import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import {
  AGGREGATE_RATING_MIN_REVIEWS,
  buildAggregateRatingJsonLd,
  productReviewSeoSummarySchema
} from '../../shared/review-aggregate'
import { readProductReviewSeoSummary } from '../../workers/catalog/product-review-seo'
import { handleProductReviewsQaHttp } from '../../workers/catalog/product-reviews-qa-http'

const now = '2026-10-29T12:00:00Z'
let sqlite: DatabaseSync | undefined
afterEach(() => {
  sqlite?.close()
  sqlite = undefined
})

async function fixture() {
  sqlite = await openMigratedDatabase()
  seedInventoryFixture(sqlite)
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='product_reviews'").get())
    sqlite.exec(await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = OFF')
  return { sqlite, db: d1OverSqlite(sqlite) }
}
let seq = 0
function review(
  s: DatabaseSync,
  o: Partial<{
    product: string
    rating: number
    status: string
    verified: number
    fraud: string
    consent: number
    customer: string
  }> = {}
) {
  seq++
  s.prepare(
    `INSERT INTO product_reviews(id,product_id,customer_id,rating,title,content,is_verified_buyer,moderation_status,fraud_status,consent_accepted,consent_at,display_name,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    `rev-${seq}`,
    o.product ?? 'p-1',
    o.customer ?? `cust-${seq}`,
    o.rating ?? 5,
    'Titulo de prueba',
    'Contenido de la opinión de prueba suficiente',
    o.verified ?? 1,
    o.status ?? 'approved',
    o.fraud ?? 'clean',
    o.consent ?? 1,
    now,
    'Cliente verificado',
    now,
    now
  )
}
function many(s: DatabaseSync, n: number, rating = 5, extra: Parameters<typeof review>[2] = {}) {
  for (let i = 0; i < n; i++) review(s, { rating, ...extra })
}

describe('SEO-026 AggregateRating from own verified reviews only', () => {
  it('stays hidden below the minimum eligible count', async () => {
    const { sqlite: s, db } = await fixture()
    many(s, AGGREGATE_RATING_MIN_REVIEWS - 1)
    const summary = await readProductReviewSeoSummary(db, 'p-1')
    expect(summary.eligibleCount).toBe(AGGREGATE_RATING_MIN_REVIEWS - 1)
    expect(summary.eligible).toBe(false)
    expect(buildAggregateRatingJsonLd(summary)).toBeNull()
  })
  it('emits aggregateRating exactly at the minimum with matching count and average', async () => {
    const { sqlite: s, db } = await fixture()
    many(s, 3, 5)
    many(s, 2, 4)
    const summary = await readProductReviewSeoSummary(db, 'p-1')
    expect(summary).toMatchObject({ eligibleCount: 5, eligible: true, averageRating: 4.6 })
    expect(summary.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 2, 5: 3 })
    expect(buildAggregateRatingJsonLd(summary)).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.6',
      reviewCount: 5,
      ratingCount: 5,
      bestRating: '5',
      worstRating: '1'
    })
  })
  it.each([
    ['pending', { status: 'pending' }],
    ['rejected', { status: 'rejected' }],
    ['quarantined', { status: 'quarantined' }],
    ['not a verified buyer', { verified: 0 }],
    ['flagged fraud', { fraud: 'flagged' }],
    ['blocked fraud', { fraud: 'blocked' }],
    ['consent revoked', { consent: 0 }]
  ])('does not count %s reviews', async (_name, extra) => {
    const { sqlite: s, db } = await fixture()
    many(s, 5)
    many(s, 3, 1, extra as Parameters<typeof review>[2])
    const summary = await readProductReviewSeoSummary(db, 'p-1')
    expect(summary.eligibleCount).toBe(5)
    expect(summary.averageRating).toBe(5)
  })
  it('excludes self-reviews from staff/merchant identities', async () => {
    const { sqlite: s, db } = await fixture()
    s.exec(`INSERT INTO customers(id,created_at,updated_at) VALUES('staff-cust','${now}','${now}');
      INSERT INTO identities(id,customer_id,email,password_hash,email_verified_at,status,session_version,created_at,updated_at)
      VALUES('id-staff','staff-cust','staff@example.invalid','x','${now}','active',1,'${now}','${now}');
      INSERT INTO roles(code,name,description) VALUES('operator','Op','x');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('id-staff','operator','${now}')`)
    many(s, 5)
    many(s, 4, 1, { customer: 'staff-cust' })
    const summary = await readProductReviewSeoSummary(db, 'p-1')
    expect(summary.eligibleCount).toBe(5)
    expect(summary.averageRating).toBe(5)
  })
  it('does not mix reviews from other products and resolves the legacy numeric id', async () => {
    const { sqlite: s, db } = await fixture()
    many(s, 5, 5, { product: 'p-1' })
    many(s, 6, 1, { product: 'p-2' })
    const legacy = s.prepare("SELECT legacy_id FROM products WHERE id='p-1'").get() as { legacy_id: number }
    const byLegacy = await readProductReviewSeoSummary(db, String(legacy.legacy_id))
    expect(byLegacy.eligibleCount).toBe(5)
    expect((await readProductReviewSeoSummary(db, 'p-2')).averageRating).toBe(1)
  })
  it('returns an empty non-eligible summary for unknown or malformed product refs', async () => {
    const { db } = await fixture()
    expect((await readProductReviewSeoSummary(db, 'nope')).eligibleCount).toBe(0)
    expect((await readProductReviewSeoSummary(db, "x' OR 1=1 --")).eligibleCount).toBe(0)
    expect((await readProductReviewSeoSummary(db, 'a'.repeat(200))).eligible).toBe(false)
  })
  it('exposes the visible policy and validates the DTO shape', async () => {
    const { sqlite: s, db } = await fixture()
    many(s, 5)
    const summary = await readProductReviewSeoSummary(db, 'p-1')
    expect(productReviewSeoSummarySchema.safeParse(summary).success).toBe(true)
    expect(summary.policy.text).toMatch(/compradores verificados/i)
    expect(summary.policy.text).toMatch(/moderad/i)
    expect(productReviewSeoSummarySchema.safeParse({ ...summary, extra: 1 }).success).toBe(false)
  })
  it('never emits markup for a tampered summary that is below the threshold or inconsistent', () => {
    const base = {
      eligibleCount: 2,
      averageRating: 5,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 },
      minimumCount: 5,
      eligible: true,
      policy: { version: 'v', text: 'Texto de política de opiniones verificadas' }
    }
    expect(buildAggregateRatingJsonLd(base)).toBeNull()
    expect(buildAggregateRatingJsonLd({ ...base, eligibleCount: 5, averageRating: 0 })).toBeNull()
    expect(buildAggregateRatingJsonLd({ ...base, eligibleCount: 5, averageRating: 6 })).toBeNull()
    expect(buildAggregateRatingJsonLd({ ...base, eligibleCount: 5, eligible: false })).toBeNull()
  })
  it('serves GET /api/products/:id/reviews/summary publicly, read-only and uncacheable by shared caches', async () => {
    const { sqlite: s, db } = await fixture()
    many(s, 5)
    const ctx = { database: db, now: () => now } as unknown as Parameters<typeof handleProductReviewsQaHttp>[1]
    const ok = await handleProductReviewsQaHttp(new Request('https://x.invalid/api/products/p-1/reviews/summary'), ctx)
    expect(ok!.status).toBe(200)
    expect(ok!.headers.get('Cache-Control')).toBe('no-store')
    expect(productReviewSeoSummarySchema.parse(await ok!.json()).eligibleCount).toBe(5)
    const post = await handleProductReviewsQaHttp(
      new Request('https://x.invalid/api/products/p-1/reviews/summary', { method: 'POST', body: '{}' }),
      ctx
    )
    expect(post!.status).toBe(405)
  })
})
