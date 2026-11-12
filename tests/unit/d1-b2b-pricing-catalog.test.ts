import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../../workers/catalog/b2b-pricing'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { listPublishedProducts } from '../../workers/catalog/products'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import { returnsFixture, CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { testUuid } from '../support/deterministic'

async function world() {
  const f = await returnsFixture()
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    const now = utc(),
      before = utc(-60000)
    f.sqlite.exec(`
      INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company','${CUSTOMER}','Empresa','approved','${before}','${before}');
    `)
    await upsertD1B2BPriceList(
      f.database,
      CLAIMS,
      {
        priceListId: 'list',
        expectedVersion: 0,
        code: 'LIST',
        name: 'Tarifa',
        status: 'active',
        validFrom: before,
        validUntil: null,
        variantRules: [{ variantId: 'v-1-1', unitGrossCents: 333 }],
        categoryRules: [],
        reason: 'Acuerdo comercial'
      },
      { idempotencyKey: testUuid(), now: () => now }
    )
    await assignD1CompanyB2BPriceList(
      f.database,
      CLAIMS,
      'company',
      { priceListId: 'list', expectedVersion: 0, validFrom: before, validUntil: null, reason: 'Acuerdo comercial' },
      { idempotencyKey: testUuid(), now: () => now }
    )
    return { ...f, now }
  } catch (error) {
    f.sqlite.close()
    throw error
  }
}
const query = { page: 1, limit: 24, sort: 'default' as const }
describe('contractual catalog prices', () => {
  it('uses the assigned price for the list and detail while guests receive the public price', async () => {
    const f = await world()
    try {
      const guest = await listPublishedProducts(f.database, query, { instant: f.now })
      const buyer = await listPublishedProducts(f.database, query, { instant: f.now, customerId: CUSTOMER })
      expect(guest?.items.find((p) => p.slug === 'producto-1')?.minPrice).toBe(500)
      expect(buyer?.items.find((p) => p.slug === 'producto-1')?.minPrice).toBe(333)
      const detail = await getPublishedProductDetail(f.database, 'producto-1', { instant: f.now, customerId: CUSTOMER })
      expect(detail?.variants[0]).toMatchObject({
        price: 333,
        pricingVersion: 'b2b:list:v1:a1:variant:v-1-1',
        netPrice: 275
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not show contractual prices to another customer or a suspended company', async () => {
    const f = await world()
    try {
      expect(
        (await listPublishedProducts(f.database, query, { instant: f.now, customerId: 'other' }))?.items.find(
          (p) => p.slug === 'producto-1'
        )?.minPrice
      ).toBe(500)
      f.sqlite.exec("UPDATE companies SET status='suspended' WHERE id='company'")
      expect(
        (await listPublishedProducts(f.database, query, { instant: f.now, customerId: CUSTOMER }))?.items.find(
          (p) => p.slug === 'producto-1'
        )?.minPrice
      ).toBe(500)
    } finally {
      f.sqlite.close()
    }
  })
})

it('projects cart prices only for the verified session, and rejects a revoked session', async () => {
  const f = await world()
  try {
    const { createCart, setCartLine } = await import('../../workers/catalog/cart')
    const { handleStorefrontCartHttp, setCartCookie } = await import('../../workers/catalog/storefront-cart')
    const { BUYER_CLAIMS } = await import('./d1-returns-fixture')
    const cart = await createCart(f.database, { correlationId: 'b2b-cart', now: f.now })
    await setCartLine(f.database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1,
      correlationId: 'b2b-cart',
      now: f.now
    })
    const cartCookie = setCartCookie(cart, f.now).split(';')[0]!
    const deps = {
      database: f.database,
      dispatch: async () => new Response(null, { status: 500 }),
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-pepper-0123456789abcdef',
      now: () => f.now,
      authenticationEnabled: true,
      session: async () => BUYER_CLAIMS
    }
    const read = (cookie: string) =>
      handleStorefrontCartHttp(
        new Request('https://shop.invalid/api/cart?customerId=other', { headers: { cookie } }),
        deps
      )
    const guest = await read(cartCookie)
    expect(((await guest!.json()) as { items: Array<{ price: number }> }).items[0]?.price).toBe(500)
    const buyer = await read(`${cartCookie}; neteco-session=verified`)
    expect(((await buyer!.json()) as { items: Array<{ price: number }> }).items[0]?.price).toBe(333)
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(f.now, BUYER_CLAIMS.sessionId)
    expect((await read(`${cartCookie}; neteco-session=verified`))?.status).toBe(401)
  } finally {
    f.sqlite.close()
  }
})

it('derives catalog pricing from the sealed session and never from query parameters', async () => {
  const f = await world()
  try {
    const { default: worker } = await import('../../workers/canary')
    const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
    const { BUYER_CLAIMS } = await import('./d1-returns-fixture')
    const password = 'synthetic-session-password-0123456789abcdef'
    const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
    const env = { DB: f.database, AUTH_ENABLED: 'true', NUXT_SESSION_PASSWORD: password } as unknown as CloudflareEnv
    const request = (cookie?: string) =>
      new Request(`https://shop.invalid/api/products?customerId=${CUSTOMER}`, { headers: cookie ? { cookie } : {} })
    const publicResponse = await worker.fetch!(request(), env)
    expect(
      ((await publicResponse.json()) as { items: Array<{ slug: string; minPrice: number }> }).items.find(
        (p) => p.slug === 'producto-1'
      )?.minPrice
    ).toBe(500)
    const privateResponse = await worker.fetch!(request(cookie), env)
    expect(
      ((await privateResponse.json()) as { items: Array<{ slug: string; minPrice: number }> }).items.find(
        (p) => p.slug === 'producto-1'
      )?.minPrice
    ).toBe(333)
    expect(privateResponse.headers.get('cache-control')).toContain('no-store')
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(f.now, BUYER_CLAIMS.sessionId)
    expect((await worker.fetch!(request(cookie), env)).status).toBe(401)
  } finally {
    f.sqlite.close()
  }
})

it('sends the verified session to quote without a coupon and ignores injected tariff identifiers', async () => {
  const f = await world()
  try {
    const { createCart, setCartLine } = await import('../../workers/catalog/cart')
    const { handleCartCommand } = await import('../../workers/cart-coordinator')
    const { default: worker } = await import('../../workers/canary')
    const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
    const { BUYER_CLAIMS } = await import('./d1-returns-fixture')
    const password = 'synthetic-session-password-0123456789abcdef'
    const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
    const cart = await createCart(f.database, { correlationId: 'b2b-http', now: f.now })
    await setCartLine(f.database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1,
      correlationId: 'b2b-http',
      now: f.now
    })
    const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
    const env = {
      DB: f.database,
      AUTH_ENABLED: 'true',
      NUXT_SESSION_PASSWORD: password,
      CARTS: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (request: Request) => {
            const command = (await request.json()) as { commandId: string }
            const result = await handleCartCommand(command, {
              database: f.database,
              getResponse: async (k) => responses.get(k),
              putResponse: async (k, v) => {
                responses.set(k, v)
              },
              setAlarm: async () => {}
            })
            return Response.json(result.body, { status: result.status })
          }
        })
      }
    } as unknown as CloudflareEnv
    const response = await worker.fetch!(
      new Request(`https://shop.invalid/api/carts/${cart.cartId}/quote`, {
        method: 'POST',
        headers: {
          authorization: `Cart ${cart.token}`,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'quote-http'
        },
        body: JSON.stringify({ expectedVersion: 2, priceListId: 'injected', customerId: 'other' })
      }),
      env
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      quote: { lines: [{ unitGrossCents: 333, priceVersionId: 'b2b:list:v1:a1:variant:v-1-1' }] }
    })
  } finally {
    f.sqlite.close()
  }
})

