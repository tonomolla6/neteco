import {
  API_KEY_MAX_ACTIVE_PER_COMPANY,
  API_KEY_MAX_LIFETIME_DAYS,
  createApiKeyInputSchema,
  ipMatchesAllowlist,
  parseApiKey,
  revokeApiKeyInputSchema,
  rotateApiKeyInputSchema,
  updateApiKeyPolicyInputSchema,
  type ApiKeyScope
} from '../../shared/security-b2b-api-keys'
import {
  SecurityControlError,
  adminExistsSql,
  assertSecret,
  hmacSha256Hex,
  parseInput,
  payloadHash,
  plusDays,
  plusSeconds,
  randomBytes,
  requireAdmin,
  timingSafeEqualHex,
  toBase64Url,
  toHex,
  type CommandRow
} from './controls-common'

export interface ApiKeyView {
  id: string
  companyId: string
  name: string
  prefix: string
  scopes: ApiKeyScope[]
  allowedIps: string[] | null
  quotaPerMinute: number
  quotaPerDay: number
  status: 'active' | 'rotated' | 'revoked'
  expiresAt: string
  revokedAt: string | null
  revokeReason: string | null
  rotatedToId: string | null
  lastUsedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

interface KeyRow {
  id: string
  company_id: string
  name: string
  key_prefix: string
  key_hash: string
  scopes_json: string
  allowed_ips_json: string | null
  quota_per_minute: number
  quota_per_day: number
  status: 'active' | 'rotated' | 'revoked'
  expires_at: string
  revoked_at: string | null
  revoke_reason: string | null
  rotated_to_id: string | null
  version: number
  created_at: string
  updated_at: string
  last_used_at: string | null
}

export interface ApiKeyAdminContext {
  actorIdentityId: string
  now: string
  pepper: string
}

const KEY_SELECT = `SELECT k.*, u.last_used_at FROM b2b_api_keys k LEFT JOIN b2b_api_key_last_use u ON u.key_id=k.id`

function toView(row: KeyRow): ApiKeyView {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: JSON.parse(row.scopes_json) as ApiKeyScope[],
    allowedIps: row.allowed_ips_json ? (JSON.parse(row.allowed_ips_json) as string[]) : null,
    quotaPerMinute: row.quota_per_minute,
    quotaPerDay: row.quota_per_day,
    status: row.status,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    rotatedToId: row.rotated_to_id,
    lastUsedAt: row.last_used_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** D1 positional placeholders must match the statement exactly: bind the prefix it references. */
function statement(database: D1Database, sql: string, params: unknown[]) {
  const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))
  return database.prepare(sql).bind(...params.slice(0, highest))
}

async function readRow(database: D1Database, id: string): Promise<KeyRow | null> {
  return database.prepare(`${KEY_SELECT} WHERE k.id=?1`).bind(id).first<KeyRow>()
}

async function readCommand(database: D1Database, commandId: string) {
  return database
    .prepare(
      `SELECT command_id, kind, payload_hash, key_id, result_key_id FROM b2b_api_key_commands WHERE command_id=?1`
    )
    .bind(commandId)
    .first<CommandRow>()
}

async function view(database: D1Database, id: string): Promise<ApiKeyView> {
  const row = await readRow(database, id)
  if (!row) throw new SecurityControlError('api_key_not_found', 404)
  return toView(row)
}

function assertExpiry(expiresAt: string, now: string) {
  if (!(expiresAt > now) || expiresAt > plusDays(now, API_KEY_MAX_LIFETIME_DAYS)) {
    throw new SecurityControlError('invalid_expiry', 400)
  }
}

async function newSecret(pepper: string) {
  const prefix = `ntk_${toHex(randomBytes(4))}`
  const secret = toBase64Url(randomBytes(32))
  return { prefix, secret, presented: `${prefix}_${secret}`, hash: await hmacSha256Hex(pepper, secret) }
}

function replayOrConflict(command: CommandRow | null, hash: string): CommandRow | null {
  if (!command) return null
  if (command.payload_hash !== hash) throw new SecurityControlError('idempotency_conflict', 409)
  return command
}

