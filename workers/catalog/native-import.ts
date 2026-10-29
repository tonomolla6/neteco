import { z } from 'zod'
import {
  CATALOG_NATIVE_IMPORT_MAX_BYTES,
  nativeImportInputSchema,
  nativeImportCommandInputSchema,
  nativeImportPreviewSchema,
  nativeImportInvalidSchema,
  nativeImportReceiptSchema,
  type NativeImportPreview,
  type NativeImportInvalid,
  type NativeImportReceipt
} from '../../shared/catalog-native-import'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema,
  catalogPolicyInstantSchema
} from '../../shared/catalog-publication-policy'
import { validateCatalogRecords, type CatalogImportDataset } from '../../shared/catalog-tabular-core'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { validateQuantity } from '../../server/domain/money'
import { catalogTypedAttributeIntegrityCtes } from './typed-attribute-integrity'
import { typedAttributeEntryValiditySql, typedAttributeNamespaceValiditySql } from './typed-attribute-sql'

export class NativeCatalogImportError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'preview_expired'
      | 'already_applied'
      | 'already_reverted'
      | 'not_applied'
      | 'idempotency_conflict'
  ) {
    super(code)
  }
}
type Options = { now?: string }
type Manifest = Omit<CatalogImportDataset, 'variants'> & {
  warehouseId: string
  variants: Array<
    CatalogImportDataset['variants'][number] & {
      initialPriceId: string
      initialMovementId: string
      compensationMovementId: string
    }
  >
}
const permissions = ['catalog.write', 'administration.manage', 'inventory.write'] as const
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const at = (value: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${value})`
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND ${at('s.created_at')}<=${at(clock)} AND ${at('s.expires_at')}>${at(clock)}
 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND ${at('i.email_verified_at')}<=${at(clock)}
 AND ${permissions
   .map(
     (
       permission
     ) => `EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON assigned.role_code=granted.role_code
 WHERE assigned.identity_id=i.id AND granted.permission_code='${permission}' AND ${at('assigned.granted_at')}<=${at(clock)}
 AND (assigned.expires_at IS NULL OR ${at('assigned.expires_at')}>${at(clock)}))`
   )
   .join(' AND ')}`
