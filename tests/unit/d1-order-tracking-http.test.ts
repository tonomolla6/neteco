import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAdminFulfillmentHttp } from '../../workers/fulfillment/admin-http'
import { handleOrderTrackingHttp } from '../../workers/fulfillment/tracking-http'
import { trackingFixture, BUYER, CLAIMS, configuration } from './d1-order-tracking-http-fixture'
import { orderTrackingSchema } from '../../shared/order-tracking'

const origin = 'https://tracking.neteco.test',
  id = '10000000-0000-4000-8000-000000000069'
const touched = vi.fn(() => {
  throw new Error('must_not_touch_D1')
})
const database = { prepare: touched, batch: touched } as unknown as D1Database
beforeEach(() => {
  touched.mockClear()
})
// Initial RED observes actual legacy routing (404), not an absent import or a
// service stub. The tracking handler will be wired before this legacy fallback.
async function dispatch(path: string, method = 'GET', requestOrigin = origin) {
  const request = new Request(origin + path, { method, headers: { Origin: requestOrigin } })
  return (
    (await handleOrderTrackingHttp(request, {
      database,
      origin,
      sessionCookieConfiguration: { password: 'synthetic-tracking-password-more-than-32', maxAgeSeconds: 3600 },
      edgeLimiter: { limit: async () => ({ success: true }) },
      rateLimitPepper: 'synthetic-tracking-rate-pepper-more-than-32'
    })) ??
    (await handleAdminFulfillmentHttp(request, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: 'synthetic-tracking-password-more-than-32'
    })) ??
    new Response(null, { status: 404 })
  )
}
function privateFailure(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('x-robots-tag')).toContain('noindex')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(touched).not.toHaveBeenCalled()
}
describe.each(['', 'admin/'])('tracking %s namespace before private reads', (audience) => {
  const base = `/api/${audience}orders/${id}/tracking`
  it('requires real session or sealed guest authority, never a plaintext bearer', async () => {
    privateFailure(await dispatch(base), 401)
  })
  it('rejects writes before authentication or D1', async () => {
    const response = await dispatch(base, 'POST')
    privateFailure(response, 405)
    expect(response.headers.get('allow')).toBe('GET')
  })
  it('rejects query credentials and all query parameters before reads', async () => {
    privateFailure(await dispatch(base + '?token=' + 'a'.repeat(64)), 400)
  })
  it('owns encoded aliases without executing them', async () => {
    privateFailure(await dispatch(base.replace('/tracking', '/%74racking')), 400)
  })
  it('rejects cross-origin GET before any authority read', async () => {
    privateFailure(await dispatch(base, 'GET', 'https://external.invalid'), 403)
  })
  it('rejects an alternate request origin even when Origin is absent', async () => {
    const response = await handleOrderTrackingHttp(new Request('https://alternate.invalid' + base), {
      database,
      origin,
      sessionCookieConfiguration: configuration,
      edgeLimiter: { limit: async () => ({ success: true }) },
      rateLimitPepper: 'synthetic-tracking-rate-pepper-more-than-32'
    })
    privateFailure(response!, 403)
  })
})