export async function createApiKey(
  database: D1Database,
  rawInput: unknown,
  context: ApiKeyAdminContext
): Promise<{ key: ApiKeyView; secret: string | null; replayed: boolean }> {
  const input = parseInput(createApiKeyInputSchema, rawInput)
  assertSecret(context.pepper)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const hash = await payloadHash('create', input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) return { key: await view(database, replay.key_id!), secret: null, replayed: true }

  assertExpiry(input.expiresAt, context.now)
  const company = await database
    .prepare(`SELECT status FROM companies WHERE id=?1`)
    .bind(input.companyId)
    .first<{ status: string }>()
  if (!company) throw new SecurityControlError('company_not_found', 404)
  if (company.status !== 'approved') throw new SecurityControlError('company_not_approved', 409)

  const secret = await newSecret(context.pepper)
  const id = crypto.randomUUID()
  const params = [
    id, // 1
    input.companyId, // 2
    input.name, // 3
    secret.prefix, // 4
    secret.hash, // 5
    JSON.stringify(input.scopes), // 6
    input.allowedIps ? JSON.stringify(input.allowedIps) : null, // 7
    input.quotaPerMinute, // 8
    input.quotaPerDay, // 9
    input.expiresAt, // 10
    context.actorIdentityId, // 11
    context.now, // 12
    crypto.randomUUID(), // 13 audit id
    JSON.stringify({ name: input.name, scopes: input.scopes, expiresAt: input.expiresAt, prefix: secret.prefix }), // 14
    input.commandId, // 15
    hash // 16
  ]
  await database.batch([
    statement(
      database,
      `INSERT INTO b2b_api_keys(id, company_id, name, key_prefix, key_hash, scopes_json, allowed_ips_json,
         quota_per_minute, quota_per_day, status, expires_at, created_by, version, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11, 1, ?12, ?12
       WHERE ${adminExistsSql('?11', '?12')}
         AND EXISTS(SELECT 1 FROM companies WHERE id=?2 AND status='approved')
         AND (SELECT COUNT(*) FROM b2b_api_keys WHERE company_id=?2 AND status='active')<${API_KEY_MAX_ACTIVE_PER_COMPANY}`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_audit(id, key_id, actor_identity_id, action, detail_json, created_at)
       SELECT ?13, ?1, ?11, 'created', ?14, ?12 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?1)`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_commands(command_id, kind, payload_hash, key_id, result_key_id, created_at)
       SELECT ?15, 'create', ?16, ?1, NULL, ?12 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?1)`,
      params
    )
  ])
  const written = await readCommand(database, input.commandId)
  if (!written || written.key_id !== id) {
    const count = await database
      .prepare(`SELECT COUNT(*) c FROM b2b_api_keys WHERE company_id=?1 AND status='active'`)
      .bind(input.companyId)
      .first<{ c: number }>()
    if ((count?.c ?? 0) >= API_KEY_MAX_ACTIVE_PER_COMPANY) throw new SecurityControlError('key_limit_reached', 409)
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('company_not_approved', 409)
  }
  return { key: await view(database, id), secret: secret.presented, replayed: false }
}

