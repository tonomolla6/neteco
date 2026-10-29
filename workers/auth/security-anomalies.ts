import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export const SECURITY_ANOMALY_TYPES = [
  'admin_new_device_login',
  'mfa_change',
  'mass_export',
  'role_permission_change',
  'refund_anomaly'
] as const
export type SecurityAnomalyType = (typeof SECURITY_ANOMALY_TYPES)[number]

export const SECURITY_ANOMALY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type SecurityAnomalySeverity = (typeof SECURITY_ANOMALY_SEVERITIES)[number]

export const SECURITY_ANOMALY_STATUSES = ['open', 'acknowledged', 'resolved'] as const
export type SecurityAnomalyStatus = (typeof SECURITY_ANOMALY_STATUSES)[number]

export const SECURITY_ANOMALY_REASONS = [
  'admin_login_new_device_fingerprint',
  'mfa_reset',
  'mfa_disabled',
  'mfa_reenrolled',
  'mfa_recovery_code_used',
  'export_row_threshold_exceeded',
  'export_window_burst_exceeded',
  'export_row_and_burst_exceeded',
  'admin_invitation_created',
  'admin_invitation_accepted',
  'admin_invitation_revoked',
  'admin_role_granted',
  'refund_amount_threshold_exceeded',
  'refund_actor_burst_exceeded',
  'refund_amount_and_burst_exceeded'
] as const
export type SecurityAnomalyReason = (typeof SECURITY_ANOMALY_REASONS)[number]

export const SECURITY_ANOMALY_READ_PERMISSIONS = ['security.read', 'security.manage'] as const
export const SECURITY_ANOMALY_WRITE_PERMISSIONS = ['security.manage'] as const

export interface SecurityAnomalyThresholds {
  exportRowThreshold?: number
  exportWindowCountThreshold?: number
  exportWindowSeconds?: number
  refundAmountThresholdCents?: number
  refundBurstCountThreshold?: number
  refundBurstWindowSeconds?: number
}

export const DEFAULT_SECURITY_ANOMALY_THRESHOLDS: Required<SecurityAnomalyThresholds> = {
  exportRowThreshold: 25,
  exportWindowCountThreshold: 3,
  exportWindowSeconds: 600,
  refundAmountThresholdCents: 10000,
  refundBurstCountThreshold: 3,
  refundBurstWindowSeconds: 600
}

export type SecurityAnomalyErrorCode =
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'service_unavailable'

export class SecurityAnomalyError extends Error {
  constructor(readonly code: SecurityAnomalyErrorCode) {
    super(code)
    this.name = 'SecurityAnomalyError'
  }
}

export interface SecurityAnomalySignal {
  id: string
  sourceKey: string
  type: SecurityAnomalyType
  severity: SecurityAnomalySeverity
  reasonCode: SecurityAnomalyReason
  status: SecurityAnomalyStatus
  actorId: string
  actorSessionId: string | null
  objectType: string
  objectId: string
  ipHash: string | null
  userAgentHash: string | null
  deviceFingerprintHash: string | null
  context: Record<string, string | number | boolean | null>
  version: number
  occurredAt: string
  createdAt: string
  updatedAt: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  acknowledgedCommandId: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  resolvedCommandId: string | null
  resolutionNote: string | null
}

export interface SecurityAnomalyTransition {
  commandId: string
  signalId: string
  action: 'acknowledge' | 'resolve'
  actorId: string
  sessionId: string
  ipHash: string | null
  userAgentHash: string | null
  fromStatus: SecurityAnomalyStatus
  toStatus: SecurityAnomalyStatus
  version: number
  note: string | null
  createdAt: string
}

export interface SecurityAnomalyList {
  source: 'cloudflare'
  items: SecurityAnomalySignal[]
  nextCursor: string | null
}

export interface SecurityAnomalyDetail {
  source: 'cloudflare'
  item: SecurityAnomalySignal
  transitions: SecurityAnomalyTransition[]
}

export interface SecurityAnomalyReceipt {
  source: 'cloudflare'
  action: 'acknowledge' | 'resolve'
  commandId: string
  signalId: string
  status: 'acknowledged' | 'resolved'
  previousStatus: SecurityAnomalyStatus
  version: number
  actorId: string
  sessionId: string
  note: string | null
  occurredAt: string
  payloadHash: string
}

export interface SecurityAnomalyCommandStatus {
  source: 'cloudflare'
  outcome: 'applied' | 'unknown'
  receipt: SecurityAnomalyReceipt | null
}

export interface EmitSecurityAnomalyInput {
  sourceKey: string
  type: SecurityAnomalyType
  severity: SecurityAnomalySeverity
  reasonCode: SecurityAnomalyReason
  actorId: string
  actorSessionId?: string | null
  objectType: string
  objectId: string
  ipHash?: string | null
  userAgentHash?: string | null
  deviceFingerprintHash?: string | null
  context?: Record<string, unknown>
  occurredAt?: string
}

export interface SecurityAnomalyWriteOptions {
  now?: string
  idempotencyKey: string
  ipHash?: string | null
  userAgentHash?: string | null
}

function isControlCode(code: number) {
  return code <= 0x1f || code === 0x7f
}
function hasControlCharacter(value: string) {
  return [...value].some((character) => isControlCode(character.charCodeAt(0)))
}
function stripControlCharacters(value: string) {
  return [...value].filter((character) => !isControlCode(character.charCodeAt(0))).join('')
}

const uuidSchema = z.string().uuid()
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)
const utcIsoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)))

const noteTextSchema = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .refine((value) => !hasControlCharacter(value))

export const securityAnomalyAcknowledgeInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(1_000_000),
    note: noteTextSchema.optional()
  })
  .strict()

export const securityAnomalyResolveInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1).max(1_000_000),
    note: noteTextSchema
  })
  .strict()

