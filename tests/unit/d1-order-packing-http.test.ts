import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAdminFulfillmentHttp, type AdminFulfillmentHttpEnvironment } from '../../workers/fulfillment/admin-http'
import { handleAdminPackingHttp } from '../../workers/fulfillment/packing-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { packingFixture, CLAIMS, REASON } from './d1-order-packing-fixture'
import { adminOrderPackingSchema, orderPackingReceiptSchema, orderPackingIntentHash } from '../../shared/order-packing'

const origin = 'https://packing.neteco.test'
const orderId = '10000000-0000-4000-8000-000000000069'
const key = '20000000-0000-4000-8000-000000000069'
const prefix = `/api/admin/orders/${orderId}/packing`

describe('packing private HTTP namespace and boundaries', () => {
  const touched = vi.fn(() => {
    throw new Error('must_not_reach_D1')
  })
  const database = { prepare: touched, batch: touched } as unknown as D1Database
  beforeEach(() => {
    touched.mockClear()
  })
  const environment = (enabled = true): AdminFulfillmentHttpEnvironment => ({
    DB: database,
    AUTH_ENABLED: enabled ? 'true' : 'false',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: 'synthetic-packing-cookie-password-more-than-32'
  })
  // Initial RED used the existing fulfillment HTTP and observed404. The new
  // packing handler must own its routes before the unchanged legacy handler.
  async function dispatch(path: string, method = 'GET', enabled = true, requestOrigin?: string) {
    const request = new Request(origin + path, {
      method,
      headers: { ...(requestOrigin ? { origin: requestOrigin } : {}), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {})
    })
    return (
      (await handleAdminPackingHttp(request, environment(enabled))) ??
      (await handleAdminFulfillmentHttp(request, environment(enabled))) ??
      new Response(null, { status: 404 })
    )
  }
  function privateFailure(response: Response, status: number) {
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Cookie')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(touched).not.toHaveBeenCalled()
  }
  it.each([
    [prefix, 'GET'],
    [`${prefix}/commands`, 'POST'],
    [`${prefix}/commands/${key}`, 'GET']
  ])('requires an authenticated administrator before D1 for %s %s', async (path, method) => {
    privateFailure(await dispatch(path, method, true, method === 'POST' ? origin : undefined), 401)
  })
  it.each([
    [prefix, 'POST', 'GET'],
    [`${prefix}/commands`, 'GET', 'POST'],
    [`${prefix}/commands/${key}`, 'POST', 'GET']
  ])('rejects unsupported method at %s %s before authentication', async (path, method, allow) => {
    const response = await dispatch(path, method, true, origin)
    privateFailure(response, 405)
    expect(response.headers.get('allow')).toBe(allow)
  })
  it('fails closed when auth is disabled and never uses a legacy backend', async () => {
    privateFailure(await dispatch(prefix, 'GET', false), 503)
  })
  it('requires exact Origin on commands before cookie, body or D1', async () => {
    privateFailure(await dispatch(`${prefix}/commands`, 'POST', true, 'https://attacker.invalid'), 403)
  })
  it('preserves unrelated fulfillment namespace and its live authentication boundary', async () => {
    privateFailure(await dispatch(`/api/admin/orders/${orderId}/fulfillment`), 401)
    expect((await dispatch('/api/admin/orders/unrelated')).status).toBe(404)
  })
})

