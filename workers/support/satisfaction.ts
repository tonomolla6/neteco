import type { VerifiedSessionClaims } from '../catalog/authorization'
import { customerFulfillmentSql } from '../catalog/customer-orders'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { supportPolicySchema, supportUuid, type SupportPolicy } from '../../shared/support-operations'
import {
  satisfactionInputSchema,
  satisfactionTargetSchema,
  satisfactionIntentHash,
  customerSatisfactionSchema,
  satisfactionReceiptSchema,
  adminSatisfactionQuerySchema,
  adminSatisfactionResponseSchema,
  type SatisfactionSource,
  type CustomerSatisfaction,
  type SatisfactionReceipt,
  type SatisfactionCommandResponse
} from '../../shared/support-satisfaction'
import {
  supportActor,
  authorizeSupportTicket,
  supportClock,
  actorSql,
  actorBinds,
  type SupportActor,
  SupportError
} from './operations'

export class SatisfactionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SatisfactionError'
  }
}
export interface SatisfactionOptions {
  now?: string
  policy?: SupportPolicy | null
}
function fail(code: string): never {
  throw new SatisfactionError(code)
}
function checked<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) fail('invalid_input')
  return result.data
}
const clockSql = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
// Existing support history authority, with its immutable command and event.
const supportProof = `t.updated_at<=${clockSql}
 AND (SELECT count(*) FROM support_commands WHERE ticket_id=t.id)=t.version
 AND (SELECT count(*) FROM support_events WHERE ticket_id=t.id)=t.version
 AND EXISTS(SELECT 1 FROM support_commands c JOIN support_events e ON e.id=c.id
 WHERE c.id=t.last_command_id AND c.ticket_id=t.id AND c.result_version=t.version
 AND c.to_state=t.state AND c.created_at=t.updated_at AND e.ticket_id=c.ticket_id
 AND e.state=c.to_state AND e.type=c.action AND e.actor_id IS c.actor_id)`
const deliveredState = customerFulfillmentSql('o.id', 'o.customer_id', clockSql)
const sourceCte = `WITH actor AS MATERIALIZED(${actorSql}),current_source AS MATERIALIZED(
 SELECT t.id sourceId,t.public_ref targetId,'support' kind,t.customer_id customerId,t.version,
 t.state state,t.updated_at finalizedAt,t.policy,t.retention_until retentionUntil,t.category,NULL shippingMethod,
 CASE WHEN ${supportProof} THEN 1 ELSE 0 END confirmed
 FROM support_tickets t JOIN actor a ON a.customer_id=t.customer_id WHERE ?7='support' AND t.public_ref=?8
 UNION ALL
 SELECT o.id,o.id,'delivery',o.customer_id,COALESCE(f.version,0),${deliveredState},f.updated_at,?9,
 CASE WHEN ?9 IS NOT NULL AND f.updated_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%SZ',f.updated_at,'+'||json_extract(?9,'$.retentionDays')||' days') ELSE NULL END,
 NULL,o.shipping_method_code,
 CASE WHEN f.order_id IS NULL OR ${deliveredState} IS NOT NULL THEN 1 ELSE 0 END
 FROM orders o JOIN actor a ON a.customer_id=o.customer_id LEFT JOIN order_fulfillments f ON f.order_id=o.id
 WHERE ?7='delivery' AND o.id=?8
)`
const feedbackProof = `f.customer_id=c.customer_id AND f.kind=c.kind AND f.target_id=c.target_id
 AND f.score=c.score AND f.comment_hash=c.comment_hash AND f.submitted_at=c.submitted_at AND f.retention_until=c.retention_until`
