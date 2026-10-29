import type { TypedAttributeFacet, TypedAttributeFilter } from '~~/shared/types/catalog'
import { parseCatalogTypedFilters, serializeCatalogTypedFilters } from '~~/shared/catalog-typed-attribute-filters'

export type TypedCatalogSelection = TypedAttributeFilter['values'][number]
export interface TypedCatalogPill {
  definitionId: string
  value: TypedCatalogSelection
  label: string
}

function invalidRoute() {
  return Object.assign(new Error('Filtros de atributos no válidos'), {
    statusCode: 400,
    statusMessage: 'Filtros de atributos no válidos',
    fatal: true
  })
}
export function readCatalogTypedRouteValue(raw: unknown): TypedAttributeFilter[] {
  if (raw !== undefined && typeof raw !== 'string') throw invalidRoute()
  const parsed = parseCatalogTypedFilters(raw)
  if (!parsed.success) throw invalidRoute()
  return parsed.data
}
export function catalogTypedQuery(filters: unknown): string | undefined {
  try {
    return serializeCatalogTypedFilters(filters)
  } catch {
    throw invalidRoute()
  }
}
export function countCatalogTypedSelections(filters: readonly TypedAttributeFilter[] | undefined): number {
  return (filters ?? []).reduce((count, filter) => count + filter.values.length, 0)
}
function valueKey(value: TypedCatalogSelection): string {
  return typeof value === 'object'
    ? JSON.stringify({ quantity: value.quantity, unit: value.unit })
    : JSON.stringify(value)
}
function display(value: TypedCatalogSelection): string {
  return typeof value === 'object'
    ? `${value.quantity} ${value.unit}`
    : typeof value === 'boolean'
      ? value
        ? 'Sí'
        : 'No'
      : String(value)
}
export function catalogTypedPills(
  filters: readonly TypedAttributeFilter[] | undefined,
  facets?: readonly TypedAttributeFacet[]
): TypedCatalogPill[] {
  return (filters ?? []).flatMap((filter) => {
    const facet = facets?.find((item) => item.definitionId === filter.definitionId)
    return filter.values.map((value) => ({
      definitionId: filter.definitionId,
      value: typeof value === 'object' ? { ...value } : value,
      label: `${facet?.label ?? filter.definitionId}: ${facet?.values.find((item) => valueKey(item.value) === valueKey(value))?.label ?? display(value)}`
    }))
  })
}
export function removeCatalogTypedSelection(
  filters: readonly TypedAttributeFilter[],
  definitionId: string,
  value: TypedCatalogSelection
): TypedAttributeFilter[] {
  return readCatalogTypedRouteValue(
    catalogTypedQuery(
      filters
        .map((filter) => ({
          definitionId: filter.definitionId,
          values: filter.values.filter(
            (item) => filter.definitionId !== definitionId || valueKey(item) !== valueKey(value)
          )
        }))
        .filter((filter) => filter.values.length)
    )
  )
}
export function hasCatalogTypedFacets(facets: readonly TypedAttributeFacet[] | undefined): boolean {
  return facets?.some((facet) => facet.values.some((value) => value.n > 0)) ?? false
}