const claimsSchema = z
  .object({
    sessionId: catalogPolicyUuidSchema,
    identityId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
function instant(options: Options) {
  if (options.now !== undefined && !catalogPolicyInstantSchema.safeParse(options.now).success)
    throw new NativeCatalogImportError('invalid_input')
  return options.now ?? null
}
async function authorize(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  options: Options
): Promise<VerifiedSessionClaims> {
  let data: unknown
  try {
    data = catalogPolicyOwnJson(input)
  } catch {
    throw new NativeCatalogImportError('unauthenticated')
  }
  const parsed = claimsSchema.safeParse(data)
  if (!parsed.success) throw new NativeCatalogImportError('unauthenticated')
  instant(options)
  for (const permission of permissions) {
    const result = await authorizeD1Session(database, parsed.data, permission, {
      requireMfa: true,
      ...(options.now === undefined ? {} : { now: options.now })
    })
    if (!result.allowed) throw new NativeCatalogImportError(result.code)
  }
  return parsed.data
}
const params = (claims: VerifiedSessionClaims, options: Options) =>
  [instant(options), claims.sessionId, claims.identityId, claims.sessionVersion] as const
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
function validId(id: string) {
  if (!catalogPolicyUuidSchema.safeParse(id).success) throw new NativeCatalogImportError('invalid_input')
}
function invalid(code: string, issues?: NativeImportInvalid['issues']): NativeImportInvalid {
  return nativeImportInvalidSchema.parse({
    source: 'cloudflare',
    outcome: 'invalid',
    issues: issues?.slice(0, 100) ?? [
      {
        code,
        message:
          code === 'invalid_typed_values'
            ? 'Los atributos tipados deben usar definiciones activas y referencias a productos existentes públicos; no se admiten referencias a borradores del mismo lote.'
            : 'El lote no cumple las condiciones de importación.'
      }
    ]
  })
}
const j = (field: string, value = 'item.value') => `json_extract(${value},'$.${field}')`
function typedProducts(manifest: string) {
  return `SELECT ${j('id')} AS id,${j('categoryId')} AS category_id,${j('attributes')} AS attributes
    FROM json_each(${manifest},'$.products') item`
}
// Evaluate the complete typed predicate independently of the surrounding CAS
// tree. Embedding it in the final balanced guard would exceed D1 depth100.
export function nativeImportTypedValidityCte(sourceSql: string) {
  const { ctes, validitySql } = catalogTypedAttributeIntegrityCtes({
    sourceSql,
    mode: 'write',
    clockSql: "COALESCE(?1,'now')",
    prefix: 'intake'
  })
  return `${ctes},typed_check AS MATERIALIZED(SELECT ${validitySql} AS valid)`
}
export function nativeImportTypedGuardSql(
  table: 'catalog_native_guards' | 'catalog_import_job_guards',
  ctes: string,
  ownershipSql: string
) {
  // Fail-only CHECKs add no successful state. Kept separate from legacy full-row
  // guards to respect depth100; both execute in the same atomic D1 transaction.
  return `WITH actor AS (${actorSql}),${ctes} INSERT INTO ${table}(id,satisfied)
    SELECT ?5||':typed',0 WHERE NOT EXISTS(SELECT 1 FROM actor ${ownershipSql} AND (SELECT valid FROM typed_check)=1)`
}
export function nativeImportTypedReferenceUnusedCte(targetSql: string, externalSql: string) {
  const valid = typedAttributeEntryValiditySql({
    entrySql: 'usage.value',
    definitionAlias: 'definition',
    revisionAlias: 'revision',
    categoryIdSql: 'usage.category_id',
    productIdSql: 'usage.id',
    mode: 'historical'
  })
  // Consumers are the outer scan; callers probe the immutable target PK, not a
  // correlated 25k-row IN list. Only a valid historical reference constitutes use.
  return `namespaces AS MATERIALIZED(SELECT id,category_id,
      CASE WHEN json_valid(attributes) THEN attributes -> '$.typed' ELSE NULL END AS namespace FROM products),
    consumers AS MATERIALIZED(SELECT *,${typedAttributeNamespaceValiditySql('namespace')} AS valid FROM namespaces),
    usages AS MATERIALIZED(SELECT consumer.id,consumer.category_id,CASE WHEN entry.type='object' THEN entry.value ELSE '{}' END AS value FROM consumers consumer
      CROSS JOIN json_each(CASE WHEN consumer.valid=1 THEN consumer.namespace ELSE '{"values":[]}' END,'$.values') entry),
    validity AS MATERIALIZED(SELECT ${valid} AS valid FROM usages usage
      JOIN catalog_typed_attribute_definitions definition ON definition.id=json_extract(usage.value,'$.definitionId')
      JOIN catalog_typed_attribute_revisions revision ON revision.definition_id=definition.id
        AND revision.revision=json_extract(usage.value,'$.revision')
      WHERE definition.kind='reference' AND ${targetSql} AND ${externalSql}),
    typed_check AS MATERIALIZED(SELECT NOT EXISTS(SELECT 1 FROM validity WHERE valid=1) AS valid)`
}
function typedUnused(manifest: string) {
  const products = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.products')`
  return nativeImportTypedReferenceUnusedCte(
    `json_extract(usage.value,'$.value') IN (${products})`,
    `usage.id NOT IN (${products})`
  )
}
// SQLite counts expression-tree depth, not just the number of predicates.
// A balanced conjunction keeps full-row CAS below workerd's depth100 limit.
function and(values: string[]): string {
  if (!values.length) return '1'
  if (values.length === 1) return values[0]!
  const midpoint = Math.floor(values.length / 2)
  return `(${and(values.slice(0, midpoint))} AND ${and(values.slice(midpoint))})`
}
function references(manifest: string) {
  return `NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.products') item
 LEFT JOIN catalog_sources source ON source.id=${j('sourceId')}
 LEFT JOIN categories category ON category.id=${j('categoryId')}
 LEFT JOIN brands brand ON brand.id=${j('brandId')}
 WHERE source.id IS NULL OR source.is_master<>1 OR category.id IS NULL OR brand.id IS NULL
 OR category.status<>${j('categoryStatus')} OR brand.status<>${j('brandStatus')})
 AND NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.variants') item
 LEFT JOIN tax_classes tax ON tax.id=${j('taxClassId')} LEFT JOIN shipping_profiles shipping ON shipping.id=${j('shippingProfileId')}
 WHERE tax.id IS NULL OR shipping.id IS NULL OR ${at('tax.valid_from')} IS NULL OR ${at('tax.valid_from')}>${at(clock)}
 OR (tax.valid_until IS NOT NULL AND (${at('tax.valid_until')} IS NULL OR ${at('tax.valid_until')}<=${at(clock)}
 OR ${at('tax.valid_until')}<=${at('tax.valid_from')})))
 AND (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')=1
 AND EXISTS(SELECT 1 FROM inventory_locations WHERE id=json_extract(${manifest},'$.warehouseId') AND active=1 AND kind='warehouse')`
}
function noConflicts(manifest: string) {
  return `NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.products') item JOIN products current
 ON current.id=${j('id')} OR current.legacy_id=${j('legacyId')} OR current.slug=${j('slug')})
 AND NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.variants') item JOIN variants current
 ON current.id=${j('id')} OR current.legacy_id=${j('legacyId')} OR current.sku=${j('sku')}
 OR (current.ean IS NOT NULL AND current.ean IN (${j('ean')},${j('gtin')}))
 OR (current.gtin IS NOT NULL AND current.gtin IN (${j('ean')},${j('gtin')})))
 AND NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.assets') item JOIN media_assets current
 ON current.id=${j('id')} OR current.storage_key=${j('storageKey')} OR current.checksum_sha256=${j('checksumSha256')})
 AND NOT EXISTS(SELECT 1 FROM json_each(${manifest},'$.assets') item JOIN media_uploads current
 ON current.id=${j('id')} OR current.object_key=${j('storageKey')} OR current.checksum=${j('checksumSha256')})`
}
async function databaseIssues(database: D1Database, claims: VerifiedSessionClaims, manifest: string, options: Options) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}),${nativeImportTypedValidityCte(typedProducts('?5'))} SELECT ${references('?5')} AS refs,${noConflicts('?5')} AS unique_ok,(SELECT valid FROM typed_check) AS typed_ok FROM actor`
    )
    .bind(...params(claims, options), manifest)
    .first<{ refs: number; unique_ok: number; typed_ok: number }>()
  await authorize(database, claims, options)
  if (!row || row.refs !== 1) return invalid('reference_conflict')
  if (row.unique_ok !== 1) return invalid('catalog_identifier_conflict')
  if (row.typed_ok !== 1) return invalid('invalid_typed_values')
  return null
}
interface PreviewRow {
  id: string
  hash: string
  manifest: string
  created_at: string
  expires_at: string
  status: NativeImportPreview['status']
}
async function previewRow(database: D1Database, claims: VerifiedSessionClaims, id: string, options: Options) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT p.*,CASE
 WHEN EXISTS(SELECT 1 FROM catalog_native_commands WHERE preview_id=p.id AND action='revert') THEN 'reverted'
 WHEN EXISTS(SELECT 1 FROM catalog_native_commands WHERE preview_id=p.id AND action='apply') THEN 'applied'
 WHEN p.expires_at<=${clock} THEN 'expired' ELSE 'pending' END AS status
 FROM actor JOIN catalog_native_previews p ON p.actor_id=actor.id WHERE p.id=?5`
    )
    .bind(...params(claims, options), id)
    .first<PreviewRow>()
  await authorize(database, claims, options)
  if (!row) throw new NativeCatalogImportError('not_found')
  if ((await sha256(row.manifest)) !== row.hash) throw new Error('native_import_integrity')
  await authorize(database, claims, options)
  return row
}
function counts(manifest: Manifest) {
  return {
    products: manifest.products.length,
    variants: manifest.variants.length,
    assets: manifest.assets.length,
    mappings: manifest.media.length
  }
}
function projection(row: PreviewRow): NativeImportPreview {
  const manifest = JSON.parse(row.manifest) as Manifest
  return nativeImportPreviewSchema.parse({
    source: 'cloudflare',
    outcome: 'preview',
    id: row.id,
    hash: row.hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    counts: counts(manifest),
    policy: { publication: 'draft_only', media: 'pending_verification', priceStock: 'authorized_initialization' }
  })
}
export async function readNativeCatalogImportPreview(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  options: Options = {}
): Promise<NativeImportPreview> {
  validId(id)
  const claims = await authorize(database, input, options)
  return projection(await previewRow(database, claims, id, options))
}
export async function previewNativeCatalogImport(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  raw: unknown,
  options: Options = {}
): Promise<NativeImportPreview | NativeImportInvalid> {
  const claims = await authorize(database, input, options)
  const parsed = nativeImportInputSchema.safeParse(raw)
  if (!parsed.success) return invalid('invalid_catalog_file')
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > CATALOG_NATIVE_IMPORT_MAX_BYTES)
    return invalid('catalog_file_too_large')
  const validation = validateCatalogRecords(parsed.data.records)
  if (!validation.valid) return invalid('invalid_catalog_file', validation.issues)
  const dataset = validation.dataset
  if (
    new Set(dataset.products.map((product) => product.sourceId)).size !== 1 ||
    new Set([...dataset.products, ...dataset.variants].map((item) => item.sourceVersion)).size !== 1
  )
    return invalid('source_version_conflict')
  const identifiers = new Map<string, string>()
  for (const variant of dataset.variants) {
    try {
      validateQuantity(variant.minimumQuantity, variant)
      if (
        variant.priceGrossCents <= 0 ||
        (variant.compareAtGrossCents !== null && variant.compareAtGrossCents <= variant.priceGrossCents)
      )
        return invalid('initial_price_required')
    } catch {
      return invalid('quantity_rules_invalid')
    }
    for (const value of [variant.ean, variant.gtin]) {
      if (!value) continue
      if (identifiers.has(value) && identifiers.get(value) !== variant.id) return invalid('catalog_identifier_conflict')
      identifiers.set(value, variant.id)
    }
    if (variant.inventory.length > 1 || variant.inventory.some((balance) => balance.version !== 1))
      return invalid('initial_inventory_required')
  }
  const warehouse = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT location.id FROM actor JOIN inventory_locations location WHERE location.active=1 AND location.kind='warehouse'
   AND (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')=1`
    )
    .bind(...params(claims, options))
    .first<{ id: string }>()
  await authorize(database, claims, options)
  if (
    !warehouse ||
    dataset.variants.some((variant) => variant.inventory.some((balance) => balance.locationId !== warehouse.id))
  )
    return invalid('single_warehouse_required')
  const manifest: Manifest = {
    ...dataset,
    warehouseId: warehouse.id,
    variants: dataset.variants.map((variant) => ({
      ...variant,
      initialPriceId: crypto.randomUUID(),
      initialMovementId: crypto.randomUUID(),
      compensationMovementId: crypto.randomUUID()
    }))
  }
  let serialized: string
  try {
    serialized = JSON.stringify(catalogPolicyOwnJson(manifest))
  } catch {
    return invalid('invalid_catalog_file')
  }
  if (new TextEncoder().encode(serialized).byteLength > CATALOG_NATIVE_IMPORT_MAX_BYTES)
    return invalid('catalog_file_too_large')
  const issue = await databaseIssues(database, claims, serialized, options)
  if (issue) return issue
  const id = crypto.randomUUID(),
    hash = await sha256(serialized)
  await authorize(database, claims, options)
  try {
    await database.batch([
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_native_guards',
            nativeImportTypedValidityCte(typedProducts('?6')),
            'WHERE 1=1'
          )
        )
        .bind(...params(claims, options), id, serialized),
      database
        .prepare(
          `WITH actor AS (${actorSql}) INSERT INTO catalog_native_previews(id,actor_id,hash,manifest,created_at,expires_at)
      SELECT ?5,actor.id,?6,?7,${clock},strftime('%Y-%m-%dT%H:%M:%SZ',${clock},'+30 minutes') FROM actor
      WHERE ${references('?7')} AND ${noConflicts('?7')}`
        )
        .bind(...params(claims, options), id, hash, serialized),
      database
        .prepare(
          `WITH actor AS (${actorSql}) INSERT INTO catalog_native_guards(id,satisfied) SELECT ?5,
      CASE WHEN EXISTS(SELECT 1 FROM actor JOIN catalog_native_previews p ON p.actor_id=actor.id WHERE p.id=?5) THEN 1 ELSE 0 END`
        )
        .bind(...params(claims, options), id),
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_native_guards',
            nativeImportTypedValidityCte(typedProducts('(SELECT manifest FROM catalog_native_previews WHERE id=?5)')),
            'JOIN catalog_native_previews p ON p.actor_id=actor.id WHERE p.id=?5'
          )
        )
        .bind(...params(claims, options), id),
      database.prepare('DELETE FROM catalog_native_guards WHERE id=?').bind(id)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims, options)
    return invalid('invalid_typed_values')
  }
  return readNativeCatalogImportPreview(database, claims, id, options)
}

