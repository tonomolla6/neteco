import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { PerformanceInsightError, isCanonicalInstant } from '../../shared/performance-insights-error'

export interface OperationOptions {
  now?: string
}

export function operationInstant(options?: OperationOptions): string {
  const now = options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!isCanonicalInstant(now)) throw new PerformanceInsightError('invalid_instant', 500)
  return now
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Live authorization (never trusts cached cookie roles). Mutations authorize again right before commit. */
export async function requireAdministration(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<string> {
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) throw new PerformanceInsightError(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  return auth.identityId
}

export type CommandDomain = 'aiops' | 'third_party' | 'edge_personalization'
type GuardTable = 'aiops_recommendations' | 'third_party_scripts' | 'edge_personalization_rules'

export interface CommandContext {
  database: D1Database
  domain: CommandDomain
  actorId: string
  action: string
  commandId: string
  idempotencyKey: string
  now: string
}

export interface CommandPlan<T> {
  statements: D1PreparedStatement[]
  receipt: T
  /** Only commit the command row (and therefore report success) if this row reached `version`. */
  guard?: { table: GuardTable; id: string; version: number }
}

async function findReceipt(ctx: CommandContext, payloadHash: string): Promise<string | null> {
  const row = await ctx.database
    .prepare(
      `SELECT payload_hash, receipt_json FROM perf_insight_commands
       WHERE domain = ?1 AND actor_id = ?2 AND idempotency_key = ?3`
    )
    .bind(ctx.domain, ctx.actorId, ctx.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()
  if (!row) return null
  if (row.payload_hash !== payloadHash)
    throw new PerformanceInsightError('idempotency_conflict', 409, 'Idempotency key reused with another payload')
  return row.receipt_json
}

/**
 * Runs `build` at most once per (domain, actor, idempotencyKey). The command row is the audit
 * record (append-only) and is inserted in the same batch as the state change; CAS failures
 * leave no command row and surface as `concurrency_conflict`.
 */
export async function executeIdempotent<T>(
  ctx: CommandContext,
  payload: unknown,
  build: () => Promise<CommandPlan<T>>
): Promise<T> {
  const payloadHash = await sha256Hex(stableStringify({ action: ctx.action, payload }))
  const replay = await findReceipt(ctx, payloadHash)
  if (replay !== null) return JSON.parse(replay) as T
  const plan = await build()
  const guardSql = plan.guard ? `WHERE EXISTS (SELECT 1 FROM ${plan.guard.table} WHERE id = ?9 AND version = ?10)` : ''
  const binds: unknown[] = [
    ctx.commandId,
    ctx.domain,
    ctx.actorId,
    ctx.action,
    ctx.idempotencyKey,
    payloadHash,
    JSON.stringify(plan.receipt),
    ctx.now
  ]
  if (plan.guard) binds.push(plan.guard.id, plan.guard.version)
  const insert = ctx.database
    .prepare(
      `INSERT INTO perf_insight_commands
         (command_id, domain, actor_id, action, idempotency_key, payload_hash, receipt_json, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 ${guardSql}`
    )
    .bind(...binds)
  try {
    await ctx.database.batch([...plan.statements, insert])
  } catch (error) {
    const raced = await findReceipt(ctx, payloadHash).catch(() => null)
    if (raced !== null) return JSON.parse(raced) as T
    if (error instanceof PerformanceInsightError) throw error
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message))
      throw new PerformanceInsightError('conflict', 409, 'Resource already exists')
    throw error
  }
  const stored = await ctx.database
    .prepare(`SELECT 1 AS present FROM perf_insight_commands WHERE command_id = ?1`)
    .bind(ctx.commandId)
    .first()
  if (!stored) throw new PerformanceInsightError('concurrency_conflict', 409, 'Resource changed concurrently')
  return plan.receipt
}
