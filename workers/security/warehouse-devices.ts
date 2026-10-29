import {
  POSTURE_MAX_AGE_SECONDS,
  deviceTransitionInputSchema,
  deviceWipeConfirmSchema,
  deviceWipeInputSchema,
  devicePostureSchema,
  enrollDeviceInputSchema,
  evaluatePosture,
  isSharedAccountEmail,
  type DevicePosture,
  type DeviceStatus,
  type PostureViolation
} from '../../shared/security-warehouse-devices'
import { z } from 'zod'
import {
  SecurityControlError,
  adminExistsSql,
  isUniqueViolation,
  parseInput,
  payloadHash,
  plusSeconds,
  requireAdmin,
  type CommandRow
} from './controls-common'

export interface DeviceView {
  id: string
  label: string
  kind: string
  platform: string
  assignedIdentityId: string
  status: DeviceStatus
  diskEncrypted: boolean | null
  screenLockEnabled: boolean | null
  passcodeLength: number | null
  jailbroken: boolean | null
  lastPostureAt: string | null
  lastSeenAt: string | null
  wipeRequestedAt: string | null
  wipeConfirmedAt: string | null
  offlineKeyVersion: number
  version: number
  createdAt: string
  updatedAt: string
}

interface DeviceRow {
  id: string
  label: string
  kind: string
  platform: string
  assigned_identity_id: string
  status: DeviceStatus
  disk_encrypted: number | null
  screen_lock_enabled: number | null
  passcode_length: number | null
  jailbroken: number | null
  last_posture_at: string | null
  last_seen_at: string | null
  wipe_requested_at: string | null
  wipe_confirmed_at: string | null
  offline_key_version: number
  version: number
  created_at: string
  updated_at: string
}

const DEVICE_SELECT = `SELECT d.*, p.last_seen_at FROM warehouse_devices d LEFT JOIN warehouse_device_presence p ON p.device_id=d.id`
const bool = (value: number | null) => (value === null ? null : value === 1)

function toView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    platform: row.platform,
    assignedIdentityId: row.assigned_identity_id,
    status: row.status,
    diskEncrypted: bool(row.disk_encrypted),
    screenLockEnabled: bool(row.screen_lock_enabled),
    passcodeLength: row.passcode_length,
    jailbroken: bool(row.jailbroken),
    lastPostureAt: row.last_posture_at,
    lastSeenAt: row.last_seen_at,
    wipeRequestedAt: row.wipe_requested_at,
    wipeConfirmedAt: row.wipe_confirmed_at,
    offlineKeyVersion: row.offline_key_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function statement(database: D1Database, sql: string, params: unknown[]) {
  const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))
  return database.prepare(sql).bind(...params.slice(0, highest))
}

async function readRow(database: D1Database, id: string): Promise<DeviceRow | null> {
  return database.prepare(`${DEVICE_SELECT} WHERE d.id=?1`).bind(id).first<DeviceRow>()
}

async function readCommand(database: D1Database, commandId: string) {
  return database
    .prepare(`SELECT command_id, kind, payload_hash, device_id FROM warehouse_device_commands WHERE command_id=?1`)
    .bind(commandId)
    .first<CommandRow>()
}

async function view(database: D1Database, id: string): Promise<DeviceView> {
  const row = await readRow(database, id)
  if (!row) throw new SecurityControlError('device_not_found', 404)
  return toView(row)
}

function replayOrConflict(command: CommandRow | null, hash: string): CommandRow | null {
  if (command && command.payload_hash !== hash) throw new SecurityControlError('idempotency_conflict', 409)
  return command
}

const STATUS_ERROR: Partial<Record<DeviceStatus, string>> = {
  pending_enrollment: 'device_not_active',
  locked: 'device_locked',
  lost: 'device_lost',
  wipe_pending: 'device_wipe_pending',
  wiped: 'device_wiped',
  retired: 'device_retired'
}

function storedPosture(row: DeviceRow): { compliant: boolean; violations: PostureViolation[] } {
  if (
    row.disk_encrypted === null ||
    row.screen_lock_enabled === null ||
    row.passcode_length === null ||
    row.jailbroken === null
  ) {
    return { compliant: false, violations: ['disk_not_encrypted'] }
  }
  return evaluatePosture({
    diskEncrypted: row.disk_encrypted === 1,
    screenLockEnabled: row.screen_lock_enabled === 1,
    passcodeLength: row.passcode_length,
    jailbroken: row.jailbroken === 1
  })
}

