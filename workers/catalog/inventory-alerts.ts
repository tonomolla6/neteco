import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  inventoryAlertsQuerySchema,
  inventoryAlertsResponseSchema,
  inventoryAlertPolicyResponseSchema,
  inventoryAlertCommandReceiptSchema,
  inventoryAlertCommandResponseSchema,
  inventoryAlertThresholdInputSchema,
  inventoryAlertIntentHash,
  parseInventoryAlertInput,
  type InventoryAlertAction,
  type InventoryAlertCommandReceipt
} from '../../shared/inventory-alerts'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { inventoryPositionCtes } from './inventory-position-sql'

export type InventoryAlertsErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'alert_not_current'
  | 'warehouse_unavailable'
  | 'unavailable'
export class InventoryAlertsError extends Error {
  constructor(public code: InventoryAlertsErrorCode) {
    super(code)
  }
}
export interface InventoryAlertsOptions {
  now?: () => string
}
const instant = (o: InventoryAlertsOptions) =>
  catalogPolicyInstantSchema.parse(o.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
function checked<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new InventoryAlertsError('invalid_input')
  return result.data
}
const claimsSchema = z
  .object({
    identityId: catalogPolicyUuidSchema,
    sessionId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().positive()
  })
  .strict()
const sqlClock = "COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actor = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND i.session_version=s.session_version
 AND s.revoked_at IS NULL AND s.created_at<=${sqlClock} AND s.expires_at>${sqlClock} AND i.status IN ('active','pending')
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${sqlClock} AND s.mfa_verified=1
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND r.granted_at<=${sqlClock} AND (r.expires_at IS NULL OR r.expires_at>${sqlClock}) AND p.permission_code=?5)`
function actorParams(c: VerifiedSessionClaims, permission: string, o: InventoryAlertsOptions) {
  return [c.sessionId, c.identityId, c.sessionVersion, o.now ? instant(o) : null, permission]
}
async function authorize(db: D1Database, c: VerifiedSessionClaims, permission: string, o: InventoryAlertsOptions) {
  checked(claimsSchema, c)
  const a = await authorizeD1Session(db, c, permission, { now: instant(o), requireMfa: true })
  if (!a.allowed) throw new InventoryAlertsError(a.code)
}
async function finalCapabilities(db: D1Database, c: VerifiedSessionClaims, o: InventoryAlertsOptions) {
  const row = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=?2 AND r.granted_at<=${sqlClock} AND (r.expires_at IS NULL OR r.expires_at>${sqlClock}) AND p.permission_code='inventory.write') AS writable WHERE EXISTS(${actor})`
    )
    .bind(...actorParams(c, 'inventory.read', o))
    .first<{ writable: number }>()
  if (!row) {
    await authorize(db, c, 'inventory.read', o)
    throw new InventoryAlertsError('forbidden')
  }
  return { inventoryRead: true as const, inventoryWrite: row.writable === 1 }
}
interface Fact {
  variant_id: string
  legacy_id: number
  sku: string
  threshold: number | null
  policy_version: number
  policy_updated: string | null
  sellable: number | null
  current_kind: 'low' | 'out_of_stock' | 'anomaly' | null
  episode_id: string | null
  episode_kind: string | null
  episode_state: string | null
  episode_version: number | null
  episode_created: string | null
  episode_updated: string | null
  policy_confirmed: number
  episode_confirmed: number
  snapshot: string
}
// These are projections, not an independent source of alert history. Read only
// the version/kind/state actually backed by its immutable command and audit.
const policyProof = `(p.variant_id IS NULL OR EXISTS(
 SELECT 1 FROM inventory_alert_commands pc JOIN inventory_alert_audit pa ON pa.command_id=pc.id
 WHERE pc.id=p.command_id AND pc.action='threshold' AND pc.source='admin'
 AND pc.target_id=CAST(v.legacy_id AS TEXT) AND pc.created_at=p.updated_at
 AND json_extract(pc.input,'$.expectedVersion')=p.version-1
 AND json_extract(pc.input,'$.threshold') IS p.threshold AND json_type(pc.input,'$.threshold') IS NOT NULL
 AND json_extract(pc.response,'$.version')=p.version
 AND pa.variant_id=p.variant_id AND pa.episode_id IS NULL AND pa.action='threshold' AND pa.created_at=p.updated_at
 AND json_extract(pa.after_state,'$.version')=p.version AND json_extract(pa.after_state,'$.threshold') IS p.threshold
 AND json_type(pa.after_state,'$.threshold') IS NOT NULL))`
