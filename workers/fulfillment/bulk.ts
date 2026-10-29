import { z } from 'zod'
import {
  adminOrderBulkCommandSchema,
  adminOrderBulkCreateInputSchema,
  adminOrderBulkGroupSchema,
  adminOrderBulkHashSchema,
  adminOrderBulkIntentHash,
  adminOrderBulkPreviewInputSchema,
  adminOrderBulkPreviewSchema,
  adminOrderBulkReasonSchema,
  adminOrderBulkReceiptSchema,
  type AdminOrderBulkCommand,
  type AdminOrderBulkGroup,
  type AdminOrderBulkPreview,
  type AdminOrderBulkReceipt,
  type AdminOrderBulkPreviewInput
} from '../../shared/admin-order-bulk'
import {
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import {
  allowedFulfillmentActions,
  fulfillmentCommandReceiptSchema,
  fulfillmentTransitionInputSchema
} from '../../shared/order-fulfillment'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { AdminInvitationError, authorizeD1AdminInvitationActor } from '../auth/admin-invitations'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import {
  executeD1AdminFulfillmentCommand,
  readD1AdminFulfillmentCommand,
  fulfillmentEnrolledActorSql,
  fulfillmentAuditProofSql,
  fulfillmentFactsSql,
  fulfillmentFreshClock,
  fulfillmentSourceBlockers,
  fulfillmentSourceSchema,
  FulfillmentError
} from './admin'
export type AdminOrderBulkErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'revalidation_required'
  | 'idempotency_conflict'
  | 'history_unconfirmed'
  | 'service_unavailable'
export class AdminOrderBulkError extends Error {
  constructor(readonly code: AdminOrderBulkErrorCode) {
    super(code)
    this.name = 'AdminOrderBulkError'
  }
}
export interface AdminOrderBulkOptions {
  now?: string
}
export interface AdminOrderBulkStepResult {
  source: 'cloudflare'
  groupId: string
  dispatchId: string
  processed: number
  remaining: number
  requeue: boolean
  status: 'pending' | 'completed' | 'paused'
}
// Until a larger native bound is measured, one canonical command per invocation
// reserves room for HTTP/queue authority checks within D1 Free's 50 queries.
export const ADMIN_ORDER_BULK_EFFECTIVE_STEP_LIMIT = 1
const claimsSchema = z
  .object({
    identityId: catalogPolicyUuidSchema,
    sessionId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
const optionsSchema = z.object({ now: catalogPolicyInstantSchema.optional() }).strict()
const authCodes = ['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'] as const
const sourcesSchema = z
  .array(z.object({ orderId: catalogPolicyUuidSchema, source: fulfillmentSourceSchema.nullable() }).strict())
  .min(1)
  .max(25)
const childSchema = z
  .object({
    orderId: catalogPolicyUuidSchema,
    expectedVersion: z.number().int().min(0),
    childKey: catalogPolicyUuidSchema,
    eligible: z.boolean(),
    reason: adminOrderBulkReasonSchema.nullable()
  })
  .strict()
type Sources = z.infer<typeof sourcesSchema>
const groupRecordSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    dispatch_id: catalogPolicyUuidSchema,
    command_id: catalogPolicyUuidSchema,
    actor_id: catalogPolicyUuidSchema,
    session_id: catalogPolicyUuidSchema,
    session_version: z.number().int().min(1),
    payload_hash: adminOrderBulkHashSchema,
    input_json: z.string(),
    preview_json: z.string(),
    sources_json: z.string(),
    children_json: z.string(),
    receipt_json: z.string(),
    claim_nonce: catalogPolicyUuidSchema,
    created_at: catalogPolicyInstantSchema
  })
  .strict()
type GroupRecord = z.infer<typeof groupRecordSchema>
function checked<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  code: AdminOrderBulkErrorCode = 'invalid_input'
): z.output<S> {
  let data: unknown
  try {
    data = catalogPolicyOwnJson(input)
  } catch {
    throw new AdminOrderBulkError(code)
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new AdminOrderBulkError(code)
  return parsed.data
}
function stored<S extends z.ZodTypeAny>(schema: S, json: string): z.output<S> {
  try {
    return checked(schema, JSON.parse(json), 'history_unconfirmed')
  } catch {
    throw new AdminOrderBulkError('history_unconfirmed')
  }
}
async function attempt<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AdminOrderBulkError) throw error
    if (
      error instanceof FulfillmentError &&
      [...authCodes, 'not_found', 'idempotency_conflict', 'history_unconfirmed'].some((code) => code === error.code)
    )
      throw new AdminOrderBulkError(error.code as AdminOrderBulkErrorCode)
    throw new AdminOrderBulkError('service_unavailable')
  }
}
function instant(now?: string) {
  return now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  try {
    await authorizeD1AdminInvitationActor(database, claims, true, now === undefined ? {} : { now })
  } catch (error) {
    if (error instanceof AdminInvitationError && authCodes.some((code) => code === error.code))
      throw new AdminOrderBulkError(error.code as (typeof authCodes)[number])
    throw error
  }
}
async function rows(statement: D1PreparedStatement): Promise<unknown[]> {
  const result = await statement.all()
  if (!result.success || !Array.isArray(result.results)) throw new AdminOrderBulkError('service_unavailable')
  return result.results
}
function batchSucceeded(result: D1Result[], size: number) {
  if (result.length !== size || result.some((row) => !row.success)) throw new AdminOrderBulkError('service_unavailable')
}
// Only the final order-id predicate is widened; every canonical readiness and
// history expression remains the single-order service's policy, verbatim.
const selectedFactsSql = fulfillmentFactsSql.replace(
  'WHERE o.id=?5',
  "WHERE o.id IN (SELECT json_extract(value,'$.orderId') FROM json_each(?5))"
)
async function readSources(database: D1Database, ids: string[], now?: string): Promise<Sources> {
  const records = checked(
    z.array(fulfillmentSourceSchema).max(25),
    await rows(
      database
        .prepare(`WITH ${selectedFactsSql} SELECT * FROM facts ORDER BY order_id`)
        .bind(now ?? null, null, null, null, JSON.stringify(ids.map((orderId) => ({ orderId }))))
    ),
    'history_unconfirmed'
  )
  if (
    records.some((row) => !ids.includes(row.order_id)) ||
    new Set(records.map((row) => row.order_id)).size !== records.length
  )
    throw new AdminOrderBulkError('history_unconfirmed')
  return ids.map((orderId) => ({ orderId, source: records.find((row) => row.order_id === orderId) ?? null }))
}
async function projectPreview(
  input: AdminOrderBulkPreviewInput,
  sources: Sources,
  now: string
): Promise<AdminOrderBulkPreview> {
  const projected = sources.map(({ orderId, source }) => {
    const reason =
      source === null
        ? 'not_found'
        : (fulfillmentSourceBlockers(source)[0] ??
          (allowedFulfillmentActions(
            source.state,
            source.interrupted_state,
            checked(z.enum(['pickup', 'own_delivery', 'parcel']), source.shipping_method, 'history_unconfirmed')
          ).includes(input.action)
            ? null
            : 'invalid_transition'))
    return {
      orderId,
      expectedVersion: source?.version ?? 0,
      currentVersion: source?.version ?? null,
      state: source?.state ?? null,
      eligible: reason === null,
      reason
    }
  })
  return checked(
    adminOrderBulkPreviewSchema,
    {
      source: 'cloudflare',
      action: input.action,
      previewHash: await sha256Hex(canonicalJson({ input, sources })),
      rows: projected,
      eligible: projected.filter((row) => row.eligible).length,
      blocked: projected.filter((row) => !row.eligible).length,
      inventoryEffect: 'none',
      economicEffect: 'none',
      evaluatedAt: now
    },
    'history_unconfirmed'
  )
}
export async function previewD1AdminOrderBulk(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawInput: unknown,
  rawOptions: AdminOrderBulkOptions = {}
): Promise<AdminOrderBulkPreview> {
  return attempt(async () => {
    const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
      input = checked(adminOrderBulkPreviewInputSchema, rawInput),
      options = checked(optionsSchema, rawOptions),
      fresh = fulfillmentFreshClock(options.now)
    await authorize(database, claims, fresh())
    const result = await projectPreview(input, await readSources(database, input.orderIds, fresh()), instant(fresh()))
    await authorize(database, claims, fresh())
    return result
  })
}
async function decode(record: GroupRecord) {
  const input = stored(adminOrderBulkCreateInputSchema, record.input_json),
    preview = stored(adminOrderBulkPreviewSchema, record.preview_json),
    sources = stored(sourcesSchema, record.sources_json),
    children = stored(z.array(childSchema).min(1).max(25), record.children_json),
    receipt = stored(adminOrderBulkReceiptSchema, record.receipt_json)
  const derived = await projectPreview(
    {
      action: input.action,
      orderIds: input.orders.map((row) => row.orderId),
      reason: input.reason,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence })
    },
    sources,
    preview.evaluatedAt
  )
  if (
    canonicalJson(derived) !== canonicalJson(preview) ||
    (await adminOrderBulkIntentHash(input)) !== record.payload_hash ||
    input.previewHash !== preview.previewHash ||
    children.length !== input.orders.length ||
    sources.length !== input.orders.length ||
    new Set(children.map((row) => row.childKey)).size !== children.length ||
    children.some((child, index) => {
      const order = input.orders[index],
        row = preview.rows[index]
      return (
        !order ||
        !row ||
        child.orderId !== order.orderId ||
        child.expectedVersion !== order.expectedVersion ||
        child.orderId !== row.orderId ||
        child.expectedVersion !== row.expectedVersion ||
        child.eligible !== row.eligible ||
        child.reason !== row.reason
      )
    }) ||
    receipt.groupId !== record.id ||
    receipt.dispatchId !== record.dispatch_id ||
    receipt.commandId !== record.command_id ||
    receipt.payloadHash !== record.payload_hash ||
    receipt.recordedAt !== record.created_at ||
    receipt.previewHash !== preview.previewHash ||
    receipt.selected !== children.length ||
    receipt.eligible !== preview.eligible ||
    receipt.blocked !== preview.blocked
  )
    throw new AdminOrderBulkError('history_unconfirmed')
  return { record, input, preview, sources, children, receipt }
}
type Group = Awaited<ReturnType<typeof decode>>
async function lookup(database: D1Database, where: string, values: (string | number)[]): Promise<Group | null> {
  const found = await rows(
    database.prepare(`SELECT * FROM admin_order_bulk_groups WHERE ${where} LIMIT 2`).bind(...values)
  )
  if (found.length > 1) throw new AdminOrderBulkError('history_unconfirmed')
  return found.length ? decode(checked(groupRecordSchema, found[0], 'history_unconfirmed')) : null
}
async function ownCommand(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string) {
  const group = await lookup(database, 'actor_id=? AND command_id=?', [claims.identityId, key])
  if (group && group.record.payload_hash !== hash) throw new AdminOrderBulkError('idempotency_conflict')
  return group
}
export async function createD1AdminOrderBulk(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawInput: unknown,
  rawOptions: AdminOrderBulkOptions & { idempotencyKey: string }
): Promise<AdminOrderBulkReceipt> {
  return attempt(async () => {
    const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
      input = checked(adminOrderBulkCreateInputSchema, rawInput),
      options = checked(optionsSchema.extend({ idempotencyKey: catalogPolicyUuidSchema }), rawOptions),
      fresh = fulfillmentFreshClock(options.now)
    await authorize(database, claims, fresh())
    const hash = await adminOrderBulkIntentHash(input),
      existing = await ownCommand(database, claims, options.idempotencyKey, hash)
    await authorize(database, claims, fresh())
    if (existing) return existing.receipt
    const sources = await readSources(
        database,
        input.orders.map((row) => row.orderId),
        fresh()
      ),
      previewInput = {
        action: input.action,
        orderIds: input.orders.map((row) => row.orderId),
        reason: input.reason,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence })
      },
      preview = await projectPreview(previewInput, sources, instant(fresh()))
    if (
      preview.previewHash !== input.previewHash ||
      preview.rows.some((row, index) => row.expectedVersion !== input.orders[index]?.expectedVersion)
    )
      throw new AdminOrderBulkError('revalidation_required')
    const id = crypto.randomUUID(),
      dispatchId = crypto.randomUUID(),
      nonce = crypto.randomUUID(),
      now = instant(fresh()),
      children = preview.rows.map((row) => ({
        orderId: row.orderId,
        expectedVersion: row.expectedVersion,
        childKey: crypto.randomUUID(),
        eligible: row.eligible,
        reason: row.reason
      }))
    const receipt = checked(adminOrderBulkReceiptSchema, {
      source: 'cloudflare',
      commandId: options.idempotencyKey,
      payloadHash: hash,
      groupId: id,
      dispatchId,
      previewHash: input.previewHash,
      selected: children.length,
      eligible: preview.eligible,
      blocked: preview.blocked,
      recordedAt: now
    })
    const mismatch = Object.keys(fulfillmentSourceSchema.shape)
      .map((field) => `f.${field} IS NOT json_extract(e.value,'$.source.${field}')`)
      .join(' OR ')
    const proof = `NOT EXISTS(SELECT 1 FROM json_each(?5) e LEFT JOIN facts f ON f.order_id=json_extract(e.value,'$.orderId') WHERE (json_extract(e.value,'$.source') IS NULL AND f.order_id IS NOT NULL) OR (json_extract(e.value,'$.source') IS NOT NULL AND (f.order_id IS NULL OR ${mismatch})))`
    const bindings = [
      fresh() ?? null,
      claims.sessionId,
      claims.identityId,
      claims.sessionVersion,
      JSON.stringify(sources),
      id,
      dispatchId,
      options.idempotencyKey,
      hash,
      JSON.stringify(input),
      JSON.stringify(preview),
      JSON.stringify(children),
      JSON.stringify(receipt),
      now,
      nonce
    ]
    try {
      batchSucceeded(
        await database.batch([
          database
            .prepare(
              `WITH actor AS (${fulfillmentEnrolledActorSql}),${selectedFactsSql} INSERT INTO admin_order_bulk_groups(id,dispatch_id,command_id,actor_id,session_id,session_version,payload_hash,input_json,preview_json,sources_json,children_json,receipt_json,claim_nonce,created_at) SELECT ?6,?7,?8,?3,?2,?4,?9,?10,?11,?5,?12,?13,?15,?14 FROM actor WHERE ${proof}`
            )
            .bind(...bindings),
          database
            .prepare(
              'INSERT INTO admin_order_bulk_guards(id,satisfied) SELECT ?,0 WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_groups WHERE id=? AND claim_nonce=?)'
            )
            .bind(id, id, nonce),
          database
            .prepare(
              `INSERT INTO admin_order_bulk_results(group_id,order_id,status,reason,receipt_json,recorded_at) SELECT g.id,json_extract(c.value,'$.orderId'),'not_attempted',json_extract(c.value,'$.reason'),NULL,g.created_at FROM admin_order_bulk_groups g,json_each(g.children_json) c WHERE g.id=? AND g.claim_nonce=? AND json_extract(c.value,'$.eligible')=0`
            )
            .bind(id, nonce)
        ]),
        3
      )
    } catch (error) {
      await authorize(database, claims, fresh())
      const winner = await ownCommand(database, claims, options.idempotencyKey, hash)
      await authorize(database, claims, fresh())
      if (winner) return winner.receipt
      const current = await projectPreview(
        previewInput,
        await readSources(
          database,
          input.orders.map((row) => row.orderId),
          fresh()
        ),
        instant(fresh())
      )
      if (current.previewHash !== input.previewHash) throw new AdminOrderBulkError('revalidation_required')
      throw error
    }
    await authorize(database, claims, fresh())
    const committed = await ownCommand(database, claims, options.idempotencyKey, hash)
    await authorize(database, claims, fresh())
    if (!committed) throw new AdminOrderBulkError('history_unconfirmed')
    return committed.receipt
  })
}
export async function readD1AdminOrderBulkCommand(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawKey: string,
  rawHash: string,
  rawOptions: AdminOrderBulkOptions = {}
): Promise<AdminOrderBulkCommand> {
  return attempt(async () => {
    const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
      key = checked(catalogPolicyUuidSchema, rawKey),
      hash = checked(adminOrderBulkHashSchema, rawHash),
      options = checked(optionsSchema, rawOptions),
      fresh = fulfillmentFreshClock(options.now)
    await authorize(database, claims, fresh())
    const group = await ownCommand(database, claims, key, hash)
    await authorize(database, claims, fresh())
    return checked(
      adminOrderBulkCommandSchema,
      group
        ? { source: 'cloudflare', outcome: 'applied', receipt: group.receipt }
        : { source: 'cloudflare', outcome: 'unknown', receipt: null },
      'history_unconfirmed'
    )
  })
}
async function projectGroup(database: D1Database, group: Group): Promise<AdminOrderBulkGroup> {
  const appliedProof = fulfillmentAuditProofSql.replaceAll('c.', 'fc.')
  const records = await rows(
    database
      .prepare(
        `SELECT child.value AS child_json,r.status,r.reason,r.receipt_json,a.order_id AS attempted,CASE WHEN r.status='applied' THEN EXISTS(SELECT 1 FROM order_fulfillment_commands fc WHERE fc.actor_id=g.actor_id AND fc.order_id=r.order_id AND fc.idempotency_key=json_extract(child.value,'$.childKey') AND fc.response=r.receipt_json AND ${appliedProof}) ELSE 1 END AS proof FROM admin_order_bulk_groups g,json_each(g.children_json) child LEFT JOIN admin_order_bulk_results r ON r.group_id=g.id AND r.order_id=json_extract(child.value,'$.orderId') LEFT JOIN admin_order_bulk_attempts a ON a.group_id=g.id AND a.order_id=json_extract(child.value,'$.orderId') WHERE g.id=? ORDER BY CAST(child.key AS INTEGER)`
      )
      .bind(group.record.id)
  )
  const schema = z
    .object({
      child_json: z.string(),
      status: z.enum(['applied', 'rejected', 'not_attempted']).nullable(),
      reason: adminOrderBulkReasonSchema.nullable(),
      receipt_json: z.string().nullable(),
      attempted: catalogPolicyUuidSchema.nullable(),
      proof: z.literal(1)
    })
    .strict()
  const result = records.map((raw, index) => {
    const row = checked(schema, raw, 'history_unconfirmed'),
      child = stored(childSchema, row.child_json)
    if (canonicalJson(child) !== canonicalJson(group.children[index]))
      throw new AdminOrderBulkError('history_unconfirmed')
    return {
      orderId: child.orderId,
      expectedVersion: child.expectedVersion,
      childKey: child.childKey,
      status: row.status ?? (row.attempted ? 'unknown' : 'pending'),
      reason: row.reason,
      receipt: row.receipt_json === null ? null : stored(fulfillmentCommandReceiptSchema, row.receipt_json)
    }
  })
  if (result.length !== group.children.length) throw new AdminOrderBulkError('history_unconfirmed')
  const pauses = await rows(
    database.prepare('SELECT reason FROM admin_order_bulk_pauses WHERE group_id=?').bind(group.record.id)
  )
  checked(z.array(z.object({ reason: z.enum(authCodes) }).strict()).max(1), pauses, 'history_unconfirmed')
  const completed = result.filter((row) => ['applied', 'rejected', 'not_attempted'].includes(row.status)).length
  return checked(
    adminOrderBulkGroupSchema,
    {
      source: 'cloudflare',
      groupId: group.record.id,
      commandId: group.record.command_id,
      payloadHash: group.record.payload_hash,
      dispatchId: group.record.dispatch_id,
      action: group.input.action,
      status: pauses.length ? 'paused' : completed === result.length ? 'completed' : 'pending',
      recordedAt: group.record.created_at,
      selected: result.length,
      completed,
      remaining: result.length - completed,
      rows: result,
      inventoryEffect: 'none',
      economicEffect: 'none'
    },
    'history_unconfirmed'
  )
}
export async function readD1AdminOrderBulk(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawId: string,
  rawOptions: AdminOrderBulkOptions = {}
): Promise<AdminOrderBulkGroup> {
  return attempt(async () => {
    const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
      id = checked(catalogPolicyUuidSchema, rawId),
      options = checked(optionsSchema, rawOptions),
      fresh = fulfillmentFreshClock(options.now)
    await authorize(database, claims, fresh())
    const group = await lookup(database, 'id=? AND actor_id=?', [id, claims.identityId])
    if (!group) throw new AdminOrderBulkError('not_found')
    const result = await projectGroup(database, group)
    await authorize(database, claims, fresh())
    return result
  })
}
async function pause(database: D1Database, group: Group, reason: (typeof authCodes)[number], now: string) {
  batchSucceeded(
    await database.batch([
      database
        .prepare(
          'INSERT INTO admin_order_bulk_pauses(group_id,reason,recorded_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_pauses WHERE group_id=?)'
        )
        .bind(group.record.id, reason, now, group.record.id),
      database
        .prepare(
          `INSERT INTO admin_order_bulk_results(group_id,order_id,status,reason,receipt_json,recorded_at) SELECT g.id,json_extract(c.value,'$.orderId'),'not_attempted',?,NULL,? FROM admin_order_bulk_groups g,json_each(g.children_json) c WHERE g.id=? AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_attempts a WHERE a.group_id=g.id AND a.order_id=json_extract(c.value,'$.orderId')) AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_results r WHERE r.group_id=g.id AND r.order_id=json_extract(c.value,'$.orderId'))`
        )
        .bind(reason, now, group.record.id)
    ]),
    2
  )
}
export async function processD1AdminOrderBulkStep(
  database: D1Database,
  rawId: string,
  rawDispatch: string,
  rawOptions: AdminOrderBulkOptions & { limit?: number } = {}
): Promise<AdminOrderBulkStepResult> {
  return attempt(async () => {
    const id = checked(catalogPolicyUuidSchema, rawId),
      dispatch = checked(catalogPolicyUuidSchema, rawDispatch),
      options = checked(optionsSchema.extend({ limit: z.number().int().min(1).max(5).optional() }), rawOptions),
      fresh = fulfillmentFreshClock(options.now)
    const group = await lookup(database, 'id=? AND dispatch_id=?', [id, dispatch])
    if (!group) throw new AdminOrderBulkError('not_found')
    const claims = {
      identityId: group.record.actor_id,
      sessionId: group.record.session_id,
      sessionVersion: group.record.session_version
    }
    const before = await projectGroup(database, group)
    let processed = 0
    if (before.status === 'pending')
      for (const child of before.rows
        .filter((row) => row.status === 'pending' || row.status === 'unknown')
        .slice(0, Math.min(options.limit ?? 1, ADMIN_ORDER_BULK_EFFECTIVE_STEP_LIMIT))) {
        try {
          await authorize(database, claims, fresh())
          const input = checked(
            fulfillmentTransitionInputSchema,
            {
              action: group.input.action,
              expectedVersion: child.expectedVersion,
              reason: group.input.reason,
              ...(group.input.evidence === undefined ? {} : { evidence: group.input.evidence })
            },
            'history_unconfirmed'
          )
          let receipt = await readD1AdminFulfillmentCommand(database, claims, child.orderId, input, {
            idempotencyKey: child.childKey,
            requireEnrolledMfa: true,
            ...(fresh() === undefined ? {} : { now: fresh() })
          })
          if (!receipt) {
            const result = await database
              .prepare(
                `WITH actor AS (${fulfillmentEnrolledActorSql}) INSERT INTO admin_order_bulk_attempts(group_id,order_id,created_at) SELECT ?5,?6,?7 FROM actor WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_attempts WHERE group_id=?5 AND order_id=?6) AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_results WHERE group_id=?5 AND order_id=?6) AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_pauses WHERE group_id=?5)`
              )
              .bind(
                fresh() ?? null,
                claims.sessionId,
                claims.identityId,
                claims.sessionVersion,
                id,
                child.orderId,
                instant(fresh())
              )
              .run()
            if (!result.success) throw new AdminOrderBulkError('service_unavailable')
            await authorize(database, claims, fresh())
            const ready = await rows(
              database
                .prepare(
                  'SELECT order_id FROM admin_order_bulk_attempts WHERE group_id=? AND order_id=? AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_results WHERE group_id=? AND order_id=?) AND NOT EXISTS(SELECT 1 FROM admin_order_bulk_pauses WHERE group_id=?)'
                )
                .bind(id, child.orderId, id, child.orderId, id)
            )
            if (ready.length !== 1) break
            receipt = await executeD1AdminFulfillmentCommand(database, claims, child.orderId, input, {
              idempotencyKey: child.childKey,
              requireEnrolledMfa: true,
              ...(fresh() === undefined ? {} : { now: fresh() })
            })
          }
          const result = await database
            .prepare(
              `INSERT INTO admin_order_bulk_results(group_id,order_id,status,reason,receipt_json,recorded_at) SELECT ?,?,'applied',NULL,?,? WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_results WHERE group_id=? AND order_id=?)`
            )
            .bind(id, child.orderId, JSON.stringify(receipt), instant(fresh()), id, child.orderId)
            .run()
          if (!result.success) throw new AdminOrderBulkError('service_unavailable')
          processed++
        } catch (error) {
          if (
            (error instanceof AdminOrderBulkError || error instanceof FulfillmentError) &&
            authCodes.some((code) => code === error.code)
          ) {
            await pause(database, group, error.code as (typeof authCodes)[number], instant(fresh()))
            break
          }
          if (
            error instanceof FulfillmentError &&
            adminOrderBulkReasonSchema.safeParse(error.code).success &&
            !['history_unconfirmed', 'idempotency_conflict'].includes(error.code)
          ) {
            const result = await database
              .prepare(
                `INSERT INTO admin_order_bulk_results(group_id,order_id,status,reason,receipt_json,recorded_at) SELECT ?,?,'rejected',?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_results WHERE group_id=? AND order_id=?)`
              )
              .bind(id, child.orderId, error.code, instant(fresh()), id, child.orderId)
              .run()
            if (!result.success) throw new AdminOrderBulkError('service_unavailable')
            processed++
          } else throw error
        }
      }
    const current = await projectGroup(database, group)
    return {
      source: 'cloudflare',
      groupId: id,
      dispatchId: dispatch,
      processed,
      remaining: current.remaining,
      requeue: current.status === 'pending',
      status: current.status
    }
  })
}
/** Internal queue/Cron metadata only; consumption revalidates the frozen actor. */
export async function readD1AdminOrderBulkDispatches(
  database: D1Database,
  rawOptions: AdminOrderBulkOptions & { limit?: number } = {}
): Promise<{ groupId: string; dispatchId: string }[]> {
  return attempt(async () => {
    const options = checked(optionsSchema.extend({ limit: z.number().int().min(1).max(5).optional() }), rawOptions)
    const result = await rows(
      database
        .prepare(
          `SELECT g.id AS groupId,g.dispatch_id AS dispatchId FROM admin_order_bulk_groups g WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_pauses p WHERE p.group_id=g.id) AND EXISTS(SELECT 1 FROM json_each(g.children_json) child WHERE NOT EXISTS(SELECT 1 FROM admin_order_bulk_results r WHERE r.group_id=g.id AND r.order_id=json_extract(child.value,'$.orderId'))) ORDER BY g.created_at,g.id LIMIT ?`
        )
        .bind(options.limit ?? 5)
    )
    return checked(
      z.array(z.object({ groupId: catalogPolicyUuidSchema, dispatchId: catalogPolicyUuidSchema }).strict()).max(5),
      result,
      'history_unconfirmed'
    )
  })
}