function postureIsStale(row: DeviceRow, now: string): boolean {
  return !row.last_posture_at || plusSeconds(row.last_posture_at, POSTURE_MAX_AGE_SECONDS) < now
}

export interface DeviceAdminContext {
  actorIdentityId: string
  now: string
}

export async function enrollDevice(
  database: D1Database,
  rawInput: unknown,
  context: DeviceAdminContext
): Promise<{ device: DeviceView; replayed: boolean }> {
  const input = parseInput(enrollDeviceInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const hash = await payloadHash('enroll', input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) return { device: await view(database, replay.device_id!), replayed: true }

  const identity = await database
    .prepare(`SELECT email, status FROM identities WHERE id=?1`)
    .bind(input.assignedIdentityId)
    .first<{ email: string; status: string }>()
  if (!identity) throw new SecurityControlError('identity_not_found', 404)
  if (identity.status !== 'active') throw new SecurityControlError('identity_not_active', 409)
  if (isSharedAccountEmail(identity.email)) throw new SecurityControlError('shared_account_rejected', 422)

  const id = crypto.randomUUID()
  const params = [
    id, // 1
    input.label, // 2
    input.kind, // 3
    input.platform, // 4
    input.assignedIdentityId, // 5
    context.actorIdentityId, // 6
    context.now, // 7
    crypto.randomUUID(), // 8 audit
    JSON.stringify({ kind: input.kind, platform: input.platform }), // 9
    input.commandId, // 10
    hash // 11
  ]
  try {
    await database.batch([
      statement(
        database,
        `INSERT INTO warehouse_devices(id, label, kind, platform, assigned_identity_id, status, offline_key_version, version, created_by, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'pending_enrollment', 1, 1, ?6, ?7, ?7
         WHERE ${adminExistsSql('?6', '?7')} AND EXISTS(SELECT 1 FROM identities WHERE id=?5 AND status='active')`,
        params
      ),
      statement(
        database,
        `INSERT INTO warehouse_device_audit(id, device_id, actor_identity_id, action, detail_json, created_at)
         SELECT ?8, ?1, ?6, 'enrolled', ?9, ?7 WHERE EXISTS(SELECT 1 FROM warehouse_devices WHERE id=?1)`,
        params
      ),
      statement(
        database,
        `INSERT INTO warehouse_device_commands(command_id, kind, payload_hash, device_id, created_at)
         SELECT ?10, 'enroll', ?11, ?1, ?7 WHERE EXISTS(SELECT 1 FROM warehouse_devices WHERE id=?1)`,
        params
      )
    ])
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await readCommand(database, input.commandId)
    if (raced) return { device: await view(database, raced.device_id!), replayed: true }
    throw new SecurityControlError('identity_already_has_device', 409)
  }
  if (!(await readCommand(database, input.commandId))) {
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('identity_not_active', 409)
  }
  return { device: await view(database, id), replayed: false }
}

export async function reportDevicePosture(
  database: D1Database,
  rawInput: { deviceId: string; posture: DevicePosture },
  context: DeviceAdminContext
): Promise<{ device: DeviceView; compliant: boolean; violations: PostureViolation[] }> {
  const deviceId = parseInput(z.string().uuid(), rawInput.deviceId)
  const posture = parseInput(devicePostureSchema, rawInput.posture)
  const { compliant, violations } = evaluatePosture(posture)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readRow(database, deviceId)
    if (!row) throw new SecurityControlError('device_not_found', 404)
    if (row.assigned_identity_id !== context.actorIdentityId) throw new SecurityControlError('device_not_assigned', 403)
    const owner = await database
      .prepare(`SELECT status FROM identities WHERE id=?1`)
      .bind(context.actorIdentityId)
      .first<{ status: string }>()
    if (owner?.status !== 'active') throw new SecurityControlError('identity_not_active', 403)
    if (!['pending_enrollment', 'active', 'locked'].includes(row.status)) {
      throw new SecurityControlError(STATUS_ERROR[row.status] ?? 'device_not_active', 409)
    }
    const next: DeviceStatus =
      row.status === 'pending_enrollment' && compliant
        ? 'active'
        : row.status === 'active' && !compliant
          ? 'locked'
          : row.status
    const autoLocked = row.status === 'active' && next === 'locked'
    const params = [
      deviceId, // 1
      row.version, // 2
      context.now, // 3
      context.actorIdentityId, // 4
      posture.diskEncrypted ? 1 : 0, // 5
      posture.screenLockEnabled ? 1 : 0, // 6
      posture.passcodeLength, // 7
      posture.jailbroken ? 1 : 0, // 8
      next, // 9
      row.status, // 10
      crypto.randomUUID(), // 11 audit
      JSON.stringify({ compliant, violations, from: row.status, to: next }), // 12
      crypto.randomUUID(), // 13 audit auto-lock
      JSON.stringify({ violations }) // 14
    ]
    await database.batch([
      statement(
        database,
        `UPDATE warehouse_devices SET disk_encrypted=?5, screen_lock_enabled=?6, passcode_length=?7, jailbroken=?8,
           last_posture_at=?3, status=?9, version=version+1, updated_at=?3
         WHERE id=?1 AND version=?2 AND status=?10 AND assigned_identity_id=?4`,
        params
      ),
      statement(
        database,
        `INSERT INTO warehouse_device_audit(id, device_id, actor_identity_id, action, detail_json, created_at)
         SELECT ?11, ?1, ?4, 'posture_reported', ?12, ?3 WHERE EXISTS(SELECT 1 FROM warehouse_devices WHERE id=?1 AND version=?2+1)`,
        params
      ),
      ...(autoLocked
        ? [
            statement(
              database,
              `INSERT INTO warehouse_device_audit(id, device_id, actor_identity_id, action, detail_json, created_at)
               SELECT ?13, ?1, ?4, 'auto_locked_noncompliant', ?14, ?3 WHERE EXISTS(SELECT 1 FROM warehouse_devices WHERE id=?1 AND version=?2+1)`,
              params
            )
          ]
        : [])
    ])
    const written = await view(database, deviceId)
    if (written.version === row.version + 1) return { device: written, compliant, violations }
  }
  throw new SecurityControlError('version_conflict', 409)
}

