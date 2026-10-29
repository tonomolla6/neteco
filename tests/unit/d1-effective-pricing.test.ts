import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  effectiveGrossCentsExpression,
  inlineEffectivePricingSql,
  resolvePricingInstant
} from '../../workers/catalog/pricing'
import { listPublishedProducts } from '../../workers/catalog/products'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const T0 = '2026-08-20T00:00:00Z'
const REASON = 'Versión creada por pruebas de resolución temporal'

function insertVariantBase(database: DatabaseSync) {
  database.prepare("INSERT INTO brands (id, name, slug, status) VALUES ('b1', 'NETECO', 'neteco', 'published')").run()
  database
    .prepare(
      "INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES ('t21', 'ES-GEN-21', 'General 21 %', 2100, '2020-01-01T00:00:00Z')"
    )
    .run()
  database
    .prepare("INSERT INTO shipping_profiles (id, code, name, kind) VALUES ('sp1', 'parcel', 'Parcel', 'parcel')")
    .run()
  database
    .prepare(
      "INSERT INTO categories (id, legacy_id, name, slug, status, sort_order) VALUES ('c1', 7, 'Químicos', 'quimicos', 'published', 7)"
    )
    .run()
}

interface VariantSeed {
  id: string
  productId: string
  sku: string
  grossCents: number
}

function insertProduct(database: DatabaseSync, id: string, legacyId: number, name: string, slug: string) {
  database
    .prepare(
      `INSERT INTO products (id, legacy_id, category_id, name, slug, status)
       VALUES (?, ?, 'c1', ?, ?, 'published')`
    )
    .run(id, legacyId, name, slug)
}

function insertVariant(database: DatabaseSync, seed: VariantSeed, legacyId: number) {
  database
    .prepare(
      `INSERT INTO variants (
         id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents
       ) VALUES (?, ?, ?, 't21', 'sp1', ?, 'Botella 1 L', 'published', ?)`
    )
    .run(seed.id, legacyId, seed.productId, seed.sku, seed.grossCents)
}

