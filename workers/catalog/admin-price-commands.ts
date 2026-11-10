import { z } from 'zod'
import {
  catalogPriceScheduleInputSchema,
  catalogPriceCancelInputSchema,
  catalogPriceReceiptSchema,
  catalogPriceIdSchema,
  catalogPriceInstantSchema,
  type CatalogPriceScheduleInput,
  type CatalogPriceCancelInput,
  type CatalogPriceReceipt
} from '../../shared/catalog-price-commands'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { validateQuantity } from '../../server/domain/money'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

export const ADMIN_PRICE_WRITE_PERMISSION = 'administration.manage'
export class AdminPriceCommandError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'variant_not_editable'
      | 'version_conflict'
      | 'head_conflict'
      | 'quantity_conflict'
      | 'invalid_window'
      | 'not_cancellable'
      | 'idempotency_conflict'
      | 'conflict'
  ) {
    super(code)
  }
}
type Command =
  | { action: 'price_schedule'; body: CatalogPriceScheduleInput }
  | { action: 'price_cancel'; body: CatalogPriceCancelInput }
type Options = { idempotencyKey: string; now?: string }
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
function checked<T, I>(
  schema: z.ZodType<T, I>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(value)
  } catch {
    throw new AdminPriceCommandError(code)
  }
  const result = schema.safeParse(plain)
  if (!result.success) throw new AdminPriceCommandError(code)
  return result.data
}
const clock = "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',?1),strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
const at = (value: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${value})`
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND ${at('s.created_at')}<=${at(clock)} AND ${at('s.expires_at')}>${at(clock)}
 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND ${at('i.email_verified_at')}<=${at(clock)}
 AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON assigned.role_code=granted.role_code
 WHERE assigned.identity_id=i.id AND granted.permission_code='administration.manage'
 AND ${at('assigned.granted_at')}<=${at(clock)} AND (assigned.expires_at IS NULL OR ${at('assigned.expires_at')}>${at(clock)}))`
