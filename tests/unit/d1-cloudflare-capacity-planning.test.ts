import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { type SimulateCampaignInput, CloudflareCapacityError } from '../../shared/cloudflare-capacity-planning'
import {
  initializeD1CapacityMetrics,
  simulateD1CampaignCapacity,
  approveD1CampaignPlan,
  readD1CapacityMetrics
} from '../../workers/observability/capacity-planning'

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
      ('admin', 'Administración', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-capacity@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)
  return sqlite
}

describe('OBS-026: Capacity planning Cloudflare', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
    await initializeD1CapacityMetrics(db, CLAIMS, { now: NOW })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('initializes and reads baseline metrics for all Cloudflare subsystems and providers', async () => {
    const metrics = await readD1CapacityMetrics(db)
    expect(metrics.length).toBeGreaterThanOrEqual(14)

    const keys = metrics.map((m) => m.resourceKey)
    expect(keys).toContain('worker_cpu_ms')
    expect(keys).toContain('worker_subrequests')
    expect(keys).toContain('d1_rows_read_daily')
    expect(keys).toContain('d1_rows_written_daily')
    expect(keys).toContain('d1_storage_bytes')
    expect(keys).toContain('do_connections_hotspot')
    expect(keys).toContain('r2_class_a_operations_monthly')
    expect(keys).toContain('r2_class_b_operations_monthly')
    expect(keys).toContain('r2_storage_bytes')
    expect(keys).toContain('queues_backlog_messages')
    expect(keys).toContain('workflows_active_instances')
    expect(keys).toContain('cdn_edge_bandwidth_gb')
    expect(keys).toContain('provider_redsys_tps')
    expect(keys).toContain('provider_beply_rate_limit')

    for (const m of metrics) {
      expect(m.quotaLimit).toBeGreaterThan(0)
      expect(m.headroomPercent).toBeGreaterThanOrEqual(0)
    }
  })

  it('simulates a moderate pre-campaign load and passes with healthy headroom', async () => {
    const input: SimulateCampaignInput = {
      commandId: '40000000-0000-4000-8000-000000000001',
      idempotencyKey: 'sim-black-friday-moderate',
      campaignName: 'Campaña Limpieza Industrial Otoño',
      startTime: '2026-11-10T08:00:00Z',
      endTime: '2026-11-12T20:00:00Z',
      projectedPeakMultiplier: 2.0,
      projectedVisitorsPeak: 5000,
      projectedOrdersHour: 120
    }

    const plan = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    expect(plan.campaignName).toBe('Campaña Limpieza Industrial Otoño')
    expect(plan.status).toBe('simulated_passed')
    expect(plan.headroomVerdict).toBe('healthy')
    expect(plan.minHeadroomPercent).toBeGreaterThanOrEqual(20.0)
    expect(plan.estimatedCloudflareCostEur).toBeGreaterThan(0)
    expect(plan.mitigations.length).toBe(0)
  })

  it('detects low headroom warning and generates actionable mitigations', async () => {
    // 5x multiplier pushes D1 rows read or DO hotspot into warning territory (< 20% headroom)
    const input: SimulateCampaignInput = {
      commandId: '40000000-0000-4000-8000-000000000002',
      idempotencyKey: 'sim-flash-sale-warning',
      campaignName: 'Venta Flash Químicos 5x',
      startTime: '2026-11-20T10:00:00Z',
      endTime: '2026-11-20T18:00:00Z',
      projectedPeakMultiplier: 4.8,
      projectedVisitorsPeak: 20000,
      projectedOrdersHour: 600
    }

    const plan = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    expect(plan.status).toBe('simulated_warning')
    expect(plan.headroomVerdict).toBe('warning_headroom_low')
    expect(plan.minHeadroomPercent).toBeLessThan(20.0)
    expect(plan.minHeadroomPercent).toBeGreaterThanOrEqual(0.0)
    expect(plan.mitigations.length).toBeGreaterThan(0)
    expect(plan.bottlenecks.some((b) => b.status === 'warning')).toBe(true)
  })

  it('fails simulation when peak load exhausts subsystem quota (e.g. Redsys TPS or DO hotspot)', async () => {
    // 15x multiplier overwhelms payment provider TPS and DO connection limit
    const input: SimulateCampaignInput = {
      commandId: '40000000-0000-4000-8000-000000000003',
      idempotencyKey: 'sim-excessive-fail',
      campaignName: 'Campaña Desproporcionada 15x',
      startTime: '2026-11-25T00:00:00Z',
      endTime: '2026-11-26T00:00:00Z',
      projectedPeakMultiplier: 15.0,
      projectedVisitorsPeak: 80000,
      projectedOrdersHour: 3500
    }

    const plan = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    expect(plan.status).toBe('simulated_failed')
    expect(plan.headroomVerdict).toBe('critical_quota_exhausted')
    expect(plan.minHeadroomPercent).toBeLessThan(0)
    expect(plan.bottlenecks.some((b) => b.status === 'critical')).toBe(true)
  })

  it('approves a passed or warned campaign plan with CAS concurrency check', async () => {
    const input: SimulateCampaignInput = {
      commandId: '40000000-0000-4000-8000-000000000004',
      idempotencyKey: 'sim-to-approve',
      campaignName: 'Black Friday Oficial 2026',
      startTime: '2026-11-27T00:00:00Z',
      endTime: '2026-11-29T23:59:59Z',
      projectedPeakMultiplier: 2.5,
      projectedVisitorsPeak: 7500,
      projectedOrdersHour: 200
    }

    const plan = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    expect(plan.version).toBe(1)

    // Concurrency mismatch check (wrong expected version)
    await expect(
      approveD1CampaignPlan(
        db,
        CLAIMS,
        {
          commandId: '40000000-0000-4000-8000-000000000005',
          idempotencyKey: 'approve-wrong-version',
          planId: plan.id,
          expectedVersion: 99
        },
        { now: NOW }
      )
    ).rejects.toThrow(CloudflareCapacityError)

    // Valid approval
    const approved = await approveD1CampaignPlan(
      db,
      CLAIMS,
      {
        commandId: '40000000-0000-4000-8000-000000000006',
        idempotencyKey: 'approve-valid',
        planId: plan.id,
        expectedVersion: 1
      },
      { now: NOW }
    )

    expect(approved.status).toBe('approved')
    expect(approved.version).toBe(2)
  })

  it('enforces command idempotency and immutable audit triggers', async () => {
    const input: SimulateCampaignInput = {
      commandId: '40000000-0000-4000-8000-000000000007',
      idempotencyKey: 'sim-idemp',
      campaignName: 'Test Idempotencia',
      startTime: '2026-12-01T00:00:00Z',
      endTime: '2026-12-02T00:00:00Z',
      projectedPeakMultiplier: 1.5,
      projectedVisitorsPeak: 2000,
      projectedOrdersHour: 50
    }

    const first = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    const replay = await simulateD1CampaignCapacity(db, CLAIMS, input, { now: NOW })
    expect(first.id).toBe(replay.id)

    expect(() => {
      sqlite.exec(
        `UPDATE cloudflare_capacity_commands SET action = 'simulate_campaign' WHERE command_id = '${input.commandId}'`
      )
    }).toThrow(/cloudflare_capacity_command_immutable/)
  })
})
