import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleWarehouseRouteTelemetryHttp,
  ownsWarehouseRouteTelemetryNamespace,
  type WarehouseRouteTelemetryHttpDependencies
} from '../../workers/observability/warehouse-route-telemetry-http'

const NOW = '2026-10-29T14:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NOPERMS_ID = '10000000-0000-4000-8000-000000000002'
const NOMFA_ID = '10000000-0000-4000-8000-000000000003'

const session = (n: number) => `20000000-0000-4000-8000-00000000000${n}`
const ADMIN = { identityId: ADMIN_ID, sessionId: session(1), sessionVersion: 1 }
const NOPERMS = { identityId: NOPERMS_ID, sessionId: session(2), sessionVersion: 1 }
const NOMFA = { identityId: NOMFA_ID, sessionId: session(3), sessionVersion: 1 }

const BASE = 'https://shop.example/api/admin/observability/telemetry'
let counter = 0
const uuid = () => `c0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

async function setupTestDb(): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql', import.meta.url),
      'utf8'
    )
  )

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture'),
      ('operator', 'Operador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOPERMS_ID}', NULL, 'operator@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOMFA_ID}', NULL, 'nomfa@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NOMFA_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN.sessionId}', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-11-29T14:00:00Z'),
      ('${NOPERMS.sessionId}', '${NOPERMS_ID}', 1, 1, '${NOW}', '2026-11-29T14:00:00Z'),
      ('${NOMFA.sessionId}', '${NOMFA_ID}', 1, 0, '${NOW}', '2026-11-29T14:00:00Z');
  `)

  return { sqlite, db: d1OverSqlite(sqlite) }
}

const claimsResolver = async (request: Request) => {
  switch (request.headers.get('x-test-session')) {
    case 'admin':
      return ADMIN
    case 'noperms':
      return NOPERMS
    case 'nomfa':
      return NOMFA
    default:
      return null
  }
}

function req(path: string, options: { method?: string; body?: unknown; session?: string; origin?: string } = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8'
  })
  if (options.session) headers.set('x-test-session', options.session)
  if (options.origin) headers.set('origin', options.origin)
  return new Request(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })
}

describe('OBS-029 Warehouse & Route Telemetry HTTP', () => {
  let sqlite: DatabaseSync
  let deps: WarehouseRouteTelemetryHttpDependencies

  beforeEach(async () => {
    const fixture = await setupTestDb()
    sqlite = fixture.sqlite
    deps = {
      database: fixture.db,
      sessionCookieConfiguration: { password: 'x'.repeat(40), maxAgeSeconds: 3600 },
      origin: 'https://shop.example',
      now: () => NOW,
      claimsResolver
    }
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('owns only its namespace', () => {
    expect(ownsWarehouseRouteTelemetryNamespace('/api/admin/observability/telemetry')).toBe(true)
    expect(ownsWarehouseRouteTelemetryNamespace('/api/admin/observability/telemetry/events')).toBe(true)
    expect(ownsWarehouseRouteTelemetryNamespace('/api/admin/observability/telemetry/devices')).toBe(true)
    expect(ownsWarehouseRouteTelemetryNamespace('/api/admin/observability/telemetry/compute')).toBe(true)
    expect(ownsWarehouseRouteTelemetryNamespace('/api/admin/observability/other')).toBe(false)
  })

  it('enforces authentication and permissions', async () => {
    const anon = await handleWarehouseRouteTelemetryHttp(req(`${BASE}/devices`), deps)
    expect(anon?.status).toBe(401)
    const noPerms = await handleWarehouseRouteTelemetryHttp(req(`${BASE}/devices`, { session: 'noperms' }), deps)
    expect(noPerms?.status).toBe(403)
  })

  it('rejects telemetry ingestion if labor privacy review is NOT explicitly confirmed', async () => {
    const res = await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/events`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'cmd-telemetry-privacy-fail',
          facet: 'pick_rate',
          shiftCode: 'morning',
          zoneCode: 'chemicals_bulk',
          operatorId: 'operator-alberto-78',
          metricPrimary: 45.5,
          laborPrivacyReviewed: false, // Must be true!
          occurredAt: NOW
        }
      }),
      deps
    )
    expect(res?.status).toBe(403)
    const data = await res?.json()
    expect(data.error.code).toBe('labor_privacy_violation')
  })

  it('records event, pseudonymizing operator ID with 64-char SHA-256 for labor privacy', async () => {
    const res = await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/events`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'cmd-telemetry-event-1',
          facet: 'pick_rate',
          shiftCode: 'morning',
          zoneCode: 'chemicals_bulk',
          operatorId: 'operator-alberto-78',
          metricPrimary: 52.0,
          errorCount: 1,
          laborPrivacyReviewed: true,
          occurredAt: NOW
        }
      }),
      deps
    )
    expect(res?.status).toBe(201)
    const data = await res?.json()
    expect(data.event.facet).toBe('pick_rate')
    expect(data.event.laborPrivacyReviewed).toBe(true)
    expect(data.event.operatorPseudonym.length).toBe(64)
    expect(data.event.operatorPseudonym).not.toContain('alberto')
  })

  it('records device heartbeat and lists warehouse devices fleet', async () => {
    const postRes = await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/devices/heartbeat`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'cmd-device-heartbeat-1',
          deviceId: 'rf-terminal-wh-01',
          deviceType: 'rf_scanner',
          batteryPercent: 88,
          appVersion: 'v2.4.1',
          syncLatencyMs: 42,
          offlineQueueDepth: 0,
          errorCount24h: 0,
          status: 'online'
        }
      }),
      deps
    )
    expect(postRes?.status).toBe(200)

    const listRes = await handleWarehouseRouteTelemetryHttp(req(`${BASE}/devices`, { session: 'admin' }), deps)
    expect(listRes?.status).toBe(200)
    const listData = await listRes?.json()
    expect(listData.devices.length).toBe(1)
    expect(listData.devices[0].deviceId).toBe('rf-terminal-wh-01')
    expect(listData.devices[0].status).toBe('online')
  })

  it('computes and retrieves shift aggregates across all 8 facets', async () => {
    // 1. Ingest events for facets
    await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/events`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'event-pick',
          facet: 'pick_rate',
          shiftCode: 'morning',
          zoneCode: 'chemicals_bulk',
          operatorId: 'worker-1',
          metricPrimary: 60,
          errorCount: 2,
          laborPrivacyReviewed: true,
          occurredAt: NOW
        }
      }),
      deps
    )

    // 2. Compute aggregate
    const computeRes = await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/compute`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'compute-morning-2026-10-29',
          periodDate: '2026-10-29',
          shiftCode: 'morning',
          zoneCode: 'chemicals_bulk'
        }
      }),
      deps
    )
    expect(computeRes?.status).toBe(200)
    const computeData = await computeRes?.json()
    expect(computeData.aggregate.periodDate).toBe('2026-10-29')
    expect(computeData.aggregate.laborPrivacyReviewed).toBe(true)

    // 3. Get aggregate
    const getRes = await handleWarehouseRouteTelemetryHttp(
      req(`${BASE}/aggregates?periodDate=2026-10-29&shiftCode=morning&zoneCode=chemicals_bulk`, { session: 'admin' }),
      deps
    )
    expect(getRes?.status).toBe(200)
    const getData = await getRes?.json()
    expect(getData.aggregate.periodDate).toBe('2026-10-29')
    expect(getData.aggregate.shiftCode).toBe('morning')
  })
})
