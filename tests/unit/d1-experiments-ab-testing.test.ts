import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import {
  type CreateExperimentInput,
  type ExperimentGuardrails,
  type RecordDecisionInput,
  type UpdateExperimentInput,
  calculateSampleRatioMismatch,
  checkExperimentOverlap,
  evaluateGuardrails,
  stableAssignVariant,
  ExperimentsError
} from '../../shared/experiments-ab-testing'
import {
  assignD1ExperimentVariant,
  createD1Experiment,
  getD1Experiment,
  getD1ExperimentReport,
  listD1Experiments,
  pauseD1Experiment,
  recordD1ExperimentDecision,
  recordD1ExperimentEvent,
  startD1Experiment,
  updateD1Experiment
} from '../../workers/analytics/experiments'

const NOW = '2026-10-29T12:00:00Z'
const PAST_10_DAYS = '2026-10-19T12:00:00Z'
const PAST_START = '2026-01-01T00:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const NON_ADMIN_SESSION = '20000000-0000-4000-8000-000000000002'
const NON_ADMIN_CLAIMS = { identityId: NON_ADMIN_ID, sessionId: NON_ADMIN_SESSION, sessionVersion: 1 }

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openAccountSecurityDatabase()

  // Setup permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin'),
      ('customer', 'Cliente', 'Fixture customer');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin access'),
      ('experiments.manage', 'experiments', 'manage', 'Fixture experiment management');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'experiments.manage');
  `)

  // Admin identity
  sqlite.exec(`
    INSERT OR REPLACE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
    VALUES ('${ADMIN_ID}', 'admin.ab@neteco.es', 'fixture_hash', '${PAST_START}', 'active', 1, '${PAST_START}', '${PAST_START}');
    INSERT OR REPLACE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${ADMIN_ID}', 'admin', '${PAST_START}');
    INSERT OR REPLACE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${PAST_START}', '2026-10-30T12:00:00Z');
  `)

  // Non-admin identity
  sqlite.exec(`
    INSERT OR REPLACE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
    VALUES ('${NON_ADMIN_ID}', 'user@neteco.es', 'fixture_hash', '${PAST_START}', 'active', 1, '${PAST_START}', '${PAST_START}');
    INSERT OR REPLACE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${NON_ADMIN_ID}', 'customer', '${PAST_START}');
    INSERT OR REPLACE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${NON_ADMIN_SESSION}', '${NON_ADMIN_ID}', 1, 0, '${PAST_START}', '2026-10-30T12:00:00Z');
  `)

  return sqlite
}

describe('Experiments & A/B Testing Engine (DAT-017, DAT-018, MKT-011)', () => {
  let sqlite: DatabaseSync

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
  })

  afterEach(() => {
    sqlite?.close()
  })

  const sampleGuardrails: ExperimentGuardrails = {
    marginFloorBasisPoints: 1500, // min 15% margin (MKT-011)
    maxUnsubscribeRateBasisPoints: 50, // max 0.5% unsubscribes (MKT-011 bajas)
    maxComplaintRateBasisPoints: 20, // max 0.2% complaints (MKT-011 quejas)
    cwvLcpMaxMs: 2500, // Core Web Vitals LCP (MKT-011)
    cwvClsMax: 0.1, // Core Web Vitals CLS (MKT-011)
    cwvInpMaxMs: 200 // Core Web Vitals INP (MKT-011)
  }

  const sampleCreateInput: CreateExperimentInput = {
    key: 'mkt-offer-urgency-banner',
    name: 'Descuento químico profesional con urgencia de stock',
    hypothesis: 'Mostrar stock residual con 10% de descuento aumenta la conversión sin erosionar el margen del 15%',
    experimentType: 'message_offer',
    ownerEmail: 'admin.ab@neteco.es',
    targetSurface: 'checkout_incentive',
    targetSegment: 'b2b_only',
    exclusiveGroup: 'checkout_incentives_layer',
    primaryMetric: 'conversion_rate',
    guardrails: sampleGuardrails,
    trafficAllocationPercent: 100,
    minSampleSize: 50,
    minDurationDays: 7,
    holdoutPercent: 10,
    changesDescription: 'Variante A muestra banner estático, Variante B muestra badge dinámico de stock limitado',
    variants: [
      {
        variantKey: 'holdout',
        name: 'Holdout (Sin oferta)',
        isHoldout: true,
        weight: 10,
        payload: { offerText: '', discountPercent: 0 }
      },
      {
        variantKey: 'control',
        name: 'Control (Banner genérico)',
        isControl: true,
        weight: 45,
        payload: { offerText: 'Envío rápido profesional', discountPercent: 0 }
      },
      {
        variantKey: 'urgency_offer',
        name: 'Variante Urgencia (10% descuento con stock)',
        weight: 45,
        payload: { offerText: 'Últimas 5 garrafas: 10% dto.', discountPercent: 10, marginImpactBps: -400 }
      }
    ]
  }

  describe('Pure Mathematical & Statistical Utilities', () => {
    it('stableAssignVariant assigns deterministically based on unitId', () => {
      const unit1 = 'visitor-12345678'
      const res1 = stableAssignVariant({
        experimentKey: 'test-exp',
        unitId: unit1,
        trafficAllocationPercent: 100,
        holdoutPercent: 10,
        variants: [
          { variantKey: 'holdout', weight: 10, isHoldout: true },
          { variantKey: 'control', weight: 45, isControl: true },
          { variantKey: 'variant_b', weight: 45 }
        ]
      })

      // Multiple invocations with same input return identical variant
      const res2 = stableAssignVariant({
        experimentKey: 'test-exp',
        unitId: unit1,
        trafficAllocationPercent: 100,
        holdoutPercent: 10,
        variants: [
          { variantKey: 'holdout', weight: 10, isHoldout: true },
          { variantKey: 'control', weight: 45, isControl: true },
          { variantKey: 'variant_b', weight: 45 }
        ]
      })

      expect(res1.variantKey).toBe(res2.variantKey)
      expect(res1.isAssigned).toBe(true)
    })

    it('stableAssignVariant respects trafficAllocationPercent gating', () => {
      // 0% allocation gives null
      const res = stableAssignVariant({
        experimentKey: 'test-exp',
        unitId: 'visitor-abcdef99',
        trafficAllocationPercent: 0,
        holdoutPercent: 0,
        variants: [
          { variantKey: 'control', weight: 50 },
          { variantKey: 'variant_b', weight: 50 }
        ]
      })
      expect(res.variantKey).toBeNull()
      expect(res.isAssigned).toBe(false)
    })

    it('calculateSampleRatioMismatch detects balanced vs mismatched traffic (DAT-017 SRM)', () => {
      const variants = [
        { variantKey: 'control', weight: 50 },
        { variantKey: 'treatment', weight: 50 }
      ]

      // Balanced traffic: 500 vs 500
      const balanced = calculateSampleRatioMismatch(variants, { control: 500, treatment: 500 })
      expect(balanced.status).toBe('pass')
      expect(balanced.pValue).toBeGreaterThan(0.05)
      expect(balanced.chiSquare).toBe(0)

      // Severe mismatch: 700 vs 300
      const mismatched = calculateSampleRatioMismatch(variants, { control: 700, treatment: 300 })
      expect(mismatched.status).toBe('mismatch_detected')
      expect(mismatched.pValue).toBeLessThan(0.001)
      expect(mismatched.chiSquare).toBeGreaterThan(10)
    })

    it('checkExperimentOverlap detects collisions in surface and segment (DAT-018)', () => {
      const active = [
        {
          id: 'exp-1',
          name: 'Exp 1',
          key: 'exp-1',
          targetSurface: 'checkout_incentive' as const,
          targetSegment: 'b2b_only' as const,
          exclusiveGroup: 'checkout_group'
        }
      ]

      // Same surface and segment -> conflict
      const collision1 = checkExperimentOverlap(
        { targetSurface: 'checkout_incentive', targetSegment: 'b2b_only' },
        active
      )
      expect(collision1.hasConflict).toBe(true)
      expect(collision1.conflictingExperimentKey).toBe('exp-1')

      // Different surface -> no conflict
      const ok1 = checkExperimentOverlap({ targetSurface: 'homepage_hero', targetSegment: 'b2b_only' }, active)
      expect(ok1.hasConflict).toBe(false)

      // Same exclusive group -> conflict even if segment differs
      const collision2 = checkExperimentOverlap(
        { targetSurface: 'homepage_hero', targetSegment: 'b2c_only', exclusiveGroup: 'checkout_group' },
        active
      )
      expect(collision2.hasConflict).toBe(true)
    })

    it('evaluateGuardrails checks margin, unsubscribes, complaints, and Core Web Vitals (MKT-011)', () => {
      // 1. Healthy variant
      const healthy = evaluateGuardrails(sampleGuardrails, {
        variantKey: 'urgency_offer',
        exposures: 1000,
        conversions: 120,
        clicks: 300,
        ordersPlaced: 120,
        conversionRate: 0.12,
        totalRevenueCents: 500000,
        averageOrderValueCents: 4166,
        unsubscribes: 2, // 2/1000 = 0.2% <= 0.5%
        complaints: 1, // 1/1000 = 0.1% <= 0.2%
        averageMarginBasisPoints: 1800, // 18% >= 15%
        p75LcpMs: 1800, // 1.8s <= 2.5s
        p75Cls: 0.05, // 0.05 <= 0.1
        p75InpMs: 120 // 120ms <= 200ms
      })
      expect(healthy.status).toBe('healthy')
      expect(healthy.breaches).toHaveLength(0)

      // 2. Breached variant (margin dropped below floor, LCP too slow, high complaints)
      const breached = evaluateGuardrails(sampleGuardrails, {
        variantKey: 'urgency_offer',
        exposures: 1000,
        conversions: 150,
        clicks: 400,
        ordersPlaced: 150,
        conversionRate: 0.15,
        totalRevenueCents: 400000,
        averageOrderValueCents: 2666,
        unsubscribes: 10, // 1.0% > 0.5%
        complaints: 5, // 0.5% > 0.2%
        averageMarginBasisPoints: 1200, // 12% < 15% floor
        p75LcpMs: 3100, // 3.1s > 2.5s
        p75Cls: 0.15, // 0.15 > 0.1
        p75InpMs: 250 // 250ms > 200ms
      })
      expect(breached.status).toBe('breached')
      expect(breached.breaches.map((b) => b.guardrail)).toEqual([
        'margin_floor',
        'max_unsubscribe_rate',
        'max_complaint_rate',
        'cwv_lcp',
        'cwv_cls',
        'cwv_inp'
      ])
    })
  })

  describe('D1 Database Operations (CAS, Idempotency, Audit)', () => {
    it('creates an experiment with variants, holdout, and audit command', async () => {
      const db = d1OverSqlite(sqlite)
      const res = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-1',
        now: () => NOW
      })

      expect(res.experimentId).toBeDefined()
      expect(res.key).toBe(sampleCreateInput.key)
      expect(res.version).toBe(1)

      const exp = await getD1Experiment(db, res.experimentId)
      expect(exp).not.toBeNull()
      expect(exp?.name).toBe(sampleCreateInput.name)
      expect(exp?.hypothesis).toBe(sampleCreateInput.hypothesis)
      expect(exp?.status).toBe('draft')
      expect(exp?.variants).toHaveLength(3)

      // Re-running with same idempotency key returns identical receipt
      const idemp = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-1',
        now: () => NOW
      })
      expect(idemp.experimentId).toBe(res.experimentId)
    })

    it('rejects unauthorized creation', async () => {
      const db = d1OverSqlite(sqlite)
      await expect(
        createD1Experiment(db, NON_ADMIN_CLAIMS, sampleCreateInput, {
          idempotencyKey: 'cmd-unauth',
          now: () => NOW
        })
      ).rejects.toThrow(ExperimentsError)
    })

    it('updates draft experiment with CAS version protection', async () => {
      const db = d1OverSqlite(sqlite)
      const created = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-update',
        now: () => NOW
      })

      const updateInput: UpdateExperimentInput = {
        expectedVersion: 1,
        hypothesis: 'Nueva hipótesis refinada para clientes B2B con garrafas de 25L'
      }

      const updated = await updateD1Experiment(db, ADMIN_CLAIMS, created.experimentId, updateInput, {
        idempotencyKey: 'cmd-update-1',
        now: () => NOW
      })

      expect(updated.version).toBe(2)

      // Outdated expectedVersion triggers version_conflict
      await expect(
        updateD1Experiment(
          db,
          ADMIN_CLAIMS,
          created.experimentId,
          { expectedVersion: 1 },
          {
            idempotencyKey: 'cmd-update-conflict',
            now: () => NOW
          }
        )
      ).rejects.toThrow(ExperimentsError)
    })

    it('starts experiment and blocks overlapping active tests (DAT-018)', async () => {
      const db = d1OverSqlite(sqlite)
      const exp1 = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-overlap-1',
        now: () => NOW
      })

      // Start experiment 1
      const startRes1 = await startD1Experiment(db, ADMIN_CLAIMS, exp1.experimentId, {
        expectedVersion: 1,
        idempotencyKey: 'cmd-start-1',
        now: () => NOW
      })
      expect(startRes1.status).toBe('running')

      // Pause experiment 1
      const pauseRes1 = await pauseD1Experiment(db, ADMIN_CLAIMS, exp1.experimentId, {
        expectedVersion: 2,
        idempotencyKey: 'cmd-pause-1',
        now: () => NOW
      })
      expect(pauseRes1.status).toBe('paused')

      // Restart experiment 1
      await startD1Experiment(db, ADMIN_CLAIMS, exp1.experimentId, {
        expectedVersion: 3,
        idempotencyKey: 'cmd-restart-1',
        now: () => NOW
      })

      // Create a second experiment on the same surface & segment
      const exp2Input: CreateExperimentInput = {
        ...sampleCreateInput,
        key: 'second-conflicting-test',
        name: 'Otro test de incentivos en checkout'
      }
      const exp2 = await createD1Experiment(db, ADMIN_CLAIMS, exp2Input, {
        idempotencyKey: 'cmd-create-overlap-2',
        now: () => NOW
      })

      // Trying to start the second experiment must be rejected due to overlap conflict!
      await expect(
        startD1Experiment(db, ADMIN_CLAIMS, exp2.experimentId, {
          expectedVersion: 1,
          idempotencyKey: 'cmd-start-2-conflict',
          now: () => NOW
        })
      ).rejects.toThrow(ExperimentsError)
    })

    it('assigns variant server-side stably and persists in D1 (DAT-017)', async () => {
      const db = d1OverSqlite(sqlite)
      const exp = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-assign',
        now: () => NOW
      })
      await startD1Experiment(db, ADMIN_CLAIMS, exp.experimentId, {
        expectedVersion: 1,
        idempotencyKey: 'cmd-start-assign',
        now: () => NOW
      })

      const assignment1 = await assignD1ExperimentVariant(
        db,
        {
          experimentKey: sampleCreateInput.key,
          unitType: 'customer_id',
          unitId: '30000000-0000-4000-8000-000000000099',
          context: { segment: 'b2b_only', surface: 'checkout_incentive' }
        },
        NOW
      )

      expect(assignment1.variantKey).toBeDefined()
      expect(['holdout', 'control', 'urgency_offer']).toContain(assignment1.variantKey)

      // Subsequent assignment query returns the exact persisted variant
      const assignment2 = await assignD1ExperimentVariant(
        db,
        {
          experimentKey: sampleCreateInput.key,
          unitType: 'customer_id',
          unitId: '30000000-0000-4000-8000-000000000099'
        },
        NOW
      )

      expect(assignment2.variantKey).toBe(assignment1.variantKey)
    })

    it('records metric events and generates summary report with SRM and guardrails', async () => {
      const db = d1OverSqlite(sqlite)
      const exp = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-metrics',
        now: () => PAST_10_DAYS
      })
      await startD1Experiment(db, ADMIN_CLAIMS, exp.experimentId, {
        expectedVersion: 1,
        idempotencyKey: 'cmd-start-metrics',
        now: () => PAST_10_DAYS
      })

      // Record 30 exposures for control and 30 for urgency_offer
      for (let i = 0; i < 30; i++) {
        await recordD1ExperimentEvent(
          db,
          {
            experimentKey: sampleCreateInput.key,
            variantKey: 'control',
            unitType: 'visitor_id',
            unitId: `vis-control-${i}`,
            eventType: 'exposure'
          },
          PAST_10_DAYS
        )
        await recordD1ExperimentEvent(
          db,
          {
            experimentKey: sampleCreateInput.key,
            variantKey: 'urgency_offer',
            unitType: 'visitor_id',
            unitId: `vis-urgency-${i}`,
            eventType: 'exposure'
          },
          PAST_10_DAYS
        )
      }

      // Record conversions and margins
      for (let i = 0; i < 6; i++) {
        await recordD1ExperimentEvent(
          db,
          {
            experimentKey: sampleCreateInput.key,
            variantKey: 'control',
            unitType: 'visitor_id',
            unitId: `vis-control-${i}`,
            eventType: 'conversion',
            eventValue: 5000,
            marginBasisPoints: 2000
          },
          NOW
        )
      }

      for (let i = 0; i < 12; i++) {
        await recordD1ExperimentEvent(
          db,
          {
            experimentKey: sampleCreateInput.key,
            variantKey: 'urgency_offer',
            unitType: 'visitor_id',
            unitId: `vis-urgency-${i}`,
            eventType: 'conversion',
            eventValue: 5500,
            marginBasisPoints: 1700
          },
          NOW
        )
      }

      // Record Core Web Vitals
      await recordD1ExperimentEvent(
        db,
        {
          experimentKey: sampleCreateInput.key,
          variantKey: 'urgency_offer',
          unitType: 'visitor_id',
          unitId: 'vis-cwv-1',
          eventType: 'web_vital_lcp',
          eventValue: 1600
        },
        NOW
      )

      const report = await getD1ExperimentReport(db, exp.experimentId, NOW)
      expect(report.srm.status).toBe('pass')
      expect(report.guardrailsStatus.status).toBe('healthy')
      expect(report.hasMetMinSampleSize).toBe(true) // >= 50
      expect(report.hasMetMinDuration).toBe(true) // 10 days >= 7

      const controlMetrics = report.variantsMetrics.find((v) => v.variantKey === 'control')
      const urgencyMetrics = report.variantsMetrics.find((v) => v.variantKey === 'urgency_offer')

      expect(controlMetrics?.conversions).toBe(6)
      expect(urgencyMetrics?.conversions).toBe(12)
      expect(report.liftVsControlPercent).toBeGreaterThan(0)
    })

    it('records decision and archives results (DAT-017)', async () => {
      const db = d1OverSqlite(sqlite)
      const exp = await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-decide',
        now: () => PAST_10_DAYS
      })
      await startD1Experiment(db, ADMIN_CLAIMS, exp.experimentId, {
        expectedVersion: 1,
        idempotencyKey: 'cmd-start-decide',
        now: () => PAST_10_DAYS
      })

      // Add minimum sample size
      for (let i = 0; i < 50; i++) {
        await recordD1ExperimentEvent(
          db,
          {
            experimentKey: sampleCreateInput.key,
            variantKey: 'control',
            unitType: 'visitor_id',
            unitId: `vis-decide-${i}`,
            eventType: 'exposure'
          },
          PAST_10_DAYS
        )
      }

      const decisionInput: RecordDecisionInput = {
        expectedVersion: 2,
        decision: 'variant_b_winner',
        decisionRationale:
          'La variante de urgencia incrementó significativamente la conversión manteniendo margen > 15%'
      }

      const decided = await recordD1ExperimentDecision(db, ADMIN_CLAIMS, exp.experimentId, decisionInput, {
        idempotencyKey: 'cmd-decision-1',
        now: () => NOW
      })

      expect(decided.status).toBe('archived')
      expect(decided.decision).toBe('variant_b_winner')
      expect(decided.archivedResults).toBeDefined()
      expect(decided.archivedResults?.srm).toBeDefined()
    })

    it('lists experiments and filters by status, owner, surface, segment (DAT-018)', async () => {
      const db = d1OverSqlite(sqlite)
      await createD1Experiment(db, ADMIN_CLAIMS, sampleCreateInput, {
        idempotencyKey: 'cmd-create-list',
        now: () => NOW
      })

      const all = await listD1Experiments(db, {})
      expect(all.experiments.length).toBeGreaterThanOrEqual(1)

      const filtered = await listD1Experiments(db, {
        status: 'draft',
        surface: 'checkout_incentive',
        segment: 'b2b_only'
      })
      expect(filtered.experiments).toHaveLength(1)
      expect(filtered.experiments[0]!.key).toBe(sampleCreateInput.key)
      expect(filtered.experiments[0]!.changesDescription).toBe(sampleCreateInput.changesDescription)
    })
  })
})
