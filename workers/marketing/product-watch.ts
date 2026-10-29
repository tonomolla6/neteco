import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  authorizeD1AccountPreferences,
  AccountPreferencesError,
  accountPreferenceAuthoritySql as authoritySql,
  accountPreferenceAuthorityAllowedSql as authorityAllowed
} from '../auth/account-preferences'
import {
  prepareQuoteLinesStatement,
  mapQuoteLines,
  canonicalPayloadHash,
  CartError,
  type RawResolvedLine
} from '../catalog/cart'
import { publicationValidityExpression } from '../catalog/publication-validity'
import { effectiveGovernedVersionIdExpression, inlineEffectivePricingSql } from '../catalog/pricing'
import { sellableExpression } from '../catalog/inventory'
import { catalogPolicyInstantSchema as instant } from '../../shared/catalog-publication-policy'
import {
  PRODUCT_WATCH_POLICY_VERSION as POLICY,
  PRODUCT_WATCH_NOTICE_TEXT as TEXT,
  productWatchCreateInputSchema,
  productWatchConfirmInputSchema,
  productWatchCancelInputSchema,
  productWatchReceiptSchema,
  productWatchListSchema,
  productWatchDetailSchema,
  productWatchIntentHash,
  type ProductWatchCommand,
  type ProductWatchList,
  type ProductWatchReceipt
} from '../../shared/product-watch'

export interface ProductWatchOptions {
  now?: () => string
  /** Dedicated, server-only HMAC key. Never returned in a response or stored in D1. */
  hmacKey?: Uint8Array
}
export interface ProductWatchSender {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<{ messageId: string }>
}
export class ProductWatchError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'already_subscribed'
      | 'variant_unavailable'
      | 'confirmation_unavailable'
      | 'configuration_unavailable'
      | 'history_unconfirmed'
      | 'service_unavailable'
  ) {
    super(code)
  }
}
function fail(code: ProductWatchError['code']): never {
  throw new ProductWatchError(code)
}
const uuid = z.string().uuid(),
  hex = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
function clock(options: ProductWatchOptions) {
  const value = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!instant.safeParse(value).success) fail('configuration_unavailable')
  return value
}
function secret(options: ProductWatchOptions) {
  if (!(options.hmacKey instanceof Uint8Array) || options.hmacKey.length < 32 || options.hmacKey.length > 128)
    fail('configuration_unavailable')
  return options.hmacKey
}
async function attempt<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (cause instanceof ProductWatchError) throw cause
    if (cause instanceof AccountPreferencesError) {
      if (cause.code === 'unauthenticated' || cause.code === 'email_unverified' || cause.code === 'mfa_required')
        throw new ProductWatchError(cause.code)
    }
    return fail('service_unavailable')
  }
}
async function owner(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: ProductWatchOptions,
  expected?: string
) {
  const value = await authorizeD1AccountPreferences(db, claims, options)
  if (expected && value.customerId !== expected) fail('unauthenticated')
  return value
}
function args(claims: VerifiedSessionClaims, now: string, envelope: unknown) {
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion, JSON.stringify(envelope)]
}
const json = (field: string) => `json_extract(?5,'$.${field}')`
const actorGuard = `${authorityAllowed} AND a.customerId=${json('customerId')} AND a.actorId=${json('actorId')}`
const projectionProof = allSql([
  'w.version=(SELECT count(*) FROM product_watch_commands c WHERE c.watch_id=w.id)',
  `EXISTS(SELECT 1 FROM product_watch_commands c WHERE ${allSql([
    'c.watch_id=w.id',
    'c.applied_version=w.version',
    'c.actor_id=w.command_actor_id',
    'c.command_id=w.command_id',
    "json_extract(c.receipt_json,'$.status')=w.status",
    "json_extract(c.snapshot_json,'$.baselineGrossCents') IS w.baseline_gross_cents",
    "json_extract(c.snapshot_json,'$.baselineAvailable') IS w.baseline_available",
    "json_extract(c.snapshot_json,'$.confirmedAt') IS w.confirmed_at",
    "json_extract(c.snapshot_json,'$.cancelledAt') IS w.cancelled_at"
  ])})`
])
const watchSchema = z
  .object({
    id: uuid,
    customer_id: uuid,
    actor_id: uuid,
    variant_id: z.string().min(1).max(200),
    variant_legacy_id: integer,
    kind: z.enum(['price_drop', 'back_in_stock']),
    recipient: z.string().email(),
    policy_version: z.literal(POLICY),
    consent_text: z.literal(TEXT),
    text_hash: hex,
    created_at: instant,
    confirmation_expires_at: instant,
    version: integer,
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    baseline_gross_cents: integer.nullable(),
    baseline_available: z.union([z.literal(0), z.literal(1)]).nullable(),
    confirmed_at: instant.nullable(),
    cancelled_at: instant.nullable(),
    command_actor_id: uuid,
    command_id: uuid,
    proof: z.literal(1)
  })
  .strict()