export type DeviceAccessResult = { ok: true; device: DeviceView } | { ok: false; code: string }

/** Live decision for every device-bound operation: titular, status, posture freshness and compliance. */
export async function authorizeDeviceAccess(
  database: D1Database,
  request: { deviceId: string; identityId: string },
  context: { now: string }
): Promise<DeviceAccessResult> {
  const row = await readRow(database, request.deviceId)
  if (!row) return { ok: false, code: 'device_not_found' }
  if (row.assigned_identity_id !== request.identityId) return { ok: false, code: 'device_not_assigned' }
  const owner = await database
    .prepare(`SELECT status FROM identities WHERE id=?1`)
    .bind(request.identityId)
    .first<{ status: string }>()
  if (owner?.status !== 'active') return { ok: false, code: 'identity_not_active' }
  if (row.status !== 'active') return { ok: false, code: STATUS_ERROR[row.status] ?? 'device_not_active' }
  if (postureIsStale(row, context.now)) return { ok: false, code: 'posture_stale' }
  if (!storedPosture(row).compliant) return { ok: false, code: 'posture_non_compliant' }
  return { ok: true, device: toView(row) }
}

interface TransitionSpec {
  kind: 'lock' | 'unlock' | 'lost' | 'wipe' | 'wipe_confirm' | 'retire'
  schema: z.ZodType<{ commandId: string; deviceId: string; expectedVersion?: number; reason?: string }>
  from: DeviceStatus[]
  to: DeviceStatus
  action: string
  /** 'admin' = administration.manage; 'admin_or_assignee' = either; 'assignee' = the titular only. */
  actor: 'admin' | 'admin_or_assignee' | 'assignee'
  bumpOfflineKey?: boolean
  setWipeRequested?: boolean
  setWipeConfirmed?: boolean
  requireCompliantPosture?: boolean
}

