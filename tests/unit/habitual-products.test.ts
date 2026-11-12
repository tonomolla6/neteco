import { describe, expect, it } from 'vitest'
import { rankHabitualLines } from '../../shared/habitual-products'

const line = (variantId: number | null, quantity: number, overrides = {}) => ({
  sku: `REF-${variantId}`,
  name: `Producto ${variantId}`,
  format: 'Caja',
  quantity,
  unitGross: 1210,
  variantId,
  slug: `producto-${variantId}`,
  image: null,
  visual: null,
  available: true,
  ...overrides
})

describe('habitual products from the customer own orders', () => {
  it('ranks by how many orders contain the reference, then by recency, with the usual quantity', () => {
    const habituals = rankHabitualLines([
      { orderedAt: '2026-10-03T10:00:00Z', lines: [line(1, 4), line(2, 2)] },
      { orderedAt: '2026-09-01T10:00:00Z', lines: [line(1, 4), line(3, 1)] },
      { orderedAt: '2026-08-01T10:00:00Z', lines: [line(1, 6), line(3, 1), line(2, 2)] }
    ])
    expect(habituals.map((item) => [item.variantId, item.timesOrdered, item.usualQuantity])).toEqual([
      [1, 3, 4],
      [2, 2, 2],
      [3, 2, 1]
    ])
    expect(habituals[0]).toMatchObject({ sku: 'REF-1', lastOrderedAt: '2026-10-03T10:00:00Z', lastQuantity: 4 })
  })

  it('skips lines that can no longer be ordered and respects the limit', () => {
    const habituals = rankHabitualLines(
      [
        {
          orderedAt: '2026-10-03T10:00:00Z',
          lines: [line(1, 1), line(2, 1, { available: false }), line(null, 1), line(4, 1), line(5, 1)]
        }
      ],
      2
    )
    expect(habituals.map((item) => item.variantId)).toEqual([1, 4])
  })

  it('counts a reference once per order even if it appears in two lines', () => {
    const [habitual] = rankHabitualLines([{ orderedAt: '2026-10-03T10:00:00Z', lines: [line(1, 2), line(1, 3)] }])
    expect(habitual).toMatchObject({ timesOrdered: 1, usualQuantity: 5 })
  })
})
