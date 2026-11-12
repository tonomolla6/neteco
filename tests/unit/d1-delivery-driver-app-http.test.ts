/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in this test file */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleDeliveryDriverAppHttp,
  ownsDeliveryDriverAppNamespace
} from '../../workers/fulfillment/delivery-driver-app-http'
import { ADMIN, DRIVER_IDENTITY, NOW, OTHER, opsWorld, type OpsWorld } from './shipping-ops-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

let w: OpsWorld
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const T = '2026-10-29T09:30:00Z'

beforeEach(async () => {
  w = await opsWorld()
  w.sqlite.exec(`
    INSERT INTO delivery_drivers(id,identity_id,name,phone,license_number,status,created_at,updated_at) VALUES('d-1','${DRIVER_IDENTITY}','Conductor','+34600111222','LIC-1','active','${NOW}','${NOW}');
    INSERT INTO delivery_routes(id,route_date,vehicle_id,driver_id,status,window_start,window_end,total_stops,total_parcels,total_weight_grams,version,created_at,updated_at) VALUES('r-1','2026-10-29',NULL,'d-1','planned','08:00','16:00',1,1,1000,1,'${NOW}','${NOW}');
    INSERT INTO delivery_route_stops(id,route_id,sequence_index,order_id,recipient_name,street_address,postal_code,city,parcel_count,weight_grams,status) VALUES('s-1','r-1',0,NULL,'Taller Alfa','Calle A 1','46870','Ontinyent',1,1000,'pending');
  `)
})
afterEach(() => w.close())

