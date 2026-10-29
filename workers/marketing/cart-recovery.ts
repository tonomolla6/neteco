import type { VerifiedSessionClaims } from '../catalog/authorization'
import type {
  CartRecoveryPreference,
  CartRecoveryReceipt,
  CartRecoveryCommand,
  CartRecoveryResolved
} from '../../shared/cart-recovery'
import type { ProductWatchSender } from './product-watch'
import type { z } from 'zod'
import {
  authorizeD1AccountPreferences,
  AccountPreferencesError,
  accountPreferenceAuthoritySql as authoritySql,
  accountPreferenceAuthorityAllowedSql as authorityAllowed
} from '../auth/account-preferences'
import {
  getCart,
  CartError,
  prepareQuoteLinesStatement,
  quoteLinesQuery,
  mapQuoteLines,
  type RawResolvedLine
} from '../catalog/cart'
import { sha256Hex } from '../catalog/inventory'
import { validateQuantity, quoteLine } from '../../server/domain/money'
import {
  catalogPolicyInstantSchema as instant,
  catalogPolicyUuidSchema as uuid
} from '../../shared/catalog-publication-policy'
import {
  CART_RECOVERY_POLICY_VERSION as POLICY,
  CART_RECOVERY_NOTICE_TEXT as NOTICE,
  cartRecoveryPreferenceInputSchema,
  cartRecoveryAssociationInputSchema,
  cartRecoveryResumeInputSchema,
  cartRecoveryResolveInputSchema,
  cartRecoveryPreferenceSchema,
  cartRecoveryReceiptSchema,
  cartRecoveryResolvedSchema,
  cartRecoveryIntentHash
} from '../../shared/cart-recovery'

