import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

const uuid = z.string().uuid()
export const paymentTokenRemovalInputSchema = z
  .object({ tokenId: uuid, commandId: uuid, expectedVersion: z.number().int().safe().min(1) })
  .strict()
export class PaymentTokenError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'not_found' | 'conflict' | 'unavailable') {
    super(code)
  }
}
type Options = { now?: () => string }
function clock(options: Options) {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(now).success) throw new PaymentTokenError('unavailable')
  return now
}
async function owner(db: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  const customer = await activeOrderCustomerId(db, claims, now)
  if (!customer) throw new PaymentTokenError('unauthenticated')
  return customer
}
const authority = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 JOIN customers c ON c.id=i.customer_id AND c.status='active'
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND i.session_version=s.session_version
 AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND s.revoked_at IS NULL AND s.created_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND s.expires_at>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND c.id=?5)`
export async function listPaymentTokens(db: D1Database, claims: VerifiedSessionClaims | null, options: Options = {}) {
  const customer = await owner(db, claims, clock(options))
  const rows = await db
    .prepare(
      `SELECT id,status,version,created_at AS createdAt FROM payment_saved_tokens
    WHERE customer_id=? AND status='active' ORDER BY created_at,id LIMIT 101`
    )
    .bind(customer)
    .all()
  if (!rows.success || rows.results.length > 100) throw new PaymentTokenError('unavailable')
  if ((await owner(db, claims, clock(options))) !== customer) throw new PaymentTokenError('unauthenticated')
  return { tokens: rows.results }
}
async function receipt(db: D1Database, customer: string, commandId: string) {
  return db
    .prepare(
      `SELECT c.token_id AS tokenId,c.version,c.payload_hash AS payloadHash,
    CASE WHEN a.token_id=c.token_id AND a.version=c.version AND a.created_at=c.created_at
      AND a.action='removal_requested' THEN 1 ELSE 0 END AS proof
    FROM payment_token_commands c LEFT JOIN payment_token_audit a
      ON a.customer_id=c.customer_id AND a.command_id=c.command_id
    WHERE c.customer_id=? AND c.command_id=?`
    )
    .bind(customer, commandId)
    .first<{ tokenId: string; version: number; payloadHash: string; proof: number }>()
}
export async function requestPaymentTokenRemoval(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: Options = {}
) {
  const parsed = paymentTokenRemovalInputSchema.safeParse(raw)
  if (!parsed.success) throw new PaymentTokenError('invalid_input')
  const input = parsed.data
  const now = clock(options),
    customer = await owner(db, claims, now)
  const hash = await canonicalPayloadHash({
    kind: 'payment-token-removal',
    customerId: customer,
    tokenId: input.tokenId,
    expectedVersion: input.expectedVersion
  })
  async function recover() {
    const saved = await receipt(db, customer, input.commandId)
    if ((await owner(db, claims, clock(options))) !== customer) throw new PaymentTokenError('unauthenticated')
    if (!saved) return null
    if (saved.payloadHash !== hash) throw new PaymentTokenError('conflict')
    if (saved.proof !== 1) throw new PaymentTokenError('unavailable')
    return { tokenId: saved.tokenId, version: saved.version, outcome: 'removal_pending' as const }
  }
  const existing = await recover()
  if (existing) return existing
  const row = await db
    .prepare('SELECT status,version FROM payment_saved_tokens WHERE id=? AND customer_id=?')
    .bind(input.tokenId, customer)
    .first<{ status: string; version: number }>()
  if (!row) throw new PaymentTokenError('not_found')
  if (row.status !== 'active' || row.version !== input.expectedVersion) throw new PaymentTokenError('conflict')
  const args = [
    claims!.sessionId,
    claims!.identityId,
    claims!.sessionVersion,
    now,
    customer,
    input.tokenId,
    input.expectedVersion
  ]
  const guardId = crypto.randomUUID(),
    finalGuardId = crypto.randomUUID()
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO payment_token_guards(id,valid) SELECT ?8,CASE WHEN ${authority} AND EXISTS(
        SELECT 1 FROM payment_saved_tokens WHERE id=?6 AND customer_id=?5 AND status='active' AND version=?7) THEN 1 ELSE 0 END`
        )
        .bind(...args, guardId),
      db
        .prepare(
          `UPDATE payment_saved_tokens SET status='removal_pending',version=version+1,updated_at=?4
        WHERE id=?6 AND customer_id=?5 AND status='active' AND version=?7 AND ${authority}`
        )
        .bind(...args),
      db
        .prepare(
          `INSERT INTO payment_token_commands(customer_id,command_id,payload_hash,token_id,version,created_at)
        SELECT ?5,?8,?9,id,version,?4 FROM payment_saved_tokens WHERE id=?6 AND customer_id=?5
        AND status='removal_pending' AND version=?7+1 AND ${authority}`
        )
        .bind(...args, input.commandId, hash),
      db
        .prepare(
          `INSERT INTO payment_token_audit(customer_id,command_id,token_id,action,version,created_at)
        SELECT customer_id,command_id,token_id,'removal_requested',version,created_at FROM payment_token_commands
        WHERE customer_id=?1 AND command_id=?2`
        )
        .bind(customer, input.commandId),
      db
        .prepare(
          `INSERT INTO payment_token_removal_jobs(token_id,status,attempts,due_at,updated_at)
        SELECT token_id,'pending',0,created_at,created_at FROM payment_token_commands
        WHERE customer_id=?1 AND command_id=?2`
        )
        .bind(customer, input.commandId),
      db
        .prepare(
          `INSERT INTO payment_token_guards(id,valid) SELECT ?8,CASE WHEN ${authority} AND EXISTS(
        SELECT 1 FROM payment_token_audit a JOIN payment_saved_tokens t ON t.id=a.token_id
        JOIN payment_token_removal_jobs j ON j.token_id=t.id AND j.status='pending'
        WHERE a.customer_id=?5 AND a.command_id=?9 AND t.status='removal_pending' AND t.version=?7+1) THEN 1 ELSE 0 END`
        )
        .bind(...args, finalGuardId, input.commandId),
      db.prepare('DELETE FROM payment_token_guards WHERE id IN (?1,?2)').bind(guardId, finalGuardId)
    ])
  } catch {
    const replay = await recover()
    if (replay) return replay
    const current = await db
      .prepare('SELECT status,version FROM payment_saved_tokens WHERE id=? AND customer_id=?')
      .bind(input.tokenId, customer)
      .first<{ status: string; version: number }>()
    if (!current) throw new PaymentTokenError('not_found')
    if (current.status !== 'active' || current.version !== input.expectedVersion)
      throw new PaymentTokenError('conflict')
    throw new PaymentTokenError('unavailable')
  }
  const result = await recover()
  if (!result) throw new PaymentTokenError('unavailable')
  return result
}
