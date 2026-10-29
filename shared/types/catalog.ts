import type { CatalogTypedAttributeKind, CatalogTypedAttributeValue } from '../catalog-typed-attributes'

export type UiColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export interface ProductVisualData {
  type: string
  color: string
}

export interface ProductCardData {
  id: number
  slug: string
  name: string
  brand: string
  badges: string[]
  visual: ProductVisualData
  image: string | null
  imageAlt?: string | null
  shortDesc?: string | null
  minPrice: number
  minNetPrice: number
  /** Precio anterior de la variante más barata, si lo hay. Permite marcar oferta con su ahorro. */
  compareAtPrice?: number | null
  formats: number
}

export interface ProductSummary extends ProductCardData {
  uuid: string
  categoryId: number
  featured: boolean
}

export interface SearchSuggestion {
  name: string
  slug: string
  brand: string
  visual: ProductVisualData
  image: string | null
  imageAlt?: string | null
  minPrice: number
  minNetPrice: number
  sku: string | null
}

export interface CategoryFlat {
  id: number
  name: string
  slug: string
  parentId: number | null
  sort: number
  count: number
}

export interface CategoryNode extends CategoryFlat {
  children: CategoryNode[]
}

export interface CategoryResponse {
  roots: CategoryNode[]
  flat: CategoryFlat[]
}

export interface FacetValue {
  value: string
  n: number
}

export interface TypedAttributeFilter {
  definitionId: string
  values: Array<Exclude<CatalogTypedAttributeValue, string[]>>
}

export interface TypedAttributeFacet {
  definitionId: string
  categoryId: number
  code: string
  kind: Exclude<CatalogTypedAttributeKind, 'text'>
  label: string
  values: Array<{
    value: Exclude<CatalogTypedAttributeValue, string[]>
    label: string
    n: number
  }>
}

export interface TypedAttributeDetail {
  definitionId: string
  revision: number
  code: string
  kind: CatalogTypedAttributeKind
  label: string
  value: CatalogTypedAttributeValue
  displayValue: string
}

export interface ProductFacets {
  typed?: TypedAttributeFacet[]
  brands: FacetValue[]
  badges: FacetValue[]
  envases: FacetValue[]
  tallas: FacetValue[]
  capacidades: Array<FacetValue & { units: number; label: string }>
  colores: Array<FacetValue & { hex: string | null }>
  medidas: FacetValue[]
  acabados: FacetValue[]
  price: { min: number; max: number } | null
  categories: Array<{ id: number; name: string; slug: string; n: number }>
}

export interface ProductListResponse {
  items: ProductSummary[]
  total: number
  page: number
  pages: number
  facets?: ProductFacets
}

export interface CatalogFilters {
  typed?: TypedAttributeFilter[]
  brands: string[]
  badges: string[]
  envases: string[]
  tallas: string[]
  capacidades: string[]
  colors: string[]
  medidas: string[]
  acabados: string[]
  priceMin: number | null
  priceMax: number | null
}

export type CatalogQueryParameters = Record<string, string | number | undefined>
