import { splitGross } from '../../server/domain/money'
import { sellableExpression } from './inventory'
import { readPublicProductMedia } from '../media/public-catalog'
import { assertCurrentTypedAttributes, type TypedAttributeObservation } from './typed-attribute-facets'
import {
  publicationValidityWithClock,
  assertCurrentPublicationValidity,
  publicMediaProjectionIds
} from './publication-validity'
import {
  effectiveGovernedVersionIdExpression,
  parameterizeEffectivePricingSql,
  resolvePricingInstant,
  type EffectivePricingOptions
} from './pricing'
import {
  CATALOG_TYPED_ATTRIBUTE_UNITS,
  type CatalogTypedAttributeKind,
  type CatalogTypedAttributeUnit,
  type CatalogTypedAttributeValue
} from '../../shared/catalog-typed-attributes'
import { typedAttributeEntryValiditySql, typedAttributeNamespaceValiditySql } from './typed-attribute-sql'

export class InvalidCompareRequestError extends Error {
  readonly code = 'invalid_compare_request'
  constructor(message = 'invalid_compare_request') {
    super(message)
    this.name = 'InvalidCompareRequestError'
  }
}

export class CompareProductNotFoundError extends Error {
  readonly code = 'product_not_found'
  constructor(message = 'product_not_found') {
    super(message)
    this.name = 'CompareProductNotFoundError'
  }
}

export interface ProductCompareRegulatory {
  pictograms: string[]
  hazardStatements: string[]
  signalWord: string | null
  ufi: string | null
  requiresSds: boolean
}

export interface ProductCompareItem {
  id: number
  uuid: string
  name: string
  slug: string
  brand: string
  image: string | null
  imageAlt: string | null
  minPrice: number
  minNetPrice: number
  formats: string[]
  primaryFormat: string
  availability: 'in_stock' | 'backorder' | 'out_of_stock'
  stockTotal: number
  regulatory: ProductCompareRegulatory
}

export interface ProductCompareAttributeValue {
  productSlug: string
  present: boolean
  rawValue: CatalogTypedAttributeValue | null
  displayValue: string
  canonicalQuantity: number | null
  canonicalUnit: string | null
  isDifferent: boolean
}

export interface ProductCompareAttributeRow {
  definitionId: string
  code: string
  label: string
  kind: CatalogTypedAttributeKind | 'regulatory' | string
  group: 'technical' | 'regulatory'
  comparable: boolean
  hasDifference: boolean
  hasWinner: boolean
  values: ProductCompareAttributeValue[]
}

export interface ProductCompareResponse {
  products: ProductCompareItem[]
  rows: ProductCompareAttributeRow[]
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,179}$/

export function parseCompareSlugs(
  raw: unknown
): { success: true; slugs: string[] } | { success: false; error: string } {
  let list: string[]
  if (typeof raw === 'string') {
    list = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } else if (Array.isArray(raw)) {
    list = raw.map((s) => String(s).trim()).filter((s) => s.length > 0)
  } else {
    return { success: false, error: 'invalid_slugs' }
  }

  if (list.length === 0) {
    return { success: false, error: 'invalid_slugs' }
  }
  if (list.length < 2) {
    return { success: false, error: 'min_products_required' }
  }
  if (list.length > 4) {
    return { success: false, error: 'max_products_exceeded' }
  }

  const seen = new Set<string>()
  for (const slug of list) {
    if (!SLUG_PATTERN.test(slug)) {
      return { success: false, error: 'invalid_slug_format' }
    }
    if (seen.has(slug)) {
      return { success: false, error: 'duplicate_slugs' }
    }
    seen.add(slug)
  }

  return { success: true, slugs: list }
}

export interface NormalizedCompareUnit {
  canonicalQuantity: number
  canonicalUnit: string
  family: 'volume' | 'mass' | 'length' | 'area' | 'count' | 'ratio'
}

