import { createHash, randomUUID } from 'node:crypto'
import {
  type CloudflareManifest,
  type CloudflarePolicyAuditRecord,
  type DriftDifference,
  type PolicyViolation,
  type TargetEnvironment,
  CloudflarePolicyError,
  runDriftAuditSchema,
  runPolicyAuditSchema
} from '../../shared/cloudflare-policy'

function computeHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

interface EvaluationResult {
  passed: boolean
  blockersCount: number
  warningsCount: number
  rulesEvaluatedCount: number
  violations: PolicyViolation[]
}

export function evaluateCloudflareManifest(manifest: CloudflareManifest): EvaluationResult {
  const violations: PolicyViolation[] = []
  let rulesEvaluatedCount = 0

  // 1. R2 público accidental
  rulesEvaluatedCount++
  for (const bucket of manifest.r2Buckets) {
    if (bucket.publicAccess || bucket.bucketWebsite) {
      if (bucket.authorizedPublicBypass) {
        violations.push({
          ruleId: 'R2_PUBLIC_ACCESS_FORBIDDEN',
          severity: 'warning',
          resource: bucket.bucketName,
          message: `Bucket ${bucket.bucketName} has public access with authorized exception`
        })
      } else {
        violations.push({
          ruleId: 'R2_PUBLIC_ACCESS_FORBIDDEN',
          severity: 'blocker',
          resource: bucket.bucketName,
          message: `Accidental public R2 access detected on bucket ${bucket.bucketName}`
        })
      }
    }
  }

  // 2. Bindings cruzados
  rulesEvaluatedCount++
  for (const binding of manifest.bindings) {
    if (binding.targetEnvironment !== manifest.environment) {
      violations.push({
        ruleId: 'CROSS_ENVIRONMENT_BINDINGS_FORBIDDEN',
        severity: 'blocker',
        resource: binding.bindingName,
        message: `Cross-environment binding: ${binding.bindingName} targets ${binding.targetEnvironment} while worker is in ${manifest.environment}`
      })
    }
  }

  // 3. D1 y Durable Objects sin aislamiento
  rulesEvaluatedCount++
  for (const d1 of manifest.d1Databases) {
    if (!d1.isolatedNamespace) {
      violations.push({
        ruleId: 'D1_DO_ISOLATION_REQUIRED',
        severity: 'blocker',
        resource: d1.databaseName,
        message: `D1 database ${d1.databaseName} does not enforce isolated namespace`
      })
    }
  }
  for (const doClass of manifest.durableObjects) {
    if (!doClass.isolatedNamespace) {
      violations.push({
        ruleId: 'D1_DO_ISOLATION_REQUIRED',
        severity: 'blocker',
        resource: doClass.className,
        message: `Durable Object class ${doClass.className} does not enforce isolated namespace`
      })
    }
  }

  // 4. Secretos en vars
  rulesEvaluatedCount++
  const secretKeyRegex = /(KEY|SECRET|PASSWORD|TOKEN|AUTH|CREDENTIAL|PRIVATE)/i
  for (const [key, value] of Object.entries(manifest.vars)) {
    if (secretKeyRegex.test(key) && !key.startsWith('PUBLIC_')) {
      violations.push({
        ruleId: 'NO_PLAINTEXT_SECRETS_IN_VARS',
        severity: 'blocker',
        resource: `vars.${key}`,
        message: `Plaintext secret candidate found in vars: ${key}. Must use Worker Secrets binding`
      })
    } else if (typeof value === 'string' && (value.startsWith('sk_live_') || value.startsWith('ghp_'))) {
      violations.push({
        ruleId: 'NO_PLAINTEXT_SECRETS_IN_VARS',
        severity: 'blocker',
        resource: `vars.${key}`,
        message: `Live secret token found in value of vars.${key}`
      })
    }
  }

  // 5. TLS débil
  rulesEvaluatedCount++
  if (manifest.edgeSecurity.minTlsVersion === '1.0' || manifest.edgeSecurity.minTlsVersion === '1.1') {
    violations.push({
      ruleId: 'STRONG_TLS_REQUIRED',
      severity: 'blocker',
      resource: 'edgeSecurity.minTlsVersion',
      message: `Weak TLS version ${manifest.edgeSecurity.minTlsVersion}. Minimum supported is 1.2`
    })
  }
  if (manifest.edgeSecurity.sslMode === 'off' || manifest.edgeSecurity.sslMode === 'flexible') {
    violations.push({
      ruleId: 'STRONG_TLS_REQUIRED',
      severity: 'blocker',
      resource: 'edgeSecurity.sslMode',
      message: `Insecure SSL mode ${manifest.edgeSecurity.sslMode}. Must be strict or full_strict`
    })
  }

  // 6. WAF ausente
  rulesEvaluatedCount++
  if (!manifest.edgeSecurity.wafEnabled || !manifest.edgeSecurity.managedRulesetsActive) {
    violations.push({
      ruleId: 'WAF_MANDATORY',
      severity: 'blocker',
      resource: 'edgeSecurity.waf',
      message: 'Cloudflare WAF or managed rulesets are inactive'
    })
  }

  // 7. Time Travel ausente
  rulesEvaluatedCount++
  for (const d1 of manifest.d1Databases) {
    if (!d1.timeTravelEnabled) {
      violations.push({
        ruleId: 'D1_TIME_TRAVEL_REQUIRED',
        severity: 'blocker',
        resource: d1.databaseName,
        message: `D1 database ${d1.databaseName} has Time Travel disabled`
      })
    }
  }

  // 8. Export/Backup ausentes
  rulesEvaluatedCount++
  if (!manifest.edgeSecurity.backupExportConfigured) {
    violations.push({
      ruleId: 'BACKUP_EXPORT_SCHEDULE_REQUIRED',
      severity: 'blocker',
      resource: 'edgeSecurity.backupExport',
      message: 'Automated backup export schedule is not configured'
    })
  }
  for (const d1 of manifest.d1Databases) {
    if (!d1.backupScheduleConfigured) {
      violations.push({
        ruleId: 'BACKUP_EXPORT_SCHEDULE_REQUIRED',
        severity: 'blocker',
        resource: d1.databaseName,
        message: `D1 database ${d1.databaseName} does not have backup schedule configured`
      })
    }
  }

  const blockersCount = violations.filter((v) => v.severity === 'blocker').length
  const warningsCount = violations.filter((v) => v.severity === 'warning').length

  return {
    passed: blockersCount === 0,
    blockersCount,
    warningsCount,
    rulesEvaluatedCount,
    violations
  }
}

