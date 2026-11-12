import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'

/** Shared plumbing for SHP-027/028/030 modules: stable errors, hashing, live authorisation, HTTP helpers. */
export type ShippingOpsErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'unknown_profile'
  | 'unpackable'
  | 'no_active_boxes'
  | 'too_many_units'
  | 'too_many_parcels'
  | 'plan_stale'
  | 'validation_out_of_tolerance'
  | 'carrier_unavailable'
  | 'nothing_to_manifest'
  | 'manifest_not_open'
  | 'manifest_not_closed'
  | 'payload_too_large'
  | 'conflict'
  | 'internal'

export class ShippingOpsError extends Error {
  constructor(
    readonly code: ShippingOpsErrorCode,
    readonly details: Record<string, unknown> = {}
  ) {
    super(code)
    this.name = 'ShippingOpsError'
  }
}

const STATUS: Record<ShippingOpsErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  conflict: 409,
  manifest_not_open: 409,
  manifest_not_closed: 409,
  nothing_to_manifest: 409,
  plan_stale: 409,
  payload_too_large: 413,
  unknown_profile: 422,
  unpackable: 422,
  no_active_boxes: 422,
  too_many_units: 422,
  too_many_parcels: 422,
  validation_out_of_tolerance: 422,
  carrier_unavailable: 502,
  internal: 500
}

export function nowIso(now?: string): string {
  return now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
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

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hashPayload(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value))
}

export async function firstRow<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...params)
      .first<T>()) ?? null
  )
}

export async function allRows<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<T>()
  return (result.results ?? []) as T[]
}

/** SQL predicate (one bound identity id at ?N) that is true only for a live admin identity. */
export const liveAdminSql = (param: string) =>
  `EXISTS(SELECT 1 FROM identities i JOIN identity_roles ir ON ir.identity_id = i.id
     JOIN role_permissions rp ON rp.role_code = ir.role_code
     WHERE i.id = ${param} AND i.status = 'active' AND rp.permission_code = 'administration.manage'
       AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`

/** Live driver predicate: active identity linked to an active driver row. */
export const liveDriverSql = (identityParam: string, driverParam: string) =>
  `EXISTS(SELECT 1 FROM delivery_drivers d JOIN identities i ON i.id = d.identity_id
     WHERE d.id = ${driverParam} AND d.identity_id = ${identityParam} AND d.status = 'active' AND i.status = 'active')`

export async function requireAdmin(db: D1Database, identityId: string): Promise<void> {
  const row = await firstRow<{ ok: number }>(db, `SELECT ${liveAdminSql('?1')} AS ok`, identityId)
  if (!row?.ok) throw new ShippingOpsError('forbidden')
}

export interface OpsActor {
  identityId: string
  sessionId?: string
  sessionVersion?: number
}

export interface OpsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  sessionProvider?: (request: Request) => Promise<OpsActor | null>
  now?: () => string
}

export async function resolveActor(request: Request, deps: OpsHttpDependencies): Promise<OpsActor | null> {
  if (deps.sessionProvider) return deps.sessionProvider(request)
  if (!deps.sessionCookieConfiguration) return null
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null
  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const live = await firstRow<{ ok: number }>(
    deps.database,
    `SELECT 1 AS ok FROM identities i JOIN auth_sessions s ON s.identity_id = i.id
     WHERE i.id = ?1 AND i.status = 'active' AND i.session_version = ?2
       AND s.id = ?3 AND s.session_version = i.session_version AND s.revoked_at IS NULL
       AND s.created_at <= ?4 AND s.expires_at > ?4`,
    claims.identityId,
    claims.sessionVersion,
    claims.sessionId,
    now
  )
  return live
    ? { identityId: claims.identityId, sessionId: claims.sessionId, sessionVersion: claims.sessionVersion }
    : null
}

/** The injected provider is a test seam; production supplies a verified cookie. */
export async function checkOpsAdmin(actor: OpsActor, deps: OpsHttpDependencies): Promise<Response | null> {
  if (deps.sessionProvider) return null
  if (!actor.sessionId || typeof actor.sessionVersion !== 'number')
    return opsJson({ error: { code: 'unauthorized' } }, 401)
  try {
    const auth = await authorizeD1Session(
      deps.database,
      { identityId: actor.identityId, sessionId: actor.sessionId, sessionVersion: actor.sessionVersion },
      'administration.manage',
      { now: deps.now?.(), requireMfa: true }
    )
    if (!auth.allowed)
      return opsJson(
        { error: { code: auth.code === 'unauthenticated' ? 'unauthorized' : 'forbidden' } },
        auth.code === 'unauthenticated' ? 401 : 403
      )
    return null
  } catch {
    return opsJson({ error: { code: 'service_unavailable' } }, 503)
  }
}

export function opsJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Cookie'
    }
  })
}

export function opsError(error: unknown): Response {
  if (error instanceof ShippingOpsError) {
    const body: { code: string; details?: Record<string, unknown> } = { code: error.code }
    if (Object.keys(error.details).length) body.details = error.details
    return opsJson({ error: body }, STATUS[error.code])
  }
  return opsJson({ error: { code: 'internal' } }, 500)
}

export const methodNotAllowed = () => opsJson({ error: { code: 'method_not_allowed' } }, 405)

export async function readJson(request: Request, maxBytes = 262144): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new ShippingOpsError('payload_too_large')
  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxBytes) throw new ShippingOpsError('payload_too_large')
  try {
    return JSON.parse(text)
  } catch {
    throw new ShippingOpsError('invalid_input')
  }
}

export function randomId(): string {
  return globalThis.crypto.randomUUID()
}

export interface BatchGuards {
  /** Aborts the whole batch unless the previous statement changed exactly one row. */
  expectOne(): D1PreparedStatement
  /** Aborts the whole batch unless the SQL boolean expression is true. */
  check(expression: string, ...params: unknown[]): D1PreparedStatement
}

/**
 * Atomic D1 batch with abort guards: a failed guard violates shipping_ops_guards.satisfied = 1 and rolls
 * back every statement of the batch. Guard rows are removed in the same batch when it succeeds.
 */
export async function atomicBatch(db: D1Database, build: (guards: BatchGuards) => D1PreparedStatement[]) {
  const batchId = randomId()
  let n = 0
  const nextId = () => `${batchId}:${n++}`
  const guards: BatchGuards = {
    expectOne: () =>
      db
        .prepare(`INSERT INTO shipping_ops_guards(id, satisfied) SELECT ?1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END`)
        .bind(nextId()),
    check: (expression, ...params) =>
      db
        .prepare(
          `INSERT INTO shipping_ops_guards(id, satisfied) SELECT ?1, CASE WHEN (${expression}) THEN 1 ELSE 0 END`
        )
        .bind(nextId(), ...params)
  }
  const statements = build(guards)
  await db.batch([
    ...statements,
    db.prepare(`DELETE FROM shipping_ops_guards WHERE substr(id, 1, 36) = ?1`).bind(batchId)
  ])
}

/** Runs one mutation that must change exactly one row, followed by dependent statements. */
export async function guardedWrite(db: D1Database, mutation: D1PreparedStatement, after: D1PreparedStatement[] = []) {
  await atomicBatch(db, (g) => [mutation, g.expectOne(), ...after])
}