export function normalizeCompareUnit(quantity: number, unit: CatalogTypedAttributeUnit): NormalizedCompareUnit {
  switch (unit) {
    case 'ml':
      return { canonicalQuantity: Math.round((quantity / 1000) * 1e9) / 1e9, canonicalUnit: 'l', family: 'volume' }
    case 'l':
      return { canonicalQuantity: quantity, canonicalUnit: 'l', family: 'volume' }
    case 'm3':
      return { canonicalQuantity: Math.round(quantity * 1000 * 1e9) / 1e9, canonicalUnit: 'l', family: 'volume' }
    case 'g':
      return { canonicalQuantity: Math.round((quantity / 1000) * 1e9) / 1e9, canonicalUnit: 'kg', family: 'mass' }
    case 'kg':
      return { canonicalQuantity: quantity, canonicalUnit: 'kg', family: 'mass' }
    case 'um':
      return { canonicalQuantity: Math.round((quantity / 1e6) * 1e9) / 1e9, canonicalUnit: 'm', family: 'length' }
    case 'mm':
      return { canonicalQuantity: Math.round((quantity / 1000) * 1e9) / 1e9, canonicalUnit: 'm', family: 'length' }
    case 'cm':
      return { canonicalQuantity: Math.round((quantity / 100) * 1e9) / 1e9, canonicalUnit: 'm', family: 'length' }
    case 'm':
      return { canonicalQuantity: quantity, canonicalUnit: 'm', family: 'length' }
    case 'm2':
      return { canonicalQuantity: quantity, canonicalUnit: 'm2', family: 'area' }
    case 'ud':
      return { canonicalQuantity: quantity, canonicalUnit: 'ud', family: 'count' }
    case 'percent':
      return { canonicalQuantity: quantity, canonicalUnit: 'percent', family: 'ratio' }
    default:
      return { canonicalQuantity: quantity, canonicalUnit: String(unit), family: 'count' }
  }
}

export interface CompareAttributeInput {
  productSlug: string
  present: boolean
  value: unknown
  kind?: string
  referenceName?: string | null
  optionLabel?: string | null
}

export function compareAttributeValues(
  inputs: CompareAttributeInput[],
  kind: string
): { items: ProductCompareAttributeValue[]; comparable: boolean; hasDifference: boolean } {
  const items: Array<
    ProductCompareAttributeValue & {
      unitFamily?: string
      canonicalCompareKey?: string | number | boolean
    }
  > = []

  for (const input of inputs) {
    if (!input.present || input.value === null || input.value === undefined) {
      items.push({
        productSlug: input.productSlug,
        present: false,
        rawValue: null,
        displayValue: 'no indicado',
        canonicalQuantity: null,
        canonicalUnit: null,
        isDifferent: false
      })
      continue
    }

    if (kind === 'unit' && typeof input.value === 'object' && 'quantity' in input.value && 'unit' in input.value) {
      const normalized = normalizeCompareUnit(Number(input.value.quantity), input.value.unit)
      const unitLabel = CATALOG_TYPED_ATTRIBUTE_UNITS[input.value.unit as CatalogTypedAttributeUnit] ?? input.value.unit
      items.push({
        productSlug: input.productSlug,
        present: true,
        rawValue: input.value,
        displayValue: `${input.value.quantity} ${unitLabel}`,
        canonicalQuantity: normalized.canonicalQuantity,
        canonicalUnit: normalized.canonicalUnit,
        unitFamily: normalized.family,
        canonicalCompareKey: normalized.canonicalQuantity,
        isDifferent: false
      })
      continue
    }

    if (kind === 'number') {
      const num = Number(input.value)
      items.push({
        productSlug: input.productSlug,
        present: true,
        rawValue: num,
        displayValue: String(num),
        canonicalQuantity: num,
        canonicalUnit: null,
        canonicalCompareKey: num,
        isDifferent: false
      })
      continue
    }

    if (kind === 'boolean') {
      const bool = Boolean(input.value)
      items.push({
        productSlug: input.productSlug,
        present: true,
        rawValue: bool,
        displayValue: bool ? 'Sí' : 'No',
        canonicalQuantity: null,
        canonicalUnit: null,
        canonicalCompareKey: bool,
        isDifferent: false
      })
      continue
    }

    if (kind === 'list') {
      const list = Array.isArray(input.value) ? input.value : [String(input.value)]
      const displayed = input.optionLabel ?? list.join(', ')
      items.push({
        productSlug: input.productSlug,
        present: true,
        rawValue: list,
        displayValue: displayed,
        canonicalQuantity: null,
        canonicalUnit: null,
        canonicalCompareKey: [...list].sort().join(';'),
        isDifferent: false
      })
      continue
    }

    if (kind === 'reference') {
      const ref = String(input.value)
      const displayed = input.referenceName ?? ref
      items.push({
        productSlug: input.productSlug,
        present: true,
        rawValue: ref,
        displayValue: displayed,
        canonicalQuantity: null,
        canonicalUnit: null,
        canonicalCompareKey: ref,
        isDifferent: false
      })
      continue
    }

    // Default string/text
    const str = String(input.value).trim()
    items.push({
      productSlug: input.productSlug,
      present: true,
      rawValue: str,
      displayValue: str,
      canonicalQuantity: null,
      canonicalUnit: null,
      canonicalCompareKey: str,
      isDifferent: false
    })
  }

  const presentItems = items.filter((i) => i.present)
  let comparable: boolean
  let hasDifference: boolean

  if (presentItems.length < 2) {
    comparable = true
    hasDifference = false
  } else if (kind === 'unit') {
    const firstFamily = presentItems[0]!.unitFamily
    const sameFamily = presentItems.every((i) => i.unitFamily === firstFamily)
    if (!sameFamily) {
      comparable = false
      hasDifference = false
    } else {
      comparable = true
      const firstQty = presentItems[0]!.canonicalQuantity!
      hasDifference = presentItems.some((i) => Math.abs(i.canonicalQuantity! - firstQty) > 1e-9)
    }
  } else if (kind === 'number') {
    comparable = true
    const firstNum = presentItems[0]!.canonicalQuantity!
    hasDifference = presentItems.some((i) => Math.abs(i.canonicalQuantity! - firstNum) > 1e-9)
  } else {
    comparable = true
    const firstKey = presentItems[0]!.canonicalCompareKey
    hasDifference = presentItems.some((i) => i.canonicalCompareKey !== firstKey)
  }

  for (const item of items) {
    item.isDifferent = hasDifference && item.present
  }

  return { items, comparable, hasDifference }
}

