import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleWarehouseScanHttp,
  ownsWarehouseScanNamespace,
  type WarehouseScanHttpDependencies
} from '../../workers/fulfillment/warehouse-scan-operations-http'

const NOW = '2026-10-29T12:00:00Z'
const WAREHOUSE_USER_ID = '10000000-0000-4000-8000-000000000031'
const NON_WAREHOUSE_ID = '10000000-0000-4000-8000-000000000099'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('warehouse', 'Almacén', 'Rol almacén'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('fulfillment.manage', 'fulfillment', 'manage', 'Gestión fulfillment');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('warehouse', 'fulfillment.manage'),
      ('warehouse', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${WAREHOUSE_USER_ID}', 'warehouse-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_WAREHOUSE_ID}', 'user-wh@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000031', '${WAREHOUSE_USER_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('20000000-0000-4000-8000-000000000099', '${NON_WAREHOUSE_ID}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${WAREHOUSE_USER_ID}', 'warehouse', '${NOW}'),
      ('${NON_WAREHOUSE_ID}', 'customer', '${NOW}');

    INSERT OR IGNORE INTO warehouse_printers (id, name, location, protocol, endpoint_address, status, supported_formats_json, updated_at) VALUES
      ('zebra-pack-01', 'Zebra Packing 1', 'Muelle C', 'zpl', 'tcp://192.168.1.100', 'online', '["parcel_4x6"]', '${NOW}');
  `)

  return sqlite
}

async function makeCookie(db: D1Database, identityId: string, sessionId: string): Promise<string> {
  const cookie = await issueD1SessionCookie(
    db,
    { identityId, sessionId, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  )
  return cookie?.split(';')[0] ?? ''
}

describe('ADM-031: Warehouse Scan Operations HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: WarehouseScanHttpDependencies
  let warehouseCookie: string
  let nonWarehouseCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    db = d1OverSqlite(sqlite)
    warehouseCookie = await makeCookie(db, WAREHOUSE_USER_ID, '20000000-0000-4000-8000-000000000031')
    nonWarehouseCookie = await makeCookie(db, NON_WAREHOUSE_ID, '20000000-0000-4000-8000-000000000099')
    deps = {
      database: db,
      origin: ORIGIN,
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('matches routing namespace', () => {
    expect(ownsWarehouseScanNamespace('/api/admin/warehouse/queues')).toBe(true)
    expect(ownsWarehouseScanNamespace('/api/admin/warehouse/scan')).toBe(true)
    expect(ownsWarehouseScanNamespace('/api/admin/warehouse/exceptions')).toBe(true)
    expect(ownsWarehouseScanNamespace('/api/admin/warehouse/printers')).toBe(true)
    expect(ownsWarehouseScanNamespace('/api/admin/warehouse/metrics')).toBe(true)
    expect(ownsWarehouseScanNamespace('/api/store/cart')).toBe(false)
  })

  it('GET /api/admin/warehouse/queues returns queue lists and counts', async () => {
    const req = new Request(`${ORIGIN}/api/admin/warehouse/queues`, {
      method: 'GET',
      headers: {
        Cookie: warehouseCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleWarehouseScanHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.reception).toBeInstanceOf(Array)
    expect(data.picking).toBeInstanceOf(Array)
    expect(data.packing).toBeInstanceOf(Array)
  })

  it('POST /api/admin/warehouse/exceptions creates warehouse exception', async () => {
    const req = new Request(`${ORIGIN}/api/admin/warehouse/exceptions`, {
      method: 'POST',
      headers: {
        Cookie: warehouseCookie,
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'X-Command-Id': '30000000-0000-4000-8000-000000000060'
      },
      body: JSON.stringify({
        targetType: 'order',
        targetId: 'ORD-2026-8888',
        exceptionType: 'damaged_item',
        severity: 'high',
        reason: 'Botella de ácido sulfúrico con tapón rajado, producto confinado para neutralización'
      })
    })

    const res = await handleWarehouseScanHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(201)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.id).toBeDefined()
    expect(data.exceptionType).toBe('damaged_item')
  })

  it('GET /api/admin/warehouse/metrics returns live metrics', async () => {
    const req = new Request(`${ORIGIN}/api/admin/warehouse/metrics`, {
      method: 'GET',
      headers: {
        Cookie: warehouseCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleWarehouseScanHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const data = (await res!.json()) as Record<string, unknown>
    expect(data.queueCounts).toBeDefined()
    expect(data.dailyStats).toBeDefined()
  })

  it('rejects unauthorized access without warehouse permissions', async () => {
    const req = new Request(`${ORIGIN}/api/admin/warehouse/metrics`, {
      method: 'GET',
      headers: {
        Cookie: nonWarehouseCookie,
        Origin: ORIGIN
      }
    })

    const res = await handleWarehouseScanHttp(req, deps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})
