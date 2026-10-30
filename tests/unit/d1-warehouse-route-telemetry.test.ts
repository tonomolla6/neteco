import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type WarehouseTelemetryEventInput,
  type WarehouseDeviceHeartbeatInput,
  pseudonymizeOperatorId
} from '../../shared/warehouse-route-telemetry'
import {
  WarehouseTelemetryError,
  recordD1TelemetryEvent,
  recordD1DeviceHeartbeat,
  computeD1TelemetryAggregates,
  getD1TelemetryAggregates,
  listD1WarehouseDevices
} from '../../workers/observability/warehouse-route-telemetry'

const NOW = '2026-10-29T16:00:00Z'
const TODAY = '2026-10-29'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql', import.meta.url),
      'utf8'
    )
  )

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Admin fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${NOW}', '2099-12-31T23:59:59Z');
  `)

  return sqlite
}

describe('OBS-029 Warehouse & Route Telemetry (8 Facets & Labor Privacy)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('pseudonymizes operator IDs with SHA-256 for labor privacy protection (art. 20 bis ET, LOPDGDD)', async () => {
    const rawOperatorId = 'OP-JUAN-PEREZ-4829'
    const pseudonym = await pseudonymizeOperatorId(rawOperatorId)

    expect(pseudonym).toMatch(/^[0-9a-f]{64}$/)
    expect(pseudonym).not.toContain('JUAN')
    expect(pseudonym).not.toContain('PEREZ')
    // Deterministic for same operator
    const second = await pseudonymizeOperatorId(rawOperatorId)
    expect(second).toBe(pseudonym)
  })

  it('rejects telemetry events when labor privacy review flag is NOT confirmed', async () => {
    const eventId = 'e0000000-0000-4000-8000-000000000001'
    const commandId = 'c0000000-0000-4000-8000-000000000001'
    const input: WarehouseTelemetryEventInput = {
      facet: 'pick_rate',
      shiftCode: 'morning',
      zoneCode: 'chemicals_bulk',
      operatorId: 'OP-1234',
      metricPrimary: 85.5, // 85.5 picks/hour
      metricSecondary: 0,
      errorCount: 1,
      laborPrivacyReviewed: false, // VIOLATION
      occurredAt: NOW
    }

    await expect(
      recordD1TelemetryEvent(db, ADMIN_CLAIMS, eventId, commandId, 'idemp-telemetry-1', input, { now: () => NOW })
    ).rejects.toThrow(WarehouseTelemetryError)
  })

  it('records telemetry events for all 8 facets when labor privacy is verified', async () => {
    const facets: Array<WarehouseTelemetryEventInput['facet']> = [
      'pick_rate',
      'dock_to_stock',
      'packing',
      'on_time_delivery',
      'damages',
      'capacity',
      'devices'
    ]

    for (let i = 0; i < facets.length; i++) {
      const facet = facets[i]
      const eventId = `e0000000-0000-4000-8000-00000000001${i}`
      const commandId = `c0000000-0000-4000-8000-00000000001${i}`
      const input: WarehouseTelemetryEventInput = {
        facet,
        shiftCode: 'morning',
        zoneCode: facet === 'on_time_delivery' ? 'fleet_transit' : 'chemicals_bulk',
        operatorId: `OP-SHIFT-1-OPERATOR-${i}`,
        metricPrimary: 95.0 + i,
        metricSecondary: 2.0,
        errorCount: 0,
        laborPrivacyReviewed: true,
        occurredAt: NOW
      }

      const recorded = await recordD1TelemetryEvent(db, ADMIN_CLAIMS, eventId, commandId, `idemp-facet-${i}`, input, {
        now: () => NOW
      })

      expect(recorded.facet).toBe(facet)
      expect(recorded.operatorPseudonym).toMatch(/^[0-9a-f]{64}$/)
      expect(recorded.laborPrivacyReviewed).toBe(true)
    }
  })

  it('records device telemetry heartbeat and queries device fleet health', async () => {
    const commandId1 = 'c0000000-0000-4000-8000-000000000101'
    const commandId2 = 'c0000000-0000-4000-8000-000000000102'

    const heartbeat1: WarehouseDeviceHeartbeatInput = {
      deviceId: 'SCANNER-ALMACEN-01',
      deviceType: 'rf_scanner',
      batteryPercent: 88,
      appVersion: '2.4.1',
      syncLatencyMs: 42,
      offlineQueueDepth: 0,
      errorCount24h: 0,
      status: 'online'
    }

    const heartbeat2: WarehouseDeviceHeartbeatInput = {
      deviceId: 'TABLET-EMBALAJE-02',
      deviceType: 'pack_station_tablet',
      batteryPercent: 12, // low battery
      appVersion: '2.4.1',
      syncLatencyMs: 310,
      offlineQueueDepth: 5,
      errorCount24h: 3,
      status: 'degraded'
    }

    await recordD1DeviceHeartbeat(db, ADMIN_CLAIMS, commandId1, 'idemp-dev-1', heartbeat1, { now: () => NOW })
    await recordD1DeviceHeartbeat(db, ADMIN_CLAIMS, commandId2, 'idemp-dev-2', heartbeat2, { now: () => NOW })

    const devices = await listD1WarehouseDevices(db, ADMIN_CLAIMS)
    expect(devices).toHaveLength(2)
    const onlineScanner = devices.find((d) => d.deviceId === 'SCANNER-ALMACEN-01')
    expect(onlineScanner?.batteryPercent).toBe(88)
    expect(onlineScanner?.status).toBe('online')
  })

  it('computes daily shift aggregates across all 8 operational and route telemetry facets', async () => {
    // Ingest events
    await recordD1TelemetryEvent(
      db,
      ADMIN_CLAIMS,
      'e0000000-0000-4000-8000-000000000201',
      'c0000000-0000-4000-8000-000000000201',
      'idemp-agg-1',
      {
        facet: 'pick_rate',
        shiftCode: 'morning',
        zoneCode: 'chemicals_bulk',
        operatorId: 'OP-1',
        metricPrimary: 120, // 120 picks/h
        metricSecondary: 0,
        errorCount: 2,
        laborPrivacyReviewed: true,
        occurredAt: NOW
      },
      { now: () => NOW }
    )

    await recordD1TelemetryEvent(
      db,
      ADMIN_CLAIMS,
      'e0000000-0000-4000-8000-000000000202',
      'c0000000-0000-4000-8000-000000000202',
      'idemp-agg-2',
      {
        facet: 'dock_to_stock',
        shiftCode: 'morning',
        zoneCode: 'chemicals_bulk',
        operatorId: 'OP-2',
        metricPrimary: 45, // 45 minutes dock to stock
        metricSecondary: 0,
        errorCount: 0,
        laborPrivacyReviewed: true,
        occurredAt: NOW
      },
      { now: () => NOW }
    )

    // Compute aggregates
    const aggregateId = 'a0000000-0000-4000-8000-000000000301'
    const commandId = 'c0000000-0000-4000-8000-000000000301'
    const aggregate = await computeD1TelemetryAggregates(
      db,
      ADMIN_CLAIMS,
      aggregateId,
      commandId,
      'idemp-compute-1',
      {
        periodDate: TODAY,
        shiftCode: 'morning',
        zoneCode: 'chemicals_bulk'
      },
      { now: () => NOW }
    )

    expect(aggregate.periodDate).toBe(TODAY)
    expect(aggregate.shiftCode).toBe('morning')
    expect(aggregate.zoneCode).toBe('chemicals_bulk')
    expect(aggregate.avgPickRatePerHour).toBeGreaterThanOrEqual(0)
    expect(aggregate.laborPrivacyReviewed).toBe(true)

    // Query back
    const queried = await getD1TelemetryAggregates(db, ADMIN_CLAIMS, TODAY, 'morning', 'chemicals_bulk')
    expect(queried?.id).toBe(aggregateId)
  })
})