describe('packing HTTP over real command fixtures', () => {
  let fixture: Awaited<ReturnType<typeof packingFixture>>, cookie: string
  const password = 'synthetic-packing-cookie-password-more-than-32'
  beforeEach(async () => {
    fixture = await packingFixture({ stage: 'packed' })
    cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => fixture.sqlite.close())
  const base = () => `/api/admin/orders/${fixture.orderId}/packing`
  function pack() {
    return {
      action: 'pack' as const,
      expectedVersion: 0,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      parcels: [0, 1].map(() => ({
        weightGrams: 1000,
        widthMm: 200,
        heightMm: 100,
        depthMm: 100,
        contents: [{ lineIndex: 0, quantity: 2 }]
      }))
    }
  }
  function manual() {
    return {
      action: 'manual_dispatch' as const,
      expectedVersion: 1,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      shipments: [0, 1].map((parcelIndex) => ({
        parcelIndex,
        carrier: 'Operador sintético manual',
        shipmentNumber: `SYNTHETIC-${parcelIndex}`,
        trackingNumber: `TRACK-${parcelIndex}`,
        externalLabelReference: `DOCUMENT-REF-${parcelIndex}`
      })),
      actualNetCents: 700,
      taxBps: 2100
    }
  }
  async function dispatch(
    path = base(),
    method = 'GET',
    body?: unknown,
    key = crypto.randomUUID(),
    headers: Record<string, string> = {}
  ) {
    return (await handleAdminPackingHttp(
      new Request(origin + path, {
        method,
        headers: { cookie, origin, 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      { DB: fixture.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    ))!
  }
  it('reads without Origin, packs two exact parcels and records manual contingency without fulfillment or economic writes', async () => {
    const initial = await handleAdminPackingHttp(new Request(origin + base(), { headers: { cookie } }), {
      DB: fixture.database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
    expect(initial?.status).toBe(200)
    expect(adminOrderPackingSchema.parse(await initial!.json())).toMatchObject({
      version: 0,
      state: 'unpacked',
      fulfillmentVersion: 2,
      fulfillmentState: 'packed',
      shippingMethod: 'parcel'
    })
    const before = fixture.economic()
    const packed = await dispatch(base() + '/commands', 'POST', pack())
    expect(packed.status).toBe(201)
    expect(orderPackingReceiptSchema.parse(await packed.json())).toMatchObject({
      version: 1,
      fulfillmentVersion: 2,
      parcelCount: 2,
      inventoryEffect: 'none',
      economicEffect: 'none',
      providerEffect: 'none'
    })
    const dispatched = await dispatch(base() + '/commands', 'POST', manual())
    expect(dispatched.status).toBe(201)
    const current = await dispatch()
    expect(current.status).toBe(200)
    expect(adminOrderPackingSchema.parse(await current.json())).toMatchObject({
      state: 'manual_dispatch_recorded',
      version: 2,
      fulfillmentState: 'packed',
      dispatch: {
        actualNetCents: 700,
        actualTaxCents: 147,
        actualGrossCents: 847,
        labelVerification: 'unverified_reference_only'
      }
    })
    expect(fixture.economic()).toEqual(before)
  })
  it('replays only the original key/body, recovers an exact receipt and leaves unknown ambiguous with read-only GET', async () => {
    const key = crypto.randomUUID(),
      body = pack(),
      hash = await orderPackingIntentHash(fixture.orderId, body)
    const first = await dispatch(base() + '/commands', 'POST', body, key)
    expect(first.status).toBe(201)
    const receipt = await first.json()
    const replay = await dispatch(base() + '/commands', 'POST', body, key)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(receipt)
    const rows = fixture.sqlite.prepare('SELECT total_changes() AS n').get()
    const recovered = await dispatch(`${base()}/commands/${key}`, 'GET', undefined, key, {
      'X-Neteco-Command-Payload-Hash': hash
    })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    const unknown = await dispatch(`${base()}/commands/${crypto.randomUUID()}`, 'GET', undefined, key, {
      'X-Neteco-Command-Payload-Hash': hash
    })
    expect(unknown.status).toBe(200)
    expect(await unknown.json()).toEqual({ source: 'cloudflare', outcome: 'unknown' })
    expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(rows)
    expect(
      (await dispatch(base() + '/commands', 'POST', { ...body, reason: 'Distinto motivo sintético' }, key)).status
    ).toBe(409)
    expect(
      (
        await dispatch(`${base()}/commands/${key}`, 'GET', undefined, key, {
          'X-Neteco-Command-Payload-Hash': 'f'.repeat(64)
        })
      ).status
    ).toBe(409)
  })
  it.each(['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'])(
    'rechecks current %s before reads, replay and private receipt lookup',
    async (code) => {
      const key = crypto.randomUUID(),
        input = pack(),
        hash = await orderPackingIntentHash(fixture.orderId, input)
      expect((await dispatch(base() + '/commands', 'POST', input, key)).status).toBe(201)
      if (code === 'unauthenticated')
        fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CLAIMS.sessionId)
      if (code === 'email_unverified')
        fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CLAIMS.identityId)
      if (code === 'mfa_required')
        fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
      if (code === 'forbidden')
        fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
      const before = fixture.economic()
      for (const response of [
        await dispatch(),
        await dispatch(base() + '/commands', 'POST', input, key),
        await dispatch(`${base()}/commands/${key}`, 'GET', undefined, key, { 'X-Neteco-Command-Payload-Hash': hash })
      ]) {
        expect(response.status).toBe(code === 'unauthenticated' ? 401 : 403)
        expect(await response.json()).toEqual({ error: { code } })
      }
      expect(fixture.economic()).toEqual(before)
    }
  )
  it.each(['%70acking', 'packing%2Fcommands', 'packing%5Ccommands', 'packing/unknown'])(
    'owns malformed alias %s and never falls back',
    async (tail) => {
      const response = await dispatch(`/api/admin/orders/${fixture.orderId}/${tail}`)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
  )
  it('rejects queries, missing receipt hash and unbounded metadata rather than accepting an empty success', async () => {
    expect((await dispatch(base() + '?now=2099')).status).toBe(400)
    expect((await dispatch(`${base()}/commands/${crypto.randomUUID()}`)).status).toBe(422)
    expect(
      (await dispatch(base() + '/commands', 'POST', { ...pack(), customerEmail: 'synthetic-private@example.invalid' }))
        .status
    ).toBe(422)
    expect((await dispatch(base() + '/commands', 'POST', pack(), 'not-a-uuid')).status).toBe(400)
    expect(
      (await dispatch(base() + '/commands', 'POST', pack(), crypto.randomUUID(), { 'Content-Length': '65537' })).status
    ).toBe(413)
  })
  it('bounds the actual request stream without trusting Content-Length and rejects malformed UTF8', async () => {
    const env = { DB: fixture.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    for (const [bytes, status] of [
      [new Uint8Array(65537), 413],
      [new Uint8Array([0xff]), 400]
    ] as const) {
      const response = await handleAdminPackingHttp(
        new Request(origin + base() + '/commands', {
          method: 'POST',
          headers: { cookie, origin, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: bytes
        }),
        env
      )
      expect(response?.status).toBe(status)
    }
  })
})
