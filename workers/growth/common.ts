import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export type GrowthErrorCode =
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
  | 'variant_not_available'
  | 'limit_reached'
  | 'return_invalid'
  | 'experiment_not_running'
  | 'rate_limited'
  | 'service_unavailable'

export class GrowthError extends Error {
  constructor(readonly code: GrowthErrorCode) {
    super(code)
    this.name = 'GrowthError'
  }
}

export function fail(code: GrowthErrorCode): never {
  throw new GrowthError(code)
}

export interface CommandReceipt {
  commandId: string
  action: string
  targetId: string
  appliedVersion: number
  payloadHash: string
  recordedAt: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const isIdempotencyKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length >= 8 && key.length <= 128

export function requireIdempotencyKey(key: unknown): asserts key is string {
  if (!isIdempotencyKey(key)) fail('invalid_input')
}

/** Live authorization: current session, current MFA and current permission, never cached. */
export async function authorizeAdmin(db: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const auth = await authorizeD1Session(db, claims, 'administration.manage', { requireMfa: true, now })
  if (auth.allowed) return
  if (auth.code === 'mfa_required' || auth.code === 'unauthenticated' || auth.code === 'email_unverified')
    fail(auth.code)
  fail('forbidden')
}

type CommandTable = 'bxgy_commands' | 'promo_experiment_commands'

/** Exact replay of a prior command, or null; same key with another payload is a conflict. */
export async function replayCommand(
  db: D1Database,
  table: CommandTable,
  actorId: string,
  idempotencyKey: string,
  payloadHash: string
): Promise<CommandReceipt | null> {
  const row = await db
    .prepare(`SELECT payload_hash, receipt_json FROM ${table} WHERE actor_id = ? AND idempotency_key = ?`)
    .bind(actorId, idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()
  if (!row) return null
  if (row.payload_hash !== payloadHash) fail('idempotency_conflict')
  return JSON.parse(row.receipt_json) as CommandReceipt
}

/** Translate storage guard failures into stable domain errors. */
export function mapStorageError(error: unknown): never {
  if (error instanceof GrowthError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/_version_conflict/.test(message)) fail('version_conflict')
  if (/UNIQUE constraint failed: (bxgy_rules|promo_experiments)\.code/.test(message)) fail('conflict')
  if (/UNIQUE constraint failed: \w+_commands\.actor_id/.test(message)) fail('idempotency_conflict')
  if (/FOREIGN KEY constraint failed/.test(message)) fail('variant_not_available')
  if (/promo_experiment_not_running/.test(message)) fail('experiment_not_running')
  throw error
}

/** Atomic batch; a lost idempotency race resolves to the winner's receipt. */
export async function executeCommand(
  db: D1Database,
  table: CommandTable,
  actorId: string,
  idempotencyKey: string,
  payloadHash: string,
  statements: D1PreparedStatement[],
  receipt: CommandReceipt
): Promise<CommandReceipt> {
  try {
    await db.batch(statements)
    return receipt
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/UNIQUE constraint failed: \w+_commands\.actor_id/.test(message)) {
      const winner = await replayCommand(db, table, actorId, idempotencyKey, payloadHash)
      if (winner) return winner
    }
    return mapStorageError(error)
  }
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export { type VerifiedSessionClaims }