export async function rotateApiKey(
  database: D1Database,
  rawInput: unknown,
  context: ApiKeyAdminContext
): Promise<{ oldKey: ApiKeyView; newKey: ApiKeyView; secret: string | null; replayed: boolean }> {
  const input = parseInput(rotateApiKeyInputSchema, rawInput)
  assertSecret(context.pepper)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const hash = await payloadHash('rotate', input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) {
    return {
      oldKey: await view(database, replay.key_id!),
      newKey: await view(database, replay.result_key_id!),
      secret: null,
      replayed: true
    }
  }
  const old = await readRow(database, input.keyId)
  if (!old) throw new SecurityControlError('api_key_not_found', 404)
  if (old.status !== 'active') throw new SecurityControlError('key_not_active', 409)
  if (old.version !== input.expectedVersion) throw new SecurityControlError('version_conflict', 409)
  const newExpiresAt = input.newExpiresAt ?? old.expires_at
  assertExpiry(newExpiresAt, context.now)

  const secret = await newSecret(context.pepper)
  const newId = crypto.randomUUID()
  const graceful = input.graceSeconds > 0
  const graceEnd = plusSeconds(context.now, input.graceSeconds)
  const params = [
    input.keyId, // 1
    input.expectedVersion, // 2
    context.now, // 3
    context.actorIdentityId, // 4
    newId, // 5
    graceful ? 'rotated' : 'revoked', // 6
    graceful && graceEnd < old.expires_at ? graceEnd : old.expires_at, // 7
    graceful ? null : context.now, // 8
    graceful ? null : 'rotated', // 9
    secret.prefix, // 10
    secret.hash, // 11
    newExpiresAt, // 12
    crypto.randomUUID(), // 13 audit old
    crypto.randomUUID(), // 14 audit new
    JSON.stringify({ rotatedToPrefix: secret.prefix, graceSeconds: input.graceSeconds }), // 15
    JSON.stringify({ rotatedFrom: old.key_prefix, prefix: secret.prefix, expiresAt: newExpiresAt }), // 16
    input.commandId, // 17
    hash // 18
  ]
  await database.batch([
    statement(
      database,
      `UPDATE b2b_api_keys SET status=?6, expires_at=?7, revoked_at=?8, revoke_reason=?9, rotated_to_id=?5,
         version=version+1, updated_at=?3
       WHERE id=?1 AND version=?2 AND status='active' AND ${adminExistsSql('?4', '?3')}`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_keys(id, company_id, name, key_prefix, key_hash, scopes_json, allowed_ips_json,
         quota_per_minute, quota_per_day, status, expires_at, created_by, version, created_at, updated_at)
       SELECT ?5, o.company_id, o.name, ?10, ?11, o.scopes_json, o.allowed_ips_json, o.quota_per_minute,
         o.quota_per_day, 'active', ?12, ?4, 1, ?3, ?3
       FROM b2b_api_keys o WHERE o.id=?1 AND o.rotated_to_id=?5 AND o.version=?2+1`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_audit(id, key_id, actor_identity_id, action, detail_json, created_at)
       SELECT ?13, ?1, ?4, 'rotated', ?15, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?5)`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_audit(id, key_id, actor_identity_id, action, detail_json, created_at)
       SELECT ?14, ?5, ?4, 'created', ?16, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?5)`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_commands(command_id, kind, payload_hash, key_id, result_key_id, created_at)
       SELECT ?17, 'rotate', ?18, ?1, ?5, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?5)`,
      params
    )
  ])
  const written = await readCommand(database, input.commandId)
  if (!written) {
    const current = await readRow(database, input.keyId)
    if (current && current.version !== input.expectedVersion) throw new SecurityControlError('version_conflict', 409)
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('key_not_active', 409)
  }
  return {
    oldKey: await view(database, input.keyId),
    newKey: await view(database, newId),
    secret: secret.presented,
    replayed: false
  }
}

export async function revokeApiKey(
  database: D1Database,
  rawInput: unknown,
  context: Omit<ApiKeyAdminContext, 'pepper'> & { pepper?: string }
): Promise<{ key: ApiKeyView; replayed: boolean }> {
  const input = parseInput(revokeApiKeyInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const hash = await payloadHash('revoke', input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) return { key: await view(database, replay.key_id!), replayed: true }

  // A concurrent rotation may bump the version between read and write: retry on the fresh row.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await readRow(database, input.keyId)
    if (!row) throw new SecurityControlError('api_key_not_found', 404)
    if (row.status === 'revoked') throw new SecurityControlError('already_revoked', 409)
    const params = [
      input.keyId, // 1
      row.version, // 2
      context.now, // 3
      context.actorIdentityId, // 4
      input.reason, // 5
      crypto.randomUUID(), // 6 audit id
      JSON.stringify({ reason: input.reason, prefix: row.key_prefix }), // 7
      input.commandId, // 8
      hash // 9
    ]
    await database.batch([
      statement(
        database,
        `UPDATE b2b_api_keys SET status='revoked', revoked_at=?3, revoke_reason=?5, version=version+1, updated_at=?3
         WHERE id=?1 AND version=?2 AND status IN ('active','rotated') AND ${adminExistsSql('?4', '?3')}`,
        params
      ),
      statement(
        database,
        `INSERT INTO b2b_api_key_audit(id, key_id, actor_identity_id, action, detail_json, created_at)
         SELECT ?6, ?1, ?4, 'revoked', ?7, ?3
         WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?1 AND status='revoked' AND version=?2+1 AND revoked_at=?3 AND revoke_reason=?5)
           AND NOT EXISTS(SELECT 1 FROM b2b_api_key_audit WHERE key_id=?1 AND action='revoked')`,
        params
      ),
      statement(
        database,
        `INSERT INTO b2b_api_key_commands(command_id, kind, payload_hash, key_id, result_key_id, created_at)
         SELECT ?8, 'revoke', ?9, ?1, NULL, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_key_audit WHERE id=?6)`,
        params
      )
    ])
    if (await readCommand(database, input.commandId)) return { key: await view(database, input.keyId), replayed: false }
    await requireAdmin(database, context.actorIdentityId, context.now)
  }
  throw new SecurityControlError('version_conflict', 409)
}

