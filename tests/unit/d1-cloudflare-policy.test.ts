import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CloudflareManifest, RunDriftAuditInput, RunPolicyAuditInput } from '../../shared/cloudflare-policy'
import {
  evaluateCloudflareManifest,
  evaluateCloudflareDrift,
  getCloudflarePolicyAudit,
  runCloudflareDriftAudit,
  runCloudflarePolicyAudit
} from '../../workers/release/cloudflare-policy'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
  `)
  return sqlite
}

const COMPLIANT_MANIFEST: CloudflareManifest = {
  environment: 'production',
  policyVersion: 'v2026.10',
  r2Buckets: [
    {
      bucketName: 'neteco-media-prod',
      publicAccess: false,
      bucketWebsite: false
    }
  ],
  bindings: [
    {
      bindingName: 'DB',
      type: 'd1',
      targetResource: 'neteco-prod-d1',
      targetEnvironment: 'production'
    },
    {
      bindingName: 'MEDIA_BUCKET',
      type: 'r2',
      targetResource: 'neteco-media-prod',
      targetEnvironment: 'production'
    }
  ],
  d1Databases: [
    {
      databaseName: 'neteco-prod-d1',
      databaseId: 'd1-prod-uuid-1',
      timeTravelEnabled: true,
      isolatedNamespace: true,
      backupScheduleConfigured: true
    }
  ],
  durableObjects: [
    {
      className: 'CartCoordinator',
      isolatedNamespace: true
    }
  ],
  vars: {
    NODE_ENV: 'production',
    PUBLIC_STORE_NAME: 'Neteco Químicos',
    FEATURE_TAX_ENGINE: 'enabled'
  },
  edgeSecurity: {
    minTlsVersion: '1.2',
    sslMode: 'strict',
    wafEnabled: true,
    managedRulesetsActive: true,
    backupExportConfigured: true
  }
}

describe('CIC-030: Policy-as-code para Cloudflare y detección de drift', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('aprueba un manifiesto de Cloudflare completamente conforme', async () => {
    const evaluation = evaluateCloudflareManifest(COMPLIANT_MANIFEST)
    expect(evaluation.passed).toBe(true)
    expect(evaluation.blockersCount).toBe(0)
    expect(evaluation.violations).toHaveLength(0)
  })

  it('bloquea R2 público accidental a menos que tenga bypass explícito', () => {
    const manifestWithPublicR2: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      r2Buckets: [
        {
          bucketName: 'neteco-raw-backups',
          publicAccess: true, // Error: bucket privado marcado público
          bucketWebsite: true
        }
      ]
    }

    const evaluation = evaluateCloudflareManifest(manifestWithPublicR2)
    expect(evaluation.passed).toBe(false)
    expect(evaluation.blockersCount).toBeGreaterThan(0)
    const rule = evaluation.violations.find((v) => v.ruleId === 'R2_PUBLIC_ACCESS_FORBIDDEN')
    expect(rule).toBeDefined()
    expect(rule?.severity).toBe('blocker')
  })

  it('bloquea bindings cruzados entre entornos (e.g. prod apuntando a staging)', () => {
    const manifestWithCrossBinding: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      environment: 'production',
      bindings: [
        {
          bindingName: 'DB',
          type: 'd1',
          targetResource: 'neteco-staging-d1',
          targetEnvironment: 'staging' // Error: binding a staging en entorno prod
        }
      ]
    }

    const evaluation = evaluateCloudflareManifest(manifestWithCrossBinding)
    expect(evaluation.passed).toBe(false)
    const violation = evaluation.violations.find((v) => v.ruleId === 'CROSS_ENVIRONMENT_BINDINGS_FORBIDDEN')
    expect(violation).toBeDefined()
    expect(violation?.severity).toBe('blocker')
  })

  it('bloquea D1 o Durable Objects sin aislamiento', () => {
    const unisolatedManifest: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      d1Databases: [
        {
          databaseName: 'shared-pool-d1',
          databaseId: 'uuid-d1-shared',
          timeTravelEnabled: true,
          isolatedNamespace: false, // Error: namespace no aislado
          backupScheduleConfigured: true
        }
      ],
      durableObjects: [
        {
          className: 'GlobalCounter',
          isolatedNamespace: false // Error: DO sin aislamiento
        }
      ]
    }

    const evaluation = evaluateCloudflareManifest(unisolatedManifest)
    expect(evaluation.passed).toBe(false)
    const violations = evaluation.violations.filter((v) => v.ruleId === 'D1_DO_ISOLATION_REQUIRED')
    expect(violations.length).toBe(2)
  })

  it('bloquea secretos en variables de entorno (vars) en vez de Worker Secrets', () => {
    const manifestWithPlaintextSecrets: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      vars: {
        PUBLIC_NAME: 'Neteco',
        STRIPE_API_KEY: 'sk_live_1234567890abcdef1234567890', // Error: clave secreta en vars
        DATABASE_PASSWORD: 'superSecretPassword123!' // Error: contraseña en vars
      }
    }

    const evaluation = evaluateCloudflareManifest(manifestWithPlaintextSecrets)
    expect(evaluation.passed).toBe(false)
    const violations = evaluation.violations.filter((v) => v.ruleId === 'NO_PLAINTEXT_SECRETS_IN_VARS')
    expect(violations.length).toBe(2)
  })

  it('bloquea TLS débil (< 1.2 o flexible), WAF desactivado y falta de Time Travel o export', () => {
    const insecureManifest: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      edgeSecurity: {
        minTlsVersion: '1.0', // Error: TLS 1.0 obsoleto
        sslMode: 'flexible', // Error: MITM vulnerable
        wafEnabled: false, // Error: WAF apagado
        managedRulesetsActive: false,
        backupExportConfigured: false
      },
      d1Databases: [
        {
          databaseName: 'neteco-prod-d1',
          databaseId: 'd1-prod-uuid-1',
          timeTravelEnabled: false, // Error: Time Travel desactivado
          isolatedNamespace: true,
          backupScheduleConfigured: false // Error: backup ausente
        }
      ]
    }

    const evaluation = evaluateCloudflareManifest(insecureManifest)
    expect(evaluation.passed).toBe(false)
    expect(evaluation.violations.some((v) => v.ruleId === 'STRONG_TLS_REQUIRED')).toBe(true)
    expect(evaluation.violations.some((v) => v.ruleId === 'WAF_MANDATORY')).toBe(true)
    expect(evaluation.violations.some((v) => v.ruleId === 'D1_TIME_TRAVEL_REQUIRED')).toBe(true)
    expect(evaluation.violations.some((v) => v.ruleId === 'BACKUP_EXPORT_SCHEDULE_REQUIRED')).toBe(true)
  })

  it('detecta drift crítico entre manifiesto declarado y estado live', () => {
    const liveWithDrift: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      edgeSecurity: {
        ...COMPLIANT_MANIFEST.edgeSecurity,
        wafEnabled: false // Modificación no autorizada en vivo: WAF apagado
      },
      r2Buckets: [
        {
          bucketName: 'neteco-media-prod',
          publicAccess: true, // Modificación no autorizada: bucket abierto
          bucketWebsite: false
        }
      ]
    }

    const drift = evaluateCloudflareDrift(COMPLIANT_MANIFEST, liveWithDrift)
    expect(drift.hasCriticalDrift).toBe(true)
    expect(drift.differences.length).toBeGreaterThanOrEqual(2)
    const wafDiff = drift.differences.find((d) => d.property === 'wafEnabled')
    expect(wafDiff?.critical).toBe(true)
  })

  it('persiste auditorías de política y drift en D1 con idempotencia', async () => {
    const input: RunPolicyAuditInput = {
      commandId: 'cmd-audit-01',
      environment: 'production',
      manifest: COMPLIANT_MANIFEST
    }

    const audit = await runCloudflarePolicyAudit(db, input, ADMIN_ID, NOW)
    expect(audit.passed).toBe(true)
    expect(audit.blockersCount).toBe(0)
    expect(audit.manifestHash).toHaveLength(64)

    const fetched = await getCloudflarePolicyAudit(db, audit.id)
    expect(fetched.id).toBe(audit.id)

    // Drift audit persistido
    const liveTampered: CloudflareManifest = {
      ...COMPLIANT_MANIFEST,
      edgeSecurity: { ...COMPLIANT_MANIFEST.edgeSecurity, wafEnabled: false }
    }
    const driftInput: RunDriftAuditInput = {
      commandId: 'cmd-drift-01',
      environment: 'production',
      declaredManifest: COMPLIANT_MANIFEST,
      liveManifest: liveTampered
    }
    const driftAudit = await runCloudflareDriftAudit(db, driftInput, ADMIN_ID, NOW)
    expect(driftAudit.passed).toBe(false)
    expect(driftAudit.hasCriticalDrift).toBe(true)
  })
})
