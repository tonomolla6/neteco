import { z } from 'zod'
import {
  inventoryCountImportPreviewInputSchema,
  inventoryCountImportProposalInputSchema,
  inventoryCountImportApprovalInputSchema,
  inventoryCountImportPreviewSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportListQuerySchema,
  inventoryCountImportListSchema,
  inventoryCountImportIntentHash,
  type InventoryCountImportPreview,
  type InventoryCountImportReceipt
} from '../../shared/inventory-count-import'
import {
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  inventoryCountFactsSql,
  inventoryCountActorSql,
  parseInventoryCountSource,
  type InventoryCountSource
} from './admin-inventory'
import { canonicalJson, sha256Hex } from './inventory'

type Options = { now?: string }
type CommandOptions = Options & { idempotencyKey: string }
export class InventoryCountImportError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'InventoryCountImportError'
  }
}
function parse<T, I>(schema: z.ZodType<T, I>, raw: unknown): T {
  let copied: unknown
  try {
    copied = catalogPolicyOwnJson(raw)
  } catch {
    throw new InventoryCountImportError('invalid_input')
  }
  const result = schema.safeParse(copied)
  if (!result.success) throw new InventoryCountImportError('invalid_input')
  return result.data
}
function clock(options: Options) {
  if (options.now !== undefined) parse(catalogPolicyInstantSchema, options.now)
  const started = Date.now()
  return () =>
    new Date((options.now === undefined ? started : Date.parse(options.now)) + Math.max(0, Date.now() - started))
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
}
async function authorize(
  db: D1Database,
  claims: VerifiedSessionClaims,
  permission: 'inventory.read' | 'inventory.write',
  now: string
) {
  const result = await authorizeD1Session(db, claims, permission, { now, requireMfa: true })
  if (!result.allowed) throw new InventoryCountImportError(result.code)
}
function rows<T>(result: D1Result<T>): T[] {
  if (result.success !== true || !Array.isArray(result.results))
    throw new InventoryCountImportError('service_unavailable')
  return result.results
}
const facts = inventoryCountFactsSql.replace('v.legacy_id=?6', 'v.id IN (SELECT value FROM json_each(?6))')
type InternalRow = {
  rowNumber: number
  sku: string
  countedPhysicalQuantity: number
  variantId: number
  expectedBalanceVersion: number
  physicalQuantity: number
  physicalDelta: number
  variantUuid: string
  locationId: string
  sourceSnapshot: string
  movementId: string
}
function csvRows(value: string) {
  let parsed: string[][]
  try {
    parsed = parseCatalogCsvCells(value.replace(/^\uFEFF/, ''), { maxRows: 101, maxColumns: 2, maxCellCharacters: 200 })
  } catch {
    throw new InventoryCountImportError('invalid_input')
  }
  if (
    parsed.length < 2 ||
    parsed.length > 101 ||
    parsed[0]?.join(',') !== 'sku,countedPhysicalQuantity' ||
    parsed.some((row) => row.length !== 2)
  )
    throw new InventoryCountImportError('invalid_input')
  return parsed.slice(1).map(([sku, quantity], index) => ({
    rowNumber: index + 2,
    sku: sku!.trim().normalize('NFC'),
    rawQuantity: quantity!
  }))
}
async function sources(db: D1Database, ids: string[], now: string) {
  return rows(
    await db.prepare(`WITH ${facts} SELECT * FROM state`).bind(now, null, null, null, null, JSON.stringify(ids)).all()
  ).map(parseInventoryCountSource)
}
function validCount(source: InventoryCountSource, counted: number) {
  return (
    Number.isSafeInteger(counted) &&
    counted >= 0 &&
    source.version < Number.MAX_SAFE_INTEGER &&
    (counted >= source.physical_quantity || counted - source.blocked_quantity >= source.reserved_quantity)
  )
}
async function previewFacts(db: D1Database, raw: unknown, now: string) {
  const input = parse(inventoryCountImportPreviewInputSchema, raw),
    parsed = csvRows(input.csv)
  const candidates = rows(
    await db
      .prepare(
        `SELECT id,legacy_id,sku FROM variants WHERE EXISTS(SELECT 1 FROM json_each(?1) wanted
    WHERE variants.sku=wanted.value COLLATE NOCASE) ORDER BY id`
      )
      .bind(JSON.stringify(parsed.map((row) => row.sku)))
      .all<{ id: string; legacy_id: number; sku: string }>()
  )
  const current = await sources(
      db,
      candidates.map((row) => row.id),
      now
    ),
    internal: InternalRow[] = []
  // SQLite NOCASE folds ASCII only, not locale-dependent Unicode.
  const fold = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase())
  const output = parsed.map((row) => {
    const matched = candidates.filter((item) => fold(item.sku) === fold(row.sku))
    const quantity = /^(0|[1-9][0-9]*)$/.test(row.rawQuantity) ? Number(row.rawQuantity) : NaN
    const source = matched.length === 1 ? current.find((item) => item.variant_uuid === matched[0]!.id) : undefined
    const error =
      parsed.filter((item) => fold(item.sku) === fold(row.sku)).length !== 1
        ? 'duplicate_sku'
        : matched.length === 0
          ? 'unknown_sku'
          : matched.length !== 1
            ? 'ambiguous_sku'
            : !Number.isSafeInteger(quantity)
              ? 'invalid_quantity'
              : !source || fold(source.sku) !== fold(row.sku)
                ? 'source_unavailable'
                : !validCount(source, quantity)
                  ? 'invalid_quantity'
                  : null
    const dto = {
      rowNumber: row.rowNumber,
      sku: row.sku,
      countedPhysicalQuantity: Number.isSafeInteger(quantity) ? quantity : null,
      variantId: matched.length === 1 ? matched[0]!.legacy_id : null,
      expectedBalanceVersion: source?.version ?? null,
      physicalQuantity: source?.physical_quantity ?? null,
      physicalDelta: source && Number.isSafeInteger(quantity) ? quantity - source.physical_quantity : null,
      error
    }
    if (!error && source)
      internal.push({
        rowNumber: row.rowNumber,
        sku: row.sku,
        countedPhysicalQuantity: quantity,
        variantId: source.legacy_id,
        expectedBalanceVersion: source.version,
        physicalQuantity: source.physical_quantity,
        physicalDelta: quantity - source.physical_quantity,
        variantUuid: source.variant_uuid,
        locationId: source.location_id,
        sourceSnapshot: source.snapshot,
        movementId: ''
      })
    return dto
  })
  const previewHash = await sha256Hex(
    canonicalJson({ rows: output, states: current.map((item) => item.snapshot).sort() })
  )
  return {
    view: inventoryCountImportPreviewSchema.parse({
      source: 'cloudflare',
      previewHash,
      canPropose: output.every((row) => row.error === null) && output.some((row) => row.physicalDelta !== 0),
      rows: output
    }),
    internal
  }
}
export async function previewD1InventoryCountImport(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: Options = {}
): Promise<InventoryCountImportPreview> {
  const now = clock(options)
  await authorize(db, claims, 'inventory.read', now())
  const { view } = await previewFacts(db, raw, now())
  const write = await authorizeD1Session(db, claims, 'inventory.write', { now: now(), requireMfa: true })
  await authorize(db, claims, 'inventory.read', now())
  return { ...view, canPropose: view.canPropose && write.allowed }
}
const auditProof = `EXISTS(SELECT 1 FROM inventory_count_import_audit a WHERE a.command_id=c.id AND a.actor_id=c.actor_id
  AND a.action=c.action AND a.import_id=c.import_id AND a.payload_hash=c.payload_hash AND a.response=c.response AND a.created_at=c.created_at)`
