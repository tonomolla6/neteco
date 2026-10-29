import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { authorizeD1AccountPreferences, AccountPreferencesError } from '../auth/account-preferences'
import {
  assertCartAuthorized,
  CartError,
  prepareQuoteLinesStatement,
  mapQuoteLines,
  type RawResolvedLine
} from './cart'
import { canonicalJson, sha256Hex } from './inventory'
import { publicationValidityExpression } from './publication-validity'
import { quoteLine, validateQuantity } from '../../server/domain/money'
import {
  catalogPolicyInstantSchema as instant,
  catalogPolicyUuidSchema as uuid
} from '../../shared/catalog-publication-policy'
import {
  cartSnapshotInputSchema,
  cartSnapshotReceiptSchema,
  cartSnapshotResponseSchema,
  cartSnapshotRevokeInputSchema,
  cartSnapshotRevokeReceiptSchema,
  cartSnapshotIntentHash,
  cartSnapshotRevokeIntentHash,
  sharedCartResolveInputSchema,
  sharedCartResolveResponseSchema,
  cartSnapshotListSchema,
  type CartSnapshotResponse,
  type CartSnapshotCommand,
  type CartSnapshotList,
  type CartSnapshotRevokeReceipt,
  type SharedCartResolveResponse
} from '../../shared/cart-snapshots'

