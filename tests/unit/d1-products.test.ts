import { describe, expect, it, vi } from 'vitest'
import { listPublishedProducts } from '../../workers/catalog/products'

const PINNED_INSTANT = '2026-08-20T00:00:00Z'
const COMPARABLE_INSTANT = '2026-08-20T00:00:00.000Z'

function database(
  options: { categoryExists?: boolean; total?: number; productId?: string; productIds?: string[] } = {}
) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      parameters: [] as unknown[],
      bind(...parameters: unknown[]) {
        this.parameters = parameters
        statements.push(this)
        return this
      },
      first: vi
        .fn()
        .mockResolvedValue(
          sql.includes('AS variantsValid') && sql.includes('AS mediaValid')
            ? { valid: 1, variantsValid: 0, mediaValid: 0 }
            : options.categoryExists === false
              ? null
              : { id: 'category-id' }
        ),
      all: vi.fn().mockResolvedValue({ results: [] })
    }
    return statement
  })
  const batch = vi.fn(async (queries: Array<{ sql: string }>) =>
    queries.map((query) => ({
      success: true,
      results: query.sql.includes('SELECT count(*) AS total')
        ? [{ total: options.total ?? 1 }]
        : query.sql.includes('page_products AS MATERIALIZED')
          ? (options.productIds ?? [options.productId ?? 'product-id']).map((uuid) => ({
              uuid,
              id: 1,
              name: 'Guante de nitrilo',
              slug: 'guante-de-nitrilo',
              brand: 'NETECO',
              badgesJson: '["Destacado"]',
              visualJson: '{"type":"caja","color":"#2563eb"}',
              image: null,
              featured: 1,
              shortDesc: 'Guante profesional',
              categoryId: 105,
              minPrice: 423,
              minNetPrice: 350,
              compareAtPrice: null,
              formats: 5
            }))
          : query.sql.includes('typed_fixed_products') || options.categoryExists === false
            ? []
            : [{ id: 'category-id' }]
    }))
  )
  return { database: { prepare, batch } as unknown as D1Database, statements, batch }
}

