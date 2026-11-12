import type { CatalogTypedAttributeKind, CatalogTypedAttributeValue } from '../catalog-typed-attributes'

export type UiColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

export interface ProductVisualData {
  type: string
  color: string
}

/**
 * La única variante publicada de un producto de un solo formato. Con ella el listado puede
 * enseñar la referencia y pedir el producto sin pasar por la ficha.
 */
export interface ProductSingleVariant {
  variantId: number
  sku: string
  format: string
  /** Contenido de la unidad de venta (5 para una garrafa de 5 L). */
  units: number
  unitLabel: string
  minimumQuantity: number
  quantityIncrement: number
  maximumQuantity: number | null
  stock: number
  backorderAllowed: boolean
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
  /** Solo en productos de un único formato; ausente o `null` en el resto. */
  single?: ProductSingleVariant | null
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
  /** Productos con existencias vendibles («Solo en stock»), sin aplicar ese mismo filtro. */
  inStock?: number
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
  inStock?: boolean
}

export type CatalogQueryParameters = Record<string, string | number | undefined>
