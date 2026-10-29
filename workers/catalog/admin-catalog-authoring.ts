import { z } from 'zod'
import {
  catalogDraftAuthoringActionSchema,
  catalogDraftAuthoringReceiptSchema,
  createDraftInputSchema,
  assignBrandInputSchema,
  createVariantInputSchema,
  updateVariantInputSchema,
  discontinueVariantInputSchema,
  draftVariantInputSchema,
  type CatalogDraftAuthoringAction,
  type CatalogDraftAuthoringReceipt,
  type CreateDraftInput,
  type AssignBrandInput,
  type CreateVariantInput,
  type UpdateVariantInput,
  type DiscontinueVariantInput,
  type DraftVariantInput
} from '../../shared/catalog-draft-authoring'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema,
  catalogPolicyInstantSchema
} from '../../shared/catalog-publication-policy'
import { validateQuantity, selectVolumeUnitPrice } from '../../server/domain/money'
import { slugify } from '../../server/utils/slug'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export class CatalogDraftAuthoringError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'product_not_editable'
      | 'variant_not_editable'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'reference_unavailable'
      | 'quantity_conflict'
      | 'variant_limit'
      | 'conflict'
  ) {
    super(code)
  }
}
type Command =
  | { action: 'create_draft'; body: CreateDraftInput }
  | { action: 'assign_brand'; body: AssignBrandInput }
  | { action: 'create_variant'; body: CreateVariantInput }
  | { action: 'update_variant'; body: UpdateVariantInput }
  | { action: 'discontinue_variant'; body: DiscontinueVariantInput }
const safeId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const legacy = z
  .string()
  .max(16)
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(Number(value)) === value)
function checked<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(value)
  } catch {
    throw new CatalogDraftAuthoringError(code)
  }
  const parsed = schema.safeParse(plain)
  if (!parsed.success) throw new CatalogDraftAuthoringError(code)
  return parsed.data
}
function command(action: CatalogDraftAuthoringAction, input: unknown): Command {
  switch (action) {
    case 'create_draft':
      return { action, body: checked(createDraftInputSchema, input) }
    case 'assign_brand':
      return { action, body: checked(assignBrandInputSchema, input) }
    case 'create_variant':
      return { action, body: checked(createVariantInputSchema, input) }
    case 'update_variant':
      return { action, body: checked(updateVariantInputSchema, input) }
    case 'discontinue_variant':
      return { action, body: checked(discontinueVariantInputSchema, input) }
  }
}
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
  WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
    AND s.created_at<=${clock} AND s.expires_at>${clock} AND s.mfa_verified=1
    AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
    AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
      WHERE assigned.identity_id=i.id AND granted.permission_code=?5 AND assigned.granted_at<=${clock}
        AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
function actorParameters(claims: VerifiedSessionClaims, now?: string) {
  return [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, 'catalog.write'] as const
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  const result = await authorizeD1Session(database, claims, 'catalog.write', {
    requireMfa: true,
    ...(now === undefined ? {} : { now })
  })
  if (!result.allowed) throw new CatalogDraftAuthoringError(result.code)
}
const productColumns = [
  'id',
  'legacy_id',
  'category_id',
  'brand_id',
  'source_id',
  'name',
  'slug',
  'short_description',
  'description',
  'usage',
  'series',
  'status',
  'featured',
  'attributes',
  'regulatory',
  'source_version',
  'published_at',
  'created_at',
  'updated_at',
  'catalog_version'
] as const
const variantColumns = [
  'id',
  'legacy_id',
  'product_id',
  'tax_class_id',
  'shipping_profile_id',
  'sku',
  'ean',
  'gtin',
  'mpn',
  'format',
  'status',
  'unit_base',
  'unit_label',
  'content_quantity',
  'units_per_case',
  'cases_per_pallet',
  'minimum_quantity',
  'quantity_increment',
  'maximum_quantity',
  'price_gross_cents',
  'compare_at_gross_cents',
  'cost_net_cents',
  'currency',
  'weight_grams',
  'width_mm',
  'height_mm',
  'depth_mm',
  'safety_stock',
  'backorder_allowed',
  'lead_time_days',
  'color',
  'image',
  'source_version',
  'created_at',
  'updated_at'
] as const
const variantFields = {
  sku: 'sku',
  format: 'format',
  ean: 'ean',
  gtin: 'gtin',
  mpn: 'mpn',
  taxClassId: 'tax_class_id',
  shippingProfileId: 'shipping_profile_id',
  unitBase: 'unit_base',
  unitLabel: 'unit_label',
  contentQuantity: 'content_quantity',
  unitsPerCase: 'units_per_case',
  casesPerPallet: 'cases_per_pallet',
  minimumQuantity: 'minimum_quantity',
  quantityIncrement: 'quantity_increment',
  maximumQuantity: 'maximum_quantity',
  weightGrams: 'weight_grams',
  widthMm: 'width_mm',
  heightMm: 'height_mm',
  depthMm: 'depth_mm',
  backorderAllowed: 'backorder_allowed',
  leadTimeDays: 'lead_time_days',
  color: 'color'
} as const
/** Grouped JSON objects preserve nulls, and keep each function below D1's 32
 * argument limit. Unlike json_patch, assembling groups never deletes null keys. */
