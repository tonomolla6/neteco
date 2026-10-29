import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CreateB2BContractSloInput } from '../../shared/b2b-contract-slo'
import {
  createD1B2BContractSlo,
  verifyD1OperationalCapacity,
  recordD1B2BSloEvent,
  recordD1B2BExclusion,
  generateD1ComplianceReport
} from '../../workers/observability/b2b-slo'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '50000000-0000-4000-8000-000000000001'
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
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-b2b-slo@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
    INSERT OR IGNORE INTO customers (id, name, phone, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Hospital Central Lavandería SL', '+34912345678', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO companies (id, customer_id, legal_name, trade_name, tax_id, country_code, status, created_at, updated_at) VALUES
      ('comp-1', '${CUSTOMER_ID}', 'Lavanderías Industriales del Sur SA', 'Lavanderías Sur', 'B12345678', 'ES', 'approved', '${NOW}', '${NOW}');
  `)
  return sqlite
}

describe('OBS-028: SLO por cuentas B2B/contratos', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates a B2B contract SLO in operational_check_pending status', async () => {
    const input: CreateB2BContractSloInput = {
      commandId: '60000000-0000-4000-8000-000000000001',
      idempotencyKey: 'contract-b2b-lavanderia-1',
      customerId: CUSTOMER_ID,
      companyName: 'Lavanderías Industriales del Sur SA',
      contractRef: 'CTR-B2B-2026-LAV-01',
      tierCode: 'premium_b2b',
      billingPeriodStart: '2026-10-01T00:00:00Z',
      billingPeriodEnd: '2026-10-31T23:59:59Z'
    }

    const contract = await createD1B2BContractSlo(db, CLAIMS, input, { now: NOW })
    expect(contract.contractRef).toBe('CTR-B2B-2026-LAV-01')
    expect(contract.tierCode).toBe('premium_b2b')
    expect(contract.availabilityTarget).toBe(0.999) // 99.9%
    expect(contract.apiP95LatencyTargetMs).toBe(400)
    expect(contract.supportResponseTargetMin).toBe(30)
    expect(contract.dispatchLeadTargetHours).toBe(24)
    expect(contract.status).toBe('operational_check_pending')
    expect(contract.operationalCapacityVerified).toBe(false)
  })

  it('enforces operational capacity verification before contract activation ("no SLA contractual sin capacidad operativa")', async () => {
    const contract = await createD1B2BContractSlo(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000002',
        idempotencyKey: 'contract-b2b-check-1',
        customerId: CUSTOMER_ID,
        companyName: 'Lavanderías Industriales del Sur SA',
        contractRef: 'CTR-B2B-2026-CAP-02',
        tierCode: 'enterprise_vip',
        billingPeriodStart: '2026-10-01T00:00:00Z',
        billingPeriodEnd: '2026-10-31T23:59:59Z'
      },
      { now: NOW }
    )

    // 1. Verification fails when capacity conditions are not met (e.g. insufficient headroom or error budget frozen)
    const failedCheck = await verifyD1OperationalCapacity(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000003',
        idempotencyKey: 'verify-capacity-failing',
        contractId: contract.id,
        expectedVersion: 1,
        capacityAssessment: {
          errorBudgetHealthy: false, // Error budget is frozen!
          currentHeadroomPercent: 12.0, // Enterprise requires 30%
          hasDedicatedManager: false
        }
      },
      { now: NOW }
    )

    expect(failedCheck.status).toBe('suspended_capacity')
    expect(failedCheck.operationalCapacityVerified).toBe(false)
    expect(failedCheck.operationalCheckNotes).toContain('insufficient_operational_capacity')

    // 2. Verification succeeds when operational capacity is validated
    const passedCheck = await verifyD1OperationalCapacity(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000004',
        idempotencyKey: 'verify-capacity-passed',
        contractId: contract.id,
        expectedVersion: failedCheck.version,
        capacityAssessment: {
          errorBudgetHealthy: true,
          currentHeadroomPercent: 35.0, // Above 30% required
          hasDedicatedManager: true
        }
      },
      { now: NOW }
    )

    expect(passedCheck.status).toBe('active')
    expect(passedCheck.operationalCapacityVerified).toBe(true)
  })

  it('records measurable promises and applies auditable exclusions for downtime calculation', async () => {
    // Create and activate contract
    const contract = await createD1B2BContractSlo(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000005',
        idempotencyKey: 'contract-for-report',
        customerId: CUSTOMER_ID,
        companyName: 'Lavanderías Industriales del Sur SA',
        contractRef: 'CTR-B2B-2026-REP-03',
        tierCode: 'premium_b2b',
        billingPeriodStart: '2026-10-01T00:00:00Z',
        billingPeriodEnd: '2026-10-31T23:59:59Z'
      },
      { now: NOW }
    )

    await verifyD1OperationalCapacity(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000006',
        idempotencyKey: 'verify-rep-contract',
        contractId: contract.id,
        expectedVersion: 1,
        capacityAssessment: {
          errorBudgetHealthy: true,
          currentHeadroomPercent: 25.0,
          hasDedicatedManager: true
        }
      },
      { now: NOW }
    )

    // Ingest daily events: 60 minutes downtime on 2026-10-15
    await recordD1B2BSloEvent(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000007',
        idempotencyKey: 'event-b2b-oct15',
        contractId: contract.id,
        eventDate: '2026-10-15',
        serviceJourney: 'b2b_api_orders',
        totalTransactions: 2000,
        successfulTransactions: 1980,
        p95LatencyMs: 320,
        downtimeMinutes: 60,
        supportTicketsCount: 4,
        supportBreachesCount: 0,
        fulfillmentDispatchesCount: 50,
        fulfillmentDelaysCount: 0
      },
      { now: NOW }
    )

    // Add auditable exclusion: 45 minutes of scheduled maintenance with notice
    await recordD1B2BExclusion(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000008',
        idempotencyKey: 'excl-maint-oct15',
        contractId: contract.id,
        reasonCategory: 'scheduled_maintenance',
        startTime: '2026-10-15T02:00:00Z',
        endTime: '2026-10-15T02:45:00Z',
        excludedDowntimeMinutes: 45,
        justification: 'Mantenimiento preventivo de base de datos D1 programado y notificado 7 días antes'
      },
      { now: NOW }
    )

    // Generate report for 2026-10 (44640 total minutes in 31 days)
    // Gross downtime = 60 min. Excluded = 45 min. Net chargeable downtime = 15 min.
    // Availability = (44640 - 15) / 44640 = 99.966% >= 99.9% target -> COMPLIANT!
    const report = await generateD1ComplianceReport(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000009',
        idempotencyKey: 'gen-rep-oct-2026',
        contractId: contract.id,
        reportMonth: '2026-10'
      },
      { now: NOW }
    )

    expect(report.totalDowntimeMinutes).toBe(60)
    expect(report.excludedDowntimeMinutes).toBe(45)
    expect(report.netChargeableDowntimeMinutes).toBe(15)
    expect(report.availabilityAchieved).toBeGreaterThanOrEqual(0.999)
    expect(report.availabilityCompliant).toBe(true)
    expect(report.overallCompliant).toBe(true)
    expect(report.penaltyCreditEur).toBe(0.0)
    expect(report.alertLevel).toBe('nominal')
  })

  it('triggers breach alerting and calculates penalty credits when SLA is violated', async () => {
    const contract = await createD1B2BContractSlo(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000010',
        idempotencyKey: 'contract-breach-test',
        customerId: CUSTOMER_ID,
        companyName: 'Lavanderías Industriales del Sur SA',
        contractRef: 'CTR-B2B-2026-BREACH-04',
        tierCode: 'premium_b2b', // Target 99.9% -> allowed downtime in 30 days (43200 min) = 43.2 min
        billingPeriodStart: '2026-11-01T00:00:00Z',
        billingPeriodEnd: '2026-11-30T23:59:59Z'
      },
      { now: NOW }
    )

    await verifyD1OperationalCapacity(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000011',
        idempotencyKey: 'verify-breach-contract',
        contractId: contract.id,
        expectedVersion: 1,
        capacityAssessment: {
          errorBudgetHealthy: true,
          currentHeadroomPercent: 25.0,
          hasDedicatedManager: true
        }
      },
      { now: NOW }
    )

    // Ingest 120 minutes unexcused downtime
    await recordD1B2BSloEvent(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000012',
        idempotencyKey: 'event-breach-120min',
        contractId: contract.id,
        eventDate: '2026-11-10',
        serviceJourney: 'b2b_portal',
        totalTransactions: 1000,
        successfulTransactions: 900,
        p95LatencyMs: 650, // Breaches 400ms target
        downtimeMinutes: 120, // Breaches 43.2 min allowed
        supportTicketsCount: 5,
        supportBreachesCount: 2, // Breached support SLA
        fulfillmentDispatchesCount: 20,
        fulfillmentDelaysCount: 3 // Breached fulfillment
      },
      { now: NOW }
    )

    const report = await generateD1ComplianceReport(
      db,
      CLAIMS,
      {
        commandId: '60000000-0000-4000-8000-000000000013',
        idempotencyKey: 'gen-rep-nov-2026',
        contractId: contract.id,
        reportMonth: '2026-11'
      },
      { now: NOW }
    )

    expect(report.netChargeableDowntimeMinutes).toBe(120)
    expect(report.availabilityCompliant).toBe(false)
    expect(report.latencyCompliant).toBe(false)
    expect(report.supportCompliant).toBe(false)
    expect(report.fulfillmentCompliant).toBe(false)
    expect(report.overallCompliant).toBe(false)
    expect(report.alertLevel).toBe('breached')
    expect(report.penaltyCreditEur).toBeGreaterThan(0) // Tier has 5% penalty credit
  })
})