export interface CartSnapshotAccess {
  claims: VerifiedSessionClaims | null
  cartId: string
  cartToken: string
}
export interface CartSnapshotCommandAccess {
  claims: VerifiedSessionClaims | null
  cartId?: string
  cartToken?: string
}
export interface CartSnapshotOptions {
  now?: string
}
export class CartSnapshotError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'not_found'
      | 'version_conflict'
      | 'conflict'
      | 'empty_cart'
      | 'limit_reached'
      | 'already_exists'
      | 'variant_not_available'
      | 'service_unavailable'
  ) {
    super(code)
    this.name = 'CartSnapshotError'
  }
}
function fail(code: CartSnapshotError['code']): never {
  throw new CartSnapshotError(code)
}
function clock(options: CartSnapshotOptions) {
  const start = Date.now(),
    now = options.now ?? new Date(start).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!instant.safeParse(now).success) fail('invalid_input')
  return {
    now,
    fresh: () => new Date(Date.parse(now) + Math.max(0, Date.now() - start)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
}
async function owner(db: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  try {
    return await authorizeD1AccountPreferences(db, claims, { now: () => now })
  } catch (error) {
    if (
      error instanceof AccountPreferencesError &&
      error.code !== 'unavailable' &&
      error.code !== 'conflict' &&
      error.code !== 'invalid_input'
    )
      fail(error.code)
    return fail('service_unavailable')
  }
}
async function cartAuthority(db: D1Database, access: CartSnapshotCommandAccess) {
  if (!access.cartId || !access.cartToken) fail('unauthenticated')
  try {
    await assertCartAuthorized(db, access.cartId, access.cartToken)
  } catch (error) {
    if (error instanceof CartError && error.code === 'unauthorized') fail('unauthenticated')
    fail('service_unavailable')
  }
}
async function tokenFor(cartToken: string, shareId: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(cartToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`neteco:cart-share:v1\n${shareId}`))
  )
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
interface CommandRow {
  actor_id: string
  command_id: string
  customer_id: string
  action: 'create' | 'revoke'
  payload_hash: string
  cart_id: string | null
  list_id: string | null
  share_id: string | null
  cart_version: number | null
  receipt_json: string
  created_at: string
}
interface ShareRow {
  id: string
  customer_id: string
  creator_identity_id: string
  create_command_id: string
  list_id: string
  token_hash: string
  snapshot_json: string
  created_at: string
  expires_at: string
  revoked_at: string | null
}
async function command(db: D1Database, actor: string, customer: string, key: string) {
  try {
    return await db
      .prepare('SELECT * FROM customer_cart_snapshot_commands WHERE actor_id=?1 AND customer_id=?2 AND command_id=?3')
      .bind(actor, customer, key)
      .first<CommandRow>()
  } catch {
    return fail('service_unavailable')
  }
}
function receiptOf(row: CommandRow) {
  let raw: unknown
  try {
    raw = JSON.parse(row.receipt_json)
  } catch {
    return fail('service_unavailable')
  }
  if (row.action === 'create') {
    const p = cartSnapshotReceiptSchema.safeParse(raw)
    if (!p.success) return fail('service_unavailable')
    const r = p.data
    if (
      r.commandId !== row.command_id ||
      r.payloadHash !== row.payload_hash ||
      r.listId !== row.list_id ||
      r.shareId !== row.share_id ||
      r.cartVersion !== row.cart_version ||
      r.createdAt !== row.created_at
    )
      return fail('service_unavailable')
    return r
  }
  if (row.action !== 'revoke') return fail('service_unavailable')
  const p = cartSnapshotRevokeReceiptSchema.safeParse(raw)
  if (
    !p.success ||
    p.data.commandId !== row.command_id ||
    p.data.payloadHash !== row.payload_hash ||
    p.data.shareId !== row.share_id
  )
    return fail('service_unavailable')
  return p.data
}
async function createResponse(
  db: D1Database,
  row: CommandRow,
  access: CartSnapshotCommandAccess
): Promise<CartSnapshotResponse> {
  if (row.action !== 'create' || row.cart_id !== access.cartId) fail('unauthenticated')
  await cartAuthority(db, access)
  const receipt = cartSnapshotReceiptSchema.parse(receiptOf(row))
  let share: CartSnapshotResponse['share'] = null
  if (receipt.shareId !== null) {
    const stored = await db
      .prepare('SELECT * FROM customer_cart_shares WHERE id=?1')
      .bind(receipt.shareId)
      .first<ShareRow>()
    if (
      !stored ||
      stored.creator_identity_id !== row.actor_id ||
      stored.customer_id !== row.customer_id ||
      stored.create_command_id !== row.command_id ||
      stored.list_id !== receipt.listId ||
      stored.created_at !== receipt.createdAt ||
      stored.expires_at !== receipt.expiresAt
    )
      fail('service_unavailable')
    const token = await tokenFor(access.cartToken!, receipt.shareId)
    if ((await sha256Hex(token)) !== stored.token_hash) fail('service_unavailable')
    share = { id: receipt.shareId, token, expiresAt: stored.expires_at }
  }
  return cartSnapshotResponseSchema.parse({ source: 'cloudflare', receipt, share })
}
// Identical live account/email/conditional-MFA policy to account preferences.
// Mutation time is SQL-real unless an explicitly injected internal test clock exists.
const mutationCte = `WITH a AS MATERIALIZED(SELECT json_extract(?1,'$.sessionId') sessionId,json_extract(?1,'$.actorId') actorId,
 json_extract(?1,'$.sessionVersion') sessionVersion,json_extract(?1,'$.customerId') customerId,
 COALESCE(json_extract(?1,'$.clock'),strftime('%Y-%m-%dT%H:%M:%SZ','now')) now),
 authority AS MATERIALIZED(SELECT c.id customerId,i.id actorId FROM a JOIN auth_sessions s ON s.id=a.sessionId
 JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE i.id=a.actorId AND c.id=a.customerId AND s.session_version=a.sessionVersion AND s.session_version=i.session_version
 AND i.status='active' AND c.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=a.now
 AND s.revoked_at IS NULL AND s.created_at<=a.now AND s.expires_at>a.now
 AND (s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL)))`
const validCart = `EXISTS(SELECT 1 FROM carts c,a WHERE c.id=json_extract(?1,'$.cartId') AND c.token_hash=json_extract(?1,'$.cartTokenHash')
 AND c.status='active' AND c.expires_at>a.now AND c.version=json_extract(?1,'$.cartVersion'))`