describe('D1 product read model', () => {
  it('materializes bounded search independently before every public authority and facet aggregate', async () => {
    const fixture = database()
    await listPublishedProducts(
      fixture.database,
      { page: 1, limit: 50, sort: 'default', search: 'TypedProofSynthetic', facets: true },
      { instant: PINNED_INSTANT }
    )
    const queries = fixture.statements.filter((statement) => statement.sql.includes('variant_summary'))
    // count + page + 11 facets (including «Solo en stock») + typed facets
    expect(queries).toHaveLength(14)
    for (const { sql } of queries) {
      expect(sql).toContain('search_terms AS MATERIALIZED')
      expect(sql).toContain('search_products AS MATERIALIZED')
      expect(sql).toContain('p.id IN (SELECT product_id FROM search_products)')
    }
    expect(fixture.batch).toHaveBeenCalledOnce()
  })
  it('preserves the legacy bounded public page identity payload limit of 256 KiB', async () => {
    const productIds = Array.from({ length: 1000 }, (_, index) => '😀'.repeat(98) + String(index).padStart(4, '0'))
    expect(productIds.every((id) => id.length === 200)).toBe(true)
    const fixture = database({ productIds })
    const outcome = await listPublishedProducts(fixture.database, { page: 1, limit: 1000, sort: 'default' }).then(
      () => null,
      (error: Error) => error.message
    )
    expect(outcome).toBe('invalid_publication_validity_ids')
  })
  it.each(['', 'x'.repeat(201), 'product\u0000id', 'product\u007fid'])(
    'preserves the legacy bounded public page identity validation for %j',
    async (productId) => {
      const fixture = database({ productId })
      await expect(listPublishedProducts(fixture.database, { page: 1, limit: 24, sort: 'default' })).rejects.toThrow(
        'invalid_media_product_ids'
      )
    }
  )
  it('returns the existing public contract with parsed JSON and stable pagination', async () => {
    const fixture = database({ total: 25 })
    const result = await listPublishedProducts(
      fixture.database,
      { page: 2, limit: 24, sort: 'price_asc' },
      { instant: PINNED_INSTANT }
    )

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          uuid: 'product-id',
          badges: ['Destacado'],
          visual: { type: 'caja', color: '#2563eb' },
          featured: true,
          minPrice: 423,
          minNetPrice: 350,
          formats: 5
        })
      ],
      total: 25,
      page: 2,
      pages: 2
    })
    expect(fixture.batch).toHaveBeenCalledOnce()
    const list = fixture.statements.find((statement) => statement.sql.includes('ORDER BY summary.minPrice ASC'))
    expect(list?.sql).toContain('ORDER BY summary.minPrice ASC, lower(p.name), p.id')
    expect(list?.parameters.slice(-2)).toEqual([24, 24])
    const media = fixture.statements.find((statement) => statement.sql.includes('ORDER BY CASE role'))
    expect(media?.sql).toContain('media_publications')
    expect(media).toBe(list)
    expect(media?.parameters[0]).toBe(COMPARABLE_INSTANT)
    expect(media?.sql).toContain('page_media AS MATERIALIZED')
    expect(media?.sql).toContain('media_rights_decisions')
    expect(media?.sql).toContain('media_scan_receipts')
    expect(media?.sql).toContain('eligible.variant_id IS NULL')
    expect(fixture.statements).toHaveLength(2)
  })

  it('resolves prices against governed versions with the pinned instant bound before filters', async () => {
    const fixture = database()
    await listPublishedProducts(fixture.database, { page: 1, limit: 24, sort: 'default' }, { instant: PINNED_INSTANT })

    for (const statement of fixture.statements.filter((statement) =>
      statement.sql.includes('variant_price_versions')
    )) {
      expect(statement.sql).toContain('variant_price_versions')
      expect(statement.parameters.slice(0, 2)).toEqual([COMPARABLE_INSTANT, COMPARABLE_INSTANT])
    }
  })

  it('never lets the client choose the pricing instant', async () => {
    const fixture = database()
    await listPublishedProducts(fixture.database, { page: 1, limit: 24, sort: 'default' })

    for (const statement of fixture.statements.filter((statement) =>
      statement.sql.includes('variant_price_versions')
    )) {
      const [from, until] = statement.parameters.slice(0, 2) as [string, string]
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
      expect(until).toBe(from)
    }
  })

  it('returns null for an unknown published category in the same listing snapshot', async () => {
    const fixture = database({ categoryExists: false })
    const result = await listPublishedProducts(
      fixture.database,
      { category: 'no-existe', page: 1, limit: 24, sort: 'default' },
      { instant: PINNED_INSTANT }
    )

    expect(result).toBeNull()
    expect(fixture.batch).toHaveBeenCalledOnce()
    expect(fixture.batch.mock.calls[0]![0]).toHaveLength(3)
  })

  it('uses parameterized FTS5 and LIKE fallbacks for user search text', async () => {
    const fixture = database()
    await listPublishedProducts(
      fixture.database,
      { search: 'nítrilo azul', page: 1, limit: 10, sort: 'name' },
      { instant: PINNED_INSTANT }
    )

    expect(fixture.statements[0]?.parameters).toEqual([
      COMPARABLE_INSTANT,
      COMPARABLE_INSTANT,
      COMPARABLE_INSTANT,
      COMPARABLE_INSTANT,
      JSON.stringify([{ term: 'nitrilo azul', match: '"nitrilo"* AND "azul"*', pattern: '%nitrilo azul%' }]),
      'nitrilo azul',
      PINNED_INSTANT,
      PINNED_INSTANT
    ])
    expect(fixture.statements[0]?.sql).toContain('products_fts MATCH search_term.fts')
    expect(fixture.statements[0]?.sql).not.toContain('nítrilo azul')
    expect(fixture.batch).toHaveBeenCalledOnce()
  })
})
