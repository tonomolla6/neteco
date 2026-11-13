import { describe, expect, it } from 'vitest'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { splitGross } from '../../server/domain/money'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'
import { handleStorefrontShippingHttp } from '../../workers/catalog/storefront-shipping'
import { resolveShippingOptions } from '../../workers/catalog/shipping'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testUuid } from '../support/deterministic'

const NOW = '2026-08-25T09:00:00Z'
const ORIGIN = 'https://shop.neteco.test'
const REQUEST_KEY = '550e8400-e29b-41d4-a716-446655440000'

async function world(freeShippingThresholdCents?: number | null) {
  const sqlite = await openMigratedDatabase()
  sqlite.limits.exprDepth = 100
  seedInventoryFixture(sqlite)
  applyGeneratedSeed(sqlite, renderD1ShippingSeed())
  const database = d1OverSqlite(sqlite)
  await provisionPublicationValidityFixture(database, {
    productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
    now: '2026-01-01T00:00:00Z'
  })
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const dispatch = async (command: Record<string, unknown>) => {
    const result = await handleCartCommand(command, {
      database,
      freeShippingThresholdCents,
      getResponse: async (id) => responses.get(`${command.cartId}:${id}`),
      putResponse: async (id, value) => {
        responses.set(`${command.cartId}:${id}`, value)
      },
      setAlarm: async () => {}
    })
    return Response.json(result.body, { status: result.status })
  }
  const edgeLimiter = { limit: async () => ({ success: true }) } as unknown as RateLimit
  const deps = {
    database,
    dispatch,
    edgeLimiter,
    rateLimitPepper: 'test-shipping-edge-pepper-0123456789abcdef',
    now: () => NOW
  }
  const request = (path: string, body: Record<string, unknown>, cookie?: string, origin = ORIGIN) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '192.0.2.21',
        'content-type': 'application/json',
        'idempotency-key': REQUEST_KEY,
        origin,
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify(body)
    })
  const cartResponse = await handleStorefrontCartHttp(
    new Request(`${ORIGIN}/api/cart`, { headers: { 'cf-connecting-ip': '192.0.2.21' } }),
    deps
  )
  if (!cartResponse || cartResponse.status !== 200) throw new Error('cart creation failed')
  const cookie = cartResponse.headers.get('set-cookie')!.split(';')[0]!
  const added = await handleStorefrontCartHttp(
    request(
      '/api/cart/items',
      { variantId: 11, quantity: 2, expectedVersion: 1, idempotencyKey: 'shipping-add' },
      cookie
    ),
    deps
  )
  if (!added || added.status !== 200) throw new Error('cart add failed')
  const address = {
    name: 'Ada Compradora',
    line1: 'Carrer Major 1',
    postalCode: '46870',
    city: 'Ontinyent',
    region: 'Valencia',
    phone: '+34 600 000 000'
  }
  return { sqlite, database, dispatch, deps, request, cookie, address }
}