function rowObject(columns: readonly string[], alias: string, overrides: Readonly<Record<string, string>> = {}) {
  const groups: string[] = []
  for (let offset = 0; offset < columns.length; offset += 12)
    groups.push(
      `json_object(${columns
        .slice(offset, offset + 12)
        .map((column) => `'${column}',${overrides[column] ?? `${alias}.${column}`}`)
        .join(',')})`
    )
  return `json_array(${groups.join(',')})`
}
function groupedRow(value: unknown): Record<string, unknown> {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  )
    throw new Error('catalog_draft_source_invalid')
  return Object.assign(Object.create(null), ...value)
}
function sourceJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('catalog_draft_source_invalid')
  }
}
const owned =
  'c.id=?12 AND c.claim_nonce=?13 AND c.actor_id=?3 AND c.action=?6 AND c.idempotency_key=?10 AND c.payload_hash=?11 AND c.target=?21 AND c.input=?9'
const auditColumns =
  'actor_id,action,target,input,product_id,product_uuid,variant_id,variant_uuid,expected_version,result_version,reason,before_state,after_state,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((column) => `a.${column} IS c.${column}`)
  .concat('a.command_id=c.id')
  .join(' AND ')
function receipt(raw: string): CatalogDraftAuthoringReceipt {
  const parsed = sourceJson(raw),
    checkedReceipt = catalogDraftAuthoringReceiptSchema.safeParse(parsed)
  if (
    !checkedReceipt.success ||
    !parsed ||
    typeof parsed !== 'object' ||
    Object.keys(parsed).join(',') !== 'source,action,productId,productUuid,variantId,variantUuid,catalogVersion,updated'
  )
    throw new Error('catalog_draft_receipt_invalid')
  return parsed as CatalogDraftAuthoringReceipt
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,
    EXISTS(SELECT 1 FROM catalog_draft_authoring_audit a WHERE ${auditMatch}) AS completed
    FROM actor JOIN catalog_draft_authoring_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?6`
    )
    .bind(...actorParameters(claims, now), key)
    .first<{ payload_hash: string; response: string; completed: number }>()
  await authorize(database, claims, now)
  if (!row) return null
  if (row.payload_hash !== hash) throw new CatalogDraftAuthoringError('idempotency_conflict')
  if (row.completed !== 1) throw new CatalogDraftAuthoringError('conflict')
  return receipt(row.response)
}
const j = (field: string) => `json_extract(?9,'$.${field}')`
const expected = j('expectedVersion')
interface Context {
  productId: number
  productUuid: string
  variantId: number | null
  variantUuid: string | null
  category: string
  brand: string
  tax: string | null
  shipping: string | null
  location: string | null
  slug: string
  mergedVariant: DraftVariantInput | null
  before: string
}
type Target = { productId?: string; variantId?: string }
async function context(
  database: D1Database,
  claims: VerifiedSessionClaims,
  cmd: Command,
  target: Target,
  now?: string
): Promise<Context> {
  const creating = cmd.action === 'create_draft',
    newVariant = creating || cmd.action === 'create_variant'
  const product = creating
    ? null
    : await database
        .prepare('SELECT * FROM products WHERE legacy_id=?1')
        .bind(Number(target.productId))
        .first<Record<string, unknown>>()
  await authorize(database, claims, now)
  if (!creating && !product) throw new CatalogDraftAuthoringError('not_found')
  if (
    product &&
    (!catalogPolicyUuidSchema.safeParse(product.id).success ||
      !safeId.safeParse(product.legacy_id).success ||
      !safeId.safeParse(product.catalog_version).success)
  )
    throw new Error('catalog_draft_source_invalid')
  if (product && product.status !== 'draft') throw new CatalogDraftAuthoringError('product_not_editable')
  if (product && product.catalog_version !== cmd.body.expectedVersion)
    throw new CatalogDraftAuthoringError('version_conflict')
  const variant =
    cmd.action === 'update_variant' || cmd.action === 'discontinue_variant'
      ? await database
          .prepare('SELECT * FROM variants WHERE legacy_id=?1 AND product_id=?2')
          .bind(Number(target.variantId), product!.id)
          .first<Record<string, unknown>>()
      : null
  if ((cmd.action === 'update_variant' || cmd.action === 'discontinue_variant') && !variant)
    throw new CatalogDraftAuthoringError('not_found')
  if (variant && variant.status === 'discontinued') throw new CatalogDraftAuthoringError('variant_not_editable')
  if (
    variant &&
    (!catalogPolicyUuidSchema.safeParse(variant.id).success || !safeId.safeParse(variant.legacy_id).success)
  )
    throw new Error('catalog_draft_source_invalid')
  let mergedVariant: DraftVariantInput | null = null
  if (creating) mergedVariant = cmd.body.initialVariant
  if (cmd.action === 'create_variant') {
    mergedVariant = draftVariantInputSchema.parse(
      Object.fromEntries(Object.keys(variantFields).map((field) => [field, Reflect.get(cmd.body, field)]))
    )
  }
  if (cmd.action === 'update_variant') {
    const values: Record<string, unknown> = Object.create(null)
    for (const [field, column] of Object.entries(variantFields))
      values[field] = field === 'backorderAllowed' ? variant![column] === 1 : variant![column]
    for (const field of Object.keys(variantFields))
      if (Object.hasOwn(cmd.body, field)) values[field] = Reflect.get(cmd.body, field)
    const parsed = draftVariantInputSchema.safeParse(values)
    if (!parsed.success) throw new CatalogDraftAuthoringError('quantity_conflict')
    mergedVariant = parsed.data
  }
  const categoryRow = await database
    .prepare(creating ? 'SELECT id FROM categories WHERE legacy_id=?1' : 'SELECT id FROM categories WHERE id=?1')
    .bind(creating ? cmd.body.categoryId : product!.category_id)
    .first<{ id: string }>()
  const brand = creating || cmd.action === 'assign_brand' ? cmd.body.brandId : product!.brand_id
  if (
    !categoryRow ||
    !catalogPolicyUuidSchema.safeParse(categoryRow.id).success ||
    !catalogPolicyUuidSchema.safeParse(brand).success
  )
    throw new CatalogDraftAuthoringError('reference_unavailable')
  const counter = async (entity: 'product' | 'variant') => {
    const row = await database
      .prepare(
        `SELECT max(last_id,COALESCE((SELECT max(legacy_id) FROM ${entity === 'product' ? 'products' : 'variants'}),0)) AS maximum
      FROM catalog_draft_legacy_counters WHERE entity=?1`
      )
      .bind(entity)
      .first<{ maximum: number }>()
    if (!row || !Number.isSafeInteger(row.maximum) || row.maximum < 0 || row.maximum >= Number.MAX_SAFE_INTEGER)
      throw new CatalogDraftAuthoringError('conflict')
    return row.maximum + 1
  }
  const productId = creating ? await counter('product') : Number(product!.legacy_id)
  const variantId = newVariant ? await counter('variant') : variant ? Number(variant.legacy_id) : null
  const productUuid = creating ? crypto.randomUUID() : String(product!.id)
  let slug = creating ? slugify(cmd.body.name) || 'producto' : String(product!.slug)
  if (creating && (await database.prepare('SELECT 1 AS present FROM products WHERE slug=?1').bind(slug).first())) {
    slug = `${slug}-${productId}`
    if (await database.prepare('SELECT 1 AS present FROM products WHERE slug=?1').bind(slug).first())
      slug = `${slug}-${productUuid.slice(0, 8)}`
  }
  const location = newVariant
    ? await database
        .prepare("SELECT min(id) AS id,count(*) AS total FROM inventory_locations WHERE active=1 AND kind='warehouse'")
        .first<{ id: string | null; total: number }>()
    : null
  if (newVariant && (!location || location.total !== 1 || typeof location.id !== 'string'))
    throw new CatalogDraftAuthoringError('reference_unavailable')
  const ctx: Context = {
    productId,
    productUuid,
    variantId,
    variantUuid: newVariant ? crypto.randomUUID() : variant ? String(variant.id) : null,
    category: categoryRow.id,
    brand: String(brand),
    tax: mergedVariant?.taxClassId ?? (variant ? String(variant.tax_class_id) : null),
    shipping: mergedVariant?.shippingProfileId ?? (variant ? String(variant.shipping_profile_id) : null),
    location: location?.id ?? null,
    slug,
    mergedVariant,
    before: ''
  }
  const parameters = parametersFor(claims, cmd, target, ctx, 'preflight', '0'.repeat(64), now)
  const execution = plan(cmd)
  const row = await database
    .prepare(
      `${withActor} SELECT ${execution.before} AS snapshot,(${execution.pre}) AS eligible,(${execution.refsValid}) AS referencesAvailable FROM actor`
    )
    .bind(...parameters)
    .first<{ snapshot: string; eligible: number; referencesAvailable: number }>()
  await authorize(database, claims, now)
  if (!row || typeof row.snapshot !== 'string') throw new Error('catalog_draft_source_invalid')
  ctx.before = row.snapshot
  const source = z
    .object({
      variants: z.array(z.unknown()),
      prices: z.array(z.unknown()),
      reservations: z.array(z.unknown()),
      references: z.object({
        category: z.unknown(),
        brand: z.unknown(),
        tax: z.unknown(),
        shipping: z.unknown(),
        location: z.unknown()
      })
    })
    .parse(sourceJson(row.snapshot))
  if (source.variants.length > 500 || (newVariant && source.variants.length >= 500))
    throw new CatalogDraftAuthoringError('variant_limit')
  if (
    cmd.action === 'discontinue_variant' &&
    source.variants.map(groupedRow).filter((item) => item.status !== 'discontinued').length <= 1
  )
    throw new CatalogDraftAuthoringError('variant_not_editable')
  if ((cmd.action === 'update_variant' || cmd.action === 'discontinue_variant') && source.reservations.length)
    throw new CatalogDraftAuthoringError('quantity_conflict')
  if (cmd.action === 'update_variant') {
    for (const item of source.prices) {
      const price = z
        .object({
          status: z.string(),
          valid_until: z.string().nullable(),
          gross_cents: safeId,
          volume_tiers: z.string()
        })
        .parse(item)
      if (
        price.status !== 'approved' ||
        (price.valid_until !== null && Date.parse(price.valid_until) <= Date.parse(now ?? new Date().toISOString()))
      )
        continue
      const tiers = z
        .array(
          z
            .object({ minimumQuantity: safeId, unitGrossCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
            .strict()
        )
        .max(500)
        .parse(sourceJson(price.volume_tiers))
      try {
        selectVolumeUnitPrice(price.gross_cents, mergedVariant!.minimumQuantity, tiers)
        for (const tier of tiers) {
          if (tier.minimumQuantity <= mergedVariant!.minimumQuantity) throw new Error('tier_moq')
          validateQuantity(tier.minimumQuantity, mergedVariant!)
        }
      } catch {
        throw new CatalogDraftAuthoringError('quantity_conflict')
      }
    }
  }
  if (row.referencesAvailable !== 1) throw new CatalogDraftAuthoringError('reference_unavailable')
  if (row.eligible !== 1) throw new CatalogDraftAuthoringError('conflict')
  return ctx
}
const withActor = `WITH params AS (SELECT ?24 AS value),actor AS (${actorSql})`
function parametersFor(
  claims: VerifiedSessionClaims,
  cmd: Command,
  target: Target,
  ctx: Context,
  key: string,
  hash: string,
  now?: string
) {
  return [
    ...actorParameters(claims, now),
    cmd.action,
    ctx.productId,
    ctx.variantId,
    JSON.stringify(cmd.body),
    key,
    hash,
    crypto.randomUUID(),
    crypto.randomUUID(),
    ctx.productUuid,
    ctx.variantUuid,
    ctx.category,
    ctx.brand,
    ctx.tax,
    ctx.shipping,
    ctx.location,
    JSON.stringify(target),
    ctx.before,
    ctx.slug,
    ctx.mergedVariant ? JSON.stringify(ctx.mergedVariant) : null
  ]
}
function plan(cmd: Command) {
  const creating = cmd.action === 'create_draft',
    adding = creating || cmd.action === 'create_variant',
    editing = cmd.action === 'update_variant'
  const bodyPath = creating ? 'initialVariant.' : ''
  const variantOverrides: Record<string, string> = {}
  for (const [field, column] of Object.entries(variantFields)) {
    if (adding || (editing && Object.hasOwn(cmd.body, field))) {
      const value = j(`${bodyPath}${field}`)
      variantOverrides[column] = field === 'contentQuantity' ? `CAST(${value} AS REAL)` : value
    }
  }
  const newVariant: Record<string, string> = {
    ...variantOverrides,
    id: '?15',
    legacy_id: 'CAST(?8 AS INTEGER)',
    product_id: '?14',
    status: "'draft'",
    price_gross_cents: '0',
    compare_at_gross_cents: 'NULL',
    cost_net_cents: 'NULL',
    currency: "'EUR'",
    safety_stock: '0',
    image: 'NULL',
    source_version: "'d1-authoring-v1'",
    created_at: clock,
    updated_at: clock
  }
  const productOverrides: Record<string, string> = {
    updated_at: clock,
    catalog_version: `CAST(${expected}+1 AS INTEGER)`
  }
  if (cmd.action === 'assign_brand') productOverrides.brand_id = '?17'
  const newProduct: Record<string, string> = {
    id: '?14',
    legacy_id: 'CAST(?7 AS INTEGER)',
    category_id: '?16',
    brand_id: '?17',
    source_id: 'NULL',
    name: j('name'),
    slug: '?23',
    short_description: j('shortDesc'),
    description: j('description'),
    usage: j('usage'),
    series: j('series'),
    status: "'draft'",
    featured: j('featured'),
    attributes: `(json_object('badges',json_extract(?9,'$.badges'),'visual',json_extract(?9,'$.visual'),'attrs',json_extract(?9,'$.attrs')) || '')`,
    regulatory: "'{}'",
    source_version: "'d1-authoring-v1'",
    published_at: 'NULL',
    created_at: clock,
    updated_at: clock,
    catalog_version: '1'
  }
  const refs = `json_object('category',(SELECT json_object('id',id,'legacy_id',legacy_id,'status',status,'parent_id',parent_id) FROM categories WHERE id=?16),
    'brand',(SELECT json_object('id',id,'status',status) FROM brands WHERE id=?17),
    'tax',(SELECT json_object('id',id,'rate',rate_basis_points,'valid_from',valid_from,'valid_until',valid_until) FROM tax_classes WHERE id=?18),
    'shipping',(SELECT json_object('id',id,'kind',kind,'adr_data',adr_data,'constraints',constraints) FROM shipping_profiles WHERE id=?19),
    'location',(SELECT json_object('id',id,'active',active,'kind',kind,'total',(SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')) FROM inventory_locations WHERE id=?20))`
  const priceColumns = [
    'id',
    'variant_id',
    'gross_cents',
    'compare_at_gross_cents',
    'reference_gross_cents_30d',
    'volume_tiers',
    'valid_from',
    'valid_until',
    'status',
    'reason',
    'created_by',
    'created_at',
    'cancelled_by',
    'cancelled_at',
    'cancellation_reason'
  ]
  const prices = `(SELECT json_group_array(json(item)) FROM (SELECT json_object(${priceColumns.map((column) => `'${column}',price.${column}`).join(',')}) AS item FROM variant_price_versions price WHERE variant_id=?15 ORDER BY id))`
  const reservations = `(SELECT json_group_array(json(item)) FROM (SELECT json_object('id',r.id,'status',r.status,'quantity',line.quantity,'location',line.location_id,'expires_at',r.expires_at) AS item
    FROM inventory_reservations r JOIN inventory_reservation_lines line ON line.reservation_id=r.id WHERE line.variant_id=?15 AND r.status='reserved' ORDER BY r.id,line.location_id))`
  const movementColumns = [
    'id',
    'variant_id',
    'location_id',
    'movement_type',
    'physical_delta',
    'reserved_delta',
    'reference_type',
    'reference_id',
    'idempotency_key',
    'correlation_id',
    'reason',
    'created_at'
  ]
  const movements = `(SELECT json_group_array(json(item)) FROM (SELECT json_object(${movementColumns.map((column) => `'${column}',m.${column}`).join(',')}) AS item FROM inventory_movements m WHERE m.variant_id=?15 ORDER BY m.id))`
  const balances = `(SELECT json_group_array(json(item)) FROM (SELECT json_object('variant_id',variant_id,'location_id',location_id,'physical_quantity',physical_quantity,'blocked_quantity',blocked_quantity,'version',version,'created_at',created_at,'updated_at',updated_at) AS item FROM inventory_balances WHERE variant_id=?15 ORDER BY location_id))`
  const balanceAfter = adding
    ? `json_array(json_object('variant_id',?15,'location_id',?20,'physical_quantity',0,'blocked_quantity',0,'version',1,'created_at',${clock},'updated_at',${clock}))`
    : balances
  const state = (after: boolean) => {
    const product =
      creating && after
        ? rowObject(productColumns, 'p', newProduct)
        : `(SELECT ${rowObject(productColumns, 'p', after ? productOverrides : {})} FROM products p WHERE p.id=?14)`
    let variantObject = rowObject(variantColumns, 'v')
    if (after && (editing || cmd.action === 'discontinue_variant'))
      variantObject = `CASE WHEN v.id=?15 THEN ${rowObject(variantColumns, 'v', {
        ...(editing ? variantOverrides : { status: "'discontinued'" }),
        updated_at: clock
      })} ELSE ${variantObject} END`
    const variants = `(SELECT json_group_array(json(item)) FROM (SELECT v.id AS sort_id,${variantObject} AS item FROM variants v WHERE v.product_id=?14
      ${after && adding ? `UNION ALL SELECT ?15,${rowObject(variantColumns, 'v', newVariant)}` : ''} ORDER BY sort_id))`
    return `json_object('product',${product},'variants',${variants},'references',${refs},'prices',${prices},'balances',${after ? balanceAfter : balances},'reservations',${reservations},'movements',${movements})`
  }
  const before = state(false),
    predicted = state(true)
  // The actual post-state reads persisted values, not newly predicted values.
  const after = before
  const refsValid = `EXISTS(SELECT 1 FROM categories WHERE id=?16 AND legacy_id BETWEEN 1 AND 9007199254740991 AND status<>'discontinued')
    AND EXISTS(SELECT 1 FROM brands WHERE id=?17 AND status<>'archived')
    ${
      cmd.action !== 'assign_brand'
        ? `AND EXISTS(SELECT 1 FROM tax_classes WHERE id=?18 AND rate_basis_points BETWEEN 0 AND 10000
      AND strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)<=strftime('%Y-%m-%dT%H:%M:%fZ',${clock})
      AND (valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)>strftime('%Y-%m-%dT%H:%M:%fZ',${clock})))
      AND EXISTS(SELECT 1 FROM shipping_profiles WHERE id=?19)`
        : ''
    }
    ${adding ? "AND EXISTS(SELECT 1 FROM inventory_locations WHERE id=?20 AND active=1 AND kind='warehouse') AND (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse')=1" : ''}`
  const availableIds = `${adding ? `NOT EXISTS(SELECT 1 FROM variants WHERE id=?15 OR legacy_id=?8 OR sku=${j(`${bodyPath}sku`)})` : '1'}
    ${creating ? 'AND NOT EXISTS(SELECT 1 FROM products WHERE id=?14 OR legacy_id=?7 OR slug=?23)' : ''}`
  const reserveFree =
    editing || cmd.action === 'discontinue_variant'
      ? `AND NOT EXISTS(SELECT 1 FROM inventory_reservations r JOIN inventory_reservation_lines line ON line.reservation_id=r.id WHERE line.variant_id=?15 AND r.status='reserved')`
      : ''
  const productPre = creating
    ? '1'
    : `EXISTS(SELECT 1 FROM products WHERE id=?14 AND legacy_id=?7 AND status='draft' AND catalog_version=${expected})`
  const variantPre =
    editing || cmd.action === 'discontinue_variant'
      ? "AND EXISTS(SELECT 1 FROM variants WHERE id=?15 AND legacy_id=?8 AND product_id=?14 AND status<>'discontinued')"
      : ''
  const countPre = adding
    ? 'AND (SELECT count(*) FROM variants WHERE product_id=?14)<500'
    : cmd.action === 'discontinue_variant'
      ? "AND (SELECT count(*) FROM variants WHERE product_id=?14 AND status<>'discontinued')>1"
      : ''
  const pre = `${refsValid} AND ${productPre} ${variantPre} ${countPre} AND ${availableIds} ${reserveFree}`
  const post = `${refsValid} AND EXISTS(SELECT 1 FROM products WHERE id=?14 AND legacy_id=?7 AND status='draft' AND catalog_version=${expected}+1) ${reserveFree}
    ${cmd.action === 'assign_brand' ? '' : `AND EXISTS(SELECT 1 FROM variants WHERE id=?15 AND legacy_id=?8 AND product_id=?14 AND status=${cmd.action === 'discontinue_variant' ? "'discontinued'" : adding ? "'draft'" : "(SELECT json_extract(item.value,'$[0].status') FROM catalog_draft_authoring_commands command,json_each(command.before_state,'$.variants') item WHERE command.id=?12 AND json_extract(item.value,'$[0].id')=?15)"})`}`
  const ownedCte = `${withActor},owned AS MATERIALIZED(SELECT c.* FROM actor JOIN catalog_draft_authoring_commands c ON c.actor_id=actor.id WHERE ${owned})`
  const liveBefore = `${ownedCte} `
  const domain: string[] = []
  if (creating)
    domain.push(`${liveBefore} UPDATE catalog_draft_legacy_counters SET last_id=?7 WHERE entity='product'
    AND max(last_id,COALESCE((SELECT max(legacy_id) FROM products),0))=?7-1 AND EXISTS(SELECT 1 FROM owned c WHERE (${pre}) AND c.before_state=${before})`)
  if (adding)
    domain.push(`${liveBefore} UPDATE catalog_draft_legacy_counters SET last_id=?8 WHERE entity='variant'
    AND max(last_id,COALESCE((SELECT max(legacy_id) FROM variants),0))=?8-1 AND EXISTS(SELECT 1 FROM owned c WHERE (${pre}) AND c.before_state=${before})`)
  const allocated = `${creating ? "AND (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='product')=?7" : ''} ${adding ? "AND (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='variant')=?8" : ''}`
  if (creating)
    domain.push(`${liveBefore} INSERT INTO products(${productColumns.join(',')}) SELECT ${productColumns.map((column) => (newProduct[column] === clock ? 'c.created_at' : newProduct[column])).join(',')} FROM owned c
    WHERE (${pre}) AND c.before_state=${before} ${allocated}`)
  else
    domain.push(`${liveBefore} UPDATE products AS p SET ${Object.entries(productOverrides)
      .map(([column, value]) => `${column}=${value === clock ? '(SELECT created_at FROM owned)' : value}`)
      .join(',')}
    WHERE p.id=?14 AND p.catalog_version=${expected} AND EXISTS(SELECT 1 FROM owned c WHERE (${pre}) AND c.before_state=${before} ${allocated})`)
  const intermediate = `${before}=json_set(c.before_state,'$.product',json_extract(c.after_state,'$.product'))`
  if (adding)
    domain.push(`${liveBefore} INSERT INTO variants(${variantColumns.join(',')}) SELECT ${variantColumns.map((column) => (newVariant[column] === clock ? 'c.created_at' : (newVariant[column] ?? 'NULL'))).join(',')} FROM owned c
    WHERE ${intermediate} AND (${refsValid}) ${allocated}`)
  if (editing || cmd.action === 'discontinue_variant')
    domain.push(`${liveBefore} UPDATE variants AS v SET ${Object.entries({
      ...variantOverrides,
      ...(cmd.action === 'discontinue_variant' ? { status: "'discontinued'" } : {}),
      updated_at: '(SELECT created_at FROM owned)'
    })
      .map(([column, value]) => `${column}=${value}`)
      .join(',')}
    WHERE v.id=?15 AND v.product_id=?14 AND v.status<>'discontinued' AND EXISTS(SELECT 1 FROM owned c WHERE ${intermediate} AND (${refsValid}) ${reserveFree})`)
  if (adding)
    domain.push(`${liveBefore} INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
    SELECT ?15,?20,0,0,1,c.created_at,c.created_at FROM owned c WHERE ${before}=json_set(c.after_state,'$.balances',json_extract(c.before_state,'$.balances')) AND (${refsValid})`)
  return { before, predicted, after, pre, post, domain, refsValid }
}
function constraint(error: unknown) {
  if (!(error instanceof Error)) return false
  const errcode: unknown = Object.getOwnPropertyDescriptor(error, 'errcode')?.value
  const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value
  return (
    (typeof errcode === 'number' && (errcode & 255) === 19) ||
    isD1CheckConstraintFailure(error) ||
    (typeof message === 'string' &&
      (/^(?:D1_ERROR: )?catalog_draft_(?:authoring_(?:commands|audit)_immutable|authoring_audit_command|counter_immutable)(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(
        message
      ) ||
        /^(?:D1_ERROR: )?(?:UNIQUE|FOREIGN KEY|NOT NULL) constraint failed(?:: [A-Za-z0-9_., ]+)?(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?)?$/.test(
          message
        )))
  )
}

/** Local draft authoring only; no scheduler, stock receipt, status/publication,
 * media/rights/policy approval or mutable caller-supplied identity. */
export async function executeD1CatalogDraftAuthoringCommand(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  actionInput: CatalogDraftAuthoringAction,
  targetInput: { productId?: string; variantId?: string },
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CatalogDraftAuthoringReceipt> {
  const action = checked(catalogDraftAuthoringActionSchema, actionInput),
    cmd = command(action, input)
  const target = checked(z.object({ productId: legacy.optional(), variantId: legacy.optional() }).strict(), targetInput)
  if (
    (action !== 'create_draft') !== Object.hasOwn(target, 'productId') ||
    ['update_variant', 'discontinue_variant'].includes(action) !== Object.hasOwn(target, 'variantId')
  )
    throw new CatalogDraftAuthoringError('invalid_input')
  const opts = checked(
    z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .refine((value) =>
            [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
          ),
        now: catalogPolicyInstantSchema.optional()
      })
      .strict(),
    options
  )
  const claims = checked(
    z
      .object({ identityId: catalogPolicyUuidSchema, sessionId: catalogPolicyUuidSchema, sessionVersion: safeId })
      .strict(),
    claimsInput,
    'unauthenticated'
  )
  await authorize(database, claims, opts.now)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['catalog.draft-authoring.v1', action, target, cmd.body]))
  )
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const existing = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
  if (existing) return existing
  for (let attempt = 0; attempt < 3; attempt++) {
    let ctx: Context
    try {
      ctx = await context(database, claims, cmd, target, opts.now)
    } catch (error) {
      if (error instanceof CatalogDraftAuthoringError) {
        const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
        if (winner) return winner
      }
      throw error
    }
    const execution = plan(cmd),
      parameters = parametersFor(claims, cmd, target, ctx, opts.idempotencyKey, hash, opts.now)
    const response = `json_object('source','cloudflare','action',?6,'productId',CAST(?7 AS INTEGER),'productUuid',?14,'variantId',CAST(?8 AS INTEGER),'variantUuid',?15,'catalogVersion',CAST(${expected}+1 AS INTEGER),'updated',json('true'))`
    const statements = [
      database
        .prepare(
          `${withActor} INSERT INTO catalog_draft_authoring_commands(id,claim_nonce,${auditColumns},idempotency_key,payload_hash)
        SELECT ?12,?13,actor.id,?6,?21,?9,?7,?14,?8,?15,CAST(${expected} AS INTEGER),CAST(${expected}+1 AS INTEGER),${j('reason')},${execution.before},${execution.predicted},${response},${clock},?10,?11
        FROM actor WHERE (${execution.pre}) AND ${execution.before}=?22 AND NOT EXISTS(SELECT 1 FROM catalog_draft_authoring_commands WHERE actor_id=?3 AND idempotency_key=?10)`
        )
        .bind(...parameters),
      ...execution.domain.map((sql) => database.prepare(sql).bind(...parameters)),
      database
        .prepare(
          `${withActor} INSERT INTO catalog_draft_authoring_audit(id,command_id,${auditColumns}) SELECT c.id,c.id,${auditColumns
            .split(',')
            .map((column) => `c.${column}`)
            .join(',')}
        FROM actor JOIN catalog_draft_authoring_commands c ON c.actor_id=actor.id WHERE ${owned} AND (${execution.post}) AND c.after_state=${execution.after}`
        )
        .bind(...parameters),
      database
        .prepare(
          `${withActor} SELECT c.response FROM actor JOIN catalog_draft_authoring_commands c ON c.actor_id=actor.id JOIN catalog_draft_authoring_audit a ON ${auditMatch} WHERE ${owned}`
        )
        .bind(...parameters),
      database
        .prepare(
          `${withActor} INSERT INTO catalog_draft_authoring_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0 WHERE NOT EXISTS(
        SELECT 1 FROM actor JOIN catalog_draft_authoring_commands c ON c.actor_id=actor.id JOIN catalog_draft_authoring_audit a ON ${auditMatch}
        WHERE ${owned} AND (${execution.post}) AND c.after_state=${execution.after})`
        )
        .bind(...parameters)
    ]
    try {
      const results = await database.batch<{ response: string }>(statements)
      if (results.length !== statements.length || results.some((result) => !result || result.success !== true))
        throw new Error('catalog_draft_write_unavailable')
      const row = results[statements.length - 2]?.results[0]
      if (!row || typeof row.response !== 'string') throw new Error('catalog_draft_write_unavailable')
      return receipt(row.response)
    } catch (error) {
      if (!constraint(error)) throw error
      const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
      if (winner) return winner
      if (action === 'create_draft' && attempt < 2) continue
      await context(database, claims, cmd, target, opts.now)
      throw new CatalogDraftAuthoringError('conflict')
    }
  }
  throw new CatalogDraftAuthoringError('conflict')
}