const historyProof = `EXISTS(SELECT 1 FROM inventory_count_imports i JOIN inventory_count_import_commands p ON p.id=i.command_id
  WHERE i.id=c.import_id AND p.action='propose' AND p.actor_id=i.proposed_by AND p.import_id=i.id
  AND json_extract(c.response,'$.commandId')=c.idempotency_key AND json_extract(c.response,'$.action')=c.action
  AND json_extract(c.response,'$.importId')=c.import_id AND json_extract(c.response,'$.payloadHash')=c.payload_hash
  AND json_extract(c.response,'$.recordedAt')=c.created_at
  AND c.created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',c.created_at),'')
  AND json_extract(c.response,'$.rowCount')=i.row_count AND json_extract(c.response,'$.changedCount')=i.changed_count
  AND (SELECT count(*) FROM inventory_count_import_rows r WHERE r.import_id=i.id)=i.row_count
  AND (SELECT count(*) FROM inventory_count_import_rows r WHERE r.import_id=i.id AND r.physical_delta<>0)=i.changed_count)
  AND (c.action='propose' OR NOT EXISTS(SELECT 1 FROM inventory_count_import_rows r WHERE r.import_id=c.import_id AND r.physical_delta<>0 AND NOT EXISTS(
    SELECT 1 FROM inventory_movements m WHERE m.id=r.movement_id AND m.variant_id=r.variant_id AND m.location_id=r.location_id
      AND m.movement_type='adjustment' AND m.physical_delta=r.physical_delta AND m.reserved_delta=0 AND m.reference_type='inventory_count_import'
      AND m.reference_id=c.id AND m.idempotency_key='count-import:'||r.movement_id AND m.correlation_id=c.import_id AND m.created_at=c.created_at)))`