describe('Cloudflare storefront shipping bridge', () => {
  it('does not fabricate a natural-day ETA when no operational calendar is configured', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    try {
      const response = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), deps)
      expect(response?.status).toBe(200)
      const body = (await response!.json()) as {
        rates: Array<{ estimatedDeliveryFrom: unknown; estimatedDeliveryTo: unknown; etaStatus: unknown }>
      }
      expect(body.rates.length).toBeGreaterThan(0)
      expect(
        body.rates.every(
          (rate) =>
            rate.estimatedDeliveryFrom === null && rate.estimatedDeliveryTo === null && rate.etaStatus === 'unknown'
        )
      ).toBe(true)
    } finally {
      sqlite.close()
    }
  })
  it('reports withdrawn governing evidence as variant_not_available without quote, command or stock effects', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    const counts = () =>
      sqlite
        .prepare(
          `SELECT (SELECT count(*) FROM cart_commands) AS commands,
        (SELECT count(*) FROM checkout_quotes) AS quotes,
        (SELECT count(*) FROM shipping_quotes) AS shipping,
        (SELECT count(*) FROM inventory_reservations) AS reservations,
        (SELECT count(*) FROM inventory_movements) AS movements`
        )
        .get()
    const before = counts()
    const cartBefore = sqlite.prepare('SELECT version FROM carts').get()
    // Explicit synthetic fixture withdrawal; production history is immutable.
    const eventId = testUuid()
    sqlite
      .prepare(
        `INSERT INTO product_media_publication_events
        (id,publication_id,event_type,reason,actor_id,created_at,idempotency_key,payload_hash)
        SELECT ?,id,'withdrawn','Synthetic local evidence withdrawal',actor_id,?,?,?
        FROM product_media_publications WHERE product_id='p-1' AND role='main' AND variant_id IS NULL`
      )
      .run(eventId, NOW, eventId, 'a'.repeat(64))
    const response = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), deps)
    expect(response?.status).toBe(422)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(await response?.json()).toEqual({ error: { code: 'variant_not_available' } })
    expect(counts()).toEqual(before)
    expect(sqlite.prepare('SELECT version FROM carts').get()).toEqual(cartBefore)
  })

  it.each(['internal', 'private SQL or provider diagnostic'])(
    'sanitizes an upstream outage (%s) as internal, never a domain conflict',
    async (code) => {
      const { sqlite, deps, request, cookie, address } = await world()
      const response = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), {
        ...deps,
        dispatch: async () => Response.json({ error: { code } }, { status: 500 })
      })
      expect(response?.status).toBe(500)
      expect(await response?.json()).toEqual({ error: { code: 'internal' } })
      expect((sqlite.prepare('SELECT count(*) AS n FROM checkout_quotes').get() as { n: number }).n).toBe(0)
    }
  )

  it('returns server-priced rate proofs without exposing the HttpOnly cart token or personal address', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    const response = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), deps)
    expect(response?.status).toBe(200)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    const body = (await response!.json()) as {
      cartVersion: number
      rates: Array<{
        serviceCode: string
        quoteId: string
        shippingQuoteId: string
        optionIndex: number
        optionHash: string
        subtotalNetCents: number
        taxCents: number
        totalGrossCents: number
        netCents: number
      }>
    }
    expect(body.cartVersion).toBe(2)
    expect(body.rates.length).toBeGreaterThan(0)
    const pickup = body.rates.find((rate) => rate.serviceCode === 'pickup')!
    expect(body.rates.find((rate) => rate.serviceCode === 'own_delivery')?.netCents).toBe(0)
    expect(pickup.optionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(pickup.quoteId).toBeTruthy()
    expect(pickup.shippingQuoteId).toBeTruthy()
    expect(pickup.optionIndex).toBeGreaterThanOrEqual(0)
    const gross = (
      sqlite.prepare('SELECT total_gross_cents AS gross FROM checkout_quotes WHERE id = ?').get(pickup.quoteId) as {
        gross: number
      }
    ).gross
    expect(pickup.totalGrossCents).toBe(gross)
    expect(pickup.subtotalNetCents).toBe(splitGross(gross, 2100).netCents)
    expect(pickup.taxCents).toBe(gross - pickup.subtotalNetCents)
    const cookieToken = cookie.split('.').at(-1)!
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(cookieToken)
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM shipping_quotes').all())).not.toContain(address.name)
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM shipping_quotes').all())).not.toContain(address.line1)
    const replay = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), deps)
    expect(await replay?.json()).toEqual(body)
    const changedCart = await handleStorefrontCartHttp(
      request(
        '/api/cart/items',
        { variantId: 11, quantity: 3, expectedVersion: 2, idempotencyKey: 'shipping-mutate' },
        cookie
      ),
      deps
    )
    expect(changedCart?.status).toBe(200)
    const replayAfterMutation = await handleStorefrontShippingHttp(
      request('/api/shipping/rates', address, cookie),
      deps
    )
    expect(await replayAfterMutation?.json()).toEqual(body)
    const replayAfterExpiry = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), {
      ...deps,
      now: () => '2026-09-01T09:00:00Z'
    })
    expect(await replayAfterExpiry?.json()).toEqual(body)
    expect((sqlite.prepare('SELECT count(*) AS n FROM checkout_quotes').get() as { n: number }).n).toBe(1)
    expect((sqlite.prepare('SELECT count(*) AS n FROM shipping_quotes').get() as { n: number }).n).toBe(1)
    const changedDestination = await handleStorefrontShippingHttp(
      request('/api/shipping/rates', { ...address, postalCode: '46001' }, cookie),
      deps
    )
    expect(changedDestination?.status).toBe(409)
    expect((sqlite.prepare('SELECT count(*) AS n FROM shipping_quotes').get() as { n: number }).n).toBe(1)
  })

  it('uses only the newest active version of each shipping rate', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    sqlite
      .prepare(
        `INSERT INTO shipping_rates (
          id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points,
          eta_min_days, eta_max_days, rate_version, active, created_at
        ) SELECT ?, zone_id, method_code, service_profile, 101, tax_rate_basis_points,
                 eta_min_days, eta_max_days, 2, 1, ?
          FROM shipping_rates WHERE method_code = 'own_delivery' AND service_profile = 'parcel' AND rate_version = 1`
      )
      .run(testUuid(), NOW)
    const response = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), deps)
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as { rates: Array<{ serviceCode: string; netCents: number }> }
    expect(body.rates.filter((rate) => rate.serviceCode === 'own_delivery')).toEqual([
      expect.objectContaining({ netCents: 101 })
    ])
  })

  it('applies the trusted parcel-free threshold to the same gross tier price as the cart quote', async () => {
    const free = await world(1)
    const freeResponse = await handleStorefrontShippingHttp(
      free.request('/api/shipping/rates', free.address, free.cookie),
      free.deps
    )
    expect(freeResponse?.status).toBe(200)
    const freeBody = (await freeResponse!.json()) as {
      rates: Array<{ serviceCode: string; netCents: number; taxCents: number }>
    }
    expect(freeBody.rates.find((rate) => rate.serviceCode === 'parcel')?.netCents).toBe(0)
    const snapshot = free.sqlite.prepare('SELECT options_json AS options FROM shipping_quotes').get() as {
      options: string
    }
    expect(
      (JSON.parse(snapshot.options) as Array<{ methodCode: string; taxCents: number }>).find(
        (option) => option.methodCode === 'parcel'
      )?.taxCents
    ).toBe(0)

    const paid = await world(1_000_000)
    const paidResponse = await handleStorefrontShippingHttp(
      paid.request('/api/shipping/rates', paid.address, paid.cookie),
      paid.deps
    )
    expect(paidResponse?.status).toBe(200)
    const paidBody = (await paidResponse!.json()) as { rates: Array<{ serviceCode: string; netCents: number }> }
    expect(paidBody.rates.find((rate) => rate.serviceCode === 'parcel')?.netCents).toBe(495)
  })

  it('rejects cross-origin writes, unauthenticated calls and client-supplied monetary fields', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    const before = (sqlite.prepare('SELECT count(*) AS n FROM shipping_quotes').get() as { n: number }).n
    const crossOrigin = await handleStorefrontShippingHttp(
      request('/api/shipping/rates', address, cookie, 'https://evil.test'),
      deps
    )
    expect(crossOrigin?.status).toBe(403)
    expect((await handleStorefrontShippingHttp(request('/api/shipping/rates', address), deps))?.status).toBe(401)
    expect(
      (
        await handleStorefrontShippingHttp(
          request('/api/shipping/rates', { ...address, totalGrossCents: 1 }, cookie),
          deps
        )
      )?.status
    ).toBe(400)
    expect((sqlite.prepare('SELECT count(*) AS n FROM shipping_quotes').get() as { n: number }).n).toBe(before)
  })

  it('fails closed when the edge limiter denies or cannot identify the client', async () => {
    const { sqlite, deps, request, cookie, address } = await world()
    const denied = await handleStorefrontShippingHttp(request('/api/shipping/rates', address, cookie), {
      ...deps,
      edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
    })
    expect(denied?.status).toBe(429)
    const missingIp = new Request(`${ORIGIN}/api/shipping/rates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': REQUEST_KEY, origin: ORIGIN, cookie },
      body: JSON.stringify(address)
    })
    expect((await handleStorefrontShippingHttp(missingIp, deps))?.status).toBe(503)
    expect((sqlite.prepare('SELECT count(*) AS n FROM shipping_quotes').get() as { n: number }).n).toBe(0)
  })
})

describe('shipping across the shipment-plan schema transition', () => {
  it.each([null, 3])(
    'keeps a legacy checkout usable without inventing a new shipment plan (supplier lead %s)',
    async (lead) => {
      const { sqlite, database } = await world()
      try {
        sqlite.exec('DROP TABLE order_shipment_plans; DROP TABLE fulfillment_lead_time_policy')
        sqlite.prepare('UPDATE variants SET lead_time_days=?, backorder_allowed=1').run(lead)
        if (lead !== null) sqlite.exec('UPDATE inventory_balances SET physical_quantity=0')
        const cart = sqlite.prepare('SELECT id FROM carts').get() as { id: string }
        const result = await resolveShippingOptions(database, {
          cartId: cart.id,
          now: NOW,
          destination: { postalCode: '46870', city: 'Ontinyent' }
        })
        expect(result.options.length).toBeGreaterThan(0)
        for (const option of result.options) {
          expect(option.shipments).toBeUndefined()
          expect(option.shipmentMode).toBeUndefined()
          expect(option.eta).toMatchObject({ status: 'unknown', from: null, to: null })
        }
      } finally {
        sqlite.close()
      }
    }
  )

  it('fails closed for a partially installed shipment schema before offering an unusable plan', async () => {
    const { sqlite, database } = await world()
    try {
      sqlite.exec('DROP TABLE order_shipment_plans')
      const cart = sqlite.prepare('SELECT id FROM carts').get() as { id: string }
      await expect(
        resolveShippingOptions(database, {
          cartId: cart.id,
          now: NOW,
          destination: { postalCode: '46870', city: 'Ontinyent' }
        })
      ).rejects.toThrow('incomplete_fulfillment_schema')
      expect(sqlite.prepare('SELECT count(*) n FROM shipping_quotes').get()).toEqual({ n: 0 })
    } finally {
      sqlite.close()
    }
  })

  it('uses the configured default for missing supplier lead time with the complete current schema', async () => {
    const { sqlite, database } = await world()
    try {
      sqlite.exec(
        'UPDATE inventory_balances SET physical_quantity=0; UPDATE variants SET lead_time_days=NULL, backorder_allowed=1; UPDATE fulfillment_lead_time_policy SET restock_default_days=11'
      )
      const cart = sqlite.prepare('SELECT id FROM carts').get() as { id: string }
      const result = await resolveShippingOptions(database, {
        cartId: cart.id,
        now: NOW,
        destination: { postalCode: '46870', city: 'Ontinyent' }
      })
      expect(result.options.length).toBeGreaterThan(0)
      for (const option of result.options) {
        expect(option.shipmentMode).toBe('together')
        expect(option.shipments).toHaveLength(1)
        expect(option.shipments![0]!.leadDays).toBe(11)
      }
    } finally {
      sqlite.close()
    }
  })
})
