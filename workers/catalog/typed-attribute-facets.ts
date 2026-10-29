import {
  CATALOG_TYPED_ATTRIBUTE_UNITS,
  catalogTypedAttributeDefinitionSchema,
  typedAttributeNumberMatchesPrecision,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeValue
} from '../../shared/catalog-typed-attributes'
import { parseCatalogTypedFilters } from '../../shared/catalog-typed-attribute-filters'
import { catalogPolicyCodeSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import type { TypedAttributeFilter, TypedAttributeFacet, TypedAttributeDetail } from '../../shared/types/catalog'
import { publicationValidityWithClock } from './publication-validity'
import {
  typedAttributeEntryValiditySql,
  typedAttributeNamespaceValiditySql,
  typedAttributePublicCategoryValiditySql
} from './typed-attribute-sql'

export interface TypedAttributeSqlFilter {
  key: string
  clause: string
  parameters: Array<string | number>
}
export interface TypedAttributeObservation {
  id: string
  revision: number
}
interface DefinitionRow {
  id: string
  categoryId: number
  categoryUuid: string
  code: string
  kind: string
  label: string
  revision: number
  status: string
  config: string
}
export class InvalidTypedAttributeFiltersError extends Error {
  readonly code = 'invalid_typed_filters'
  constructor() {
    super('invalid_typed_filters')
  }
}

function filterValueMatchesKind(
  value: TypedAttributeFilter['values'][number],
  definition: CatalogTypedAttributeDefinition
) {
  switch (definition.kind) {
    case 'number':
      return typeof value === 'number' && typedAttributeNumberMatchesPrecision(value, 6)
    case 'boolean':
      return typeof value === 'boolean'
    case 'list':
      return (
        typeof value === 'string' &&
        catalogPolicyCodeSchema.safeParse(value).success &&
        definition.config.options.some((option) => option.code === value)
      )
    case 'reference':
      return typeof value === 'string' && catalogPolicyUuidSchema.safeParse(value).success
    case 'unit':
      return typeof value === 'object' && typedAttributeNumberMatchesPrecision(value.quantity, 6)
    default:
      return false
  }
}

/** Semantic admission is a single private lookup. Unknown, withdrawn and
 * non-public categories produce the same error without returning metadata. */
export async function preparePublicTypedFilters(database: D1Database, raw?: string) {
  const parsed = parseCatalogTypedFilters(raw)
  if (!parsed.success) throw new InvalidTypedAttributeFiltersError()
  const filters = parsed.data
  const observations: TypedAttributeObservation[] = []
  if (!filters.length)
    return {
      filters,
      sqlFilters: [] as TypedAttributeSqlFilter[],
      observations,
      referenceFilters: [] as TypedAttributeFilter[]
    }
  const result = await database
    .prepare(
      `SELECT d.id,c.legacy_id AS categoryId,d.category_id AS categoryUuid,
    d.code,d.kind,r.label,d.current_revision AS revision,d.status,r.config
    FROM json_each(?) requested CROSS JOIN catalog_typed_attribute_definitions d ON d.id=requested.value
    JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id AND r.revision=d.current_revision
    JOIN categories c ON c.id=d.category_id AND c.status='published' AND c.legacy_id BETWEEN 1 AND 9007199254740990
    WHERE d.status='active' AND r.status='active' AND ${typedAttributePublicCategoryValiditySql('d.category_id')}`
    )
    .bind(JSON.stringify(filters.map((filter) => filter.definitionId)))
    .all<DefinitionRow>()
  const definitions = new Map<string, CatalogTypedAttributeDefinition>()
  for (const row of result.results ?? []) {
    let config: unknown
    try {
      config = JSON.parse(row.config)
    } catch {
      throw new InvalidTypedAttributeFiltersError()
    }
    const checked = catalogTypedAttributeDefinitionSchema.safeParse({ ...row, config })
    if (!checked.success) throw new InvalidTypedAttributeFiltersError()
    definitions.set(row.id, checked.data)
  }
  for (const filter of filters) {
    const definition = definitions.get(filter.definitionId)
    if (!definition || !filter.values.every((value) => filterValueMatchesKind(value, definition)))
      throw new InvalidTypedAttributeFiltersError()
    observations.push({ id: definition.id, revision: definition.revision })
  }
  const sqlFilters = filters.map((filter): TypedAttributeSqlFilter => ({
    key: `typed:${filter.definitionId}`,
    clause: `EXISTS(SELECT 1 FROM typed_tokens matched
      WHERE matched.product_id=p.id AND matched.definition_id=?
        AND EXISTS(SELECT 1 FROM json_each(?) selection WHERE ${typedSelectionMatchesSql('matched', 'selection')}))`,
    parameters: [filter.definitionId, JSON.stringify(filter.values)]
  }))
  return {
    filters,
    sqlFilters,
    observations,
    referenceFilters: filters.filter((filter) => definitions.get(filter.definitionId)?.kind === 'reference')
  }
}

/** Capture the actual eligible reference identities in the count snapshot,
 * rather than doing a later lookup that could miss a concurrent withdrawal. */
export function typedFilterReferenceProjectionSql(filters: readonly TypedAttributeFilter[]) {
  if (!filters.length) return { sql: "'[]'", parameters: [] as string[] }
  return {
    sql: `(SELECT COALESCE(json_group_array(DISTINCT reference_token.reference_id),'[]') FROM typed_tokens reference_token
      WHERE reference_token.kind='reference' AND EXISTS(SELECT 1 FROM json_each(?) requested_reference
        WHERE json_extract(requested_reference.value,'$.definitionId')=reference_token.definition_id
          AND EXISTS(SELECT 1 FROM json_each(requested_reference.value,'$.values') selected_reference
            WHERE ${typedSelectionMatchesSql('reference_token', 'selected_reference')})))`,
    parameters: [JSON.stringify(filters)]
  }
}

function typedSelectionMatchesSql(token: string, selection: string) {
  const object = `CASE WHEN ${selection}.type='object' THEN ${selection}.value ELSE '{}' END`
  return `(CASE ${token}.kind
    WHEN 'number' THEN ${selection}.type IN ('integer','real') AND ${token}.number_value=${selection}.value
    WHEN 'boolean' THEN ${selection}.type IN ('true','false') AND ${token}.number_value=${selection}.value
    WHEN 'list' THEN ${selection}.type='text' AND ${token}.text_value=${selection}.value
    WHEN 'reference' THEN ${selection}.type='text' AND ${token}.text_value=${selection}.value
    WHEN 'unit' THEN ${selection}.type='object' AND ${token}.number_value=json_extract(${object},'$.quantity') AND ${token}.unit=json_extract(${object},'$.unit')
    ELSE 0 END)`
}

/** A reusable set-based CTE: JSON entry -> definition PK -> exact revision PK.
 * No global catalogue IDs are brought into application memory for filtering.
 * Reference names exist in the result only after full publication eligibility.
 */
export function publicTypedAttributeCtes(instant?: string, productId?: string) {
  const reference = publicationValidityWithClock('typed_target', instant)
  const namespace = "typed_p.attributes -> '$.typed'"
  const validEntry = typedAttributeEntryValiditySql({
    entrySql: 'raw.entry_json',
    definitionAlias: 'typed_d',
    revisionAlias: 'typed_h',
    categoryIdSql: 'raw.category_id',
    productIdSql: 'raw.product_id',
    mode: 'historical'
  })
  return {
    parameters: [...(productId === undefined ? [] : [productId]), ...reference.parameters],
    sql: `typed_raw AS MATERIALIZED (
      SELECT typed_p.id AS product_id,typed_p.category_id,CAST(entry.key AS INTEGER) AS entry_index,
        CASE WHEN entry.type='object' THEN entry.value ELSE '{}' END AS entry_json
      FROM products typed_p CROSS JOIN json_each(CASE WHEN ${typedAttributeNamespaceValiditySql(namespace)} THEN ${namespace} ELSE '{"values":[]}' END,'$.values') entry
      WHERE typed_p.status='published' ${productId === undefined ? '' : 'AND typed_p.id=?'}
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
    ), typed_tokens AS MATERIALIZED (
      SELECT valid.*,CASE WHEN token.type IN ('true','false') THEN token.type WHEN token.type='object' THEN token.value ELSE json_quote(token.value) END AS value_json,
        CASE WHEN valid.kind='unit' THEN json_extract(token.value,'$.quantity') WHEN valid.kind IN ('number','boolean') THEN token.value END AS number_value,
        CASE WHEN valid.kind IN ('list','reference') THEN token.value END AS text_value,
        CASE WHEN valid.kind='unit' THEN json_extract(token.value,'$.unit') END AS unit
      FROM typed_valid valid CROSS JOIN json_each(CASE WHEN valid.kind='list' THEN valid.entry_json -> '$.value' ELSE json_array(json(valid.entry_json -> '$.value')) END) token
      WHERE valid.kind<>'text'
    )`
  }
}

export interface PublicTypedFacetRow {
  definition_id: string
  category_legacy_id: number
  code: string
  kind: TypedAttributeFacet['kind']
  label: string
  current_revision: number
  value_json: string
  option_label: string | null
  reference_name: string | null
  reference_id: string | null
  n: number
}
export interface PublicTypedFacetOptions {
  effectiveSummary: string
  instantParameters: string[]
  joins: string
  filters: TypedAttributeSqlFilter[]
  typedFilters: TypedAttributeFilter[]
  instant?: string
}

/** Preparation is deliberately synchronous: callers may combine the typed
 * aggregate with fixed facets in their final, single D1 batch snapshot. */
export function preparePublicTypedFacetsStatement(database: D1Database, options: PublicTypedFacetOptions) {
  const ctes = publicTypedAttributeCtes(options.instant)
  // Keep the eight legacy filter predicates outside typed auto-exclusion's
  // expression tree: their fifty-value selections must still fit D1 depth100.
  const fixed = options.filters.filter((filter) => !filter.key.startsWith('typed:'))
  const matches = typedSelectionMatchesSql('matching_token', 'selected_value')
  return database
    .prepare(
      `${options.effectiveSummary},${ctes.sql},typed_requested AS MATERIALIZED (
        SELECT json_extract(value,'$.definitionId') AS definition_id,value -> '$.values' AS selections
        FROM json_each(${options.typedFilters.length ? '?' : "'[]'"})
      ), typed_matches AS MATERIALIZED (
        SELECT matching_token.product_id,requested.definition_id
        FROM typed_tokens matching_token CROSS JOIN typed_requested requested ON requested.definition_id=matching_token.definition_id
        CROSS JOIN json_each(requested.selections) selected_value
        WHERE ${matches} GROUP BY matching_token.product_id,requested.definition_id
      ), typed_fixed_products AS MATERIALIZED (
        SELECT p.id ${options.joins}
        WHERE ${fixed.map((filter) => filter.clause).join(' AND ') || '1'}
      )
    SELECT token.definition_id,token.category_legacy_id,token.code,token.kind,token.label,token.current_revision,
      min(token.value_json) AS value_json,token.reference_name,token.reference_id,
      CASE WHEN token.kind='list' THEN (SELECT json_extract(option.value,'$.label') FROM json_each(token.current_config,'$.options') option WHERE json_extract(option.value,'$.code')=token.text_value) END AS option_label,
      count(DISTINCT p.id) AS n
    FROM typed_fixed_products p JOIN typed_tokens token ON token.product_id=p.id
    WHERE NOT EXISTS(SELECT 1 FROM typed_requested requested
        LEFT JOIN typed_matches matched ON matched.product_id=p.id AND matched.definition_id=requested.definition_id
        WHERE requested.definition_id<>token.definition_id AND matched.product_id IS NULL)
    GROUP BY token.definition_id,token.kind,token.number_value,token.unit,token.text_value
    ORDER BY token.category_legacy_id,token.code,token.definition_id,token.number_value,token.unit,token.text_value`
    )
    .bind(
      ...options.instantParameters,
      ...ctes.parameters,
      ...(options.typedFilters.length ? [JSON.stringify(options.typedFilters)] : []),
      ...fixed.flatMap((filter) => filter.parameters)
    )
}

export function parsePublicTypedFacetsRows(rows: readonly PublicTypedFacetRow[]) {
  const facets = new Map<string, TypedAttributeFacet>()
  for (const row of rows) {
    const value: TypedAttributeFilter['values'][number] = JSON.parse(row.value_json)
    let facet = facets.get(row.definition_id)
    if (!facet) {
      facet = {
        definitionId: row.definition_id,
        categoryId: row.category_legacy_id,
        code: row.code,
        kind: row.kind,
        label: row.label,
        values: []
      }
      facets.set(row.definition_id, facet)
    }
    facet.values.push({ value, label: displayValue(value, row.option_label, row.reference_name), n: row.n })
  }
  return { facets: [...facets.values()] }
}

export async function readPublicTypedFacets(database: D1Database, options: PublicTypedFacetOptions) {
  const result = await preparePublicTypedFacetsStatement(database, options).all<PublicTypedFacetRow>()
  return parsePublicTypedFacetsRows(result.results ?? [])
}

function displayValue(
  value: CatalogTypedAttributeValue,
  optionLabel?: string | null,
  referenceName?: string | null
): string {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return referenceName ?? optionLabel ?? value
  if (Array.isArray(value)) return value.join(', ')
  return `${value.quantity} ${CATALOG_TYPED_ATTRIBUTE_UNITS[value.unit]}`
}

interface DetailRow {
  definition_id: string
  revision: number
  code: string
  kind: CatalogTypedAttributeDefinition['kind']
  historical_label: string
  historical_config: string
  entry_json: string
  reference_id: string | null
  reference_name: string | null
  current_revision: number
}
export async function readPublicTypedDetail(database: D1Database, productId: string, instant?: string) {
  const ctes = publicTypedAttributeCtes(instant, productId)
  const result = await database
    .prepare(`WITH ${ctes.sql} SELECT * FROM typed_valid ORDER BY entry_index`)
    .bind(...ctes.parameters)
    .all<DetailRow>()
  const attrs: TypedAttributeDetail[] = [],
    referenceIds: string[] = [],
    observations: TypedAttributeObservation[] = []
  for (const row of result.results ?? []) {
    const entry: { value: CatalogTypedAttributeValue } = JSON.parse(row.entry_json)
    let displayed = displayValue(entry.value, null, row.reference_name)
    if (row.kind === 'list' && Array.isArray(entry.value)) {
      const config: { options: Array<{ code: string; label: string }> } = JSON.parse(row.historical_config)
      displayed = entry.value.map((code) => config.options.find((option) => option.code === code)!.label).join(', ')
    }
    attrs.push({
      definitionId: row.definition_id,
      revision: row.revision,
      code: row.code,
      kind: row.kind,
      label: row.historical_label,
      value: entry.value,
      displayValue: displayed
    })
    observations.push({ id: row.definition_id, revision: row.current_revision })
    if (row.reference_id) referenceIds.push(row.reference_id)
  }
  return { attrs, referenceIds, observations }
}

/** A label/config edit or retirement during async enrichment must not return
 * stale counts/labels. Revisions are immutable, so current revision+status is
 * the complete governing identity. Conflicting observations fail closed. */
export async function assertCurrentTypedAttributes(
  database: D1Database,
  observations: readonly TypedAttributeObservation[]
) {
  const unique = new Map<string, number>()
  for (const item of observations) {
    if (unique.has(item.id) && unique.get(item.id) !== item.revision) throw new Error('typed_attributes_changed')
    unique.set(item.id, item.revision)
  }
  if (!unique.size) return
  const result = await database
    .prepare(
      `SELECT count(*) AS n FROM json_each(?) observed
    CROSS JOIN catalog_typed_attribute_definitions d ON d.id=json_extract(observed.value,'$[0]')
    WHERE d.current_revision=json_extract(observed.value,'$[1]') AND d.status='active'`
    )
    .bind(JSON.stringify([...unique]))
    .first<{ n: number }>()
  if (result?.n !== unique.size) throw new Error('typed_attributes_changed')
}