const actorParams = (claims: VerifiedSessionClaims, now?: string) =>
  [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion] as const
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  const result = await authorizeD1Session(database, claims, ADMIN_PRICE_WRITE_PERMISSION, {
    requireMfa: true,
    ...(now === undefined ? {} : { now: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') })
  })
  if (!result.allowed) throw new AdminPriceCommandError(result.code)
}
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
function object(columns: readonly string[], alias: string, overrides: Record<string, string> = {}) {
  return `json_object(${columns.map((column) => `'${column}',${overrides[column] ?? `${alias}.${column}`}`).join(',')})`
}
function grouped(columns: readonly string[], alias: string) {
  const groups: string[] = []
  for (let start = 0; start < columns.length; start += 12) groups.push(object(columns.slice(start, start + 12), alias))
  return `json_array(${groups.join(',')})`
}
const head = `(SELECT id FROM variant_price_versions WHERE variant_id=?8 AND status='approved'
 ORDER BY ${at('valid_from')} DESC,${at('created_at')} DESC,id DESC LIMIT 1)`
const previous = `(SELECT id FROM variant_price_versions WHERE variant_id=?8 AND status='approved' AND id IS NOT ?14
 ORDER BY ${at('valid_from')} DESC,${at('created_at')} DESC,id DESC LIMIT 1)`
const j = (field: string) => `json_extract(?6,'$.${field}')`
/** Descriptive evidence from approved windows only, never an invented legacy
 * reference. Import gaps do not prove a complete thirty-day price history. */
const reference = `(SELECT min(gross_cents) FROM variant_price_versions WHERE variant_id=?8 AND status='approved'
 AND ${at('valid_from')}<${at(j('validFrom'))}
 AND ${at(`COALESCE(valid_until,${j('validFrom')})`)}
 >strftime('%Y-%m-%dT%H:%M:%fZ',${j('validFrom')},'-30 days'))`
const restoreUntil = `CASE WHEN EXISTS(SELECT 1 FROM catalog_price_commands prior JOIN catalog_price_audit audit ON audit.command_id=prior.id
  WHERE prior.action='price_schedule' AND prior.price_id=?7 AND prior.variant_id=?8)
  THEN (SELECT json_extract(item.value,'$.valid_until') FROM catalog_price_commands prior,json_each(prior.before_state,'$.prices') item
    WHERE prior.action='price_schedule' AND prior.price_id=?7 AND prior.variant_id=?8 AND json_extract(item.value,'$.id')=?15 LIMIT 1)
  ELSE CASE WHEN ${at('price.valid_until')}=(SELECT ${at('valid_from')} FROM variant_price_versions WHERE id=?7)
    THEN NULL ELSE price.valid_until END END`
const priorAuditMatch = 'actor_id,action,variant_id,price_id,input,reason,before_state,after_state,response,created_at'
  .split(',')
  .map((column) => `audit.${column} IS prior.${column}`)
  .concat('audit.command_id=prior.id')
  .join(' AND ')
const restorationCoherent = `NOT EXISTS(SELECT 1 FROM catalog_price_commands WHERE action='price_schedule' AND price_id=?7)
 OR ((SELECT count(*) FROM catalog_price_commands WHERE action='price_schedule' AND price_id=?7)=1
 AND EXISTS(SELECT 1 FROM catalog_price_commands prior JOIN catalog_price_audit audit ON ${priorAuditMatch}
 WHERE prior.action='price_schedule' AND prior.price_id=?7 AND prior.variant_id=?8
 AND EXISTS(SELECT 1 FROM json_each(prior.after_state,'$.prices') saved JOIN variant_price_versions current
   ON current.id=json_extract(saved.value,'$.id') WHERE current.id=?7 AND saved.value=${object(priceColumns, 'current')})
 AND (?15 IS NULL OR EXISTS(SELECT 1 FROM json_each(prior.after_state,'$.prices') saved JOIN variant_price_versions current
   ON current.id=json_extract(saved.value,'$.id') WHERE current.id=?15 AND current.valid_until IS json_extract(saved.value,'$.valid_until')))))`
function state(cmd: Command, phase: 'before' | 'closed' | 'after', stamp = clock) {
  const overrides: Record<string, string> = {}
  if (phase !== 'before') {
    if (cmd.action === 'price_schedule')
      overrides.valid_until = `CASE WHEN price.id=?14 AND
      (price.valid_until IS NULL OR ${at('price.valid_until')}>${at(j('validFrom'))}) THEN ${j('validFrom')} ELSE price.valid_until END`
    else {
      overrides.status = "CASE WHEN price.id=?7 THEN 'cancelled' ELSE price.status END"
      overrides.cancelled_by = 'CASE WHEN price.id=?7 THEN ?3 ELSE price.cancelled_by END'
      overrides.cancelled_at = `CASE WHEN price.id=?7 THEN ${stamp} ELSE price.cancelled_at END`
      overrides.cancellation_reason = `CASE WHEN price.id=?7 THEN ${j('reason')} ELSE price.cancellation_reason END`
      if (phase === 'after')
        overrides.valid_until = `CASE WHEN price.id=?15 THEN ${restoreUntil} ELSE price.valid_until END`
    }
  }
  const newPrice: Record<string, string> = {
    id: '?7',
    variant_id: '?8',
    gross_cents: j('grossCents'),
    compare_at_gross_cents: j('compareAtGrossCents'),
    reference_gross_cents_30d: 'CAST(?16 AS INTEGER)',
    volume_tiers: `(${j('volumeTiers')} || '')`,
    valid_from: j('validFrom'),
    valid_until: 'NULL',
    status: "'approved'",
    reason: j('reason'),
    created_by: '?3',
    created_at: stamp,
    cancelled_by: 'NULL',
    cancelled_at: 'NULL',
    cancellation_reason: 'NULL'
  }
  const prices = `(SELECT json_group_array(json(item)) FROM (SELECT price.id,${object(priceColumns, 'price', overrides)} AS item
    FROM variant_price_versions price WHERE variant_id=?8
    ${phase === 'after' && cmd.action === 'price_schedule' ? `UNION ALL SELECT ?7,${object(priceColumns, 'price', newPrice)}` : ''} ORDER BY id))`
  const balances = `(SELECT json_group_array(json(item)) FROM (SELECT location_id,json_object('variant_id',variant_id,'location_id',location_id,
    'physical',physical_quantity,'blocked',blocked_quantity,'version',version,'created_at',created_at,'updated_at',updated_at) AS item
    FROM inventory_balances WHERE variant_id=?8 ORDER BY location_id))`
  return `json_object('product',(SELECT ${grouped(productColumns, 'p')} FROM products p JOIN variants v ON p.id=v.product_id WHERE v.id=?8),
    'variant',(SELECT ${grouped(variantColumns, 'v')} FROM variants v WHERE v.id=?8),'prices',${prices},'balances',${balances})`
}
function providerRow<T, I>(schema: z.ZodType<T, I>, value: unknown): T {
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(value)
  } catch {
    throw new Error('price_provider_invalid')
  }
  const result = schema.safeParse(plain)
  if (!result.success) throw new Error('price_provider_invalid')
  return result.data
}
// Complete histories are never truncated into a guessed CAS snapshot. The
// pre-command snapshot is limited to 512 KiB UTF-8; its predicted after-state
// adds only the bounded price-command delta, leaving room for both states.
// Larger histories fail closed before the batch and need an explicit archival
// decision; this writer does not invent a partial financial history.
const snapshotSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (new TextEncoder().encode(value).length > 512 * 1024) return false
    try {
      return z
        .object({
          product: z.array(z.record(z.string(), z.unknown())).length(2),
          variant: z.array(z.record(z.string(), z.unknown())).length(3),
          prices: z.array(z.record(z.string(), z.unknown())),
          balances: z.array(z.record(z.string(), z.unknown()))
        })
        .strict()
        .safeParse(JSON.parse(value)).success
    } catch {
      return false
    }
  })
