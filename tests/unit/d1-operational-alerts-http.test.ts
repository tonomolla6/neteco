import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleOperationalAlertsHttp,
  ownsOperationalAlertsNamespace,
  type OperationalAlertsHttpDependencies
} from '../../workers/communications/operational-alerts-http'

const NOW = '2026-10-29T14:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NOPERMS_ID = '10000000-0000-4000-8000-000000000002'
const NOMFA_ID = '10000000-0000-4000-8000-000000000003'

const session = (n: number) => `20000000-0000-4000-8000-00000000000${n}`
const ADMIN = { identityId: ADMIN_ID, sessionId: session(1), sessionVersion: 1 }
const NOPERMS = { identityId: NOPERMS_ID, sessionId: session(2), sessionVersion: 1 }
const NOMFA = { identityId: NOMFA_ID, sessionId: session(3), sessionVersion: 1 }

const BASE = 'https://shop.example/api/admin/operations/alerts'
let counter = 0
const uuid = () => `a0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

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

describe('COM-019 Operational Alerts HTTP', () => {
  let sqlite: DatabaseSync
  let deps: OperationalAlertsHttpDependencies

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

  it('owns only its namespace, including percent-encoded paths', () => {
    expect(ownsOperationalAlertsNamespace('/api/admin/operations/alerts')).toBe(true)
    expect(ownsOperationalAlertsNamespace('/api/admin/operations/%61lerts')).toBe(true)
    expect(ownsOperationalAlertsNamespace('/api/admin/operations/alerts/123')).toBe(true)
    expect(ownsOperationalAlertsNamespace('/api/admin/operations/other')).toBe(false)
  })

  it('returns null outside namespace', async () => {
    const res = await handleOperationalAlertsHttp(req('https://shop.example/api/other'), deps)
    expect(res).toBeNull()
  })

  it('enforces authentication, permissions, and MFA', async () => {
    const anon = await handleOperationalAlertsHttp(req(BASE), deps)
    expect(anon?.status).toBe(401)
    expect(anon?.headers.get('cache-control')).toBe('private, no-store')

    const noPerms = await handleOperationalAlertsHttp(req(BASE, { session: 'noperms' }), deps)
    expect(noPerms?.status).toBe(403)

    const noMfa = await handleOperationalAlertsHttp(req(BASE, { session: 'nomfa' }), deps)
    expect(noMfa?.status).toBe(403)
    const err = await noMfa?.json()
    expect(err.error.code).toBe('mfa_required')
  })

  it('rejects cross-origin mutations', async () => {
    const res = await handleOperationalAlertsHttp(
      req(BASE, {
        method: 'POST',
        session: 'admin',
        origin: 'https://attacker.example',
        body: { alertId: uuid(), commandId: uuid(), area: 'warehouse', severity: 'info' }
      }),
      deps
    )
    expect(res?.status).toBe(403)
  })

  it('rejects un-auditable personal communication channels (COM-019 acceptance criterion)', async () => {
    const res = await handleOperationalAlertsHttp(
      req(BASE, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          alertId: uuid(),
          commandId: uuid(),
          area: 'warehouse',
          severity: 'info',
          category: 'general_operational',
          title: 'Notificación personal no auditable',
          description: 'Aviso urgente',
          locationRef: 'DOCK-1',
          unapprovedChannel: 'whatsapp_personal_group'
        }
      }),
      deps
    )
    expect(res?.status).toBe(400)
    const data = await res?.json()
    expect(data.error.code).toBe('invalid_input')
  })

  it('creates an informational alert and dispatches to primary channel', async () => {
    const alertId = uuid()
    const commandId = uuid()
    const res = await handleOperationalAlertsHttp(
      req(BASE, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          alertId,
          commandId,
          area: 'warehouse',
          severity: 'info',
          category: 'general_operational',
          title: 'Muelle 2 ocupado temporalmente',
          description: 'Descarga de proveedor químico en curso',
          locationRef: 'DOCK-2'
        }
      }),
      deps
    )
    expect(res?.status).toBe(201)
    const data = await res?.json()
    expect(data.alert.id).toBe(alertId)
    expect(data.alert.redundantChannelRequired).toBe(false)
    expect(data.alert.dispatches.length).toBe(1)
    expect(data.alert.dispatches[0].channel).toBe('dashboard')
  })

  it('creates a critical exception alert and automatically triggers redundant channel', async () => {
    const alertId = uuid()
    const commandId = uuid()
    const res = await handleOperationalAlertsHttp(
      req(BASE, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          alertId,
          commandId,
          area: 'warehouse',
          severity: 'critical',
          category: 'chemical_spill',
          title: 'Derrame químico corrosivo pasillo B3',
          description: 'Rotura de bidón de hipoclorito; protocolo de contención activado',
          locationRef: 'AISLE-B3'
        }
      }),
      deps
    )
    expect(res?.status).toBe(201)
    const data = await res?.json()
    expect(data.alert.id).toBe(alertId)
    expect(data.alert.severity).toBe('critical')
    expect(data.alert.redundantChannelRequired).toBe(true)
    expect(data.alert.redundantChannelDispatched).toBe(true)
    expect(data.alert.dispatches.length).toBe(2)
    expect(data.alert.dispatches.some((d: { isRedundant: boolean }) => d.isRedundant)).toBe(true)
  })

  it('manages full lifecycle: list -> ack -> escalate -> resolve with CAS', async () => {
    const alertId = uuid()
    const createCmd = uuid()

    // 1. Create alert
    await handleOperationalAlertsHttp(
      req(BASE, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          alertId,
          commandId: createCmd,
          area: 'delivery',
          severity: 'critical',
          category: 'vehicle_breakdown',
          title: 'Avería furgoneta reparto ruta norte',
          description: 'Parada motor en A-1 km 42',
          locationRef: 'ROUTE-NORTH-VEH-04'
        }
      }),
      deps
    )

    // 2. List alerts
    const listRes = await handleOperationalAlertsHttp(
      req(`${BASE}?area=delivery&severity=critical`, { session: 'admin' }),
      deps
    )
    expect(listRes?.status).toBe(200)
    const listData = await listRes?.json()
    expect(listData.items.length).toBe(1)
    expect(listData.items[0].id).toBe(alertId)
    expect(listData.items[0].version).toBe(1)

    // 3. Acknowledge with CAS version 1
    const ackCmd = uuid()
    const ackRes = await handleOperationalAlertsHttp(
      req(`${BASE}/${alertId}/ack`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: ackCmd,
          expectedVersion: 1,
          ackNote: 'Recibido por supervisor de tráfico; coordinando grúa'
        }
      }),
      deps
    )
    expect(ackRes?.status).toBe(200)
    const ackData = await ackRes?.json()
    expect(ackData.alert.status).toBe('acknowledged')
    expect(ackData.alert.version).toBe(2)
    expect(ackData.alert.ackNote).toContain('supervisor de tráfico')

    // Stale CAS fails with 409
    const staleAckRes = await handleOperationalAlertsHttp(
      req(`${BASE}/${alertId}/ack`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          expectedVersion: 1, // Stale!
          ackNote: 'Intento duplicado'
        }
      }),
      deps
    )
    expect(staleAckRes?.status).toBe(409)

    // 4. Escalate to tier 2 with CAS version 2
    const escCmd = uuid()
    const escRes = await handleOperationalAlertsHttp(
      req(`${BASE}/${alertId}/escalate`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: escCmd,
          expectedVersion: 2,
          targetTier: 2,
          escalationReason: 'Grúa retrasada > 45min, escalado a jefatura de operaciones'
        }
      }),
      deps
    )
    expect(escRes?.status).toBe(200)
    const escData = await escRes?.json()
    expect(escData.alert.status).toBe('escalated')
    expect(escData.alert.escalationTier).toBe(2)
    expect(escData.alert.version).toBe(3)

    // 5. Resolve with CAS version 3
    const resolveCmd = uuid()
    const resolveRes = await handleOperationalAlertsHttp(
      req(`${BASE}/${alertId}/resolve`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: resolveCmd,
          expectedVersion: 3,
          resolutionNote: 'Vehículo de reemplazo en ruta, pedidos reasignados sin rotura'
        }
      }),
      deps
    )
    expect(resolveRes?.status).toBe(200)
    const resolveData = await resolveRes?.json()
    expect(resolveData.alert.status).toBe('resolved')
    expect(resolveData.alert.version).toBe(4)

    // 6. Get single alert
    const getRes = await handleOperationalAlertsHttp(req(`${BASE}/${alertId}`, { session: 'admin' }), deps)
    expect(getRes?.status).toBe(200)
    const getData = await getRes?.json()
    expect(getData.alert.status).toBe('resolved')
    expect(getData.alert.dispatches.length).toBeGreaterThanOrEqual(2)
  })
})