// Closed column lists preserve exact bytes/types for compare-and-swap recovery.
// Groups stay below D1's 32 function-argument limit.
const productColumns =
  'id,legacy_id,category_id,brand_id,source_id,name,slug,short_description,description,usage,series,status,featured,attributes,regulatory,source_version,published_at,created_at,updated_at,catalog_version'.split(
    ','
  )
const variantColumns =
  'id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,ean,gtin,mpn,identifier_exception_reason,format,status,unit_base,unit_label,content_quantity,units_per_case,cases_per_pallet,minimum_quantity,quantity_increment,maximum_quantity,price_gross_cents,compare_at_gross_cents,cost_net_cents,currency,weight_grams,width_mm,height_mm,depth_mm,safety_stock,backorder_allowed,lead_time_days,color,image,source_version,created_at,updated_at'.split(
    ','
  )
const assetColumns =
  'id,storage_key,original_name,mime_type,byte_size,checksum_sha256,owner_name,source_url,license,authorized_at,rights_status,quarantine_status,alt_text,metadata,created_at'.split(
    ','
  )
const priceColumns =
  'id,variant_id,gross_cents,compare_at_gross_cents,reference_gross_cents_30d,volume_tiers,valid_from,valid_until,status,reason,created_by,created_at,cancelled_by,cancelled_at,cancellation_reason'.split(
    ','
  )