it('does not release a private catalog response after a concurrent company suspension', async () => {
  const f = await world()
  try {
    const { default: worker } = await import('../../workers/canary')
    const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
    const { BUYER_CLAIMS } = await import('./d1-returns-fixture')
    const password = 'synthetic-session-password-0123456789abcdef'
    const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
    let fired = false
    const database = new Proxy(f.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (!fired) {
              fired = true
              f.sqlite.exec("UPDATE companies SET status='suspended' WHERE id='company'")
            }
            return result
          }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const env = { DB: database, AUTH_ENABLED: 'true', NUXT_SESSION_PASSWORD: password } as unknown as CloudflareEnv
    const response = await worker.fetch!(new Request('https://shop.invalid/api/products', { headers: { cookie } }), env)
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('333')
  } finally {
    f.sqlite.close()
  }
})

it('computes net catalog cents exactly at large safe-integer prices', async () => {
  const f = await world()
  try {
    await upsertD1B2BPriceList(
      f.database,
      CLAIMS,
      {
        priceListId: 'list',
        expectedVersion: 1,
        code: 'LIST',
        name: 'Tarifa',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: null,
        variantRules: [{ variantId: 'v-1-1', unitGrossCents: 9007199254740988 }],
        categoryRules: [],
        reason: 'Prueba de precisión'
      },
      { idempotencyKey: testUuid(), now: () => f.now }
    )
    const result = await listPublishedProducts(f.database, query, { instant: f.now, customerId: CUSTOMER })
    expect(result?.items.find((p) => p.slug === 'producto-1')?.minNetPrice).toBe(7443966326232221)
  } finally {
    f.sqlite.close()
  }
})

