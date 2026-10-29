import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export type PlanningErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'approval_self'
  | 'no_change'
  | 'root_cause_required'
  | 'invalid_state'
  | 'insufficient_stock'
  | 'service_unavailable'

export class InventoryPlanningError extends Error {
  constructor(readonly code: PlanningErrorCode) {
    super(code)
    this.name = 'InventoryPlanningError'
  }
}

export interface PlanningOptions {
  now?: string
}

export const planningNow = (options?: PlanningOptions) =>
  options?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Canonical payload hash: stable key order, independent of JSON property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export async function authorizePlanning(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permission: 'inventory.read' | 'inventory.write',
  options?: PlanningOptions
) {
  const result = await authorizeD1Session(database, claims, permission, {
    requireMfa: true,
    now: planningNow(options)
  })
  if (!result.allowed) throw new InventoryPlanningError(result.code)
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)

/** Returns the stored response for an already-applied command, or null. */
export async function replayCommand<T>(
  database: D1Database,
  commandId: string,
  scope: string,
  payloadHash: string
): Promise<T | null> {
  if (!isUuid(commandId)) throw new InventoryPlanningError('invalid_input')
  const row = await database
    .prepare('SELECT payload_hash, scope, response_json FROM inventory_planning_commands WHERE command_id = ?1')
    .bind(commandId)
    .first<{ payload_hash: string; scope: string; response_json: string }>()
  if (!row) return null
  if (row.payload_hash !== payloadHash || row.scope !== scope) throw new InventoryPlanningError('idempotency_conflict')
  return JSON.parse(row.response_json) as T
}

/** Guards are written with ?1.. placeholders; their binds follow the 8 insert binds. */
export const shiftGuard = (sql: string) => sql.replace(/\?(\d+)/g, (_, n) => `?${Number(n) + 8}`)

/** Insert statement that only records the command when `guardSql` (a SELECT 1 ...) holds. */
export function recordCommandStatement(
  database: D1Database,
  args: {
    commandId: string
    actorId: string
    scope: 'reorder' | 'scan' | 'cycle_count'
    action: string
    targetId: string
    payloadHash: string
    response: unknown
    now: string
    guardSql?: string
    guardBinds?: unknown[]
    /** Record only if the immediately preceding statement of the batch changed a row (CAS won). */
    afterChange?: boolean
  }
) {
  const base = `INSERT INTO inventory_planning_commands(command_id,actor_id,scope,action,target_id,payload_hash,response_json,created_at)`
  const binds = [
    args.commandId,
    args.actorId,
    args.scope,
    args.action,
    args.targetId,
    args.payloadHash,
    JSON.stringify(args.response),
    args.now
  ]
  if (args.afterChange)
    return database.prepare(`${base} SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE changes() > 0`).bind(...binds)
  if (!args.guardSql) return database.prepare(`${base} VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(...binds)
  return database
    .prepare(`${base} SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(${shiftGuard(args.guardSql)})`)
    .bind(...binds, ...(args.guardBinds ?? []))
}

/** Map SQLite aborts from guards/triggers/CHECKs to stable domain errors. */
export function mapPlanningDbError(cause: unknown): InventoryPlanningError {
  if (cause instanceof InventoryPlanningError) return cause
  const text = String((cause as Error)?.message ?? cause)
  if (
    /version_conflict|UNIQUE constraint failed: (inventory_purchase_suggestions|inventory_reorder_policies)/.test(text)
  )
    return new InventoryPlanningError('version_conflict')
  if (/UNIQUE constraint failed: inventory_planning_commands/.test(text))
    return new InventoryPlanningError('idempotency_conflict')
  if (/CHECK constraint failed: blocked_quantity|physical_quantity|insufficient/.test(text))
    return new InventoryPlanningError('insufficient_stock')
  return new InventoryPlanningError('service_unavailable')
}

/** Runs a mutation; on a command-id race re-reads the stored response instead of failing. */
export async function runIdempotent<T>(
  database: D1Database,
  args: { commandId: string; scope: string; payloadHash: string },
  execute: () => Promise<T>
): Promise<T> {
  const stored = await replayCommand<T>(database, args.commandId, args.scope, args.payloadHash)
  if (stored) return stored
  try {
    return await execute()
  } catch (cause) {
    const mapped = mapPlanningDbError(cause)
    if (mapped.code === 'idempotency_conflict' || mapped.code === 'version_conflict') {
      const winner = await replayCommand<T>(database, args.commandId, args.scope, args.payloadHash)
      if (winner) return winner
    }
    throw mapped
  }
}
