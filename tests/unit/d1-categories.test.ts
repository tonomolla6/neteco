import { describe, expect, it, vi } from 'vitest'
import { listPublishedCategories, type CategoryRow } from '../../workers/catalog/categories'

function database(rows: CategoryRow[]) {
  return {
    prepare: vi.fn(() => ({ all: vi.fn().mockResolvedValue({ results: rows }) }))
  } as unknown as D1Database
}

describe('D1 category read model', () => {
  it('builds the public tree and rolls product totals into every ancestor', async () => {
    const result = await listPublishedCategories(
      database([
        { id: 7, name: 'Productos químicos', slug: 'productos-quimicos', parentId: null, sort: 7, directCount: 2 },
        { id: 11, name: 'Desengrasantes', slug: 'desengrasantes', parentId: 7, sort: 11, directCount: 3 }
      ])
    )

    expect(result.roots).toEqual([
      {
        id: 7,
        name: 'Productos químicos',
        slug: 'productos-quimicos',
        parentId: null,
        sort: 7,
        count: 5,
        children: [
          {
            id: 11,
            name: 'Desengrasantes',
            slug: 'desengrasantes',
            parentId: 7,
            sort: 11,
            count: 3,
            children: []
          }
        ]
      }
    ])
    expect(result.flat).toEqual([
      expect.objectContaining({ id: 7, count: 5 }),
      expect.objectContaining({ id: 11, count: 3 })
    ])
  })
})
