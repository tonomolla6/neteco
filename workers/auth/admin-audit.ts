import { ZodError } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { authorizeD1AdminInvitationActor } from './admin-invitations'
import { supportInstant, supportUuid } from '../../shared/support-operations'
import { orderExportCsvCell } from '../../shared/order-export'
import {
  ADMIN_AUDIT_EXPORT_COLUMNS,
  ADMIN_AUDIT_EXPORT_MAX_BYTES,
  adminAuditQuerySchema,
  adminAuditFiltersSchema,
  adminAuditIdSchema,
  adminAuditHashSchema,
  adminAuditItemSchema,
  adminAuditChangeSchema,
  adminAuditListSchema,
  adminAuditDetailSchema,
  adminAuditReviewSchema,
  adminAuditReviewInputSchema,
  adminAuditExportInputSchema,
  adminAuditReceiptSchema,
  adminAuditIntentHash,
  adminAuditFilterHash,
  adminAuditHash,
  type AdminAuditItem,
  type AdminAuditCommand,
  type AdminAuditDetail,
  type AdminAuditList,
  type AdminAuditReceipt
} from '../../shared/admin-audit'
import { adminAuditSourcesCte, ADMIN_AUDIT_SOURCE_FAMILIES } from './admin-audit-sources'

export type AdminAuditErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'export_too_large'
  | 'history_unconfirmed'
  | 'service_unavailable'