interface SourceRow {
  actorId: string
  customerId: string
  sourceId: string | null
  targetId: string
  kind: SatisfactionSource
  version: number
  state: string | null
  finalizedAt: string | null
  policy: string | null
  retentionUntil: string | null
  category: string | null
  shippingMethod: string | null
  confirmed: number
  commandId: string | null
  score: number | null
  comment: string | null
  submittedAt: string | null
  feedbackCoherent: number
  feedbackCount: number
  commandCount: number
  now: string
}
interface Context {
  db: D1Database
  actor: SupportActor
  kind: SatisfactionSource
  id: string
  now: () => string
  options: SatisfactionOptions
  policy: string | null
}
async function context(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: SatisfactionSource,
  id: string,
  options: SatisfactionOptions
): Promise<Context> {
  checked(satisfactionTargetSchema.safeParse({ kind, id, version: 0 }))
  const now = supportClock(options.now)
  try {
    const actor = await supportActor(db, claims, 'customer', now)
    if (kind === 'support') await authorizeSupportTicket(db, actor, id, now)
    const policy = options.policy == null ? null : canonicalJson(checked(supportPolicySchema.safeParse(options.policy)))
    return { db, actor, kind, id, now, options, policy }
  } catch (error) {
    if (error instanceof SupportError) fail(error.code === 'history_unconfirmed' ? 'service_unavailable' : error.code)
    throw error
  }
}
function binds(c: Context) {
  return [...actorBinds(c.actor, { now: c.options.now === undefined ? undefined : c.now() }), c.kind, c.id, c.policy]
}
async function source(c: Context): Promise<SourceRow> {
  const row = await c.db
    .prepare(
      `${sourceCte}
 SELECT a.id actorId,a.customer_id customerId,s.sourceId,s.targetId,s.kind,s.version,s.state,s.finalizedAt,
 CASE WHEN f.command_id IS NULL THEN s.policy ELSE committed.policy END policy,
 CASE WHEN f.command_id IS NULL THEN s.retentionUntil ELSE committed.retention_until END retentionUntil,
 s.category,s.shippingMethod,s.confirmed,
 f.command_id commandId,f.score,f.comment,f.submitted_at submittedAt,
 CASE WHEN f.command_id IS NULL THEN 1 WHEN EXISTS(SELECT 1 FROM support_satisfaction_commands c WHERE c.command_id=f.command_id AND ${feedbackProof}) THEN 1 ELSE 0 END feedbackCoherent,
 (SELECT count(*) FROM support_satisfaction_feedback x WHERE x.kind=?7 AND x.target_id=?8 AND x.customer_id=a.customer_id) feedbackCount,
 (SELECT count(*) FROM support_satisfaction_commands x WHERE x.kind=?7 AND x.target_id=?8 AND x.customer_id=a.customer_id) commandCount,
 ${clockSql} now FROM actor a LEFT JOIN current_source s ON 1=1
 LEFT JOIN support_satisfaction_feedback f ON f.kind=s.kind AND f.target_id=s.targetId AND f.customer_id=a.customer_id
 LEFT JOIN support_satisfaction_commands committed ON committed.command_id=f.command_id`
    )
    .bind(...binds(c))
    .first<SourceRow>()
  if (!row) fail('unauthenticated')
  if (!row.sourceId) fail('not_found')
  if (
    row.confirmed !== 1 ||
    row.feedbackCoherent !== 1 ||
    row.feedbackCount !== row.commandCount ||
    row.feedbackCount > 1
  )
    fail('service_unavailable')
  if (row.policy !== null) {
    try {
      supportPolicySchema.parse(JSON.parse(row.policy))
    } catch {
      fail('service_unavailable')
    }
  }
  return row
}
function reason(row: SourceRow) {
  if (row.policy === null || row.retentionUntil === null) return 'policy_unavailable' as const
  if (row.retentionUntil <= row.now) return 'retention_expired' as const
  if (row.commandId !== null) return 'already_submitted' as const
  if (row.kind === 'support' ? !['resolved', 'closed'].includes(row.state ?? '') : row.state !== 'delivered')
    return 'source_not_final' as const
  return null
}
function view(row: SourceRow, policyHash: string | null): CustomerSatisfaction {
  const why = reason(row),
    available = why !== 'retention_expired' && why !== 'policy_unavailable'
  const policy = row.policy === null ? null : supportPolicySchema.parse(JSON.parse(row.policy))
  return customerSatisfactionSchema.parse({
    source: 'cloudflare',
    target: { kind: row.kind, id: row.targetId, version: row.version },
    eligible: why === null,
    reason: why,
    feedback:
      available && row.commandId ? { score: row.score, comment: row.comment, submittedAt: row.submittedAt } : null,
    privacy:
      policy && row.retentionUntil
        ? { noticePath: policy.privacyNoticePath, retentionUntil: row.retentionUntil, policyHash }
        : null,
    evaluatedAt: row.now
  })
}
export async function readCustomerSatisfaction(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: SatisfactionSource,
  id: string,
  options: SatisfactionOptions = {}
) {
  const c = await context(db, claims, kind, id, options),
    before = await source(c)
  const policyHash = before.policy === null ? null : await sha256Hex(before.policy)
  // Hashing is asynchronous: authority and the exact policy are reread after it.
  const final = await source(c)
  if (final.policy !== before.policy) fail('service_unavailable')
  return view(final, policyHash)
}
interface CommandRow {
  command_id: string
  customer_id: string
  kind: SatisfactionSource
  target_id: string
  source_version: number
  payload_hash: string
  score: number
  submitted_at: string
  retention_until: string
}
function receipt(row: CommandRow): SatisfactionReceipt {
  try {
    return satisfactionReceiptSchema.parse({
      source: 'cloudflare',
      commandId: row.command_id,
      target: { kind: row.kind, id: row.target_id, version: row.source_version },
      payloadHash: row.payload_hash,
      score: row.score,
      submittedAt: row.submitted_at,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
  } catch {
    return fail('service_unavailable')
  }
}
async function command(c: Context, key: string, hash: string): Promise<SatisfactionReceipt | null> {
  // Receipt lookup and final live session/owner/retention share one statement.
  const row = await c.db
    .prepare(
      `${sourceCte} SELECT a.id actorId,s.sourceId,COALESCE(committed.policy,s.policy) policy,
 COALESCE(committed.retention_until,s.retentionUntil) retentionUntil,s.confirmed,
 CASE WHEN committed.command_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM support_satisfaction_feedback f
 WHERE f.command_id=committed.command_id AND f.customer_id=committed.customer_id
 AND f.kind=committed.kind AND f.target_id=committed.target_id AND f.score=committed.score
 AND f.comment_hash=committed.comment_hash AND f.submitted_at=committed.submitted_at
 AND f.retention_until=committed.retention_until) END feedbackCoherent,
 (SELECT json_object('command_id',x.command_id,'customer_id',x.customer_id,'kind',x.kind,'target_id',x.target_id,'source_version',x.source_version,'payload_hash',x.payload_hash,'score',x.score,'submitted_at',x.submitted_at,'retention_until',x.retention_until)
 FROM support_satisfaction_commands x JOIN support_satisfaction_feedback f ON f.command_id=x.command_id
 WHERE x.command_id=?10 AND x.customer_id=a.customer_id AND x.kind=?7 AND x.target_id=?8
 AND f.customer_id=x.customer_id AND f.kind=x.kind AND f.target_id=x.target_id AND f.score=x.score
 AND f.comment_hash=x.comment_hash AND f.submitted_at=x.submitted_at AND f.retention_until=x.retention_until) result,
 ${clockSql} now FROM actor a LEFT JOIN current_source s ON 1=1
 LEFT JOIN support_satisfaction_commands committed ON committed.kind=s.kind AND committed.target_id=s.targetId AND committed.customer_id=a.customer_id`
    )
    .bind(...binds(c), key)
    .first<{
      actorId: string
      sourceId: string | null
      policy: string | null
      retentionUntil: string | null
      confirmed: number
      feedbackCoherent: number
      result: string | null
      now: string
    }>()
  if (!row) fail('unauthenticated')
  if (!row.sourceId) fail('not_found')
  if (row.confirmed !== 1 || row.feedbackCoherent !== 1) fail('service_unavailable')
  if (!row.policy || !row.retentionUntil) fail('policy_unavailable')
  if (row.retentionUntil <= row.now) fail('retention_expired')
  if (!row.result) return null
  let value: CommandRow
  try {
    value = JSON.parse(row.result) as CommandRow
  } catch {
    return fail('service_unavailable')
  }
  if (value.payload_hash !== hash) fail('idempotency_conflict')
  if (value.retention_until <= row.now) fail('retention_expired')
  return receipt(value)
}
export async function readCustomerSatisfactionCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: SatisfactionSource,
  id: string,
  key: string,
  hash: string,
  options: SatisfactionOptions = {}
): Promise<SatisfactionCommandResponse> {
  checked(supportUuid.safeParse(key))
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_input')
  const c = await context(db, claims, kind, id, options),
    result = await command(c, key, hash)
  return result
    ? { source: 'cloudflare', outcome: 'applied', receipt: result }
    : { source: 'cloudflare', outcome: 'unknown' }
}
export async function submitCustomerSatisfaction(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  kind: SatisfactionSource,
  id: string,
  raw: unknown,
  options: SatisfactionOptions & { idempotencyKey: string }
): Promise<SatisfactionReceipt> {
  const input = checked(satisfactionInputSchema.safeParse(raw)),
    key = checked(supportUuid.safeParse(options.idempotencyKey))
  const hash = await satisfactionIntentHash(kind, id, input),
    commentHash = await sha256Hex(input.comment ?? '')
  const c = await context(db, claims, kind, id, options),
    before = await source(c)
  const old = await command(c, key, hash)
  if (old) return old
  const why = reason(before)
  if (why) fail(why)
  if (before.version !== input.expectedSourceVersion) fail('source_version_conflict')
  const policyHash = await sha256Hex(before.policy!)
  if (policyHash !== input.expectedPolicyHash) fail('policy_version_conflict')
  const insert = db
    .prepare(
      `${sourceCte} INSERT INTO support_satisfaction_commands
 (command_id,customer_id,actor_id,kind,target_id,source_id,source_version,payload_hash,score,comment_hash,policy,policy_hash,retention_until,category,shipping_method,submitted_at)
 SELECT ?10,s.customerId,a.id,s.kind,s.targetId,s.sourceId,s.version,?11,?12,?13,s.policy,?14,s.retentionUntil,s.category,s.shippingMethod,${clockSql}
 FROM current_source s JOIN actor a ON a.customer_id=s.customerId
 WHERE s.confirmed=1 AND s.version=?15 AND s.policy=?16 AND s.retentionUntil=?17 AND s.retentionUntil>${clockSql} AND ?14=?18
 AND ((s.kind='support' AND s.state IN('resolved','closed')) OR (s.kind='delivery' AND s.state='delivered'))
 AND NOT EXISTS(SELECT 1 FROM support_satisfaction_commands x WHERE x.customer_id=a.customer_id AND x.kind=s.kind AND x.target_id=s.targetId)
 AND NOT EXISTS(SELECT 1 FROM support_satisfaction_commands x WHERE x.command_id=?10)`
    )
    .bind(
      ...binds(c),
      key,
      hash,
      input.score,
      commentHash,
      policyHash,
      input.expectedSourceVersion,
      before.policy,
      before.retentionUntil,
      input.expectedPolicyHash
    )
  try {
    await db.batch([
      insert,
      db
        .prepare(
          `INSERT INTO support_satisfaction_feedback(command_id,customer_id,kind,target_id,score,comment,comment_hash,submitted_at,retention_until)
      SELECT command_id,customer_id,kind,target_id,score,?3,comment_hash,submitted_at,retention_until FROM support_satisfaction_commands
      WHERE command_id=?1 AND payload_hash=?2 AND NOT EXISTS(SELECT 1 FROM support_satisfaction_feedback WHERE command_id=?1)`
        )
        .bind(key, hash, input.comment ?? null),
      db
        .prepare(
          'INSERT INTO support_satisfaction_guards(id,satisfied) SELECT ?1,EXISTS(SELECT 1 FROM support_satisfaction_commands c JOIN support_satisfaction_feedback f ON f.command_id=c.command_id WHERE c.command_id=?1 AND c.payload_hash=?2 AND ' +
            feedbackProof +
            ')'
        )
        .bind(key, hash),
      db.prepare('DELETE FROM support_satisfaction_guards WHERE id=?1').bind(key)
    ])
  } catch {
    const current = await source(c),
      replay = await command(c, key, hash)
    if (replay) return replay
    if (reason(current)) fail(reason(current)!)
    if (current.version !== input.expectedSourceVersion) fail('source_version_conflict')
    fail('service_unavailable')
  }
  const applied = await command(c, key, hash)
  if (!applied) fail('service_unavailable')
  return applied
}
export async function readAdminSatisfaction(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  filters: unknown,
  options: SatisfactionOptions = {}
) {
  const query = checked(adminSatisfactionQuerySchema.safeParse(filters)),
    now = supportClock(options.now)
  let actor: SupportActor
  try {
    actor = await supportActor(db, claims, 'admin', now)
  } catch (error) {
    if (error instanceof SupportError) fail(error.code)
    throw error
  }
  const conditions = ['c.retention_until>' + clockSql, 'c.submitted_at<=' + clockSql],
    values: unknown[] = []
  const bind = (value: unknown) => {
    values.push(value)
    return '?' + (6 + values.length)
  }
  if (query.source) conditions.push('c.kind=' + bind(query.source))
  if (query.category) conditions.push('c.category=' + bind(query.category))
  if (query.shippingMethod) conditions.push('c.shipping_method=' + bind(query.shippingMethod))
  if (query.score) conditions.push('c.score=' + bind(query.score))
  const limit = bind(query.perPage),
    offset = bind((query.page - 1) * query.perPage),
    comment = query.comments ? 'f.comment' : 'NULL'
  // Page, total, aggregates and final live admin authority: one read snapshot.
  const row = await db
    .prepare(
      `WITH actor AS MATERIALIZED(${actorSql}),candidates AS MATERIALIZED(
 SELECT c.* FROM support_satisfaction_commands c WHERE ${conditions.join(' AND ')}
 ),eligible AS MATERIALIZED(SELECT c.* FROM candidates c
 WHERE EXISTS(SELECT 1 FROM support_satisfaction_feedback f WHERE f.command_id=c.command_id AND ${feedbackProof})
 ),page AS MATERIALIZED(SELECT c.* FROM eligible c ORDER BY c.submitted_at DESC,c.command_id DESC LIMIT ${limit} OFFSET ${offset})
 SELECT a.id actorId,${clockSql} now,(SELECT count(*) FROM eligible) total,
 ((SELECT count(*) FROM candidates)=(SELECT count(*) FROM eligible)) coherent,(SELECT avg(score) FROM eligible) average,
 (SELECT json_group_array(json_object('score',scores.score,'count',(SELECT count(*) FROM eligible WHERE score=scores.score))) FROM (SELECT 1 score UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) scores) scores,
 (SELECT json_group_array(json_object('target',json_object('kind',c.kind,'id',c.target_id,'version',c.source_version),'score',c.score,'submittedAt',c.submitted_at,'category',c.category,'shippingMethod',c.shipping_method,'comment',${comment})) FROM page c JOIN support_satisfaction_feedback f ON f.command_id=c.command_id) items
 FROM actor a`
    )
    .bind(...actorBinds(actor, { now: options.now === undefined ? undefined : now() }), ...values)
    .first<{
      actorId: string
      now: string
      total: number
      coherent: number
      average: number | null
      scores: string
      items: string
    }>()
  if (!row) fail('forbidden')
  if (row.coherent !== 1) fail('service_unavailable')
  try {
    return adminSatisfactionResponseSchema.parse({
      source: 'cloudflare',
      items: JSON.parse(row.items),
      total: row.total,
      page: query.page,
      perPage: query.perPage,
      commentsIncluded: query.comments,
      stats: { count: row.total, average: row.average, byScore: JSON.parse(row.scores) },
      evaluatedAt: row.now
    })
  } catch {
    return fail('service_unavailable')
  }
}