async function command(db: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now: () => string) {
  await authorize(db, claims, 'inventory.write', now())
  const found = rows(
    await db
      .prepare(
        `SELECT c.*,(${auditProof} AND ${historyProof}) AS confirmed FROM inventory_count_import_commands c WHERE actor_id=?1 AND idempotency_key=?2`
      )
      .bind(claims.identityId, key)
      .all<{ payload_hash: string; response: string; confirmed: number }>()
  )
  await authorize(db, claims, 'inventory.write', now())
  if (!found.length) return null
  if (found.length !== 1 || found[0]!.confirmed !== 1) throw new InventoryCountImportError('history_unconfirmed')
  if (found[0]!.payload_hash !== hash) throw new InventoryCountImportError('idempotency_conflict')
  let value: unknown
  try {
    value = JSON.parse(found[0]!.response)
  } catch {
    throw new InventoryCountImportError('history_unconfirmed')
  }
  const result = inventoryCountImportReceiptSchema.safeParse(value)
  if (!result.success || result.data.commandId !== key || result.data.payloadHash !== hash)
    throw new InventoryCountImportError('history_unconfirmed')
  return result.data
}
export async function readD1InventoryCountImportCommand(
  db: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: Options = {}
) {
  parse(catalogPolicyUuidSchema, key)
  parse(z.string().regex(/^[0-9a-f]{64}$/), hash)
  const receipt = await command(db, claims, key, hash, clock(options))
  return receipt
    ? { source: 'cloudflare' as const, outcome: 'applied' as const, receipt }
    : { source: 'cloudflare' as const, outcome: 'unknown' as const, receipt: null }
}
type Lot = {
  id: string
  proposed_by: string
  reason: string
  reference: string
  created_at: string
  row_count: number
  changed_count: number
  approval_actor: string | null
  approved_at: string | null
  confirmed: number
}
type StoredRow = {
  row_number: number
  variant_id: string
  location_id: string
  legacy_variant_id: number
  sku: string
  expected_version: number
  physical_before: number
  counted_quantity: number
  physical_delta: number
  before_state: string
  movement_id: string
}
const lotSelect = `SELECT i.*,approved.actor_id AS approval_actor,approved.created_at AS approved_at,
  (${auditProof} AND ${historyProof} AND (approved.id IS NULL OR EXISTS(SELECT 1 FROM inventory_count_import_commands c WHERE c.id=approved.id AND ${auditProof} AND ${historyProof}))) AS confirmed
  FROM inventory_count_imports i JOIN inventory_count_import_commands c ON c.id=i.command_id
  LEFT JOIN inventory_count_import_commands approved ON approved.import_id=i.id AND approved.action='approve'`
