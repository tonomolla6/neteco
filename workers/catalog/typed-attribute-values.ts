import type { VerifiedSessionClaims } from './authorization'
import {
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeValuesSchema,
  validateTypedAttributeValues
} from '../../shared/catalog-typed-attributes'
import type { CatalogTypedAttributeValues } from '../../shared/catalog-typed-attributes'
import {
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema,
  updateCatalogTypedAttributeValuesSchema
} from '../../shared/catalog-typed-attribute-views'
import type {
  CatalogTypedAttributeProductView,
  CatalogTypedAttributeValuesReceipt
} from '../../shared/catalog-typed-attribute-views'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import {
  AdminCatalogMutationError,
  authorizeD1CatalogMutation,
  updateD1DraftProductMetadata
} from './admin-catalog-mutations'
import { typedAttributeEntryValiditySql, typedAttributeNamespaceValiditySql } from './typed-attribute-sql'
import { publicationValidityExpression } from './publication-validity'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'

const EMPTY: CatalogTypedAttributeValues = { version: 1, values: [] }
interface ProductRow {
  id: string
  legacy_id: number
  category_id: string
  category_legacy_id: number
  catalog_version: number
  status: CatalogTypedAttributeProductView['product']['status']
  attributes: string
  raw_typed: string | null
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

function parsedNamespace(attributes: string): CatalogTypedAttributeValues {
  try {
    const object = JSON.parse(attributes)
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('invalid_attributes')
    if (!Object.hasOwn(object, 'typed')) return EMPTY
    return catalogTypedAttributeValuesSchema.parse(object.typed)
  } catch {
    throw new AdminCatalogMutationError('invalid_typed_values')
  }
}

async function readProduct(database: D1Database, legacyId: string): Promise<ProductRow> {
  const id = parseAdminCatalogLegacyId(legacyId)
  if (id === null || String(id) !== legacyId) throw new AdminCatalogMutationError('invalid_input')
  const row = await database
    .prepare(
      `SELECT p.id,p.legacy_id,p.category_id,p.catalog_version,p.status,p.attributes,p.attributes -> '$.typed' AS raw_typed,
    c.legacy_id AS category_legacy_id FROM products p JOIN categories c ON c.id=p.category_id
    WHERE p.legacy_id=? AND c.legacy_id BETWEEN 1 AND 9007199254740991`
    )
    .bind(id)
    .first<ProductRow>()
  if (!row) throw new AdminCatalogMutationError('not_found')
  return row
}

/** At most 32 current plus the <=32 exact revisions pinned by this product or
 * proposed replacement. No unbounded historical list or N+1 definition reads. */
async function definitionsFor(database: D1Database, categoryUuid: string, pinned: CatalogTypedAttributeValues) {
  const result = await database
    .prepare(
      `SELECT d.id,c.legacy_id AS categoryId,d.category_id AS categoryUuid,d.code,d.kind,
    r.label,r.revision,r.status,r.config FROM catalog_typed_attribute_definitions d
    JOIN categories c ON c.id=d.category_id JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id
    WHERE d.category_id=?1 AND (r.revision=d.current_revision OR EXISTS (
      SELECT 1 FROM json_each(?2,'$.values') pin WHERE json_extract(pin.value,'$.definitionId')=d.id
        AND json_extract(pin.value,'$.revision')=r.revision)) ORDER BY d.code,r.revision LIMIT 65`
    )
    .bind(categoryUuid, JSON.stringify(pinned))
    .all<DefinitionRow>()
  if (result.results.length > 64 || new Set(result.results.map((row) => row.id)).size > 32)
    throw new AdminCatalogMutationError('conflict')
  return result.results.map((row) =>
    catalogTypedAttributeDefinitionSchema.parse({ ...row, config: JSON.parse(row.config) })
  )
}

export async function readD1CatalogTypedAttributeProduct(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  options: { now?: string } = {}
): Promise<CatalogTypedAttributeProductView> {
  const claims = await authorizeD1CatalogMutation(database, claimsInput, options.now)
  const product = await readProduct(database, legacyId),
    typed = parsedNamespace(product.attributes)
  const definitions = await definitionsFor(database, product.category_id, typed)
  if (
    !validateTypedAttributeValues(typed, definitions, {
      categoryId: product.category_legacy_id,
      ...(catalogPolicyUuidSchema.safeParse(product.id).success ? { productId: product.id } : {}),
      mode: 'historical'
    }).success
  )
    throw new AdminCatalogMutationError('invalid_typed_values')
  await authorizeD1CatalogMutation(database, claims, options.now)
  return catalogTypedAttributeProductViewSchema.parse({
    source: 'cloudflare',
    product: {
      id: product.legacy_id,
      uuid: product.id,
      categoryId: product.category_legacy_id,
      categoryUuid: product.category_id,
      catalogVersion: product.catalog_version,
      status: product.status
    },
    typed,
    definitions,
    capabilities: { read: true, update: product.status === 'draft' }
  })
}

const sameEntry = (
  left: CatalogTypedAttributeValues['values'][number],
  right: CatalogTypedAttributeValues['values'][number]
) =>
  left.definitionId === right.definitionId &&
  left.revision === right.revision &&
  JSON.stringify(left.value) === JSON.stringify(right.value)

/** Runs only AFTER durable replay, so subsequent retirement cannot change an
 * already accepted outcome. The transaction repeats every rule in SQL. */
export async function validateD1CatalogTypedAttributePatch(
  database: D1Database,
  claims: VerifiedSessionClaims,
  legacyId: string,
  body: { expectedVersion: number; categoryId?: number; typed?: CatalogTypedAttributeValues },
  now?: string
) {
  const product = await readProduct(database, legacyId)
  if (product.status !== 'draft') throw new AdminCatalogMutationError('product_not_editable')
  if (product.catalog_version !== body.expectedVersion) throw new AdminCatalogMutationError('version_conflict')
  const attributes = JSON.parse(product.attributes) as Record<string, unknown>
  if (body.typed === undefined && body.categoryId === undefined) return
  if (body.typed === undefined && !Object.hasOwn(attributes, 'typed'))
    return { rawTyped: product.raw_typed, canonicalPrevious: EMPTY, previousValid: true }
  const old = catalogTypedAttributeValuesSchema.safeParse(attributes.typed)
  const proposed = body.typed ?? (old.success ? old.data : null)
  if (!proposed) throw new AdminCatalogMutationError('invalid_typed_values')
  const categoryId = body.categoryId ?? product.category_legacy_id
  const category = await database
    .prepare('SELECT id FROM categories WHERE legacy_id=?')
    .bind(categoryId)
    .first<{ id: string }>()
  if (!category) throw new AdminCatalogMutationError('invalid_input')
  const definitions = await definitionsFor(database, category.id, proposed)
  for (const entry of proposed.values) {
    const unchanged = old.success && old.data.values.some((previous) => sameEntry(previous, entry))
    const result = validateTypedAttributeValues({ version: 1, values: [entry] }, definitions, {
      categoryId,
      ...(catalogPolicyUuidSchema.safeParse(product.id).success ? { productId: product.id } : {}),
      mode: unchanged ? 'historical' : 'write'
    })
    if (!result.success) throw new AdminCatalogMutationError('invalid_typed_values')
    const definition = definitions.find((item) => item.id === entry.definitionId && item.revision === entry.revision)!
    if (!unchanged && definition.kind === 'reference') {
      const target = await database
        .prepare(
          `SELECT ref.id FROM products ref JOIN categories c ON c.id=ref.category_id
        WHERE ref.id=?2 AND ref.status='published' AND ref.legacy_id BETWEEN 1 AND 9007199254740991
        AND EXISTS(SELECT 1 FROM variants reference_variant WHERE reference_variant.product_id=ref.id
          AND reference_variant.status='published' AND reference_variant.legacy_id BETWEEN 1 AND 9007199254740991)
        AND c.status='published' AND ${publicationValidityExpression('ref', "COALESCE(?1,'now')")}`
        )
        .bind(now ?? null, entry.value as string)
        .first()
      if (!target) throw new AdminCatalogMutationError('reference_unavailable')
    }
  }
  await authorizeD1CatalogMutation(database, claims, now)
  return { rawTyped: product.raw_typed, canonicalPrevious: old.success ? old.data : EMPTY, previousValid: old.success }
}

/** Trusted SQL fragments only. Old exact entries may retain their historical
 * revision; changed/new entries must remain current, active and eligible. */
export function catalogTypedAttributeReplacementValidityCtes(
  next: string,
  previous: string,
  category: string,
  product: string,
  historicalAllowed = '1'
) {
  const entry = 'typed_value.value'
  const unchanged = `((${historicalAllowed})=1 AND EXISTS(SELECT 1 FROM typed_previous_values old_value
    WHERE json_extract(old_value.value,'$.definitionId')=json_extract(${entry},'$.definitionId')
      AND json_extract(old_value.value,'$.revision')=json_extract(${entry},'$.revision')
      AND json_type(old_value.value,'$.value') IS json_type(${entry},'$.value')
      AND json_extract(old_value.value,'$.value') IS json_extract(${entry},'$.value')))`
  const validity = (mode: 'write' | 'historical') =>
    typedAttributeEntryValiditySql({
      entrySql: entry,
      definitionAlias: 'typed_definition',
      revisionAlias: 'typed_revision',
      categoryIdSql: category,
      productIdSql: product,
      mode
    })
  const reference = `EXISTS(SELECT 1 FROM typed_public_references ref
    WHERE ref.id=json_extract(${entry},'$.value') AND ref.id<>${product} AND ref.eligible=1)`
  // Independent materialized scalar columns keep the shared predicates below
  // D1's expression depth even inside the command's final EXISTS guard.
  return `, typed_namespaces AS MATERIALIZED (
      SELECT ${next} -> '$.typed' AS proposed, ${previous} -> '$.typed' AS previous FROM target
    ), typed_namespace_checks AS MATERIALIZED (
      SELECT *, ${typedAttributeNamespaceValiditySql('proposed')} AS proposed_valid,
        ${typedAttributeNamespaceValiditySql('previous')} AS previous_valid FROM typed_namespaces
    ), typed_proposed_values AS MATERIALIZED (
      SELECT CASE WHEN entry.type='object' THEN entry.value ELSE '{}' END AS value
      FROM typed_namespace_checks,json_each(CASE WHEN proposed_valid=1 THEN proposed ELSE '{"version":1,"values":[]}' END,'$.values') entry
    ), typed_previous_values AS MATERIALIZED (
      SELECT CASE WHEN entry.type='object' THEN entry.value ELSE '{}' END AS value
      FROM typed_namespace_checks,json_each(CASE WHEN previous_valid=1 THEN previous ELSE '{"version":1,"values":[]}' END,'$.values') entry
    ), typed_reference_ids AS MATERIALIZED (
      SELECT DISTINCT json_extract(v.value,'$.value') AS id FROM typed_proposed_values v
      JOIN catalog_typed_attribute_definitions d ON d.id=json_extract(v.value,'$.definitionId') AND d.kind='reference'
    ), typed_public_references AS MATERIALIZED (
      SELECT ref.id, ${publicationValidityExpression('ref', "COALESCE(?1,'now')")} AS eligible
      FROM typed_reference_ids needed JOIN products ref ON ref.id=needed.id
      JOIN categories c ON c.id=ref.category_id AND c.status='published'
      WHERE ref.status='published' AND ref.legacy_id BETWEEN 1 AND 9007199254740991
        AND EXISTS(SELECT 1 FROM variants reference_variant WHERE reference_variant.product_id=ref.id
          AND reference_variant.status='published' AND reference_variant.legacy_id BETWEEN 1 AND 9007199254740991)
    ), typed_entry_rules AS MATERIALIZED (
      SELECT ${unchanged} AS unchanged, ${validity('historical')} AS historical_valid,
        ${validity('write')} AS write_valid,
        CASE WHEN typed_definition.kind='reference' THEN ${reference} ELSE 1 END AS reference_valid
      FROM typed_proposed_values typed_value CROSS JOIN target
      LEFT JOIN catalog_typed_attribute_definitions typed_definition ON typed_definition.id=json_extract(${entry},'$.definitionId')
      LEFT JOIN catalog_typed_attribute_revisions typed_revision ON typed_revision.definition_id=typed_definition.id
        AND typed_revision.revision=json_extract(${entry},'$.revision')
    ), typed_replacement_validity AS MATERIALIZED (
      SELECT CASE WHEN proposed IS NULL THEN 1 WHEN proposed_valid IS NOT 1 THEN 0
      ELSE NOT EXISTS(SELECT 1 FROM typed_entry_rules WHERE
        COALESCE(CASE WHEN unchanged=1 THEN historical_valid ELSE write_valid AND reference_valid END,0)<>1)
      END AS valid FROM typed_namespace_checks)`
}

export async function updateD1CatalogTypedAttributeValues(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  legacyId: string,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CatalogTypedAttributeValuesReceipt> {
  const parsed = updateCatalogTypedAttributeValuesSchema.safeParse(input)
  if (!parsed.success) throw new AdminCatalogMutationError('invalid_input')
  return catalogTypedAttributeValuesReceiptSchema.parse(
    await updateD1DraftProductMetadata(database, claims, legacyId, parsed.data, options)
  )
}