export function evaluateCloudflareDrift(
  declared: CloudflareManifest,
  live: CloudflareManifest
): { hasCriticalDrift: boolean; differences: DriftDifference[] } {
  const differences: DriftDifference[] = []

  // Check WAF drift
  if (declared.edgeSecurity.wafEnabled !== live.edgeSecurity.wafEnabled) {
    differences.push({
      resource: 'edgeSecurity',
      property: 'wafEnabled',
      expected: declared.edgeSecurity.wafEnabled,
      actual: live.edgeSecurity.wafEnabled,
      critical: declared.edgeSecurity.wafEnabled && !live.edgeSecurity.wafEnabled
    })
  }

  // Check TLS drift
  if (declared.edgeSecurity.minTlsVersion !== live.edgeSecurity.minTlsVersion) {
    differences.push({
      resource: 'edgeSecurity',
      property: 'minTlsVersion',
      expected: declared.edgeSecurity.minTlsVersion,
      actual: live.edgeSecurity.minTlsVersion,
      critical: live.edgeSecurity.minTlsVersion < declared.edgeSecurity.minTlsVersion
    })
  }

  // Check SSL Mode drift
  if (declared.edgeSecurity.sslMode !== live.edgeSecurity.sslMode) {
    differences.push({
      resource: 'edgeSecurity',
      property: 'sslMode',
      expected: declared.edgeSecurity.sslMode,
      actual: live.edgeSecurity.sslMode,
      critical: live.edgeSecurity.sslMode === 'off' || live.edgeSecurity.sslMode === 'flexible'
    })
  }

  // Check R2 public access drift
  for (const decBucket of declared.r2Buckets) {
    const liveBucket = live.r2Buckets.find((b) => b.bucketName === decBucket.bucketName)
    if (liveBucket && !decBucket.publicAccess && liveBucket.publicAccess) {
      differences.push({
        resource: decBucket.bucketName,
        property: 'publicAccess',
        expected: false,
        actual: true,
        critical: true
      })
    }
  }

  // Check D1 Time Travel drift
  for (const decDb of declared.d1Databases) {
    const liveDb = live.d1Databases.find((d) => d.databaseId === decDb.databaseId)
    if (liveDb && decDb.timeTravelEnabled && !liveDb.timeTravelEnabled) {
      differences.push({
        resource: decDb.databaseName,
        property: 'timeTravelEnabled',
        expected: true,
        actual: false,
        critical: true
      })
    }
  }

  const hasCriticalDrift = differences.some((d) => d.critical)

  return {
    hasCriticalDrift,
    differences
  }
}

interface RawAuditRow {
  id: string
  target_environment: string
  policy_version: string
  passed: number
  blockers_count: number
  warnings_count: number
  rules_evaluated_count: number
  violations_json: string
  manifest_hash: string
  has_critical_drift: number
  drift_summary_json: string | null
  created_at: string
  created_by: string
}

