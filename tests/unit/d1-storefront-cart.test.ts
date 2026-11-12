import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { credentials, handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'
import { quoteCart } from '../../workers/catalog/cart'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { afterPublicMediaRead, publishMediaFixture, type JsonTestResponse } from '../support/media-publication-fixture'

const NOW = '2026-08-12T12:00:00Z'
const ORIGIN = 'https://shop.neteco.test'
const databases: DatabaseSync[] = []
interface CartTestItem extends Record<string, unknown> {
  qty: number
  variantId: number
  price: number
  compareAtPrice: number | null
  pricingVersion: string
  image: string | null
  imageAlt: string | null
}
interface CartTestBody extends Record<string, unknown> {
  id: string
  subtotal: number
  items: CartTestItem[]
}

async function world() {
  const sqlite = await openMigratedDatabase()
  databases.push(sqlite)
  seedInventoryFixture(sqlite)
  // Local SQLite seam follows the live fake Date at SQL execution, preserving
  // production's 'now' clock and the scanner's original finite lifetime.
  sqlite.function('synthetic_storefront_cart_clock', () => {
    const clock = vi.getMockedSystemTime()
    if (!clock) throw new Error('missing_synthetic_storefront_cart_clock')
    const milliseconds = clock.getTime(),
      instant = new Date(milliseconds).toISOString()
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant) || Date.parse(instant) !== milliseconds)
      throw new Error('invalid_synthetic_storefront_cart_clock')
    return instant
  })
  const nativeDatabase = d1OverSqlite(sqlite),
    nativePrepare = nativeDatabase.prepare.bind(nativeDatabase)
  const database = new Proxy(nativeDatabase, {})
  database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_storefront_cart_clock()'))
  await provisionPublicationValidityFixture(database, {
    productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
    now: '2026-01-01T00:00:00Z'
  })
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const dispatch = async (command: Record<string, unknown>) => {
    const cartId = String(command.cartId)
    const result = await handleCartCommand(command, {
      database,
      getResponse: async (commandId) => responses.get(`${cartId}:${commandId}`),
      putResponse: async (commandId, value) => {
        responses.set(`${cartId}:${commandId}`, value)
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
    rateLimitPepper: 'test-cart-edge-pepper-0123456789abcdef',
    now: () => NOW
  }
  const request = (path: string, method = 'GET', cookie?: string, body?: Record<string, unknown>, origin = ORIGIN) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': '192.0.2.21',
        ...(cookie ? { cookie } : {}),
        ...(method === 'GET' ? {} : { origin }),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
  const send = async (path: string, method = 'GET', cookie?: string, body?: Record<string, unknown>) => {
    const response = await handleStorefrontCartHttp(request(path, method, cookie, body), deps)
    if (!response) throw new Error('route did not match')
    return response as JsonTestResponse<CartTestBody>
  }
  const begin = async () => {
    const response = await send('/api/cart')
    expect(response.status).toBe(200)
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!
    return { cookie, cart: (await response.json()) as Record<string, unknown> }
  }
  return { sqlite, database, deps, dispatch, request, send, begin }
}

describe('Cloudflare storefront cart facade', () => {
  it.each([NOW, '2027-01-01T00:00:00Z'])(
    'rejects an ADD bound to another cart at %s after authorizing the current cookie, without expiry or dispatch',
    async (now) => {
      const { sqlite, deps, request, begin } = await world()
      const first = await begin(),
        second = await begin()
      const before = sqlite.prepare('SELECT total_changes() AS changes').get()
      const dispatch = vi.fn(async () => {
        throw new Error('mismatched ADD must never dispatch')
      })
      const input = { variantId: 11, quantity: 2, expectedVersion: 1, idempotencyKey: 'bound-add' }
      const base = request('/api/cart/items', 'POST', second.cookie, input)
      const headers = new Headers(base.headers)
      headers.set('X-Neteco-Cart-Id', String(first.cart.id))
      const response = await handleStorefrontCartHttp(new Request(base, { headers }), {
        ...deps,
        dispatch,
        now: () => now
      })
      expect(response?.status).toBe(409)
      expect(await response!.json()).toEqual({ error: { code: 'conflict' } })
      expect(dispatch).not.toHaveBeenCalled()
      expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
      expect(sqlite.prepare('SELECT status FROM carts').all()).toEqual([{ status: 'active' }, { status: 'active' }])
      const unauthorized = request('/api/cart/items', 'POST', second.cookie.replace(/[^.]+$/, 'A'.repeat(43)), input)
      const invalidHeaders = new Headers(unauthorized.headers)
      invalidHeaders.set('X-Neteco-Cart-Id', String(first.cart.id))
      expect(
        (await handleStorefrontCartHttp(new Request(unauthorized, { headers: invalidHeaders }), { ...deps, dispatch }))
          ?.status
      ).toBe(401)
    }
  )
  it('recovers a lost ADD response after withdrawal without dispatch, creation or mutation', async () => {
    const { sqlite, deps, request, send, begin } = await world()
    const { cookie, cart } = await begin()
    await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'lost/add'
    })
    sqlite.exec(
      "UPDATE variants SET status='draft' WHERE id='v-1-1'; UPDATE carts SET status='expired',expired_at=expires_at"
    )
    const before = sqlite.prepare('SELECT * FROM carts').all()
    const dispatch = vi.fn(async () => {
      throw new Error('GET must never dispatch')
    })
    const path = '/api/cart/operations/lost%2Fadd?variantId=11&quantity=2&expectedVersion=1'
    const response = await handleStorefrontCartHttp(request(path, 'GET', cookie), { ...deps, dispatch })
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({
      source: 'cloudflare',
      cartId: cart.id,
      commandId: 'lost/add',
      outcome: 'applied',
      appliedVersion: 2
    })
    expect(response!.headers.get('set-cookie')).toBeNull()
    expect(response!.headers.get('cache-control')).toBe('no-store')
    expect(dispatch).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT * FROM carts').all()).toEqual(before)
    expect((await send(path, 'GET')).status).toBe(401)
    expect((await send(path.replace('quantity=2', 'quantity=3'), 'GET', cookie)).status).toBe(409)
    expect(await (await send(path.replace('lost%2Fadd', 'absent'), 'GET', cookie)).json()).toMatchObject({
      outcome: 'unknown',
      appliedVersion: null
    })
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    for (const database of databases.splice(0)) database.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses only the exact governed SKU image and withdraws it without changing cart prices or quantities', async () => {
    const { sqlite, database, send, begin } = await world()
    sqlite.exec(`UPDATE products SET attributes = '{"image":"https://unapproved.example.invalid/product.jpg"}' WHERE id = 'p-1';
      UPDATE variants SET image = '/img/products/unapproved.webp' WHERE id = 'v-1-1';
      INSERT INTO variants(id, legacy_id, product_id, sku, format, status, price_gross_cents, tax_class_id, shipping_profile_id, mpn)
      VALUES ('v-1-2', 12, 'p-1', 'SKU-1-2', 'Otro color', 'published', 900, 't21', 'sp1', 'SYNTHETIC-SIBLING-MPN')`)
    await publishMediaFixture(database, { now: NOW, productId: 'p-1' })
    await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-2' })
    const { cookie } = await begin()
    const response = await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'own-image'
    })
    const baseline = await response.json()
    expect(baseline.items[0]).toMatchObject({ image: null, imageAlt: null, sku: 'SKU-1-1', qty: 2, price: 500 })
    const photo = await publishMediaFixture(database, {
      now: NOW,
      productId: 'p-1',
      variantId: 'v-1-1',
      imageAlt: 'Foto autorizada SKU-1-1'
    })
    const published = await (await send('/api/cart', 'GET', cookie)).json()
    expect(published).toEqual({
      ...baseline,
      items: [{ ...baseline.items[0], image: photo.image, imageAlt: photo.imageAlt }]
    })
    for (const forbidden of [
      'unapproved',
      'productUuid',
      'variantUuid',
      photo.uploadId,
      'object_key',
      'scannerVersion'
    ])
      expect(JSON.stringify(published)).not.toContain(forbidden)
    await photo.withdraw()
    expect(await (await send('/api/cart', 'GET', cookie)).json()).toEqual(baseline)
  })

  it.each([1, 6])('batches media for %i cart lines without N+1 queries', async (count) => {
    const { database, send, begin } = await world()
    const { cookie } = await begin()
    for (let index = 1; index <= count; index++)
      await send('/api/cart/items', 'POST', cookie, {
        variantId: index * 10 + 1,
        quantity: 1,
        expectedVersion: index,
        idempotencyKey: `line-${index}`
      })
    const prepare = vi.spyOn(database, 'prepare')
    const response = await send('/api/cart', 'GET', cookie)
    expect(response.status).toBe(200)
    expect((await response.json()).items).toHaveLength(count)
    expect(prepare).toHaveBeenCalledTimes(6)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH supplied_now AS'))).toHaveLength(1)
  })

  it('rechecks the token after media enrichment and never releases the old cart after revocation', async () => {
    const { sqlite, database, deps, request, begin, send } = await world()
    const { cookie } = await begin()
    await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'before-revoke'
    })
    const identity = credentials(request('/api/cart', 'GET', cookie))!
    let changed = false
    const wrapped = afterPublicMediaRead(database, () => {
      if (!changed) {
        changed = true
        sqlite.prepare('UPDATE carts SET token_hash = ? WHERE id = ?').run('0'.repeat(64), identity.cartId)
      }
    })
    const response = await handleStorefrontCartHttp(request('/api/cart', 'GET', cookie), { ...deps, database: wrapped })
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as CartTestBody
    expect(body.id).not.toBe(identity.cartId)
    expect(body.items).toEqual([])
    expect(response?.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it.each(['version', 'expiry', 'converted'] as const)(
    'rejects a concurrently changed cart %s after media enrichment instead of mixing state',
    async (change) => {
      const { sqlite, database, deps, request, begin, send } = await world()
      const { cookie } = await begin()
      await send('/api/cart/items', 'POST', cookie, {
        variantId: 11,
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: 'before-change'
      })
      const identity = credentials(request('/api/cart', 'GET', cookie))!
      const quote = await quoteCart(database, {
        ...identity,
        expectedVersion: 2,
        idempotencyKey: 'conversion-quote',
        correlationId: 'test',
        now: NOW
      })
      if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
      const wrapped = afterPublicMediaRead(database, () => {
        if (change === 'version')
          sqlite.prepare('UPDATE carts SET version = version + 1 WHERE id = ?').run(identity.cartId)
        if (change === 'expiry')
          sqlite.prepare('UPDATE carts SET expires_at = ? WHERE id = ?').run('2026-08-13T13:00:00Z', identity.cartId)
        if (change === 'converted')
          sqlite
            .prepare(
              "UPDATE carts SET status = 'converted', converted_at = ?, converted_quote_id = ?, version = version + 1 WHERE id = ?"
            )
            .run(NOW, quote.quote.quoteId, identity.cartId)
      })
      const response = await handleStorefrontCartHttp(request('/api/cart', 'GET', cookie), {
        ...deps,
        database: wrapped
      })
      expect(response?.status).toBe(409)
      expect(await response!.json()).toEqual({ error: { code: 'version_conflict' } })
      expect(response?.headers.get('cache-control')).toBe('no-store')
    }
  )

  it('rejects natural cart expiry during media enrichment even without a concurrent database update', async () => {
    const { sqlite, database, deps, request, begin, send } = await world()
    const { cookie } = await begin()
    await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'before-natural-expiry'
    })
    const identity = credentials(request('/api/cart', 'GET', cookie))!
    sqlite.prepare('UPDATE carts SET expires_at = ? WHERE id = ?').run('2026-08-12T12:00:01Z', identity.cartId)
    const wrapped = afterPublicMediaRead(database, () => {
      vi.setSystemTime(new Date('2026-08-12T12:00:01Z'))
    })
    const response = await handleStorefrontCartHttp(request('/api/cart', 'GET', cookie), { ...deps, database: wrapped })
    expect(response?.status).toBe(409)
    expect(await response!.json()).toEqual({ error: { code: 'version_conflict' } })
    expect(sqlite.prepare('SELECT status FROM carts WHERE id = ?').get(identity.cartId)).toEqual({ status: 'expired' })
  })

  it('creates a cart behind a secure HttpOnly cookie without leaking the token into JSON or D1', async () => {
    const { sqlite, send } = await world()
    const response = await send('/api/cart')
    const cookie = response.headers.get('set-cookie')!
    const payload = await response.text()
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(payload).toContain('"items":[]')
    const token = cookie.match(/v1\.[^.]+\.([A-Za-z0-9_-]{43})/)?.[1]
    expect(token).toBeTruthy()
    expect(payload).not.toContain(token!)
    const saved = sqlite.prepare('SELECT token_hash FROM carts').get() as { token_hash: string }
    expect(saved.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(saved.token_hash).not.toBe(token)
  })

  it('fails closed before creating a cart when edge abuse control is denied or unavailable', async () => {
    const { sqlite, deps, request } = await world()
    const denied = await handleStorefrontCartHttp(request('/api/cart'), {
      ...deps,
      edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
    })
    expect(denied?.status).toBe(429)
    const unavailable = await handleStorefrontCartHttp(new Request(`${ORIGIN}/api/cart`), deps)
    expect(unavailable?.status).toBe(503)
    expect((sqlite.prepare('SELECT count(*) AS n FROM carts').get() as { n: number }).n).toBe(0)
  })

  it('maps legacy variant IDs, adds atomically, and does not double-add on replay', async () => {
    const { sqlite, send, begin } = await world()
    const { cookie } = await begin()
    const input = { variantId: 11, quantity: 2, expectedVersion: 1, idempotencyKey: 'add-once' }
    const first = await send('/api/cart/items', 'POST', cookie, input)
    expect(first.status).toBe(200)
    expect(((await first.json()) as { items: Array<{ qty: number; variantId: number }> }).items).toMatchObject([
      { qty: 2, variantId: 11 }
    ])
    expect((await send('/api/cart/items', 'POST', cookie, input)).status).toBe(200)
    expect((await send('/api/cart/items', 'POST', cookie, { ...input, quantity: 3 })).status).toBe(409)
    expect(((await sqlite.prepare('SELECT quantity FROM cart_lines').get()) as { quantity: number }).quantity).toBe(2)
    expect(((await sqlite.prepare('SELECT count(*) AS n FROM cart_commands').get()) as { n: number }).n).toBe(1)
  })

  it('uses the governed effective price and does not resurrect a legacy compare-at value', async () => {
    const { sqlite, send, begin } = await world()
    const { cookie } = await begin()
    sqlite.exec('UPDATE variants SET compare_at_gross_cents = 900 WHERE legacy_id = 11')
    sqlite.exec(`INSERT INTO variant_price_versions (
      id, variant_id, gross_cents, compare_at_gross_cents, valid_from, reason, created_at
    ) VALUES (
      'price-governed', 'v-1-1', 800, NULL, '2026-08-12T00:00:00Z',
      'test governed price', '2026-08-12T00:00:00Z'
    )`)
    const response = await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: 'governed'
    })
    expect(response.status).toBe(200)
    const cart = (await response.json()) as {
      subtotal: number
      items: Array<{ price: number; compareAtPrice: number | null; pricingVersion: string }>
    }
    expect(cart.subtotal).toBe(800)
    expect(cart.items[0]).toMatchObject({ price: 800, compareAtPrice: null, pricingVersion: 'price-governed' })
  })

  it('projects the same volume tier and line-rounded net that checkout quotes', async () => {
    const { sqlite, send, begin } = await world()
    const { cookie } = await begin()
    sqlite.exec(`INSERT INTO variant_price_versions (
      id, variant_id, gross_cents, volume_tiers, valid_from, reason, created_at
    ) VALUES (
      'price-tier-cart', 'v-1-1', 500,
      '[{"minimumQuantity":2,"unitGrossCents":3}]',
      '2026-08-12T00:00:00Z', 'Volume discount', '2026-08-12T00:00:00Z'
    )`)
    const response = await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'tier-cart'
    })
    expect(response.status).toBe(200)
    const cart = (await response.json()) as Record<string, unknown> & { items: Array<Record<string, unknown>> }
    expect(cart.items[0]).toMatchObject({
      basePrice: 500,
      price: 3,
      priceTiers: [{ minimumQuantity: 2, unitGrossCents: 3 }],
      netPrice: 2,
      lineNet: 5,
      pricingVersion: 'price-tier-cart'
    })
    expect(cart).toMatchObject({ subtotal: 6, subtotalNet: 5, tax: 1 })
    const overLimit = await send('/api/cart/items/11', 'PUT', cookie, {
      quantity: 1000,
      expectedVersion: 2,
      idempotencyKey: 'tier-over-limit'
    })
    expect(overLimit.status).toBe(400)
    expect((sqlite.prepare('SELECT quantity FROM cart_lines').get() as { quantity: number }).quantity).toBe(2)
  })

  it('sets, removes, and revokes with version gates; a clear replay cannot revive the cart', async () => {
    const { sqlite, send, begin } = await world()
    const { cookie } = await begin()
    expect(
      (
        await send('/api/cart/items', 'POST', cookie, {
          variantId: 11,
          quantity: 1,
          expectedVersion: 1,
          idempotencyKey: 'add'
        })
      ).status
    ).toBe(200)
    expect(
      (
        await send('/api/cart/items/11', 'PUT', cookie, {
          quantity: 3,
          expectedVersion: 2,
          idempotencyKey: 'set'
        })
      ).status
    ).toBe(200)
    expect((await send('/api/cart/items/11?expectedVersion=3&idempotencyKey=remove', 'DELETE', cookie)).status).toBe(
      200
    )
    expect(
      (
        await send('/api/cart/items', 'POST', cookie, {
          variantId: 11,
          quantity: 2,
          expectedVersion: 4,
          idempotencyKey: 'readd'
        })
      ).status
    ).toBe(200)
    const clearPath = '/api/cart?expectedVersion=5&idempotencyKey=clear'
    const clear = await send(clearPath, 'DELETE', cookie)
    expect(clear.status).toBe(200)
    expect(clear.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(((await sqlite.prepare('SELECT count(*) AS n FROM cart_lines').get()) as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT status FROM carts').get() as { status: string }).status).toBe('expired')
    expect((await send(clearPath, 'DELETE', cookie)).status).toBe(200)
    expect(
      (
        await send('/api/cart/items', 'POST', cookie, {
          variantId: 11,
          quantity: 1,
          expectedVersion: 6,
          idempotencyKey: 'after-clear'
        })
      ).status
    ).toBe(409)
    expect(((await sqlite.prepare('SELECT count(*) AS n FROM cart_lines').get()) as { n: number }).n).toBe(0)
  })

  it('rejects cross-origin writes and bad cookies; GET replaces a bad cookie without leaking existence', async () => {
    const { deps, request, send, begin } = await world()
    const { cookie } = await begin()
    const crossOrigin = await handleStorefrontCartHttp(
      request(
        '/api/cart/items',
        'POST',
        cookie,
        { variantId: 11, quantity: 1, expectedVersion: 1, idempotencyKey: 'x' },
        'https://evil.test'
      ),
      deps
    )
    expect(crossOrigin?.status).toBe(403)
    expect(
      (
        await send('/api/cart/items', 'POST', 'neteco-cart-v2=bad', {
          variantId: 11,
          quantity: 1,
          expectedVersion: 1,
          idempotencyKey: 'x'
        })
      ).status
    ).toBe(401)
    const replaced = await send('/api/cart', 'GET', 'neteco-cart-v2=bad')
    expect(replaced.status).toBe(200)
    expect(replaced.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('cannot add an item whose category is no longer published', async () => {
    const { sqlite, begin, send } = await world()
    const { cookie } = await begin()
    sqlite.exec("UPDATE categories SET status = 'hidden' WHERE id = 'c1'")
    const response = await send('/api/cart/items', 'POST', cookie, {
      variantId: 11,
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: 'hidden-category'
    })
    expect(response.status).toBe(422)
    expect(((await sqlite.prepare('SELECT count(*) AS n FROM cart_lines').get()) as { n: number }).n).toBe(0)
  })

  it('mounts the facade before the legacy canary handlers', async () => {
    const { database, dispatch, request } = await world()
    const env = {
      DB: database,
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_RATE_LIMIT_PEPPER: 'test-cart-edge-pepper-0123456789abcdef',
      CARTS: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async (call: Request) => dispatch((await call.json()) as Record<string, unknown>) })
      }
    } as unknown as CloudflareEnv
    const response = await worker.fetch!(request('/api/cart'), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })
})
