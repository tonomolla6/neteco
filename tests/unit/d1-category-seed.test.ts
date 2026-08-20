import { describe, expect, it } from 'vitest'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { CATEGORIES } from '../../server/db/seed'

describe('D1 category seed', () => {
  it('is deterministic, transactional and contains every source category once', () => {
    const first = renderD1CategorySeed()
    const second = renderD1CategorySeed()

    expect(first).toBe(second)
    expect(first.startsWith('BEGIN TRANSACTION;')).toBe(true)
    expect(first.endsWith('COMMIT;\n')).toBe(true)
    expect(first.match(/INSERT INTO categories/g)).toHaveLength(CATEGORIES.length)
    expect(first).not.toContain('undefined')
  })

  it('orders every child after its parent so foreign keys can stay enabled', () => {
    const indexes = new Map(CATEGORIES.map(([id], index) => [id, index]))
    for (const [id, _name, parent] of CATEGORIES) {
      if (parent !== null) expect(indexes.get(parent), `parent of category ${id}`).toBeLessThan(indexes.get(id)!)
    }
  })
})
