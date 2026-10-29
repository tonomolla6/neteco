import { ZodError } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { supportInstant, supportUuid } from '../../shared/support-operations'
import { safeRecordRolePermissionChangeSignal } from './security-anomalies'
import {
  adminInvitationCreateInputSchema,
  adminInvitationRevokeInputSchema,
  adminInvitationAcceptInputSchema,
  adminInvitationQuerySchema,
  adminInvitationSchema,
  adminInvitationListSchema,
  adminInvitationPreviewSchema,
  adminInvitationReceiptSchema,
  adminInvitationHashSchema,
  adminInvitationTokenHash,
  adminInvitationIntentHash,
  type AdminInvitation,
  type AdminInvitationList,
  type AdminInvitationReceipt,
  type AdminInvitationCommand,
  type AdminInvitationPreview
} from '../../shared/admin-invitations'

export class AdminInvitationError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'invitation_unavailable'
      | 'role_already_granted'
      | 'service_unavailable'
      | 'history_unconfirmed'
  ) {
    super(code)
  }
}
type Options = { now?: string }
type CommandOptions = Options & { idempotencyKey: string; ipHash?: string | null }
type Actor = { id: string; email: string; session_version: number }
type Ledger = {
  id: string
  actor_id: string
  actor_email: string
  action: 'create' | 'revoke' | 'accept'
  invitation_id: string
  payload_hash: string
  input_json: string
  receipt_json: string
  created_at: string
}
const clock = "COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const granted = (identity: string, permission: string) =>
  `EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions permitted ON permitted.role_code=assigned.role_code WHERE assigned.identity_id=${identity} AND permitted.permission_code=${permission} AND assigned.granted_at<=${clock} AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
const permissions = (role: string) =>
  `(SELECT json_group_array(permission_code) FROM(SELECT permission_code FROM role_permissions WHERE role_code=${role} ORDER BY permission_code))`
const delegable = (role: string, identity: string) =>
  `(SELECT count(*) FROM role_permissions WHERE role_code=${role}) BETWEEN 1 AND 100 AND NOT EXISTS(SELECT 1 FROM role_permissions target WHERE target.role_code=${role} AND NOT ${granted(identity, 'target.permission_code')})`
function authority(admin: boolean) {
  return `SELECT i.id,i.email,i.session_version FROM identities i JOIN auth_sessions s ON s.identity_id=i.id JOIN identity_mfa m ON m.identity_id=i.id
    WHERE s.id=?1 AND i.id=?2 AND s.session_version=?3 AND i.session_version=s.session_version AND i.status='active'
    AND s.revoked_at IS NULL AND s.created_at<=${clock} AND s.expires_at>${clock} AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock} AND s.mfa_verified=1
    AND m.verified_at IS NOT NULL AND m.verified_at<=${clock} ${admin ? `AND ${granted('i.id', "'administration.manage'")}` : "AND EXISTS(SELECT 1 FROM customers c WHERE c.id=i.customer_id AND c.status='active')"}`
}
const projection = `json_object('id',v.id,'recipientEmail',v.recipient_email,'roleCode',v.role_code,'version',v.version,'status',CASE WHEN v.status='pending' AND v.expires_at<=${clock} THEN 'expired' ELSE v.status END,'createdAt',v.created_at,'expiresAt',v.expires_at,'acceptedAt',v.accepted_at,'revokedAt',v.revoked_at)`
const issuer = `EXISTS(SELECT 1 FROM identities issuer JOIN identity_mfa mi ON mi.identity_id=issuer.id
  WHERE issuer.id=v.issuer_id AND issuer.status='active' AND issuer.session_version=v.issuer_session_version
  AND mi.verified_at IS NOT NULL AND mi.verified_at<=${clock}
  AND issuer.email_verified_at IS NOT NULL AND issuer.email_verified_at<=${clock} AND ${granted('issuer.id', "'administration.manage'")} AND ${delegable('v.role_code', 'issuer.id')}
  AND v.permissions_json=${permissions('v.role_code')})`
const eligible = `v.status='pending' AND v.created_at<=${clock} AND v.expires_at>${clock} AND v.recipient_id=a.id AND v.recipient_email=a.email AND ${issuer}`
function bind(claims: VerifiedSessionClaims, options: Options) {
  supportUuid.parse(claims?.sessionId)
  supportUuid.parse(claims?.identityId)
  if (!Number.isSafeInteger(claims.sessionVersion) || claims.sessionVersion < 1)
    throw new AdminInvitationError('unauthenticated')
  if (options.now !== undefined) supportInstant.parse(options.now)
  return [claims.sessionId, claims.identityId, claims.sessionVersion, options.now ?? null]
}
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AdminInvitationError) throw error
    if (error instanceof ZodError) throw new AdminInvitationError('invalid_input')
    throw new AdminInvitationError('service_unavailable')
  }
}
async function actor(db: D1Database, claims: VerifiedSessionClaims, admin: boolean, options: Options): Promise<Actor> {
  const row = await db
    .prepare(
      `SELECT i.id,i.email,i.session_version,i.email_verified_at,s.mfa_verified,m.verified_at AS enrollment,
    ${granted('i.id', "'administration.manage'")} AS granted_permission FROM identities i JOIN auth_sessions s ON s.identity_id=i.id LEFT JOIN identity_mfa m ON m.identity_id=i.id
    WHERE s.id=?1 AND i.id=?2 AND s.session_version=?3 AND i.session_version=s.session_version AND i.status='active'
    AND s.revoked_at IS NULL AND s.created_at<=${clock} AND s.expires_at>${clock}
    ${admin ? '' : "AND EXISTS(SELECT 1 FROM customers c WHERE c.id=i.customer_id AND c.status='active')"}`
    )
    .bind(...bind(claims, options))
    .first<
      Actor & {
        email_verified_at: string | null
        mfa_verified: number
        enrollment: string | null
        granted_permission: number
      }
    >()
  if (!row) throw new AdminInvitationError('unauthenticated')
  const now = options.now ?? nowUtc()
  if (!row.email_verified_at || row.email_verified_at > now) throw new AdminInvitationError('email_unverified')
  if (row.mfa_verified !== 1 || !row.enrollment || row.enrollment > now) throw new AdminInvitationError('mfa_required')
  if (admin && row.granted_permission !== 1) throw new AdminInvitationError('forbidden')
  return row
}
export async function authorizeD1AdminInvitationActor(
  db: D1Database,
  claims: VerifiedSessionClaims,
  admin: boolean,
  options: Options = {}
) {
  return attempt(async () => {
    await actor(guardedFiscalDatabase(db), claims, admin, options)
  })
}
async function release(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options: Options,
  row: Ledger,
  admin: boolean,
  acceptedNow = false
) {
  const receipt = adminInvitationReceiptSchema.parse(JSON.parse(row.receipt_json)),
    input: unknown = JSON.parse(row.input_json)
  const canonical = JSON.stringify({
    purpose: 'admin-invitation-v1',
    action: row.action,
    targetId: row.action === 'revoke' ? row.invitation_id : null,
    input
  })
  if (
    (await adminInvitationTokenHash(canonical)) !== row.payload_hash ||
    receipt.commandId !== row.id ||
    receipt.action !== row.action ||
    receipt.invitationId !== row.invitation_id ||
    receipt.recordedAt !== row.created_at ||
    receipt.payloadHash !== row.payload_hash ||
    receipt.sessionRevoked !== (row.action === 'accept')
  )
    throw new AdminInvitationError('history_unconfirmed')
  // Final SQL release follows all asynchronous hashing. The narrow exception is
  // only the exact old session/version revoked by this acceptance command.
  const sql = acceptedNow
    ? `SELECT 1 AS allowed FROM identities i JOIN auth_sessions s ON s.identity_id=i.id JOIN identity_mfa m ON m.identity_id=i.id JOIN admin_invitation_commands c ON c.actor_id=i.id JOIN admin_invitations v ON v.id=c.invitation_id
    WHERE i.id=?2 AND i.email=c.actor_email AND i.status='active' AND i.email_verified_at<=${clock} AND m.verified_at<=${clock} AND i.session_version=?3+1
    AND s.id=?1 AND s.session_version=?3 AND s.revoked_at=c.created_at AND c.id=?5 AND c.payload_hash=?6 AND c.receipt_json=?7
    AND v.status='accepted' AND v.command_id=c.id AND v.recipient_id=i.id AND v.recipient_email=i.email
    AND EXISTS(SELECT 1 FROM customers customer WHERE customer.id=i.customer_id AND customer.status='active')`
    : `WITH a AS MATERIALIZED(${authority(admin)}) SELECT 1 AS allowed FROM a JOIN admin_invitation_commands c ON c.actor_id=a.id AND c.actor_email=a.email WHERE c.id=?5 AND c.payload_hash=?6 AND c.receipt_json=?7`
  const allowed = await db
    .prepare(sql)
    .bind(...bind(claims, options), row.id, row.payload_hash, row.receipt_json)
    .first<{ allowed: number }>()
  if (allowed?.allowed !== 1) throw new AdminInvitationError('unauthenticated')
  return receipt
}
async function replay(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  admin: boolean,
  options: Options
) {
  const row = await db.prepare('SELECT * FROM admin_invitation_commands WHERE id=?').bind(key).first<Ledger>()
  if (!row) return null
  if (
    row.actor_id !== claims.identityId ||
    row.payload_hash !== hash ||
    (admin ? row.action === 'accept' : row.action !== 'accept')
  )
    throw new AdminInvitationError('idempotency_conflict')
  return release(db, claims, options, row, admin)
}
export async function readD1AdminInvitations(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: Options = {}
): Promise<AdminInvitationList> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      query = adminInvitationQuerySchema.parse(raw)
    await actor(db, claims, true, options)
    const row = await db
      .prepare(
        `WITH a AS MATERIALIZED(${authority(true)}), eligible_roles AS MATERIALIZED(
      SELECT r.code,${permissions('r.code')} AS permissions FROM roles r,a WHERE r.code IN('support','warehouse','catalog_editor','publisher','finance','admin') AND ${delegable('r.code', 'a.id')} ORDER BY r.code),
      page AS MATERIALIZED(SELECT ${projection} AS item FROM admin_invitations v WHERE EXISTS(SELECT 1 FROM a) ORDER BY v.created_at DESC,v.id DESC LIMIT ?5 OFFSET ?6)
      SELECT EXISTS(SELECT 1 FROM a) AS authorized,(SELECT count(*) FROM admin_invitations WHERE EXISTS(SELECT 1 FROM a)) AS total,
      (SELECT json_group_array(json(item)) FROM page) AS items,(SELECT json_group_array(json_object('code',code,'permissions',json(permissions))) FROM eligible_roles) AS roles`
      )
      .bind(...bind(claims, options), query.perPage, (query.page - 1) * query.perPage)
      .first<{ authorized: number; total: number; items: string; roles: string }>()
    if (row?.authorized !== 1) throw new AdminInvitationError('unauthenticated')
    return adminInvitationListSchema.parse({
      source: 'cloudflare',
      ...query,
      total: row.total,
      roles: JSON.parse(row.roles),
      items: JSON.parse(row.items)
    })
  })
}
export async function readD1AdminInvitation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  options: Options = {}
): Promise<AdminInvitation> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb)
    supportUuid.parse(id)
    await actor(db, claims, true, options)
    const row = await db
      .prepare(
        `WITH a AS MATERIALIZED(${authority(true)}) SELECT EXISTS(SELECT 1 FROM a) AS authorized,(SELECT ${projection} FROM admin_invitations v WHERE v.id=?5 AND EXISTS(SELECT 1 FROM a)) AS item`
      )
      .bind(...bind(claims, options), id)
      .first<{ authorized: number; item: string | null }>()
    if (row?.authorized !== 1) throw new AdminInvitationError('unauthenticated')
    if (!row.item) throw new AdminInvitationError('not_found')
    return adminInvitationSchema.parse(JSON.parse(row.item))
  })
}
async function eligibleInvitation(db: D1Database, claims: VerifiedSessionClaims, tokenHash: string, options: Options) {
  const row = await db
    .prepare(
      `WITH a AS MATERIALIZED(${authority(false)}) SELECT v.*,EXISTS(SELECT 1 FROM identity_roles old WHERE old.identity_id=a.id AND old.role_code=v.role_code) AS already_granted FROM admin_invitations v,a WHERE v.token_hash=?5 AND ${eligible}`
    )
    .bind(...bind(claims, options), tokenHash)
    .first<{
      id: string
      role_code: AdminInvitation['roleCode']
      permissions_json: string
      expires_at: string
      version: number
      already_granted: number
    }>()
  if (!row) throw new AdminInvitationError('invitation_unavailable')
  return row
}
export async function previewD1AdminInvitation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: Options = {}
): Promise<AdminInvitationPreview> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      input = adminInvitationAcceptInputSchema.parse(raw)
    await actor(db, claims, false, options)
    const row = await eligibleInvitation(db, claims, await adminInvitationTokenHash(input.token), options)
    if (row.already_granted) throw new AdminInvitationError('role_already_granted')
    return adminInvitationPreviewSchema.parse({
      source: 'cloudflare',
      invitationId: row.id,
      roleCode: row.role_code,
      permissions: JSON.parse(row.permissions_json),
      expiresAt: row.expires_at
    })
  })
}
async function persist(
  db: D1Database,
  claims: VerifiedSessionClaims,
  options: CommandOptions,
  receipt: AdminInvitationReceipt,
  input: unknown,
  reason: string,
  email: string,
  before: D1PreparedStatement[] = []
) {
  const serialized = JSON.stringify(receipt)
  await db.batch([
    ...before,
    db
      .prepare(
        `INSERT INTO admin_invitation_commands(id,actor_id,actor_session_id,actor_session_version,actor_email,action,invitation_id,payload_hash,input_json,reason,receipt_json,created_at)
      SELECT ?5,?2,?1,?3,?6,?7,?8,?9,?10,?11,?12,?13 FROM (${authority(receipt.action !== 'accept')}) a WHERE a.email=?6`
      )
      .bind(
        ...bind(claims, options),
        receipt.commandId,
        email,
        receipt.action,
        receipt.invitationId,
        receipt.payloadHash,
        JSON.stringify(input),
        reason,
        serialized,
        receipt.recordedAt
      ),
    db
      .prepare(
        'INSERT INTO admin_invitation_guards(id,passed) SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM admin_invitation_commands WHERE id=?1 AND actor_id=?2 AND invitation_id=?3 AND payload_hash=?4 AND receipt_json=?5) THEN 1 ELSE 0 END'
      )
      .bind(receipt.commandId, claims.identityId, receipt.invitationId, receipt.payloadHash, serialized),
    db.prepare('DELETE FROM admin_invitation_guards WHERE id=?').bind(receipt.commandId)
  ])
  const row = await db
    .prepare('SELECT * FROM admin_invitation_commands WHERE id=?')
    .bind(receipt.commandId)
    .first<Ledger>()
  if (!row) throw new AdminInvitationError('history_unconfirmed')
  const released = await release(db, claims, options, row, receipt.action !== 'accept', receipt.action === 'accept')
  // SEC-035: alert-only signal, derived from this exact committed command. Never blocks or fails the command.
  await safeRecordRolePermissionChangeSignal(db, {
    actorId: claims.identityId,
    sessionId: claims.sessionId,
    changeKind:
      receipt.action === 'create'
        ? 'admin_invitation_created'
        : receipt.action === 'accept'
          ? 'admin_invitation_accepted'
          : 'admin_invitation_revoked',
    sourceCommandId: receipt.commandId,
    invitationId: receipt.invitationId,
    roleCode: receipt.roleCode,
    ipHash: options.ipHash ?? null,
    occurredAt: receipt.recordedAt
  })
  return released
}
function isGuard(error: unknown) {
  let current = error
  for (let depth = 0; depth < 6 && current instanceof Error; depth++, current = current.cause)
    if (current.message.includes('admin_invitation_atomic_guard')) return true
  return false
}
export async function createD1AdminInvitation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
): Promise<AdminInvitationReceipt> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      input = adminInvitationCreateInputSchema.parse(raw)
    supportUuid.parse(options.idempotencyKey)
    const current = await actor(db, claims, true, options),
      hash = await adminInvitationIntentHash('create', null, input)
    const previous = await replay(db, claims, options.idempotencyKey, hash, true, options)
    if (previous) return previous
    const facts = await db
      .prepare(
        `WITH a AS MATERIALIZED(${authority(true)}) SELECT ${permissions('?5')} AS permissions,
      EXISTS(SELECT 1 FROM roles r,a WHERE r.code=?5 AND ${delegable('r.code', 'a.id')}) AS delegable,
      (SELECT id FROM identities WHERE email=?6 AND status='active' AND email_verified_at IS NOT NULL AND email_verified_at<=${clock} AND EXISTS(SELECT 1 FROM customers c WHERE c.id=identities.customer_id AND c.status='active')) AS recipient`
      )
      .bind(...bind(claims, options), input.roleCode, input.recipientEmail)
      .first<{ permissions: string; delegable: number; recipient: string | null }>()
    if (facts?.delegable !== 1) throw new AdminInvitationError('forbidden')
    if (!facts.recipient || facts.recipient === claims.identityId)
      throw new AdminInvitationError('invitation_unavailable')
    const fingerprint = await adminInvitationTokenHash(facts.permissions),
      now = options.now ?? nowUtc(),
      id = crypto.randomUUID()
    const expires = new Date(Date.parse(now) + input.expiresInHours * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const receipt = adminInvitationReceiptSchema.parse({
      source: 'cloudflare',
      commandId: options.idempotencyKey,
      action: 'create',
      invitationId: id,
      version: 1,
      payloadHash: hash,
      recordedAt: now,
      roleCode: input.roleCode,
      sessionRevoked: false
    })
    const insert = db
      .prepare(
        `INSERT INTO admin_invitations(id,issuer_id,issuer_session_id,issuer_session_version,recipient_id,recipient_email,role_code,permissions_json,permissions_hash,token_hash,version,status,created_at,expires_at,command_id)
      SELECT ?5,?2,?1,?3,recipient.id,?6,?7,?8,?9,?10,1,'pending',?11,?12,?13 FROM (${authority(true)}) a JOIN identities recipient ON recipient.id=?14
      WHERE recipient.email=?6 AND recipient.status='active' AND recipient.email_verified_at<=${clock} AND EXISTS(SELECT 1 FROM customers c WHERE c.id=recipient.customer_id AND c.status='active') AND ${delegable('?7', 'a.id')} AND ?8=${permissions('?7')}`
      )
      .bind(
        ...bind(claims, options),
        id,
        input.recipientEmail,
        input.roleCode,
        facts.permissions,
        fingerprint,
        input.tokenHash,
        now,
        expires,
        options.idempotencyKey,
        facts.recipient
      )
    try {
      return await persist(db, claims, options, receipt, input, input.reason, current.email, [insert])
    } catch (error) {
      const raced = await replay(db, claims, options.idempotencyKey, hash, true, options)
      if (raced) return raced
      if (isGuard(error)) throw new AdminInvitationError('invitation_unavailable')
      throw error
    }
  })
}
export async function revokeD1AdminInvitation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: unknown,
  options: CommandOptions
): Promise<AdminInvitationReceipt> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      input = adminInvitationRevokeInputSchema.parse(raw)
    supportUuid.parse(id)
    supportUuid.parse(options.idempotencyKey)
    const current = await actor(db, claims, true, options),
      hash = await adminInvitationIntentHash('revoke', id, input)
    const previous = await replay(db, claims, options.idempotencyKey, hash, true, options)
    if (previous) return previous
    const item = await readD1AdminInvitation(db, claims, id, options)
    if (item.version !== input.expectedVersion) throw new AdminInvitationError('version_conflict')
    if (item.status !== 'pending') throw new AdminInvitationError('invitation_unavailable')
    const receipt = adminInvitationReceiptSchema.parse({
      source: 'cloudflare',
      commandId: options.idempotencyKey,
      action: 'revoke',
      invitationId: id,
      version: input.expectedVersion + 1,
      payloadHash: hash,
      recordedAt: options.now ?? nowUtc(),
      roleCode: item.roleCode,
      sessionRevoked: false
    })
    try {
      return await persist(db, claims, options, receipt, input, input.reason, current.email)
    } catch (error) {
      const raced = await replay(db, claims, options.idempotencyKey, hash, true, options)
      if (raced) return raced
      if (isGuard(error)) throw new AdminInvitationError('version_conflict')
      throw error
    }
  })
}
export async function acceptD1AdminInvitation(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
): Promise<AdminInvitationReceipt> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      input = adminInvitationAcceptInputSchema.parse(raw)
    supportUuid.parse(options.idempotencyKey)
    const current = await actor(db, claims, false, options),
      hash = await adminInvitationIntentHash('accept', null, input)
    const previous = await replay(db, claims, options.idempotencyKey, hash, false, options)
    if (previous) return previous
    const tokenHash = await adminInvitationTokenHash(input.token),
      item = await eligibleInvitation(db, claims, tokenHash, options)
    if (item.already_granted) throw new AdminInvitationError('role_already_granted')
    const receipt = adminInvitationReceiptSchema.parse({
      source: 'cloudflare',
      commandId: options.idempotencyKey,
      action: 'accept',
      invitationId: item.id,
      version: item.version + 1,
      payloadHash: hash,
      recordedAt: options.now ?? nowUtc(),
      roleCode: item.role_code,
      sessionRevoked: true
    })
    try {
      return await persist(
        db,
        claims,
        options,
        receipt,
        { tokenHash },
        'Aceptación explícita de invitación administrativa.',
        current.email
      )
    } catch (error) {
      if (isGuard(error)) throw new AdminInvitationError('invitation_unavailable')
      throw error
    }
  })
}
export async function readD1AdminInvitationCommand(
  rawDb: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: Options & { audience: 'admin' | 'account' }
): Promise<AdminInvitationCommand> {
  return attempt(async () => {
    const db = guardedFiscalDatabase(rawDb),
      admin = options.audience === 'admin'
    supportUuid.parse(key)
    adminInvitationHashSchema.parse(hash)
    await actor(db, claims, admin, options)
    const row = await db.prepare('SELECT * FROM admin_invitation_commands WHERE id=?').bind(key).first<Ledger>()
    if (row) {
      if (row.actor_id !== claims.identityId || (admin ? row.action === 'accept' : row.action !== 'accept'))
        throw new AdminInvitationError('not_found')
      if (row.payload_hash !== hash) throw new AdminInvitationError('idempotency_conflict')
      return { source: 'cloudflare', outcome: 'applied', receipt: await release(db, claims, options, row, admin) }
    }
    const allowed = await db
      .prepare(`WITH a AS MATERIALIZED(${authority(admin)}) SELECT EXISTS(SELECT 1 FROM a) AS allowed`)
      .bind(...bind(claims, options))
      .first<{ allowed: number }>()
    if (allowed?.allowed !== 1) throw new AdminInvitationError('unauthenticated')
    return { source: 'cloudflare', outcome: 'unknown', receipt: null }
  })
}