function mapAuditRow(row: RawAuditRow): CloudflarePolicyAuditRecord {
  return {
    id: row.id,
    targetEnvironment: row.target_environment as TargetEnvironment,
    policyVersion: row.policy_version,
    passed: row.passed === 1,
    blockersCount: Number(row.blockers_count),
    warningsCount: Number(row.warnings_count),
    rulesEvaluatedCount: Number(row.rules_evaluated_count),
    violations: JSON.parse(row.violations_json),
    manifestHash: row.manifest_hash,
    hasCriticalDrift: row.has_critical_drift === 1,
    driftSummary: row.drift_summary_json ? JSON.parse(row.drift_summary_json) : null,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

async function checkIdempotency(
  db: D1Database,
  commandId: string,
  payloadHash: string
): Promise<{ exists: boolean; auditId?: string }> {
  const existing = await db
    .prepare('SELECT command_id, audit_id, payload_hash FROM cloudflare_policy_commands WHERE command_id = ?')
    .bind(commandId)
    .first<{ command_id: string; audit_id: string; payload_hash: string }>()

  if (!existing) return { exists: false }
  if (existing.payload_hash !== payloadHash) {
    throw new CloudflarePolicyError('idempotency_conflict', 409, 'Command payload hash does not match original command')
  }
  return { exists: true, auditId: existing.audit_id }
}

export async function runCloudflarePolicyAudit(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<CloudflarePolicyAuditRecord> {
  const validated = runPolicyAuditSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.auditId) {
    return getCloudflarePolicyAudit(db, idemp.auditId)
  }

  const manifest = validated.manifest
  const manifestHash = computeHash(manifest)
  const evaluation = evaluateCloudflareManifest(manifest)

  const auditId = randomUUID()

  await db
    .prepare(
      `
      INSERT INTO cloudflare_policy_audits (
        id, target_environment, policy_version, passed,
        blockers_count, warnings_count, rules_evaluated_count,
        violations_json, manifest_hash, has_critical_drift,
        drift_summary_json, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `
    )
    .bind(
      auditId,
      validated.environment,
      manifest.policyVersion,
      evaluation.passed ? 1 : 0,
      evaluation.blockersCount,
      evaluation.warningsCount,
      evaluation.rulesEvaluatedCount,
      JSON.stringify(evaluation.violations),
      manifestHash,
      nowIso,
      actorId
    )
    .run()

  await db
    .prepare(
      `
      INSERT INTO cloudflare_policy_commands (
        id, command_id, actor_id, action, audit_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'run_policy_audit', ?, ?, ?, ?)
    `
    )
    .bind(randomUUID(), validated.commandId, actorId, auditId, payloadHash, JSON.stringify(validated), nowIso)
    .run()

  return getCloudflarePolicyAudit(db, auditId)
}

export async function runCloudflareDriftAudit(
  db: D1Database,
  input: unknown,
  actorId: string,
  nowIso: string
): Promise<CloudflarePolicyAuditRecord> {
  const validated = runDriftAuditSchema.parse(input)
  const payloadHash = computeHash(validated)

  const idemp = await checkIdempotency(db, validated.commandId, payloadHash)
  if (idemp.exists && idemp.auditId) {
    return getCloudflarePolicyAudit(db, idemp.auditId)
  }

  const manifestHash = computeHash(validated.liveManifest)
  const drift = evaluateCloudflareDrift(validated.declaredManifest, validated.liveManifest)
  const liveEvaluation = evaluateCloudflareManifest(validated.liveManifest)

  const passed = liveEvaluation.passed && !drift.hasCriticalDrift
  const auditId = randomUUID()

  await db
    .prepare(
      `
      INSERT INTO cloudflare_policy_audits (
        id, target_environment, policy_version, passed,
        blockers_count, warnings_count, rules_evaluated_count,
        violations_json, manifest_hash, has_critical_drift,
        drift_summary_json, created_at, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .bind(
      auditId,
      validated.environment,
      validated.declaredManifest.policyVersion,
      passed ? 1 : 0,
      liveEvaluation.blockersCount,
      liveEvaluation.warningsCount,
      liveEvaluation.rulesEvaluatedCount,
      JSON.stringify(liveEvaluation.violations),
      manifestHash,
      drift.hasCriticalDrift ? 1 : 0,
      JSON.stringify(drift.differences),
      nowIso,
      actorId
    )
    .run()

  await db
    .prepare(
      `
      INSERT INTO cloudflare_policy_commands (
        id, command_id, actor_id, action, audit_id, payload_hash, payload_json, created_at
      ) VALUES (?, ?, ?, 'run_drift_audit', ?, ?, ?, ?)
    `
    )
    .bind(randomUUID(), validated.commandId, actorId, auditId, payloadHash, JSON.stringify(validated), nowIso)
    .run()

  return getCloudflarePolicyAudit(db, auditId)
}

export async function getCloudflarePolicyAudit(db: D1Database, auditId: string): Promise<CloudflarePolicyAuditRecord> {
  const row = await db.prepare('SELECT * FROM cloudflare_policy_audits WHERE id = ?').bind(auditId).first<RawAuditRow>()

  if (!row) {
    throw new CloudflarePolicyError('audit_not_found', 404, `Audit ${auditId} not found`)
  }
  return mapAuditRow(row)
}

export async function listCloudflarePolicyAudits(db: D1Database, limit = 50): Promise<CloudflarePolicyAuditRecord[]> {
  const rows = await db
    .prepare('SELECT * FROM cloudflare_policy_audits ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<RawAuditRow>()

  return (rows.results ?? []).map(mapAuditRow)
}
