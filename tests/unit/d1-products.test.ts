import { describe, expect, it, vi } from 'vitest'
import { listPublishedProducts } from '../../workers/catalog/products'

function database(options: { categoryExists?: boolean; total?: number } = {}) {
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
      first: vi.fn().mockResolvedValue(options.categoryExists === false ? null : { id: 'category-id' })
    }
    return statement
  })
  const batch = vi.fn().mockResolvedValue([
    { results: [{ total: options.total ?? 1 }], success: true },
    {
      results: [
        {
          uuid: 'product-id',
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
          formats: 5
        }
      ],
      success: true
    }
  ])
  return { database: { prepare, batch } as unknown as D1Database, statements, batch }
}

describe('D1 product read model', () => {
  it('returns the existing public contract with parsed JSON and stable pagination', async () => {
    const fixture = database({ total: 25 })
    const result = await listPublishedProducts(fixture.database, {
      page: 2,
      limit: 24,
      sort: 'price_asc'
    })

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
    expect(fixture.statements.at(-1)?.sql).toContain('ORDER BY summary.minPrice ASC, lower(p.name), p.id')
    expect(fixture.statements.at(-1)?.parameters.slice(-2)).toEqual([24, 24])
  })

  it('returns null for an unknown published category before listing products', async () => {
    const fixture = database({ categoryExists: false })
    const result = await listPublishedProducts(fixture.database, {
      category: 'no-existe',
      page: 1,
      limit: 24,
      sort: 'default'
    })

    expect(result).toBeNull()
    expect(fixture.batch).not.toHaveBeenCalled()
  })

  it('uses parameterized FTS5 and LIKE fallbacks for user search text', async () => {
    const fixture = database()
    await listPublishedProducts(fixture.database, {
      search: 'nítrilo azul',
      page: 1,
      limit: 10,
      sort: 'name'
    })

    expect(fixture.statements[0]?.parameters).toEqual([
      '"nítrilo"* AND "azul"*',
      '%nítrilo azul%',
      '%nítrilo azul%',
      '%nítrilo azul%'
    ])
    expect(fixture.statements[0]?.sql).toContain('products_fts MATCH ?')
  })
})