function insertVersion(
  database: DatabaseSync,
  options: {
    id: string
    variantId: string
    grossCents: number
    validFrom: string
    validUntil?: string
    status?: 'approved' | 'cancelled'
    createdAt?: string
  }
) {
  const cancelled = options.status === 'cancelled'
  database
    .prepare(
      `INSERT INTO variant_price_versions (
         id, variant_id, gross_cents, volume_tiers, valid_from, valid_until, status,
         reason, created_at, cancelled_at, cancelled_by, cancellation_reason
       ) VALUES (?, ?, ?, '[]', ?, ?, ?, '${REASON}', ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.variantId,
      options.grossCents,
      options.validFrom,
      options.validUntil ?? null,
      options.status ?? 'approved',
      options.createdAt ?? '2026-01-01T00:00:00Z',
      cancelled ? '2026-02-01T00:00:00Z' : null,
      cancelled ? 'staff-1' : null,
      cancelled ? 'Cancelada en pruebas' : null
    )
}

function resolveEffective(database: DatabaseSync, variantId: string, instant: string): number {
  const fragment = inlineEffectivePricingSql(effectiveGrossCentsExpression('target'), instant)
  const row = database
    .prepare(`SELECT ${fragment} AS effective FROM variants target WHERE target.id = ?`)
    .get(variantId) as { effective: number } | undefined
  return Number(row?.effective)
}

describe('D1 price version model on an empty database', () => {
  it('applies every migration cleanly and exposes the governed indexes', async () => {
    const database = await openMigratedDatabase()
    const objects = (
      database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(objects).toEqual(
      expect.arrayContaining([
        'variant_price_versions',
        'variant_price_versions_effective_idx',
        'variant_price_versions_schedule_idx',
        'variant_price_versions_upcoming_idx'
      ])
    )
  })

  it('enforces foreign keys against variants', async () => {
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p1', 101, 'Producto', 'producto')
    insertVariant(database, { id: 'v1', productId: 'p1', sku: 'SKU-1', grossCents: 500 }, 1)
    expect(() =>
      database
        .prepare(
          `INSERT INTO variant_price_versions (
             id, variant_id, gross_cents, valid_from, reason, created_at
           ) VALUES ('pv-x', 'missing-variant', 500, '2026-01-01T00:00:00Z', '${REASON}', '2026-01-01T00:00:00Z')`
        )
        .run()
    ).toThrow()
  })

  it('rejects a reversed window even when mixed timestamp precision would sort its text the other way', async () => {
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p1', 101, 'Producto', 'producto')
    insertVariant(database, { id: 'v1', productId: 'p1', sku: 'SKU-1', grossCents: 500 }, 1)
    expect(() =>
      insertVersion(database, {
        id: 'reversed-window',
        variantId: 'v1',
        grossCents: 600,
        validFrom: '2026-08-20T00:00:00.500Z',
        validUntil: '2026-08-20T00:00:00Z'
      })
    ).toThrow()
  })

  it.each([
    ['non-positive gross', { gross: 0 }],
    ['compare-at not above gross', { compareAt: 500 }],
    ['valid_until equal to valid_from', { validUntil: '2026-01-01T00:00:00Z' }],
    ['unknown status', { status: 'future' }],
    ['volume tiers as object', { volumeTiers: '{"a":1}' }],
    ['too short reason', { reason: 'ab' }],
    ['cancelled without metadata', { status: 'cancelled', skipMetadata: true }],
    ['approved with cancellation metadata', { cancelledMetadataOnApproved: true }]
  ])('rejects %s', async (label, overrides) => {
    void label
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p1', 101, 'Producto', 'producto')
    insertVariant(database, { id: 'v1', productId: 'p1', sku: 'SKU-1', grossCents: 400 }, 1)
    const specific = overrides as {
      gross?: number
      compareAt?: number
      validUntil?: string
      status?: string
      volumeTiers?: string
      reason?: string
      skipMetadata?: boolean
      cancelledMetadataOnApproved?: boolean
    }
    const cancelled = specific.status === 'cancelled'
    const withCancellationMetadata =
      (cancelled || specific.cancelledMetadataOnApproved === true) && specific.skipMetadata !== true
    expect(() =>
      database
        .prepare(
          `INSERT INTO variant_price_versions (
             id, variant_id, gross_cents, compare_at_gross_cents, volume_tiers,
             valid_from, valid_until, status, reason, created_at,
             cancelled_at, cancelled_by, cancellation_reason
           ) VALUES ('pv-bad', 'v1', ?, ?, ?, '2026-01-01T00:00:00Z', ?, ?, ?,
             '2026-01-01T00:00:00Z', ?, ?, ?)`
        )
        .run(
          specific.gross ?? 500,
          specific.compareAt === undefined ? null : specific.compareAt,
          specific.volumeTiers ?? '[]',
          specific.validUntil ?? null,
          specific.status ?? 'approved',
          specific.reason ?? REASON,
          withCancellationMetadata ? '2026-02-01T00:00:00Z' : null,
          withCancellationMetadata ? 'staff-1' : null,
          withCancellationMetadata ? 'Motivo suficiente' : null
        )
    ).toThrow()
  })

  it.each([
    [
      'invalid valid_from text',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, reason, created_at)
       VALUES ('pv-date', 'v1', 500, 'banana', '${REASON}', '2026-01-01T00:00:00Z')`
    ],
    [
      'impossible valid_from date',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, reason, created_at)
       VALUES ('pv-date', 'v1', 500, '2026-02-30T00:00:00Z', '${REASON}', '2026-01-01T00:00:00Z')`
    ],
    [
      'out-of-range valid_from components',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, reason, created_at)
       VALUES ('pv-date', 'v1', 500, '2026-99-99T00:00:00Z', '${REASON}', '2026-01-01T00:00:00Z')`
    ],
    [
      'non-canonical valid_until offset',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, valid_until, reason, created_at)
       VALUES ('pv-date', 'v1', 500, '2026-01-01T00:00:00Z',
               '2026-02-01T00:00:00+00:00', '${REASON}', '2026-01-01T00:00:00Z')`
    ],
    [
      'invalid created_at text',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, reason, created_at)
       VALUES ('pv-date', 'v1', 500, '2026-01-01T00:00:00Z', '${REASON}', 'also-banana')`
    ],
    [
      'invalid cancelled_at text',
      `INSERT INTO variant_price_versions
       (id, variant_id, gross_cents, valid_from, status, reason, created_at,
        cancelled_at, cancelled_by, cancellation_reason)
       VALUES ('pv-date', 'v1', 500, '2026-01-01T00:00:00Z', 'cancelled', '${REASON}',
               '2026-01-01T00:00:00Z', 'not-a-date', 'staff-1', 'Cancelación de prueba')`
    ]
  ])('rejects %s so textual ordering remains chronological', async (_label, statement) => {
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p1', 101, 'Producto', 'producto')
    insertVariant(database, { id: 'v1', productId: 'p1', sku: 'SKU-1', grossCents: 400 }, 1)

    expect(() => database.exec(statement)).toThrow()
  })

  it('accepts both canonical UTC seconds and millisecond precision', async () => {
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p1', 101, 'Producto', 'producto')
    insertVariant(database, { id: 'v1', productId: 'p1', sku: 'SKU-1', grossCents: 400 }, 1)

    expect(() =>
      database.exec(`INSERT INTO variant_price_versions
        (id, variant_id, gross_cents, valid_from, valid_until, reason, created_at)
        VALUES ('pv-date', 'v1', 500, '2026-01-01T00:00:00Z',
                '2026-02-01T00:00:00.123Z', '${REASON}', '2026-01-01T00:00:00.001Z')`)
    ).not.toThrow()
  })
})