interface ProductRow {
  uuid: string
  categoryUuid: string
  id: number
  name: string
  slug: string
  brand: string
  categoryId: number
  shortDesc: string | null
  description: string | null
  usage: string | null
  badgesJson: string
  visualJson: string
  image: string | null
  datasheet: string | null
  featured: number
  series: string | null
  attrsJson: string
  typedJson: string | null
  regulatoryJson: string
}

interface VariantRow {
  uuid: string
  productId: string
  id: number
  format: string
  sku: string
  price: number
  taxRateBasisPoints: number
  stock: number
  backorderAllowed: number
}

interface BatchTypedRow {
  product_id: string
  definition_id: string
  revision: number
  code: string
  kind: CatalogTypedAttributeKind
  historical_label: string
  historical_config: string
  entry_json: string
  reference_id: string | null
  reference_name: string | null
  current_revision: number
}

export async function getProductsComparison(
  database: D1Database,
  rawSlugs: unknown,
  pricingOptions?: EffectivePricingOptions
): Promise<ProductCompareResponse> {
  const parsedSlugs = parseCompareSlugs(rawSlugs)
  if (!parsedSlugs.success) {
    throw new InvalidCompareRequestError(parsedSlugs.error)
  }
  const slugs = parsedSlugs.slugs

  const instant = resolvePricingInstant(pricingOptions)
  const validity = publicationValidityWithClock('p', pricingOptions?.instant)
  const slugPlaceholders = slugs.map(() => '?').join(',')

  const productsResult = await database
    .prepare(
      `SELECT p.id AS uuid, p.category_id AS categoryUuid, p.legacy_id AS id,
        p.name, p.slug, COALESCE(b.name, 'NETECO') AS brand,
        c.legacy_id AS categoryId, p.short_description AS shortDesc,
        p.description, p.usage,
        COALESCE(json_extract(p.attributes, '$.badges'), '[]') AS badgesJson,
        COALESCE(json_extract(p.attributes, '$.visual'), '{"type":"botella","color":"#64748b"}') AS visualJson,
        json_extract(p.attributes, '$.image') AS image,
        json_extract(p.attributes, '$.datasheet') AS datasheet,
        p.featured, p.series,
        COALESCE(json_extract(p.attributes, '$.attrs'), '[]') AS attrsJson,
        p.attributes -> '$.typed' AS typedJson,
        p.regulatory AS regulatoryJson
      FROM products p
      JOIN categories c ON c.id = p.category_id AND c.status = 'published'
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.slug IN (${slugPlaceholders}) AND p.status = 'published'
        AND ${validity.sql}
        AND p.legacy_id IS NOT NULL AND c.legacy_id IS NOT NULL`
    )
    .bind(...slugs, ...validity.parameters)
    .all<ProductRow>()

  const rawProducts = productsResult.results ?? []
  if (rawProducts.length !== slugs.length) {
    throw new CompareProductNotFoundError()
  }

  // Preserve exact input order of slugs
  const productMap = new Map(rawProducts.map((p) => [p.slug, p]))
  const products: ProductRow[] = []
  for (const s of slugs) {
    const p = productMap.get(s)
    if (!p) throw new CompareProductNotFoundError()
    products.push(p)
  }

  const productUuids = products.map((p) => p.uuid)
  const productUuidPlaceholders = productUuids.map(() => '?').join(',')

  const selectedVersion = parameterizeEffectivePricingSql(effectiveGovernedVersionIdExpression('v'), instant)
  const variantsResult = await database
    .prepare(
      `SELECT v.id AS uuid, v.product_id AS productId, v.legacy_id AS id, v.format, v.sku,
        COALESCE(pv.gross_cents, v.price_gross_cents) AS price,
        tax.rate_basis_points AS taxRateBasisPoints,
        COALESCE((SELECT SUM(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id = v.id), 0) AS stock,
        v.backorder_allowed AS backorderAllowed
      FROM variants v
      JOIN tax_classes tax ON tax.id = v.tax_class_id
      LEFT JOIN variant_price_versions pv ON pv.id = ${selectedVersion.sql} AND pv.variant_id = v.id
      WHERE v.product_id IN (${productUuidPlaceholders}) AND v.status = 'published' AND v.legacy_id IS NOT NULL
      ORDER BY v.legacy_id`
    )
    .bind(...selectedVersion.instantParameters, ...productUuids)
    .all<VariantRow>()

  const variants = variantsResult.results ?? []
  const variantsByProduct = new Map<string, VariantRow[]>()
  for (const v of variants) {
    let list = variantsByProduct.get(v.productId)
    if (!list) {
      list = []
      variantsByProduct.set(v.productId, list)
    }
    list.push(v)
  }

  for (const p of products) {
    const pVariants = variantsByProduct.get(p.uuid)
    if (!pVariants || pVariants.length === 0) {
      throw new CompareProductNotFoundError()
    }
  }

  // Batch media query
  const publishedMedia = await readPublicProductMedia(
    database,
    productUuids,
    pricingOptions?.instant?.replace(/\.\d{3}Z$/, 'Z')
  )

  // Batch typed attributes query
  const reference = publicationValidityWithClock('typed_target', pricingOptions?.instant)
  const namespace = "typed_p.attributes -> '$.typed'"
  const validEntry = typedAttributeEntryValiditySql({
    entrySql: 'raw.entry_json',
    definitionAlias: 'typed_d',
    revisionAlias: 'typed_h',
    categoryIdSql: 'raw.category_id',
    productIdSql: 'raw.product_id',
    mode: 'historical'
  })

  const typedCteSql = `typed_raw AS MATERIALIZED (
    SELECT typed_p.id AS product_id,typed_p.category_id,CAST(entry.key AS INTEGER) AS entry_index,
      CASE WHEN entry.type='object' THEN entry.value ELSE '{}' END AS entry_json
    FROM products typed_p CROSS JOIN json_each(CASE WHEN ${typedAttributeNamespaceValiditySql(namespace)} THEN ${namespace} ELSE '{"values":[]}' END,'$.values') entry
    WHERE typed_p.status='published' AND typed_p.id IN (${productUuidPlaceholders})
  ), typed_valid AS MATERIALIZED (
    SELECT raw.*,typed_d.id AS definition_id,typed_d.code,typed_d.kind,typed_d.current_revision,
      typed_h.revision,typed_h.label AS historical_label,typed_h.config AS historical_config,
      typed_current.label,typed_current.config AS current_config,typed_category.legacy_id AS category_legacy_id,
      CASE WHEN typed_d.kind='reference' THEN typed_target.id END AS reference_id,
      CASE WHEN typed_d.kind='reference' THEN typed_target.name END AS reference_name
    FROM typed_raw raw
    CROSS JOIN catalog_typed_attribute_definitions typed_d ON typed_d.id=json_extract(raw.entry_json,'$.definitionId')
    CROSS JOIN catalog_typed_attribute_revisions typed_h ON typed_h.definition_id=typed_d.id AND typed_h.revision=json_extract(raw.entry_json,'$.revision')
    JOIN catalog_typed_attribute_revisions typed_current ON typed_current.definition_id=typed_d.id AND typed_current.revision=typed_d.current_revision
    JOIN categories typed_category ON typed_category.id=typed_d.category_id AND typed_category.status='published' AND typed_category.legacy_id BETWEEN 1 AND 9007199254740990
    LEFT JOIN products typed_target ON typed_d.kind='reference' AND typed_target.id=json_extract(raw.entry_json,'$.value')
    LEFT JOIN categories typed_target_category ON typed_target_category.id=typed_target.category_id
    WHERE typed_d.status='active' AND typed_current.status='active' AND ${validEntry}
      AND CASE WHEN typed_d.kind='reference' THEN typed_target.status='published' AND typed_target.legacy_id BETWEEN 1 AND 9007199254740990
        AND typed_target_category.status='published' AND typed_target_category.legacy_id BETWEEN 1 AND 9007199254740990
        AND EXISTS(SELECT 1 FROM variants typed_target_variant WHERE typed_target_variant.product_id=typed_target.id AND typed_target_variant.status='published' AND typed_target_variant.legacy_id BETWEEN 1 AND 9007199254740990)
        AND ${reference.sql} ELSE 1 END
  )`

  const typedResult = await database
    .prepare(`WITH ${typedCteSql} SELECT * FROM typed_valid ORDER BY entry_index`)
    .bind(...productUuids, ...reference.parameters)
    .all<BatchTypedRow>()

  const typedRows = typedResult.results ?? []
  const allReferenceIds: string[] = []
  const allObservations: TypedAttributeObservation[] = []
  const typedByProduct = new Map<string, Map<string, BatchTypedRow>>()
  const definitionsMap = new Map<string, { id: string; code: string; label: string; kind: CatalogTypedAttributeKind }>()

  for (const row of typedRows) {
    if (row.reference_id) allReferenceIds.push(row.reference_id)
    allObservations.push({ id: row.definition_id, revision: row.current_revision })

    let productTyped = typedByProduct.get(row.product_id)
    if (!productTyped) {
      productTyped = new Map()
      typedByProduct.set(row.product_id, productTyped)
    }
    productTyped.set(row.definition_id, row)

    if (!definitionsMap.has(row.definition_id)) {
      definitionsMap.set(row.definition_id, {
        id: row.definition_id,
        code: row.code,
        label: row.historical_label,
        kind: row.kind
      })
    }
  }

  // Publication validity assertion
  const projection = publicMediaProjectionIds(publishedMedia.values())
  await assertCurrentPublicationValidity(database, [...productUuids, ...allReferenceIds], pricingOptions?.instant, {
    ...projection,
    variantIds: [...projection.variantIds, ...variants.map((v) => v.uuid)]
  })
  await assertCurrentTypedAttributes(database, allObservations)

  // Construct ProductCompareItem list
  const productItems: ProductCompareItem[] = []
  for (const p of products) {
    const pVariants = variantsByProduct.get(p.uuid)!
    let minPriceVariant = pVariants[0]!
    let totalStock = 0
    let anyBackorder = false

    for (const v of pVariants) {
      if (v.price < minPriceVariant.price) {
        minPriceVariant = v
      }
      totalStock += v.stock
      if (v.backorderAllowed === 1) anyBackorder = true
    }

    const netPrice = splitGross(minPriceVariant.price, minPriceVariant.taxRateBasisPoints).netCents
    const formats = [...new Set(pVariants.map((v) => v.format))]
    const media = publishedMedia.get(p.uuid)

    let regulatoryRaw: Record<string, unknown>
    try {
      regulatoryRaw = JSON.parse(p.regulatoryJson || '{}') as Record<string, unknown>
    } catch {
      regulatoryRaw = {}
    }

    const regulatory: ProductCompareRegulatory = {
      pictograms: Array.isArray(regulatoryRaw.pictograms) ? (regulatoryRaw.pictograms as string[]) : [],
      hazardStatements: Array.isArray(regulatoryRaw.hazardStatements)
        ? (regulatoryRaw.hazardStatements as string[])
        : [],
      signalWord: typeof regulatoryRaw.signalWord === 'string' ? regulatoryRaw.signalWord : null,
      ufi: typeof regulatoryRaw.ufi === 'string' ? regulatoryRaw.ufi : null,
      requiresSds: regulatoryRaw.requiresSds === true
    }

    const availability = totalStock > 0 ? 'in_stock' : anyBackorder ? 'backorder' : 'out_of_stock'

    productItems.push({
      id: p.id,
      uuid: p.uuid,
      name: p.name,
      slug: p.slug,
      brand: p.brand,
      image: media?.image ?? null,
      imageAlt: media?.imageAlt ?? null,
      minPrice: minPriceVariant.price,
      minNetPrice: netPrice,
      formats,
      primaryFormat: minPriceVariant.format,
      availability,
      stockTotal: totalStock,
      regulatory
    })
  }

  // Build matrix rows for typed attributes
  const rows: ProductCompareAttributeRow[] = []
  for (const def of definitionsMap.values()) {
    const inputs: CompareAttributeInput[] = []
    for (const p of products) {
      const row = typedByProduct.get(p.uuid)?.get(def.id)
      if (!row) {
        inputs.push({ productSlug: p.slug, present: false, value: null, kind: def.kind })
      } else {
        let entryValue: unknown
        try {
          const entry = JSON.parse(row.entry_json) as { value: unknown }
          entryValue = entry.value
        } catch {
          entryValue = null
        }
        let optionLabel: string | null = null
        if (def.kind === 'list' && Array.isArray(entryValue)) {
          try {
            const config = JSON.parse(row.historical_config) as { options?: Array<{ code: string; label: string }> }
            optionLabel = entryValue
              .map((code: unknown) => config.options?.find((o) => o.code === code)?.label ?? String(code))
              .join(', ')
          } catch {
            // fallback
          }
        }
        inputs.push({
          productSlug: p.slug,
          present: true,
          value: entryValue,
          kind: def.kind,
          referenceName: row.reference_name,
          optionLabel
        })
      }
    }

    const comparisonResult = compareAttributeValues(inputs, def.kind)
    rows.push({
      definitionId: def.id,
      code: def.code,
      label: def.label,
      kind: def.kind,
      group: 'technical',
      comparable: comparisonResult.comparable,
      hasDifference: comparisonResult.hasDifference,
      hasWinner: false,
      values: comparisonResult.items
    })
  }

  // Sort rows deterministically: by code
  rows.sort((a, b) => a.code.localeCompare(b.code))

  // Add regulatory rows (factual, without declaring any winner or "better" product)
  const pictogramsInputs: ProductCompareAttributeInput[] = []
  const hazardInputs: ProductCompareAttributeInput[] = []
  const signalWordInputs: ProductCompareAttributeInput[] = []

  for (const item of productItems) {
    const p = item.regulatory
    pictogramsInputs.push({
      productSlug: item.slug,
      present: p.pictograms.length > 0,
      rawValue: p.pictograms,
      displayValue: p.pictograms.length > 0 ? p.pictograms.join(', ') : 'no indicado',
      canonicalQuantity: null,
      canonicalUnit: null,
      isDifferent: false
    })
    hazardInputs.push({
      productSlug: item.slug,
      present: p.hazardStatements.length > 0,
      rawValue: p.hazardStatements,
      displayValue: p.hazardStatements.length > 0 ? p.hazardStatements.join('; ') : 'no indicado',
      canonicalQuantity: null,
      canonicalUnit: null,
      isDifferent: false
    })
    signalWordInputs.push({
      productSlug: item.slug,
      present: !!p.signalWord,
      rawValue: p.signalWord,
      displayValue: p.signalWord ?? 'no indicado',
      canonicalQuantity: null,
      canonicalUnit: null,
      isDifferent: false
    })
  }

  rows.push({
    definitionId: 'reg-pictograms',
    code: 'clp_pictograms',
    label: 'Pictogramas CLP',
    kind: 'regulatory',
    group: 'regulatory',
    comparable: false,
    hasDifference: false,
    hasWinner: false,
    values: pictogramsInputs
  })

  rows.push({
    definitionId: 'reg-hazard',
    code: 'hazard_statements',
    label: 'Indicaciones de peligro (frases H)',
    kind: 'regulatory',
    group: 'regulatory',
    comparable: false,
    hasDifference: false,
    hasWinner: false,
    values: hazardInputs
  })

  rows.push({
    definitionId: 'reg-signal',
    code: 'signal_word',
    label: 'Palabra de advertencia',
    kind: 'regulatory',
    group: 'regulatory',
    comparable: false,
    hasDifference: false,
    hasWinner: false,
    values: signalWordInputs
  })

  return {
    products: productItems,
    rows
  }
}