const validLines = `(SELECT count(*) FROM cart_lines WHERE cart_id=json_extract(?1,'$.cartId')) BETWEEN 1 AND 100
 AND NOT EXISTS(SELECT 1 FROM cart_lines cl LEFT JOIN variants v ON v.id=cl.variant_id
 LEFT JOIN products p ON p.id=v.product_id LEFT JOIN categories c ON c.id=p.category_id
 WHERE cl.cart_id=json_extract(?1,'$.cartId') AND (v.id IS NULL OR v.status<>'published' OR p.status<>'published' OR c.status<>'published'
 OR NOT COALESCE(${publicationValidityExpression('p')},0) OR cl.quantity<1 OR cl.quantity>999
 OR cl.quantity<v.minimum_quantity OR (v.maximum_quantity IS NOT NULL AND cl.quantity>v.maximum_quantity)
 OR (cl.quantity-v.minimum_quantity)%v.quantity_increment<>0))`
function argumentsFor(
  access: CartSnapshotCommandAccess,
  customerId: string,
  options: CartSnapshotOptions,
  extra: Record<string, unknown>
) {
  if (!access.claims) return fail('unauthenticated')
  return JSON.stringify({
    sessionId: access.claims.sessionId,
    actorId: access.claims.identityId,
    sessionVersion: access.claims.sessionVersion,
    customerId,
    clock: options.now ?? null,
    ...extra
  })
}
/** Last await before returning private data: customer binding and original cart
 * possession are proved together, not in two separately revocable reads. */
