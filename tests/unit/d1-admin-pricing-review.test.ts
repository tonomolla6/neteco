import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { listD1AdminPrices, type D1AdminPricingList } from '../../workers/catalog/admin-pricing'
import { handleD1AdminPricingRequest } from '../../workers/catalog/admin-pricing-http'
import { listD1AdminProducts, readD1AdminProduct } from '../../workers/catalog/admin-catalog'
import { cartGoodsGrossCents, createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import { listPublishedProducts } from '../../workers/catalog/products'
import { handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-09-30T09:00:00Z'
const IDENTITY = '41000000-0000-4000-8000-000000000001'
const SESSION = '42000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'synthetic-pricing-review-cookie-password-at-least-32', maxAgeSeconds: 3600 }
const QUERY = { q: '', variant: 11, page: 1, perPage: 1, historyPage: 1, historyPerPage: 8 }
const LEGACY = { basePrice: 500, unitPrice: 500, compareAtPrice: 1000, referencePrice30d: null, priceTiers: [] }
const GOVERNED = {
  basePrice: 700,
  unitPrice: 600,
  compareAtPrice: 900,
  referencePrice30d: 650,
  priceTiers: [{ minimumQuantity: 10, unitGrossCents: 600 }]
}

interface ExpectedPrice {
  basePrice: number
  unitPrice: number
  compareAtPrice: number | null
  referencePrice30d: number | null
  priceTiers: Array<{ minimumQuantity: number; unitGrossCents: number }>
}

describe('independent governed admin-pricing contract review', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','pricing-review@example.invalid','synthetic-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T08:00:00Z','2026-09-30T11:00:00Z');
      INSERT INTO roles VALUES ('pricing_review_editor','Editor','Independent local fixture');
      INSERT INTO permissions VALUES ('catalog.write','catalog','write','Independent local fixture');
      INSERT INTO role_permissions VALUES ('pricing_review_editor','catalog.write');
      INSERT INTO identity_roles(identity_id,role_code,granted_at)
        VALUES ('${IDENTITY}','pricing_review_editor','2026-09-01T00:00:00Z');
      UPDATE variants SET compare_at_gross_cents=1000,created_at='2026-09-01T00:00:00Z' WHERE id='v-1-1';
    `)
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  function approvedVersion(id: string, compareAt: number | null, variantId = 'v-1-1', from = '2026-09-29T00:00:00Z') {
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,compare_at_gross_cents,
          reference_gross_cents_30d,volume_tiers,valid_from,status,reason,created_at)
         VALUES (?,?,700,?,650,'[{"minimumQuantity":10,"unitGrossCents":600}]',?,'approved',
          'Independent approved fixture','2026-09-28T00:00:00Z')`
      )
      .run(id, variantId, compareAt, from)
  }
  async function readAdmin() {
    const result = await listD1AdminPrices(database, CLAIMS, NOW, QUERY)
    if (result.outcome !== 'found') throw new Error('Independent fixture must be authorized')
    expect(result.data.items).toHaveLength(1)
    return result.data.items[0]!
  }

  async function assertEveryConsumer(expected: ExpectedPrice, pricingVersion = 'legacy:v-1-1') {
    const detail = await getPublishedProductDetail(database, 'producto-1', { instant: NOW })
    const variantShape = {
      price: expected.basePrice,
      compareAtPrice: expected.compareAtPrice,
      referencePrice30d: expected.referencePrice30d,
      priceTiers: expected.priceTiers,
      pricingVersion,
      sku: 'SKU-1-1'
    }
    expect.soft(detail!.variants[0]).toMatchObject(variantShape)
    const published = await listPublishedProducts(database, { page: 1, limit: 24, sort: 'default' }, { instant: NOW })
    expect.soft(published!.items.find((item) => item.id === 1)).toMatchObject({
      minPrice: expected.basePrice,
      compareAtPrice: expected.compareAtPrice
    })
    const privateDetail = await readD1AdminProduct(database, CLAIMS, NOW, '1')
    if (privateDetail.outcome !== 'found') throw new Error('Independent catalog fixture must be authorized')
    expect.soft(privateDetail.data.variants[0]).toMatchObject(variantShape)
    const privateList = await listD1AdminProducts(database, CLAIMS, NOW, { q: 'Producto 1', page: 1, perPage: 25 })
    if (privateList.outcome !== 'found') throw new Error('Independent catalog list fixture must be authorized')
    expect.soft(privateList.data.items[0]).toMatchObject({ id: 1, minPrice: expected.basePrice })
    expect.soft(await readAdmin()).toMatchObject({
      grossCents: expected.basePrice,
      compareAtGrossCents: expected.compareAtPrice,
      referenceGrossCents30d: expected.referencePrice30d,
      volumeTiers: expected.priceTiers,
      pricingVersion
    })

    const created = await createCart(database, { correlationId: 'independent-pricing-review', now: NOW })
    expect(
      await setCartLine(database, {
        ...created,
        variantId: 'v-1-1',
        quantity: 10,
        expectedVersion: 1,
        idempotencyKey: 'independent-line',
        correlationId: 'independent-pricing-review',
        now: NOW
      })
    ).toMatchObject({ outcome: 'applied' })
    const response = await handleStorefrontCartHttp(
      new Request('https://neteco.invalid/api/cart', {
        headers: { cookie: `neteco-cart-v2=v1.${created.cartId}.${created.token}` }
      }),
      {
        database,
        now: () => NOW,
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        rateLimitPepper: 'synthetic-pricing-review-limiter-at-least-32',
        dispatch: async () => {
          throw new Error('Existing-cart GET must not dispatch a mutation')
        }
      }
    )
    expect(response!.status).toBe(200)
    const projected = (await response!.json()) as { items: unknown[]; subtotal: number }
    expect.soft(projected.items[0]).toMatchObject({
      ...variantShape,
      price: expected.unitPrice,
      basePrice: expected.basePrice,
      qty: 10
    })
    expect.soft(projected.subtotal).toBe(expected.unitPrice * 10)
    expect.soft(await cartGoodsGrossCents(database, created.cartId, NOW)).toBe(expected.unitPrice * 10)

    const quoteInput = {
      ...created,
      expectedVersion: 2,
      idempotencyKey: 'independent-quote',
      correlationId: 'independent-pricing-review',
      now: NOW
    }
    const result = await quoteCart(database, quoteInput)
    if (result.outcome !== 'quoted') throw new Error('Independent fixture must produce a contractual quote')
    expect.soft(result.quote.lines[0]).toMatchObject({
      variantId: 'v-1-1',
      sku: 'SKU-1-1',
      quantity: 10,
      unitGrossCents: expected.unitPrice,
      grossCents: expected.unitPrice * 10,
      priceVersionId: pricingVersion
    })
    expect.soft(result.quote.totals.grossCents).toBe(expected.unitPrice * 10)
    if (expected.basePrice === LEGACY.basePrice) {
      sqlite.exec("UPDATE variants SET price_gross_cents=950 WHERE id='v-1-1'")
      expect(await quoteCart(database, { ...quoteInput, now: '2026-09-30T09:01:00Z' })).toEqual(result)
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM checkout_quotes').get()).toMatchObject({ count: 1 })
    }
  }

  it('preserves an approved NULL compare-at instead of resurrecting legacy metadata in the real HTTP DTO', async () => {
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
    approvedVersion('43000000-0000-4000-8000-000000000001', null)
    const publicDetail = await getPublishedProductDetail(database, 'producto-1', { instant: NOW })
    const publicVariant = publicDetail!.variants[0]!
    expect(publicVariant).toMatchObject({ price: 700, compareAtPrice: null })
    const cookie = await issueD1SessionCookie(database, CLAIMS, COOKIE)
    expect(cookie).not.toBeNull()
    const response = await handleD1AdminPricingRequest(
      new Request('https://neteco.invalid/api/admin/prices?variant=11', {
        headers: { cookie: cookie!.split(';')[0]! }
      }),
      { database, sessionCookieConfiguration: COOKIE, origin: 'https://neteco.invalid', now: NOW }
    )
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    const admin = (await response!.json()) as D1AdminPricingList
    expect(admin.items[0]!.grossCents).toBe(publicVariant.price)
    expect(admin.items[0]!.compareAtGrossCents).toBe(publicVariant.compareAtPrice)
    await assertEveryConsumer({ ...GOVERNED, compareAtPrice: null }, '43000000-0000-4000-8000-000000000001')
  })

  it('keeps all metadata attached to the effective version even when its stored ID matches the legacy marker', async () => {
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
    approvedVersion('legacy:v-1-1', 900)
    const publicDetail = await getPublishedProductDetail(database, 'producto-1', { instant: NOW })
    expect(publicDetail!.variants[0]).toMatchObject({
      price: 700,
      compareAtPrice: 900,
      referencePrice30d: 650,
      priceTiers: [{ minimumQuantity: 10, unitGrossCents: 600 }],
      pricingVersion: 'legacy:v-1-1'
    })
    const admin = await readAdmin()
    expect(admin.history[0]).toMatchObject({ id: 'legacy:v-1-1', grossCents: 700, compareAtGrossCents: 900 })
    expect(admin).toMatchObject({
      grossCents: 700,
      compareAtGrossCents: 900,
      referenceGrossCents30d: 650,
      volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 600 }],
      pricingVersion: 'legacy:v-1-1',
      validFrom: '2026-09-29T00:00:00Z'
    })
  })

  it('keeps an active marker-ID winner and its volume price consistent across all consumers', async () => {
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
    approvedVersion('legacy:v-1-1', 900)
    await assertEveryConsumer(GOVERNED)
  })

  it.each([
    ['future own SKU', 'v-1-1', '2026-10-01T00:00:00Z'],
    ['future other SKU', 'v-2-1', '2026-10-01T00:00:00Z'],
    ['active other SKU', 'v-2-1', '2026-09-29T00:00:00Z']
  ])(
    'does not attach marker-ID metadata to the current legacy price across any consumer (%s)',
    async (_, variantId, from) => {
      // The compared public/cart SKU is p-1 only. A price version attached to
      // v-2-1 remains a separate, unapproved-publication administrative fixture.
      await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
      approvedVersion('legacy:v-1-1', 900, variantId, from)
      expect(await readAdmin()).toMatchObject({
        grossCents: 500,
        compareAtGrossCents: 1000,
        referenceGrossCents30d: null,
        volumeTiers: [],
        pricingVersion: 'legacy:v-1-1',
        validFrom: '2026-09-01T00:00:00.000Z'
      })
      await assertEveryConsumer(LEGACY)
    }
  )
})