export const securityAnomalyFiltersSchema = z
  .object({
    severity: z.enum(SECURITY_ANOMALY_SEVERITIES).optional(),
    type: z.enum(SECURITY_ANOMALY_TYPES).optional(),
    status: z.enum(SECURITY_ANOMALY_STATUSES).optional(),
    actorId: uuidSchema.optional(),
    objectId: z.string().trim().min(1).max(120).optional(),
    from: utcIsoSchema.optional(),
    to: utcIsoSchema.optional(),
    cursor: z.string().min(8).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(25).default(20)
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to)

const cursorPayloadSchema = z
  .object({
    occurredAt: utcIsoSchema,
    id: uuidSchema,
    filterHash: sha256HexSchema
  })
  .strict()

const FORBIDDEN_CONTEXT_KEYS = new Set([
  'ip',
  'ipaddress',
  'clientip',
  'remoteip',
  'useragent',
  'ua',
  'email',
  'recipientemail',
  'customeremail',
  'token',
  'tokenhash',
  'challengetoken',
  'secret',
  'encryptedsecret',
  'password',
  'passwordhash',
  'recoverycode',
  'recoverycodes',
  'cookie',
  'authorization'
])

function looksLikeRawPiiString(value: string): boolean {
  // Reject strings that look like email addresses or IPv4 addresses
  if (/@/.test(value)) return true
  if (/^\b(?:\d{1,3}\.){3}\d{1,3}\b$/.test(value.trim())) return true
  return false
}

export function sanitizeSecurityAnomalyContext(
  rawContext?: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  if (!rawContext || typeof rawContext !== 'object') return {}
  const cleaned: Record<string, string | number | boolean | null> = {}
  const entries = Object.entries(rawContext).slice(0, 24)
  for (const [rawKey, rawValue] of entries) {
    const normalizedKey = rawKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (!normalizedKey || FORBIDDEN_CONTEXT_KEYS.has(normalizedKey)) continue
    if (rawValue === null) {
      cleaned[rawKey] = null
    } else if (typeof rawValue === 'boolean') {
      cleaned[rawKey] = rawValue
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      cleaned[rawKey] = rawValue
    } else if (typeof rawValue === 'string') {
      const trimmed = stripControlCharacters(rawValue).trim()
      if (!trimmed || looksLikeRawPiiString(trimmed)) continue
      cleaned[rawKey] = trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed
    }
  }
  return cleaned
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashSecurityNetworkValue(
  rawValue: string | null | undefined,
  pepper = 'neteco-security-anomaly-network-v1'
): Promise<string | null> {
  const normalized = rawValue?.trim()
  if (!normalized || normalized.length > 512) return null
  const normalizedPepper = pepper.trim() || 'neteco-security-anomaly-network-v1'
  return sha256Hex(`security-network-v1:${normalizedPepper}:${normalized.toLowerCase()}`)
}

export async function computeSecurityDeviceFingerprintHash(
  ipHash: string | null | undefined,
  userAgentHash: string | null | undefined
): Promise<string | null> {
  const validIp = ipHash && sha256HexSchema.safeParse(ipHash).success ? ipHash : null
  const validUa = userAgentHash && sha256HexSchema.safeParse(userAgentHash).success ? userAgentHash : null
  if (!validIp && !validUa) return null
  return sha256Hex(`security-device-fp-v1:${validIp ?? 'no-ip'}:${validUa ?? 'no-ua'}`)
}

export async function securityAnomalyIntentHash(
  action: 'acknowledge' | 'resolve',
  signalId: string,
  input: { expectedVersion: number; note?: string | null }
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      scope: 'security-anomaly-v1',
      action,
      signalId,
      expectedVersion: input.expectedVersion,
      note: input.note?.trim() ?? null
    })
  )
}

function normalizeOptionalHash(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const parsed = sha256HexSchema.safeParse(value)
  if (!parsed.success) throw new SecurityAnomalyError('invalid_input')
  return parsed.data
}

function normalizeNow(now?: string): string {
  const value = now ?? new Date().toISOString()
  const parsed = utcIsoSchema.safeParse(value)
  if (!parsed.success) throw new SecurityAnomalyError('invalid_input')
  return parsed.data
}

interface RawSignalRow {
  id: string
  source_key: string
  signal_type: SecurityAnomalyType
  severity: SecurityAnomalySeverity
  reason_code: SecurityAnomalyReason
  status: SecurityAnomalyStatus
  actor_id: string
  actor_session_id: string | null
  object_type: string
  object_id: string
  ip_hash: string | null
  user_agent_hash: string | null
  device_fingerprint_hash: string | null
  context_json: string
  version: number
  occurred_at: string
  created_at: string
  updated_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
  acknowledged_command_id: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolved_command_id: string | null
  resolution_note: string | null
}

function mapSignalRow(row: RawSignalRow): SecurityAnomalySignal {
  const parsedContext = (() => {
    try {
      return sanitizeSecurityAnomalyContext(JSON.parse(row.context_json) as Record<string, unknown>)
    } catch {
      return {}
    }
  })()
  return {
    id: row.id,
    sourceKey: row.source_key,
    type: row.signal_type,
    severity: row.severity,
    reasonCode: row.reason_code,
    status: row.status,
    actorId: row.actor_id,
    actorSessionId: row.actor_session_id,
    objectType: row.object_type,
    objectId: row.object_id,
    ipHash: row.ip_hash,
    userAgentHash: row.user_agent_hash,
    deviceFingerprintHash: row.device_fingerprint_hash,
    context: parsedContext,
    version: Number(row.version),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedCommandId: row.acknowledged_command_id,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedCommandId: row.resolved_command_id,
    resolutionNote: row.resolution_note
  }
}