async function lot(db: D1Database, id: string) {
  parse(catalogPolicyUuidSchema, id)
  const result = rows(await db.prepare(`${lotSelect} WHERE i.id=?1`).bind(id).all<Lot>())
  if (!result.length) throw new InventoryCountImportError('not_found')
  if (result.length !== 1 || result[0]!.confirmed !== 1) throw new InventoryCountImportError('history_unconfirmed')
  const entries = rows(
    await db
      .prepare('SELECT * FROM inventory_count_import_rows WHERE import_id=?1 ORDER BY row_number')
      .bind(id)
      .all<StoredRow>()
  )
  if (entries.length !== result[0]!.row_count) throw new InventoryCountImportError('history_unconfirmed')
  return { header: result[0]!, entries }
}
function summary(header: Lot) {
  return {
    source: 'cloudflare' as const,
    importId: header.id,
    version: header.approval_actor ? 2 : 1,
    status: header.approval_actor ? ('approved' as const) : ('proposed' as const),
    proposedBy: header.proposed_by,
    approvedBy: header.approval_actor,
    reason: header.reason,
    reference: header.reference,
    createdAt: header.created_at,
    approvedAt: header.approved_at
  }
}
export async function readD1InventoryCountImport(
  db: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  options: Options = {}
) {
  const now = clock(options)
  await authorize(db, claims, 'inventory.read', now())
  const { header, entries } = await lot(db, id),
    current = await sources(
      db,
      entries.map((row) => row.variant_id),
      now()
    )
  const output = entries.map((row) => {
    const state = current.find((item) => item.variant_uuid === row.variant_id && item.location_id === row.location_id)
    if (!state) throw new InventoryCountImportError('reconciliation_required')
    return {
      rowNumber: row.row_number,
      sku: row.sku,
      variantId: row.legacy_variant_id,
      expectedBalanceVersion: row.expected_version,
      physicalQuantity: row.physical_before,
      countedPhysicalQuantity: row.counted_quantity,
      physicalDelta: row.physical_delta,
      error: null,
      currentBalanceVersion: state.version,
      currentPhysicalQuantity: state.physical_quantity,
      stale: state.snapshot !== row.before_state
    }
  })
  const write = await authorizeD1Session(db, claims, 'inventory.write', { now: now(), requireMfa: true })
  await authorize(db, claims, 'inventory.read', now())
  return inventoryCountImportSnapshotSchema.parse({
    ...summary(header),
    rows: output,
    capabilities: {
      approve:
        write.allowed &&
        !header.approval_actor &&
        header.proposed_by !== claims.identityId &&
        output.every((row) => !row.stale)
    }
  })
}
export async function readD1InventoryCountImports(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: Options = {}
) {
  const input = parse(inventoryCountImportListQuerySchema, raw),
    now = clock(options)
  await authorize(db, claims, 'inventory.read', now())
  const result = rows(
    await db
      .prepare(`${lotSelect} ORDER BY i.created_at DESC,i.id DESC LIMIT ?1 OFFSET ?2`)
      .bind(input.perPage, (input.page - 1) * input.perPage)
      .all<Lot>()
  )
  if (result.some((row) => row.confirmed !== 1)) throw new InventoryCountImportError('history_unconfirmed')
  const count = await db.prepare('SELECT count(*) AS n FROM inventory_count_imports').first<{ n: number }>()
  if (!count || !Number.isSafeInteger(count.n)) throw new InventoryCountImportError('service_unavailable')
  await authorize(db, claims, 'inventory.read', now())
  return inventoryCountImportListSchema.parse({
    source: 'cloudflare',
    ...input,
    total: count.n,
    items: result.map(summary)
  })
}
export async function proposeD1InventoryCountImport(
  db: D1Database,
  claims: VerifiedSessionClaims,
  raw: unknown,
  options: CommandOptions
): Promise<InventoryCountImportReceipt> {
  const now = clock(options)
  await authorize(db, claims, 'inventory.write', now())
  const input = parse(inventoryCountImportProposalInputSchema, raw),
    key = parse(catalogPolicyUuidSchema, options.idempotencyKey)
  const hash = await inventoryCountImportIntentHash('propose', null, input),
    existing = await command(db, claims, key, hash, now)
  if (existing) return existing
  const { view, internal } = await previewFacts(db, { csv: input.csv }, now())
  if (view.previewHash !== input.previewHash) throw new InventoryCountImportError('preview_conflict')
  if (view.rows.some((row) => row.error !== null)) throw new InventoryCountImportError('invalid_input')
  if (!view.canPropose) throw new InventoryCountImportError('no_change')
  for (const row of internal) row.movementId = crypto.randomUUID()
  return execute(
    db,
    claims,
    {
      action: 'propose',
      importId: crypto.randomUUID(),
      key,
      hash,
      entries: internal,
      reason: input.reason,
      reference: input.reference,
      previewHash: input.previewHash
    },
    now
  )
}
export async function approveD1InventoryCountImport(
  db: D1Database,
  claims: VerifiedSessionClaims,
  id: string,
  raw: unknown,
  options: CommandOptions
): Promise<InventoryCountImportReceipt> {
  const now = clock(options)
  await authorize(db, claims, 'inventory.write', now())
  const input = parse(inventoryCountImportApprovalInputSchema, raw),
    key = parse(catalogPolicyUuidSchema, options.idempotencyKey)
  const hash = await inventoryCountImportIntentHash('approve', id, input),
    existing = await command(db, claims, key, hash, now)
  if (existing) return existing
  const { header, entries } = await lot(db, id)
  if (header.proposed_by === claims.identityId) throw new InventoryCountImportError('approval_self')
  if (input.expectedVersion !== 1 || header.approval_actor) throw new InventoryCountImportError('version_conflict')
  const current = await sources(
    db,
    entries.map((row) => row.variant_id),
    now()
  )
  if (
    entries.some(
      (row) =>
        !current.some(
          (state) =>
            state.variant_uuid === row.variant_id &&
            state.snapshot === row.before_state &&
            validCount(state, row.counted_quantity)
        )
    )
  )
    throw new InventoryCountImportError('version_conflict')
  return execute(
    db,
    claims,
    {
      action: 'approve',
      importId: id,
      key,
      hash,
      reason: input.reason,
      reference: header.reference,
      previewHash: '',
      entries: entries.map((row) => ({
        rowNumber: row.row_number,
        sku: row.sku,
        countedPhysicalQuantity: row.counted_quantity,
        variantId: row.legacy_variant_id,
        expectedBalanceVersion: row.expected_version,
        physicalQuantity: row.physical_before,
        physicalDelta: row.physical_delta,
        variantUuid: row.variant_id,
        locationId: row.location_id,
        sourceSnapshot: row.before_state,
        movementId: row.movement_id
      }))
    },
    now
  )
}
type Execution = {
  action: 'propose' | 'approve'
  importId: string
  key: string
  hash: string
  reason: string
  reference: string
  previewHash: string
  entries: InternalRow[]
}
async function execute(
  db: D1Database,
  claims: VerifiedSessionClaims,
  value: Execution,
  now: () => string
): Promise<InventoryCountImportReceipt> {
  await authorize(db, claims, 'inventory.write', now())
  const commandId = crypto.randomUUID(),
    instant = now()
  const receipt = inventoryCountImportReceiptSchema.parse({
    source: 'cloudflare',
    commandId: value.key,
    action: value.action,
    importId: value.importId,
    expectedVersion: value.action === 'propose' ? 0 : 1,
    version: value.action === 'propose' ? 1 : 2,
    payloadHash: value.hash,
    rowCount: value.entries.length,
    changedCount: value.entries.filter((row) => row.physicalDelta !== 0).length,
    recordedAt: instant,
    inventoryEffect: value.action === 'propose' ? 'none' : 'physical_adjustment',
    economicEffect: 'none'
  })
  const params = [
    instant,
    claims.sessionId,
    claims.identityId,
    claims.sessionVersion,
    commandId,
    JSON.stringify(value.entries.map((row) => row.variantUuid)),
    JSON.stringify(value),
    JSON.stringify(receipt)
  ]
  const prefix = `WITH request AS (SELECT ?8 AS response),actor AS (${inventoryCountActorSql}),${facts},requested AS MATERIALIZED(SELECT value AS row FROM json_each(?7,'$.entries'))`
  const gate = `EXISTS(SELECT 1 FROM actor) AND (SELECT count(*) FROM state)=(SELECT count(*) FROM requested)
    AND NOT EXISTS(SELECT 1 FROM requested r WHERE NOT EXISTS(SELECT 1 FROM state s WHERE s.variant_uuid=json_extract(r.row,'$.variantUuid')
      AND s.location_id=json_extract(r.row,'$.locationId') AND s.snapshot=json_extract(r.row,'$.sourceSnapshot') AND s.location_count=1 AND s.kind='warehouse' AND s.active=1
      AND s.ledger_physical=s.physical_quantity AND s.ledger_reserved=s.reserved_quantity AND s.version<9007199254740991
      AND (json_extract(r.row,'$.countedPhysicalQuantity')>=s.physical_quantity OR json_extract(r.row,'$.countedPhysicalQuantity')-s.blocked_quantity>=s.reserved_quantity)))
    AND (json_extract(?7,'$.action')='propose' OR EXISTS(SELECT 1 FROM inventory_count_imports i WHERE i.id=json_extract(?7,'$.importId')
      AND i.proposed_by<>?3 AND NOT EXISTS(SELECT 1 FROM inventory_count_import_commands approved WHERE approved.import_id=i.id AND approved.action='approve')))`
  const owned = `EXISTS(SELECT 1 FROM inventory_count_import_commands WHERE id=?5 AND actor_id=?3)`
  const statements = [
    `${prefix} INSERT INTO inventory_count_import_commands(id,actor_id,idempotency_key,action,import_id,payload_hash,response,created_at)
      SELECT ?5,?3,json_extract(?7,'$.key'),json_extract(?7,'$.action'),json_extract(?7,'$.importId'),json_extract(?7,'$.hash'),?8,?1 WHERE ${gate}`,
    `${prefix} INSERT INTO inventory_count_imports(id,command_id,proposed_by,reason,reference,preview_hash,row_count,changed_count,created_at)
      SELECT json_extract(?7,'$.importId'),?5,?3,json_extract(?7,'$.reason'),json_extract(?7,'$.reference'),json_extract(?7,'$.previewHash'),
        json_extract(?8,'$.rowCount'),json_extract(?8,'$.changedCount'),?1 WHERE json_extract(?7,'$.action')='propose' AND ${owned}`,
    `${prefix} INSERT INTO inventory_count_import_rows(import_id,row_number,variant_id,location_id,legacy_variant_id,sku,expected_version,physical_before,counted_quantity,physical_delta,before_state,movement_id)
      SELECT json_extract(?7,'$.importId'),json_extract(row,'$.rowNumber'),json_extract(row,'$.variantUuid'),json_extract(row,'$.locationId'),
        json_extract(row,'$.variantId'),json_extract(row,'$.sku'),json_extract(row,'$.expectedBalanceVersion'),json_extract(row,'$.physicalQuantity'),
        json_extract(row,'$.countedPhysicalQuantity'),json_extract(row,'$.physicalDelta'),json_extract(row,'$.sourceSnapshot'),json_extract(row,'$.movementId')
      FROM requested WHERE json_extract(?7,'$.action')='propose' AND ${owned}`,
    `${prefix} UPDATE inventory_balances SET physical_quantity=(SELECT json_extract(row,'$.countedPhysicalQuantity') FROM requested WHERE json_extract(row,'$.variantUuid')=inventory_balances.variant_id),
      version=version+1,updated_at=?1 WHERE json_extract(?7,'$.action')='approve' AND ${owned}
      AND EXISTS(SELECT 1 FROM requested WHERE json_extract(row,'$.variantUuid')=inventory_balances.variant_id AND json_extract(row,'$.locationId')=inventory_balances.location_id AND json_extract(row,'$.physicalDelta')<>0)`,
    `${prefix} INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
      SELECT json_extract(row,'$.movementId'),json_extract(row,'$.variantUuid'),json_extract(row,'$.locationId'),'adjustment',json_extract(row,'$.physicalDelta'),0,
        'inventory_count_import',?5,'count-import:'||json_extract(row,'$.movementId'),json_extract(?7,'$.importId'),json_extract(?7,'$.reason'),?1
      FROM requested WHERE json_extract(?7,'$.action')='approve' AND json_extract(row,'$.physicalDelta')<>0 AND ${owned}`,
    `${prefix} INSERT INTO inventory_count_import_audit(command_id,actor_id,action,import_id,payload_hash,response,created_at)
      SELECT c.id,c.actor_id,c.action,c.import_id,c.payload_hash,c.response,c.created_at FROM inventory_count_import_commands c WHERE c.id=?5 AND ${historyProof}`,
    `${prefix} INSERT INTO inventory_count_import_guards(id,satisfied) SELECT ?5,0 WHERE NOT EXISTS(SELECT 1 FROM inventory_count_import_commands c
      WHERE c.id=?5 AND ${auditProof} AND ${historyProof} AND EXISTS(SELECT 1 FROM actor))
      OR EXISTS(SELECT 1 FROM requested r WHERE NOT EXISTS(SELECT 1 FROM state s WHERE s.variant_uuid=json_extract(r.row,'$.variantUuid')
        AND s.location_id=json_extract(r.row,'$.locationId') AND s.ledger_physical=s.physical_quantity AND s.ledger_reserved=s.reserved_quantity
        AND s.physical_quantity=CASE WHEN json_extract(?7,'$.action')='approve' THEN json_extract(r.row,'$.countedPhysicalQuantity') ELSE json_extract(r.row,'$.physicalQuantity') END
        AND s.version=json_extract(r.row,'$.expectedBalanceVersion')+(json_extract(?7,'$.action')='approve' AND json_extract(r.row,'$.physicalDelta')<>0)))`
  ]
  try {
    const result = await db.batch(statements.map((sql) => db.prepare(sql).bind(...params)))
    if (result.length !== statements.length || result.some((item) => !item.success))
      throw new InventoryCountImportError('service_unavailable')
  } catch (error) {
    await authorize(db, claims, 'inventory.write', now())
    const winner = await command(db, claims, value.key, value.hash, now)
    if (winner) return winner
    const current = await sources(
      db,
      value.entries.map((row) => row.variantUuid),
      now()
    )
    if (
      value.entries.some(
        (row) =>
          !current.some((source) => source.variant_uuid === row.variantUuid && source.snapshot === row.sourceSnapshot)
      )
    )
      throw new InventoryCountImportError(value.action === 'propose' ? 'preview_conflict' : 'version_conflict')
    throw error
  }
  const confirmed = await command(db, claims, value.key, value.hash, now)
  if (!confirmed) throw new InventoryCountImportError('history_unconfirmed')
  return confirmed
}
