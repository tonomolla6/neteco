import type { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { customerFulfillmentSql } from '../catalog/customer-orders'
import { publicationValidityExpression } from '../catalog/publication-validity'
import { sha256Hex } from '../catalog/inventory'
import { supportActor, supportClock, SupportError, type SupportActor } from './operations'
import { supportUuid } from '../../shared/support-operations'
import {
  productContributionSubmitInputSchema,
  productContributionReplyInputSchema,
  productContributionModerationInputSchema,
  productContributionQuerySchema,
  publicProductContributionQuerySchema,
  productContributionSnapshotSchema,
  productContributionReceiptSchema,
  productContributionIntentHash,
  productContributionListSchema,
  publicProductContributionSchema,
  publicProductContributionListSchema,
  type ProductContributionSnapshot,
  type ProductContributionList,
  type PublicProductContributionList,
  type ProductContributionReceipt,
  type ProductContributionCommand
} from '../../shared/product-contributions'
export type ProductContributionAudience = 'customer' | 'admin'
export interface ProductContributionOptions {
  now?: string
}
export interface ProductContributionCommandOptions extends ProductContributionOptions {
  idempotencyKey: string
}
export class ProductContributionError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'invalid_transition'
      | 'history_unconfirmed'
      | 'service_unavailable'
      | 'limit_exceeded'
  ) {
    super(code)
  }
}
function fail(code: ProductContributionError['code']): never {
  throw new ProductContributionError(code)
}
function checked<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) fail('invalid_input')
  return parsed.data
}
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ProductContributionError) throw error
    if (error instanceof SupportError) {
      if (['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden', 'not_found'].includes(error.code))
        throw new ProductContributionError(error.code as ProductContributionError['code'])
    }
    fail('service_unavailable')
  }
}
const instant = "COALESCE(json_extract(?1,'$.now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const authority = `WITH context AS MATERIALIZED(SELECT json_extract(?1,'$.identityId') identityId,json_extract(?1,'$.sessionId') sessionId,json_extract(?1,'$.sessionVersion') sessionVersion,json_extract(?1,'$.customerId') customerId,json_extract(?1,'$.audience') audience,${instant} now),
 actor AS MATERIALIZED(SELECT i.id,i.customer_id FROM context x JOIN auth_sessions s ON s.id=x.sessionId JOIN identities i ON i.id=s.identity_id WHERE i.id=x.identityId AND i.status='active' AND i.session_version=x.sessionVersion AND s.session_version=i.session_version AND s.revoked_at IS NULL AND s.created_at<=x.now AND s.expires_at>x.now AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=x.now
 AND((x.audience='customer' AND i.customer_id=x.customerId AND EXISTS(SELECT 1 FROM customers c WHERE c.id=i.customer_id AND c.status='active') AND(s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))) OR(x.audience='admin' AND s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=x.now) AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='support.manage' AND r.granted_at<=x.now AND(r.expires_at IS NULL OR r.expires_at>x.now)))))`
interface Context {
  db: D1Database
  claims: VerifiedSessionClaims
  audience: ProductContributionAudience
  actor: SupportActor
  now: () => string
  options: ProductContributionOptions
}
function bind(c: Context) {
  return JSON.stringify({
    ...c.claims,
    audience: c.audience,
    customerId: c.actor.customerId,
    now: c.options.now === undefined ? null : c.now()
  })
}
async function release(c: Context, proofs: Array<{ id: string; version: number; snapshotHash: string }> = []) {
  const row = await c.db
    .prepare(
      `${authority} SELECT EXISTS(SELECT 1 FROM actor) allowed,NOT EXISTS(SELECT 1 FROM json_each(?2) wanted WHERE NOT EXISTS(SELECT 1 FROM product_contribution_commands v WHERE v.contribution_id=json_extract(wanted.value,'$.id') AND v.version=json_extract(wanted.value,'$.version') AND v.snapshot_hash=json_extract(wanted.value,'$.snapshotHash') AND v.version=(SELECT max(version) FROM product_contribution_commands WHERE contribution_id=v.contribution_id) AND(?3='admin' OR v.customer_id=(SELECT customer_id FROM actor)))) coherent`
    )
    .bind(bind(c), JSON.stringify(proofs), c.audience)
    .first<{ allowed: number; coherent: number }>()
  if (!row?.allowed) fail(c.audience === 'admin' ? 'forbidden' : 'unauthenticated')
  if (!row.coherent) fail('history_unconfirmed')
}
async function context(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  options: ProductContributionOptions
): Promise<Context> {
  if (audience !== 'admin' && audience !== 'customer') fail('invalid_input')
  const now = supportClock(options.now),
    actor = await supportActor(db, claims, audience, now),
    c = { db, claims: claims!, audience, actor, now, options }
  if (audience === 'admin') {
    const m = await db
      .prepare('SELECT verified_at FROM identity_mfa WHERE identity_id=?')
      .bind(claims!.identityId)
      .first<{ verified_at: string | null }>()
    if (!m?.verified_at || m.verified_at > now()) fail('mfa_required')
  }
  await release(c)
  return c
}
export async function authorizeD1ProductContributionActor(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  options: ProductContributionOptions = {}
): Promise<void> {
  return attempt(async () => {
    await context(db, claims, audience, options)
  })
}
interface Row {
  id: string
  actor_id: string
  audience: ProductContributionAudience
  customer_id: string
  contribution_id: string
  product_id: string
  order_id: string | null
  action: ProductContributionReceipt['action']
  expected_version: number
  version: number
  payload_hash: string
  input: string
  snapshot: string
  snapshot_hash: string
  response: string
  created_at: string
}
async function proof(row: Row) {
  try {
    const snapshot = productContributionSnapshotSchema.parse(JSON.parse(row.snapshot)),
      receipt = productContributionReceiptSchema.parse(JSON.parse(row.response))
    if (
      snapshot.id !== row.contribution_id ||
      snapshot.version !== row.version ||
      snapshot.updatedAt !== row.created_at ||
      receipt.commandId !== row.id ||
      receipt.contributionId !== row.contribution_id ||
      receipt.action !== row.action ||
      receipt.version !== row.version ||
      receipt.expectedVersion !== row.expected_version ||
      receipt.recordedAt !== row.created_at ||
      receipt.payloadHash !== row.payload_hash ||
      (await sha256Hex(row.snapshot)) !== row.snapshot_hash ||
      (await productContributionIntentHash(
        row.action,
        row.action === 'submit' ? null : row.contribution_id,
        JSON.parse(row.input)
      )) !== row.payload_hash
    )
      fail('history_unconfirmed')
    return { snapshot, receipt }
  } catch {
    fail('history_unconfirmed')
  }
}
async function proveRows(rows: Row[]) {
  if (rows.length === 0) fail('not_found')
  if (rows.length > 100) fail('limit_exceeded')
  let latest: Awaited<ReturnType<typeof proof>> | null = null
  for (const [index, row] of rows.entries()) {
    if (
      row.version !== index + 1 ||
      row.expected_version !== index ||
      row.customer_id !== rows[0]!.customer_id ||
      row.product_id !== rows[0]!.product_id ||
      row.order_id !== rows[0]!.order_id
    )
      fail('history_unconfirmed')
    latest = await proof(row)
  }
  return latest!
}
async function rowsFor(c: Context, id: string) {
  const result = await c.db
    .prepare(
      `${authority} SELECT v.* FROM product_contribution_commands v WHERE v.contribution_id=?2 AND EXISTS(SELECT 1 FROM actor) AND(?3='admin' OR v.customer_id=(SELECT customer_id FROM actor)) ORDER BY version LIMIT 101`
    )
    .bind(bind(c), id, c.audience)
    .all<Row>()
  if (!result.success) fail('service_unavailable')
  return result.results
}
async function replay(c: Context, key: string, hash: string, target?: string) {
  const row = await c.db
    .prepare('SELECT * FROM product_contribution_commands WHERE id=? AND actor_id=? AND audience=?')
    .bind(key, c.claims.identityId, c.audience)
    .first<Row>()
  if (!row) return null
  if (row.payload_hash !== hash || (target !== undefined && row.contribution_id !== target))
    fail('idempotency_conflict')
  const receipt = (await proof(row)).receipt
  await release(c)
  return receipt
}
async function commit(
  c: Context,
  input: unknown,
  snapshot: ProductContributionSnapshot,
  action: ProductContributionReceipt['action'],
  key: string,
  hash: string,
  productUuid: string,
  owner: string,
  orderId: string | null
): Promise<ProductContributionReceipt> {
  if (snapshot.version > 100) fail('limit_exceeded')
  const receipt = productContributionReceiptSchema.parse({
      source: 'cloudflare',
      commandId: key,
      contributionId: snapshot.id,
      action,
      expectedVersion: snapshot.version - 1,
      version: snapshot.version,
      payloadHash: hash,
      recordedAt: snapshot.updatedAt,
      inventoryEffect: 'none',
      economicEffect: 'none',
      senderInvoked: false
    }),
    encoded = JSON.stringify(snapshot),
    snapshotHash = await sha256Hex(encoded),
    guard = crypto.randomUUID()
  try {
    await c.db.batch([
      c.db
        .prepare(
          `${authority} INSERT INTO product_contribution_commands(id,actor_id,session_id,session_version,audience,customer_id,contribution_id,product_id,order_id,action,expected_version,version,payload_hash,input,snapshot,snapshot_hash,response,created_at)
 SELECT ?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12 + 1,?13,?14,?15,?16,?17,?18 WHERE EXISTS(SELECT 1 FROM actor)
 AND(?11<>'submit' OR EXISTS(SELECT 1 FROM products p WHERE p.id=?9 AND p.status='published' AND ${publicationValidityExpression('p')}))
 AND(?11<>'submit' OR ?10 IS NULL OR EXISTS(SELECT 1 FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN variants v ON v.id=l.variant_id WHERE o.id=?10 AND o.customer_id=?7 AND v.product_id=?9 AND ${customerFulfillmentSql('o.id', 'o.customer_id', instant)}='delivered'))`
        )
        .bind(
          bind(c),
          key,
          c.claims.identityId,
          c.claims.sessionId,
          c.claims.sessionVersion,
          c.audience,
          owner,
          snapshot.id,
          productUuid,
          orderId,
          action,
          receipt.expectedVersion,
          hash,
          JSON.stringify(input),
          encoded,
          snapshotHash,
          JSON.stringify(receipt),
          snapshot.updatedAt
        ),
      c.db
        .prepare(
          'INSERT INTO product_contribution_guards(id,passed) SELECT ?1,EXISTS(SELECT 1 FROM product_contribution_commands WHERE id=?2 AND actor_id=?3 AND contribution_id=?4 AND payload_hash=?5 AND snapshot_hash=?6 AND response=?7)'
        )
        .bind(guard, key, c.claims.identityId, snapshot.id, hash, snapshotHash, JSON.stringify(receipt)),
      c.db.prepare('DELETE FROM product_contribution_guards WHERE id=?').bind(guard)
    ])
  } catch {
    await context(c.db, c.claims, c.audience, c.options)
    const exact = await replay(c, key, hash, snapshot.id)
    if (exact) return exact
    const current = await c.db
      .prepare('SELECT max(version) version FROM product_contribution_commands WHERE contribution_id=?')
      .bind(snapshot.id)
      .first<{ version: number | null }>()
    if ((current?.version ?? 0) !== receipt.expectedVersion) fail('version_conflict')
    fail('service_unavailable')
  }
  await release(c)
  return receipt
}
export async function submitD1ProductContribution(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: ProductContributionCommandOptions
): Promise<ProductContributionReceipt> {
  return attempt(async () => {
    const c = await context(db, claims, 'customer', options),
      input = checked(productContributionSubmitInputSchema, raw),
      key = checked(supportUuid, options.idempotencyKey),
      hash = await productContributionIntentHash('submit', null, input),
      old = await replay(c, key, hash)
    if (old) return old
    const product = await db
      .prepare(
        `SELECT p.id FROM products p WHERE p.legacy_id=?1 AND p.status='published' AND ${publicationValidityExpression('p')}`
      )
      .bind(input.productId)
      .first<{ id: string }>()
    if (!product) fail('not_found')
    const orderId = input.kind === 'review' ? (input.orderId ?? null) : null
    if (orderId) {
      const found = await db
        .prepare(
          `SELECT o.id FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN variants v ON v.id=l.variant_id WHERE o.id=?1 AND o.customer_id=?2 AND v.product_id=?3 AND ${customerFulfillmentSql('o.id', 'o.customer_id', '?4')}='delivered'`
        )
        .bind(orderId, c.actor.customerId, product.id, c.now())
        .first()
      if (!found) fail('not_found')
    }
    const time = c.now(),
      id = crypto.randomUUID(),
      snapshot = productContributionSnapshotSchema.parse({
        source: 'cloudflare',
        id,
        productId: input.productId,
        kind: input.kind,
        score: input.kind === 'review' ? input.score : null,
        title: input.title,
        body: input.body,
        origin: orderId ? 'verified_purchase' : 'unverified',
        answer: null,
        reply: null,
        questionStatus: input.kind === 'question' ? 'open' : null,
        createdAt: time,
        updatedAt: time,
        version: 1,
        state: 'pending',
        slaDueAt: null,
        capabilities: { canReply: true, canModerate: false },
        history: [{ action: 'submit', version: 1, recordedAt: time }]
      })
    return commit(c, input, snapshot, 'submit', key, hash, product.id, c.actor.customerId!, orderId)
  })
}
async function mutate(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  id: string,
  raw: unknown,
  options: ProductContributionCommandOptions
) {
  const c = await context(db, claims, audience, options),
    target = checked(supportUuid, id)
  const command:
    | { kind: 'reply'; input: z.infer<typeof productContributionReplyInputSchema> }
    | { kind: 'moderation'; input: z.infer<typeof productContributionModerationInputSchema> } =
    audience === 'customer'
      ? { kind: 'reply', input: checked(productContributionReplyInputSchema, raw) }
      : { kind: 'moderation', input: checked(productContributionModerationInputSchema, raw) }
  const input = command.input,
    action = command.kind === 'reply' ? 'reply' : command.input.action,
    key = checked(supportUuid, options.idempotencyKey),
    hash = await productContributionIntentHash(action, target, input),
    old = await replay(c, key, hash, target)
  if (old) return old
  const rows = await rowsFor(c, target),
    previous = (await proveRows(rows)).snapshot,
    row = rows.at(-1)!
  if (input.expectedVersion !== previous.version) fail('version_conflict')
  if (previous.state === 'withdrawn' && action !== 'withdraw') fail('invalid_transition')
  if ((action === 'answer' || action === 'close') && previous.kind !== 'question') fail('invalid_transition')
  if (action === 'close' && previous.state !== 'published') fail('invalid_transition')
  const time = c.now(),
    version = previous.version + 1,
    snapshot = {
      ...previous,
      version,
      updatedAt: time,
      history: [...previous.history, { action, version, recordedAt: time }]
    }
  if (action === 'reply' && 'body' in input) {
    snapshot.reply = input.body
    snapshot.state = 'pending'
  }
  if (action === 'publish' && 'slaDueAt' in input) {
    if (input.slaDueAt !== null && (previous.kind !== 'question' || input.slaDueAt <= time)) fail('invalid_input')
    snapshot.state = 'published'
    snapshot.slaDueAt = input.slaDueAt
  }
  if (action === 'answer' && 'body' in input) {
    snapshot.answer = input.body
    snapshot.questionStatus = 'answered'
    snapshot.state = 'published'
    snapshot.slaDueAt = null
  }
  if (action === 'close') {
    snapshot.questionStatus = 'closed'
    snapshot.slaDueAt = null
  }
  if (action === 'withdraw') {
    snapshot.state = 'withdrawn'
    snapshot.slaDueAt = null
  }
  return commit(
    c,
    input,
    productContributionSnapshotSchema.parse(snapshot),
    action,
    key,
    hash,
    row.product_id,
    row.customer_id,
    row.order_id
  )
}
export async function replyD1ProductContribution(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: ProductContributionCommandOptions
): Promise<ProductContributionReceipt> {
  return attempt(() => mutate(db, claims, 'customer', id, raw, options))
}
export async function moderateD1ProductContribution(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: ProductContributionCommandOptions
): Promise<ProductContributionReceipt> {
  return attempt(() => mutate(db, claims, 'admin', id, raw, options))
}
export async function readD1ProductContribution(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  id: string,
  options: ProductContributionOptions = {}
): Promise<ProductContributionSnapshot> {
  return attempt(async () => {
    const c = await context(db, claims, audience, options),
      rows = await rowsFor(c, checked(supportUuid, id)),
      snapshot = (await proveRows(rows)).snapshot
    snapshot.capabilities = {
      canReply: audience === 'customer' && snapshot.state !== 'withdrawn',
      canModerate: audience === 'admin'
    }
    await release(c, [{ id: snapshot.id, version: snapshot.version, snapshotHash: rows.at(-1)!.snapshot_hash }])
    return snapshot
  })
}
export async function readD1ProductContributions(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  raw: unknown,
  options: ProductContributionOptions = {}
): Promise<ProductContributionList> {
  return attempt(async () => {
    const c = await context(db, claims, audience, options),
      q = checked(productContributionQuerySchema, raw),
      cte = `${authority},heads AS MATERIALIZED(SELECT v.* FROM product_contribution_commands v WHERE v.version=(SELECT max(version) FROM product_contribution_commands WHERE contribution_id=v.contribution_id) AND EXISTS(SELECT 1 FROM actor) AND(?2='admin' OR v.customer_id=(SELECT customer_id FROM actor)) AND(?3 IS NULL OR json_extract(v.snapshot,'$.productId')=?3) AND(?4 IS NULL OR json_extract(v.snapshot,'$.kind')=?4) AND(?5 IS NULL OR json_extract(v.snapshot,'$.state')=?5))`,
      args = [bind(c), audience, q.productId ?? null, q.kind ?? null, q.state ?? null]
    const results = await db.batch([
      db.prepare(`${cte} SELECT count(*) total FROM heads`).bind(...args),
      db
        .prepare(
          `${cte},page AS MATERIALIZED(SELECT contribution_id,created_at FROM heads ORDER BY created_at DESC,id DESC LIMIT ?6 OFFSET ?7) SELECT c.* FROM product_contribution_commands c JOIN page p ON p.contribution_id=c.contribution_id ORDER BY p.created_at DESC,p.contribution_id DESC,c.version LIMIT 2501`
        )
        .bind(...args, q.perPage, (q.page - 1) * q.perPage)
    ])
    if (results.some((r) => !r.success)) fail('service_unavailable')
    const rows = results[1]!.results as unknown as Row[]
    if (rows.length > 2500 || JSON.stringify(rows).length > 2 * 1024 * 1024) fail('limit_exceeded')
    const groups = new Map<string, Row[]>()
    for (const row of rows) {
      const group = groups.get(row.contribution_id) ?? []
      group.push(row)
      groups.set(row.contribution_id, group)
    }
    const items: ProductContributionSnapshot[] = [],
      proofs: Array<{ id: string; version: number; snapshotHash: string }> = []
    for (const group of groups.values()) {
      const item = (await proveRows(group)).snapshot
      item.capabilities = {
        canReply: audience === 'customer' && item.state !== 'withdrawn',
        canModerate: audience === 'admin'
      }
      items.push(item)
      proofs.push({ id: item.id, version: item.version, snapshotHash: group.at(-1)!.snapshot_hash })
    }
    const total = (results[0]!.results[0] as { total: number }).total,
      dto = productContributionListSchema.parse({
        source: 'cloudflare',
        items,
        page: q.page,
        perPage: q.perPage,
        total,
        pages: Math.ceil(total / q.perPage)
      })
    await release(c, proofs)
    return dto
  })
}
export async function readD1ProductContributionCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  audience: ProductContributionAudience,
  key: string,
  hash: string,
  options: ProductContributionOptions = {}
): Promise<ProductContributionCommand> {
  return attempt(async () => {
    const c = await context(db, claims, audience, options)
    checked(supportUuid, key)
    if (!/^[0-9a-f]{64}$/.test(hash)) fail('invalid_input')
    const receipt = await replay(c, key, hash)
    if (receipt) return { source: 'cloudflare', outcome: 'applied', receipt }
    await release(c)
    return { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}
export async function readD1PublicProductContributions(
  db: D1Database,
  productId: number,
  raw: unknown,
  options: ProductContributionOptions = {}
): Promise<PublicProductContributionList> {
  return attempt(async () => {
    const q = checked(publicProductContributionQuerySchema, raw)
    if (!Number.isSafeInteger(productId) || productId < 1) fail('invalid_input')
    supportClock(options.now)
    const cte = `WITH published AS MATERIALIZED(SELECT p.id FROM products p WHERE p.legacy_id=?1 AND p.status='published' AND ${publicationValidityExpression('p')}),heads AS MATERIALIZED(SELECT c.* FROM product_contribution_commands c JOIN published p ON p.id=c.product_id WHERE c.version=(SELECT max(version) FROM product_contribution_commands WHERE contribution_id=c.contribution_id) AND json_extract(c.snapshot,'$.state')='published' AND(?2 IS NULL OR json_extract(c.snapshot,'$.kind')=?2))`
    async function source() {
      const result = await db.batch([
        db
          .prepare(`${cte} SELECT EXISTS(SELECT 1 FROM published) available,(SELECT count(*) FROM heads) total`)
          .bind(productId, q.kind ?? null),
        db
          .prepare(`${cte} SELECT * FROM heads ORDER BY created_at DESC,id DESC LIMIT ?3 OFFSET ?4`)
          .bind(productId, q.kind ?? null, q.perPage, (q.page - 1) * q.perPage)
      ])
      if (result.some((r) => !r.success)) fail('service_unavailable')
      return {
        header: result[0]!.results[0] as { available: number; total: number },
        rows: result[1]!.results as unknown as Row[]
      }
    }
    const first = await source()
    if (!first.header.available) fail('not_found')
    if (JSON.stringify(first.rows).length > 2 * 1024 * 1024) fail('limit_exceeded')
    const items = []
    for (const row of first.rows) {
      const s = (await proof(row)).snapshot
      items.push(
        publicProductContributionSchema.parse({
          id: s.id,
          productId: s.productId,
          kind: s.kind,
          score: s.score,
          title: s.title,
          body: s.body,
          origin: s.origin,
          answer: s.answer,
          reply: s.reply,
          questionStatus: s.questionStatus,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt
        })
      )
    }
    const dto = publicProductContributionListSchema.parse({
        source: 'cloudflare',
        productId,
        items,
        page: q.page,
        perPage: q.perPage,
        total: first.header.total,
        pages: Math.ceil(first.header.total / q.perPage)
      }),
      final = await source()
    if (!final.header.available) fail('not_found')
    if (JSON.stringify(final) !== JSON.stringify(first)) fail('history_unconfirmed')
    return dto
  })
}