async function requireSecurityPermission(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  mode: 'read' | 'write'
): Promise<VerifiedSessionClaims> {
  if (
    !claims ||
    !uuidSchema.safeParse(claims.identityId).success ||
    !uuidSchema.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  ) {
    throw new SecurityAnomalyError('unauthenticated')
  }
  const allowedPermissions = mode === 'write' ? SECURITY_ANOMALY_WRITE_PERMISSIONS : SECURITY_ANOMALY_READ_PERMISSIONS
  const placeholders = allowedPermissions.map((_, index) => `?${index + 5}`).join(', ')
  try {
    const row = await database
      .prepare(
        `SELECT s.mfa_verified AS mfa_verified,
                (i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?1) AS email_verified,
                (m.verified_at IS NOT NULL AND m.verified_at <= ?1) AS mfa_enrolled,
                EXISTS(
                  SELECT 1
                  FROM identity_roles ir
                  JOIN role_permissions rp ON rp.role_code = ir.role_code
                  WHERE ir.identity_id = i.id
                    AND ir.granted_at <= ?1
                    AND (ir.expires_at IS NULL OR ir.expires_at > ?1)
                    AND rp.permission_code IN (${placeholders})
                ) AS permitted
         FROM auth_sessions s
         JOIN identities i ON i.id = s.identity_id
         LEFT JOIN identity_mfa m ON m.identity_id = i.id
         WHERE s.id = ?2 AND s.identity_id = ?3 AND s.session_version = ?4
           AND i.session_version = s.session_version AND i.status = 'active'
           AND s.revoked_at IS NULL AND s.created_at <= ?1 AND s.expires_at > ?1`
      )
      .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion, ...allowedPermissions)
      .first<{ mfa_verified: number; email_verified: number; mfa_enrolled: number | null; permitted: number }>()
    if (!row) throw new SecurityAnomalyError('unauthenticated')
    if (!row.permitted) throw new SecurityAnomalyError('forbidden')
    if (!row.email_verified) throw new SecurityAnomalyError('email_unverified')
    if (!row.mfa_verified || !row.mfa_enrolled) throw new SecurityAnomalyError('mfa_required')
    return claims
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('service_unavailable')
  }
}