async function transition(
  database: D1Database,
  spec: TransitionSpec,
  rawInput: unknown,
  context: DeviceAdminContext
): Promise<{ device: DeviceView; replayed: boolean }> {
  const input = parseInput(spec.schema, rawInput)
  const isAdmin = await database
    .prepare(`SELECT ${adminExistsSql('?1', '?2')} AS ok`)
    .bind(context.actorIdentityId, context.now)
    .first<{ ok: number }>()
  if (spec.actor === 'admin' && !isAdmin?.ok) throw new SecurityControlError('forbidden', 403)
  const hash = await payloadHash(spec.kind, input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) return { device: await view(database, replay.device_id!), replayed: true }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readRow(database, input.deviceId)
    if (!row) throw new SecurityControlError('device_not_found', 404)
    const assignee = row.assigned_identity_id === context.actorIdentityId
    if (spec.actor === 'assignee' && !assignee) throw new SecurityControlError('device_not_assigned', 403)
    if (spec.actor === 'admin_or_assignee' && !assignee && !isAdmin?.ok)
      throw new SecurityControlError('forbidden', 403)
    const expected = input.expectedVersion
    if (expected !== undefined && expected !== row.version) throw new SecurityControlError('version_conflict', 409)
    if (!spec.from.includes(row.status)) {
      throw new SecurityControlError(spec.kind === 'wipe_confirm' ? 'wipe_not_requested' : 'invalid_transition', 409)
    }
    if (spec.requireCompliantPosture) {
      if (!storedPosture(row).compliant) throw new SecurityControlError('posture_non_compliant', 409)
      if (postureIsStale(row, context.now)) throw new SecurityControlError('posture_stale', 409)
    }
    const statuses = spec.from.map((status) => `'${status}'`).join(',')
    const params = [
      row.id, // 1
      row.version, // 2
      context.now, // 3
      context.actorIdentityId, // 4
      spec.to, // 5
      spec.bumpOfflineKey ? 1 : 0, // 6
      spec.setWipeRequested ? context.now : null, // 7
      spec.setWipeConfirmed ? context.now : null, // 8
      crypto.randomUUID(), // 9 audit
      JSON.stringify({ from: row.status, to: spec.to, reason: input.reason ?? null }), // 10
      input.commandId, // 11
      hash, // 12
      spec.actor === 'assignee' ? row.assigned_identity_id : null // 13 required assignee
    ]
    await database.batch([
      statement(
        database,
        `UPDATE warehouse_devices SET status=?5, offline_key_version=offline_key_version+?6,
           wipe_requested_at=COALESCE(?7, wipe_requested_at), wipe_confirmed_at=COALESCE(?8, wipe_confirmed_at),
           version=version+1, updated_at=?3
         WHERE id=?1 AND version=?2 AND status IN (${statuses})
           AND (${
             spec.actor === 'admin'
               ? adminExistsSql('?4', '?3')
               : spec.actor === 'assignee'
                 ? 'assigned_identity_id=?4'
                 : `assigned_identity_id=?4 OR ${adminExistsSql('?4', '?3')}`
           })`,
        params
      ),
      statement(
        database,
        `INSERT INTO warehouse_device_audit(id, device_id, actor_identity_id, action, detail_json, created_at)
         SELECT ?9, ?1, ?4, '${spec.action}', ?10, ?3 WHERE EXISTS(SELECT 1 FROM warehouse_devices WHERE id=?1 AND version=?2+1 AND status=?5)`,
        params
      ),
      statement(
        database,
        `INSERT INTO warehouse_device_commands(command_id, kind, payload_hash, device_id, created_at)
         SELECT ?11, '${spec.kind}', ?12, ?1, ?3 WHERE EXISTS(SELECT 1 FROM warehouse_device_audit WHERE id=?9)`,
        params
      )
    ])
    if (await readCommand(database, input.commandId)) return { device: await view(database, row.id), replayed: false }
    // Commands that carry a version are CAS: losing the race is a conflict, not a retry.
    if (expected !== undefined) throw new SecurityControlError('version_conflict', 409)
  }
  throw new SecurityControlError('version_conflict', 409)
}

const lockSchema = deviceTransitionInputSchema
const wipeConfirmSchema = deviceWipeConfirmSchema

export const lockDevice = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    { kind: 'lock', schema: lockSchema, from: ['active'], to: 'locked', action: 'locked', actor: 'admin' },
    input,
    ctx
  )

