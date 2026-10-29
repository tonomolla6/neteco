import { describe, expect, it } from 'vitest'
import { parseCatalogTypedFilters, serializeCatalogTypedFilters } from '../../shared/catalog-typed-attribute-filters'

const first = '0058ca00-0000-4000-8000-000000000001'
const second = '0058ca00-0000-4000-8000-000000000002'

describe('typed catalog filter URL contract', () => {
  it('uses no parameter for an absent or empty selection', () => {
    expect(parseCatalogTypedFilters(undefined)).toEqual({ success: true, data: [] })
    expect(parseCatalogTypedFilters('[]')).toEqual({ success: true, data: [] })
    expect(serializeCatalogTypedFilters([])).toBeUndefined()
  })
  it('round-trips false, zero, list/reference codes and paired quantities without coercion', () => {
    const filters = [
      { definitionId: first, values: [false, 0, 'concentrado', { quantity: 5, unit: 'l' }] },
      { definitionId: second, values: ['0058ca00-0000-4000-8000-000000000010'] }
    ]
    const serialized = serializeCatalogTypedFilters(filters)
    expect(typeof serialized).toBe('string')
    const parsed = parseCatalogTypedFilters(serialized)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('Valid typed filters rejected')
    expect(parsed.data[0]!.values).toEqual(expect.arrayContaining(filters[0]!.values))
    expect(parsed.data[1]!.values).toEqual(filters[1]!.values)
    expect(serializeCatalogTypedFilters(parsed.data)).toBe(serialized)
  })
  it('canonicalizes selection order without merging different quantity/unit pairs or boolean/number tokens', () => {
    const a = [{ definitionId: first, values: [false, 0, { quantity: 5, unit: 'l' }, { quantity: 5, unit: 'kg' }] }]
    const b = [{ definitionId: first, values: [...a[0]!.values].reverse() }]
    expect(serializeCatalogTypedFilters(a)).toBe(serializeCatalogTypedFilters(b))
    const parsed = parseCatalogTypedFilters(serializeCatalogTypedFilters(a))
    expect(parsed.success && parsed.data[0]!.values.length).toBe(4)
  })
  it.each([
    '',
    '{',
    'null',
    '{}',
    JSON.stringify([{ definitionId: first, values: [] }]),
    JSON.stringify([{ definitionId: first, values: [false, false] }]),
    JSON.stringify([
      { definitionId: first, values: [1] },
      { definitionId: first, values: [2] }
    ]),
    JSON.stringify([{ definitionId: first, values: [{ quantity: 1, unit: 'liters' }] }]),
    JSON.stringify([{ definitionId: first, values: [true], revision: 1 }]),
    JSON.stringify([{ definitionId: 'not-a-uuid', values: [true] }]),
    JSON.stringify([{ definitionId: first, values: Array.from({ length: 17 }, (_, n) => n) }]),
    JSON.stringify(
      Array.from({ length: 13 }, (_, n) => ({
        definitionId: `0058ca00-0000-4000-8000-${String(n).padStart(12, '0')}`,
        values: [n]
      }))
    ),
    JSON.stringify([{ definitionId: first, values: ['a'.repeat(4096)] }])
  ])('rejects invalid or over-budget URL input %s', (raw) => {
    expect(parseCatalogTypedFilters(raw)).toEqual({ success: false, code: 'invalid_typed_filters' })
  })
  it('serializes only own dense JSON data and never invokes hostile getters', () => {
    let calls = 0
    const getter = {
      definitionId: first,
      get values() {
        calls++
        return [true]
      }
    }
    expect(() => serializeCatalogTypedFilters([getter])).toThrow('invalid_typed_filters')
    expect(calls).toBe(0)
    expect(() => serializeCatalogTypedFilters(new Array(1))).toThrow('invalid_typed_filters')
    expect(() => serializeCatalogTypedFilters([{ definitionId: first, values: [Infinity] }])).toThrow(
      'invalid_typed_filters'
    )
  })
})
