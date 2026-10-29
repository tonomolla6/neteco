import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type EvaluateReleaseInput,
  type RecordSliMeasurementInput,
  type EmergencyOverrideInput,
  ErrorBudgetReleaseError
} from '../../shared/error-budget-releases'
import {
  recordD1SliMeasurement,
  evaluateD1ReleaseDecision,
  emergencyOverrideD1ReleaseDecision,
  readD1ErrorBudgetOverview
} from '../../workers/observability/error-budget'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0116_observability_sre_capacity_slo.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('operator', 'Operador', 'Fixture operator');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-sre@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)
  return sqlite
}

describe('OBS-025: Error budget en decisiones de release', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('records SLI measurements for journeys and computes error budget', async () => {
    const input: RecordSliMeasurementInput = {
      commandId: '30000000-0000-4000-8000-000000000001',
      idempotencyKey: 'sli-storefront-20261029',
      journey: 'storefront',
      windowStart: '2026-10-22T00:00:00Z',
      windowEnd: '2026-10-29T00:00:00Z',
      totalEvents: 100000,
      failedEvents: 50,
      targetSloRatio: 0.999, // 99.90% -> allowed errors = 100
      metadata: { source: 'edge-logs' }
    }

    const recorded = await recordD1SliMeasurement(db, CLAIMS, input, { now: NOW })
    expect(recorded.journey).toBe('storefront')
    expect(recorded.totalEvents).toBe(100000)
    expect(recorded.failedEvents).toBe(50)

    const overview = await readD1ErrorBudgetOverview(db, { now: NOW })
    expect(overview.journeys.storefront).toBeDefined()
    expect(overview.journeys.storefront.remainingBudgetPercent).toBeCloseTo(50.0, 1) // 50 failed out of 100 allowed = 50% remaining
    expect(overview.journeys.storefront.burnRate).toBeCloseTo(0.5, 1)
    expect(overview.featureFreezeActive).toBe(false)
  })

  it('approves feature release when all error budgets are healthy', async () => {
    await recordD1SliMeasurement(
      db,
      CLAIMS,
      {
        commandId: '30000000-0000-4000-8000-000000000002',
        idempotencyKey: 'sli-checkout-ok',
        journey: 'checkout_orders',
        windowStart: '2026-10-22T00:00:00Z',
        windowEnd: '2026-10-29T00:00:00Z',
        totalEvents: 50000,
        failedEvents: 5, // Allowed: 50000 * 0.0005 = 25 -> 80% remaining
        targetSloRatio: 0.9995
      },
      { now: NOW }
    )

    const evalInput: EvaluateReleaseInput = {
      commandId: '30000000-0000-4000-8000-000000000003',
      idempotencyKey: 'eval-rel-2026-1',
      releaseVersion: 'v2026.10.30-feat-1',
      releaseType: 'feature',
      commitHash: 'abcdef1234567'
    }

    const decision = await evaluateD1ReleaseDecision(db, CLAIMS, evalInput, { now: NOW })
    expect(decision.status).toBe('approved')
    expect(decision.releaseVersion).toBe('v2026.10.30-feat-1')
    expect(decision.budgetStatusSummary.freezeActive).toBe(false)
  })

  it('pauses feature releases when error budget is exhausted and prioritizes reliability', async () => {
    // Inject high error count in checkout_orders (e.g. 40 failures out of 25 allowed)
    await recordD1SliMeasurement(
      db,
      CLAIMS,
      {
        commandId: '30000000-0000-4000-8000-000000000004',
        idempotencyKey: 'sli-checkout-failing',
        journey: 'checkout_orders',
        windowStart: '2026-10-22T00:00:00Z',
        windowEnd: '2026-10-29T00:00:00Z',
        totalEvents: 50000,
        failedEvents: 40, // Allowed: 25 -> budget exhausted!
        targetSloRatio: 0.9995
      },
      { now: NOW }
    )

    const featureInput: EvaluateReleaseInput = {
      commandId: '30000000-0000-4000-8000-000000000005',
      idempotencyKey: 'eval-feat-blocked',
      releaseVersion: 'v2026.10.30-new-marketing',
      releaseType: 'feature',
      commitHash: 'deadbeef12345'
    }

    // Feature release MUST BE BLOCKED
    const featureDecision = await evaluateD1ReleaseDecision(db, CLAIMS, featureInput, { now: NOW })
    expect(featureDecision.status).toBe('blocked_budget_exhausted')
    expect(featureDecision.budgetStatusSummary.freezeActive).toBe(true)
    expect(featureDecision.budgetStatusSummary.blockingJourneys).toContain('checkout_orders')

    // Reliability fixes MUST BE ALLOWED even when error budget is exhausted ("prioriza fiabilidad")
    const reliabilityInput: EvaluateReleaseInput = {
      commandId: '30000000-0000-4000-8000-000000000006',
      idempotencyKey: 'eval-reliability-allowed',
      releaseVersion: 'v2026.10.30-fix-checkout-timeout',
      releaseType: 'reliability_fix',
      commitHash: 'fix1234567890'
    }
    const reliabilityDecision = await evaluateD1ReleaseDecision(db, CLAIMS, reliabilityInput, { now: NOW })
    expect(reliabilityDecision.status).toBe('approved')

    // Hotfix and Rollback must also be permitted
    const hotfixInput: EvaluateReleaseInput = {
      commandId: '30000000-0000-4000-8000-000000000007',
      idempotencyKey: 'eval-hotfix-allowed',
      releaseVersion: 'v2026.10.30-hotfix-1',
      releaseType: 'hotfix',
      commitHash: 'hotfix1234567'
    }
    const hotfixDecision = await evaluateD1ReleaseDecision(db, CLAIMS, hotfixInput, { now: NOW })
    expect(hotfixDecision.status).toBe('approved')
  })

  it('allows emergency override with mandatory audit justification', async () => {
    // Create an exhausted measurement
    await recordD1SliMeasurement(
      db,
      CLAIMS,
      {
        commandId: '30000000-0000-4000-8000-000000000008',
        idempotencyKey: 'sli-failing-for-override',
        journey: 'catalog_api',
        windowStart: '2026-10-22T00:00:00Z',
        windowEnd: '2026-10-29T00:00:00Z',
        totalEvents: 100000,
        failedEvents: 200, // Target 99.9% -> allowed 100 -> exhausted
        targetSloRatio: 0.999
      },
      { now: NOW }
    )

    const decision = await evaluateD1ReleaseDecision(
      db,
      CLAIMS,
      {
        commandId: '30000000-0000-4000-8000-000000000009',
        idempotencyKey: 'eval-blocked-before-override',
        releaseVersion: 'v2026.10.30-promo-launch',
        releaseType: 'feature',
        commitHash: 'feataabbccddee'
      },
      { now: NOW }
    )

    expect(decision.status).toBe('blocked_budget_exhausted')

    // Override without justification must fail
    await expect(
      emergencyOverrideD1ReleaseDecision(
        db,
        CLAIMS,
        {
          commandId: '30000000-0000-4000-8000-000000000010',
          idempotencyKey: 'override-empty-justification',
          decisionId: decision.id,
          justification: '   '
        },
        { now: NOW }
      )
    ).rejects.toThrow(ErrorBudgetReleaseError)

    // Override with valid justification
    const overrideInput: EmergencyOverrideInput = {
      commandId: '30000000-0000-4000-8000-000000000011',
      idempotencyKey: 'override-valid',
      decisionId: decision.id,
      justification: 'Aprobado por Dirección de Operaciones para mitigar impacto de campaña comercial'
    }
    const overridden = await emergencyOverrideD1ReleaseDecision(db, CLAIMS, overrideInput, { now: NOW })
    expect(overridden.status).toBe('overridden_emergency')
    expect(overridden.overriddenBy).toBe(ADMIN_ID)
    expect(overridden.justification).toBe(
      'Aprobado por Dirección de Operaciones para mitigar impacto de campaña comercial'
    )
  })

  it('guarantees command idempotency and immutable audit logs', async () => {
    const input: EvaluateReleaseInput = {
      commandId: '30000000-0000-4000-8000-000000000012',
      idempotencyKey: 'eval-idempotent-test',
      releaseVersion: 'v2026.10.30-idemp',
      releaseType: 'feature',
      commitHash: '1234567890abc'
    }

    const first = await evaluateD1ReleaseDecision(db, CLAIMS, input, { now: NOW })
    const replay = await evaluateD1ReleaseDecision(db, CLAIMS, input, { now: NOW })
    expect(first.id).toBe(replay.id)

    // Trying to alter command table directly must abort
    expect(() => {
      sqlite.exec(
        `UPDATE sre_release_decision_commands SET action = 'evaluate_release' WHERE command_id = '${input.commandId}'`
      )
    }).toThrow(/sre_release_command_immutable/)

    expect(() => {
      sqlite.exec(`DELETE FROM sre_release_decision_commands WHERE command_id = '${input.commandId}'`)
    }).toThrow(/sre_release_command_immutable/)
  })
})
