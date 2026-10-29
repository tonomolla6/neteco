import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  classifyImpersonatedAction,
  impersonationActionInputSchema,
  impersonationActionResultSchema,
  impersonationBanner,
  impersonationLogSchema,
  impersonationSessionSchema,
  impersonationStartSchema
} from '../../shared/support-impersonation'
import {
  lifecycleBindings,
  lifecycleFail,
  lifecycleNow,
  lifecycleUuid,
  type AccountLifecycleOptions
} from '../auth/account-lifecycle-core'

const AUTHORITY = `WITH grants AS MATERIALIZED(SELECT p.permission_code FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=?3 AND r.granted_at<=?1 AND(r.expires_at IS NULL OR r.expires_at>?1))
 SELECT i.id actorId,i.customer_id ownCustomerId,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=?1) verified,
 (s.mfa_verified=1 AND EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL AND m.verified_at<=?1)) mfa,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='support.manage') support,
 EXISTS(SELECT 1 FROM grants WHERE permission_code='support.impersonate') impersonate
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4
 AND i.session_version=s.session_version AND i.status='active' AND s.revoked_at IS NULL AND s.created_at<=?1 AND s.expires_at>?1`
const authorityRow = z
  .object({
    actorId: z.string().uuid(),
    ownCustomerId: z.string().uuid().nullable(),
    verified: z.number(),
    mfa: z.number(),
    support: z.number(),
    impersonate: z.number()
  })
  .strict()
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, now: string, needsPermission = true) {
  if (
    !claims ||
    !lifecycleUuid.safeParse(claims.identityId).success ||
    !lifecycleUuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    return lifecycleFail('unauthenticated')
  const raw = await db
    .prepare(AUTHORITY)
    .bind(...lifecycleBindings(claims, now))
    .first()
  if (raw === null) return lifecycleFail('unauthenticated')
  const row = authorityRow.safeParse(raw)
  if (!row.success) return lifecycleFail('unavailable')
  if (!row.data.verified) return lifecycleFail('email_unverified')
  if (!row.data.mfa) return lifecycleFail('mfa_required')
  if (needsPermission && (!row.data.support || !row.data.impersonate)) return lifecycleFail('forbidden')
  return row.data
}
const sessionRow = z
  .object({
    id: z.string().uuid(),
    actor_id: z.string().uuid(),
    customer_id: z.string().uuid(),
    customer_name: z.string().nullable(),
    ticket_ref: z.string(),
    reason: z.string(),
    started_at: catalogPolicyInstantSchema,
    expires_at: catalogPolicyInstantSchema,
    ended_at: catalogPolicyInstantSchema.nullable(),
    payload_hash: z.string()
  })
  .strict()
const SESSION_SELECT = `SELECT s.id,s.actor_id,s.customer_id,c.name customer_name,s.ticket_ref,s.reason,s.started_at,s.expires_at,s.ended_at,s.payload_hash
 FROM support_impersonation_sessions s JOIN customers c ON c.id=s.customer_id`
function view(row: z.infer<typeof sessionRow>, now: string) {
  const status = row.ended_at ? 'ended' : row.expires_at > now ? 'active' : 'expired',
    remaining = status === 'active' ? Math.ceil((Date.parse(row.expires_at) - Date.parse(now)) / 1000) : 0
  const parsed = impersonationSessionSchema.safeParse({
    source: 'cloudflare',
    id: row.id,
    actorId: row.actor_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    ticketRef: row.ticket_ref,
    reason: row.reason,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    status,
    remainingSeconds: remaining,
    banner: impersonationBanner(row.customer_name, row.ticket_ref)
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
async function readSession(db: D1Database, where: string, ...binds: unknown[]) {
  const raw = await db
    .prepare(`${SESSION_SELECT} WHERE ${where}`)
    .bind(...binds)
    .first()
  if (raw === null) return null
  const parsed = sessionRow.safeParse(raw)
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export async function startD1Impersonation(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: AccountLifecycleOptions = {}
) {
  const parsed = impersonationStartSchema.safeParse(input)
  if (!parsed.success || !lifecycleUuid.safeParse(key).success) return lifecycleFail('invalid_input')
  const now = lifecycleNow(options),
    value = parsed.data,
    actor = await authority(db, claims, now)
  if (actor.ownCustomerId === value.customerId) return lifecycleFail('forbidden')
  const hash = await canonicalPayloadHash({ actorId: actor.actorId, ...value }),
    previous = await readSession(db, 's.actor_id=?1 AND s.command_id=?2', actor.actorId, key)
  if (previous) return previous.payload_hash === hash ? view(previous, now) : lifecycleFail('conflict')
  const target = await db
    .prepare(
      `SELECT 1 ok FROM customers c JOIN support_tickets t ON t.customer_id=c.id WHERE c.id=?1 AND c.status='active' AND t.public_ref=?2
 AND t.state<>'closed' AND(t.retention_until IS NULL OR t.retention_until>?3)`
    )
    .bind(value.customerId, value.ticketRef, now)
    .first()
  if (target === null) return lifecycleFail('not_found')
  const id = crypto.randomUUID()
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE support_impersonation_sessions SET ended_at=expires_at,ended_reason='expired' WHERE actor_id=?1 AND ended_at IS NULL AND expires_at<=?2`
        )
        .bind(actor.actorId, now),
      db
        .prepare(
          `INSERT INTO support_impersonation_sessions(id,command_id,payload_hash,actor_id,actor_session_id,customer_id,ticket_ref,reason,started_at,expires_at)
 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
        )
        .bind(
          id,
          key,
          hash,
          actor.actorId,
          claims!.sessionId,
          value.customerId,
          value.ticketRef,
          value.reason,
          now,
          iso(Date.parse(now) + value.minutes * 60000)
        )
    ])
  } catch {
    /* One open session per agent is a unique index; read the durable state next. */
  }
  const stored = await readSession(db, 's.actor_id=?1 AND s.command_id=?2', actor.actorId, key)
  await authority(db, claims, now)
  if (!stored) return lifecycleFail('conflict')
  return stored.payload_hash === hash ? view(stored, now) : lifecycleFail('conflict')
}
export async function getActiveD1Impersonation(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountLifecycleOptions = {}
) {
  const now = lifecycleNow(options),
    actor = await authority(db, claims, now, false),
    row = await readSession(db, 's.actor_id=?1 AND s.ended_at IS NULL AND s.expires_at>?2', actor.actorId, now)
  return row ? view(row, now) : null
}
export async function endD1Impersonation(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  sessionId: string,
  options: AccountLifecycleOptions = {}
) {
  if (!lifecycleUuid.safeParse(sessionId).success) return lifecycleFail('invalid_input')
  const now = lifecycleNow(options),
    actor = await authority(db, claims, now, false)
  let row = await readSession(db, 's.id=?1 AND s.actor_id=?2', sessionId, actor.actorId)
  if (!row) return lifecycleFail('not_found')
  if (!row.ended_at) {
    const expired = row.expires_at <= now
    try {
      await db
        .prepare(
          'UPDATE support_impersonation_sessions SET ended_at=?1,ended_reason=?2 WHERE id=?3 AND actor_id=?4 AND ended_at IS NULL'
        )
        .bind(expired ? row.expires_at : now, expired ? 'expired' : 'manual', sessionId, actor.actorId)
        .run()
    } catch {
      /* re-read */
    }
    row = await readSession(db, 's.id=?1 AND s.actor_id=?2', sessionId, actor.actorId)
  }
  return row?.ended_at ? view(row, now) : lifecycleFail('unavailable')
}
const actionRow = z
  .object({
    seq: z.number().int(),
    action_code: z.string(),
    resource: z.string().nullable(),
    outcome: z.enum(['allowed', 'blocked']),
    block_reason: z.string().nullable(),
    recorded_at: catalogPolicyInstantSchema
  })
  .strict()
const ACTION_SELECT = 'SELECT seq,action_code,resource,outcome,block_reason,recorded_at'
function actionView(sessionId: string, row: z.infer<typeof actionRow>) {
  const parsed = impersonationActionResultSchema.safeParse({
    source: 'cloudflare',
    sessionId,
    seq: row.seq,
    action: row.action_code,
    resource: row.resource,
    outcome: row.outcome,
    reason: row.block_reason,
    recordedAt: row.recorded_at
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
/**
 * Logs every attempted action. Credentials and payments are denied by an
 * allow-list; blocked and post-expiry attempts are still written to the audit.
 */
export async function recordD1ImpersonatedAction(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  sessionId: string,
  key: string,
  input: unknown,
  options: AccountLifecycleOptions = {}
) {
  const parsed = impersonationActionInputSchema.safeParse(input)
  if (!parsed.success || !lifecycleUuid.safeParse(sessionId).success || !lifecycleUuid.safeParse(key).success)
    return lifecycleFail('invalid_input')
  const now = lifecycleNow(options),
    actor = await authority(db, claims, now),
    session = await readSession(db, 's.id=?1 AND s.actor_id=?2', sessionId, actor.actorId)
  if (!session) return lifecycleFail('not_found')
  const value = parsed.data,
    resource = value.resource ?? null,
    existing = await db
      .prepare(`${ACTION_SELECT} FROM support_impersonation_actions WHERE session_id=?1 AND command_id=?2`)
      .bind(sessionId, key)
      .first()
  if (existing) {
    const row = actionRow.parse(existing)
    return row.action_code === value.action && row.resource === resource
      ? actionView(sessionId, row)
      : lifecycleFail('conflict')
  }
  const active = !session.ended_at && session.expires_at > now,
    verdict = classifyImpersonatedAction(value.action),
    outcome = active && verdict.outcome === 'allowed' ? 'allowed' : 'blocked',
    reason =
      outcome === 'allowed'
        ? null
        : !active
          ? 'session_inactive'
          : verdict.outcome === 'blocked'
            ? verdict.reason
            : 'not_permitted'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO support_impersonation_actions(id,session_id,seq,command_id,actor_id,action_code,resource,outcome,block_reason,recorded_at)
 SELECT ?1,?2,COALESCE(MAX(seq),0)+1,?3,?4,?5,?6,?7,?8,?9 FROM support_impersonation_actions WHERE session_id=?2`
        )
        .bind(crypto.randomUUID(), sessionId, key, actor.actorId, value.action, resource, outcome, reason, now)
        .run()
      break
    } catch {
      /* seq race or guard: re-read below */
      const raced = await db
        .prepare(`SELECT 1 ok FROM support_impersonation_actions WHERE session_id=?1 AND command_id=?2`)
        .bind(sessionId, key)
        .first()
      if (raced) break
    }
  }
  const stored = await db
    .prepare(`${ACTION_SELECT} FROM support_impersonation_actions WHERE session_id=?1 AND command_id=?2`)
    .bind(sessionId, key)
    .first()
  await authority(db, claims, now)
  if (!stored) return lifecycleFail('unavailable')
  return actionView(sessionId, actionRow.parse(stored))
}
export async function listD1ImpersonationActions(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  sessionId: string,
  options: AccountLifecycleOptions = {}
) {
  if (!lifecycleUuid.safeParse(sessionId).success) return lifecycleFail('invalid_input')
  const now = lifecycleNow(options)
  await authority(db, claims, now)
  const session = await readSession(db, 's.id=?1', sessionId)
  if (!session) return lifecycleFail('not_found')
  const { results } = await db
    .prepare(`${ACTION_SELECT} FROM support_impersonation_actions WHERE session_id=?1 ORDER BY seq LIMIT 2000`)
    .bind(sessionId)
    .all()
  await authority(db, claims, now)
  const parsed = impersonationLogSchema.safeParse({
    source: 'cloudflare',
    session: view(session, now),
    actions: results.map((raw) => {
      const { sessionId: _s, source: _o, ...rest } = actionView(sessionId, actionRow.parse(raw))
      void _s
      void _o
      return rest
    })
  })
  return parsed.success ? parsed.data : lifecycleFail('unavailable')
}