describe('D1 deterministic effective pricing', () => {
  async function seededCatalog() {
    const database = await openMigratedDatabase()
    insertVariantBase(database)
    insertProduct(database, 'p-act', 101, 'Jabón concentrado activo', 'jabon-concentrado-activo')
    insertProduct(database, 'p-mix', 102, 'Set de limpieza profesional', 'set-limpieza-profesional')
    insertProduct(database, 'p-high', 103, 'Cubo industrial premium', 'cubo-industrial-premium')

    const variants = [
      { id: 'v-act', productId: 'p-act', sku: 'ACT-1', grossCents: 423 },
      { id: 'v-old', productId: 'p-mix', sku: 'MIX-1', grossCents: 900 },
      { id: 'v-sched', productId: 'p-mix', sku: 'MIX-2', grossCents: 930 },
      { id: 'v-bound', productId: 'p-mix', sku: 'MIX-3', grossCents: 940 },
      { id: 'v-high', productId: 'p-high', sku: 'HIGH-1', grossCents: 1999 }
    ] as const
    variants.forEach((variant, index) => insertVariant(database, { ...variant }, index + 1))

    // v-old: live governed version below the legacy base.
    insertVersion(database, { id: 'pv-old', variantId: 'v-old', grossCents: 600, validFrom: '2026-01-01T00:00:00Z' })
    // v-sched: expired window, cancelled open window and a future tie pair.
    insertVersion(database, {
      id: 'pv-exp',
      variantId: 'v-sched',
      grossCents: 200,
      validFrom: '2026-06-01T00:00:00Z',
      validUntil: '2026-07-01T00:00:00Z'
    })
    insertVersion(database, {
      id: 'pv-can',
      variantId: 'v-sched',
      grossCents: 150,
      validFrom: '2026-05-01T00:00:00Z',
      status: 'cancelled'
    })
    insertVersion(database, { id: 'tie-a', variantId: 'v-sched', grossCents: 800, validFrom: '2027-01-01T00:00:00Z' })
    insertVersion(database, { id: 'tie-z', variantId: 'v-sched', grossCents: 700, validFrom: '2027-01-01T00:00:00Z' })
    // v-bound: end boundary is exclusive, start boundary is inclusive.
    insertVersion(database, {
      id: 'pv-endb',
      variantId: 'v-bound',
      grossCents: 220,
      validFrom: '2026-07-01T00:00:00Z',
      validUntil: T0
    })
    insertVersion(database, { id: 'pv-startb', variantId: 'v-bound', grossCents: 300, validFrom: T0 })

    await provisionPublicationValidityFixture(d1OverSqlite(database), {
      productIds: ['p-act', 'p-mix', 'p-high'],
      now: '2020-01-01T00:00:00Z'
    })
    return { database, variants }
  }

  it('selects temporal windows with exact boundaries, exclusions and fallback', async () => {
    const { database } = await seededCatalog()

    // At T0: fallback, live version, future/expired/cancelled ignored, inclusive start.
    expect(resolveEffective(database, 'v-act', T0)).toBe(423)
    expect(resolveEffective(database, 'v-old', T0)).toBe(600)
    expect(resolveEffective(database, 'v-sched', T0)).toBe(930)
    expect(resolveEffective(database, 'v-bound', T0)).toBe(300)
    // Expired version governs inside its window only.
    expect(resolveEffective(database, 'v-sched', '2026-06-15T00:00:00Z')).toBe(200)
    expect(resolveEffective(database, 'v-sched', '2026-06-30T23:59:59Z')).toBe(200)
    expect(resolveEffective(database, 'v-sched', '2026-07-01T00:00:00Z')).toBe(930)
    // created_at wins before id when valid_from ties.
    insertVersion(database, {
      id: 'tie-0-newer',
      variantId: 'v-sched',
      grossCents: 650,
      validFrom: '2027-01-01T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z'
    })
    expect(resolveEffective(database, 'v-sched', '2027-01-01T12:00:00Z')).toBe(650)
    database.prepare("DELETE FROM variant_price_versions WHERE id = 'tie-0-newer'").run()
    // Greatest id wins when valid_from and created_at both tie.
    expect(resolveEffective(database, 'v-sched', '2027-01-01T12:00:00Z')).toBe(700)
    expect(resolveEffective(database, 'v-sched', '2027-01-01T12:00:00Z')).toBe(700)
  })

  it('orders second and millisecond timestamps chronologically at the same-second boundary', async () => {
    const { database } = await seededCatalog()
    insertVersion(database, {
      id: 'mixed-seconds',
      variantId: 'v-act',
      grossCents: 500,
      validFrom: '2026-08-20T00:00:00Z',
      validUntil: '2026-08-20T00:00:00.500Z',
      createdAt: '2026-08-20T00:00:00Z'
    })
    insertVersion(database, {
      id: 'mixed-millis',
      variantId: 'v-act',
      grossCents: 600,
      validFrom: '2026-08-20T00:00:00.500Z',
      validUntil: '2026-08-20T00:00:00.750Z',
      createdAt: '2026-08-20T00:00:00.001Z'
    })
    expect(resolveEffective(database, 'v-act', '2026-08-20T00:00:00Z')).toBe(500)
    expect(resolveEffective(database, 'v-act', '2026-08-20T00:00:00.499Z')).toBe(500)
    expect(resolveEffective(database, 'v-act', '2026-08-20T00:00:00.500Z')).toBe(600)
    expect(resolveEffective(database, 'v-act', '2026-08-20T00:00:00.749Z')).toBe(600)
    expect(resolveEffective(database, 'v-act', '2026-08-20T00:00:00.750Z')).toBe(423)
  })

  it('exposes effective prices through the public catalog contract without N+1 queries', async () => {
    const { database } = await seededCatalog()
    const result = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 1, limit: 10, sort: 'price_asc' },
      { instant: T0 }
    )

    expect(result?.total).toBe(3)
    expect(result?.items.map((item) => item.slug)).toEqual([
      'set-limpieza-profesional',
      'jabon-concentrado-activo',
      'cubo-industrial-premium'
    ])
    expect(result?.items.map((item) => item.minPrice)).toEqual([300, 423, 1999])
    // Net prices derive from the effective gross and the variant tax class (21 % here).
    expect(result?.items.map((item) => item.minNetPrice)).toEqual([248, 350, 1652])
    expect(result?.items.find((item) => item.slug === 'set-limpieza-profesional')?.formats).toBe(3)

    const descending = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 1, limit: 10, sort: 'price_desc' },
      { instant: T0 }
    )
    expect(descending?.items.map((item) => item.minPrice)).toEqual([1999, 423, 300])

    const paginated = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 2, limit: 2, sort: 'price_asc' },
      { instant: T0 }
    )
    expect(paginated).toMatchObject({ total: 3, page: 2, pages: 2 })
    expect(paginated?.items.map((item) => item.slug)).toEqual(['cubo-industrial-premium'])
  })

  it('keeps search and category filtering working over the priced catalog', async () => {
    const { database } = await seededCatalog()
    const hit = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 1, limit: 10, sort: 'default', search: 'jabón' },
      { instant: T0 }
    )
    expect(hit?.total).toBe(1)
    expect(hit?.items[0]?.slug).toBe('jabon-concentrado-activo')

    const miss = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 1, limit: 10, sort: 'default', search: 'zzz-inexistente' },
      { instant: T0 }
    )
    expect(miss?.total).toBe(0)

    const category = await listPublishedProducts(
      d1OverSqlite(database),
      { page: 1, limit: 10, sort: 'default', category: 'quimicos' },
      { instant: T0 }
    )
    expect(category?.total).toBe(3)
  })

  it('pins the evaluation instant server-side only', () => {
    expect(resolvePricingInstant({ instant: T0 })).toBe(T0)
    expect(resolvePricingInstant()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(() => resolvePricingInstant({ instant: "2026-08-20'; DROP TABLE variants;--" })).toThrow()
    expect(() => resolvePricingInstant({ instant: '2026-02-30T00:00:00Z' })).toThrow()
    expect(() => resolvePricingInstant({ instant: '2026-08-20T00:00:00+00:00' })).toThrow()
    expect(() => inlineEffectivePricingSql(effectiveGrossCentsExpression('v'), 'not-a-date')).toThrow()
  })
})