describe('tracking HTTP with actual checkout, paid assignment and manual packing commands', () => {
  let fixture: Awaited<ReturnType<typeof trackingFixture>>
  beforeEach(async () => {
    fixture = await trackingFixture()
  })
  afterEach(() => {
    fixture?.sqlite.close()
  })
  async function read(orderId: string, cookie: string, admin = false, now?: string) {
    return (await handleOrderTrackingHttp(
      new Request(`${origin}/api/${admin ? 'admin/' : ''}orders/${orderId}/tracking`, { headers: { Cookie: cookie } }),
      {
        database: fixture.database,
        origin,
        sessionCookieConfiguration: configuration,
        edgeLimiter: { limit: async () => ({ success: true }) },
        rateLimitPepper: 'synthetic-tracking-rate-pepper-more-than-32',
        ...(now ? { now: () => now } : {})
      }
    ))!
  }
  it('serves matching customer/admin/guest projections without any GET writes or private annotation leaks', async () => {
    const before = fixture.economic(),
      changes = fixture.sqlite.prepare('SELECT total_changes() n').get()
    for (const [orderId, cookie, audience] of [
      [fixture.ownedOrderId, fixture.buyerCookie, 'customer'],
      [fixture.ownedOrderId, fixture.adminCookie, 'admin'],
      [fixture.guestOrderId, fixture.guestCookie, 'guest']
    ] as const) {
      const response = await read(orderId, cookie, audience === 'admin')
      expect(response.status).toBe(200)
      const dto = orderTrackingSchema.parse(await response.json())
      expect(dto).toMatchObject({
        orderId,
        audience,
        shippingMethod: 'parcel',
        fulfillment: { state: 'packed', version: 2 },
        packing: { parcelCount: 2 },
        carrierEvents: [],
        carrierStatus: 'not_connected',
        fallback: { kind: 'contact_neteco', contactPath: '/contacto' }
      })
      expect(dto.shipments).toHaveLength(2)
      expect(dto.shipments.every((item) => item.verification === 'manual_unverified')).toBe(true)
      expect(JSON.stringify(dto)).not.toMatch(
        /shipmentNumber|externalLabelReference|actualNetCents|@example|Synthetic buyer|reason|token|DOCUMENT-/
      )
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(changes)
    expect(fixture.economic()).toEqual(before)
  })
  it('uses uniform404 for wrong owner/order and never falls back from an authenticated stranger to a guest grant', async () => {
    for (const [orderId, cookie] of [
      [fixture.ownedOrderId, fixture.foreignCookie],
      [crypto.randomUUID(), fixture.buyerCookie],
      [fixture.ownedOrderId, fixture.guestCookie],
      [fixture.guestOrderId, fixture.foreignCookie + '; ' + fixture.guestCookie]
    ]) {
      const response = await read(orderId!, cookie!)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'not_found' } })
    }
  })
  it.each(['email_unverified', 'mfa_required', 'forbidden', 'unauthenticated'])(
    'rechecks administrator %s before revealing operational references',
    async (code) => {
      if (code === 'email_unverified')
        fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CLAIMS.identityId)
      if (code === 'mfa_required')
        fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
      if (code === 'forbidden')
        fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
      if (code === 'unauthenticated')
        fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CLAIMS.sessionId)
      const response = await read(fixture.ownedOrderId, fixture.adminCookie, true)
      expect(response.status).toBe(code === 'unauthenticated' ? 401 : 403)
      expect(await response.json()).toEqual({ error: { code } })
    }
  )
  it('enforces current customer email and sessionVersion without requiring customer MFA', async () => {
    fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER.identityId)
    // Existing customer timeline/fiscal authority treats an unverified owner
    // as unauthenticated (admin email failures remain explicit403).
    expect((await read(fixture.ownedOrderId, fixture.buyerCookie)).status).toBe(401)
    fixture.sqlite
      .prepare('UPDATE identities SET email_verified_at=created_at,session_version=2 WHERE id=?')
      .run(BUYER.identityId)
    expect((await read(fixture.ownedOrderId, fixture.buyerCookie)).status).toBe(401)
  })
  it('expires or revokes only the original sealed guest scope rather than turning it into a login', async () => {
    expect((await read(fixture.guestOrderId, fixture.guestCookie, false, '2099-01-01T00:00:00Z')).status).toBe(404)
    fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=created_at WHERE id=?').run(fixture.guestOrderId)
    expect((await read(fixture.guestOrderId, fixture.guestCookie)).status).toBe(404)
    expect((await read(fixture.guestOrderId, fixture.guestCookie, true)).status).toBe(401)
  })
  it('fails503 for explicitly corrupted packing after genuine commands, never an empty carrier history success', async () => {
    fixture.sqlite.exec('DROP TRIGGER order_packing_projection_update')
    fixture.sqlite
      .prepare('UPDATE order_packings SET parcels=\'[{"synthetic":"corrupt"}]\' WHERE order_id=?')
      .run(fixture.ownedOrderId)
    const response = await read(fixture.ownedOrderId, fixture.adminCookie, true)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'history_unconfirmed' } })
  })
})
