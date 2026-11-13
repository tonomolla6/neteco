import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { testNow, testUuid } from '../support/deterministic'
import { readProductRecommendations } from '../../workers/catalog/product-recommendations'
import { handleProductRecommendationsHttp } from '../../workers/catalog/product-recommendations-http'
import { parseProductRecommendationsQuery, recommendationTitle } from '../../shared/product-recommendations'
import { assignD1CompanyB2BPriceList, upsertD1B2BPriceList } from '../../workers/catalog/b2b-pricing'

let sqlite: DatabaseSync, database: D1Database, now: string
const origin = 'https://recommendations.neteco.test'
const query = (search: string) => parseProductRecommendationsQuery(new URLSearchParams(search))!
beforeEach(async () => {
  now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  sqlite = await openAccountSecurityDatabase()
  database = d1OverSqlite(sqlite)
  seedInventoryFixture(sqlite)
  await provisionPublicationValidityFixture(database, { productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'], now })
  sqlite.exec('UPDATE products SET featured=1')
})
afterEach(() => {
  sqlite?.close()
  vi.restoreAllMocks()
})

function pair(a: number, b: number, count: number) {
  sqlite.prepare('INSERT INTO catalog_co_purchases VALUES (?,?,?,?)').run(`p-${a}`, `p-${b}`, count, now)
}
function view(productId: number, session: number) {
  sqlite
    .prepare(
      `INSERT INTO analytics_client_events VALUES (?, 'product_viewed', ?, 'preview', 'synthetic', '1', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      testUuid(),
      session.toString(16).padStart(64, '0'),
      'a'.repeat(64),
      JSON.stringify({ productId }),
      'b'.repeat(64),
      now,
      now,
      '2099-01-01T00:00:00Z'
    )
}

describe('published product recommendations use real signals and catalog authority', () => {
  it('only labels co-purchase with at least two orders per recommended product', async () => {
    pair(1, 2, 1)
    pair(1, 3, 2)
    pair(4, 1, 3)
    const response = await readProductRecommendations(database, query('product=producto-1&strips=bought_together'))
    expect(response.strips).toHaveLength(1)
    expect(response.strips[0]).toMatchObject({ kind: 'bought_together', basis: 'co_purchase' })
    expect(response.strips[0]!.items.map((item) => item.id)).toEqual([4, 3])
    expect(recommendationTitle(response.strips[0]!)).toBe('Comprados juntos frecuentemente')
  })

  it('only claims co-viewing with two independent sessions', async () => {
    for (const session of [1, 2]) for (const product of [1, 2, 3]) view(product, session)
    view(4, 1)
    const response = await readProductRecommendations(database, query('product=producto-1&strips=also_viewed'))
    expect(response.strips[0]).toMatchObject({ basis: 'co_view' })
    expect(response.strips[0]!.items.map((item) => item.id).sort()).toEqual([2, 3])
  })

  it('keeps fallback labels honest, excludes anchors/cart, and never repeats a card across strips', async () => {
    const response = await readProductRecommendations(
      database,
      query('product=producto-1&cart=producto-2&strips=also_viewed,trending')
    )
    expect(response.strips[0]).toMatchObject({ basis: 'category' })
    expect(recommendationTitle(response.strips[0]!)).toBe('Más productos de esta familia')
    const ids = response.strips.flatMap((strip) => strip.items.map((item) => item.id))
    expect(ids).not.toContain(1)
    expect(ids).not.toContain(2)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never recommends unpublished products or products without a positive public price', async () => {
    pair(1, 2, 2)
    pair(1, 3, 2)
    pair(1, 4, 2)
    pair(1, 5, 2)
    sqlite.exec(
      "UPDATE products SET status='draft' WHERE id='p-2'; UPDATE variants SET price_gross_cents=0 WHERE product_id='p-3'"
    )
    const response = await readProductRecommendations(database, query('product=producto-1&strips=bought_together'))
    expect(response.strips[0]!.items.map((item) => item.id).sort()).toEqual([4, 5])
    expect(response.strips[0]!.items.every((item) => item.minPrice > 0 && item.image?.startsWith('/media/'))).toBe(true)
  })

  it('preserves the customer contractual price while guests receive the public price', async () => {
    const actor = testUuid(),
      sessionId = testUuid(),
      customerId = testUuid()
    const past = new Date(testNow() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const future = new Date(testNow() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run(customerId, 'Synthetic company', past, past)
    sqlite
      .prepare(
        "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company',?,'Synthetic','approved',?,?)"
      )
      .run(customerId, past, past)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'editor@example.invalid','synthetic',?,'active',?,?)"
      )
      .run(actor, past, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(sessionId, actor, past, future)
    sqlite.exec(
      "INSERT INTO roles VALUES('editor','Editor','Synthetic'); INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'); INSERT INTO role_permissions VALUES('editor','administration.manage')"
    )
    sqlite.prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'editor',?)").run(actor, past)
    const claims = { identityId: actor, sessionId, sessionVersion: 1 }
    await upsertD1B2BPriceList(
      database,
      claims,
      {
        priceListId: 'list',
        expectedVersion: 0,
        code: 'LIST',
        name: 'Tarifa',
        status: 'active',
        validFrom: past,
        validUntil: null,
        variantRules: [{ variantId: 'v-2-1', unitGrossCents: 333 }],
        categoryRules: [],
        reason: 'Synthetic contractual price'
      },
      { idempotencyKey: testUuid(), now: () => now }
    )
    await assignD1CompanyB2BPriceList(
      database,
      claims,
      'company',
      {
        priceListId: 'list',
        expectedVersion: 0,
        validFrom: past,
        validUntil: null,
        reason: 'Synthetic contractual price'
      },
      { idempotencyKey: testUuid(), now: () => now }
    )
    pair(1, 2, 2)
    pair(1, 3, 2)
    const request = query('product=producto-1&strips=bought_together')
    const guest = await readProductRecommendations(database, request)
    const buyer = await readProductRecommendations(database, request, { pricing: { instant: now, customerId } })
    expect(guest.strips[0]!.items.find((item) => item.id === 2)?.minPrice).toBe(500)
    expect(buyer.strips[0]!.items.find((item) => item.id === 2)?.minPrice).toBe(333)
  })
})

describe('recommendation HTTP boundary', () => {
  const deps = () => ({
    database,
    origin,
    edgeLimiter: { limit: async () => ({ success: true }) } as RateLimit,
    rateLimitPepper: 'synthetic-rate-limit-pepper-32-characters'
  })
  const request = (path: string, init?: RequestInit) =>
    new Request(origin + path, { ...init, headers: { 'cf-connecting-ip': '192.0.2.46', ...init?.headers } })

  it('serves a private cookie-varying response without writing impressions', async () => {
    const response = await handleProductRecommendationsHttp(
      request('/api/product-recommendations?strips=trending'),
      deps()
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get('cache-control')).toBe('private, max-age=120')
    expect(response?.headers.get('cdn-cache-control')).toBe('no-store')
    expect(response?.headers.get('vary')).toBe('Cookie')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM recommendation_impressions').get()?.n).toBe(0)
  })
  it.each(['limit=13', 'limit=0', 'unknown=1', 'product=a&product=b', 'product=../private', 'strips=unknown'])(
    'rejects invalid or duplicate input %s',
    async (search) => {
      const response = await handleProductRecommendationsHttp(request(`/api/product-recommendations?${search}`), deps())
      expect(response?.status).toBe(400)
      expect(await response?.json()).toEqual({ error: { code: 'invalid_input' } })
    }
  )
  it('rejects cross-origin requests, method changes, encoded aliases and exhausted edge quotas', async () => {
    expect(
      (
        await handleProductRecommendationsHttp(
          request('/api/product-recommendations', { headers: { origin: 'https://other.invalid' } }),
          deps()
        )
      )?.status
    ).toBe(403)
    expect(
      (await handleProductRecommendationsHttp(request('/api/product-recommendations', { method: 'POST' }), deps()))
        ?.status
    ).toBe(405)
    expect((await handleProductRecommendationsHttp(request('/api/%70roduct-recommendations'), deps()))?.status).toBe(
      404
    )
    const limited = { ...deps(), edgeLimiter: { limit: async () => ({ success: false }) } as RateLimit }
    expect((await handleProductRecommendationsHttp(request('/api/product-recommendations'), limited))?.status).toBe(429)
  })
})