const call = async (
  method: string,
  path: string,
  body?: unknown,
  identity: string | null = DRIVER_IDENTITY,
  raw?: string
) => {
  const response = await handleDeliveryDriverAppHttp(
    new Request(`https://tienda.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    { database: w.db, sessionProvider: async () => (identity ? { identityId: identity } : null), now: () => NOW }
  )
  const buffer = Buffer.from(await response!.arrayBuffer())
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    /* binary */
  }
  return { response: response!, json, buffer }
}
let n = 0
const ev = (extra: Record<string, unknown>) => ({
  commandId: `cmd-http-${String(++n).padStart(6, '0')}`,
  occurredAt: T,
  ...extra
})

describe('SHP-027 delivery app HTTP', () => {
  it('rechecks the cookie session and MFA for admin reports', async () => {
    const identity = '11000000-0000-4000-8000-000000000001'
    const session = '22000000-0000-4000-8000-000000000001'
    const config = { password: 'synthetic-shipping-ops-password-32-characters', maxAgeSeconds: 3600 }
    w.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
      )
      .run(identity, 'admin-shipping@example.invalid', NOW, NOW, NOW)
    w.sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'admin-role',?)")
      .run(identity, NOW)
    w.sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
      )
      .run(session, identity, NOW)
    const cookie = (await issueD1SessionCookie(
      w.db,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      config
    ))!
    const request = () =>
      new Request('https://neteco.invalid/api/admin/delivery-app/routes/r-1/report', { headers: { cookie } })
    const deps = { database: w.db, sessionCookieConfiguration: config, now: () => NOW }
    expect((await handleDeliveryDriverAppHttp(request(), deps))?.status).toBe(200)
    w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    expect((await handleDeliveryDriverAppHttp(request(), deps))?.status).toBe(403)
    w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=? WHERE id=?').run(NOW, session)
    expect((await handleDeliveryDriverAppHttp(request(), deps))?.status).toBe(401)
  })

  it('rejects a revoked driver cookie before exposing the manifest', async () => {
    const identity = '11000000-0000-4000-8000-000000000002'
    const session = '22000000-0000-4000-8000-000000000002'
    const config = { password: 'synthetic-shipping-ops-password-32-characters', maxAgeSeconds: 3600 }
    w.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
      )
      .run(identity, 'driver-shipping@example.invalid', NOW, NOW, NOW)
    w.sqlite.prepare("UPDATE delivery_drivers SET identity_id=? WHERE id='d-1'").run(identity)
    w.sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,'2099-01-01T00:00:00Z')"
      )
      .run(session, identity, NOW)
    const cookie = (await issueD1SessionCookie(
      w.db,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      config
    ))!
    const request = () => new Request('https://neteco.invalid/api/delivery/manifest', { headers: { cookie } })
    const deps = { database: w.db, sessionCookieConfiguration: config, now: () => NOW }
    expect((await handleDeliveryDriverAppHttp(request(), deps))?.status).toBe(200)
    w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, session)
    expect((await handleDeliveryDriverAppHttp(request(), deps))?.status).toBe(401)
  })

  it('owns the driver and admin app namespaces only', async () => {
    expect(ownsDeliveryDriverAppNamespace('/api/delivery/manifest')).toBe(true)
    expect(ownsDeliveryDriverAppNamespace('/api/admin/delivery-app/routes/r-1/report')).toBe(true)
    expect(ownsDeliveryDriverAppNamespace('/api/admin/delivery-routes/r-1')).toBe(false)
    expect(ownsDeliveryDriverAppNamespace('/api/deliveryx')).toBe(false)
    expect(
      await handleDeliveryDriverAppHttp(new Request('https://x.example/api/orders'), { database: w.db })
    ).toBeNull()
  })

  it('401 anonymous, 403 for non drivers, never cacheable', async () => {
    const anon = await call('GET', '/api/delivery/manifest', undefined, null)
    expect(anon.response.status).toBe(401)
    expect(anon.response.headers.get('cache-control')).toContain('no-store')
    expect((await call('GET', '/api/delivery/manifest', undefined, OTHER)).response.status).toBe(403)
    expect((await call('GET', '/api/delivery/manifest', undefined, ADMIN)).response.status).toBe(403)
    expect(
      (await call('POST', '/api/delivery/events', ev({ kind: 'start_route', routeId: 'r-1' }), OTHER)).response.status
    ).toBe(403)
  })

  it('serves the manifest and drives a route through events', async () => {
    const manifest = await call('GET', '/api/delivery/manifest')
    expect(manifest.response.status).toBe(200)
    expect(manifest.response.headers.get('cache-control')).toContain('no-store')
    expect(manifest.json.routes[0].stops[0].recipientName).toBe('Taller Alfa')
    const started = await call('POST', '/api/delivery/events', ev({ kind: 'start_route', routeId: 'r-1' }))
    expect(started.json.result).toMatchObject({ outcome: 'applied', routeStatus: 'in_progress' })
    const body = ev({
      kind: 'deliver',
      stopId: 's-1',
      pod: { method: 'signature', receivedBy: 'Ana', evidence: { mime: 'image/png', base64: PNG } }
    })
    const delivered = await call('POST', '/api/delivery/events', body)
    expect(delivered.json.result).toMatchObject({ outcome: 'applied', routeStatus: 'completed' })
    const replay = await call('POST', '/api/delivery/events', body)
    expect(replay.response.status).toBe(200)
    expect(replay.json.result.outcome).toBe('replayed')
    const again = await call(
      'POST',
      '/api/delivery/events',
      ev({ kind: 'deliver', stopId: 's-1', pod: { method: 'neighbour', receivedBy: 'Vecino Pepe' } })
    )
    expect(again.response.status).toBe(409)
    expect(again.json.error.code).toBe('invalid_transition')
  })

  it('syncs offline queues with per-event outcomes', async () => {
    const a = ev({ kind: 'start_route', routeId: 'r-1' })
    const b = ev({ kind: 'start', stopId: 'nope' })
    const sync = await call('POST', '/api/delivery/sync', { events: [a, b] })
    expect(sync.response.status).toBe(200)
    expect(sync.json.results).toEqual([
      { commandId: a.commandId, outcome: 'applied' },
      { commandId: b.commandId, outcome: 'rejected', error: { code: 'not_found' } }
    ])
    expect((await call('POST', '/api/delivery/sync', { events: [] })).response.status).toBe(400)
  })

  it('maps malformed input, oversized bodies and methods', async () => {
    expect((await call('POST', '/api/delivery/events', undefined, DRIVER_IDENTITY, '{bad')).response.status).toBe(400)
    expect((await call('POST', '/api/delivery/events', { kind: 'nope' })).response.status).toBe(400)
    expect(
      (await call('POST', '/api/delivery/events', undefined, DRIVER_IDENTITY, 'x'.repeat(700_000))).response.status
    ).toBe(413)
    expect((await call('GET', '/api/delivery/events')).response.status).toBe(405)
    expect((await call('GET', '/api/delivery/manifest?date=nope')).response.status).toBe(400)
    expect((await call('GET', '/api/delivery/unknown')).response.status).toBe(404)
  })

  it('exposes the audit report and evidence to admins only, with safe headers', async () => {
    await call('POST', '/api/delivery/events', ev({ kind: 'start_route', routeId: 'r-1' }))
    await call(
      'POST',
      '/api/delivery/events',
      ev({
        kind: 'deliver',
        stopId: 's-1',
        pod: { method: 'signature', receivedBy: 'Ana', evidence: { mime: 'image/png', base64: PNG } }
      })
    )
    const report = await call('GET', '/api/admin/delivery-app/routes/r-1/report', undefined, ADMIN)
    expect(report.response.status).toBe(200)
    expect(report.json.pods[0]).toMatchObject({ stopId: 's-1', hasEvidence: true })
    expect(
      (await call('GET', '/api/admin/delivery-app/routes/r-1/report', undefined, DRIVER_IDENTITY)).response.status
    ).toBe(403)
    expect((await call('GET', '/api/admin/delivery-app/routes/zzz/report', undefined, ADMIN)).response.status).toBe(404)
    const evidence = await call('GET', '/api/admin/delivery-app/stops/s-1/evidence', undefined, ADMIN)
    expect(evidence.response.status).toBe(200)
    expect(evidence.response.headers.get('content-type')).toBe('image/png')
    expect(evidence.response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(evidence.response.headers.get('content-security-policy')).toContain('sandbox')
    expect(evidence.buffer.toString('base64')).toBe(PNG)
    expect(
      (await call('GET', '/api/admin/delivery-app/stops/s-1/evidence', undefined, DRIVER_IDENTITY)).response.status
    ).toBe(403)
    expect((await call('GET', '/api/admin/delivery-app/stops/s-9/evidence', undefined, ADMIN)).response.status).toBe(
      404
    )
  })
})