export const unlockDevice = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    {
      kind: 'unlock',
      schema: lockSchema,
      from: ['locked'],
      to: 'active',
      action: 'unlocked',
      actor: 'admin',
      requireCompliantPosture: true
    },
    input,
    ctx
  )

export const reportDeviceLost = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    {
      kind: 'lost',
      schema: lockSchema,
      from: ['pending_enrollment', 'active', 'locked'],
      to: 'lost',
      action: 'lost',
      actor: 'admin_or_assignee',
      bumpOfflineKey: true
    },
    input,
    ctx
  )

export const requestDeviceWipe = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    {
      kind: 'wipe',
      schema: deviceWipeInputSchema,
      from: ['pending_enrollment', 'active', 'locked', 'lost'],
      to: 'wipe_pending',
      action: 'wipe_requested',
      actor: 'admin',
      bumpOfflineKey: true,
      setWipeRequested: true
    },
    input,
    ctx
  )

export const confirmDeviceWipe = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    {
      kind: 'wipe_confirm',
      schema: wipeConfirmSchema,
      from: ['wipe_pending'],
      to: 'wiped',
      action: 'wipe_confirmed',
      actor: 'assignee',
      setWipeConfirmed: true
    },
    input,
    ctx
  )

export const retireDevice = (db: D1Database, input: unknown, ctx: DeviceAdminContext) =>
  transition(
    db,
    {
      kind: 'retire',
      schema: lockSchema,
      from: ['pending_enrollment', 'active', 'locked', 'lost', 'wiped'],
      to: 'retired',
      action: 'retired',
      actor: 'admin'
    },
    input,
    ctx
  )

export interface DeviceCheckin {
  status: DeviceStatus
  wipe: boolean
  lock: boolean
  compliant: boolean
  postureStale: boolean
  offlineKeyVersion: number
}

/** Device heartbeat: tells the titular's device whether it must lock or wipe itself. Never bumps the CAS version. */
export async function deviceCheckin(
  database: D1Database,
  rawInput: { deviceId: string },
  context: DeviceAdminContext
): Promise<DeviceCheckin> {
  const deviceId = parseInput(z.string().uuid(), rawInput.deviceId)
  const row = await readRow(database, deviceId)
  if (!row) throw new SecurityControlError('device_not_found', 404)
  if (row.assigned_identity_id !== context.actorIdentityId) throw new SecurityControlError('device_not_assigned', 403)
  await database
    .prepare(
      `INSERT INTO warehouse_device_presence(device_id, last_seen_at) VALUES (?1, ?2)
       ON CONFLICT(device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at WHERE excluded.last_seen_at>last_seen_at`
    )
    .bind(deviceId, context.now)
    .run()
  return {
    status: row.status,
    wipe: row.status === 'wipe_pending',
    lock: row.status !== 'active',
    compliant: storedPosture(row).compliant,
    postureStale: postureIsStale(row, context.now),
    offlineKeyVersion: row.offline_key_version
  }
}

export async function listDevices(
  database: D1Database,
  filter: { status?: DeviceStatus; identityId?: string; limit?: number }
): Promise<DeviceView[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200)
  const { results } = await database
    .prepare(
      `${DEVICE_SELECT} WHERE (?1 IS NULL OR d.status=?1) AND (?2 IS NULL OR d.assigned_identity_id=?2)
       ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?3`
    )
    .bind(filter.status ?? null, filter.identityId ?? null, limit)
    .all<DeviceRow>()
  return results.map(toView)
}

export interface DeviceAuditEntry {
  id: string
  deviceId: string
  actorIdentityId: string | null
  action: string
  detail: Record<string, unknown>
  createdAt: string
}

export async function listDeviceAudit(database: D1Database, deviceId: string): Promise<DeviceAuditEntry[]> {
  const { results } = await database
    .prepare(
      `SELECT id, device_id, actor_identity_id, action, detail_json, created_at FROM warehouse_device_audit
       WHERE device_id=?1 ORDER BY created_at, rowid LIMIT 500`
    )
    .bind(deviceId)
    .all<{
      id: string
      device_id: string
      actor_identity_id: string | null
      action: string
      detail_json: string
      created_at: string
    }>()
  return results.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    actorIdentityId: row.actor_identity_id,
    action: row.action,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at
  }))
}
