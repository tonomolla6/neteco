import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { splitGross } from '../../server/domain/money'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import worker from '../../workers/canary'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const INSTANT = '2026-08-20T00:00:00Z'
const REASON = 'Versión creada para probar el detalle público'

describe('D1 public product detail', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let slug: string
  let variantId: string

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    applyGeneratedSeed(sqlite, renderD1CategorySeed())
    applyGeneratedSeed(sqlite, renderD1ProductSeed())
    applyGeneratedSeed(sqlite, renderD1InventorySeed())
    database = d1OverSqlite(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: sqlite
        .prepare("SELECT id FROM products WHERE status='published'")
        .all()
        .map((row) => String(row.id)),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const row = sqlite
      .prepare(
        `SELECT p.slug, v.id AS variantId FROM products p JOIN variants v ON v.product_id = p.id
        WHERE p.legacy_id = 1 ORDER BY v.legacy_id LIMIT 1`
      )
      .get() as { slug: string; variantId: string }
    slug = row.slug
    variantId = row.variantId
  })
  afterEach(() => sqlite.close())

  it('matches the Nuxt detail shape with governed price, tax, stock and safe empty documents', async () => {
    const detail = await getPublishedProductDetail(database, slug, { instant: INSTANT })
    expect(detail).not.toBeNull()
    expect(detail).toMatchObject({
      id: 1,
      slug,
      brand: 'NETECO',
      featured: expect.any(Boolean),
      badges: expect.any(Array),
      visual: { type: expect.any(String), color: expect.any(String) },
      attrs: expect.any(Array),
      regulatory: expect.any(Object),
      siblings: expect.any(Array),
      breadcrumb: expect.any(Array),
      related: expect.any(Array),
      documents: []
    })
    expect(detail).not.toHaveProperty('uuid')
    expect(detail!.variants.length).toBeGreaterThan(0)
    const first = detail!.variants[0]!
    expect(first.uuid).toBe(variantId)
    expect(first.priceTiers).toEqual([])
    expect(first.pricingVersion).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.netPrice).toBe(splitGross(first.price, first.taxRateBasisPoints).netCents)
    expect(first.stock).toBeGreaterThan(0)
    expect(detail!.breadcrumb.at(-1)?.slug).toBeDefined()
    expect(detail!.related.every((item) => item.slug !== slug)).toBe(true)
  })

  it('uses the winning price version for all pricing fields and excludes cancelled/future versions', async () => {
    const base = (await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!
    const insert = sqlite.prepare(
      `INSERT INTO variant_price_versions(id, variant_id, gross_cents, compare_at_gross_cents,
        reference_gross_cents_30d, volume_tiers, valid_from, status, reason, created_at,
        cancelled_by, cancelled_at, cancellation_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      'price-detail-current',
      variantId,
      base.price + 200,
      base.price + 400,
      base.price + 300,
      '[{"minimumQuantity":3,"unitGrossCents":100}]',
      '2026-08-19T00:00:00Z',
      'approved',
      REASON,
      '2026-08-19T00:00:00Z',
      null,
      null,
      null
    )
    insert.run(
      'price-detail-future',
      variantId,
      base.price + 500,
      null,
      null,
      '[]',
      '2026-08-21T00:00:00Z',
      'approved',
      REASON,
      '2026-08-19T00:00:00Z',
      null,
      null,
      null
    )
    insert.run(
      'price-detail-cancelled',
      variantId,
      base.price + 700,
      null,
      null,
      '[]',
      '2026-08-20T00:00:00Z',
      'cancelled',
      REASON,
      '2026-08-19T00:00:00Z',
      'test',
      '2026-08-20T00:00:00Z',
      'Cancelación de prueba'
    )
    const current = (await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!
    expect(current).toMatchObject({
      pricingVersion: 'price-detail-current',
      price: base.price + 200,
      compareAtPrice: base.price + 400,
      referencePrice30d: base.price + 300,
      priceTiers: [{ minimumQuantity: 3, unitGrossCents: 100 }]
    })
    expect(current.netPrice).toBe(splitGross(current.price, current.taxRateBasisPoints).netCents)
  })

  it('subtracts active reservations conservatively and hides unpublished products', async () => {
    const initial = (await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!.stock
    const location = sqlite
      .prepare('SELECT location_id AS id FROM inventory_balances WHERE variant_id = ? LIMIT 1')
      .get(variantId) as { id: string }
    sqlite
      .prepare(
        `INSERT INTO inventory_reservations(id, idempotency_key, payload_hash, correlation_id,
          expires_at, created_at, updated_at)
        VALUES ('detail-reserve', 'detail-reserve', ?, 'detail-test', ?, ?, ?)`
      )
      .run('a'.repeat(64), '2026-08-21T00:00:00Z', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z')
    sqlite
      .prepare(
        `INSERT INTO inventory_reservation_lines(reservation_id, variant_id, location_id, quantity)
        VALUES ('detail-reserve', ?, ?, 2)`
      )
      .run(variantId, location.id)
    expect((await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!.stock).toBe(
      initial - 2
    )
    sqlite.prepare("UPDATE products SET status = 'hidden' WHERE slug = ?").run(slug)
    expect(await getPublishedProductDetail(database, slug, { instant: INSTANT })).toBeNull()
    expect(await getPublishedProductDetail(database, '../secret', { instant: INSTANT })).toBeNull()
  })

  it('falls back to the legacy variant price only when no governed version is effective', async () => {
    const original = (await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!
    sqlite.prepare('DELETE FROM variant_price_versions WHERE variant_id = ?').run(variantId)
    const fallback = (await getPublishedProductDetail(database, slug, { instant: INSTANT }))!.variants[0]!
    expect(fallback).toMatchObject({
      pricingVersion: `legacy:${variantId}`,
      price: original.price,
      priceTiers: [],
      referencePrice30d: null
    })
    sqlite
      .prepare("UPDATE variants SET status = 'hidden' WHERE product_id = (SELECT id FROM products WHERE slug = ?)")
      .run(slug)
    expect(await getPublishedProductDetail(database, slug, { instant: INSTANT })).toBeNull()
  })

  it('serves governed public metadata without stale caching and returns private 404', async () => {
    const env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    const response = await worker.fetch(new Request(`https://neteco.invalid/api/products/${slug}`), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    expect(((await response.json()) as { slug: string }).slug).toBe(slug)
    const missing = await worker.fetch(new Request('https://neteco.invalid/api/products/no-existe'), env)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(await missing.json()).toEqual({ error: 'product_not_found' })
  })
})