async function isIdentityCurrentlyAdmin(database: D1Database, identityId: string, now: string): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS is_admin
       FROM identity_roles ir
       JOIN roles r ON r.code = ir.role_code
       WHERE ir.identity_id = ?
         AND ir.granted_at <= ?
         AND (ir.expires_at IS NULL OR ir.expires_at > ?)
       LIMIT 1`
    )
    .bind(identityId, now, now)
    .first<{ is_admin: number }>()
  return Boolean(row)
}

export async function emitSecurityAnomalySignal(
  database: D1Database,
  input: EmitSecurityAnomalyInput
): Promise<{ signal: SecurityAnomalySignal; deduplicated: boolean }> {
  const now = normalizeNow(input.occurredAt)
  const sourceKey = input.sourceKey.trim()
  if (
    sourceKey.length < 3 ||
    sourceKey.length > 240 ||
    !SECURITY_ANOMALY_TYPES.includes(input.type) ||
    !SECURITY_ANOMALY_SEVERITIES.includes(input.severity) ||
    !SECURITY_ANOMALY_REASONS.includes(input.reasonCode) ||
    !uuidSchema.safeParse(input.actorId).success
  ) {
    throw new SecurityAnomalyError('invalid_input')
  }
  const objectType = input.objectType.trim()
  const objectId = input.objectId.trim()
  if (objectType.length < 2 || objectType.length > 64 || objectId.length < 1 || objectId.length > 120) {
    throw new SecurityAnomalyError('invalid_input')
  }
  const ipHash = normalizeOptionalHash(input.ipHash)
  const userAgentHash = normalizeOptionalHash(input.userAgentHash)
  const deviceFingerprintHash =
    normalizeOptionalHash(input.deviceFingerprintHash) ??
    (await computeSecurityDeviceFingerprintHash(ipHash, userAgentHash))
  const contextJson = JSON.stringify(sanitizeSecurityAnomalyContext(input.context))

  try {
    const existingBefore = await database
      .prepare('SELECT * FROM security_anomaly_signals WHERE source_key = ? LIMIT 1')
      .bind(sourceKey)
      .first<RawSignalRow>()
    if (existingBefore) {
      return { signal: mapSignalRow(existingBefore), deduplicated: true }
    }

    const id = crypto.randomUUID()
    await database
      .prepare(
        `INSERT INTO security_anomaly_signals (
          id, source_key, signal_type, severity, reason_code, status,
          actor_id, actor_session_id, object_type, object_id,
          ip_hash, user_agent_hash, device_fingerprint_hash, context_json,
          version, occurred_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(source_key) DO NOTHING`
      )
      .bind(
        id,
        sourceKey,
        input.type,
        input.severity,
        input.reasonCode,
        input.actorId,
        input.actorSessionId ?? null,
        objectType,
        objectId,
        ipHash,
        userAgentHash,
        deviceFingerprintHash,
        contextJson,
        now,
        now,
        now
      )
      .run()

    const persisted = await database
      .prepare('SELECT * FROM security_anomaly_signals WHERE source_key = ? LIMIT 1')
      .bind(sourceKey)
      .first<RawSignalRow>()
    if (!persisted) throw new SecurityAnomalyError('service_unavailable')
    return {
      signal: mapSignalRow(persisted),
      deduplicated: persisted.id !== id
    }
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('service_unavailable')
  }
}

export async function recordAdminSessionDeviceSignal(
  database: D1Database,
  input: {
    identityId: string
    sessionId: string
    sourceEventId?: string
    ipHash?: string | null
    userAgentHash?: string | null
    deviceFingerprintHash?: string | null
    occurredAt?: string
  }
): Promise<{
  emitted: boolean
  deduplicated: boolean
  signal: SecurityAnomalySignal | null
  isFirstDevice: boolean
}> {
  const occurredAt = normalizeNow(input.occurredAt)
  const ipHash = normalizeOptionalHash(input.ipHash)
  const userAgentHash = normalizeOptionalHash(input.userAgentHash)
  const fingerprintHash =
    normalizeOptionalHash(input.deviceFingerprintHash) ??
    (await computeSecurityDeviceFingerprintHash(ipHash, userAgentHash))

  if (!fingerprintHash) {
    return { emitted: false, deduplicated: false, signal: null, isFirstDevice: false }
  }

  const isAdmin = await isIdentityCurrentlyAdmin(database, input.identityId, occurredAt)
  if (!isAdmin) {
    return { emitted: false, deduplicated: false, signal: null, isFirstDevice: false }
  }

  const sourceKey = `admin_new_device_login:${input.identityId}:${input.sourceEventId ?? input.sessionId}`
  const existingSignal = await database
    .prepare('SELECT * FROM security_anomaly_signals WHERE source_key = ? LIMIT 1')
    .bind(sourceKey)
    .first<RawSignalRow>()
  if (existingSignal) {
    const signal = mapSignalRow(existingSignal)
    return {
      emitted: true,
      deduplicated: true,
      signal,
      isFirstDevice: Boolean(signal.context.isFirstKnownDevice)
    }
  }

  const existingDevice = await database
    .prepare(
      `SELECT identity_id, fingerprint_hash, seen_count
       FROM security_admin_known_devices
       WHERE identity_id = ? AND fingerprint_hash = ?
       LIMIT 1`
    )
    .bind(input.identityId, fingerprintHash)
    .first<{ identity_id: string; fingerprint_hash: string; seen_count: number }>()

  if (existingDevice) {
    await database
      .prepare(
        `UPDATE security_admin_known_devices
         SET last_session_id = ?,
             last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END,
             seen_count = seen_count + 1
         WHERE identity_id = ? AND fingerprint_hash = ?`
      )
      .bind(input.sessionId, occurredAt, occurredAt, input.identityId, fingerprintHash)
      .run()
    return { emitted: false, deduplicated: false, signal: null, isFirstDevice: false }
  }

  const countRow = await database
    .prepare('SELECT count(*) AS count FROM security_admin_known_devices WHERE identity_id = ?')
    .bind(input.identityId)
    .first<{ count: number }>()
  const knownDeviceCountBefore = Number(countRow?.count ?? 0)
  const isFirstDevice = knownDeviceCountBefore === 0

  await database
    .prepare(
      `INSERT INTO security_admin_known_devices (
        identity_id, fingerprint_hash, ip_hash, user_agent_hash,
        first_session_id, last_session_id, first_seen_at, last_seen_at, seen_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(identity_id, fingerprint_hash) DO UPDATE SET
        last_session_id = excluded.last_session_id,
        last_seen_at = excluded.last_seen_at,
        seen_count = security_admin_known_devices.seen_count + 1`
    )
    .bind(
      input.identityId,
      fingerprintHash,
      ipHash,
      userAgentHash,
      input.sessionId,
      input.sessionId,
      occurredAt,
      occurredAt
    )
    .run()

  const { signal, deduplicated } = await emitSecurityAnomalySignal(database, {
    sourceKey,
    type: 'admin_new_device_login',
    severity: isFirstDevice ? 'medium' : 'high',
    reasonCode: 'admin_login_new_device_fingerprint',
    actorId: input.identityId,
    actorSessionId: input.sessionId,
    objectType: 'auth_session',
    objectId: input.sessionId,
    ipHash,
    userAgentHash,
    deviceFingerprintHash: fingerprintHash,
    occurredAt,
    context: {
      knownDeviceCountBefore,
      isFirstKnownDevice: isFirstDevice
    }
  })

  return { emitted: true, deduplicated, signal, isFirstDevice }
}

export async function recordMfaChangeSignal(
  database: D1Database,
  input: {
    identityId: string
    sessionId?: string | null
    changeType: 'mfa_reset' | 'mfa_disabled' | 'mfa_reenrolled' | 'mfa_recovery_code_used'
    sourceEventId: string
    objectId?: string
    ipHash?: string | null
    userAgentHash?: string | null
    occurredAt?: string
    context?: Record<string, unknown>
    /** Emission hooks for ordinary customers set this: only administrative identities raise an MFA alert. */
    onlyIfAdmin?: boolean
  }
): Promise<{ emitted: boolean; deduplicated: boolean; signal: SecurityAnomalySignal | null }> {
  const occurredAt = normalizeNow(input.occurredAt)
  const isAdmin = await isIdentityCurrentlyAdmin(database, input.identityId, occurredAt)
  if (input.onlyIfAdmin && !isAdmin) return { emitted: false, deduplicated: false, signal: null }
  let severity: SecurityAnomalySeverity = 'high'
  if (input.changeType === 'mfa_reset' || input.changeType === 'mfa_disabled') {
    severity = isAdmin ? 'critical' : 'high'
  } else if (input.changeType === 'mfa_recovery_code_used') {
    severity = isAdmin ? 'high' : 'medium'
  }

  const sourceKey = `mfa_change:${input.changeType}:${input.sourceEventId.trim()}`
  const { signal, deduplicated } = await emitSecurityAnomalySignal(database, {
    sourceKey,
    type: 'mfa_change',
    severity,
    reasonCode: input.changeType,
    actorId: input.identityId,
    actorSessionId: input.sessionId ?? null,
    objectType: 'identity_mfa',
    objectId: input.objectId ?? input.identityId,
    ipHash: input.ipHash,
    userAgentHash: input.userAgentHash,
    occurredAt,
    context: {
      ...input.context,
      changeType: input.changeType,
      isAdminActor: isAdmin
    }
  })
  return { emitted: true, deduplicated, signal }
}

export async function recordMassExportSignal(
  database: D1Database,
  input: {
    actorId: string
    sessionId?: string | null
    exportKind: 'admin_audit' | 'orders' | 'catalog'
    exportCommandId: string
    rowCount: number
    byteLength?: number | null
    ipHash?: string | null
    userAgentHash?: string | null
    occurredAt?: string
    thresholds?: SecurityAnomalyThresholds
  }
): Promise<{
  emitted: boolean
  deduplicated: boolean
  signal: SecurityAnomalySignal | null
  windowExportCount: number
}> {
  const occurredAt = normalizeNow(input.occurredAt)
  const rowThreshold = input.thresholds?.exportRowThreshold ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.exportRowThreshold
  const windowCountThreshold =
    input.thresholds?.exportWindowCountThreshold ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.exportWindowCountThreshold
  const windowSeconds = input.thresholds?.exportWindowSeconds ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.exportWindowSeconds

  const ipHash = normalizeOptionalHash(input.ipHash)
  const exportCommandId = input.exportCommandId.trim()
  const exportKey = `${input.exportKind}:${exportCommandId}`
  const rowCount = Math.max(0, Math.trunc(input.rowCount))

  await database
    .prepare(
      `INSERT INTO security_export_activity_log (
        export_key, actor_id, session_id, export_kind, export_command_id,
        row_count, byte_length, ip_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(export_key) DO NOTHING`
    )
    .bind(
      exportKey,
      input.actorId,
      input.sessionId ?? null,
      input.exportKind,
      exportCommandId,
      rowCount,
      input.byteLength ?? null,
      ipHash,
      occurredAt
    )
    .run()

  const windowStartIso = new Date(Date.parse(occurredAt) - windowSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const windowRow = await database
    .prepare(
      `SELECT count(*) AS count
       FROM security_export_activity_log
       WHERE actor_id = ?
         AND occurred_at >= ?
         AND occurred_at <= ?`
    )
    .bind(input.actorId, windowStartIso, occurredAt)
    .first<{ count: number }>()
  const windowExportCount = Number(windowRow?.count ?? 1)

  const rowExceeded = rowCount >= rowThreshold
  const burstExceeded = windowExportCount >= windowCountThreshold

  if (!rowExceeded && !burstExceeded) {
    return { emitted: false, deduplicated: false, signal: null, windowExportCount }
  }

  let reasonCode: SecurityAnomalyReason = 'export_window_burst_exceeded'
  let severity: SecurityAnomalySeverity = 'high'
  if (rowExceeded && burstExceeded) {
    reasonCode = 'export_row_and_burst_exceeded'
    severity = 'critical'
  } else if (rowExceeded) {
    reasonCode = 'export_row_threshold_exceeded'
    severity = rowCount >= Math.max(1, rowThreshold * 2) ? 'high' : 'medium'
  }

  const sourceKey = `mass_export:${input.exportKind}:${exportCommandId}`
  const { signal, deduplicated } = await emitSecurityAnomalySignal(database, {
    sourceKey,
    type: 'mass_export',
    severity,
    reasonCode,
    actorId: input.actorId,
    actorSessionId: input.sessionId ?? null,
    objectType: `${input.exportKind}_export`,
    objectId: exportCommandId,
    ipHash,
    userAgentHash: input.userAgentHash,
    occurredAt,
    context: {
      exportKind: input.exportKind,
      rowCount,
      rowThreshold,
      windowExportCount,
      windowCountThreshold,
      windowSeconds,
      byteLength: input.byteLength ?? null
    }
  })

  return { emitted: true, deduplicated, signal, windowExportCount }
}

export async function recordRolePermissionChangeSignal(
  database: D1Database,
  input: {
    actorId: string
    sessionId?: string | null
    changeKind:
      'admin_invitation_created' | 'admin_invitation_accepted' | 'admin_invitation_revoked' | 'admin_role_granted'
    sourceCommandId: string
    targetIdentityId?: string | null
    invitationId?: string | null
    roleCode: string
    permissions?: readonly string[]
    ipHash?: string | null
    userAgentHash?: string | null
    occurredAt?: string
  }
): Promise<{ emitted: boolean; deduplicated: boolean; signal: SecurityAnomalySignal }> {
  const occurredAt = normalizeNow(input.occurredAt)
  const roleCode = input.roleCode.trim()
  const permissions = input.permissions ?? []
  const isHighPrivilegeRole =
    roleCode === 'admin' ||
    roleCode === 'security_admin' ||
    permissions.includes('security.manage') ||
    permissions.includes('administration.manage')

  let severity: SecurityAnomalySeverity = 'medium'
  if (input.changeKind === 'admin_invitation_accepted' || input.changeKind === 'admin_role_granted') {
    severity = isHighPrivilegeRole ? 'critical' : 'high'
  } else if (input.changeKind === 'admin_invitation_created') {
    severity = isHighPrivilegeRole ? 'high' : 'medium'
  } else if (input.changeKind === 'admin_invitation_revoked') {
    severity = 'low'
  }

  const sourceKey = `role_permission_change:${input.changeKind}:${input.sourceCommandId.trim()}`
  const objectType = input.invitationId ? 'admin_invitation' : 'identity_role'
  const objectId = input.invitationId ?? input.targetIdentityId ?? input.sourceCommandId

  const { signal, deduplicated } = await emitSecurityAnomalySignal(database, {
    sourceKey,
    type: 'role_permission_change',
    severity,
    reasonCode: input.changeKind,
    actorId: input.actorId,
    actorSessionId: input.sessionId ?? null,
    objectType,
    objectId,
    ipHash: input.ipHash,
    userAgentHash: input.userAgentHash,
    occurredAt,
    context: {
      changeKind: input.changeKind,
      roleCode,
      targetIdentityId: input.targetIdentityId ?? null,
      invitationId: input.invitationId ?? null,
      permissionCount: permissions.length
    }
  })

  return { emitted: true, deduplicated, signal }
}

export async function recordRefundAnomalySignal(
  database: D1Database,
  input: {
    actorId: string
    sessionId?: string | null
    refundId: string
    orderId: string
    stage: 'plan' | 'confirm'
    sourceCommandId: string
    grossCents: number
    currency?: string
    ipHash?: string | null
    userAgentHash?: string | null
    occurredAt?: string
    thresholds?: SecurityAnomalyThresholds
  }
): Promise<{
  emitted: boolean
  deduplicated: boolean
  signal: SecurityAnomalySignal | null
  windowRefundCount: number
}> {
  const occurredAt = normalizeNow(input.occurredAt)
  const amountThresholdCents =
    input.thresholds?.refundAmountThresholdCents ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.refundAmountThresholdCents
  const burstCountThreshold =
    input.thresholds?.refundBurstCountThreshold ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.refundBurstCountThreshold
  const burstWindowSeconds =
    input.thresholds?.refundBurstWindowSeconds ?? DEFAULT_SECURITY_ANOMALY_THRESHOLDS.refundBurstWindowSeconds

  const ipHash = normalizeOptionalHash(input.ipHash)
  const refundId = input.refundId.trim()
  const orderId = input.orderId.trim()
  const grossCents = Math.max(0, Math.trunc(input.grossCents))
  const currency = (input.currency ?? 'EUR').trim().toUpperCase().slice(0, 3) || 'EUR'
  const refundKey = `${input.stage}:${refundId}`

  await database
    .prepare(
      `INSERT INTO security_refund_activity_log (
        refund_key, actor_id, session_id, refund_id, order_id,
        stage, gross_cents, currency, ip_hash, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(refund_key) DO NOTHING`
    )
    .bind(
      refundKey,
      input.actorId,
      input.sessionId ?? null,
      refundId,
      orderId,
      input.stage,
      grossCents,
      currency,
      ipHash,
      occurredAt
    )
    .run()

  const windowStartIso = new Date(Date.parse(occurredAt) - burstWindowSeconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const windowRow = await database
    .prepare(
      `SELECT count(*) AS count
       FROM security_refund_activity_log
       WHERE actor_id = ?
         AND stage = ?
         AND occurred_at >= ?
         AND occurred_at <= ?`
    )
    .bind(input.actorId, input.stage, windowStartIso, occurredAt)
    .first<{ count: number }>()
  const windowRefundCount = Number(windowRow?.count ?? 1)

  const amountExceeded = grossCents >= amountThresholdCents
  const burstExceeded = windowRefundCount >= burstCountThreshold

  if (!amountExceeded && !burstExceeded) {
    return { emitted: false, deduplicated: false, signal: null, windowRefundCount }
  }

  let reasonCode: SecurityAnomalyReason = 'refund_actor_burst_exceeded'
  let severity: SecurityAnomalySeverity = 'high'
  if (amountExceeded && burstExceeded) {
    reasonCode = 'refund_amount_and_burst_exceeded'
    severity = 'critical'
  } else if (amountExceeded) {
    reasonCode = 'refund_amount_threshold_exceeded'
    severity = grossCents >= Math.max(1, amountThresholdCents * 2) ? 'critical' : 'high'
  }

  const sourceKey = `refund_anomaly:${input.stage}:${refundId}`
  const { signal, deduplicated } = await emitSecurityAnomalySignal(database, {
    sourceKey,
    type: 'refund_anomaly',
    severity,
    reasonCode,
    actorId: input.actorId,
    actorSessionId: input.sessionId ?? null,
    objectType: 'refund',
    objectId: refundId,
    ipHash,
    userAgentHash: input.userAgentHash,
    occurredAt,
    context: {
      orderId,
      stage: input.stage,
      grossCents,
      currency,
      amountThresholdCents,
      windowRefundCount,
      burstCountThreshold,
      burstWindowSeconds
    }
  })

  return { emitted: true, deduplicated, signal, windowRefundCount }
}

/**
 * Non-blocking wrappers for emission hooks in business operations.
 * A security anomaly signal is strictly an alert and must never abort or
 * roll back the underlying business operation if the signal store is absent
 * (e.g. legacy test fixtures prior to migration 0093) or temporarily degraded.
 */
export async function safeRecordAdminSessionDeviceSignal(
  database: D1Database,
  input: Parameters<typeof recordAdminSessionDeviceSignal>[1]
): Promise<void> {
  try {
    await recordAdminSessionDeviceSignal(database, input)
  } catch {
    // Non-blocking by design (SEC-035)
  }
}

export async function safeRecordMfaChangeSignal(
  database: D1Database,
  input: Parameters<typeof recordMfaChangeSignal>[1]
): Promise<void> {
  try {
    await recordMfaChangeSignal(database, input)
  } catch {
    // Non-blocking by design (SEC-035)
  }
}

export async function safeRecordMassExportSignal(
  database: D1Database,
  input: Parameters<typeof recordMassExportSignal>[1]
): Promise<void> {
  try {
    await recordMassExportSignal(database, input)
  } catch {
    // Non-blocking by design (SEC-035)
  }
}

export async function safeRecordRolePermissionChangeSignal(
  database: D1Database,
  input: Parameters<typeof recordRolePermissionChangeSignal>[1]
): Promise<void> {
  try {
    await recordRolePermissionChangeSignal(database, input)
  } catch {
    // Non-blocking by design (SEC-035)
  }
}

export async function safeRecordRefundAnomalySignal(
  database: D1Database,
  input: Parameters<typeof recordRefundAnomalySignal>[1]
): Promise<void> {
  try {
    await recordRefundAnomalySignal(database, input)
  } catch {
    // Non-blocking by design (SEC-035)
  }
}

async function computeFilterHash(filters: {
  severity?: SecurityAnomalySeverity
  type?: SecurityAnomalyType
  status?: SecurityAnomalyStatus
  actorId?: string
  objectId?: string
  from?: string
  to?: string
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      scope: 'security-anomaly-filters-v1',
      severity: filters.severity ?? null,
      type: filters.type ?? null,
      status: filters.status ?? null,
      actorId: filters.actorId ?? null,
      objectId: filters.objectId ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null
    })
  )
}

function encodeCursor(cursor: { occurredAt: string; id: string; filterHash: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(rawCursor: string, expectedFilterHash: string): { occurredAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'))
    const parsed = cursorPayloadSchema.parse(decoded)
    if (parsed.filterHash !== expectedFilterHash) {
      throw new SecurityAnomalyError('invalid_input')
    }
    return { occurredAt: parsed.occurredAt, id: parsed.id }
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('invalid_input')
  }
}

export async function readD1SecurityAnomalies(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  rawFilters: unknown = {},
  options: { now?: string } = {}
): Promise<SecurityAnomalyList> {
  const now = normalizeNow(options.now)
  await requireSecurityPermission(database, claims, now, 'read')

  const parsedFilters = securityAnomalyFiltersSchema.safeParse(rawFilters ?? {})
  if (!parsedFilters.success) throw new SecurityAnomalyError('invalid_input')
  const filters = parsedFilters.data
  const filterHash = await computeFilterHash(filters)
  const cursor = filters.cursor ? decodeCursor(filters.cursor, filterHash) : null

  const conditions: string[] = []
  const bindings: unknown[] = []

  if (filters.severity) {
    conditions.push('severity = ?')
    bindings.push(filters.severity)
  }
  if (filters.type) {
    conditions.push('signal_type = ?')
    bindings.push(filters.type)
  }
  if (filters.status) {
    conditions.push('status = ?')
    bindings.push(filters.status)
  }
  if (filters.actorId) {
    conditions.push('actor_id = ?')
    bindings.push(filters.actorId)
  }
  if (filters.objectId) {
    conditions.push('object_id = ?')
    bindings.push(filters.objectId)
  }
  if (filters.from) {
    conditions.push('occurred_at >= ?')
    bindings.push(filters.from)
  }
  if (filters.to) {
    conditions.push('occurred_at <= ?')
    bindings.push(filters.to)
  }
  if (cursor) {
    conditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))')
    bindings.push(cursor.occurredAt, cursor.occurredAt, cursor.id)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = filters.limit + 1

  try {
    const result = await database
      .prepare(
        `SELECT *
         FROM security_anomaly_signals
         ${whereClause}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`
      )
      .bind(...bindings, fetchLimit)
      .all<RawSignalRow>()

    const rows = result.results ?? []
    const hasMore = rows.length > filters.limit
    const pageRows = hasMore ? rows.slice(0, filters.limit) : rows
    const items = pageRows.map(mapSignalRow)
    const last = items[items.length - 1]
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            occurredAt: last.occurredAt,
            id: last.id,
            filterHash
          })
        : null

    return {
      source: 'cloudflare',
      items,
      nextCursor
    }
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('service_unavailable')
  }
}

interface RawCommandRow {
  command_id: string
  signal_id: string
  actor_id: string
  session_id: string
  ip_hash: string | null
  user_agent_hash: string | null
  action: 'acknowledge' | 'resolve'
  from_status: SecurityAnomalyStatus
  to_status: SecurityAnomalyStatus
  expected_version: number
  applied_version: number
  note: string | null
  payload_hash: string
  receipt_json: string
  created_at: string
}

export async function readD1SecurityAnomalyDetail(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  signalId: string,
  options: { now?: string } = {}
): Promise<SecurityAnomalyDetail> {
  const now = normalizeNow(options.now)
  await requireSecurityPermission(database, claims, now, 'read')
  if (!uuidSchema.safeParse(signalId).success) {
    throw new SecurityAnomalyError('invalid_input')
  }

  try {
    const row = await database
      .prepare('SELECT * FROM security_anomaly_signals WHERE id = ? LIMIT 1')
      .bind(signalId)
      .first<RawSignalRow>()
    if (!row) throw new SecurityAnomalyError('not_found')

    const commandsResult = await database
      .prepare(
        `SELECT *
         FROM security_anomaly_commands
         WHERE signal_id = ?
         ORDER BY applied_version ASC, created_at ASC`
      )
      .bind(signalId)
      .all<RawCommandRow>()

    const transitions: SecurityAnomalyTransition[] = (commandsResult.results ?? []).map((cmd) => ({
      commandId: cmd.command_id,
      signalId: cmd.signal_id,
      action: cmd.action,
      actorId: cmd.actor_id,
      sessionId: cmd.session_id,
      ipHash: cmd.ip_hash,
      userAgentHash: cmd.user_agent_hash,
      fromStatus: cmd.from_status,
      toStatus: cmd.to_status,
      version: Number(cmd.applied_version),
      note: cmd.note,
      createdAt: cmd.created_at
    }))

    return {
      source: 'cloudflare',
      item: mapSignalRow(row),
      transitions
    }
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('service_unavailable')
  }
}

async function findExistingCommand(
  database: D1Database,
  commandId: string,
  actorId: string,
  action: 'acknowledge' | 'resolve',
  signalId: string,
  payloadHash: string
): Promise<SecurityAnomalyReceipt | null> {
  const existing = await database
    .prepare('SELECT * FROM security_anomaly_commands WHERE command_id = ? LIMIT 1')
    .bind(commandId)
    .first<RawCommandRow>()
  if (!existing) return null
  if (
    existing.actor_id !== actorId ||
    existing.action !== action ||
    existing.signal_id !== signalId ||
    existing.payload_hash !== payloadHash
  ) {
    throw new SecurityAnomalyError('idempotency_conflict')
  }
  return JSON.parse(existing.receipt_json) as SecurityAnomalyReceipt
}

export async function acknowledgeD1SecurityAnomaly(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  signalId: string,
  rawInput: unknown,
  options: SecurityAnomalyWriteOptions
): Promise<SecurityAnomalyReceipt> {
  const now = normalizeNow(options.now)
  const verifiedClaims = await requireSecurityPermission(database, claims, now, 'write')

  if (!uuidSchema.safeParse(signalId).success || !uuidSchema.safeParse(options.idempotencyKey).success) {
    throw new SecurityAnomalyError('invalid_input')
  }
  const parsedInput = securityAnomalyAcknowledgeInputSchema.safeParse(rawInput)
  if (!parsedInput.success) throw new SecurityAnomalyError('invalid_input')
  const input = parsedInput.data
  const ipHash = normalizeOptionalHash(options.ipHash)
  const userAgentHash = normalizeOptionalHash(options.userAgentHash)
  const payloadHash = await securityAnomalyIntentHash('acknowledge', signalId, input)

  try {
    const replay = await findExistingCommand(
      database,
      options.idempotencyKey,
      verifiedClaims.identityId,
      'acknowledge',
      signalId,
      payloadHash
    )
    if (replay) return replay

    const current = await database
      .prepare('SELECT * FROM security_anomaly_signals WHERE id = ? LIMIT 1')
      .bind(signalId)
      .first<RawSignalRow>()
    if (!current) throw new SecurityAnomalyError('not_found')

    if (Number(current.version) !== input.expectedVersion) {
      throw new SecurityAnomalyError('version_conflict')
    }
    if (current.status !== 'open') {
      throw new SecurityAnomalyError('invalid_transition')
    }

    const nextVersion = input.expectedVersion + 1
    const receipt: SecurityAnomalyReceipt = {
      source: 'cloudflare',
      action: 'acknowledge',
      commandId: options.idempotencyKey,
      signalId,
      status: 'acknowledged',
      previousStatus: current.status,
      version: nextVersion,
      actorId: verifiedClaims.identityId,
      sessionId: verifiedClaims.sessionId,
      note: input.note ?? null,
      occurredAt: now,
      payloadHash
    }

    await database.batch([
      database
        .prepare(
          `UPDATE security_anomaly_signals
           SET status = 'acknowledged',
               version = ?,
               updated_at = ?,
               acknowledged_at = ?,
               acknowledged_by = ?,
               acknowledged_command_id = ?
           WHERE id = ?
             AND version = ?
             AND status = 'open'`
        )
        .bind(
          nextVersion,
          now,
          now,
          verifiedClaims.identityId,
          options.idempotencyKey,
          signalId,
          input.expectedVersion
        ),
      database
        .prepare(
          `INSERT INTO security_anomaly_commands (
            command_id, signal_id, actor_id, session_id, ip_hash, user_agent_hash,
            action, from_status, to_status, expected_version, applied_version,
            note, payload_hash, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'acknowledge', 'open', 'acknowledged', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          options.idempotencyKey,
          signalId,
          verifiedClaims.identityId,
          verifiedClaims.sessionId,
          ipHash,
          userAgentHash,
          input.expectedVersion,
          nextVersion,
          input.note ?? null,
          payloadHash,
          JSON.stringify(receipt),
          now
        )
    ])

    return receipt
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('security_anomaly_authority_required')) {
      throw new SecurityAnomalyError('forbidden')
    }
    if (message.includes('security_anomaly_invalid_signal_mutation')) {
      throw new SecurityAnomalyError('version_conflict')
    }
    throw new SecurityAnomalyError('service_unavailable')
  }
}