export class CartRecoveryError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'consent_required'
      | 'cart_unavailable'
      | 'history_unconfirmed'
      | 'configuration_unavailable'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'CartRecoveryError'
  }
}
export interface CartRecoveryOptions {
  now?: () => string
  hmacKey?: Uint8Array
}
export interface CartRecoveryPolicy {
  enabled: boolean
  waitSeconds: number
  frequencyCapSeconds: number
  tokenTtlSeconds: number
}
export type CartRecoverySender = ProductWatchSender
export interface CartRecoveryPossession {
  cartId: string
  token: string
}
function fail(code: CartRecoveryError['code']): never {
  throw new CartRecoveryError(code)
}
function all(clauses: string[]): string {
  if (!clauses.length) throw new Error('empty_recovery_guard')
  if (clauses.length === 1) return `(${clauses[0]})`
  const at = Math.floor(clauses.length / 2)
  return `(${all(clauses.slice(0, at))} AND ${all(clauses.slice(at))})`
}
function clock(options: CartRecoveryOptions) {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!instant.safeParse(now).success) fail('configuration_unavailable')
  return now
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) fail('invalid_input')
  return result.data
}
async function attempt<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback()
  } catch (cause) {
    if (cause instanceof CartRecoveryError) throw cause
    if (cause instanceof AccountPreferencesError)
      fail(cause.code === 'unavailable' ? 'service_unavailable' : cause.code)
    if (cause instanceof CartError) fail(cause.code === 'unauthorized' ? 'unauthenticated' : 'cart_unavailable')
    fail('service_unavailable')
  }
}
async function owner(db: D1Database, claims: VerifiedSessionClaims, options: CartRecoveryOptions, expected?: string) {
  const current = await authorizeD1AccountPreferences(db, claims, options)
  if (expected && current.customerId !== expected) fail('unauthenticated')
  return current
}
const j = (field: string) => `json_extract(?6,'$.${field}')`
const dedicatedProof = `EXISTS(SELECT 1 FROM cart_recovery_commands pc WHERE ${all(['pc.customer_id=p.customer_id', 'pc.actor_id=p.actor_id', 'pc.command_id=p.command_id', "pc.action='preferences'", 'pc.applied_version=p.version', "json_extract(pc.input_json,'$.recoveryEnabled')=p.recovery_enabled", 'pc.recorded_at=p.updated_at', "json_extract(pc.input_json,'$.policyVersion')='" + POLICY + "'", "p.version=(SELECT count(*) FROM cart_recovery_commands history WHERE history.customer_id=p.customer_id AND history.action='preferences')"])})`
const globalAllowed = `EXISTS(SELECT 1 FROM customer_account_preferences gp JOIN account_preference_commands gc ON gc.customer_id=gp.customer_id AND gc.command_id=gp.command_id WHERE ${all(['gp.customer_id=a.customer_id', 'gp.product_updates=1', 'gc.applied_version=gp.version', 'gc.product_updates=gp.product_updates', 'gc.replenishment=gp.replenishment', 'gc.recorded_at=gp.updated_at', 'gp.updated_at<=?1'])})`
const consentAllowed = all([
  `EXISTS(SELECT 1 FROM cart_recovery_preferences p WHERE ${all(['p.customer_id=a.customer_id', 'p.recovery_enabled=1', 'p.version=a.consent_version', 'p.updated_at<=?1', dedicatedProof])})`,
  globalAllowed
])
const identityAllowed = `EXISTS(SELECT 1 FROM identities i JOIN customers customer ON customer.id=i.customer_id WHERE ${all(['i.id=a.actor_id', 'i.customer_id=a.customer_id', "i.status='active'", "customer.status='active'", 'i.email_verified_at IS NOT NULL', 'i.email_verified_at<=?1', 'lower(i.email)=a.recipient'])})`
const cartActive = all([
  'k.id=a.cart_id',
  "k.status='active'",
  'k.expires_at>?1',
  'k.version=a.cart_version',
  'k.token_hash=a.cart_token_hash'
])
const assocFrom = 'FROM cart_recovery_associations a JOIN carts k ON k.id=a.cart_id'
const live = all([identityAllowed, consentAllowed, cartActive, "a.policy_version='" + POLICY + "'"])
function params(claims: VerifiedSessionClaims | null, now: string, cartId: string | null, envelope: unknown) {
  return [
    now,
    claims?.sessionId ?? null,
    claims?.identityId ?? null,
    claims?.sessionVersion ?? null,
    cartId,
    JSON.stringify(envelope)
  ]
}
function actorPredicate() {
  return `EXISTS(SELECT 1 FROM authority auth WHERE ${all([authorityAllowed.replaceAll('a.', 'auth.'), `auth.customerId=${j('customerId')}`, `auth.actorId=${j('actorId')}`])})`
}
async function preference(db: D1Database, customerId: string): Promise<CartRecoveryPreference> {
  const row = await db
    .prepare(`SELECT p.*,${dedicatedProof} proof FROM cart_recovery_preferences p WHERE p.customer_id=?`)
    .bind(customerId)
    .first<{ version: number; recovery_enabled: number; updated_at: string; proof: number }>()
  if (!row) {
    if (
      await db
        .prepare("SELECT 1 FROM cart_recovery_commands WHERE customer_id=? AND action='preferences' LIMIT 1")
        .bind(customerId)
        .first()
    )
      fail('history_unconfirmed')
    return cartRecoveryPreferenceSchema.parse({
      source: 'cloudflare',
      version: 0,
      recoveryEnabled: false,
      policyVersion: POLICY,
      noticeText: NOTICE,
      updatedAt: null
    })
  }
  if (row.proof !== 1) fail('history_unconfirmed')
  const result = cartRecoveryPreferenceSchema.safeParse({
    source: 'cloudflare',
    version: row.version,
    recoveryEnabled: row.recovery_enabled === 1,
    policyVersion: POLICY,
    noticeText: NOTICE,
    updatedAt: row.updated_at
  })
  if (!result.success) fail('history_unconfirmed')
  return result.data
}
interface Command {
  actor_id: string
  customer_id: string
  command_id: string
  action: 'preferences' | 'associate' | 'resume'
  association_id: string | null
  cart_id: string | null
  expected_version: number
  applied_version: number
  payload_hash: string
  input_json: string
  receipt_json: string
  grant_hash: string | null
  recorded_at: string
}
async function command(db: D1Database, claims: VerifiedSessionClaims, customerId: string, key: string, hash: string) {
  const row = await db
    .prepare('SELECT * FROM cart_recovery_commands WHERE actor_id=? AND customer_id=? AND command_id=?')
    .bind(claims.identityId, customerId, key)
    .first<Command>()
  if (!row) return null
  if (row.payload_hash !== hash) fail('conflict')
  let receipt: CartRecoveryReceipt
  try {
    receipt = cartRecoveryReceiptSchema.parse(JSON.parse(row.receipt_json))
  } catch {
    fail('history_unconfirmed')
  }
  if (
    receipt.commandId !== key ||
    receipt.action !== row.action ||
    receipt.payloadHash !== hash ||
    receipt.version !== row.applied_version ||
    receipt.recordedAt !== row.recorded_at ||
    receipt.associationId !== row.association_id
  )
    fail('history_unconfirmed')
  return { row, receipt }
}
function guard(db: D1Database, statement: string, bindings: unknown[]) {
  return db
    .prepare(`INSERT INTO cart_recovery_atomic_guards(id,valid) SELECT ?7,CASE WHEN (${statement}) THEN 1 ELSE 0 END`)
    .bind(...bindings, crypto.randomUUID())
}
function cleanGuards(db: D1Database) {
  return db.prepare('DELETE FROM cart_recovery_atomic_guards')
}
function receipt(
  action: CartRecoveryReceipt['action'],
  key: string,
  hash: string,
  version: number,
  now: string,
  fields: { associationId?: string; cartVersion?: number; recoveryEnabled: boolean }
): CartRecoveryReceipt {
  return cartRecoveryReceiptSchema.parse({
    source: 'cloudflare',
    commandId: key,
    action,
    payloadHash: hash,
    version,
    associationId: fields.associationId ?? null,
    cartVersion: fields.cartVersion ?? null,
    recoveryEnabled: fields.recoveryEnabled,
    recordedAt: now,
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
}
function commandInsert(
  db: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  key: string,
  action: Command['action'],
  raw: unknown,
  result: CartRecoveryReceipt,
  expected: number,
  cartId: string | null,
  grantHash: string | null
) {
  return db
    .prepare(
      `INSERT INTO cart_recovery_commands(actor_id,customer_id,command_id,action,association_id,cart_id,expected_version,applied_version,payload_hash,input_json,receipt_json,grant_hash,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      claims.identityId,
      customerId,
      key,
      action,
      result.associationId,
      cartId,
      expected,
      result.version,
      result.payloadHash,
      JSON.stringify(raw),
      JSON.stringify(result),
      grantHash,
      result.recordedAt
    )
}
const sourceFields = [
  'variantId',
  'productId',
  'categoryId',
  'quantity',
  'minimumQuantity',
  'maximumQuantity',
  'quantityIncrement',
  'variantStatus',
  'productStatus',
  'categoryStatus',
  'publicationValid',
  'sku',
  'name',
  'format',
  'unitLabel',
  'backorderAllowed',
  'taxRateBasisPoints',
  'unitGrossCents',
  'volumeTiersJson',
  'priceVersionId',
  'availableQuantity'
] as const
async function contents(db: D1Database, cartId: string, now: string) {
  const results = await db.batch([
    prepareQuoteLinesStatement(db, { cartId, instant: now }),
    db
      .prepare('SELECT id,legacy_id FROM variants WHERE id IN(SELECT variant_id FROM cart_lines WHERE cart_id=?)')
      .bind(cartId),
    db.prepare('SELECT count(*) n FROM cart_lines WHERE cart_id=?').bind(cartId)
  ])
  if (results.some((result) => !result.success)) fail('service_unavailable')
  const raw = results[0]!.results as unknown as RawResolvedLine[],
    count = results[2]!.results[0] as { n: number }
  if (!count || count.n < 1 || count.n > 100 || raw.length !== count.n) fail('cart_unavailable')
  const mapped = mapQuoteLines(raw),
    identities = results[1]!.results as unknown as { id: string; legacy_id: number | null }[]
  const lines = mapped.map((line) => {
    validateQuantity(line.quantity, line)
    if (line.availableQuantity < line.quantity && !line.backorderAllowed) fail('cart_unavailable')
    const identity = identities.find((value) => value.id === line.variantId)
    if (!identity || !Number.isSafeInteger(identity.legacy_id) || identity.legacy_id! < 1) fail('cart_unavailable')
    const money = quoteLine({
      variantId: line.variantId,
      sku: line.sku,
      quantity: line.quantity,
      unitGrossCents: line.unitGrossCents,
      taxRateBasisPoints: line.taxRateBasisPoints
    })
    return {
      variantId: identity.legacy_id!,
      quantity: line.quantity,
      name: line.name,
      sku: line.sku,
      unitGrossCents: line.unitGrossCents,
      netCents: money.netCents,
      taxCents: money.taxCents,
      grossCents: money.grossCents
    }
  })
  const source = raw.map((row) => Object.fromEntries(sourceFields.map((field) => [field, row[field]])))
  return { lines, source, positions: raw.map((row) => ({ variantId: row.variantId, quantity: row.quantity })) }
}
function sourceCte(cartId: string, now: string) {
  const query = quoteLinesQuery({ cartId, instant: now })
  return `canonical_lines AS MATERIALIZED (${query.sql.replaceAll('?1', '?5')})`
}
const sourceProof = all([
  '(SELECT count(*) FROM canonical_lines)=json_array_length(' + j('source') + ')',
  '(SELECT count(*) FROM cart_lines WHERE cart_id=?5)=json_array_length(' + j('source') + ')',
  `NOT EXISTS(SELECT 1 FROM canonical_lines line WHERE NOT EXISTS(SELECT 1 FROM json_each(${j('source')}) expected WHERE ${all(sourceFields.map((field) => `line.${field} IS json_extract(expected.value,'$.${field}')`))}))`
])
interface Association {
  id: string
  customer_id: string
  actor_id: string
  cart_id: string
  cart_version: number
  cart_token_hash: string
  stage: 'cart' | 'checkout'
  recipient: string
  consent_version: number
  policy_version: string
  lines_json: string
  activity_at: string
  created_at: string
}
async function associationById(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM cart_recovery_associations WHERE id=?').bind(id).first<Association>()
  if (!row) fail('not_found')
  if (
    !uuid.safeParse(row.id).success ||
    !instant.safeParse(row.activity_at).success ||
    !instant.safeParse(row.created_at).success ||
    row.policy_version !== POLICY
  )
    fail('history_unconfirmed')
  const proof = await db
    .prepare(
      "SELECT 1 FROM cart_recovery_commands WHERE association_id=? AND action='associate' AND customer_id=? AND cart_id=? AND json_extract(receipt_json,'$.cartVersion')=? LIMIT 1"
    )
    .bind(id, row.customer_id, row.cart_id, row.cart_version)
    .first()
  if (!proof) fail('history_unconfirmed')
  return row
}
export async function readD1CartRecoveryPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryPreference> {
  return attempt(async () => {
    const current = await owner(db, claims, options),
      value = await preference(db, current.customerId)
    await owner(db, claims, options, current.customerId)
    return value
  })
}
export async function updateD1CartRecoveryPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  key: string,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryReceipt> {
  return attempt(async () => {
    parsed(uuid, key)
    const input = parsed(cartRecoveryPreferenceInputSchema, raw),
      now = clock(options),
      current = await owner(db, claims, options),
      hash = await cartRecoveryIntentHash('preferences', input),
      replay = await command(db, claims, current.customerId, key, hash)
    if (replay) {
      await owner(db, claims, options, current.customerId)
      return replay.receipt
    }
    if ((await preference(db, current.customerId)).version !== input.expectedVersion) fail('version_conflict')
    const result = receipt('preferences', key, hash, input.expectedVersion + 1, now, {
        recoveryEnabled: input.recoveryEnabled
      }),
      bindings = params(claims, now, null, { customerId: current.customerId, actorId: current.actorId })
    try {
      await db.batch([
        commandInsert(
          db,
          claims,
          current.customerId,
          key,
          'preferences',
          input,
          result,
          input.expectedVersion,
          null,
          null
        ),
        guard(db, `${authoritySql} SELECT ${actorPredicate()}`, bindings),
        cleanGuards(db)
      ])
    } catch (cause) {
      await owner(db, claims, options, current.customerId)
      const raced = await command(db, claims, current.customerId, key, hash)
      if (raced) return raced.receipt
      if ((await preference(db, current.customerId)).version !== input.expectedVersion) fail('version_conflict')
      throw cause
    }
    await owner(db, claims, options, current.customerId)
    return result
  })
}
export async function associateD1CartRecovery(
  db: D1Database,
  claims: VerifiedSessionClaims,
  cart: CartRecoveryPossession,
  raw: unknown,
  key: string,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryReceipt> {
  return attempt(async () => {
    parsed(uuid, key)
    const input = parsed(cartRecoveryAssociationInputSchema, raw),
      now = clock(options),
      current = await owner(db, claims, options)
    const view = await getCart(db, cart),
      hash = await cartRecoveryIntentHash('associate', input),
      replay = await command(db, claims, current.customerId, key, hash)
    if (replay) {
      if (replay.row.cart_id !== cart.cartId) fail('conflict')
      await owner(db, claims, options, current.customerId)
      return replay.receipt
    }
    if (view.status !== 'active' || view.expiresAt <= now) fail('cart_unavailable')
    if (view.version !== input.expectedCartVersion) fail('version_conflict')
    const pref = await preference(db, current.customerId)
    if (!pref.recoveryEnabled) fail('consent_required')
    const content = await contents(db, cart.cartId, now),
      tokenHash = await sha256Hex(cart.token),
      identity = await db
        .prepare('SELECT lower(email) email FROM identities WHERE id=?')
        .bind(claims.identityId)
        .first<{ email: string }>()
    if (!identity) fail('unauthenticated')
    const cartRow = await db
      .prepare('SELECT updated_at FROM carts WHERE id=?')
      .bind(cart.cartId)
      .first<{ updated_at: string }>()
    if (!cartRow) fail('cart_unavailable')
    const existing = await db
        .prepare(
          'SELECT id FROM cart_recovery_associations WHERE customer_id=? AND cart_id=? AND cart_version=? AND stage=?'
        )
        .bind(current.customerId, cart.cartId, view.version, input.stage)
        .first<{ id: string }>(),
      id = existing?.id ?? crypto.randomUUID()
    const result = receipt('associate', key, hash, 1, now, {
        associationId: id,
        cartVersion: view.version,
        recoveryEnabled: true
      }),
      bindings = params(claims, now, cart.cartId, {
        customerId: current.customerId,
        actorId: current.actorId,
        source: content.source
      })
    const valid = all([
      actorPredicate(),
      sourceProof,
      `EXISTS(SELECT 1 FROM carts k WHERE ${all(['k.id=?5', "k.status='active'", 'k.expires_at>?1', `k.version=${view.version}`, `k.token_hash='${tokenHash}'`])})`,
      `EXISTS(SELECT 1 FROM cart_recovery_preferences p WHERE p.customer_id=${j('customerId')} AND p.version=${pref.version} AND p.recovery_enabled=1 AND ${dedicatedProof})`
    ])
    try {
      await db.batch([
        ...(existing
          ? []
          : [
              db
                .prepare(
                  'INSERT INTO cart_recovery_associations(id,customer_id,actor_id,cart_id,cart_version,cart_token_hash,stage,recipient,consent_version,policy_version,lines_json,activity_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
                )
                .bind(
                  id,
                  current.customerId,
                  claims.identityId,
                  cart.cartId,
                  view.version,
                  tokenHash,
                  input.stage,
                  identity.email,
                  pref.version,
                  POLICY,
                  JSON.stringify(content.positions),
                  cartRow.updated_at,
                  now
                )
            ]),
        commandInsert(db, claims, current.customerId, key, 'associate', input, result, view.version, cart.cartId, null),
        guard(db, `${authoritySql},${sourceCte(cart.cartId, now)} SELECT ${valid}`, bindings),
        cleanGuards(db)
      ])
    } catch (cause) {
      await owner(db, claims, options, current.customerId)
      const raced = await command(db, claims, current.customerId, key, hash)
      if (raced) return raced.receipt
      const fresh = await getCart(db, cart)
      if (fresh.version !== view.version) fail('version_conflict')
      throw cause
    }
    await owner(db, claims, options, current.customerId)
    return result
  })
}
export async function readD1CartRecoveryCommand(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryCommand> {
  return attempt(async () => {
    parsed(uuid, key)
    if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_input')
    const current = await owner(db, claims, options),
      stored = await command(db, claims, current.customerId, key, hash)
    await owner(db, claims, options, current.customerId)
    return stored
      ? { source: 'cloudflare', outcome: 'applied', receipt: stored.receipt }
      : { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}

function secret(options: CartRecoveryOptions) {
  if (!(options.hmacKey instanceof Uint8Array) || options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 128)
    fail('configuration_unavailable')
  return options.hmacKey
}
async function signature(options: CartRecoveryOptions, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret(options)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}
async function linkToken(
  association: Association,
  delivery: { id: string; expires_at: string },
  options: CartRecoveryOptions
) {
  return (
    'cr1.' +
    Array.from(
      await signature(
        options,
        `neteco:cart-recovery:link:v1\n${association.id}\n${association.customer_id}\n${delivery.id}\n${delivery.expires_at}`
      ),
      (value) => value.toString(16).padStart(2, '0')
    ).join('')
  )
}
async function resumedToken(association: Association, key: string, options: CartRecoveryOptions) {
  const bytes = await signature(
    options,
    `neteco:cart-recovery:resume:v1\n${association.id}\n${association.customer_id}\n${key}`
  )
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
function equal(a: string, b: string) {
  let difference = a.length ^ b.length
  for (let index = 0; index < Math.max(a.length, b.length); index++)
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0)
  return difference === 0
}
async function grant(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CartRecoveryOptions,
  replay = false
) {
  const input = parsed(cartRecoveryResolveInputSchema, raw),
    now = clock(options),
    current = await owner(db, claims, options),
    association = await associationById(db, input.id)
  if (association.customer_id !== current.customerId) fail('not_found')
  const delivery = await db
    .prepare(
      "SELECT id,expires_at FROM cart_recovery_deliveries WHERE association_id=? AND status IN('sent','sending','manual_review')"
    )
    .bind(association.id)
    .first<{ id: string; expires_at: string }>()
  if (!delivery || delivery.expires_at <= now || !equal(await linkToken(association, delivery, options), input.token))
    fail('not_found')
  const rotated = replay
    ? `OR EXISTS(SELECT 1 FROM cart_recovery_commands command WHERE command.association_id=a.id AND command.action='resume' AND command.cart_id=k.id AND command.grant_hash=k.token_hash AND command.applied_version=k.version)`
    : ''
  const row = await db
    .prepare(
      `SELECT 1 ${assocFrom} WHERE a.id=?2 AND ${all([identityAllowed, consentAllowed, "k.status='active'", 'k.expires_at>?1', `((k.version=a.cart_version AND k.token_hash=a.cart_token_hash) ${rotated})`])}`
    )
    .bind(now, association.id)
    .first()
  if (!row) fail('not_found')
  await owner(db, claims, options, current.customerId)
  return { association, delivery, current, now }
}
export async function resolveD1CartRecovery(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryResolved> {
  return attempt(async () => {
    const allowed = await grant(db, claims, raw, options),
      content = await contents(db, allowed.association.cart_id, allowed.now)
    if (JSON.stringify(content.positions) !== allowed.association.lines_json) fail('not_found')
    await grant(db, claims, raw, options)
    const fresh = await contents(db, allowed.association.cart_id, clock(options))
    if (JSON.stringify(fresh.source) !== JSON.stringify(content.source)) fail('not_found')
    await grant(db, claims, raw, options)
    await owner(db, claims, options, allowed.current.customerId)
    return cartRecoveryResolvedSchema.parse({
      source: 'cloudflare',
      associationId: allowed.association.id,
      cartId: allowed.association.cart_id,
      stage: allowed.association.stage,
      cartVersion: allowed.association.cart_version,
      expiresAt: allowed.delivery.expires_at,
      lines: content.lines,
      inventoryEffect: 'none',
      economicEffect: 'none',
      evaluatedAt: allowed.now
    })
  })
}
export async function readD1CartRecoveryResumeAuthority(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CartRecoveryOptions = {}
): Promise<{ cartId: string }> {
  return attempt(async () => {
    const input = parsed(cartRecoveryResumeInputSchema, raw),
      allowed = await grant(db, claims, { id: input.id, token: input.token }, options, true)
    return { cartId: allowed.association.cart_id }
  })
}
export interface CartRecoveryCartGrant {
  cartId: string
  token: string
  expiresAt: string
}
export interface ResumeRecoveryResult {
  receipt: CartRecoveryReceipt
  cart: CartRecoveryCartGrant
}
export async function resumeD1CartRecovery(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  key: string,
  options: CartRecoveryOptions = {}
): Promise<ResumeRecoveryResult> {
  return attempt(async () => {
    parsed(uuid, key)
    const input = parsed(cartRecoveryResumeInputSchema, raw),
      hash = await cartRecoveryIntentHash('resume', input),
      allowed = await grant(db, claims, { id: input.id, token: input.token }, options, true),
      association = allowed.association
    const token = await resumedToken(association, key, options),
      tokenHash = await sha256Hex(token),
      row = await db
        .prepare('SELECT expires_at,version,token_hash FROM carts WHERE id=?')
        .bind(association.cart_id)
        .first<{ expires_at: string; version: number; token_hash: string }>()
    if (!row) fail('not_found')
    const stored = await command(db, claims, allowed.current.customerId, key, hash)
    if (stored) {
      if (
        stored.row.action !== 'resume' ||
        stored.row.association_id !== association.id ||
        stored.row.grant_hash !== tokenHash ||
        row.token_hash !== tokenHash ||
        row.version !== stored.receipt.cartVersion
      )
        fail('not_found')
      await owner(db, claims, options, allowed.current.customerId)
      return { receipt: stored.receipt, cart: { cartId: association.cart_id, token, expiresAt: row.expires_at } }
    }
    if (row.version !== input.expectedCartVersion || row.version !== association.cart_version) fail('version_conflict')
    const content = await contents(db, association.cart_id, allowed.now)
    if (JSON.stringify(content.positions) !== association.lines_json) fail('not_found')
    const result = receipt('resume', key, hash, row.version + 1, allowed.now, {
        associationId: association.id,
        cartVersion: row.version + 1,
        recoveryEnabled: true
      }),
      bindings = params(claims, allowed.now, association.cart_id, {
        customerId: allowed.current.customerId,
        actorId: allowed.current.actorId,
        source: content.source
      })
    try {
      await db.batch([
        guard(
          db,
          `${authoritySql},${sourceCte(association.cart_id, allowed.now)} SELECT ${all([actorPredicate(), sourceProof, `EXISTS(SELECT 1 ${assocFrom} WHERE a.id='${association.id}' AND ${live})`, `EXISTS(SELECT 1 FROM cart_recovery_deliveries WHERE association_id='${association.id}' AND expires_at>?1 AND status IN('sent','sending','manual_review'))`])}`,
          bindings
        ),
        commandInsert(
          db,
          claims,
          allowed.current.customerId,
          key,
          'resume',
          { id: input.id, tokenHash: await sha256Hex(input.token), expectedCartVersion: input.expectedCartVersion },
          result,
          row.version,
          association.cart_id,
          tokenHash
        ),
        db
          .prepare(
            "UPDATE carts SET token_hash=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='active' AND expires_at>? AND token_hash=?"
          )
          .bind(tokenHash, allowed.now, association.cart_id, row.version, allowed.now, association.cart_token_hash),
        db
          .prepare(
            'INSERT INTO cart_recovery_atomic_guards(id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM carts WHERE id=? AND version=? AND token_hash=?) THEN 1 ELSE 0 END'
          )
          .bind(crypto.randomUUID(), association.cart_id, result.cartVersion, tokenHash),
        cleanGuards(db)
      ])
    } catch (cause) {
      await owner(db, claims, options, allowed.current.customerId)
      const replay = await command(db, claims, allowed.current.customerId, key, hash)
      if (replay && replay.row.grant_hash === tokenHash) {
        const fresh = await readD1CartRecoveryResumeGrant(db, claims, key, hash, options)
        if (!fresh) fail('not_found')
        return { receipt: replay.receipt, cart: fresh }
      }
      throw cause
    }
    const fresh = await readD1CartRecoveryResumeGrant(db, claims, key, hash, options)
    if (!fresh) fail('not_found')
    return { receipt: result, cart: fresh }
  })
}
/** Server-only recovered HttpOnly grant, never serialized in a response body. */
export async function readD1CartRecoveryResumeGrant(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: CartRecoveryOptions = {}
): Promise<CartRecoveryCartGrant | null> {
  return attempt(async () => {
    if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_input')
    const now = clock(options),
      current = await owner(db, claims, options),
      stored = await command(db, claims, current.customerId, parsed(uuid, key), hash)
    if (!stored || stored.row.action !== 'resume') return null
    const association = await associationById(db, stored.row.association_id!),
      token = await resumedToken(association, key, options)
    const active = await db
      .prepare(
        `SELECT k.expires_at ${assocFrom} WHERE a.id=?2 AND ${all([identityAllowed, consentAllowed, "k.status='active'", 'k.expires_at>?1', 'k.version=?3', 'k.token_hash=?4', "EXISTS(SELECT 1 FROM cart_recovery_deliveries d WHERE d.association_id=a.id AND d.expires_at>?1 AND d.status IN('sent','sending','manual_review'))"])}`
      )
      .bind(now, association.id, stored.receipt.cartVersion, await sha256Hex(token))
      .first<{ expires_at: string }>()
    if (!active) fail('not_found')
    await owner(db, claims, options, current.customerId)
    return { cartId: association.cart_id, token, expiresAt: active.expires_at }
  })
}
function config(policy: CartRecoveryPolicy) {
  if (
    !policy ||
    typeof policy.enabled !== 'boolean' ||
    ![policy.waitSeconds, policy.frequencyCapSeconds, policy.tokenTtlSeconds].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 2592000
    )
  )
    fail('configuration_unavailable')
  return policy
}
const after = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
function boundLimit(value: number | undefined) {
  const limit = value ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) fail('invalid_input')
  return limit
}
const newsletterCap = `NOT EXISTS(SELECT 1 FROM newsletter_editorial_caps cap JOIN newsletter_subscriptions subscriber ON subscriber.id=cap.subscription_id WHERE subscriber.email_normalized=a.recipient AND cap.next_eligible_at>?1)`
const recoveryCap = `NOT EXISTS(SELECT 1 FROM cart_recovery_deliveries cap WHERE cap.customer_id=a.customer_id AND cap.next_eligible_at>?1 AND cap.status<>'skipped')`
export async function evaluateD1CartRecoveries(
  db: D1Database,
  options: CartRecoveryOptions & { policy: CartRecoveryPolicy; limit?: number }
): Promise<{ processed: number; created: number }> {
  return attempt(async () => {
    const policy = config(options.policy),
      now = clock(options),
      limit = boundLimit(options.limit)
    if (!policy.enabled) return { processed: 0, created: 0 }
    const cursor = await db
      .prepare('SELECT last_id FROM cart_recovery_evaluation_cursor WHERE id=1')
      .first<{ last_id: string }>()
    if (!cursor) fail('history_unconfirmed')
    const candidates = await db
      .prepare(
        `SELECT a.id ${assocFrom} WHERE a.id>?2 AND ${live} AND a.activity_at<=?3 AND NOT EXISTS(SELECT 1 FROM cart_recovery_deliveries d WHERE d.association_id=a.id) ORDER BY a.id LIMIT ?4`
      )
      .bind(now, cursor.last_id, after(now, -policy.waitSeconds), limit)
      .all<{ id: string }>()
    if (!candidates.success) fail('service_unavailable')
    let created = 0
    for (const candidate of candidates.results) {
      const association = await associationById(db, candidate.id)
      let content: Awaited<ReturnType<typeof contents>>
      try {
        content = await contents(db, association.cart_id, now)
      } catch (cause) {
        if (cause instanceof CartError || (cause instanceof CartRecoveryError && cause.code === 'cart_unavailable'))
          continue
        throw cause
      }
      if (JSON.stringify(content.positions) !== association.lines_json) continue
      const id = crypto.randomUUID(),
        hash = await sha256Hex(JSON.stringify(content.source)),
        bindings = params(null, now, association.cart_id, { source: content.source })
      const result = await db
        .prepare(
          `WITH ${sourceCte(association.cart_id, now)} INSERT INTO cart_recovery_deliveries(id,association_id,customer_id,status,source_hash,created_at,expires_at,next_eligible_at)
    SELECT ?7,a.id,a.customer_id,'pending',?8,?1,?9,?10 ${assocFrom} WHERE a.id=?11 AND ${all([live, sourceProof, newsletterCap, recoveryCap, 'a.activity_at<=?12', 'NOT EXISTS(SELECT 1 FROM cart_recovery_deliveries existing WHERE existing.association_id=a.id)'])} RETURNING id`
        )
        .bind(
          ...bindings,
          id,
          hash,
          after(now, policy.tokenTtlSeconds),
          after(now, policy.frequencyCapSeconds),
          association.id,
          after(now, -policy.waitSeconds)
        )
        .all()
      if (!result.success) fail('service_unavailable')
      created += result.results.length
    }
    const next = candidates.results.length === limit ? candidates.results.at(-1)!.id : ''
    const updated = await db
      .prepare('UPDATE cart_recovery_evaluation_cursor SET last_id=? WHERE id=1 AND last_id=?')
      .bind(next, cursor.last_id)
      .run()
    if (!updated.success) fail('service_unavailable')
    return { processed: candidates.results.length, created }
  })
}
function escape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
// This predicate runs inside the conditional UPDATE, not a JS preflight.
// An in-flight claim holds the customer slot until it is resolved; ambiguous
// outcomes consume the same cooldown as confirmed sends and are never retried.
function dispatchFrequencyCap(seconds: number) {
  return `NOT EXISTS(SELECT 1 FROM cart_recovery_deliveries cap WHERE cap.customer_id=a.customer_id AND cap.association_id<>a.id AND (cap.status='sending' OR (cap.status IN('sent','manual_review') AND cap.finished_at>strftime('%Y-%m-%dT%H:%M:%SZ',?1,'-${seconds} seconds'))))`
}
// Keep this recipient fact in a separate compilation tree: the canonical
// catalogue/source proof already approaches D1's expression-depth budget.
function dispatchWatchRecipientFact(associationIdSql: string) {
  return `cart_recovery_watch_recipient_fact AS MATERIALIZED (
    SELECT NOT EXISTS(SELECT 1 FROM product_watch_deliveries delivery
      JOIN product_watch_requests watch ON watch.id=delivery.watch_id
      WHERE watch.recipient=a.recipient AND delivery.kind<>'confirmation' AND delivery.status='sending') allowed
    FROM cart_recovery_associations a WHERE a.id=${associationIdSql})`
}
export async function dispatchD1CartRecoveries(
  db: D1Database,
  sender: CartRecoverySender,
  options: CartRecoveryOptions & { policy: CartRecoveryPolicy; origin: string; limit?: number }
): Promise<{ sent: number; skipped: number; manualReview: number }> {
  return attempt(async () => {
    const policy = config(options.policy),
      now = clock(options),
      limit = boundLimit(options.limit)
    if (!policy.enabled) return { sent: 0, skipped: 0, manualReview: 0 }
    const origin = new URL(options.origin)
    if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username || origin.password)
      fail('configuration_unavailable')
    secret(options)
    const stale = await db
      .prepare(
        "UPDATE cart_recovery_deliveries SET status='manual_review',finished_at=?1 WHERE status='sending' AND claimed_at<=?2 RETURNING id"
      )
      .bind(now, after(now, -900))
      .all()
    if (!stale.success) fail('service_unavailable')
    let sent = 0,
      skipped = 0,
      manualReview = stale.results.length
    const pending = await db
      .prepare(
        "SELECT id,association_id,expires_at FROM cart_recovery_deliveries WHERE status='pending' AND created_at<=?1 ORDER BY created_at,id LIMIT ?2"
      )
      .bind(now, limit)
      .all<{ id: string; association_id: string; expires_at: string }>()
    if (!pending.success) fail('service_unavailable')
    for (const delivery of pending.results) {
      const association = await associationById(db, delivery.association_id)
      let content: Awaited<ReturnType<typeof contents>> | null = null
      try {
        content = await contents(db, association.cart_id, now)
      } catch (cause) {
        if (!(cause instanceof CartError || (cause instanceof CartRecoveryError && cause.code === 'cart_unavailable')))
          throw cause
      }
      const bindings = params(null, now, association.cart_id, { source: content?.source ?? [] }),
        eligibility = all([
          live,
          sourceProof,
          newsletterCap,
          dispatchFrequencyCap(policy.frequencyCapSeconds),
          'a.id=cart_recovery_deliveries.association_id',
          'cart_recovery_deliveries.expires_at>?1'
        ])
      const claimed =
        content && JSON.stringify(content.positions) === association.lines_json
          ? await db
              .prepare(
                `WITH ${sourceCte(association.cart_id, now)},${dispatchWatchRecipientFact('(SELECT association_id FROM cart_recovery_deliveries WHERE id=?7)')} UPDATE cart_recovery_deliveries SET status='sending',claimed_at=?1 ${assocFrom}
                JOIN cart_recovery_watch_recipient_fact watch_recipient ON watch_recipient.allowed=1
                WHERE cart_recovery_deliveries.id=?7 AND cart_recovery_deliveries.status='pending' AND ${eligibility} RETURNING id`
              )
              .bind(...bindings, delivery.id)
              .first<{ id: string }>()
          : null
      if (!claimed) {
        const discarded = await db
          .prepare(
            "UPDATE cart_recovery_deliveries SET status='skipped',finished_at=? WHERE id=? AND status='pending' RETURNING id"
          )
          .bind(now, delivery.id)
          .all()
        if (!discarded.success) fail('service_unavailable')
        skipped += discarded.results.length
        continue
      }
      try {
        const token = await linkToken(association, delivery, options),
          current = clock(options),
          check = await db
            .prepare(
              `WITH ${sourceCte(association.cart_id, current)},${dispatchWatchRecipientFact('?7')} SELECT 1 allowed ${assocFrom}
              JOIN cart_recovery_watch_recipient_fact watch_recipient ON watch_recipient.allowed=1
              WHERE a.id=?7 AND ${all([live, sourceProof, newsletterCap, dispatchFrequencyCap(policy.frequencyCapSeconds), "EXISTS(SELECT 1 FROM cart_recovery_deliveries d WHERE d.association_id=a.id AND d.status='sending' AND d.expires_at>?1)"])}`
            )
            .bind(...params(null, current, association.cart_id, { source: content!.source }), association.id)
            .first<{ allowed: number }>()
        if (check?.allowed !== 1) throw new Error('recovery_pre_send_authority_changed')
        const tokenUrl = `${options.origin}/cuenta/recuperar-carrito#id=${association.id}&token=${token}`,
          text = `Tienes un ${association.stage === 'checkout' ? 'checkout' : 'carrito'} pendiente. Revisa y retómalo si quieres: ${tokenUrl}\nLos precios y la disponibilidad se comprueban de nuevo. No reserva stock ni acepta un pago. Puedes desactivar estos recordatorios en Comunicaciones.`,
          result = await sender.send({
            to: association.recipient,
            subject: 'Revisa tu carrito pendiente en NETECO',
            text,
            html: `<p>${escape(text)}</p><p><a href="${escape(tokenUrl)}">Revisar carrito</a></p>`
          })
        if (
          typeof result.messageId !== 'string' ||
          !result.messageId.length ||
          result.messageId.length > 200 ||
          [...result.messageId].some((value) => value.charCodeAt(0) < 32)
        )
          throw new Error('recovery_unconfirmed_provider_receipt')
        const recorded = await db
          .prepare(
            "UPDATE cart_recovery_deliveries SET status='sent',finished_at=?,provider_message_id=? WHERE id=? AND status='sending' RETURNING id"
          )
          .bind(clock(options), result.messageId, delivery.id)
          .first<{ id: string }>()
        if (recorded?.id !== delivery.id) throw new Error('recovery_delivery_commit_unconfirmed')
        sent++
      } catch {
        const manual = await db
          .prepare(
            "UPDATE cart_recovery_deliveries SET status='manual_review',finished_at=? WHERE id=? AND status='sending' RETURNING id"
          )
          .bind(clock(options), delivery.id)
          .first()
        if (!manual) fail('service_unavailable')
        manualReview++
      }
    }
    return { sent, skipped, manualReview }
  })
}