const episodeProof = `(e.id IS NULL OR EXISTS(
 SELECT 1 FROM inventory_alert_commands ec JOIN inventory_alert_audit ea ON ea.command_id=ec.id
 WHERE ec.id=e.command_id AND ec.created_at=e.updated_at
 AND ((ec.action='ack' AND ec.target_id=e.id) OR (ec.action='threshold' AND ec.target_id=CAST(v.legacy_id AS TEXT)) OR (ec.action='evaluate' AND ec.target_id='warehouse'))
 AND ea.episode_id=e.id AND ea.variant_id=e.variant_id AND ea.created_at=e.updated_at
 AND ea.action IN ('opened','changed','resolved','ack')
 AND json_extract(ea.after_state,'$.kind')=e.kind AND json_extract(ea.after_state,'$.state')=e.state
 AND json_extract(ea.after_state,'$.version')=e.version
 AND EXISTS(SELECT 1 FROM inventory_alert_audit opened WHERE opened.episode_id=e.id AND opened.variant_id=e.variant_id AND opened.action='opened' AND opened.created_at=e.created_at)))`
const factsCtes = () => `${inventoryPositionCtes()}, alert_facts AS MATERIALIZED (
 SELECT v.id AS variant_id,v.legacy_id,v.sku,p.threshold,COALESCE(p.version,0) AS policy_version,p.updated_at AS policy_updated,
 CASE WHEN ${policyProof} THEN 1 ELSE 0 END AS policy_confirmed, CASE WHEN ${episodeProof} THEN 1 ELSE 0 END AS episode_confirmed,
 CASE WHEN b.variant_id IS NULL THEN NULL ELSE f.sellable_quantity END AS sellable,
 CASE WHEN f.ledger_divergent=1 OR f.availability_deficit=1 THEN 'anomaly'
 WHEN b.variant_id IS NOT NULL AND p.threshold IS NOT NULL AND f.sellable_quantity=0 THEN 'out_of_stock'
 WHEN b.variant_id IS NOT NULL AND p.threshold IS NOT NULL AND f.sellable_quantity<=p.threshold THEN 'low' ELSE NULL END AS current_kind,
 e.id AS episode_id,e.kind AS episode_kind,e.state AS episode_state,e.version AS episode_version,e.created_at AS episode_created,e.updated_at AS episode_updated,
 json_array(v.id,v.legacy_id,v.sku,v.safety_stock,v.backorder_allowed,b.version,b.physical_quantity,b.blocked_quantity,
 f.reserved_quantity,f.sellable_quantity,f.ledger_divergent,f.availability_deficit,p.threshold,p.version,p.command_id,e.id,e.kind,e.state,e.version,e.command_id) AS snapshot
 FROM variants v LEFT JOIN inventory_alert_policies p ON p.variant_id=v.id
 LEFT JOIN inventory_flags f ON f.variant_id=v.id LEFT JOIN inventory_balances b ON b.variant_id=f.variant_id AND b.location_id=f.location_id
 LEFT JOIN inventory_alert_episodes e ON e.variant_id=v.id AND e.state<>'resolved'
 WHERE v.legacy_id IS NOT NULL
)`
async function warehouse(db: D1Database) {
  const row = await db
    .prepare(
      `WITH ${inventoryPositionCtes()} SELECT l.id,l.code,l.name FROM inventory_locations l WHERE l.active=1 AND (SELECT available FROM inventory_scope)=1`
    )
    .first<{ id: string; code: string; name: string }>()
  if (!row) throw new InventoryAlertsError('warehouse_unavailable')
  return row
}
async function facts(db: D1Database, after: number, limit: number, legacy?: number) {
  const r = await db
    .prepare(
      `WITH ${factsCtes()} SELECT * FROM alert_facts WHERE legacy_id>?1 AND (?2 IS NULL OR legacy_id=?2) ORDER BY legacy_id LIMIT ?3`
    )
    .bind(after, legacy ?? null, limit)
    .all<Fact>()
  if (!r.success) throw new Error('inventory_alert_source_invalid')
  if (r.results.some((f) => f.policy_confirmed !== 1 || f.episode_confirmed !== 1))
    throw new Error('inventory_alert_projection_invalid')
  return r.results
}
export async function readD1InventoryAlertPolicy(
  db: D1Database,
  c: VerifiedSessionClaims,
  variantId: number,
  o: InventoryAlertsOptions = {}
) {
  checked(z.number().int().positive().safe(), variantId)
  await authorize(db, c, 'inventory.read', o)
  await warehouse(db)
  const f = (await facts(db, 0, 1, variantId))[0]
  if (!f) throw new InventoryAlertsError('not_found')
  const capabilities = await finalCapabilities(db, c, o)
  return inventoryAlertPolicyResponseSchema.parse({
    source: 'cloudflare',
    variantId,
    version: f.policy_version,
    threshold: f.threshold,
    updatedAt: f.policy_updated,
    capabilities
  })
}
export async function readD1InventoryAlerts(
  db: D1Database,
  c: VerifiedSessionClaims,
  rawQuery: unknown = {},
  o: InventoryAlertsOptions = {}
) {
  const q = checked(inventoryAlertsQuerySchema, rawQuery)
  await authorize(db, c, 'inventory.read', o)
  const w = await warehouse(db)
  const predicate = `(?1='all' OR e.state=?1) AND (?2 IS NULL OR e.kind=?2) AND (instr(lower(v.sku),lower(?3))>0 OR instr(lower(pr.name),lower(?3))>0) AND (?6 IS NULL OR e.id=?6)`
  const result = await db
    .prepare(
      `WITH ${factsCtes()}, matching AS MATERIALIZED (
 SELECT e.*,v.legacy_id,v.sku,f.threshold,f.sellable,f.current_kind,CASE WHEN ${episodeProof} AND f.policy_confirmed=1 THEN 1 ELSE 0 END AS projection_confirmed FROM inventory_alert_episodes e JOIN variants v ON v.id=e.variant_id JOIN products pr ON pr.id=v.product_id JOIN alert_facts f ON f.variant_id=e.variant_id WHERE ${predicate})
 SELECT (SELECT count(*) FROM matching) AS total,(SELECT max(evaluated_at) FROM inventory_alert_evaluations) AS lastEvaluationAt,
 (SELECT count(*) FROM matching WHERE projection_confirmed<>1) AS invalid,
 COALESCE((SELECT json_group_array(json_object('id',id,'variantId',legacy_id,'sku',sku,'kind',kind,'state',state,'version',version,'threshold',threshold,'sellableQuantity',sellable,'currentKind',current_kind,'createdAt',created_at,'updatedAt',updated_at,'to','/admin/inventario?variantId='||legacy_id)) FROM (SELECT * FROM matching ORDER BY updated_at DESC,id DESC LIMIT ?4 OFFSET ?5)),json('[]')) AS items`
    )
    .bind(q.state, q.kind ?? null, q.q, q.perPage, (q.page - 1) * q.perPage, q.alertId ?? null)
    .first<{ total: number; lastEvaluationAt: string | null; items: string; invalid: number }>()
  if (!result) throw new Error('inventory_alert_source_invalid')
  if (result.invalid !== 0) throw new Error('inventory_alert_projection_invalid')
  const capabilities = await finalCapabilities(db, c, o)
  return inventoryAlertsResponseSchema.parse({
    source: 'cloudflare',
    evaluatedAt: instant(o),
    lastEvaluationAt: result.lastEvaluationAt,
    warehouse: w,
    capabilities,
    items: JSON.parse(result.items),
    pagination: { page: q.page, perPage: q.perPage, total: result.total, pages: Math.ceil(result.total / q.perPage) }
  })
}
async function lookup(db: D1Database, c: VerifiedSessionClaims, key: string, hash: string, o: InventoryAlertsOptions) {
  const row = await db
    .prepare(
      `SELECT c.actor_id,c.payload_hash,c.response,c.action,c.target_id,
 (SELECT count(*) FROM inventory_alert_evaluations e WHERE e.command_id=c.id) AS evaluated,
 (SELECT count(*) FROM inventory_alert_audit a WHERE a.command_id=c.id AND a.action='opened') AS opened,
 (SELECT count(*) FROM inventory_alert_audit a WHERE a.command_id=c.id AND a.action='changed') AS updated,
 (SELECT count(*) FROM inventory_alert_audit a WHERE a.command_id=c.id AND a.action='resolved') AS resolved,
 EXISTS(SELECT 1 FROM inventory_alert_audit a WHERE a.command_id=c.id AND a.action=c.action AND json_extract(a.after_state,'$.version')=json_extract(c.response,'$.version')) AS version_proof
 FROM inventory_alert_commands c WHERE c.id=?`
    )
    .bind(key)
    .first<{
      actor_id: string
      payload_hash: string
      response: string
      action: string
      target_id: string
      evaluated: number
      opened: number
      updated: number
      resolved: number
      version_proof: number
    }>()
  await authorize(db, c, 'inventory.write', o)
  if (!row) return null
  if (row.actor_id !== c.identityId || row.payload_hash !== hash) throw new InventoryAlertsError('idempotency_conflict')
  const receipt = inventoryAlertCommandReceiptSchema.parse(JSON.parse(row.response))
  if (
    receipt.commandId !== key ||
    receipt.payloadHash !== hash ||
    receipt.action !== row.action ||
    receipt.targetId !== row.target_id ||
    receipt.processed !== row.evaluated ||
    receipt.opened !== row.opened ||
    receipt.updated !== row.updated ||
    receipt.resolved !== row.resolved ||
    (receipt.action !== 'evaluate' && row.version_proof !== 1)
  )
    throw new Error('inventory_alert_receipt_invalid')
  return receipt
}
export async function readD1InventoryAlertCommand(
  db: D1Database,
  c: VerifiedSessionClaims,
  key: string,
  hash: string,
  o: InventoryAlertsOptions = {}
) {
  checked(catalogPolicyUuidSchema, key)
  checked(z.string().regex(/^[0-9a-f]{64}$/), hash)
  await authorize(db, c, 'inventory.write', o)
  const receipt = await lookup(db, c, key, hash, o)
  return inventoryAlertCommandResponseSchema.parse(
    receipt ? { source: 'cloudflare', outcome: 'applied', receipt } : { source: 'cloudflare', outcome: 'unknown' }
  )
}