type Watch = z.infer<typeof watchSchema>
const watchColumns = `r.*,w.version,w.status,w.baseline_gross_cents,w.baseline_available,w.confirmed_at,w.cancelled_at,w.command_actor_id,w.command_id,${projectionProof} proof`
const watchFrom = 'FROM product_watch_requests r JOIN product_watches w ON w.id=r.id'
// A requested DOI confirmation is not a marketing signal. Price/stock signals
// share recovery's immutable recipient cooldown and in-flight claim boundary.
const recoveryRecipientAllowed = `NOT EXISTS(
 SELECT 1 FROM cart_recovery_deliveries recovery
 JOIN cart_recovery_associations association ON association.id=recovery.association_id
 WHERE association.recipient=r.recipient AND (
 recovery.status='sending' OR (recovery.status IN('sent','manual_review') AND
 strftime('%Y-%m-%dT%H:%M:%SZ',recovery.finished_at,
 '+'||(unixepoch(recovery.next_eligible_at)-unixepoch(recovery.created_at))||' seconds')>?1)))`
async function load(db: D1Database, id: string, customerId?: string): Promise<Watch> {
  if (!uuid.safeParse(id).success) fail('invalid_input')
  const raw = await db
    .prepare(`SELECT ${watchColumns} ${watchFrom} WHERE r.id=?1 AND (?2 IS NULL OR r.customer_id=?2)`)
    .bind(id, customerId ?? null)
    .first()
  if (!raw) fail('not_found')
  const parsed = watchSchema.safeParse(raw)
  if (!parsed.success || parsed.data.version < 1) fail('history_unconfirmed')
  if ((await canonicalPayloadHash({ policyVersion: POLICY, noticeText: TEXT })) !== parsed.data.text_hash)
    fail('history_unconfirmed')
  return parsed.data
}
async function command(
  db: D1Database,
  actorId: string,
  customerId: string,
  key: string,
  hash: string
): Promise<ProductWatchReceipt | null> {
  if (!uuid.safeParse(key).success || !hex.safeParse(hash).success) fail('invalid_input')
  const raw = await db
    .prepare(
      'SELECT action,watch_id,payload_hash,applied_version,created_at,receipt_json FROM product_watch_commands WHERE actor_id=? AND customer_id=? AND command_id=?'
    )
    .bind(actorId, customerId, key)
    .first()
  if (raw === null) return null
  const parsed = z
    .object({
      action: z.enum(['create', 'confirm', 'cancel']),
      watch_id: uuid,
      payload_hash: hex,
      applied_version: integer,
      created_at: instant,
      receipt_json: z.string()
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('history_unconfirmed')
  if (parsed.data.payload_hash !== hash) fail('conflict')
  let decoded: unknown
  try {
    decoded = JSON.parse(parsed.data.receipt_json)
  } catch {
    return fail('history_unconfirmed')
  }
  const receipt = productWatchReceiptSchema.safeParse(decoded)
  if (
    !receipt.success ||
    receipt.data.commandId !== key ||
    receipt.data.payloadHash !== hash ||
    receipt.data.watchId !== parsed.data.watch_id ||
    receipt.data.action !== parsed.data.action ||
    receipt.data.version !== parsed.data.applied_version ||
    receipt.data.recordedAt !== parsed.data.created_at
  )
    fail('history_unconfirmed')
  await load(db, receipt.data.watchId, customerId)
  return receipt.data
}
async function facts(db: D1Database, legacyId: number, now: string) {
  const variant = await db
    .prepare('SELECT id,minimum_quantity FROM variants WHERE legacy_id=?')
    .bind(legacyId)
    .first<{ id: string; minimum_quantity: number }>()
  if (!variant || !Number.isSafeInteger(variant.minimum_quantity) || variant.minimum_quantity < 1)
    fail('variant_unavailable')
  const read = await prepareQuoteLinesStatement(db, {
    instant: now,
    lines: [{ variantId: variant.id, quantity: variant.minimum_quantity }]
  }).all<RawResolvedLine>()
  if (!read.success || read.results.length !== 1) fail('history_unconfirmed')
  let line: ReturnType<typeof mapQuoteLines>[number]
  try {
    line = mapQuoteLines(read.results)[0]!
  } catch (cause) {
    if (cause instanceof CartError) return fail('variant_unavailable')
    throw cause
  }
  if (
    ![line.availableQuantity, line.unitGrossCents, line.baseUnitGrossCents].every(Number.isSafeInteger) ||
    line.availableQuantity < 0 ||
    line.unitGrossCents < 0
  )
    fail('history_unconfirmed')
  const balance = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM inventory_balances WHERE variant_id=?1) present,
    NOT EXISTS(SELECT 1 FROM inventory_balances b WHERE b.variant_id=?1 AND b.physical_quantity<>(SELECT COALESCE(SUM(m.physical_delta),0) FROM inventory_movements m WHERE m.variant_id=b.variant_id AND m.location_id=b.location_id)) coherent`
    )
    .bind(variant.id)
    .first<{ present: number; coherent: number }>()
  if (balance?.present !== 1 || balance.coherent !== 1) fail('history_unconfirmed')
  return {
    variantId: variant.id,
    legacyId,
    minimumQuantity: variant.minimum_quantity,
    unitGrossCents: line.unitGrossCents,
    baseUnitGrossCents: line.baseUnitGrossCents,
    availableQuantity: line.availableQuantity,
    available: line.availableQuantity >= variant.minimum_quantity ? (1 as const) : (0 as const),
    priceVersionId: line.priceVersionId,
    volumeTiersJson: line.volumeTiersJson
  }
}
type Facts = Awaited<ReturnType<typeof facts>>
// D1 limits expression depth to 100. Preserve every predicate while avoiding
// a left-deep conjunction around the canonical publication proof.
function allSql(clauses: readonly string[]): string {
  if (clauses.length === 1) return `(${clauses[0]})`
  if (!clauses.length) throw new Error('empty_product_watch_guard')
  const middle = Math.floor(clauses.length / 2)
  return `(${allSql(clauses.slice(0, middle))} AND ${allSql(clauses.slice(middle))})`
}
function factsGuard(now: string, publication = publicationValidityExpression('p', '?1')) {
  const price = inlineEffectivePricingSql(effectiveGovernedVersionIdExpression('v'), now)
  return `EXISTS(SELECT 1 FROM variants v JOIN products p ON p.id=v.product_id JOIN categories c ON c.id=p.category_id
    LEFT JOIN variant_price_versions price ON price.id=${price} AND price.variant_id=v.id
    WHERE ${allSql([
      `v.id=${json('facts.variantId')}`,
      `v.legacy_id=${json('facts.legacyId')}`,
      `v.minimum_quantity=${json('facts.minimumQuantity')}`,
      "v.status='published'",
      "p.status='published'",
      "c.status='published'",
      `${publication}=1`,
      `COALESCE(price.id,'legacy:'||v.id)=${json('facts.priceVersionId')}`,
      `COALESCE(price.gross_cents,v.price_gross_cents)=${json('facts.baseUnitGrossCents')}`,
      `COALESCE(price.volume_tiers,'[]')=${json('facts.volumeTiersJson')}`,
      `(SELECT TOTAL(${sellableExpression()}) FROM inventory_balances b WHERE b.variant_id=v.id)=${json('facts.availableQuantity')}`
    ])})`
}
const recipientGuard = `EXISTS(SELECT 1 FROM identities i WHERE i.id=${json('actorId')} AND lower(i.email)=${json('recipient')})`
const liveRecipient = `(EXISTS(SELECT 1 FROM identities i JOIN customers customer ON customer.id=i.customer_id
 WHERE ${allSql([
   'i.id=r.actor_id',
   'i.customer_id=r.customer_id',
   "i.status='active'",
   "customer.status='active'",
   'i.email_verified_at IS NOT NULL',
   'i.email_verified_at<=?1',
   'lower(i.email)=r.recipient'
 ])}))`
const preferenceAllowed = `(EXISTS(SELECT 1 FROM customer_account_preferences pref JOIN account_preference_commands pc ON pc.customer_id=pref.customer_id AND pc.command_id=pref.command_id
 WHERE ${allSql([
   'pref.customer_id=r.customer_id',
   'pc.applied_version=pref.version',
   'pc.product_updates=pref.product_updates',
   'pc.replenishment=pref.replenishment',
   'pc.recorded_at=pref.updated_at',
   'pref.updated_at<=?1',
   "CASE WHEN r.kind='price_drop' THEN pref.product_updates ELSE pref.replenishment END=1"
 ])}))`
async function preference(db: D1Database, watch: Watch, now: string) {
  const row = await db
    .prepare(`SELECT ${preferenceAllowed} allowed FROM product_watch_requests r WHERE r.id=?2`)
    .bind(now, watch.id)
    .first<{ allowed: number }>()
  return row?.allowed === 1
}
async function token(
  watch: Pick<Watch, 'id' | 'actor_id' | 'recipient' | 'created_at' | 'confirmation_expires_at'>,
  options: ProductWatchOptions
) {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret(options)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        `neteco:product-watch:confirm:v1:${watch.id}\n${watch.actor_id}\n${watch.recipient}\n${watch.created_at}\n${watch.confirmation_expires_at}`
      )
    )
  )
  return `pw1.${watch.id}.${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
function equal(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let n = 0; n < left.length; n++) difference |= left.charCodeAt(n) ^ right.charCodeAt(n)
  return difference === 0
}

export async function readD1ProductWatches(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  query: { page?: number; perPage?: number } = {},
  options: ProductWatchOptions = {}
): Promise<ProductWatchList> {
  return attempt(async () => {
    const current = await owner(db, claims, options),
      now = clock(options)
    const paging = z
      .object({
        page: z.number().int().min(1).max(100000).default(1),
        perPage: z.number().int().min(1).max(25).default(25)
      })
      .strict()
      .safeParse(query)
    if (!paging.success) fail('invalid_input')
    const { page, perPage } = paging.data
    const rows = await db
      .prepare(
        `SELECT ${watchColumns},${preferenceAllowed} preference_allowed,
      (SELECT count(*) FROM product_watch_deliveries d WHERE d.watch_id=r.id AND d.kind<>'confirmation') notifications
      ${watchFrom} WHERE r.customer_id=?2 ORDER BY r.created_at DESC,r.id LIMIT ?3 OFFSET ?4`
      )
      .bind(now, current.customerId, perPage, (page - 1) * perPage)
      .all()
    const count = await db
      .prepare('SELECT count(*) total FROM product_watch_requests WHERE customer_id=?')
      .bind(current.customerId)
      .first<{ total: number }>()
    if (!rows.success || !count || !Number.isSafeInteger(count.total)) fail('history_unconfirmed')
    const items = []
    for (const raw of rows.results) {
      const extra = z
        .object({ preference_allowed: z.union([z.literal(0), z.literal(1)]), notifications: integer })
        .passthrough()
        .safeParse(raw)
      if (!extra.success) fail('history_unconfirmed')
      const { preference_allowed, notifications, ...rest } = extra.data
      const parsed = watchSchema.safeParse(rest)
      if (!parsed.success) fail('history_unconfirmed')
      const w = parsed.data
      items.push({
        id: w.id,
        variantId: w.variant_legacy_id,
        kind: w.kind,
        status: w.status,
        version: w.version,
        createdAt: w.created_at,
        confirmationExpiresAt: w.confirmation_expires_at,
        confirmedAt: w.confirmed_at,
        cancelledAt: w.cancelled_at,
        baselineGrossCents: w.baseline_gross_cents,
        suppressedByPreferences: preference_allowed !== 1,
        notifications
      })
    }
    const result = productWatchListSchema.safeParse({
      source: 'cloudflare',
      page,
      perPage,
      total: count.total,
      items,
      policyVersion: POLICY,
      noticeText: TEXT,
      evaluatedAt: now
    })
    if (!result.success) fail('history_unconfirmed')
    await owner(db, claims, options, current.customerId)
    return result.data
  })
}
export async function readD1ProductWatchCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  payloadHash: string,
  options: ProductWatchOptions = {}
): Promise<ProductWatchCommand> {
  return attempt(async () => {
    const current = await owner(db, claims, options)
    const receipt = await command(db, current.actorId, current.customerId, commandId, payloadHash)
    await owner(db, claims, options, current.customerId)
    return receipt
      ? { source: 'cloudflare', outcome: 'applied', receipt }
      : { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}
export async function readD1ProductWatch(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: ProductWatchOptions = {}
) {
  return attempt(async () => {
    const current = await owner(db, claims, options),
      now = clock(options)
    const w = await load(db, id, current.customerId)
    const counts = await db
      .prepare(
        `SELECT ${preferenceAllowed} preference_allowed,
      (SELECT count(*) FROM product_watch_deliveries d WHERE d.watch_id=r.id AND d.kind<>'confirmation') notifications
      FROM product_watch_requests r WHERE r.id=?2 AND r.customer_id=?3`
      )
      .bind(now, id, current.customerId)
      .first<{ preference_allowed: number; notifications: number }>()
    if (!counts) fail('history_unconfirmed')
    const result = productWatchDetailSchema.safeParse({
      source: 'cloudflare',
      evaluatedAt: now,
      item: {
        id: w.id,
        variantId: w.variant_legacy_id,
        kind: w.kind,
        status: w.status,
        version: w.version,
        createdAt: w.created_at,
        confirmationExpiresAt: w.confirmation_expires_at,
        confirmedAt: w.confirmed_at,
        cancelledAt: w.cancelled_at,
        baselineGrossCents: w.baseline_gross_cents,
        suppressedByPreferences: counts.preference_allowed !== 1,
        notifications: counts.notifications
      }
    })
    if (!result.success) fail('history_unconfirmed')
    await owner(db, claims, options, current.customerId)
    return result.data
  })
}
async function execute(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  action: 'create' | 'confirm' | 'cancel',
  targetId: string | null,
  raw: unknown,
  key: string,
  options: ProductWatchOptions
): Promise<ProductWatchReceipt> {
  return attempt(async () => {
    const current = await owner(db, claims, options),
      now = clock(options)
    if (!uuid.safeParse(key).success) fail('invalid_input')
    const parsed = (
      action === 'create'
        ? productWatchCreateInputSchema
        : action === 'confirm'
          ? productWatchConfirmInputSchema
          : productWatchCancelInputSchema
    ).safeParse(raw)
    if (!parsed.success) fail('invalid_input')
    const payloadHash = await productWatchIntentHash(action, targetId, raw)
    const replay = await command(db, current.actorId, current.customerId, key, payloadHash)
    if (replay) {
      await owner(db, claims, options, current.customerId)
      return replay
    }
    const identity = await db
      .prepare('SELECT lower(email) email FROM identities WHERE id=?')
      .bind(current.actorId)
      .first<{ email: string }>()
    if (!identity || !z.string().email().safeParse(identity.email).success) fail('history_unconfirmed')
    let source: Facts | null = null,
      expectedVersion = 0
    const id = action === 'create' ? crypto.randomUUID() : targetId!
    let confirmationExpiresAt = new Date(Date.parse(now) + 48 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    let status: 'pending' | 'confirmed' | 'cancelled' = 'pending',
      baselineGrossCents: number | null = null,
      baselineAvailable: number | null = null,
      confirmedAt: string | null = null,
      cancelledAt: string | null = null
    let kind: 'price_drop' | 'back_in_stock', legacyId: number
    if (action === 'create') {
      const input = productWatchCreateInputSchema.parse(raw)
      kind = input.kind
      legacyId = input.variantId
      secret(options)
      source = await facts(db, legacyId, now)
      const duplicate = await db
        .prepare(
          `SELECT r.id ${watchFrom} WHERE r.customer_id=? AND r.variant_id=? AND r.kind=? AND w.status<>'cancelled'`
        )
        .bind(current.customerId, source.variantId, kind)
        .first()
      if (duplicate) fail('already_subscribed')
    } else {
      const watch = await load(db, id, current.customerId)
      kind = watch.kind
      legacyId = watch.variant_legacy_id
      confirmationExpiresAt = watch.confirmation_expires_at
      expectedVersion = productWatchCancelInputSchema.parse(
        raw && typeof raw === 'object' && 'expectedVersion' in raw ? { expectedVersion: raw.expectedVersion } : {}
      ).expectedVersion
      if (watch.version !== expectedVersion) fail('version_conflict')
      baselineGrossCents = watch.baseline_gross_cents
      baselineAvailable = watch.baseline_available
      confirmedAt = watch.confirmed_at
      if (action === 'confirm') {
        if (watch.status !== 'pending' || watch.confirmation_expires_at <= now || watch.recipient !== identity.email)
          fail('confirmation_unavailable')
        const input = productWatchConfirmInputSchema.parse(raw)
        if (!equal(input.token, await token(watch, options))) fail('confirmation_unavailable')
        source = await facts(db, legacyId, now)
        baselineGrossCents = source.unitGrossCents
        baselineAvailable = source.available
        confirmedAt = now
        status = 'confirmed'
      } else {
        if (watch.status === 'cancelled') fail('version_conflict')
        status = 'cancelled'
        cancelledAt = now
      }
    }
    const version = expectedVersion + 1,
      snapshot = { status, baselineGrossCents, baselineAvailable, confirmedAt, cancelledAt }
    const receipt = productWatchReceiptSchema.parse({
      source: 'cloudflare',
      commandId: key,
      action,
      watchId: id,
      payloadHash,
      version,
      status,
      recordedAt: now,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    const envelope = {
      customerId: current.customerId,
      actorId: current.actorId,
      recipient: identity.email,
      id,
      legacyId,
      kind,
      confirmationExpiresAt,
      policy: POLICY,
      text: TEXT,
      textHash: await canonicalPayloadHash({ policyVersion: POLICY, noticeText: TEXT }),
      facts: source,
      key,
      action,
      payloadHash,
      version,
      expectedVersion,
      snapshot,
      receipt,
      safeInput:
        action === 'confirm'
          ? {
              expectedVersion,
              tokenHash: await canonicalPayloadHash({ token: productWatchConfirmInputSchema.parse(raw).token })
            }
          : parsed.data
    }
    const binds = args(claims!, now, envelope),
      statements: D1PreparedStatement[] = []
    const common = `${actorGuard} AND ${recipientGuard} AND ${source ? factsGuard(now) : '1'}`
    if (action === 'create')
      statements.push(
        db
          .prepare(
            `${authoritySql} INSERT INTO product_watch_requests(id,customer_id,actor_id,variant_id,variant_legacy_id,kind,recipient,policy_version,consent_text,text_hash,created_at,confirmation_expires_at)
      SELECT ${json('id')},a.customerId,a.actorId,${json('facts.variantId')},${json('legacyId')},${json('kind')},${json('recipient')},${json('policy')},${json('text')},${json('textHash')},?1,${json('confirmationExpiresAt')}
      FROM authority a WHERE ${common} AND (SELECT count(*) ${watchFrom} WHERE r.customer_id=a.customerId AND w.status<>'cancelled')<50
      AND NOT EXISTS(SELECT 1 ${watchFrom} WHERE r.customer_id=a.customerId AND r.variant_id=${json('facts.variantId')} AND r.kind=${json('kind')} AND w.status<>'cancelled')`
          )
          .bind(...binds)
      )
    const transition =
      action === 'create'
        ? `EXISTS(SELECT 1 FROM product_watch_requests r WHERE r.id=${json('id')} AND r.actor_id=a.actorId AND r.created_at=?1)`
        : `EXISTS(SELECT 1 ${watchFrom} WHERE w.id=${json('id')} AND r.customer_id=a.customerId AND w.version=${json('expectedVersion')} AND ${projectionProof} AND w.status${action === 'confirm' ? "='pending' AND r.confirmation_expires_at>?1 AND r.recipient=" + json('recipient') : " IN ('pending','confirmed')"})`
    statements.push(
      db
        .prepare(
          `${authoritySql} INSERT INTO product_watch_commands(actor_id,customer_id,command_id,watch_id,action,payload_hash,input_json,snapshot_json,receipt_json,applied_version,created_at)
      SELECT a.actorId,a.customerId,${json('key')},${json('id')},${json('action')},${json('payloadHash')},${json('safeInput')},${json('snapshot')},${json('receipt')},${json('version')},?1 FROM authority a WHERE ${common} AND ${transition}`
        )
        .bind(...binds)
    )
    if (action === 'create')
      statements.push(
        db
          .prepare(
            `${authoritySql} INSERT INTO product_watch_deliveries(id,watch_id,kind,source_hash,status,created_at)
      SELECT ${json('key')},${json('id')},'confirmation',${json('payloadHash')},'pending',?1 FROM authority a WHERE ${actorGuard} AND EXISTS(SELECT 1 FROM product_watch_commands WHERE actor_id=a.actorId AND command_id=${json('key')} AND payload_hash=${json('payloadHash')})`
          )
          .bind(...binds)
      )
    statements.push(
      db
        .prepare(
          `${authoritySql} INSERT INTO product_watch_atomic_guard(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM authority a JOIN product_watch_commands c ON c.actor_id=a.actorId AND c.command_id=${json('key')} WHERE ${actorGuard} AND c.payload_hash=${json('payloadHash')})`
        )
        .bind(...binds)
    )
    try {
      const results = await db.batch(statements)
      if (results.some((result) => !result.success)) fail('service_unavailable')
    } catch (cause) {
      await owner(db, claims, options, current.customerId)
      const found = await command(db, current.actorId, current.customerId, key, payloadHash)
      if (found) {
        await owner(db, claims, options, current.customerId)
        return found
      }
      if (action !== 'create' && (await load(db, id, current.customerId)).version !== expectedVersion)
        fail('version_conflict')
      throw cause
    }
    const applied = await command(db, current.actorId, current.customerId, key, payloadHash)
    if (!applied) fail('history_unconfirmed')
    await owner(db, claims, options, current.customerId)
    return applied
  })
}
export const createD1ProductWatch = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  key: string,
  options: ProductWatchOptions = {}
) => execute(db, claims, 'create', null, raw, key, options)
export const confirmD1ProductWatch = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  key: string,
  options: ProductWatchOptions = {}
) => execute(db, claims, 'confirm', id, raw, key, options)
export const cancelD1ProductWatch = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  key: string,
  options: ProductWatchOptions = {}
) => execute(db, claims, 'cancel', id, raw, key, options)

export async function evaluateD1ProductWatches(
  db: D1Database,
  options: ProductWatchOptions & { afterId?: string; limit?: number } = {}
): Promise<{ processed: number; created: number; nextId: string | null }> {
  return attempt(async () => {
    const now = clock(options),
      limit = options.limit ?? 5
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 5 ||
      (options.afterId && !uuid.safeParse(options.afterId).success)
    )
      fail('invalid_input')
    const checkpoint =
      options.afterId === undefined
        ? await db
            .prepare('SELECT last_id FROM product_watch_evaluation_cursor WHERE id=1')
            .first<{ last_id: string }>()
        : null
    if (
      options.afterId === undefined &&
      (!checkpoint || (checkpoint.last_id !== '' && !uuid.safeParse(checkpoint.last_id).success))
    )
      fail('history_unconfirmed')
    const after = options.afterId ?? checkpoint!.last_id
    const candidates = await db
      .prepare(`SELECT r.id ${watchFrom} WHERE w.status='confirmed' AND r.id>?1 ORDER BY r.id LIMIT ?2`)
      .bind(after, limit)
      .all<{ id: string }>()
    if (!candidates.success) fail('service_unavailable')
    let created = 0
    for (const candidate of candidates.results) {
      const watch = await load(db, candidate.id)
      if (!(await preference(db, watch, now))) continue
      let current: Facts
      try {
        current = await facts(db, watch.variant_legacy_id, now)
      } catch (cause) {
        if (cause instanceof ProductWatchError && cause.code === 'variant_unavailable') continue
        throw cause
      }
      const previous = await db
        .prepare(
          'SELECT sequence,available,gross_cents FROM product_watch_observations WHERE watch_id=? ORDER BY sequence DESC LIMIT 1'
        )
        .bind(watch.id)
        .first<{ sequence: number; available: number; gross_cents: number }>()
      if (
        previous &&
        (!Number.isSafeInteger(previous.sequence) ||
          previous.sequence < 1 ||
          ![0, 1].includes(previous.available) ||
          !Number.isSafeInteger(previous.gross_cents) ||
          previous.gross_cents < 0)
      )
        fail('history_unconfirmed')
      const sequence = (previous?.sequence ?? 0) + 1,
        priorAvailable = previous?.available ?? watch.baseline_available,
        priorGross = previous?.gross_cents ?? watch.baseline_gross_cents
      const notify =
        watch.kind === 'back_in_stock'
          ? priorAvailable === 0 && current.available === 1
          : current.available === 1 &&
            current.unitGrossCents < watch.baseline_gross_cents! &&
            current.unitGrossCents < priorGross!
      const sourceHash = await canonicalPayloadHash({
        watchId: watch.id,
        sequence,
        kind: watch.kind,
        priceVersionId: current.priceVersionId,
        grossCents: current.unitGrossCents,
        available: current.available
      })
      // Internal ?2..4 are unused. Preserve ?5 for the same source predicate
      // used by interactive mutation guards, without interpolated request SQL.
      const guarded = [
        now,
        null,
        null,
        null,
        JSON.stringify({ facts: current }),
        watch.id,
        sequence,
        sourceHash,
        notify ? 1 : 0,
        crypto.randomUUID()
      ]
      const live = `w.status='confirmed' AND ${projectionProof} AND ${liveRecipient} AND ${preferenceAllowed} AND ${factsGuard(now)}`
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO product_watch_observations(watch_id,sequence,source_hash,available,gross_cents,created_at)
          SELECT r.id,?7,?8,${json('facts.available')},${json('facts.unitGrossCents')},?1 ${watchFrom} WHERE r.id=?6 AND ${live}
          AND ?7=(SELECT count(*)+1 FROM product_watch_observations WHERE watch_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM product_watch_observations WHERE watch_id=r.id AND sequence=?7)`
          )
          .bind(...guarded.slice(0, 8)),
        db
          .prepare(
            `INSERT INTO product_watch_deliveries(id,watch_id,kind,source_hash,status,created_at)
          SELECT ?10,r.id,r.kind,?8,'pending',?1 ${watchFrom} WHERE r.id=?6 AND ?9=1 AND ${live}
          AND EXISTS(SELECT 1 FROM product_watch_observations WHERE watch_id=r.id AND sequence=?7 AND source_hash=?8)
          AND NOT EXISTS(SELECT 1 FROM product_watch_deliveries WHERE watch_id=r.id AND kind=r.kind AND source_hash=?8) RETURNING id`
          )
          .bind(...guarded)
      ])
      if (results.some((result) => !result.success)) fail('service_unavailable')
      created += results[1]!.results.length
    }
    const nextId = candidates.results.length === limit ? candidates.results.at(-1)!.id : null
    if (checkpoint) {
      const saved = await db
        .prepare('UPDATE product_watch_evaluation_cursor SET last_id=?1 WHERE id=1 AND last_id=?2')
        .bind(nextId ?? '', checkpoint.last_id)
        .run()
      if (!saved.success) fail('service_unavailable')
    }
    return { processed: candidates.results.length, created, nextId }
  })
}
function escape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
/** Explicit adapters only. Ambiguous provider outcomes become manual_review;
 * no retry after acceptance uncertainty and no provider configured here. */
export async function dispatchD1ProductWatchDeliveries(
  db: D1Database,
  sender: ProductWatchSender,
  options: ProductWatchOptions & { origin: string; limit?: number }
): Promise<{ sent: number; skipped: number; manualReview: number }> {
  return attempt(async () => {
    const now = clock(options),
      limit = options.limit ?? 5,
      origin = new URL(options.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== options.origin ||
      origin.username ||
      origin.password ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 5
    )
      fail('configuration_unavailable')
    secret(options)
    const stale = await db
      .prepare(
        "UPDATE product_watch_deliveries SET status='manual_review',finished_at=?1 WHERE status='sending' AND claimed_at<=strftime('%Y-%m-%dT%H:%M:%SZ',?1,'-15 minutes') RETURNING id"
      )
      .bind(now)
      .all()
    if (!stale.success) fail('service_unavailable')
    let sent = 0,
      skipped = 0,
      manualReview = stale.results.length
    const pending = await db
      .prepare(
        "SELECT id,watch_id,kind FROM product_watch_deliveries WHERE status='pending' AND created_at<=?1 ORDER BY created_at,id LIMIT ?2"
      )
      .bind(now, limit)
      .all<{ id: string; watch_id: string; kind: string }>()
    if (!pending.success) fail('service_unavailable')
    for (const job of pending.results) {
      const watch = await load(db, job.watch_id)
      let source: Facts | null = null
      try {
        source = await facts(db, watch.variant_legacy_id, now)
      } catch (cause) {
        if (!(cause instanceof ProductWatchError && cause.code === 'variant_unavailable')) throw cause
      }
      const permitted =
        job.kind === 'confirmation'
          ? watch.status === 'pending' && watch.confirmation_expires_at > now
          : watch.status === 'confirmed' && (await preference(db, watch, now))
      const guarded = [now, null, null, null, JSON.stringify({ facts: source }), job.id]
      const signal =
        job.kind === 'confirmation'
          ? '1'
          : job.kind === 'back_in_stock'
            ? `${json('facts.available')}=1`
            : `${json('facts.available')}=1 AND ${json('facts.unitGrossCents')}<w.baseline_gross_cents`
      // Compile the complete canonical catalogue predicate outside the nested
      // watch proof. Materialization remains inside this same atomic statement.
      const sourceCte = `WITH product_watch_publication_fact AS MATERIALIZED (
        SELECT p.id product_id,${publicationValidityExpression('p', '?1')} valid
        FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=${json('facts.variantId')}
      ), product_watch_source_fact AS MATERIALIZED (
        SELECT ${factsGuard(now, '(SELECT valid FROM product_watch_publication_fact WHERE product_id=p.id)')} allowed
      )`
      // Resolve the recipient by this exact durable delivery, not by a
      // correlated outer watch expression. Compile the cooldown in its own
      // materialized tree to stay within D1's fixed expression-depth budget.
      const recipientCte = `product_watch_recipient_fact AS MATERIALIZED (
        ${
          job.kind === 'confirmation'
            ? 'SELECT 1 allowed'
            : `SELECT (${recoveryRecipientAllowed}) AND NOT EXISTS(
        SELECT 1 FROM newsletter_editorial_caps cap
        JOIN newsletter_subscriptions subscriber ON subscriber.id=cap.subscription_id
        WHERE subscriber.email_normalized=r.recipient AND cap.next_eligible_at>?1) allowed
        FROM product_watch_requests r JOIN product_watch_deliveries delivery ON delivery.watch_id=r.id
        WHERE delivery.id=?6`
        }
      )`
      const watchEligibility = allSql([
        projectionProof,
        liveRecipient,
        signal,
        job.kind === 'confirmation'
          ? "w.status='pending' AND r.confirmation_expires_at>?1"
          : `w.status='confirmed' AND ${preferenceAllowed}`
      ])
      const claimed =
        source && permitted
          ? await db
              .prepare(
                `${sourceCte},${recipientCte} UPDATE product_watch_deliveries SET status='sending',claimed_at=?1
        ${watchFrom}
        JOIN product_watch_source_fact source_fact ON source_fact.allowed=1
        JOIN product_watch_recipient_fact recipient_fact ON recipient_fact.allowed=1
        WHERE product_watch_deliveries.id=?6 AND product_watch_deliveries.status='pending'
        AND r.id=product_watch_deliveries.watch_id AND ${watchEligibility} RETURNING id`
              )
              .bind(...guarded)
              .first()
          : null
      if (!claimed) {
        const skippedRow = await db
          .prepare(
            "UPDATE product_watch_deliveries SET status='skipped',finished_at=? WHERE id=? AND status='pending' RETURNING id"
          )
          .bind(now, job.id)
          .all()
        if (!skippedRow.success) fail('service_unavailable')
        skipped += skippedRow.results.length
        continue
      }
      try {
        // Final read immediately before the adapter: the documented in-flight
        // boundary cannot cancel a provider call already accepted externally.
        // Keep catalogue and watch predicates in separate SQL compilation
        // trees: combining both in a SELECT exceeds D1 expression depth.
        // One atomic batch still reads both authorities in the same snapshot.
        const check = await db.batch<{ allowed: number }>([
          db.prepare(`${sourceCte} SELECT allowed FROM product_watch_source_fact`).bind(...guarded.slice(0, 5)),
          db
            .prepare(
              `WITH ${recipientCte} SELECT 1 allowed ${watchFrom}
            JOIN product_watch_recipient_fact recipient_fact ON recipient_fact.allowed=1
            WHERE r.id=?7 AND ${watchEligibility} LIMIT 1`
            )
            .bind(...guarded, watch.id)
        ])
        if (
          check.some((result) => !result.success) ||
          check[0]?.results[0]?.allowed !== 1 ||
          check[1]?.results[0]?.allowed !== 1
        )
          throw new Error('pre_send_authority_changed')
        const link =
          job.kind === 'confirmation'
            ? `${options.origin}/cuenta/avisos-productos#watchId=${watch.id}&token=${await token(watch, options)}`
            : `${options.origin}/cuenta/avisos-productos`
        const subject =
          job.kind === 'confirmation'
            ? 'Confirma tu aviso de variante en NETECO'
            : job.kind === 'price_drop'
              ? 'Bajada de precio de tu variante en NETECO'
              : 'Reposición de tu variante en NETECO'
        const text =
          job.kind === 'confirmation'
            ? `Confirma el aviso solicitado: ${link}\nCaduca en 48 horas. Si no lo solicitaste, ignora este mensaje.`
            : `${subject}. Consulta las condiciones y disponibilidad actuales: ${link}. No reserva stock ni garantiza precio, disponibilidad o entrega.`
        const result = await sender.send({
          to: watch.recipient,
          subject,
          text,
          html: `<p>${escape(text)}</p><p><a href="${escape(link)}">${job.kind === 'confirmation' ? 'Confirmar aviso' : 'Consultar o cancelar aviso'}</a></p>`
        })
        if (
          typeof result.messageId !== 'string' ||
          result.messageId.length < 1 ||
          result.messageId.length > 200 ||
          Array.from(result.messageId).some((c) => c.charCodeAt(0) < 32)
        )
          throw new Error('unconfirmed_provider_receipt')
        const recorded = await db
          .prepare(
            "UPDATE product_watch_deliveries SET status='sent',finished_at=?,provider_message_id=? WHERE id=? AND status='sending' RETURNING id"
          )
          .bind(now, result.messageId, job.id)
          .first<{ id: string }>()
        if (recorded?.id !== job.id) throw new Error('unconfirmed_delivery_commit')
        sent++
      } catch {
        const marked = await db
          .prepare(
            "UPDATE product_watch_deliveries SET status='manual_review',finished_at=? WHERE id=? AND status='sending'"
          )
          .bind(now, job.id)
          .run()
        if (!marked.success) fail('service_unavailable')
        manualReview++
      }
    }
    return { sent, skipped, manualReview }
  })
}
