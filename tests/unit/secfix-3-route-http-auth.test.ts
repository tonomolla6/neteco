import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleDeliveryRoutesHttp } from '../../workers/fulfillment/delivery-routes-http'
import { addDeliveryRouteStop, reoptimizeDeliveryRoute } from '../../workers/fulfillment/delivery-routes'

vi.mock('../../workers/fulfillment/delivery-routes', () => ({
  addDeliveryRouteStop: vi.fn(async () => ({})),
  reoptimizeDeliveryRoute: vi.fn(async () => ({})),
  createDeliveryDriver: vi.fn(),
  createDeliveryRoute: vi.fn(),
  createDeliveryVehicle: vi.fn(),
  getDeliveryRouteById: vi.fn(),
  listDeliveryDrivers: vi.fn(),
  listDeliveryRoutes: vi.fn(),
  listDeliveryVehicles: vi.fn(),
  DeliveryRouteError: class extends Error {}
}))
const now = '2026-10-29T12:00:00Z'
const identity = '10000000-0000-4000-8000-0000000000a1'
const session = '20000000-0000-4000-8000-0000000000a1'
const config = { password: 'q'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string
const body = {
  recipientName: 'Cliente',
  streetAddress: 'Calle 1',
  postalCode: '28001',
  city: 'Madrid',
  expectedVersion: 1,
  commandId: 'cmd-1'
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec(`
    INSERT OR IGNORE INTO roles(code,name,description) VALUES('admin','Admin','x');
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES('${identity}','a@example.invalid','x','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${session}','${identity}',1,1,'${now}','2026-10-30T12:00:00Z');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${identity}','admin','${now}');
  `)
  database = d1OverSqlite(sqlite)
  cookie = (await issueD1SessionCookie(
    database,
    { identityId: identity, sessionId: session, sessionVersion: 1 },
    config
  ))!
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

describe('SECFIX-3 route HTTP authorization', () => {
  it('rejects a revoked cookie before adding a stop', async () => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, session)
    const res = await handleDeliveryRoutesHttp(
      new Request('https://shop.invalid/api/admin/delivery-routes/r1/stops', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify(body)
      }),
      { database: database as never, sessionCookieConfiguration: config }
    )
    expect([401, 403]).toContain(res?.status)
    expect(addDeliveryRouteStop).not.toHaveBeenCalled()
  })
  it.each(['stops', 'reoptimize'])('checks fresh authority before %s writes', async (action) => {
    const sessionProvider = vi
      .fn()
      .mockResolvedValueOnce({ identityId: identity, roles: ['admin'], permissions: [] })
      .mockResolvedValueOnce(null)
    const res = await handleDeliveryRoutesHttp(
      new Request(`https://shop.invalid/api/admin/delivery-routes/r1/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'stops' ? body : { expectedVersion: 1, commandId: 'cmd-1' })
      }),
      { database: database as never, sessionProvider }
    )
    expect(res?.status).toBe(403)
    expect(addDeliveryRouteStop).not.toHaveBeenCalled()
    expect(reoptimizeDeliveryRoute).not.toHaveBeenCalled()
  })
})