/** One bounded source read, one atomic D1 batch. The snapshot guard is evaluated
 * inside that batch; no stock decisions are based on a stale preflight read. */
async function execute(
  db: D1Database,
  c: VerifiedSessionClaims | null,
  action: InventoryAlertAction,
  target: string,
  input: unknown,
  key: string,
  o: InventoryAlertsOptions,
  cronPrevious?: string | null
): Promise<InventoryAlertCommandReceipt> {
  checked(catalogPolicyUuidSchema, key)
  let body: ReturnType<typeof parseInventoryAlertInput>
  try {
    body = parseInventoryAlertInput(action, input)
  } catch {
    throw new InventoryAlertsError('invalid_input')
  }
  const thresholdBody = action === 'threshold' ? inventoryAlertThresholdInputSchema.parse(body) : null
  const hash = await inventoryAlertIntentHash(action, target, body)
  if (c) {
    await authorize(db, c, 'inventory.write', o)
    const previous = await lookup(db, c, key, hash, o)
    if (previous) return previous
  } else {
    const prior = await db
      .prepare(
        "SELECT response FROM inventory_alert_commands WHERE id=? AND source='cron' AND actor_id IS NULL AND action='evaluate' AND payload_hash=?"
      )
      .bind(key, hash)
      .first<{ response: string }>()
    if (prior) return inventoryAlertCommandReceiptSchema.parse(JSON.parse(prior.response))
  }
  await warehouse(db)
  let selected: Fact[]
  if (action === 'threshold') {
    if (!/^[1-9][0-9]*$/.test(target) || !Number.isSafeInteger(Number(target)))
      throw new InventoryAlertsError('invalid_input')
    selected = await facts(db, 0, 1, Number(target))
    if (!selected[0]) throw new InventoryAlertsError('not_found')
    if (selected[0].policy_version !== ('expectedVersion' in body ? body.expectedVersion : -1))
      throw new InventoryAlertsError('version_conflict')
  } else if (action === 'ack') {
    checked(catalogPolicyUuidSchema, target)
    const e = await db
      .prepare('SELECT v.legacy_id FROM inventory_alert_episodes e JOIN variants v ON v.id=e.variant_id WHERE e.id=?')
      .bind(target)
      .first<{ legacy_id: number }>()
    if (!e) throw new InventoryAlertsError('not_found')
    selected = await facts(db, 0, 1, e.legacy_id)
    const f = selected[0]
    if (
      !f ||
      f.episode_id !== target ||
      f.episode_state !== 'open' ||
      f.current_kind === null ||
      f.current_kind !== f.episode_kind
    )
      throw new InventoryAlertsError('alert_not_current')
    if (f.episode_version !== ('expectedVersion' in body ? body.expectedVersion : -1))
      throw new InventoryAlertsError('version_conflict')
  } else {
    if (target !== 'warehouse') throw new InventoryAlertsError('invalid_input')
    const b = body as { afterVariantId?: number; limit: number }
    selected = await facts(db, b.afterVariantId ?? 0, b.limit)
  }
  const at = instant(o),
    statement = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values),
    sql: D1PreparedStatement[] = []
  // Parameters are numbered independently in this atomic authority predicate.
  const guardAuth = () => {
    if (c)
      sql.push(
        statement(
          `INSERT INTO inventory_alert_guards(id,satisfied) SELECT ?6,0 WHERE NOT EXISTS(${actor})`,
          ...actorParams(c, 'inventory.write', o),
          key
        )
      )
  }
  guardAuth()
  if (cronPrevious !== undefined)
    sql.push(
      statement(
        "INSERT INTO inventory_alert_guards(id,satisfied) SELECT ?1,0 WHERE (SELECT id FROM inventory_alert_commands WHERE source='cron' ORDER BY rowid DESC LIMIT 1) IS NOT ?2",
        key,
        cronPrevious
      )
    )
  sql.push(
    statement(
      `WITH ${inventoryPositionCtes()} INSERT INTO inventory_alert_guards(id,satisfied) SELECT ?,0 WHERE (SELECT available FROM inventory_scope)<>1`,
      key
    )
  )
  sql.push(
    statement(
      `WITH ${factsCtes()} INSERT INTO inventory_alert_guards(id,satisfied) SELECT ?1,0 WHERE EXISTS(SELECT 1 FROM json_each(?2) requested WHERE NOT EXISTS(SELECT 1 FROM alert_facts f WHERE f.variant_id=json_extract(requested.value,'$.variant_id') AND f.snapshot=json_extract(requested.value,'$.snapshot')))`,
      key,
      JSON.stringify(selected.map((f) => ({ variant_id: f.variant_id, snapshot: f.snapshot })))
    )
  )
  let opened = 0,
    updated = 0,
    resolved = 0
  const changes: { f: Fact; kind: Fact['current_kind']; state: string; id: string; version: number; action: string }[] =
    []
  for (const f of selected) {
    let kind = f.current_kind
    if (thresholdBody && kind !== 'anomaly')
      kind =
        thresholdBody.threshold === null || f.sellable === null
          ? null
          : f.sellable === 0
            ? 'out_of_stock'
            : f.sellable <= thresholdBody.threshold
              ? 'low'
              : null
    if (action === 'ack') {
      changes.push({
        f,
        kind: f.episode_kind as Fact['current_kind'],
        state: 'acknowledged',
        id: f.episode_id!,
        version: f.episode_version! + 1,
        action: 'ack'
      })
      continue
    }
    if (!f.episode_id && kind) {
      opened++
      changes.push({ f, kind, state: 'open', id: crypto.randomUUID(), version: 1, action: 'opened' })
    } else if (f.episode_id && !kind) {
      resolved++
      changes.push({
        f,
        kind: f.episode_kind as Fact['current_kind'],
        state: 'resolved',
        id: f.episode_id,
        version: f.episode_version! + 1,
        action: 'resolved'
      })
    } else if (f.episode_id && kind !== f.episode_kind) {
      updated++
      changes.push({
        f,
        kind,
        state: f.episode_state!,
        id: f.episode_id,
        version: f.episode_version! + 1,
        action: 'changed'
      })
    }
  }
  const receipt = inventoryAlertCommandReceiptSchema.parse({
    source: 'cloudflare',
    commandId: key,
    action,
    targetId: target,
    payloadHash: hash,
    version:
      action === 'evaluate'
        ? null
        : action === 'threshold'
          ? selected[0]!.policy_version + 1
          : selected[0]!.episode_version! + 1,
    processed: action === 'ack' ? 0 : selected.length,
    opened,
    updated,
    resolved,
    nextAfterVariantId:
      action === 'evaluate' && selected.length === (body as { limit: number }).limit ? selected.at(-1)!.legacy_id : null
  })
  sql.push(
    statement(
      'INSERT INTO inventory_alert_commands(id,actor_id,source,action,target_id,payload_hash,input,response,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      key,
      c?.identityId ?? null,
      c ? 'admin' : 'cron',
      action,
      target,
      hash,
      JSON.stringify(body),
      JSON.stringify(receipt),
      at
    )
  )
  const audits: {
    id: string
    variant_id: string
    episode_id: string | null
    action: string
    before: string
    after: string
  }[] = []
  const audit = (f: Fact, episode: string | null, change: string, before: unknown, after: unknown) =>
    audits.push({
      id: crypto.randomUUID(),
      variant_id: f.variant_id,
      episode_id: episode,
      action: change,
      before: JSON.stringify(before),
      after: JSON.stringify(after)
    })
  if (thresholdBody) {
    const f = selected[0]!
    sql.push(
      statement(
        `INSERT INTO inventory_alert_policies(variant_id,threshold,version,command_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(variant_id) DO UPDATE SET threshold=excluded.threshold,version=excluded.version,command_id=excluded.command_id,updated_at=excluded.updated_at`,
        f.variant_id,
        thresholdBody.threshold,
        receipt.version,
        key,
        at
      )
    )
    audit(
      f,
      null,
      'threshold',
      { version: f.policy_version, threshold: f.threshold },
      { version: receipt.version, threshold: thresholdBody.threshold }
    )
  }
  const planned = changes.map(({ f, id, kind, state, version, action: changeAction }) => {
    audit(
      f,
      id,
      changeAction,
      { kind: f.episode_kind, state: f.episode_state, version: f.episode_version },
      { kind, state, version }
    )
    return { id, variant_id: f.variant_id, kind, state, version, created_at: f.episode_created ?? at }
  })
  if (planned.length) {
    sql.push(
      statement(
        `INSERT INTO inventory_alert_episodes(id,variant_id,kind,state,version,command_id,created_at,updated_at)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.variant_id'),json_extract(value,'$.kind'),json_extract(value,'$.state'),json_extract(value,'$.version'),?1,json_extract(value,'$.created_at'),?2 FROM json_each(?3) WHERE 1
 ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,state=excluded.state,version=excluded.version,command_id=excluded.command_id,updated_at=excluded.updated_at WHERE inventory_alert_episodes.version=excluded.version-1 AND inventory_alert_episodes.state<>'resolved'`,
        key,
        at,
        JSON.stringify(planned)
      )
    )
    sql.push(
      statement(
        `INSERT INTO inventory_alert_guards(id,satisfied) SELECT ?1,0 WHERE EXISTS(SELECT 1 FROM json_each(?2) changed WHERE NOT EXISTS(SELECT 1 FROM inventory_alert_episodes e WHERE e.id=json_extract(changed.value,'$.id') AND e.command_id=?1 AND e.version=json_extract(changed.value,'$.version')))`,
        key,
        JSON.stringify(planned)
      )
    )
  }
  if (audits.length)
    sql.push(
      statement(
        `INSERT INTO inventory_alert_audit(id,command_id,variant_id,episode_id,action,before_state,after_state,created_at) SELECT json_extract(value,'$.id'),?1,json_extract(value,'$.variant_id'),json_extract(value,'$.episode_id'),json_extract(value,'$.action'),json_extract(value,'$.before'),json_extract(value,'$.after'),?2 FROM json_each(?3)`,
        key,
        at,
        JSON.stringify(audits)
      )
    )
  if (action !== 'ack')
    sql.push(
      statement(
        `INSERT INTO inventory_alert_evaluations(command_id,variant_id,evaluated_at) SELECT ?1,json_extract(value,'$.id'),?2 FROM json_each(?3)`,
        key,
        at,
        JSON.stringify(selected.map((f) => ({ id: f.variant_id })))
      )
    )
  guardAuth()
  try {
    const results = await db.batch(sql)
    if (results.length !== sql.length || results.some((r) => !r.success))
      throw new Error('inventory_alert_batch_invalid')
  } catch (error) {
    if (c) {
      await authorize(db, c, 'inventory.write', o)
      const winner = await lookup(db, c, key, hash, o)
      if (winner) return winner
    } else {
      const winner = await db
        .prepare("SELECT response FROM inventory_alert_commands WHERE id=? AND source='cron' AND payload_hash=?")
        .bind(key, hash)
        .first<{ response: string }>()
      if (winner) return inventoryAlertCommandReceiptSchema.parse(JSON.parse(winner.response))
    }
    if (/constraint|inventory_alert_current_episode/i.test(String(error)))
      throw new InventoryAlertsError('version_conflict')
    throw error
  }
  if (c) {
    const confirmed = await lookup(db, c, key, hash, o)
    if (!confirmed) throw new Error('inventory_alert_receipt_missing')
    return confirmed
  }
  return receipt
}
export function executeD1InventoryAlertCommand(
  db: D1Database,
  c: VerifiedSessionClaims,
  action: InventoryAlertAction,
  targetId: string,
  input: unknown,
  idempotencyKey: string,
  o: InventoryAlertsOptions = {}
) {
  return execute(db, c, action, targetId, input, idempotencyKey, o)
}
/** Internal scheduled evaluator. Immutable cron command rowid provides a stable
 * sequence even when timestamps tie. Manual commands never advance this cursor.
 * Each successful page advances once; the final page restarts the next cycle. */
export async function sweepD1InventoryAlerts(
  db: D1Database,
  input: { limit?: number } = {},
  o: InventoryAlertsOptions = {}
) {
  const parsed = checked(z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict(), input)
  const previous = await db
    .prepare("SELECT id,response FROM inventory_alert_commands WHERE source='cron' ORDER BY rowid DESC LIMIT 1")
    .first<{ id: string; response: string }>()
  const receipt = previous ? inventoryAlertCommandReceiptSchema.parse(JSON.parse(previous.response)) : null
  if (
    receipt &&
    (receipt.action !== 'evaluate' || receipt.targetId !== 'warehouse' || receipt.commandId !== previous!.id)
  )
    throw new Error('inventory_alert_cron_cursor_invalid')
  const body = {
    ...(receipt?.nextAfterVariantId ? { afterVariantId: receipt.nextAfterVariantId } : {}),
    limit: parsed.limit
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['inventory-alert-cron:v1', previous?.id ?? null, body]))
    )
  )
  digest[6] = (digest[6]! & 15) | 64
  digest[8] = (digest[8]! & 63) | 128
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return execute(db, null, 'evaluate', 'warehouse', body, key, o, previous?.id ?? null)
}