it('uses the verified session for the storefront shipping quote without a coupon', async () => {
  const f = await world()
  try {
    const { createCart, setCartLine } = await import('../../workers/catalog/cart')
    const { handleCartCommand } = await import('../../workers/cart-coordinator')
    const { setCartCookie } = await import('../../workers/catalog/storefront-cart')
    const { handleStorefrontShippingHttp } = await import('../../workers/catalog/storefront-shipping')
    const { BUYER_CLAIMS } = await import('./d1-returns-fixture')
    const cart = await createCart(f.database, { correlationId: 'b2b-shipping', now: f.now })
    await setCartLine(f.database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1,
      correlationId: 'b2b-shipping',
      now: f.now
    })
    const cookie = `${setCartCookie(cart, f.now).split(';')[0]}; neteco-session=verified`
    const cache = new Map<string, { payloadHash: string; status: number; body: unknown }>()
    const dispatch = async (command: Record<string, unknown>) => {
      const result = await handleCartCommand(command, {
        database: f.database,
        getResponse: async (key) => cache.get(key),
        putResponse: async (key, value) => {
          cache.set(key, value)
        },
        setAlarm: async () => {}
      })
      return Response.json(result.body, { status: result.status })
    }
    const deps = {
      database: f.database,
      dispatch,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-pepper-0123456789abcdef',
      now: () => f.now,
      authenticationEnabled: true,
      session: async () => BUYER_CLAIMS
    }
    const request = (body: unknown) =>
      new Request('https://shop.invalid/api/shipping/rates', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://shop.invalid',
          'content-type': 'application/json',
          'idempotency-key': testUuid(),
          'cf-connecting-ip': '192.0.2.1'
        },
        body: JSON.stringify(body)
      })
    const response = await handleStorefrontShippingHttp(request({ city: 'Ontinyent', postalCode: '46870' }), deps)
    expect(response?.status).toBe(200)
    const rates = (await response!.json()) as { rates: Array<{ serviceCode: string; totalGrossCents: number }> }
    expect(rates.rates.find((r) => r.serviceCode === 'pickup')?.totalGrossCents).toBe(333)
    expect(
      (
        await handleStorefrontShippingHttp(
          request({ city: 'Ontinyent', postalCode: '46870', priceListId: 'injected' }),
          deps
        )
      )?.status
    ).toBe(400)
  } finally {
    f.sqlite.close()
  }
})
