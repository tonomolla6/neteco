import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

/** Stable, HTTP-mappable failure of the support insight modules (SUP-012/014/015/017). */
export class InsightError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'InsightError'
  }
}
export const insightFail = (code: string): never => {
  throw new InsightError(code)
}
export type InsightScope =
  'faq_handoff' | 'contact_classify' | 'contact_backlog' | 'education' | 'b2b_request' | 'b2b_admin'

export function insightNow(now?: () => string): string {
  const value = now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value)))
    return insightFail('invalid_input')
  return value
}
export function insightHash(scope: string, value: unknown): Promise<string> {
  return sha256Hex(canonicalJson({ scope, value }))
}
export function uuidKey(key: string | null | undefined): string {
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
    return insightFail('invalid_input')
  return key.toLowerCase()
}

/** Live administrative authority (support.manage + verified MFA), re-read on every call. */
export async function requireSupportAdmin(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<VerifiedSessionClaims> {
  if (!claims) return insightFail('unauthenticated')
  const result = await authorizeD1Session(db, claims, 'support.manage', { now, requireMfa: true })
  if (!result.allowed)
    return insightFail(
      ['unauthenticated', 'mfa_required', 'email_unverified'].includes(result.code) ? result.code : 'forbidden'
    )
  return claims
}

export async function replayedCommand<T>(
  db: D1Database,
  actorId: string,
  key: string,
  payloadHash: string
): Promise<T | null> {
  const row = await db
    .prepare('SELECT payload_hash,receipt FROM support_insight_commands WHERE actor_id=?1 AND idempotency_key=?2')
    .bind(actorId, key)
    .first<{ payload_hash: string; receipt: string }>()
  if (!row) return null
  if (row.payload_hash !== payloadHash) return insightFail('idempotency_conflict')
  return JSON.parse(row.receipt) as T
}
/**
 * Command ledger row, written only when the immediately preceding statement of the
 * batch changed exactly one row (the CAS guard). Dependent statements key off its id.
 */
export function guardedCommand(
  db: D1Database,
  input: {
    id: string
    scope: InsightScope
    actorId: string
    key: string
    payloadHash: string
    subjectId: string
    receipt: unknown
    now: string
  }
) {
  return db
    .prepare(
      `INSERT INTO support_insight_commands(id,scope,actor_id,idempotency_key,payload_hash,subject_id,receipt,created_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE (SELECT changes())=1`
    )
    .bind(
      input.id,
      input.scope,
      input.actorId,
      input.key,
      input.payloadHash,
      input.subjectId,
      JSON.stringify(input.receipt),
      input.now
    )
}
/** Runs a guarded batch; maps lost CAS to concurrency_conflict and key races to a replay. */
export async function runGuardedBatch<T>(
  db: D1Database,
  statements: D1PreparedStatement[],
  command: { id: string; actorId: string; key: string; payloadHash: string; receipt: T }
): Promise<T> {
  try {
    await db.batch(statements)
  } catch (error) {
    const replay = await replayedCommand<T>(db, command.actorId, command.key, command.payloadHash)
    if (replay) return replay
    if (error instanceof InsightError) throw error
    const message = String(error)
    if (/UNIQUE|constraint/i.test(message)) return insightFail('conflict')
    return insightFail('service_unavailable')
  }
  const written = await db
    .prepare('SELECT 1 AS ok FROM support_insight_commands WHERE id=?1')
    .bind(command.id)
    .first<{ ok: number }>()
  if (!written) return insightFail('concurrency_conflict')
  return command.receipt
}

/** Ledger row for commands without a CAS entity (idempotency alone guards replays). */
export function plainCommand(
  db: D1Database,
  input: {
    id: string
    scope: InsightScope
    actorId: string
    key: string
    payloadHash: string
    subjectId: string
    receipt: unknown
    now: string
  }
) {
  return db
    .prepare(
      `INSERT INTO support_insight_commands(id,scope,actor_id,idempotency_key,payload_hash,subject_id,receipt,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    )
    .bind(
      input.id,
      input.scope,
      input.actorId,
      input.key,
      input.payloadHash,
      input.subjectId,
      JSON.stringify(input.receipt),
      input.now
    )
}