async function releaseAuthority(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  now: string | null,
  access?: CartSnapshotCommandAccess
) {
  const hash = access?.cartToken ? await sha256Hex(access.cartToken) : null
  if (access && (!access.cartId || !hash)) fail('unauthenticated')
  const args = argumentsFor({ claims }, customerId, now === null ? {} : { now }, {
    cartId: access?.cartId ?? null,
    cartTokenHash: hash
  })
  const row = await db
    .prepare(
      `${mutationCte} SELECT customerId FROM authority WHERE json_extract(?1,'$.cartId') IS NULL
    OR EXISTS(SELECT 1 FROM carts WHERE id=json_extract(?1,'$.cartId') AND token_hash=json_extract(?1,'$.cartTokenHash'))`
    )
    .bind(args)
    .first()
  if (!row) fail('unauthenticated')
}
export async function saveD1CartSnapshot(
  db: D1Database,
  access: CartSnapshotAccess,
  raw: unknown,
  options: CartSnapshotOptions & { idempotencyKey: string }
): Promise<CartSnapshotResponse> {
  const time = clock(options),
    current = await owner(db, access.claims, time.fresh())
  await cartAuthority(db, access)
  const input = cartSnapshotInputSchema.safeParse(raw)
  if (!input.success || !uuid.safeParse(options.idempotencyKey).success) fail('invalid_input')
  const hash = await cartSnapshotIntentHash(input.data),
    existing = await command(db, current.actorId, current.customerId, options.idempotencyKey)
  if (existing) {
    if (existing.payload_hash !== hash || existing.action !== 'create') fail('conflict')
    const response = await createResponse(db, existing, access)
    await releaseAuthority(
      db,
      access.claims,
      current.customerId,
      options.now === undefined ? null : time.fresh(),
      access
    )
    return response
  }
  const cart = await db
    .prepare('SELECT status,version,expires_at FROM carts WHERE id=?1')
    .bind(access.cartId)
    .first<{ status: string; version: number; expires_at: string }>()
  if (!cart || cart.status !== 'active' || cart.expires_at <= time.fresh()) fail('conflict')
  if (cart.version !== input.data.expectedCartVersion) fail('version_conflict')
  const rows = await db
    .prepare('SELECT variant_id AS variantId,quantity FROM cart_lines WHERE cart_id=?1 ORDER BY variant_id')
    .bind(access.cartId)
    .all<{ variantId: string; quantity: number }>()
  if (!rows.results.length) fail('empty_cart')
  if (rows.results.length > 100) fail('limit_reached')
  let resolved
  try {
    resolved = mapQuoteLines(
      (await prepareQuoteLinesStatement(db, { lines: rows.results, instant: time.now }).all<RawResolvedLine>()).results
    )
  } catch (error) {
    if (error instanceof CartError && error.code === 'variant_not_available') fail('variant_not_available')
    return fail('service_unavailable')
  }
  if (resolved.length !== rows.results.length) fail('variant_not_available')
  for (const line of resolved) {
    try {
      validateQuantity(line.quantity, line)
      if (line.quantity > 999) fail('invalid_input')
    } catch {
      fail('invalid_input')
    }
  }
  const state = await db
    .prepare(
      `SELECT (SELECT count(*) FROM customer_favorite_lists WHERE customer_id=?1 AND is_default=0) total,
    EXISTS(SELECT 1 FROM customer_favorite_lists WHERE customer_id=?1 AND name=?2) duplicate`
    )
    .bind(current.customerId, input.data.name)
    .first<{ total: number; duplicate: number }>()
  if (!state) fail('service_unavailable')
  if (state.duplicate) fail('already_exists')
  if (state.total >= 20) fail('limit_reached')
  const listId = crypto.randomUUID(),
    shareId = input.data.createShare ? crypto.randomUUID() : null
  const expiresAt =
    shareId === null ? null : new Date(Date.parse(time.now) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const receipt = {
    commandId: options.idempotencyKey,
    payloadHash: hash,
    listId,
    shareId,
    cartVersion: cart.version,
    createdAt: time.now,
    expiresAt
  }
  const token = shareId === null ? null : await tokenFor(access.cartToken, shareId)
  const args = argumentsFor(access, current.customerId, options, {
    cartId: access.cartId,
    cartTokenHash: await sha256Hex(access.cartToken),
    cartVersion: cart.version,
    key: options.idempotencyKey,
    hash,
    listId,
    name: input.data.name,
    shareId,
    expiresAt,
    createdAt: time.now,
    receipt: JSON.stringify(receipt),
    tokenHash: token === null ? null : await sha256Hex(token)
  })
  const q = (sql: string) => db.prepare(`${mutationCte} ${sql}`).bind(args)
  try {
    await db.batch([
      q(`INSERT INTO customer_cart_snapshot_commands(actor_id,command_id,customer_id,action,payload_hash,cart_id,list_id,share_id,cart_version,receipt_json,created_at)
      SELECT actorId,json_extract(?1,'$.key'),customerId,'create',json_extract(?1,'$.hash'),json_extract(?1,'$.cartId'),json_extract(?1,'$.listId'),json_extract(?1,'$.shareId'),json_extract(?1,'$.cartVersion'),json_extract(?1,'$.receipt'),json_extract(?1,'$.createdAt') FROM authority
      WHERE ${validCart} AND ${validLines} AND (SELECT count(*) FROM customer_favorite_lists WHERE customer_id=authority.customerId AND is_default=0)<20
      AND NOT EXISTS(SELECT 1 FROM customer_favorite_lists WHERE customer_id=authority.customerId AND name=json_extract(?1,'$.name'))`),
      q(`INSERT INTO customer_favorite_lists(id,customer_id,name,is_default,created_at,updated_at)
      SELECT list_id,customer_id,json_extract(?1,'$.name'),0,created_at,created_at FROM customer_cart_snapshot_commands WHERE actor_id=(SELECT actorId FROM authority) AND command_id=json_extract(?1,'$.key')`),
      q(`INSERT INTO customer_favorite_items(list_id,variant_id,quantity,created_at,updated_at)
      SELECT c.list_id,cl.variant_id,cl.quantity,c.created_at,c.created_at FROM customer_cart_snapshot_commands c JOIN cart_lines cl ON cl.cart_id=c.cart_id WHERE c.actor_id=(SELECT actorId FROM authority) AND c.command_id=json_extract(?1,'$.key')`),
      ...(shareId === null
        ? []
        : [
            q(`INSERT INTO customer_cart_shares(id,customer_id,creator_identity_id,create_command_id,list_id,token_hash,snapshot_json,created_at,expires_at)
      SELECT c.share_id,c.customer_id,c.actor_id,c.command_id,c.list_id,json_extract(?1,'$.tokenHash'),
      (SELECT json_group_array(json_object('variantId',variant_id,'quantity',quantity)) FROM (SELECT variant_id,quantity FROM customer_favorite_items WHERE list_id=c.list_id ORDER BY variant_id)),c.created_at,json_extract(?1,'$.expiresAt')
      FROM customer_cart_snapshot_commands c WHERE c.actor_id=(SELECT actorId FROM authority) AND c.command_id=json_extract(?1,'$.key')`)
          ]),
      q(`INSERT INTO customer_cart_snapshot_guards(id,valid) SELECT json_extract(?1,'$.key'),CASE WHEN EXISTS(SELECT 1 FROM authority) AND ${validCart} AND ${validLines}
      AND EXISTS(SELECT 1 FROM customer_cart_snapshot_commands WHERE actor_id=(SELECT actorId FROM authority) AND command_id=json_extract(?1,'$.key'))
      AND (SELECT count(*) FROM customer_favorite_items WHERE list_id=json_extract(?1,'$.listId'))=(SELECT count(*) FROM cart_lines WHERE cart_id=json_extract(?1,'$.cartId'))
      AND (json_extract(?1,'$.shareId') IS NULL OR EXISTS(SELECT 1 FROM customer_cart_shares WHERE id=json_extract(?1,'$.shareId'))) THEN 1 ELSE 0 END`),
      db.prepare('DELETE FROM customer_cart_snapshot_guards WHERE id=?1').bind(options.idempotencyKey)
    ])
  } catch (error) {
    await releaseAuthority(
      db,
      access.claims,
      current.customerId,
      options.now === undefined ? null : time.fresh(),
      access
    )
    const replay = await command(db, current.actorId, current.customerId, options.idempotencyKey)
    if (replay) {
      if (replay.payload_hash !== hash || replay.action !== 'create') fail('conflict')
      const response = await createResponse(db, replay, access)
      await releaseAuthority(
        db,
        access.claims,
        current.customerId,
        options.now === undefined ? null : time.fresh(),
        access
      )
      return response
    }
    const latest = await db
      .prepare('SELECT status,version,expires_at FROM carts WHERE id=?1')
      .bind(access.cartId)
      .first<{ status: string; version: number; expires_at: string }>()
    if (latest && latest.version !== cart.version) fail('version_conflict')
    if (latest && (latest.status !== 'active' || latest.expires_at <= time.fresh())) fail('conflict')
    void error
    fail('service_unavailable')
  }
  const stored = await command(db, current.actorId, current.customerId, options.idempotencyKey)
  if (!stored) fail('service_unavailable')
  const response = await createResponse(db, stored, access)
  await releaseAuthority(db, access.claims, current.customerId, options.now === undefined ? null : time.fresh(), access)
  return response
}
export async function readD1CartSnapshotCommand(
  db: D1Database,
  access: CartSnapshotCommandAccess,
  key: string,
  hash: string,
  options: CartSnapshotOptions = {}
): Promise<CartSnapshotCommand> {
  const time = clock(options),
    current = await owner(db, access.claims, time.fresh())
  if (!uuid.safeParse(key).success || !/^[0-9a-f]{64}$/.test(hash)) fail('invalid_input')
  const row = await command(db, current.actorId, current.customerId, key)
  if (!row) {
    await releaseAuthority(db, access.claims, current.customerId, options.now === undefined ? null : time.fresh())
    return { source: 'cloudflare', outcome: 'unknown', receipt: null, share: null }
  }
  if (row.action === 'create') await cartAuthority(db, access)
  if (row.payload_hash !== hash) fail('conflict')
  const result: CartSnapshotCommand =
    row.action === 'create'
      ? { ...(await createResponse(db, row, access)), action: 'create', outcome: 'applied' }
      : {
          source: 'cloudflare',
          action: 'revoke',
          outcome: 'applied',
          receipt: cartSnapshotRevokeReceiptSchema.parse(receiptOf(row)),
          share: null
        }
  await releaseAuthority(
    db,
    access.claims,
    current.customerId,
    options.now === undefined ? null : time.fresh(),
    row.action === 'create' ? access : undefined
  )
  return result
}
export async function listD1CartSnapshots(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: CartSnapshotOptions = {}
): Promise<CartSnapshotList> {
  const time = clock(options),
    current = await owner(db, claims, time.fresh())
  const rows = await db
    .prepare(
      `SELECT c.*,s.revoked_at,s.id actual_share_id FROM customer_cart_snapshot_commands c JOIN customer_favorite_lists l ON l.id=c.list_id AND l.customer_id=c.customer_id AND l.is_default=0
    LEFT JOIN customer_cart_shares s ON s.id=c.share_id WHERE c.customer_id=?1 AND c.actor_id=?2 AND c.action='create' ORDER BY c.created_at DESC,c.command_id DESC LIMIT 21`
    )
    .bind(current.customerId, current.actorId)
    .all<CommandRow & { revoked_at: string | null; actual_share_id: string | null }>()
  const result = cartSnapshotListSchema.safeParse({
    source: 'cloudflare',
    items: rows.results.map((row) => {
      if (row.share_id !== row.actual_share_id) fail('service_unavailable')
      return { receipt: cartSnapshotReceiptSchema.parse(receiptOf(row)), revoked: row.revoked_at !== null }
    })
  })
  if (!result.success) fail('service_unavailable')
  await releaseAuthority(db, claims, current.customerId, options.now === undefined ? null : time.fresh())
  return result.data
}
export async function revokeD1CartShare(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  shareId: string,
  raw: unknown,
  options: CartSnapshotOptions & { idempotencyKey: string }
): Promise<CartSnapshotRevokeReceipt> {
  const time = clock(options),
    current = await owner(db, claims, time.fresh())
  if (
    !uuid.safeParse(shareId).success ||
    !uuid.safeParse(options.idempotencyKey).success ||
    !cartSnapshotRevokeInputSchema.safeParse(raw).success
  )
    fail('invalid_input')
  const hash = await cartSnapshotRevokeIntentHash(shareId, raw),
    existing = await command(db, current.actorId, current.customerId, options.idempotencyKey)
  if (existing) {
    if (existing.action !== 'revoke' || existing.payload_hash !== hash) fail('conflict')
    const receipt = cartSnapshotRevokeReceiptSchema.parse(receiptOf(existing))
    await releaseAuthority(db, claims, current.customerId, options.now === undefined ? null : time.fresh())
    return receipt
  }
  const share = await db
    .prepare('SELECT id FROM customer_cart_shares WHERE id=?1 AND customer_id=?2 AND creator_identity_id=?3')
    .bind(shareId, current.customerId, current.actorId)
    .first()
  if (!share) fail('not_found')
  const args = argumentsFor({ claims }, current.customerId, options, {
      shareId,
      key: options.idempotencyKey,
      hash,
      createdAt: time.now
    }),
    q = (sql: string) => db.prepare(`${mutationCte} ${sql}`).bind(args)
  try {
    await db.batch([
      q(
        `UPDATE customer_cart_shares SET revoked_at=COALESCE(revoked_at,json_extract(?1,'$.createdAt')) WHERE id=json_extract(?1,'$.shareId') AND customer_id=(SELECT customerId FROM authority) AND creator_identity_id=(SELECT actorId FROM authority)`
      ),
      q(`INSERT INTO customer_cart_snapshot_commands(actor_id,command_id,customer_id,action,payload_hash,share_id,receipt_json,created_at)
      SELECT s.creator_identity_id,json_extract(?1,'$.key'),s.customer_id,'revoke',json_extract(?1,'$.hash'),s.id,
      json_object('source','cloudflare','commandId',json_extract(?1,'$.key'),'payloadHash',json_extract(?1,'$.hash'),'shareId',s.id,'revoked',json('true'),'revokedAt',s.revoked_at),json_extract(?1,'$.createdAt')
      FROM customer_cart_shares s WHERE s.id=json_extract(?1,'$.shareId') AND s.customer_id=(SELECT customerId FROM authority) AND s.creator_identity_id=(SELECT actorId FROM authority) AND s.revoked_at IS NOT NULL`),
      q(
        `INSERT INTO customer_cart_snapshot_guards(id,valid) SELECT json_extract(?1,'$.key'),CASE WHEN EXISTS(SELECT 1 FROM authority) AND EXISTS(SELECT 1 FROM customer_cart_snapshot_commands WHERE actor_id=(SELECT actorId FROM authority) AND command_id=json_extract(?1,'$.key')) THEN 1 ELSE 0 END`
      ),
      db.prepare('DELETE FROM customer_cart_snapshot_guards WHERE id=?1').bind(options.idempotencyKey)
    ])
  } catch (error) {
    await releaseAuthority(db, claims, current.customerId, options.now === undefined ? null : time.fresh())
    const replay = await command(db, current.actorId, current.customerId, options.idempotencyKey)
    if (!replay) {
      void error
      fail('service_unavailable')
    }
    if (replay.action !== 'revoke' || replay.payload_hash !== hash) fail('conflict')
  }
  const stored = await command(db, current.actorId, current.customerId, options.idempotencyKey)
  if (!stored) fail('service_unavailable')
  const receipt = cartSnapshotRevokeReceiptSchema.parse(receiptOf(stored))
  await releaseAuthority(db, claims, current.customerId, options.now === undefined ? null : time.fresh())
  return receipt
}
function prepareLiveShare(db: D1Database, id: string, hash: string, now: string | null) {
  return db
    .prepare(
      `WITH clock AS MATERIALIZED(SELECT COALESCE(?3,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
    SELECT s.* FROM customer_cart_shares s JOIN customers c ON c.id=s.customer_id AND c.status='active'
    JOIN identities i ON i.id=s.creator_identity_id AND i.customer_id=c.id AND i.status='active'
    JOIN customer_favorite_lists l ON l.id=s.list_id AND l.customer_id=c.id
    WHERE s.id=?1 AND s.token_hash=?2 AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock)
    AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)`
    )
    .bind(id, hash, now)
}
async function liveShare(db: D1Database, id: string, hash: string, now: string | null) {
  try {
    return await prepareLiveShare(db, id, hash, now).first<ShareRow>()
  } catch {
    return fail('service_unavailable')
  }
}
async function publicFacts(
  db: D1Database,
  lines: Array<{ variantId: string; quantity: number }>,
  now: string,
  cap?: { id: string; hash: string; clock: string | null }
) {
  const statements = [
    prepareQuoteLinesStatement(db, { lines, instant: now }),
    db
      .prepare(
        `SELECT v.id variantId,v.legacy_id cartVariantId,p.slug
    FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id IN(SELECT json_extract(value,'$.variantId') FROM json_each(?1))`
      )
      .bind(JSON.stringify(lines))
  ]
  if (cap) statements.push(prepareLiveShare(db, cap.id, cap.hash, cap.clock))
  let batch: D1Result[]
  try {
    batch = await db.batch(statements)
  } catch {
    return fail('service_unavailable')
  }
  if (batch.length !== statements.length || batch.some((row) => row.success !== true || !Array.isArray(row.results)))
    fail('service_unavailable')
  if (cap && batch[2]!.results.length !== 1) fail('not_found')
  return {
    facts: batch[0]!.results as unknown as RawResolvedLine[],
    metadata: batch[1]!.results as Array<{ variantId: string; cartVariantId: number | null; slug: string }>
  }
}
export async function resolveD1SharedCart(
  db: D1Database,
  raw: unknown,
  options: CartSnapshotOptions = {}
): Promise<SharedCartResolveResponse> {
  const time = clock(options),
    input = sharedCartResolveInputSchema.safeParse(raw)
  if (!input.success) fail('not_found')
  const hash = await sha256Hex(input.data.token),
    stored = await liveShare(db, input.data.id, hash, options.now === undefined ? null : time.fresh())
  if (!stored) fail('not_found')
  const source = await command(db, stored.creator_identity_id, stored.customer_id, stored.create_command_id)
  if (
    !source ||
    source.action !== 'create' ||
    source.share_id !== stored.id ||
    source.list_id !== stored.list_id ||
    source.created_at !== stored.created_at
  )
    fail('service_unavailable')
  if (cartSnapshotReceiptSchema.parse(receiptOf(source)).expiresAt !== stored.expires_at) fail('service_unavailable')
  const schema = z
    .array(
      z
        .object({
          variantId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
          quantity: z.number().int().min(1).max(999)
        })
        .strict()
    )
    .min(1)
    .max(100)
  let rawSnapshot: unknown
  try {
    rawSnapshot = JSON.parse(stored.snapshot_json)
  } catch {
    return fail('service_unavailable')
  }
  const parsed = schema.safeParse(rawSnapshot)
  if (!parsed.success || new Set(parsed.data.map((line) => line.variantId)).size !== parsed.data.length)
    fail('service_unavailable')
  const lines = parsed.data,
    first = await publicFacts(db, lines, time.now)
  const items = lines.map((line) => {
    const unavailable = (reason: 'variant_unavailable' | 'quantity_invalid' | 'cart_unmapped' | 'out_of_stock') => ({
      ...line,
      available: false as const,
      reason
    })
    const fact = first.facts.find((fact) => fact.variantId === line.variantId)
    if (
      !fact ||
      fact.variantStatus !== 'published' ||
      fact.productStatus !== 'published' ||
      fact.categoryStatus !== 'published' ||
      fact.publicationValid !== 1
    )
      return unavailable('variant_unavailable')
    const resolved = mapQuoteLines([fact])[0]!
    try {
      validateQuantity(line.quantity, resolved)
    } catch {
      return unavailable('quantity_invalid')
    }
    if (!resolved.backorderAllowed && resolved.availableQuantity < line.quantity) return unavailable('out_of_stock')
    const meta = first.metadata.find((meta) => meta.variantId === line.variantId)
    if (!meta || !Number.isSafeInteger(meta.cartVariantId) || meta.cartVariantId! < 1)
      return unavailable('cart_unmapped')
    const quoted = quoteLine(resolved)
    return {
      ...line,
      available: true as const,
      reason: null,
      cartVariantId: meta.cartVariantId!,
      name: resolved.name,
      sku: resolved.sku,
      slug: meta.slug,
      format: resolved.format,
      unitLabel: resolved.unitLabel,
      baseUnitGrossCents: resolved.baseUnitGrossCents,
      unitGrossCents: resolved.unitGrossCents,
      netCents: quoted.netCents,
      taxCents: quoted.taxCents,
      grossCents: quoted.grossCents,
      taxRateBasisPoints: quoted.taxRateBasisPoints,
      minimumQuantity: resolved.minimumQuantity,
      maximumQuantity: resolved.maximumQuantity,
      quantityIncrement: resolved.quantityIncrement
    }
  })
  const response = sharedCartResolveResponseSchema.safeParse({
    source: 'cloudflare',
    id: stored.id,
    expiresAt: stored.expires_at,
    evaluatedAt: time.now,
    items
  })
  if (!response.success) fail('service_unavailable')
  // Re-read the bounded source set after all awaits: withdrawn products or
  // changed prices/stock must not release the earlier public projection.
  const latest = await publicFacts(db, lines, time.fresh(), {
    id: input.data.id,
    hash,
    clock: options.now === undefined ? null : time.fresh()
  })
  if (canonicalJson(first) !== canonicalJson(latest)) fail('service_unavailable')
  return response.data
}