export async function resolveD1SecurityAnomaly(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  signalId: string,
  rawInput: unknown,
  options: SecurityAnomalyWriteOptions
): Promise<SecurityAnomalyReceipt> {
  const now = normalizeNow(options.now)
  const verifiedClaims = await requireSecurityPermission(database, claims, now, 'write')

  if (!uuidSchema.safeParse(signalId).success || !uuidSchema.safeParse(options.idempotencyKey).success) {
    throw new SecurityAnomalyError('invalid_input')
  }
  const parsedInput = securityAnomalyResolveInputSchema.safeParse(rawInput)
  if (!parsedInput.success) throw new SecurityAnomalyError('invalid_input')
  const input = parsedInput.data
  const ipHash = normalizeOptionalHash(options.ipHash)
  const userAgentHash = normalizeOptionalHash(options.userAgentHash)
  const payloadHash = await securityAnomalyIntentHash('resolve', signalId, input)

  try {
    const replay = await findExistingCommand(
      database,
      options.idempotencyKey,
      verifiedClaims.identityId,
      'resolve',
      signalId,
      payloadHash
    )
    if (replay) return replay

    const current = await database
      .prepare('SELECT * FROM security_anomaly_signals WHERE id = ? LIMIT 1')
      .bind(signalId)
      .first<RawSignalRow>()
    if (!current) throw new SecurityAnomalyError('not_found')

    if (Number(current.version) !== input.expectedVersion) {
      throw new SecurityAnomalyError('version_conflict')
    }
    if (current.status === 'resolved') {
      throw new SecurityAnomalyError('invalid_transition')
    }

    const nextVersion = input.expectedVersion + 1
    const receipt: SecurityAnomalyReceipt = {
      source: 'cloudflare',
      action: 'resolve',
      commandId: options.idempotencyKey,
      signalId,
      status: 'resolved',
      previousStatus: current.status,
      version: nextVersion,
      actorId: verifiedClaims.identityId,
      sessionId: verifiedClaims.sessionId,
      note: input.note,
      occurredAt: now,
      payloadHash
    }

    await database.batch([
      database
        .prepare(
          `UPDATE security_anomaly_signals
           SET status = 'resolved',
               version = ?,
               updated_at = ?,
               resolved_at = ?,
               resolved_by = ?,
               resolved_command_id = ?,
               resolution_note = ?
           WHERE id = ?
             AND version = ?
             AND status IN ('open', 'acknowledged')`
        )
        .bind(
          nextVersion,
          now,
          now,
          verifiedClaims.identityId,
          options.idempotencyKey,
          input.note,
          signalId,
          input.expectedVersion
        ),
      database
        .prepare(
          `INSERT INTO security_anomaly_commands (
            command_id, signal_id, actor_id, session_id, ip_hash, user_agent_hash,
            action, from_status, to_status, expected_version, applied_version,
            note, payload_hash, receipt_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'resolve', ?, 'resolved', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          options.idempotencyKey,
          signalId,
          verifiedClaims.identityId,
          verifiedClaims.sessionId,
          ipHash,
          userAgentHash,
          current.status,
          input.expectedVersion,
          nextVersion,
          input.note,
          payloadHash,
          JSON.stringify(receipt),
          now
        )
    ])

    return receipt
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('security_anomaly_authority_required')) {
      throw new SecurityAnomalyError('forbidden')
    }
    if (message.includes('security_anomaly_invalid_signal_mutation')) {
      throw new SecurityAnomalyError('version_conflict')
    }
    throw new SecurityAnomalyError('service_unavailable')
  }
}

export async function readD1SecurityAnomalyCommand(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  payloadHash: string,
  options: { now?: string } = {}
): Promise<SecurityAnomalyCommandStatus> {
  const now = normalizeNow(options.now)
  const verifiedClaims = await requireSecurityPermission(database, claims, now, 'write')

  if (!uuidSchema.safeParse(commandId).success || !sha256HexSchema.safeParse(payloadHash).success) {
    throw new SecurityAnomalyError('invalid_input')
  }

  try {
    const existing = await database
      .prepare('SELECT * FROM security_anomaly_commands WHERE command_id = ? LIMIT 1')
      .bind(commandId)
      .first<RawCommandRow>()
    if (!existing) {
      return {
        source: 'cloudflare',
        outcome: 'unknown',
        receipt: null
      }
    }
    if (existing.actor_id !== verifiedClaims.identityId) {
      throw new SecurityAnomalyError('forbidden')
    }
    if (existing.payload_hash !== payloadHash) {
      throw new SecurityAnomalyError('idempotency_conflict')
    }
    return {
      source: 'cloudflare',
      outcome: 'applied',
      receipt: JSON.parse(existing.receipt_json) as SecurityAnomalyReceipt
    }
  } catch (error) {
    if (error instanceof SecurityAnomalyError) throw error
    throw new SecurityAnomalyError('service_unavailable')
  }
}
