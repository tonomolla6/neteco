import { describe, expect, it } from 'vitest'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { PRODUCTS } from '../../server/db/seed'
import { applyGeneratedSeed, openMigratedDatabase } from '../support/d1-sqlite'

const SEED_TIMESTAMP = '2026-08-12T00:00:00Z'

function applyFullSeed(database: Awaited<ReturnType<typeof openMigratedDatabase>>) {
  applyGeneratedSeed(database, renderD1CategorySeed())
  applyGeneratedSeed(database, renderD1ProductSeed())
}

describe('D1 product seed', () => {
  it('renders every demo product and variant deterministically in one transaction', () => {
    const sql = renderD1ProductSeed()
    expect(sql).toBe(renderD1ProductSeed())
    expect(sql.match(/INSERT INTO products/g)).toHaveLength(PRODUCTS.length)
    expect(sql.match(/INSERT INTO variants/g)).toHaveLength(
      PRODUCTS.reduce((sum, product) => sum + product.variants.length, 0)
    )
    expect(sql.startsWith('BEGIN TRANSACTION;')).toBe(true)
    expect(sql.endsWith('COMMIT;\n')).toBe(true)
    expect(sql).not.toContain('undefined')
  })

  it('executes cleanly against a freshly migrated SQLite/D1 base', async () => {
    const database = await openMigratedDatabase()
    applyFullSeed(database)

    const counts = database
      .prepare(
        `SELECT (SELECT count(*) FROM categories) AS categories,
                (SELECT count(*) FROM products) AS products,
                (SELECT count(*) FROM variants) AS variants,
                (SELECT count(*) FROM variant_price_versions) AS priceVersions`
      )
      .get() as { categories: number; products: number; variants: number; priceVersions: number }
    expect(counts.categories).toBeGreaterThan(0)
    expect(counts.products).toBe(PRODUCTS.length)
    expect(counts.variants).toBe(50)
    expect(counts.priceVersions).toBe(50)
  })

  it('seeds one approved initial version per variant matching the legacy base price', async () => {
    const database = await openMigratedDatabase()
    applyFullSeed(database)

    const rows = database
      .prepare(
        `SELECT version.id,
                version.variant_id AS variantId,
                version.gross_cents AS grossCents,
                variant.price_gross_cents AS baseCents,
                version.valid_from AS validFrom,
                version.valid_until AS validUntil,
                version.status,
                version.volume_tiers AS volumeTiers
         FROM variant_price_versions version
         JOIN variants variant ON variant.id = version.variant_id
         ORDER BY version.id`
      )
      .all() as Array<{
      id: string
      variantId: string
      grossCents: number
      baseCents: number
      validFrom: string
      validUntil: string | null
      status: string
      volumeTiers: string
    }>

    const expectedVersions = PRODUCTS.reduce((sum, product) => sum + product.variants.length, 0)
    expect(rows).toHaveLength(expectedVersions)
    expect(new Set(rows.map((row) => row.id)).size).toBe(expectedVersions)
    expect(new Set(rows.map((row) => row.variantId)).size).toBe(expectedVersions)

    for (const row of rows) {
      expect(row.grossCents).toBe(row.baseCents)
      expect(row.validFrom).toBe(SEED_TIMESTAMP)
      expect(row.validUntil).toBeNull()
      expect(row.status).toBe('approved')
      expect(JSON.parse(row.volumeTiers)).toEqual([])
    }
  })

  it('re-applies idempotently without duplicating versions or changing prices', async () => {
    const database = await openMigratedDatabase()
    applyFullSeed(database)

    const before = database.prepare('SELECT id, gross_cents FROM variant_price_versions ORDER BY id').all()
    applyGeneratedSeed(database, renderD1ProductSeed())
    const after = database.prepare('SELECT id, gross_cents FROM variant_price_versions ORDER BY id').all()

    expect(after).toEqual(before)
    expect(after).toHaveLength(50)
  })

  it('restores a demo initial version to its canonical approved state', async () => {
    const database = await openMigratedDatabase()
    applyFullSeed(database)
    const first = database.prepare('SELECT id FROM variant_price_versions ORDER BY id LIMIT 1').get() as { id: string }
    database
      .prepare(
        `UPDATE variant_price_versions
         SET status = 'cancelled', cancelled_by = 'test-auditor',
             cancelled_at = '2026-08-13T00:00:00Z', cancellation_reason = 'Cancelación temporal de prueba'
         WHERE id = ?`
      )
      .run(first.id)

    applyGeneratedSeed(database, renderD1ProductSeed())

    expect(
      database
        .prepare(
          `SELECT status, cancelled_by AS cancelledBy, cancelled_at AS cancelledAt,
                  cancellation_reason AS cancellationReason
           FROM variant_price_versions WHERE id = ?`
        )
        .get(first.id)
    ).toEqual({ status: 'approved', cancelledBy: null, cancelledAt: null, cancellationReason: null })
  })
})