const balanceColumns = 'variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at'.split(
  ','
)
const movementColumns =
  'id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,reason,created_at'.split(
    ','
  )
const mediaColumns = 'product_id,variant_id,asset_id,role,version,sort_order'.split(',')
function object(columns: string[], alias: string) {
  const groups: string[] = []
  for (let index = 0; index < columns.length; index += 12)
    groups.push(
      `json_object(${columns
        .slice(index, index + 12)
        .map((column) => `'${column}',${alias}.${column}`)
        .join(',')})`
    )
  // Arrays of fixed column groups retain explicit nulls: json_patch would
  // silently delete nullable keys from later groups (RFC7396 semantics).
  return groups.length === 1 ? groups[0]! : `json_array(${groups.join(',')})`
}
function state(manifest: string) {
  const variants = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.variants')`
  const products = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.products')`
  const assets = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.assets')`
  const parts = [
    ['products', 'products', productColumns, `r.id IN (${products})`, 'r.id'],
    ['variants', 'variants', variantColumns, `r.id IN (${variants})`, 'r.id'],
    ['assets', 'media_assets', assetColumns, `r.id IN (${assets})`, 'r.id'],
    [
      'media',
      'product_media',
      mediaColumns,
      `r.product_id IN (${products})`,
      'r.product_id,r.asset_id,r.role,r.version,r.variant_id'
    ],
    ['balances', 'inventory_balances', balanceColumns, `r.variant_id IN (${variants})`, 'r.variant_id,r.location_id'],
    ['prices', 'variant_price_versions', priceColumns, `r.variant_id IN (${variants})`, 'r.id'],
    ['movements', 'inventory_movements', movementColumns, `r.variant_id IN (${variants})`, 'r.id']
  ] as const
  return `json_object(${parts.map(([key, table, columns, condition, order]) => `'${key}',(SELECT json_group_array(json(item)) FROM (SELECT ${object([...columns], 'r')} AS item FROM ${table} r WHERE ${condition} ORDER BY ${order}))`).join(',')})`
}
function compensatedRows(before: string, key: string, columns: string[], changes: Record<string, string>) {
  const updates = Object.entries(changes).flatMap(([column, value]) => {
    const index = columns.indexOf(column)
    if (index < 0) throw new Error('native_import_unknown_compensation_column')
    return [`'${columns.length > 12 ? `$[${Math.floor(index / 12)}].${column}` : `$.${column}`}'`, value]
  })
  return updates.length
    ? `(SELECT json_group_array(json(json_set(item.value,${updates.join(',')}))) FROM json_each(${before},'$.${key}') item)`
    : `json_extract(${before},'$.${key}')`
}
function unused(manifest: string) {
  const variants = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.variants')`
  const products = `SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.products')`
  return `NOT EXISTS(SELECT 1 FROM cart_lines WHERE variant_id IN (${variants}))
    AND NOT EXISTS(SELECT 1 FROM checkout_quote_lines WHERE variant_id IN (${variants}))
    AND NOT EXISTS(SELECT 1 FROM inventory_reservation_lines WHERE variant_id IN (${variants}))
    AND NOT EXISTS(SELECT 1 FROM product_media_publications WHERE product_id IN (${products}))
    AND NOT EXISTS(SELECT 1 FROM product_media WHERE asset_id IN (SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.assets')) AND product_id NOT IN (${products}))
    AND NOT EXISTS(SELECT 1 FROM brands WHERE logo_asset_id IN (SELECT json_extract(value,'$.id') FROM json_each(${manifest},'$.assets')))`
}
async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: Options
) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response FROM actor JOIN catalog_native_commands c ON c.actor_id=actor.id
   WHERE c.idempotency_key=?5`
    )
    .bind(...params(claims, options), key)
    .first<{ payload_hash: string; response: string }>()
  await authorize(database, claims, options)
  if (!row) return null
  if (row.payload_hash !== hash) throw new NativeCatalogImportError('idempotency_conflict')
  return nativeImportReceiptSchema.parse(JSON.parse(row.response))
}

export async function executeNativeCatalogImportCommand(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  action: 'apply' | 'revert',
  raw: unknown,
  idempotencyKey: string,
  options: Options = {}
): Promise<NativeImportReceipt> {
  validId(id)
  const parsed = nativeImportCommandInputSchema.safeParse(raw)
  if (
    !parsed.success ||
    !['apply', 'revert'].includes(action) ||
    typeof idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)
  )
    throw new NativeCatalogImportError('invalid_input')
  const claims = await authorize(database, input, options),
    body = parsed.data
  const payloadHash = await sha256(JSON.stringify(['native-catalog.v1', id, action, body]))
  const prior = await replay(database, claims, idempotencyKey, payloadHash, options)
  if (prior) return prior
  const row = await previewRow(database, claims, id, options)
  if (row.hash !== body.previewHash) throw new NativeCatalogImportError('version_conflict')
  if (action === 'apply' && row.status !== 'pending')
    throw new NativeCatalogImportError(row.status === 'expired' ? 'preview_expired' : 'already_applied')
  if (action === 'revert' && row.status !== 'applied')
    throw new NativeCatalogImportError(row.status === 'reverted' ? 'already_reverted' : 'not_applied')
  const manifest = JSON.parse(row.manifest) as Manifest
  const commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const receipt = nativeImportReceiptSchema.parse({
    source: 'cloudflare',
    action,
    previewId: id,
    previewHash: row.hash,
    commandId,
    counts: counts(manifest),
    updated: true
  })
  const binds = [
    ...params(claims, options),
    id,
    row.hash,
    commandId,
    nonce,
    idempotencyKey,
    payloadHash,
    body.reason,
    JSON.stringify(receipt),
    action
  ]
  const condition =
    action === 'apply'
      ? `p.expires_at>${clock} AND NOT EXISTS(SELECT 1 FROM catalog_native_commands WHERE preview_id=p.id) AND ${references('p.manifest')} AND ${noConflicts('p.manifest')}`
      : `EXISTS(SELECT 1 FROM catalog_native_commands applied JOIN catalog_native_audit audit ON audit.command_id=applied.id
    WHERE applied.preview_id=p.id AND applied.action='apply' AND audit.after_state=${state('p.manifest')})
    AND NOT EXISTS(SELECT 1 FROM catalog_native_commands WHERE preview_id=p.id AND action='revert') AND ${unused('p.manifest')}`
  const typedCte = (manifest: string) =>
    action === 'apply' ? nativeImportTypedValidityCte(typedProducts(manifest)) : typedUnused(manifest)
  const claim = database
    .prepare(
      `WITH actor AS (${actorSql}) INSERT INTO catalog_native_commands(id,nonce,actor_id,preview_id,action,idempotency_key,payload_hash,reason,response,created_at)
   SELECT ?7,?8,actor.id,p.id,?13,?9,?10,?11,?12,${clock} FROM actor JOIN catalog_native_previews p ON p.actor_id=actor.id
   WHERE p.id=?5 AND p.hash=?6 AND ${condition}
   AND NOT EXISTS(SELECT 1 FROM catalog_native_commands WHERE actor_id=actor.id AND idempotency_key=?9)`
    )
    .bind(...binds)
  const withOwned = `WITH owned AS(SELECT c.*,p.manifest FROM catalog_native_commands c JOIN catalog_native_previews p ON p.id=c.preview_id WHERE c.id=?1 AND c.nonce=?2)`
  const mutations: string[] = []
  const checks: string[] = []
  const fullMatch = (
    table: string,
    columns: string[],
    mapping: Record<string, string>,
    group: string,
    idColumn = 'id'
  ) =>
    `(SELECT count(*) FROM json_each(p.manifest,'$.${group}') item JOIN ${table} r ON r.${idColumn}=${j('id')}
    WHERE ${and(columns.map((column) => `r.${column} IS ${mapping[column]}`))})=json_array_length(p.manifest,'$.${group}')`
  if (action === 'apply') {
    const productMap: Record<string, string> = {
      id: j('id'),
      legacy_id: j('legacyId'),
      category_id: j('categoryId'),
      brand_id: j('brandId'),
      source_id: j('sourceId'),
      name: j('name'),
      slug: j('slug'),
      short_description: j('shortDescription'),
      description: j('description'),
      usage: j('usage'),
      series: j('series'),
      status: "'draft'",
      featured: j('featured'),
      attributes: j('attributes'),
      regulatory: j('regulatory'),
      source_version: j('sourceVersion'),
      published_at: 'NULL',
      created_at: 'c.created_at',
      updated_at: 'c.created_at',
      catalog_version: '1'
    }
    mutations.push(
      `${withOwned} INSERT INTO products(${productColumns.join(',')}) SELECT ${productColumns.map((column) => productMap[column]).join(',')} FROM owned c,json_each(c.manifest,'$.products') item`
    )
    checks.push(fullMatch('products', productColumns, productMap, 'products'))
    const variantFields: Record<string, string> = {
      id: 'id',
      legacy_id: 'legacyId',
      product_id: 'productId',
      tax_class_id: 'taxClassId',
      shipping_profile_id: 'shippingProfileId',
      sku: 'sku',
      ean: 'ean',
      gtin: 'gtin',
      mpn: 'mpn',
      identifier_exception_reason: 'identifierExceptionReason',
      format: 'format',
      unit_base: 'unitBase',
      unit_label: 'unitLabel',
      content_quantity: 'contentQuantity',
      units_per_case: 'unitsPerCase',
      cases_per_pallet: 'casesPerPallet',
      minimum_quantity: 'minimumQuantity',
      quantity_increment: 'quantityIncrement',
      maximum_quantity: 'maximumQuantity',
      price_gross_cents: 'priceGrossCents',
      compare_at_gross_cents: 'compareAtGrossCents',
      cost_net_cents: 'costNetCents',
      currency: 'currency',
      weight_grams: 'weightGrams',
      width_mm: 'widthMm',
      height_mm: 'heightMm',
      depth_mm: 'depthMm',
      safety_stock: 'safetyStock',
      backorder_allowed: 'backorderAllowed',
      lead_time_days: 'leadTimeDays',
      color: 'color',
      image: 'image',
      source_version: 'sourceVersion'
    }
    mutations.push(
      `${withOwned} INSERT INTO variants(${variantColumns.join(',')}) SELECT ${variantColumns.map((column) => (column === 'status' ? "'draft'" : ['created_at', 'updated_at'].includes(column) ? 'c.created_at' : j(variantFields[column]!))).join(',')} FROM owned c,json_each(c.manifest,'$.variants') item`
    )
    checks.push(
      fullMatch(
        'variants',
        variantColumns,
        Object.fromEntries(
          variantColumns.map((column) => [
            column,
            column === 'status'
              ? "'draft'"
              : ['created_at', 'updated_at'].includes(column)
                ? 'c.created_at'
                : j(variantFields[column]!)
          ])
        ),
        'variants'
      )
    )
    mutations.push(`${withOwned} INSERT INTO variant_price_versions(id,variant_id,gross_cents,compare_at_gross_cents,valid_from,status,reason,created_by,created_at)
    SELECT ${j('initialPriceId')},${j('id')},${j('priceGrossCents')},${j('compareAtGrossCents')},c.created_at,'approved',c.reason,c.actor_id,c.created_at FROM owned c,json_each(c.manifest,'$.variants') item`)
    mutations.push(`${withOwned} INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
    SELECT ${j('id')},json_extract(c.manifest,'$.warehouseId'),COALESCE(${j('inventory[0].physicalQuantity')},0),COALESCE(${j('inventory[0].blockedQuantity')},0),1,c.created_at,c.created_at FROM owned c,json_each(c.manifest,'$.variants') item`)
    mutations.push(`${withOwned} INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
    SELECT ${j('initialMovementId')},${j('id')},json_extract(c.manifest,'$.warehouseId'),'initial',${j('inventory[0].physicalQuantity')},0,'catalog_native_import',c.id,c.id||':initial:'||${j('id')},c.preview_id,c.reason,c.created_at
    FROM owned c,json_each(c.manifest,'$.variants') item WHERE ${j('inventory[0].physicalQuantity')}>0`)
    const assetFields: Record<string, string> = {
      id: 'id',
      storage_key: 'storageKey',
      original_name: 'originalName',
      mime_type: 'mimeType',
      byte_size: 'byteSize',
      checksum_sha256: 'checksumSha256',
      owner_name: 'ownerName',
      source_url: 'sourceUrl',
      license: 'license',
      authorized_at: 'authorizedAt',
      alt_text: 'altText',
      metadata: 'metadata'
    }
    mutations.push(`${withOwned} INSERT INTO media_assets(${assetColumns.join(',')}) SELECT ${assetColumns.map((column) => (['rights_status', 'quarantine_status'].includes(column) ? "'pending'" : column === 'created_at' ? 'c.created_at' : j(assetFields[column]!))).join(',')}
    FROM owned c,json_each(c.manifest,'$.assets') item`)
    checks.push(
      fullMatch(
        'media_assets',
        assetColumns,
        Object.fromEntries(
          assetColumns.map((column) => [
            column,
            ['rights_status', 'quarantine_status'].includes(column)
              ? "'pending'"
              : column === 'created_at'
                ? 'c.created_at'
                : j(assetFields[column]!)
          ])
        ),
        'assets'
      )
    )
    const mediaFields: Record<string, string> = {
      product_id: 'productId',
      variant_id: 'variantId',
      asset_id: 'assetId',
      role: 'role',
      version: 'version',
      sort_order: 'sortOrder'
    }
    mutations.push(
      `${withOwned} INSERT INTO product_media(${mediaColumns.join(',')}) SELECT ${mediaColumns.map((column) => j(mediaFields[column]!)).join(',')} FROM owned c,json_each(c.manifest,'$.media') item`
    )
    for (const [entity, group] of [
      ['product', 'products'],
      ['variant', 'variants']
    ] as const) {
      mutations.push(`${withOwned} UPDATE catalog_draft_legacy_counters SET last_id=(SELECT max(json_extract(item.value,'$.legacyId'))
        FROM owned c,json_each(c.manifest,'$.${group}') item) WHERE entity='${entity}' AND last_id<(SELECT max(json_extract(item.value,'$.legacyId'))
        FROM owned c,json_each(c.manifest,'$.${group}') item)`)
      checks.push(`EXISTS(SELECT 1 FROM catalog_draft_legacy_counters counter WHERE counter.entity='${entity}'
        AND counter.last_id>=(SELECT max(json_extract(item.value,'$.legacyId')) FROM json_each(p.manifest,'$.${group}') item))`)
    }
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.media') item JOIN product_media r
      ON ${and(mediaColumns.map((column) => `r.${column} IS ${j(mediaFields[column]!)}`))})=json_array_length(p.manifest,'$.media')`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN variant_price_versions r ON r.id=${j('initialPriceId')}
      WHERE r.variant_id=${j('id')} AND r.gross_cents=${j('priceGrossCents')} AND r.compare_at_gross_cents IS ${j('compareAtGrossCents')}
      AND r.valid_from=c.created_at AND r.valid_until IS NULL AND r.status='approved' AND r.reason=c.reason
      AND r.created_by=c.actor_id AND r.created_at=c.created_at AND r.reference_gross_cents_30d IS NULL AND r.volume_tiers='[]')=json_array_length(p.manifest,'$.variants')`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN inventory_balances r ON r.variant_id=${j('id')}
      WHERE r.location_id=json_extract(p.manifest,'$.warehouseId') AND r.physical_quantity=COALESCE(${j('inventory[0].physicalQuantity')},0)
      AND r.blocked_quantity=COALESCE(${j('inventory[0].blockedQuantity')},0) AND r.version=1 AND r.created_at=c.created_at AND r.updated_at=c.created_at)=json_array_length(p.manifest,'$.variants')`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN inventory_movements r ON r.id=${j('initialMovementId')}
      WHERE r.variant_id=${j('id')} AND r.location_id=json_extract(p.manifest,'$.warehouseId') AND r.movement_type='initial'
      AND r.physical_delta=${j('inventory[0].physicalQuantity')} AND r.reserved_delta=0 AND r.reference_type='catalog_native_import'
      AND r.reference_id=c.id AND r.reason=c.reason AND r.correlation_id=c.preview_id AND r.idempotency_key=c.id||':initial:'||r.variant_id
      AND r.created_at=c.created_at)=(SELECT count(*) FROM json_each(p.manifest,'$.variants') item WHERE ${j('inventory[0].physicalQuantity')}>0)`)
    checks.push(references('p.manifest'))
  } else {
    // Compensate, do not erase the inventory/fiscal/catalogue audit history.
    mutations.push(`${withOwned} INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
    SELECT ${j('compensationMovementId')},balance.variant_id,balance.location_id,'adjustment',-balance.physical_quantity,0,'catalog_native_import',c.id,c.id||':revert:'||balance.variant_id,c.preview_id,c.reason,c.created_at
    FROM owned c,json_each(c.manifest,'$.variants') item JOIN inventory_balances balance ON balance.variant_id=${j('id')} WHERE balance.physical_quantity>0`)
    mutations.push(`${withOwned} UPDATE inventory_balances SET physical_quantity=0,blocked_quantity=0,version=version+1,updated_at=(SELECT created_at FROM owned)
    WHERE variant_id IN(SELECT json_extract(item.value,'$.id') FROM owned c,json_each(c.manifest,'$.variants') item)`)
    mutations.push(`${withOwned} UPDATE variant_price_versions SET status='cancelled',cancelled_by=(SELECT actor_id FROM owned),cancelled_at=(SELECT created_at FROM owned),cancellation_reason=(SELECT reason FROM owned)
    WHERE id IN(SELECT json_extract(item.value,'$.initialPriceId') FROM owned c,json_each(c.manifest,'$.variants') item)`)
    mutations.push(`${withOwned} UPDATE variants SET status='discontinued',price_gross_cents=0,compare_at_gross_cents=NULL,updated_at=(SELECT created_at FROM owned)
    WHERE id IN(SELECT json_extract(item.value,'$.id') FROM owned c,json_each(c.manifest,'$.variants') item)`)
    mutations.push(`${withOwned} UPDATE products SET status='discontinued',catalog_version=catalog_version+1,updated_at=(SELECT created_at FROM owned)
    WHERE id IN(SELECT json_extract(item.value,'$.id') FROM owned c,json_each(c.manifest,'$.products') item)`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN inventory_balances r ON r.variant_id=${j('id')}
      WHERE r.location_id=json_extract(p.manifest,'$.warehouseId') AND r.physical_quantity=0 AND r.blocked_quantity=0 AND r.version=2
      AND r.updated_at=c.created_at)=json_array_length(p.manifest,'$.variants')`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN variant_price_versions r ON r.id=${j('initialPriceId')}
      WHERE r.status='cancelled' AND r.cancelled_by=c.actor_id AND r.cancelled_at=c.created_at AND r.cancellation_reason=c.reason)=json_array_length(p.manifest,'$.variants')`)
    checks.push(`(SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN inventory_movements r ON r.id=${j('compensationMovementId')}
      WHERE r.variant_id=${j('id')} AND r.location_id=json_extract(p.manifest,'$.warehouseId') AND r.movement_type='adjustment'
      AND r.physical_delta=-${j('inventory[0].physicalQuantity')} AND r.reserved_delta=0 AND r.reference_type='catalog_native_import'
      AND r.reference_id=c.id AND r.reason=c.reason AND r.correlation_id=c.preview_id AND r.created_at=c.created_at)
      =(SELECT count(*) FROM json_each(p.manifest,'$.variants') item WHERE ${j('inventory[0].physicalQuantity')}>0)`)
    checks.push(unused('p.manifest'))
    // Compare every retained field, not merely cancelled/discontinued flags.
    // A trigger which changes descriptions, costs, IDs or media metadata must
    // not turn an exact compensating rollback into an unreviewed new edit.
    const compensation = [
      ['products', productColumns, { status: "'discontinued'", catalog_version: '2', updated_at: 'c.created_at' }],
      [
        'variants',
        variantColumns,
        { status: "'discontinued'", price_gross_cents: '0', compare_at_gross_cents: 'NULL', updated_at: 'c.created_at' }
      ],
      ['assets', assetColumns, {}],
      ['media', mediaColumns, {}],
      [
        'balances',
        balanceColumns,
        { physical_quantity: '0', blocked_quantity: '0', version: '2', updated_at: 'c.created_at' }
      ],
      [
        'prices',
        priceColumns,
        {
          status: "'cancelled'",
          cancelled_by: 'c.actor_id',
          cancelled_at: 'c.created_at',
          cancellation_reason: 'c.reason'
        }
      ]
    ] as const
    for (const [key, columns, changes] of compensation) {
      checks.push(
        `json_extract(audit.after_state,'$.${key}')=${compensatedRows('audit.before_state', key, [...columns], changes)}`
      )
    }
    checks.push(`(SELECT json_group_array(json(item.value)) FROM json_each(audit.after_state,'$.movements') item
      WHERE json_extract(item.value,'$.reference_id')=(SELECT id FROM catalog_native_commands WHERE preview_id=p.id AND action='apply'))
      =json_extract(audit.before_state,'$.movements')`)
  }
  const audit = database
    .prepare(
      `${withOwned} INSERT INTO catalog_native_audit(command_id,before_state,after_state)
   SELECT c.id,${action === 'apply' ? 'NULL' : "(SELECT a.after_state FROM catalog_native_commands prior JOIN catalog_native_audit a ON a.command_id=prior.id WHERE prior.preview_id=c.preview_id AND prior.action='apply')"},${state('c.manifest')} FROM owned c`
    )
    .bind(commandId, nonce)
  const expected =
    action === 'apply'
      ? `(SELECT count(*) FROM json_each(p.manifest,'$.products') item JOIN products r ON r.id=${j('id')} AND r.status='draft')=json_array_length(p.manifest,'$.products')
   AND (SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN variants r ON r.id=${j('id')} AND r.status='draft')=json_array_length(p.manifest,'$.variants')
   AND (SELECT count(*) FROM json_each(p.manifest,'$.assets') item JOIN media_assets r ON r.id=${j('id')} AND r.rights_status='pending' AND r.quarantine_status='pending')=json_array_length(p.manifest,'$.assets')`
      : `(SELECT count(*) FROM json_each(p.manifest,'$.products') item JOIN products r ON r.id=${j('id')} AND r.status='discontinued')=json_array_length(p.manifest,'$.products')
   AND (SELECT count(*) FROM json_each(p.manifest,'$.variants') item JOIN variants r ON r.id=${j('id')} AND r.status='discontinued' AND r.price_gross_cents=0)=json_array_length(p.manifest,'$.variants')`
  const guard = database
    .prepare(
      `WITH actor AS (${actorSql}) INSERT INTO catalog_native_guards(id,satisfied) SELECT ?5,
   CASE WHEN EXISTS(SELECT 1 FROM actor JOIN catalog_native_commands c ON c.actor_id=actor.id JOIN catalog_native_previews p ON p.id=c.preview_id
   JOIN catalog_native_audit audit ON audit.command_id=c.id WHERE c.id=?5 AND c.nonce=?6 AND ${expected} AND ${and(checks)}
   AND audit.after_state=${state('p.manifest')}) THEN 1 ELSE 0 END`
    )
    .bind(...params(claims, options), commandId, nonce)
  try {
    await database.batch([
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_native_guards',
            typedCte('(SELECT manifest FROM catalog_native_previews WHERE id=?5)'),
            'JOIN catalog_native_previews p ON p.actor_id=actor.id WHERE p.id=?5'
          )
        )
        .bind(...params(claims, options), row.id),
      claim,
      ...mutations.map((sql) => database.prepare(sql).bind(commandId, nonce)),
      audit,
      guard,
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_native_guards',
            typedCte(
              '(SELECT p.manifest FROM catalog_native_commands c JOIN catalog_native_previews p ON p.id=c.preview_id WHERE c.id=?5 AND c.nonce=?6)'
            ),
            'JOIN catalog_native_commands c ON c.actor_id=actor.id WHERE c.id=?5 AND c.nonce=?6'
          )
        )
        .bind(...params(claims, options), commandId, nonce),
      database.prepare('DELETE FROM catalog_native_guards WHERE id=?').bind(commandId)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims, options)
    const raced = await replay(database, claims, idempotencyKey, payloadHash, options)
    if (raced) return raced
    throw new NativeCatalogImportError('version_conflict')
  }
  await authorize(database, claims, options)
  return receipt
}

// Same current authority and hashing boundaries for the paginated workspace.
// These exports grant no authority to the caller's file or a stored preview.
export {
  actorSql as nativeImportActorSql,
  authorize as authorizeNativeCatalogImport,
  params as nativeImportParameters,
  sha256 as nativeImportSha256,
  invalid as nativeImportInvalidResult,
  productColumns as nativeImportProductColumns,
  variantColumns as nativeImportVariantColumns,
  assetColumns as nativeImportAssetColumns,
  mediaColumns as nativeImportMediaColumns,
  priceColumns as nativeImportPriceColumns,
  balanceColumns as nativeImportBalanceColumns,
  movementColumns as nativeImportMovementColumns,
  object as nativeImportRowObject,
  and as nativeImportConjunction
}