export async function updateApiKeyPolicy(
  database: D1Database,
  rawInput: unknown,
  context: Omit<ApiKeyAdminContext, 'pepper'> & { pepper?: string }
): Promise<{ key: ApiKeyView; replayed: boolean }> {
  const input = parseInput(updateApiKeyPolicyInputSchema, rawInput)
  await requireAdmin(database, context.actorIdentityId, context.now)
  const hash = await payloadHash('update_policy', input)
  const replay = replayOrConflict(await readCommand(database, input.commandId), hash)
  if (replay) return { key: await view(database, replay.key_id!), replayed: true }

  const row = await readRow(database, input.keyId)
  if (!row) throw new SecurityControlError('api_key_not_found', 404)
  if (row.status !== 'active') throw new SecurityControlError('key_not_active', 409)
  if (row.version !== input.expectedVersion) throw new SecurityControlError('version_conflict', 409)
  const before = toView(row)
  const scopes = input.scopes ?? before.scopes
  const allowedIps = input.allowedIps === undefined ? before.allowedIps : input.allowedIps
  const quotaPerMinute = input.quotaPerMinute ?? before.quotaPerMinute
  const quotaPerDay = input.quotaPerDay ?? before.quotaPerDay
  const params = [
    input.keyId, // 1
    input.expectedVersion, // 2
    context.now, // 3
    context.actorIdentityId, // 4
    JSON.stringify(scopes), // 5
    allowedIps ? JSON.stringify(allowedIps) : null, // 6
    quotaPerMinute, // 7
    quotaPerDay, // 8
    crypto.randomUUID(), // 9 audit id
    JSON.stringify({
      before: {
        scopes: before.scopes,
        allowedIps: before.allowedIps,
        quotaPerMinute: before.quotaPerMinute,
        quotaPerDay: before.quotaPerDay
      },
      after: { scopes, allowedIps, quotaPerMinute, quotaPerDay }
    }), // 10
    input.commandId, // 11
    hash // 12
  ]
  await database.batch([
    statement(
      database,
      `UPDATE b2b_api_keys SET scopes_json=?5, allowed_ips_json=?6, quota_per_minute=?7, quota_per_day=?8,
         version=version+1, updated_at=?3
       WHERE id=?1 AND version=?2 AND status='active' AND ${adminExistsSql('?4', '?3')}`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_audit(id, key_id, actor_identity_id, action, detail_json, created_at)
       SELECT ?9, ?1, ?4, 'policy_updated', ?10, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_keys WHERE id=?1 AND version=?2+1)`,
      params
    ),
    statement(
      database,
      `INSERT INTO b2b_api_key_commands(command_id, kind, payload_hash, key_id, result_key_id, created_at)
       SELECT ?11, 'update_policy', ?12, ?1, NULL, ?3 WHERE EXISTS(SELECT 1 FROM b2b_api_key_audit WHERE id=?9)`,
      params
    )
  ])
  if (!(await readCommand(database, input.commandId))) {
    await requireAdmin(database, context.actorIdentityId, context.now)
    throw new SecurityControlError('version_conflict', 409)
  }
  return { key: await view(database, input.keyId), replayed: false }
}

export type ApiKeyAuthResult =
  | { ok: true; key: { id: string; companyId: string; scopes: ApiKeyScope[] } }
  | { ok: false; code: string; status: number; retryAfterSeconds?: number }

async function consume(database: D1Database, keyId: string, kind: 'minute' | 'day', bucket: string, limit: number) {
  const row = await database
    .prepare(
      `INSERT INTO b2b_api_key_usage(key_id, bucket_kind, bucket_start, request_count) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(key_id, bucket_kind, bucket_start) DO UPDATE SET request_count=request_count+1
       WHERE request_count<?4 RETURNING request_count`
    )
    .bind(keyId, kind, bucket, limit)
    .first<{ request_count: number }>()
  return row !== null
}

/**
 * Every call re-reads the key, its company and its quotas: revocation, expiry and scope changes are
 * effective on the very next request. Failures never reveal whether a prefix exists.
 */
export async function authenticateApiKey(
  database: D1Database,
  request: { presented: string; requiredScope: ApiKeyScope; ip: string | null },
  context: { now: string; pepper: string }
): Promise<ApiKeyAuthResult> {
  assertSecret(context.pepper)
  const invalid: ApiKeyAuthResult = { ok: false, code: 'invalid_api_key', status: 401 }
  const parsed = parseApiKey(request.presented)
  if (!parsed) return invalid
  const row = await database
    .prepare(
      `SELECT k.*, c.status AS company_status FROM b2b_api_keys k JOIN companies c ON c.id=k.company_id WHERE k.key_prefix=?1`
    )
    .bind(parsed.prefix)
    .first<KeyRow & { company_status: string }>()
  if (!row) return invalid
  if (!timingSafeEqualHex(await hmacSha256Hex(context.pepper, parsed.secret), row.key_hash)) return invalid
  if (row.status === 'revoked') return { ok: false, code: 'api_key_revoked', status: 401 }
  if (row.expires_at <= context.now) return { ok: false, code: 'api_key_expired', status: 401 }
  if (row.company_status !== 'approved') return { ok: false, code: 'company_not_approved', status: 403 }
  if (row.allowed_ips_json && !ipMatchesAllowlist(request.ip, JSON.parse(row.allowed_ips_json) as string[])) {
    return { ok: false, code: 'ip_not_allowed', status: 403 }
  }
  const scopes = JSON.parse(row.scopes_json) as ApiKeyScope[]
  if (!scopes.includes(request.requiredScope)) return { ok: false, code: 'insufficient_scope', status: 403 }

  // Minute bucket first: a rate-limited caller must not burn its daily quota by retrying.
  const seconds = Number(context.now.slice(17, 19))
  if (!(await consume(database, row.id, 'minute', `${context.now.slice(0, 16)}:00Z`, row.quota_per_minute))) {
    return { ok: false, code: 'quota_exceeded', status: 429, retryAfterSeconds: 60 - seconds }
  }
  if (!(await consume(database, row.id, 'day', context.now.slice(0, 10), row.quota_per_day))) {
    const sinceMidnight = Number(context.now.slice(11, 13)) * 3600 + Number(context.now.slice(14, 16)) * 60 + seconds
    return { ok: false, code: 'quota_exceeded', status: 429, retryAfterSeconds: 86_400 - sinceMidnight }
  }
  // Revocation that landed while the quota was being consumed still wins.
  const after = await database
    .prepare(`SELECT status FROM b2b_api_keys WHERE id=?1`)
    .bind(row.id)
    .first<{ status: string }>()
  if (!after || after.status === 'revoked') return { ok: false, code: 'api_key_revoked', status: 401 }
  await database
    .prepare(
      `INSERT INTO b2b_api_key_last_use(key_id, last_used_at) VALUES (?1, ?2)
       ON CONFLICT(key_id) DO UPDATE SET last_used_at=excluded.last_used_at WHERE excluded.last_used_at>last_used_at`
    )
    .bind(row.id, context.now)
    .run()
  return { ok: true, key: { id: row.id, companyId: row.company_id, scopes } }
}

export async function listApiKeys(
  database: D1Database,
  filter: { companyId?: string; limit?: number }
): Promise<ApiKeyView[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200)
  const { results } = await database
    .prepare(`${KEY_SELECT} WHERE (?1 IS NULL OR k.company_id=?1) ORDER BY k.created_at DESC, k.rowid DESC LIMIT ?2`)
    .bind(filter.companyId ?? null, limit)
    .all<KeyRow>()
  return results.map(toView)
}

export interface ApiKeyAuditEntry {
  id: string
  keyId: string
  actorIdentityId: string | null
  action: string
  detail: Record<string, unknown>
  createdAt: string
}

export async function listApiKeyAudit(database: D1Database, keyId: string): Promise<ApiKeyAuditEntry[]> {
  const { results } = await database
    .prepare(
      `SELECT id, key_id, actor_identity_id, action, detail_json, created_at FROM b2b_api_key_audit
       WHERE key_id=?1 ORDER BY created_at, rowid LIMIT 500`
    )
    .bind(keyId)
    .all<{
      id: string
      key_id: string
      actor_identity_id: string | null
      action: string
      detail_json: string
      created_at: string
    }>()
  return results.map((row) => ({
    id: row.id,
    keyId: row.key_id,
    actorIdentityId: row.actor_identity_id,
    action: row.action,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at
  }))
}

/** Counters only matter for the current minute/day; drop old buckets. Safe to run from a cron. */
export async function pruneApiKeyUsage(database: D1Database, now: string): Promise<void> {
  await database
    .prepare(
      `DELETE FROM b2b_api_key_usage WHERE (bucket_kind='minute' AND bucket_start<?1) OR (bucket_kind='day' AND bucket_start<?2)`
    )
    .bind(plusDays(now, -2), plusDays(now, -40).slice(0, 10))
    .run()
}
