import { ZodError } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { authorizeD1AdminInvitationActor, AdminInvitationError } from '../auth/admin-invitations'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { supportUuid, supportInstant } from '../../shared/support-operations'
import {
  adminOrderViewCreateInputSchema,
  adminOrderViewUpdateInputSchema,
  adminOrderViewArchiveInputSchema,
  adminOrderViewSchema,
  adminOrderViewReceiptSchema,
  adminOrderViewHashSchema,
  adminOrderViewIntentHash,
  type AdminOrderView,
  type AdminOrderViewList,
  type AdminOrderViewDetail,
  type AdminOrderViewCommand
} from '../../shared/admin-order-views'
export type AdminOrderViewErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'view_archived'
  | 'limit_reached'
  | 'history_unconfirmed'
  | 'service_unavailable'
export class AdminOrderViewError extends Error {
  constructor(readonly code: AdminOrderViewErrorCode) {
    super(code)
  }
}
export type AdminOrderViewOptions = { now?: string }
export type AdminOrderViewCommandOptions = AdminOrderViewOptions & { idempotencyKey: string }
const clock = "COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const authority = `SELECT i.id FROM identities i JOIN auth_sessions s ON s.identity_id=i.id JOIN identity_mfa m ON m.identity_id=i.id WHERE s.id=?1 AND i.id=?2 AND s.session_version=?3 AND i.session_version=s.session_version AND i.status='active' AND s.revoked_at IS NULL AND s.created_at<=${clock} AND s.expires_at>${clock} AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock} AND s.mfa_verified=1 AND m.verified_at IS NOT NULL AND m.verified_at<=${clock} AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=${clock} AND (r.expires_at IS NULL OR r.expires_at>${clock}))`
function bind(claims: VerifiedSessionClaims, options: AdminOrderViewOptions) {
  supportUuid.parse(claims.identityId)
  supportUuid.parse(claims.sessionId)
  if (!Number.isSafeInteger(claims.sessionVersion) || claims.sessionVersion < 1)
    throw new AdminOrderViewError('unauthenticated')
  if (options.now !== undefined) supportInstant.parse(options.now)
  return [claims.sessionId, claims.identityId, claims.sessionVersion, options.now ?? null]
}
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AdminOrderViewError) throw error
    if (error instanceof AdminInvitationError) throw new AdminOrderViewError(error.code as AdminOrderViewErrorCode)
    if (error instanceof ZodError) throw new AdminOrderViewError('invalid_input')
    throw new AdminOrderViewError('service_unavailable')
  }
}
export async function authorizeD1AdminOrderViewActor(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AdminOrderViewOptions = {}
) {
  return attempt(async () => {
    if (!claims) throw new AdminOrderViewError('unauthenticated')
    await authorizeD1AdminInvitationActor(db, claims, true, options)
  })
}
type Row = {
  id: string
  owner_id: string
  name: string
  definition_json: string
  version: number
  archived: number
  created_at: string
  updated_at: string
  archived_at: string | null
  command_id: string
  receipt_json: string | null
  snapshot_json: string | null
}
function view(row: Row): AdminOrderView {
  try {
    const receipt = adminOrderViewReceiptSchema.parse(JSON.parse(row.receipt_json!)),
      snapshot = adminOrderViewCreateInputSchema.parse(JSON.parse(row.snapshot_json!))
    if (
      receipt.viewId !== row.id ||
      receipt.version !== row.version ||
      receipt.commandId !== row.command_id ||
      receipt.recordedAt !== row.updated_at ||
      snapshot.name !== row.name ||
      JSON.stringify(snapshot.definition) !== row.definition_json ||
      (receipt.action === 'archive') !== (row.archived === 1)
    )
      throw new Error('projection')
    return adminOrderViewSchema.parse({
      id: row.id,
      name: row.name,
      definition: JSON.parse(row.definition_json),
      version: row.version,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at
    })
  } catch {
    throw new AdminOrderViewError('history_unconfirmed')
  }
}
async function snapshot(db: D1Database, claims: VerifiedSessionClaims, options: AdminOrderViewOptions, id?: string) {
  const result = await db
    .prepare(
      `WITH a AS MATERIALIZED(${authority}) SELECT EXISTS(SELECT 1 FROM a) allowed,(SELECT json_group_array(json_object('id',v.id,'owner_id',v.owner_id,'name',v.name,'definition_json',v.definition_json,'version',v.version,'archived',v.archived,'created_at',v.created_at,'updated_at',v.updated_at,'archived_at',v.archived_at,'command_id',v.command_id,'receipt_json',c.receipt_json,'snapshot_json',c.snapshot_json)) FROM (SELECT * FROM admin_order_views WHERE owner_id=?2 AND ((?5 IS NULL AND archived=0) OR id=?5) AND EXISTS(SELECT 1 FROM a) ORDER BY updated_at DESC,id LIMIT 21) v LEFT JOIN admin_order_view_commands c ON c.id=v.command_id AND c.actor_id=v.owner_id AND c.view_id=v.id) items`
    )
    .bind(...bind(claims, options), id ?? null)
    .first<{ allowed: number; items: string }>()
  if (!result || result.allowed !== 1) throw new AdminOrderViewError('unauthenticated')
  const rows = JSON.parse(result.items) as Row[]
  if (rows.length > 20) throw new AdminOrderViewError('history_unconfirmed')
  return rows.map(view)
}
export async function readD1AdminOrderViews(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AdminOrderViewOptions = {}
): Promise<AdminOrderViewList> {
  return attempt(async () => {
    await authorizeD1AdminOrderViewActor(rawDb, claims, options)
    return { source: 'cloudflare', items: await snapshot(guardedFiscalDatabase(rawDb), claims!, options) }
  })
}
export async function readD1AdminOrderView(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: AdminOrderViewOptions = {}
): Promise<AdminOrderViewDetail> {
  return attempt(async () => {
    supportUuid.parse(id)
    await authorizeD1AdminOrderViewActor(rawDb, claims, options)
    const items = await snapshot(guardedFiscalDatabase(rawDb), claims!, options, id)
    if (!items[0]) throw new AdminOrderViewError('not_found')
    return { source: 'cloudflare', view: items[0] }
  })
}
type Ledger = {
  id: string
  actor_id: string
  action: 'create' | 'update' | 'archive'
  view_id: string
  expected_version: number
  payload_hash: string
  input_json: string
  receipt_json: string
  recorded_at: string
}
async function ledger(db: D1Database, claims: VerifiedSessionClaims, key: string) {
  const row = await db.prepare('SELECT * FROM admin_order_view_commands WHERE id=?').bind(key).first<Ledger>()
  if (row && row.actor_id !== claims.identityId) throw new AdminOrderViewError('not_found')
  return row
}
async function release(
  db: D1Database,
  claims: VerifiedSessionClaims,
  row: Ledger,
  hash: string,
  options: AdminOrderViewOptions
) {
  if (row.payload_hash !== hash) throw new AdminOrderViewError('idempotency_conflict')
  let receipt
  try {
    receipt = adminOrderViewReceiptSchema.parse(JSON.parse(row.receipt_json))
    const calculated = await adminOrderViewIntentHash(
      row.action,
      row.action === 'create' ? null : row.view_id,
      JSON.parse(row.input_json)
    )
    if (
      calculated !== hash ||
      receipt.commandId !== row.id ||
      receipt.action !== row.action ||
      receipt.viewId !== row.view_id ||
      receipt.payloadHash !== hash ||
      receipt.version !== row.expected_version + 1 ||
      receipt.recordedAt !== row.recorded_at
    )
      throw new Error('receipt')
  } catch {
    throw new AdminOrderViewError('history_unconfirmed')
  }
  const final = await db
    .prepare(
      `WITH a AS MATERIALIZED(${authority}) SELECT EXISTS(SELECT 1 FROM a) allowed,EXISTS(SELECT 1 FROM admin_order_view_commands c,a WHERE c.id=?5 AND c.actor_id=a.id AND c.payload_hash=?6 AND c.receipt_json=?7 AND c.input_json=?8) proven`
    )
    .bind(...bind(claims, options), row.id, hash, row.receipt_json, row.input_json)
    .first<{ allowed: number; proven: number }>()
  if (!final || final.allowed !== 1) throw new AdminOrderViewError('unauthenticated')
  if (final.proven !== 1) throw new AdminOrderViewError('history_unconfirmed')
  return receipt
}
export async function readD1AdminOrderViewCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  hash: string,
  options: AdminOrderViewOptions = {}
): Promise<AdminOrderViewCommand> {
  return attempt(async () => {
    supportUuid.parse(key)
    adminOrderViewHashSchema.parse(hash)
    await authorizeD1AdminOrderViewActor(rawDb, claims, options)
    const db = guardedFiscalDatabase(rawDb),
      row = await ledger(db, claims!, key)
    if (row)
      return { source: 'cloudflare', outcome: 'applied', receipt: await release(db, claims!, row, hash, options) }
    const final = await db
      .prepare(`SELECT EXISTS(${authority}) allowed`)
      .bind(...bind(claims!, options))
      .first<{ allowed: number }>()
    if (final?.allowed !== 1) throw new AdminOrderViewError('unauthenticated')
    return { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}
async function command(
  rawDb: D1Database,
  claims: VerifiedSessionClaims | null,
  action: 'create' | 'update' | 'archive',
  id: string | null,
  raw: unknown,
  options: AdminOrderViewCommandOptions
) {
  return attempt(async () => {
    const input =
      action === 'create'
        ? adminOrderViewCreateInputSchema.parse(raw)
        : action === 'update'
          ? adminOrderViewUpdateInputSchema.parse(raw)
          : adminOrderViewArchiveInputSchema.parse(raw)
    supportUuid.parse(options.idempotencyKey)
    if (id !== null) supportUuid.parse(id)
    await authorizeD1AdminOrderViewActor(rawDb, claims, options)
    const db = guardedFiscalDatabase(rawDb),
      hash = await adminOrderViewIntentHash(action, id, input),
      existing = await ledger(db, claims!, options.idempotencyKey)
    if (existing) return release(db, claims!, existing, hash, options)
    const current = id ? await readD1AdminOrderView(db, claims, id, options) : null
    const expected = 'expectedVersion' in input ? input.expectedVersion : 0
    if (current?.view.archived) throw new AdminOrderViewError('view_archived')
    if (current && current.view.version !== expected) throw new AdminOrderViewError('version_conflict')
    if (action === 'create' && (await readD1AdminOrderViews(db, claims, options)).items.length >= 20)
      throw new AdminOrderViewError('limit_reached')
    const snapshotInput =
      'name' in input
        ? { name: input.name, definition: input.definition }
        : { name: current!.view.name, definition: current!.view.definition }
    const viewId = id ?? crypto.randomUUID(),
      recordedAt = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      receipt = adminOrderViewReceiptSchema.parse({
        source: 'cloudflare',
        commandId: options.idempotencyKey,
        payloadHash: hash,
        action,
        viewId,
        version: expected + 1,
        recordedAt
      })
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO admin_order_view_commands(id,actor_id,session_id,session_version,action,view_id,expected_version,payload_hash,input_json,snapshot_json,receipt_json,recorded_at) SELECT ?5,?2,?1,?3,?6,?7,?8,?9,?10,?11,?12,?13 FROM (${authority})`
          )
          .bind(
            ...bind(claims!, options),
            options.idempotencyKey,
            action,
            viewId,
            expected,
            hash,
            JSON.stringify(input),
            JSON.stringify(snapshotInput),
            JSON.stringify(receipt),
            recordedAt
          )
      ])
    } catch (error) {
      await authorizeD1AdminOrderViewActor(db, claims, options)
      const replay = await ledger(db, claims!, options.idempotencyKey)
      if (replay) return release(db, claims!, replay, hash, options)
      if (id) {
        const latest = await readD1AdminOrderView(db, claims, id, options)
        if (latest.view.archived) throw new AdminOrderViewError('view_archived')
        if (latest.view.version !== expected) throw new AdminOrderViewError('version_conflict')
      } else if ((await readD1AdminOrderViews(db, claims, options)).items.length >= 20)
        throw new AdminOrderViewError('limit_reached')
      throw error
    }
    const applied = await ledger(db, claims!, options.idempotencyKey)
    if (!applied) {
      await authorizeD1AdminOrderViewActor(db, claims, options)
      throw new AdminOrderViewError('service_unavailable')
    }
    return release(db, claims!, applied, hash, options)
  })
}
export const createD1AdminOrderView = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown,
  options: AdminOrderViewCommandOptions
) => command(db, claims, 'create', null, input, options)
export const updateD1AdminOrderView = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  input: unknown,
  options: AdminOrderViewCommandOptions
) => command(db, claims, 'update', id, input, options)
export const archiveD1AdminOrderView = (
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  input: unknown,
  options: AdminOrderViewCommandOptions
) => command(db, claims, 'archive', id, input, options)
