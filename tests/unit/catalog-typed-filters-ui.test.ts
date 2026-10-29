import { describe, expect, it } from 'vitest'
import {
  catalogTypedPills,
  catalogTypedQuery,
  countCatalogTypedSelections,
  hasCatalogTypedFacets,
  readCatalogTypedRouteValue,
  removeCatalogTypedSelection
} from '../../app/utils/catalog-typed-filters'
import type { TypedAttributeFacet, TypedAttributeFilter } from '../../shared/types/catalog'

const A = 'c1000000-0000-4000-8000-000000000007',
  B = 'c2000000-0000-4000-8000-000000000007'
const selections = (): TypedAttributeFilter[] => [
  { definitionId: A, values: [false, 0] },
  { definitionId: B, values: [{ quantity: 0, unit: 'ml' }, 'blue'] }
]
const facets = (): TypedAttributeFacet[] => [
  {
    definitionId: A,
    categoryId: 7,
    code: 'number',
    kind: 'number',
    label: 'Misma etiqueta',
    values: [{ value: 0, label: '<b>Cero</b>', n: 2 }]
  },
  {
    definitionId: B,
    categoryId: 8,
    code: 'volume',
    kind: 'unit',
    label: 'Misma etiqueta',
    values: [{ value: { quantity: 0, unit: 'ml' }, label: 'Cero ml', n: 1 }]
  }
]

describe('typed catalogue UI route state', () => {
  it('round-trips shareable initial, back and forward state with exact false/zero/unit/list values', () => {
    const initial = selections(),
      firstUrl = catalogTypedQuery(initial)
    expect(typeof firstUrl).toBe('string')
    const initialState = readCatalogTypedRouteValue(firstUrl)
    expect(initialState).toEqual(
      expect.arrayContaining(initial.map((entry) => ({ ...entry, values: expect.arrayContaining(entry.values) })))
    )
    const edited = removeCatalogTypedSelection(initialState, A, false),
      nextUrl = catalogTypedQuery(edited)
    expect(readCatalogTypedRouteValue(firstUrl)).toEqual(initialState)
    expect(readCatalogTypedRouteValue(nextUrl)).toEqual(edited)
    expect(initial[0]!.values).toEqual([false, 0])
    expect(readCatalogTypedRouteValue(undefined)).toEqual([])
    expect(catalogTypedQuery([])).toBeUndefined()
  })
  it.each([
    null,
    '',
    ['[]'],
    ['[]', '[]'],
    42,
    '{',
    'null',
    '{}',
    '[{"definitionId":"bad","values":[false]}]',
    JSON.stringify([{ definitionId: A, values: [null] }]),
    JSON.stringify([{ definitionId: A, values: [false, false] }])
  ])('rejects malformed or repeated route query %j as explicit 400, never broadening results', (raw) => {
    expect(() => readCatalogTypedRouteValue(raw)).toThrow(
      expect.objectContaining({ statusCode: 400, statusMessage: 'Filtros de atributos no válidos' })
    )
  })
  it('rejects oversized or duplicate-definition route filters and invalid outgoing state', () => {
    const duplicate = [
      { definitionId: A, values: [false] },
      { definitionId: A, values: [0] }
    ]
    for (const raw of [
      JSON.stringify(duplicate),
      ' '.repeat(4097),
      JSON.stringify([{ definitionId: A, values: Array.from({ length: 17 }, (_, n) => n) }])
    ])
      expect(() => readCatalogTypedRouteValue(raw)).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => catalogTypedQuery(duplicate)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
  it('counts selections rather than attributes and returns zero after explicit reset', () => {
    expect(countCatalogTypedSelections(selections())).toBe(4)
    expect(countCatalogTypedSelections(undefined)).toBe(0)
    expect(countCatalogTypedSelections([])).toBe(0)
  })
  it('creates removable pills using stable IDs and exact values, never mutable labels', () => {
    const input = selections(),
      before = structuredClone(input),
      pills = catalogTypedPills(input, facets())
    expect(pills).toHaveLength(4)
    expect(pills.find((pill) => pill.definitionId === A && pill.value === 0)?.label).toContain('<b>Cero</b>')
    expect(pills.find((pill) => pill.definitionId === B && typeof pill.value === 'object')?.label).toContain('Cero ml')
    const next = removeCatalogTypedSelection(input, A, 0)
    expect(next.find((entry) => entry.definitionId === A)?.values).toEqual([false])
    expect(input).toEqual(before)
    const pairRemoved = removeCatalogTypedSelection(input, B, { unit: 'ml', quantity: 0 })
    expect(pairRemoved.find((entry) => entry.definitionId === B)?.values).toEqual(['blue'])
  })
  it('keeps pills removable when their facet disappears or changes label', () => {
    const input: TypedAttributeFilter[] = [{ definitionId: A, values: [false] }]
    const pill = catalogTypedPills(input, [])[0]!
    expect(pill.definitionId).toBe(A)
    expect(pill.value).toBe(false)
    expect(pill.label.length).toBeGreaterThan(0)
    expect(removeCatalogTypedSelection(input, pill.definitionId, pill.value)).toEqual([])
  })
  it('shows a dynamic-only filter panel only for options with positive results', () => {
    expect(hasCatalogTypedFacets(facets())).toBe(true)
    expect(hasCatalogTypedFacets(undefined)).toBe(false)
    expect(hasCatalogTypedFacets([])).toBe(false)
    expect(
      hasCatalogTypedFacets(
        facets().map((facet) => ({ ...facet, values: facet.values.map((value) => ({ ...value, n: 0 })) }))
      )
    ).toBe(false)
  })
})
