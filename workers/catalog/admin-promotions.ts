import {
  adminPromotionInputSchema,
  adminPromotionQuerySchema,
  adminPromotionListSchema,
  adminPromotionDetailSchema,
  adminPromotionReceiptSchema,
  adminPromotionIntentHash,
  type AdminPromotionInput
} from '../../shared/admin-promotions'
import { promotionRuleSchema } from '../../shared/promotions'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { promotionRuleHash } from './promotions'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export class AdminPromotionError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
type Options = { now?: string }
type CommandOptions = Options & { idempotencyKey: string }
const fail = (code: string): never => {
  throw new AdminPromotionError(code)
}
function parsed<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  code = 'invalid_input'
): T {
  const result = schema.safeParse(value)
  return result.success ? result.data : fail(code)
}
const actorSql = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND s.expires_at>COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.status IN ('active','pending') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage'
 AND r.granted_at<=COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND (r.expires_at IS NULL OR r.expires_at>COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))`
const binds = (claims: VerifiedSessionClaims, options: Options) =>
  [claims.sessionId, claims.identityId, claims.sessionVersion, options.now ?? null] as const
async function authorize(db: D1Database, claims: VerifiedSessionClaims, options: Options) {
  const auth = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    ...(options.now ? { now: options.now } : {})
  })
  if (!auth.allowed) fail(auth.code)
}
async function finalAuthority(db: D1Database, claims: VerifiedSessionClaims, options: Options) {
  if (
    !(await db
      .prepare(`SELECT 1 AS allowed WHERE ${actorSql}`)
      .bind(...binds(claims, options))
      .first())
  ) {
    await authorize(db, claims, options)
    fail('forbidden')
  }
}
interface VersionRow {
  rule_id: string
  code: string
  current_version: number
  rule_json: string
  rule_hash: string
  created_by: string
  created_at: string
  command_id: string
  actor_id: string
  expected_version: number
  applied_version: number
  payload_hash: string
  command_hash: string
  reason: string
  command_at: string
  audit_match: number
  head_created_at: string
  updated_at: string
  redemptions: number
  versions: number
  commands: number
  audits: number
}
const versionSql = `SELECT r.id rule_id,r.code,r.current_version,r.created_at head_created_at,r.updated_at,
 v.rule_json,v.rule_hash,v.created_by,v.created_at,c.command_id,c.actor_id,c.expected_version,c.applied_version,c.payload_hash,c.rule_hash command_hash,c.reason,c.created_at command_at,
 EXISTS(SELECT 1 FROM promotion_admin_audit a WHERE a.command_id=c.command_id AND a.rule_id=r.id AND a.version=v.version AND a.actor_id=c.actor_id
 AND a.rule_hash=c.rule_hash AND a.payload_hash=c.payload_hash AND a.reason=c.reason AND a.created_at=c.created_at) audit_match,
 (SELECT count(*) FROM promotion_redemptions u WHERE u.rule_id=r.id) redemptions,
 (SELECT count(*) FROM promotion_rule_versions x WHERE x.rule_id=r.id) versions,
 (SELECT count(*) FROM promotion_admin_commands x WHERE x.rule_id=r.id) commands,
 (SELECT count(*) FROM promotion_admin_audit x WHERE x.rule_id=r.id) audits
 FROM promotion_rules r JOIN promotion_rule_versions v ON v.rule_id=r.id
 LEFT JOIN promotion_admin_commands c ON c.rule_id=r.id AND c.applied_version=v.version`
async function verified(row: VersionRow | null) {
  if (!row) fail('not_found')
  const current = row!
  let json: unknown
  try {
    json = JSON.parse(current.rule_json)
  } catch {
    fail('history_unconfirmed')
  }
  const rule = parsed(promotionRuleSchema, json, 'history_unconfirmed')
  if (
    rule.id !== current.rule_id ||
    rule.code !== current.code ||
    rule.version !== current.applied_version ||
    rule.version !== current.expected_version + 1 ||
    current.created_by !== current.actor_id ||
    current.created_at !== current.command_at ||
    !current.audit_match ||
    current.rule_hash !== current.command_hash ||
    current.versions !== current.current_version ||
    current.commands !== current.current_version ||
    current.audits !== current.current_version ||
    (await promotionRuleHash(rule)) !== current.rule_hash ||
    (await adminPromotionIntentHash({ expectedVersion: current.expected_version, rule, reason: current.reason })) !==
      current.payload_hash
  )
    fail('history_unconfirmed')
  return rule
}
function receipt(row: VersionRow) {
  return parsed(
    adminPromotionReceiptSchema,
    {
      source: 'cloudflare',
      commandId: row.command_id,
      ruleId: row.rule_id,
      version: row.applied_version,
      ruleHash: row.rule_hash,
      payloadHash: row.payload_hash,
      createdAt: row.command_at
    },
    'history_unconfirmed'
  )
}
export async function readD1AdminPromotion(
  db: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  query: { historyPage?: number } = {},
  options: Options = {}
) {
  await authorize(db, claims, options)
  parsed(catalogPolicyUuidSchema, id)
  const historyPage = query.historyPage ?? 1
  if (!Number.isSafeInteger(historyPage) || historyPage < 1 || historyPage > 1000000) fail('invalid_input')
  const current = await db
    .prepare(versionSql + ' WHERE r.id=? AND v.version=r.current_version')
    .bind(id)
    .first<VersionRow>()
  const rule = await verified(current)
  const rows = await db
    .prepare(versionSql + ' WHERE r.id=? ORDER BY v.version DESC LIMIT 20 OFFSET ?')
    .bind(id, (historyPage - 1) * 20)
    .all<VersionRow>()
  const history = []
  for (const row of rows.results)
    history.push({ rule: await verified(row), reason: row.reason, createdAt: row.created_at })
  await finalAuthority(db, claims, options)
  return parsed(
    adminPromotionDetailSchema,
    {
      source: 'cloudflare',
      rule,
      redemptions: current!.redemptions,
      createdAt: current!.head_created_at,
      updatedAt: current!.updated_at,
      history,
      historyTotal: current!.current_version,
      historyPage
    },
    'history_unconfirmed'
  )
}
export async function listD1AdminPromotions(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown = {},
  options: Options = {}
) {
  await authorize(db, claims, options)
  const query = parsed(adminPromotionQuerySchema, raw)
  const match = `instr(r.code,?)>0 AND (?='all' OR json_extract(v.rule_json,'$.status')=?)`
  const parameters = [query.q.toUpperCase(), query.status, query.status]
  const total = await db
    .prepare(
      `SELECT count(*) total FROM promotion_rules r JOIN promotion_rule_versions v ON v.rule_id=r.id AND v.version=r.current_version WHERE ${match}`
    )
    .bind(...parameters)
    .first<{ total: number }>()
  const rows = await db
    .prepare(versionSql + ` WHERE v.version=r.current_version AND ${match} ORDER BY r.code,r.id LIMIT ? OFFSET ?`)
    .bind(...parameters, query.perPage, (query.page - 1) * query.perPage)
    .all<VersionRow>()
  const items = []
  for (const row of rows.results)
    items.push({
      rule: await verified(row),
      redemptions: row.redemptions,
      createdAt: row.head_created_at,
      updatedAt: row.updated_at
    })
  await finalAuthority(db, claims, options)
  return parsed(
    adminPromotionListSchema,
    { source: 'cloudflare', items, total: total?.total, page: query.page, perPage: query.perPage },
    'history_unconfirmed'
  )
}
export async function readD1AdminPromotionCommand(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: Options = {}
) {
  await authorize(db, claims, options)
  parsed(catalogPolicyUuidSchema, key)
  if (!/^[0-9a-f]{64}$/.test(hash)) fail('invalid_input')
  const row = await db
    .prepare(versionSql + ' WHERE c.command_id=? AND c.actor_id=?')
    .bind(key, claims.identityId)
    .first<VersionRow>()
  if (!row) {
    await finalAuthority(db, claims, options)
    return { source: 'cloudflare' as const, outcome: 'unknown' as const }
  }
  if (row.payload_hash !== hash) fail('idempotency_conflict')
  await verified(row)
  await finalAuthority(db, claims, options)
  return { source: 'cloudflare' as const, outcome: 'applied' as const, receipt: receipt(row) }
}
export async function executeD1AdminPromotion(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
) {
  await authorize(db, claims, options)
  const input: AdminPromotionInput = parsed(adminPromotionInputSchema, raw)
  parsed(catalogPolicyUuidSchema, options.idempotencyKey)
  const hash = await adminPromotionIntentHash(input),
    ruleHash = await promotionRuleHash(input.rule)
  const old = await db
    .prepare('SELECT actor_id,payload_hash FROM promotion_admin_commands WHERE command_id=?')
    .bind(options.idempotencyKey)
    .first<{ actor_id: string; payload_hash: string }>()
  if (old) {
    if (old.actor_id !== claims.identityId || old.payload_hash !== hash) fail('idempotency_conflict')
    const found = await readD1AdminPromotionCommand(db, claims, options.idempotencyKey, hash, options)
    return found.outcome === 'applied' ? found.receipt : fail('history_unconfirmed')
  }
  const head = await db
    .prepare('SELECT code,current_version FROM promotion_rules WHERE id=?')
    .bind(input.rule.id)
    .first<{ code: string; current_version: number }>()
  if ((head?.current_version ?? 0) !== input.expectedVersion) fail('version_conflict')
  if (head && head.code !== input.rule.code) fail('code_immutable')
  if (head) await readD1AdminPromotion(db, claims, input.rule.id, {}, options)
  if (input.rule.scope.kind !== 'all') {
    const table = input.rule.scope.kind === 'product' ? 'products' : 'categories'
    for (const id of input.rule.scope.ids)
      if (!(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first())) fail('scope_not_found')
  }
  const timeRow = await db
    .prepare("SELECT COALESCE(?,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now")
    .bind(options.now ?? null)
    .first<{ now: string }>()
  if (!timeRow) return fail('service_unavailable')
  const now = timeRow.now,
    { rule } = input,
    key = options.idempotencyKey
  const prepare = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values)
  const start = head
    ? prepare(
        `UPDATE promotion_rules SET current_version=?5,updated_at=?6 WHERE id=?7 AND code=?8 AND current_version=?9 AND ${actorSql}`,
        ...binds(claims, options),
        rule.version,
        now,
        rule.id,
        rule.code,
        input.expectedVersion
      )
    : prepare(
        `INSERT INTO promotion_rules(id,code,current_version,created_at,updated_at) SELECT ?5,?6,1,?7,?7 WHERE ${actorSql}`,
        ...binds(claims, options),
        rule.id,
        rule.code,
        now
      )
  try {
    await db.batch([
      start,
      prepare(
        'INSERT INTO promotion_rule_versions(rule_id,version,rule_json,rule_hash,created_by,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1',
        rule.id,
        rule.version,
        JSON.stringify(rule),
        ruleHash,
        claims.identityId,
        now
      ),
      prepare(
        `INSERT INTO promotion_admin_commands(command_id,rule_id,actor_id,session_id,session_version,expected_version,applied_version,payload_hash,rule_hash,reason,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`,
        key,
        rule.id,
        claims.identityId,
        claims.sessionId,
        claims.sessionVersion,
        input.expectedVersion,
        rule.version,
        hash,
        ruleHash,
        input.reason,
        now
      ),
      prepare(
        'INSERT INTO promotion_admin_audit(command_id,rule_id,version,actor_id,rule_hash,payload_hash,reason,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1',
        key,
        rule.id,
        rule.version,
        claims.identityId,
        ruleHash,
        hash,
        input.reason,
        now
      ),
      prepare(
        `INSERT INTO promotion_admin_guards(command_id,valid) SELECT ?5,CASE WHEN changes()=1 AND ${actorSql}
        AND EXISTS(SELECT 1 FROM promotion_admin_audit WHERE command_id=?5 AND rule_id=?6 AND version=?7) THEN 1 ELSE 0 END`,
        ...binds(claims, options),
        key,
        rule.id,
        rule.version
      ),
      prepare('DELETE FROM promotion_admin_guards WHERE command_id=?', key)
    ])
  } catch {
    await authorize(db, claims, options)
    const replay = await db
      .prepare('SELECT actor_id,payload_hash FROM promotion_admin_commands WHERE command_id=?')
      .bind(key)
      .first<{ actor_id: string; payload_hash: string }>()
    if (replay && (replay.actor_id !== claims.identityId || replay.payload_hash !== hash)) fail('idempotency_conflict')
    if (replay) {
      const found = await readD1AdminPromotionCommand(db, claims, key, hash, options)
      return found.outcome === 'applied' ? found.receipt : fail('history_unconfirmed')
    }
    const current = await db
      .prepare('SELECT current_version FROM promotion_rules WHERE id=?')
      .bind(rule.id)
      .first<{ current_version: number }>()
    if ((current?.current_version ?? 0) !== input.expectedVersion) fail('version_conflict')
    if (await db.prepare('SELECT 1 FROM promotion_rules WHERE code=? AND id<>?').bind(rule.code, rule.id).first())
      fail('code_conflict')
    fail('service_unavailable')
  }
  const applied = await readD1AdminPromotionCommand(db, claims, key, hash, options)
  return applied.outcome === 'applied' ? applied.receipt : fail('history_unconfirmed')
}