export class AdminAuditError extends Error {
  constructor(readonly code: AdminAuditErrorCode) {
    super(code)
    this.name = 'AdminAuditError'
  }
}
export type AdminAuditOptions = { now?: string }
export type AdminAuditCommandOptions = AdminAuditOptions & { idempotencyKey: string; ipHash?: string | null }
const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const clock = "COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const authority = `SELECT 1 allowed FROM identities i JOIN auth_sessions s ON s.identity_id=i.id
 JOIN identity_mfa m ON m.identity_id=i.id WHERE s.id=?1 AND i.id=?2 AND s.session_version=?3
 AND i.session_version=s.session_version AND i.status='active' AND s.revoked_at IS NULL
 AND s.created_at<=${clock} AND s.expires_at>${clock} AND s.mfa_verified=1
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock} AND m.verified_at IS NOT NULL AND m.verified_at<=${clock}
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=${clock}
 AND (r.expires_at IS NULL OR r.expires_at>${clock}))`
function parameters(claims: VerifiedSessionClaims | null, options: AdminAuditOptions) {
  if (
    !claims ||
    !supportUuid.safeParse(claims.identityId).success ||
    !supportUuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    throw new AdminAuditError('unauthenticated')
  if (options.now !== undefined) supportInstant.parse(options.now)
  return [claims.sessionId, claims.identityId, claims.sessionVersion, options.now ?? null]
}
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AdminAuditError) throw error
    if (error instanceof ZodError) throw new AdminAuditError('invalid_input')
    throw new AdminAuditError('service_unavailable')
  }
}
export async function authorizeD1AdminAuditActor(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AdminAuditOptions = {}
) {
  return attempt(async () => {
    parameters(claims, options)
    try {
      await authorizeD1AdminInvitationActor(database, claims!, true, options)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null
      if (code === 'unauthenticated' || code === 'email_unverified' || code === 'mfa_required' || code === 'forbidden')
        throw new AdminAuditError(code)
      throw new AdminAuditError('service_unavailable')
    }
  })
}
type EventRow = AdminAuditItem & { changes: string; integrity?: number }
type Ledger = {
  id: string
  actor_id: string
  action: 'review' | 'export'
  event_id: string | null
  payload_hash: string
  input_json: string
  receipt_json: string
  csv: string | null
  expires_at: string | null
  created_at: string
}
const coverage = {
  families: ADMIN_AUDIT_SOURCE_FAMILIES,
  historicalNetworkMetadata: 'only_when_recorded' as const,
  excluded: [
    'customer_self_service',
    'automated_provider_events',
    'application_logs',
    'historical_unclassified_cancellation'
  ]
}
const eventColumns =
  'e.id,e.family,e.action,e.createdAt,e.actorId,e.resourceId,e.commandId,e.sessionId,e.ipHash,e.reason,e.before,e.after,e.changes,COALESCE(h.version,0) reviewVersion,h.disposition'
const heads = `review_heads AS (SELECT event_id,version,disposition,row_number() OVER(PARTITION BY event_id ORDER BY version DESC) ordinal
 FROM admin_audit_commands WHERE action='review' AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)<=?5)`
function filters(raw: unknown) {
  const value = adminAuditFiltersSchema.parse(raw)
  if (value.from && value.to && value.from > value.to) throw new AdminAuditError('invalid_input')
  return value
}
function encodeCursor(value: { v: 1; at: string; id: string; snapshot: string; filterHash: string }) {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function decodeCursor(raw: string | undefined, filterHash: string) {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/')))
    if (!value || typeof value !== 'object') throw new Error()
    const c = value as { v: 1; at: string; id: string; snapshot: string; filterHash: string }
    if (
      c.v !== 1 ||
      c.filterHash !== filterHash ||
      !adminAuditIdSchema.safeParse(c.id).success ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(c.at) ||
      !Number.isFinite(Date.parse(c.at)) ||
      !Number.isFinite(Date.parse(c.snapshot)) ||
      encodeCursor(c) !== raw
    )
      throw new Error()
    return c
  } catch {
    throw new AdminAuditError('invalid_input')
  }
}
function item(row: EventRow): AdminAuditItem {
  const parsed = adminAuditItemSchema.safeParse(
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'changes' && key !== 'integrity'))
  )
  if (!parsed.success) throw new AdminAuditError('history_unconfirmed')
  return parsed.data
}
async function rows(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  limit: number,
  options: AdminAuditOptions,
  cursorRaw?: string
) {
  const query = filters(raw),
    hash = await adminAuditFilterHash(query),
    cursor = decodeCursor(cursorRaw, hash)
  const snapshot = cursor?.snapshot ?? new Date(options.now ?? Date.now()).toISOString()
  const values = [
    ...parameters(claims, options),
    snapshot,
    query.family ?? null,
    query.actorId ?? null,
    query.resourceId ?? null,
    query.from ? new Date(query.from).toISOString() : null,
    query.to ? new Date(query.to).toISOString() : null,
    cursor?.at ?? null,
    cursor?.id ?? null,
    limit
  ]
  const scoped = `e.createdAt<=?5
     AND e.createdAt<=strftime('%Y-%m-%dT%H:%M:%fZ',${clock})
     AND (?6 IS NULL OR e.family=?6) AND (?7 IS NULL OR e.actorId=?7) AND (?8 IS NULL OR e.resourceId=?8)
     AND (?9 IS NULL OR e.createdAt>=?9) AND (?10 IS NULL OR e.createdAt<=?10)`
  const selected = `SELECT ${eventColumns} FROM scoped_events e
     LEFT JOIN review_heads h ON h.event_id=e.id AND h.ordinal=1
     WHERE (?11 IS NULL OR e.createdAt<?11 OR(e.createdAt=?11 AND e.id<?12))
     ORDER BY e.createdAt DESC,e.id DESC LIMIT ?13`
  // One bounded JSON aggregate preserves the 1001st overflow sentinel without
  // weakening the shared fiscal boundary's 1000-row evidence ceiling.
  const names = [
    'id',
    'family',
    'action',
    'createdAt',
    'actorId',
    'resourceId',
    'commandId',
    'sessionId',
    'ipHash',
    'reason',
    'before',
    'after',
    'changes',
    'reviewVersion',
    'disposition'
  ]
  const result = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `WITH ${adminAuditSourcesCte},${heads},scoped_events AS MATERIALIZED(SELECT * FROM audit_events e WHERE ${scoped})
        SELECT (SELECT json_group_array(json_object(${names.map((name) => `'${name}',"${name}"`).join(',')})) FROM (${selected})) AS records,
        EXISTS(SELECT 1 FROM scoped_events WHERE integrity<>1) AS hasGap`
      )
      .bind(...values),
    db.prepare(authority).bind(...parameters(claims, options))
  ])
  if (result[1]?.results?.[0]?.allowed !== 1) throw new AdminAuditError('unauthenticated')
  if (result[0]?.results?.[0]?.hasGap !== 0) throw new AdminAuditError('history_unconfirmed')
  const records: unknown = JSON.parse(String(result[0]?.results?.[0]?.records ?? 'null'))
  if (!Array.isArray(records) || records.length > limit) throw new AdminAuditError('history_unconfirmed')
  return { rows: records as EventRow[], snapshot, hash }
}
export async function readD1AdminAudit(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: AdminAuditOptions = {}
): Promise<AdminAuditList> {
  return attempt(async () => {
    const query = adminAuditQuerySchema.parse(raw),
      { limit, cursor, ...filter } = query,
      db = guardedFiscalDatabase(database)
    await authorizeD1AdminAuditActor(db, claims, options)
    const result = await rows(db, claims, filter, limit + 1, options, cursor),
      visible = result.rows.slice(0, limit),
      last = visible.at(-1)
    return adminAuditListSchema.parse({
      source: 'cloudflare',
      items: visible.map(item),
      nextCursor:
        result.rows.length > limit && last
          ? encodeCursor({ v: 1, at: last.createdAt, id: last.id, snapshot: result.snapshot, filterHash: result.hash })
          : null,
      evaluatedAt: options.now ?? utc(),
      coverage
    })
  })
}
export async function readD1AdminAuditDetail(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: AdminAuditOptions = {}
): Promise<AdminAuditDetail> {
  return attempt(async () => {
    adminAuditIdSchema.parse(id)
    const db = guardedFiscalDatabase(database)
    await authorizeD1AdminAuditActor(db, claims, options)
    const result = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `WITH ${adminAuditSourcesCte},${heads} SELECT ${eventColumns},e.integrity FROM audit_events e LEFT JOIN review_heads h ON h.event_id=e.id AND h.ordinal=1 WHERE e.id=?6 AND e.createdAt<=strftime('%Y-%m-%dT%H:%M:%fZ',${clock})`
        )
        .bind(...parameters(claims, options), new Date(options.now ?? Date.now()).toISOString(), id),
      db
        .prepare(
          "SELECT id commandId,actor_id actorId,version,disposition,created_at recordedAt,'redacted' reason FROM admin_audit_commands WHERE action='review' AND event_id=? ORDER BY version DESC LIMIT 101"
        )
        .bind(id),
      db.prepare(authority).bind(...parameters(claims, options))
    ])
    if (result[2]?.results?.[0]?.allowed !== 1) throw new AdminAuditError('unauthenticated')
    const record = result[0]?.results?.[0] as unknown as EventRow | undefined
    if (!record) throw new AdminAuditError('not_found')
    if (record.integrity !== 1) throw new AdminAuditError('history_unconfirmed')
    const reviews = result[1]?.results ?? []
    if (reviews.length > 100) throw new AdminAuditError('history_unconfirmed')
    const rawChanges: unknown = JSON.parse(record.changes),
      changes = Array.isArray(rawChanges) ? rawChanges.map((change) => adminAuditChangeSchema.safeParse(change)) : []
    return adminAuditDetailSchema.parse({
      source: 'cloudflare',
      item: item(record),
      changes: changes.flatMap((change) => (change.success ? [change.data] : [])),
      changesAvailability:
        changes.length === 0 ? 'unknown' : changes.every((change) => change.success) ? 'recorded' : 'redacted',
      reviews: reviews.map((review) => adminAuditReviewSchema.parse(review)),
      evaluatedAt: options.now ?? utc()
    })
  })
}
async function release(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  row: Ledger,
  options: AdminAuditOptions,
  download = false
) {
  const receipt = adminAuditReceiptSchema.parse(JSON.parse(row.receipt_json)),
    input: unknown = JSON.parse(row.input_json)
  const hash = await adminAuditIntentHash(row.action, row.event_id, input)
  if (
    hash !== row.payload_hash ||
    receipt.commandId !== row.id ||
    receipt.action !== row.action ||
    receipt.payloadHash !== row.payload_hash ||
    receipt.recordedAt !== row.created_at
  )
    throw new AdminAuditError('history_unconfirmed')
  if (receipt.action === 'review' && receipt.eventId !== row.event_id) throw new AdminAuditError('history_unconfirmed')
  if (receipt.action === 'export') {
    const expected = adminAuditExportInputSchema.parse(input)
    if (
      !row.csv ||
      (await adminAuditHash(row.csv)) !== receipt.digest ||
      new TextEncoder().encode(row.csv).byteLength !== receipt.bytes ||
      (await adminAuditFilterHash(expected.filters)) !== receipt.filterHash ||
      receipt.expiresAt !== row.expires_at
    )
      throw new AdminAuditError('history_unconfirmed')
  }
  const final = await db
    .prepare(
      `WITH actor AS MATERIALIZED(${authority}) SELECT c.id FROM actor JOIN admin_audit_commands c ON c.actor_id=?2 WHERE c.id=?5 AND c.payload_hash=?6 AND c.receipt_json=?7 ${download ? 'AND c.expires_at>' + clock : ''}`
    )
    .bind(...parameters(claims, options), row.id, row.payload_hash, row.receipt_json)
    .first()
  if (!final) {
    if (download && row.expires_at && row.expires_at <= (options.now ?? utc())) throw new AdminAuditError('not_found')
    throw new AdminAuditError('unauthenticated')
  }
  return receipt
}
async function replay(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  hash: string,
  options: AdminAuditOptions
) {
  const row = await db.prepare('SELECT * FROM admin_audit_commands WHERE id=?').bind(key).first<Ledger>()
  if (!row) return null
  if (row.actor_id !== claims?.identityId) throw new AdminAuditError('not_found')
  if (row.payload_hash !== hash) throw new AdminAuditError('idempotency_conflict')
  return release(db, claims, row, options)
}
async function commit(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown,
  receipt: AdminAuditReceipt,
  csv: string | null,
  options: AdminAuditCommandOptions
) {
  const body = JSON.stringify(input),
    json = JSON.stringify(receipt),
    event = receipt.action === 'review' ? receipt.eventId : null
  const expected = receipt.action === 'review' ? adminAuditReviewInputSchema.parse(input).expectedVersion : null
  if (new TextEncoder().encode(body + json + (csv ?? '')).byteLength > ADMIN_AUDIT_EXPORT_MAX_BYTES)
    throw new AdminAuditError('export_too_large')
  const values = [
    ...parameters(claims, options),
    receipt.commandId,
    options.ipHash ?? null,
    receipt.action,
    event,
    receipt.payloadHash,
    body,
    expected,
    receipt.action === 'review' ? receipt.version : null,
    receipt.action === 'review' ? receipt.disposition : null,
    json,
    csv,
    receipt.action === 'export' ? receipt.expiresAt : null,
    receipt.recordedAt
  ]
  try {
    await db.batch([
      db
        .prepare(
          `WITH ${adminAuditSourcesCte},actor AS MATERIALIZED(${authority}) INSERT INTO admin_audit_commands(id,actor_id,session_id,session_version,ip_hash,action,event_id,payload_hash,input_json,expected_version,version,disposition,receipt_json,csv,expires_at,created_at)
       SELECT ?5,?2,?1,?3,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17 FROM actor
       WHERE (?7='export' OR EXISTS(SELECT 1 FROM audit_events e WHERE e.id=?8 AND e.integrity=1 AND e.createdAt<=strftime('%Y-%m-%dT%H:%M:%fZ',${clock})))`
        )
        .bind(...values),
      db
        .prepare(
          `WITH actor AS MATERIALIZED(${authority}) INSERT INTO admin_audit_guards(id,passed) SELECT ?5,CASE WHEN EXISTS(SELECT 1 FROM actor JOIN admin_audit_commands c ON c.actor_id=?2 WHERE c.id=?5 AND c.session_id=?1 AND c.session_version=?3 AND c.action=?6 AND c.event_id IS ?7 AND c.payload_hash=?8 AND c.input_json=?9 AND c.receipt_json=?10) THEN 1 ELSE 0 END`
        )
        .bind(
          ...parameters(claims, options),
          receipt.commandId,
          receipt.action,
          event,
          receipt.payloadHash,
          body,
          json
        ),
      db.prepare('DELETE FROM admin_audit_guards WHERE id=?').bind(receipt.commandId)
    ])
  } catch {
    await authorizeD1AdminAuditActor(db, claims, options)
    const raced = await replay(db, claims, receipt.commandId, receipt.payloadHash, options)
    if (raced) return raced
    if (receipt.action === 'review') {
      const current = await readD1AdminAuditDetail(db, claims, event!, options)
      if (current.item.reviewVersion !== expected) throw new AdminAuditError('version_conflict')
    }
    throw new AdminAuditError('service_unavailable')
  }
  const row = await db.prepare('SELECT * FROM admin_audit_commands WHERE id=?').bind(receipt.commandId).first<Ledger>()
  if (!row) throw new AdminAuditError('service_unavailable')
  return release(db, claims, row, options)
}
export async function reviewD1AdminAudit(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  options: AdminAuditCommandOptions
): Promise<AdminAuditReceipt> {
  return attempt(async () => {
    const input = adminAuditReviewInputSchema.parse(raw),
      db = guardedFiscalDatabase(database)
    adminAuditIdSchema.parse(id)
    supportUuid.parse(options.idempotencyKey)
    if (options.ipHash != null) adminAuditHashSchema.parse(options.ipHash)
    await authorizeD1AdminAuditActor(db, claims, options)
    const hash = await adminAuditIntentHash('review', id, input),
      previous = await replay(db, claims, options.idempotencyKey, hash, options)
    if (previous) return previous
    const detail = await readD1AdminAuditDetail(db, claims, id, options)
    if (detail.item.reviewVersion !== input.expectedVersion) throw new AdminAuditError('version_conflict')
    return commit(
      db,
      claims,
      input,
      {
        source: 'cloudflare',
        action: 'review',
        commandId: options.idempotencyKey,
        eventId: id,
        version: input.expectedVersion + 1,
        disposition: input.disposition,
        payloadHash: hash,
        recordedAt: options.now ?? utc()
      },
      null,
      options
    )
  })
}
export async function exportD1AdminAudit(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  options: AdminAuditCommandOptions
): Promise<AdminAuditReceipt> {
  return attempt(async () => {
    const input = adminAuditExportInputSchema.parse(raw),
      db = guardedFiscalDatabase(database)
    supportUuid.parse(options.idempotencyKey)
    if (options.ipHash != null) adminAuditHashSchema.parse(options.ipHash)
    await authorizeD1AdminAuditActor(db, claims, options)
    const hash = await adminAuditIntentHash('export', null, input),
      previous = await replay(db, claims, options.idempotencyKey, hash, options)
    if (previous) return previous
    const result = await rows(db, claims, input.filters, 1001, options)
    if (result.rows.length > 1000) throw new AdminAuditError('export_too_large')
    const safe = result.rows.map(item)
    const csv =
      '\uFEFF' +
      ADMIN_AUDIT_EXPORT_COLUMNS.join(',') +
      '\r\n' +
      safe
        .map((row) => ADMIN_AUDIT_EXPORT_COLUMNS.map((column) => orderExportCsvCell(row[column] ?? '')).join(','))
        .join('\r\n') +
      (safe.length ? '\r\n' : '')
    const bytes = new TextEncoder().encode(csv).byteLength
    if (bytes > ADMIN_AUDIT_EXPORT_MAX_BYTES) throw new AdminAuditError('export_too_large')
    const digest = await adminAuditHash(csv),
      filterHash = await adminAuditFilterHash(input.filters),
      recordedAt = options.now ?? utc(),
      expiresAt = new Date(Date.parse(recordedAt) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return commit(
      db,
      claims,
      input,
      {
        source: 'cloudflare',
        action: 'export',
        commandId: options.idempotencyKey,
        payloadHash: hash,
        recordedAt,
        rows: safe.length,
        bytes,
        digest,
        filterHash,
        expiresAt
      },
      csv,
      options
    )
  })
}
export async function readD1AdminAuditCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  hash: string,
  options: AdminAuditOptions = {}
): Promise<AdminAuditCommand> {
  return attempt(async () => {
    supportUuid.parse(key)
    adminAuditHashSchema.parse(hash)
    const db = guardedFiscalDatabase(database)
    await authorizeD1AdminAuditActor(db, claims, options)
    const previous = await replay(db, claims, key, hash, options)
    if (previous) return { source: 'cloudflare', outcome: 'applied', receipt: previous }
    if (
      !(await db
        .prepare(authority)
        .bind(...parameters(claims, options))
        .first())
    )
      throw new AdminAuditError('unauthenticated')
    return { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}
export async function downloadD1AdminAuditExport(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  options: AdminAuditOptions = {}
): Promise<{ csv: string; receipt: Extract<AdminAuditReceipt, { action: 'export' }> }> {
  return attempt(async () => {
    supportUuid.parse(key)
    const db = guardedFiscalDatabase(database)
    await authorizeD1AdminAuditActor(db, claims, options)
    const row = await db
      .prepare("SELECT * FROM admin_audit_commands WHERE id=? AND actor_id=? AND action='export'")
      .bind(key, claims!.identityId)
      .first<Ledger>()
    if (!row) throw new AdminAuditError('not_found')
    const receipt = await release(db, claims, row, options, true)
    if (receipt.action !== 'export' || row.csv === null) throw new AdminAuditError('history_unconfirmed')
    return { csv: row.csv, receipt }
  })
}
