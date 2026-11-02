import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'

export type { VerifiedSessionClaims }
export { canonicalJson, sha256Hex }

export type PricingErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'limit_reached'
  | 'insufficient_credit'
  | 'account_frozen'
  | 'overpayment'
  | 'variant_not_available'
  | 'rate_limited'
  | 'feature_disabled'
  | 'service_unavailable'

export class PricingError extends Error {
  constructor(readonly code: PricingErrorCode) {
    super(code)
    this.name = 'PricingError'
  }
}
export function fail(code: PricingErrorCode): never {
  throw new PricingError(code)
}

export type PricingDomain = 'auto_discount' | 'free_shipping' | 'store_credit' | 'payment_schedule'

export interface PricingReceipt {
  commandId: string
  domain: PricingDomain
  action: string
  targetId: string
  appliedVersion: number
  payloadHash: string
  recordedAt: string
  result?: Record<string, unknown>
}

export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function requireIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) fail('invalid_input')
}
export function requireVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('invalid_input')
}
export function requireUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    fail('invalid_input')
}

/** Live administrative authorization: current session, current MFA, current permission. */
export async function authorizeAdmin(db: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const auth = await authorizeD1Session(db, claims, 'administration.manage', { requireMfa: true, now })
  if (auth.allowed) return
  if (auth.code === 'mfa_required' || auth.code === 'unauthenticated' || auth.code === 'email_unverified')
    fail(auth.code)
  fail('forbidden')
}

/** The customer is always derived from the live server session, never from the request body. */
export async function liveCustomerId(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<string | null> {
  if (!claims) return null
  const row = await db
    .prepare(
      `SELECT i.customer_id AS customerId FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
       JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3 AND i.session_version = s.session_version
         AND i.status = 'active' AND i.email_verified_at IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ customerId: string | null }>()
  return row?.customerId ?? null
}
export async function requireCustomer(db: D1Database, claims: VerifiedSessionClaims, now: string): Promise<string> {
  const id = await liveCustomerId(db, claims, now)
  if (!id) fail('unauthenticated')
  return id
}

export function storageError(error: unknown): never {
  if (error instanceof PricingError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/pricing_version_conflict/.test(message)) fail('version_conflict')
  if (/UNIQUE constraint failed: pricing_commands\./.test(message)) fail('idempotency_conflict')
  if (/pricing_over(payment|refund|invoice|credit|_redeem)/.test(message)) fail('overpayment')
  if (/pricing_credit_unusable/.test(message)) fail('insufficient_credit')
  // 0152/0153: credit is frozen once a payment intent or pre-authorisation fixed the amount to charge.
  if (/checkout_credit_after_payment/.test(message)) fail('invalid_transition')
  if (/CHECK constraint failed: remaining_cents|CHECK constraint failed: balance_cents/.test(message))
    fail('version_conflict')
  if (/UNIQUE constraint failed/.test(message)) fail('conflict')
  if (/FOREIGN KEY constraint failed/.test(message)) fail('not_found')
  throw error
}

export async function replay(
  db: D1Database,
  actorId: string,
  key: string,
  payloadHash: string
): Promise<PricingReceipt | null> {
  const row = await db
    .prepare('SELECT payload_hash, receipt_json FROM pricing_commands WHERE actor_id = ? AND idempotency_key = ?')
    .bind(actorId, key)
    .first<{ payload_hash: string; receipt_json: string }>()
  if (!row) return null
  if (row.payload_hash !== payloadHash) fail('idempotency_conflict')
  return JSON.parse(row.receipt_json) as PricingReceipt
}

export interface CommandSpec {
  actorId: string
  key: string
  domain: PricingDomain
  action: string
  targetId: string
  expectedVersion: number
  appliedVersion: number
  payloadHash: string
  now: string
  result?: Record<string, unknown>
  audit?: Record<string, unknown>
  /** Statements that run after the command row (so ledger rows may reference it). */
  statements: (commandId: string) => D1PreparedStatement[]
}

/** One atomic batch: CAS-guarded command row, domain writes, append-only audit. */
export async function runCommand(db: D1Database, spec: CommandSpec): Promise<PricingReceipt> {
  const commandId = crypto.randomUUID()
  const receipt: PricingReceipt = {
    commandId,
    domain: spec.domain,
    action: spec.action,
    targetId: spec.targetId,
    appliedVersion: spec.appliedVersion,
    payloadHash: spec.payloadHash,
    recordedAt: spec.now,
    ...(spec.result ? { result: spec.result } : {})
  }
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pricing_commands(command_id, actor_id, domain, action, target_id, idempotency_key,
             expected_version, applied_version, payload_hash, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          spec.actorId,
          spec.domain,
          spec.action,
          spec.targetId,
          spec.key,
          spec.expectedVersion,
          spec.appliedVersion,
          spec.payloadHash,
          JSON.stringify(receipt),
          spec.now
        ),
      ...spec.statements(commandId),
      audit(
        db,
        spec.domain,
        spec.targetId,
        spec.action,
        spec.actorId,
        'applied',
        { commandId, ...spec.audit },
        spec.now
      )
    ])
    return receipt
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/UNIQUE constraint failed: pricing_commands\.actor_id/.test(message)) {
      const winner = await replay(db, spec.actorId, spec.key, spec.payloadHash)
      if (winner) return winner
    }
    return storageError(error)
  }
}

export function audit(
  db: D1Database,
  domain: PricingDomain,
  targetId: string,
  action: string,
  actorId: string,
  outcome: 'applied' | 'blocked',
  detail: Record<string, unknown>,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pricing_audit(domain, target_id, action, actor_id, outcome, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(domain, targetId, action, actorId, outcome, JSON.stringify(detail), now)
}

/** Blocked attempts are evidence too: persisted before the caller fails. */
export async function recordBlocked(
  db: D1Database,
  domain: PricingDomain,
  targetId: string,
  action: string,
  actorId: string,
  detail: Record<string, unknown>,
  now: string
): Promise<void> {
  await audit(db, domain, targetId, action, actorId, 'blocked', detail, now).run()
}

export const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: []
}