const sourceRowSchema = z
  .object({
    snapshot: snapshotSchema,
    headId: catalogPriceIdSchema.nullable(),
    previousId: catalogPriceIdSchema.nullable(),
    headFrom: catalogPriceInstantSchema.nullable(),
    reference: positive.nullable(),
    catalogVersion: positive,
    variantLegacyId: positive.nullable(),
    minimumQuantity: positive,
    maximumQuantity: positive.nullable(),
    quantityIncrement: positive,
    status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']),
    currency: z.string().regex(/^[A-Z]{3}$/)
  })
  .strict()
  .refine(
    (value) =>
      (value.headId === null) === (value.headFrom === null) &&
      (value.previousId === null || value.previousId !== value.headId)
  )
async function context(
  database: D1Database,
  claims: VerifiedSessionClaims,
  cmd: Command,
  params: (string | number | null)[],
  now?: string
) {
  await authorize(database, claims, now)
  const raw = await database
    .prepare(
      `WITH params AS (SELECT ?16 AS unused),actor AS (${actorSql}) SELECT ${state(cmd, 'before')} AS snapshot,
    ${head} AS headId,${previous} AS previousId,(SELECT valid_from FROM variant_price_versions WHERE id=${head}) AS headFrom,
    ${cmd.action === 'price_schedule' ? reference : 'NULL'} AS reference,p.catalog_version AS catalogVersion,
    v.legacy_id AS variantLegacyId,v.minimum_quantity AS minimumQuantity,v.maximum_quantity AS maximumQuantity,
    v.quantity_increment AS quantityIncrement,v.status,v.currency
    FROM actor JOIN variants v ON v.id=?8 JOIN products p ON p.id=v.product_id`
    )
    .bind(...params)
    .first<unknown>()
  if (raw === null) {
    await authorize(database, claims, now)
    throw new AdminPriceCommandError('not_found')
  }
  const result = providerRow(sourceRowSchema, raw)
  if (result.status === 'discontinued' || result.currency !== 'EUR')
    throw new AdminPriceCommandError('variant_not_editable')
  if (result.variantLegacyId === null) throw new AdminPriceCommandError('not_found')
  if (result.catalogVersion !== cmd.body.expectedCatalogVersion) throw new AdminPriceCommandError('version_conflict')
  if (result.headId !== cmd.body.expectedLatestApprovedId) throw new AdminPriceCommandError('head_conflict')
  if (cmd.action === 'price_schedule') {
    if (
      Date.parse(cmd.body.validFrom) < Date.parse(now ?? new Date().toISOString()) - 30_000 ||
      (result.headFrom !== null && Date.parse(cmd.body.validFrom) <= Date.parse(result.headFrom))
    )
      throw new AdminPriceCommandError('invalid_window')
    try {
      validateQuantity(result.minimumQuantity, result)
      for (const tier of cmd.body.volumeTiers) {
        if (tier.minimumQuantity <= result.minimumQuantity) throw new Error('tier_moq')
        validateQuantity(tier.minimumQuantity, result)
      }
    } catch {
      throw new AdminPriceCommandError('quantity_conflict')
    }
  } else if (
    result.headId !== params[6] ||
    !result.headFrom ||
    Date.parse(result.headFrom) <= Date.parse(now ?? new Date().toISOString())
  )
    throw new AdminPriceCommandError('not_cancellable')
  return result
}
const auditColumns = 'actor_id,action,variant_id,price_id,input,reason,before_state,after_state,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((column) => `a.${column} IS c.${column}`)
  .concat('a.command_id=c.id')
  .join(' AND ')
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const raw = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,
    EXISTS(SELECT 1 FROM catalog_price_audit a WHERE ${auditMatch}) AS completed
    FROM actor JOIN catalog_price_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?5`
    )
    .bind(...actorParams(claims, now), key)
    .first<unknown>()
  if (raw === null) {
    await authorize(database, claims, now)
    return null
  }
  const row = providerRow(
    z
      .object({
        payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
        response: z.string().min(1).max(4096),
        completed: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    raw
  )
  await authorize(database, claims, now)
  if (row.payload_hash !== hash) throw new AdminPriceCommandError('idempotency_conflict')
  if (row.completed !== 1) throw new Error('price_receipt_incomplete')
  const result = catalogPriceReceiptSchema.safeParse(JSON.parse(row.response))
  if (!result.success) throw new Error('price_receipt_invalid')
  return result.data
}
function constraint(error: unknown) {
  if (!(error instanceof Error)) return false
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'errcode')?.value
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    isD1CheckConstraintFailure(error) ||
    /^(?:D1_ERROR: )?(?:catalog_price_|UNIQUE constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed)/.test(
      error.message
    )
  )
}
async function execute(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  cmd: Command,
  target: string | null,
  options: Options
) {
  const opts = checked(
    z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/),
        now: catalogPriceInstantSchema.optional()
      })
      .strict(),
    options
  )
  const claims = checked(
    z
      .object({ identityId: catalogPolicyUuidSchema, sessionId: catalogPolicyUuidSchema, sessionVersion: positive })
      .strict(),
    claimsInput,
    'unauthenticated'
  )
  if (cmd.action === 'price_cancel' && target !== cmd.body.expectedLatestApprovedId)
    throw new AdminPriceCommandError('invalid_input')
  await authorize(database, claims, opts.now)
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['catalog.price.v1', cmd.action, target, cmd.body]))
  )
  const hash = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const existing = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
  if (existing) return existing
  const priceId = target ?? crypto.randomUUID()
  let variantId: string
  if (cmd.action === 'price_schedule') variantId = cmd.body.variantId
  else {
    const raw = await database
      .prepare('SELECT variant_id FROM variant_price_versions WHERE id=?')
      .bind(priceId)
      .first<unknown>()
    if (raw === null) {
      await authorize(database, claims, opts.now)
      throw new AdminPriceCommandError('not_found')
    }
    variantId = providerRow(z.object({ variant_id: catalogPolicyUuidSchema }).strict(), raw).variant_id
  }
  const parameters: (string | number | null)[] = [
    ...actorParams(claims, opts.now),
    cmd.action,
    JSON.stringify(cmd.body),
    priceId,
    variantId,
    opts.idempotencyKey,
    hash,
    crypto.randomUUID(),
    crypto.randomUUID(),
    '',
    cmd.body.expectedLatestApprovedId,
    null,
    null
  ]
  const source = await context(database, claims, cmd, parameters, opts.now)
  parameters[12] = source.snapshot
  parameters[14] = source.previousId
  parameters[15] = source.reference
  const pre = `EXISTS(SELECT 1 FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?8 AND v.status<>'discontinued'
    AND v.currency='EUR' AND v.legacy_id BETWEEN 1 AND 9007199254740991 AND p.catalog_version=${j('expectedCatalogVersion')})
    AND ${head} IS ?14 ${
      cmd.action === 'price_schedule'
        ? `AND ${at(j('validFrom'))}>=strftime('%Y-%m-%dT%H:%M:%fZ',${clock},'-30 seconds')
    AND (?14 IS NULL OR ${at(j('validFrom'))}>(SELECT ${at('valid_from')} FROM variant_price_versions WHERE id=?14))`
        : `AND ?7 IS ?14 AND (SELECT ${at('valid_from')} FROM variant_price_versions WHERE id=?7)>${at(clock)} AND (${restorationCoherent})`
    }`
  const base = `WITH params AS (SELECT ?16 AS unused),actor AS (${actorSql})`
  const owned = `${base},owned AS MATERIALIZED(SELECT c.* FROM actor JOIN catalog_price_commands c ON c.actor_id=actor.id
    WHERE c.id=?11 AND c.claim_nonce=?12 AND c.action=?5 AND c.price_id=?7 AND c.variant_id=?8 AND c.idempotency_key=?9
    AND c.payload_hash=?10 AND c.input=?6)`
  const receipt = `json_object('source','cloudflare','action',?5,'commandId',?11,'priceId',?7,'variantId',?8,
    'variantLegacyId',(SELECT legacy_id FROM variants WHERE id=?8),'updated',json('true'))`
  const domain: string[] = []
  if (cmd.action === 'price_schedule') {
    domain.push(`${owned} UPDATE variant_price_versions SET valid_until=${j('validFrom')} WHERE id=?14
      AND (valid_until IS NULL OR ${at('valid_until')}>${at(j('validFrom'))})
      AND EXISTS(SELECT 1 FROM owned c WHERE (${pre}) AND c.before_state=${state(cmd, 'before')})`)
    domain.push(`${owned} INSERT INTO variant_price_versions(${priceColumns.join(',')}) SELECT ?7,?8,${j('grossCents')},${j('compareAtGrossCents')},?16,
      ${j('volumeTiers')},${j('validFrom')},NULL,'approved',${j('reason')},?3,c.created_at,NULL,NULL,NULL FROM owned c
      WHERE (${pre}) AND
      ${state(cmd, 'before')}=json_set(c.after_state,'$.prices',json((SELECT json_group_array(json(item.value)) FROM json_each(c.after_state,'$.prices') item WHERE json_extract(item.value,'$.id')<>?7)))`)
  } else {
    domain.push(`${owned} UPDATE variant_price_versions SET status='cancelled',cancelled_by=?3,cancelled_at=(SELECT created_at FROM owned),
      cancellation_reason=${j('reason')} WHERE id=?7 AND EXISTS(SELECT 1 FROM owned c WHERE (${pre}) AND c.before_state=${state(cmd, 'before')})`)
    domain.push(`${owned} UPDATE variant_price_versions AS price SET valid_until=${restoreUntil} WHERE id=?15
      AND EXISTS(SELECT 1 FROM owned c WHERE ${state(cmd, 'before')}=json_set(c.before_state,'$.prices',json((
        SELECT json_group_array(json(CASE WHEN json_extract(item.value,'$.id')=?7
          THEN json_set(item.value,'$.status','cancelled','$.cancelled_by',?3,'$.cancelled_at',c.created_at,'$.cancellation_reason',${j('reason')})
          ELSE item.value END)) FROM json_each(c.before_state,'$.prices') item))))`)
  }
  // Intermediate states are compared against the claim's immutable prediction;
  // the final CHECK is the only success boundary and aborts the entire batch.
  const post = `c.after_state=${state(cmd, 'before')} AND EXISTS(SELECT 1 FROM variant_price_versions WHERE id=?7 AND variant_id=?8)
    AND EXISTS(SELECT 1 FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=?8 AND p.catalog_version=${j('expectedCatalogVersion')})`
  const sql = [
    `${base} INSERT INTO catalog_price_commands(id,claim_nonce,${auditColumns},idempotency_key,payload_hash)
    SELECT ?11,?12,actor.id,?5,?8,?7,?6,${j('reason')},${state(cmd, 'before')},${state(cmd, 'after')},${receipt},${clock},?9,?10
    FROM actor WHERE (${pre}) AND ${state(cmd, 'before')}=?13 AND NOT EXISTS(SELECT 1 FROM catalog_price_commands WHERE actor_id=?3 AND idempotency_key=?9)`,
    ...domain,
    `${owned} INSERT INTO catalog_price_audit(id,command_id,${auditColumns}) SELECT c.id,c.id,${auditColumns
      .split(',')
      .map((column) => `c.${column}`)
      .join(',')}
      FROM owned c WHERE (${post})`,
    `${owned} SELECT c.response FROM owned c JOIN catalog_price_audit a ON ${auditMatch} WHERE (${post})`,
    `${owned} INSERT INTO catalog_price_guards(id,satisfied) SELECT ?11,0 WHERE NOT EXISTS(SELECT 1 FROM owned c JOIN catalog_price_audit a ON ${auditMatch} WHERE (${post}))`
  ]
  try {
    const statements = sql.map((statement) => database.prepare(statement).bind(...parameters))
    const results = await database.batch<{ response: string }>(statements)
    let safe: unknown
    try {
      safe = catalogPolicyOwnJson(results)
    } catch {
      throw new Error('price_write_unavailable')
    }
    if (!Array.isArray(safe) || safe.length !== statements.length) throw new Error('price_write_unavailable')
    for (const item of safe) {
      if (
        !item ||
        typeof item !== 'object' ||
        !Object.hasOwn(item, 'success') ||
        Object.getOwnPropertyDescriptor(item, 'success')?.value !== true ||
        !Object.hasOwn(item, 'results') ||
        !Array.isArray(Object.getOwnPropertyDescriptor(item, 'results')?.value)
      )
        throw new Error('price_write_unavailable')
    }
    const selected: unknown = Object.getOwnPropertyDescriptor(safe[safe.length - 2], 'results')?.value
    if (!Array.isArray(selected) || selected.length !== 1) throw new Error('price_write_unavailable')
    const row: unknown = selected[0]
    const response: unknown =
      row && typeof row === 'object' ? Object.getOwnPropertyDescriptor(row, 'response')?.value : undefined
    if (typeof response !== 'string') throw new Error('price_write_unavailable')
    await authorize(database, claims, opts.now)
    const parsed = catalogPriceReceiptSchema.safeParse(JSON.parse(response))
    if (!parsed.success) throw new Error('price_receipt_invalid')
    return parsed.data
  } catch (failure) {
    if (!constraint(failure)) throw failure
    const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
    if (winner) return winner
    await context(database, claims, cmd, parameters, opts.now)
    throw new AdminPriceCommandError('conflict')
  }
}
export async function scheduleD1VariantPrice(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown,
  options: Options
): Promise<CatalogPriceReceipt> {
  return execute(
    database,
    claims,
    { action: 'price_schedule', body: checked(catalogPriceScheduleInputSchema, input) },
    null,
    options
  )
}
export async function cancelD1ScheduledPrice(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  priceId: string,
  input: unknown,
  options: Options
): Promise<CatalogPriceReceipt> {
  return execute(
    database,
    claims,
    { action: 'price_cancel', body: checked(catalogPriceCancelInputSchema, input) },
    checked(catalogPriceIdSchema, priceId),
    options
  )
}
