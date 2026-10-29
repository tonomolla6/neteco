import { z } from 'zod'
import {
  inventoryCommandActionSchema,
  inventoryLegacyIdSchema,
  inventoryIdempotencyKeySchema,
  inventoryReceiptInputSchema,
  inventoryCountProposalInputSchema,
  inventoryCountApprovalInputSchema,
  inventoryCommandReceiptSchema,
  adminInventoryVariantSchema,
  inventoryVariantSearchInputSchema,
  adminInventoryVariantSearchSchema,
  type AdminInventoryVariantSearch,
  type InventoryCommandAction,
  type InventoryCommandReceipt,
  type AdminInventoryVariant,
  type InventoryReceiptInput,
  type InventoryCountProposalInput,
  type InventoryCountApprovalInput
} from '../../shared/inventory-commands'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema,
  catalogPolicyInstantSchema
} from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { canonicalJson, sha256Hex, sellableExpression } from './inventory'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

export type InventoryCommandErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'warehouse_unavailable'
  | 'reconciliation_required'
  | 'insufficient_stock'
  | 'approval_self'
  | 'proposal_unavailable'
  | 'no_change'
  | 'conflict'
export class InventoryCommandError extends Error {
  constructor(readonly code: InventoryCommandErrorCode) {
    super(code)
    this.name = 'InventoryCommandError'
  }
}
export interface AdminInventoryCommandTarget {
  variantId: string
  countId?: string
}
/** Internal coordinator input only. HTTP verifies the cookie, then the engine
 * verifies live D1 authority again. Never serve this command from a DO cache. */
export interface AdminInventoryCoordinatorCommand {
  type: 'admin_inventory'
  claims: VerifiedSessionClaims
  action: InventoryCommandAction
  target: AdminInventoryCommandTarget
  input: unknown
  idempotencyKey: string
}
type Command =
  | { action: 'receipt'; body: InventoryReceiptInput }
  | { action: 'count_propose'; body: InventoryCountProposalInput }
  | { action: 'count_approve'; body: InventoryCountApprovalInput }
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positive = safe.min(1)
const claimsSchema = z
  .object({ identityId: catalogPolicyUuidSchema, sessionId: catalogPolicyUuidSchema, sessionVersion: positive })
  .strict()
const targetSchema = z
  .object({ variantId: inventoryLegacyIdSchema, countId: catalogPolicyUuidSchema.optional() })
  .strict()
const coordinatorSchema = z
  .object({
    type: z.literal('admin_inventory'),
    claims: claimsSchema,
    action: inventoryCommandActionSchema,
    target: targetSchema,
    input: z.unknown(),
    idempotencyKey: inventoryIdempotencyKeySchema
  })
  .strict()
function checked<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  value: unknown,
  code: InventoryCommandErrorCode = 'invalid_input'
): T {
  let copied: unknown
  try {
    copied = catalogPolicyOwnJson(value)
  } catch {
    throw new InventoryCommandError(code)
  }
  const result = schema.safeParse(copied)
  if (!result.success) throw new InventoryCommandError(code)
  return result.data
}
function parseCommand(action: InventoryCommandAction, input: unknown): Command {
  switch (action) {
    case 'receipt':
      return { action, body: checked(inventoryReceiptInputSchema, input) }
    case 'count_propose':
      return { action, body: checked(inventoryCountProposalInputSchema, input) }
    case 'count_approve':
      return { action, body: checked(inventoryCountApprovalInputSchema, input) }
  }
}
export function parseAdminInventoryCoordinatorCommand(raw: unknown): AdminInventoryCoordinatorCommand {
  const parsed = checked(coordinatorSchema, raw)
  if ((parsed.action === 'count_approve') !== Object.hasOwn(parsed.target, 'countId'))
    throw new InventoryCommandError('invalid_input')
  return { ...parsed, input: parseCommand(parsed.action, parsed.input).body }
}
async function authorize(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permission: 'inventory.read' | 'inventory.write',
  now?: string
) {
  const auth = await authorizeD1Session(database, claims, permission, {
    requireMfa: true,
    ...(now === undefined ? {} : { now })
  })
  if (!auth.allowed) throw new InventoryCommandError(auth.code)
}
function confirmedRows(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') throw new Error('inventory_provider_result_invalid')
  const success = Object.getOwnPropertyDescriptor(value, 'success'),
    results = Object.getOwnPropertyDescriptor(value, 'results')
  if (
    !success ||
    !Object.hasOwn(success, 'value') ||
    success.value !== true ||
    !results ||
    !Object.hasOwn(results, 'value') ||
    !Array.isArray(results.value)
  )
    throw new Error('inventory_provider_result_invalid')
  return denseArray(results.value)
}
function denseArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error('inventory_provider_result_invalid')
  const rows: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      throw new Error('inventory_provider_result_invalid')
    rows.push(descriptor.value)
  }
  return rows
}
function confirmedBatch(value: unknown, size: number): unknown[][] {
  const rows = denseArray(value)
  if (rows.length !== size) throw new Error('inventory_provider_result_invalid')
  return rows.map(confirmedRows)
}
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
  WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
    AND s.created_at<=${clock} AND s.expires_at>${clock} AND s.mfa_verified=1
    AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
    AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
      WHERE r.identity_id=i.id AND p.permission_code='inventory.write' AND r.granted_at<=${clock}
      AND (r.expires_at IS NULL OR r.expires_at>${clock}))`
const requestSql = `request AS (SELECT ${Array.from({ length: 21 }, (_, i) => `?${i + 1} AS p${i + 1}`).join(',')})`
function conjunction(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]!
  const middle = Math.floor(parts.length / 2)
  return `(${conjunction(parts.slice(0, middle))} AND ${conjunction(parts.slice(middle))})`
}
// Include inactive locations with any persisted inventory too. Two locations
// cannot be silently collapsed into the operational single-warehouse lane.
const factsSql = `scope AS MATERIALIZED (
  SELECT id FROM inventory_locations WHERE active=1
  UNION SELECT location_id FROM inventory_balances UNION SELECT location_id FROM inventory_movements
  UNION SELECT location_id FROM inventory_reservation_lines
), facts AS MATERIALIZED (
  SELECT v.id AS variant_uuid,v.legacy_id,p.id AS product_uuid,p.legacy_id AS product_legacy_id,
    v.sku,v.format,v.status,v.unit_base,v.unit_label,v.safety_stock,v.backorder_allowed,p.status AS product_status,
    l.id AS location_id,l.code,l.name,l.kind,l.active,l.created_at AS location_created_at,
    b.physical_quantity,b.blocked_quantity,b.version,b.created_at,b.updated_at,
    (SELECT count(*) FROM scope) AS location_count,
    COALESCE((SELECT sum(lines.quantity) FROM inventory_reservation_lines lines JOIN inventory_reservations r ON r.id=lines.reservation_id
      WHERE lines.variant_id=v.id AND lines.location_id=l.id AND r.status='reserved'),0) AS reserved_quantity,
    (SELECT count(*) FROM inventory_reservation_lines lines JOIN inventory_reservations r ON r.id=lines.reservation_id
      WHERE lines.variant_id=v.id AND lines.location_id=l.id AND r.status='reserved' AND r.expires_at<=${clock}) AS expiry_pending,
    COALESCE((SELECT sum(m.physical_delta) FROM inventory_movements m WHERE m.variant_id=v.id AND m.location_id=l.id),0) AS ledger_physical,
    COALESCE((SELECT sum(m.reserved_delta) FROM inventory_movements m WHERE m.variant_id=v.id AND m.location_id=l.id),0) AS ledger_reserved,
    (SELECT count(*) FROM inventory_movements m WHERE m.variant_id=v.id AND m.location_id=l.id) AS movement_count,
    COALESCE((SELECT json_group_array(json_object('id',id,'quantity',quantity,'expiresAt',expires_at)) FROM (
      SELECT r.id,lines.quantity,r.expires_at FROM inventory_reservation_lines lines JOIN inventory_reservations r ON r.id=lines.reservation_id
      WHERE lines.variant_id=v.id AND lines.location_id=l.id AND r.status='reserved' ORDER BY r.id
    )),'[]') AS reservations,
    ${sellableExpression()} AS sellable_quantity
  FROM variants v JOIN products p ON p.id=v.product_id JOIN inventory_balances b ON b.variant_id=v.id
    JOIN inventory_locations l ON l.id=b.location_id WHERE v.legacy_id=?6
), state AS MATERIALIZED (
  SELECT facts.*, json_object(
    'variant',json_object('uuid',variant_uuid,'legacyId',legacy_id,'productUuid',product_uuid,'productId',product_legacy_id,
      'sku',sku,'format',format,'status',status,'unitBase',unit_base,'unitLabel',unit_label,'safetyStock',safety_stock,'backorderAllowed',backorder_allowed,'productStatus',product_status),
    'warehouse',json_object('id',location_id,'code',code,'name',name,'kind',kind,'active',active,'createdAt',location_created_at,'scopeCount',location_count),
    'balance',json_object('physicalQuantity',physical_quantity,'blockedQuantity',blocked_quantity,'version',version,'createdAt',created_at,'updatedAt',updated_at),
    'ledger',json_object('physical',ledger_physical,'reserved',ledger_reserved,'count',movement_count),
    'reservedQuantity',reserved_quantity,'reservations',reservations
  ) AS snapshot FROM facts
)`
const auditColumns =
  'actor_id,action,target,input,variant_id,legacy_variant_id,location_id,expected_version,result_version,physical_before,physical_after,physical_delta,proposed_delta,proposal_id,movement_id,reason,reference,before_state,after_state,response,created_at'
const auditMatch = conjunction(
  auditColumns
    .split(',')
    .map((name) => `a.${name} IS c.${name}`)
    .concat('a.command_id=c.id')
)
const owned = conjunction([
  'c.id=?12',
  'c.claim_nonce=?13',
  'c.actor_id=?3',
  'c.action=?7',
  'c.target=?9',
  'c.input=?8',
  'c.idempotency_key=?10',
  'c.payload_hash=?11'
])
const proof = `EXISTS(SELECT 1 FROM inventory_admin_audit a WHERE ${auditMatch})`
const movementProof = `EXISTS(SELECT 1 FROM inventory_movements m WHERE m.id=c.movement_id AND m.variant_id=c.variant_id AND m.location_id=c.location_id
  AND m.movement_type=CASE WHEN c.action='receipt' THEN 'receipt' ELSE 'adjustment' END
  AND m.physical_delta=c.physical_delta AND m.reserved_delta=0 AND m.reference_type='admin_inventory' AND m.reference_id=c.id
  AND m.idempotency_key='admin-inventory:'||c.id AND m.correlation_id=c.id AND m.reason=c.reason AND m.created_at=c.created_at)`
const proposalProof = `EXISTS(SELECT 1 FROM inventory_count_proposals p WHERE p.id=c.proposal_id AND p.command_id=c.id
  AND p.variant_id=c.variant_id AND p.location_id=c.location_id AND p.actor_id=c.actor_id AND p.expected_version=c.expected_version
  AND p.physical_delta=c.proposed_delta AND p.counted_quantity=json_extract(c.input,'$.countedPhysicalQuantity')
  AND p.reason=c.reason AND p.reference=c.reference AND p.before_state=c.before_state AND p.created_at=c.created_at)`
const approvalProof = `EXISTS(SELECT 1 FROM inventory_count_approvals approved JOIN inventory_count_proposals p ON p.id=approved.proposal_id
  WHERE approved.command_id=c.id AND approved.proposal_id=c.proposal_id AND approved.actor_id=c.actor_id AND approved.actor_id<>p.actor_id
  AND approved.reason=c.reason AND approved.created_at=c.created_at AND p.variant_id=c.variant_id AND p.location_id=c.location_id
  AND p.expected_version=c.expected_version AND p.before_state=c.before_state AND p.counted_quantity=c.physical_after AND p.physical_delta=c.physical_delta)`
const effectProof = `(CASE c.action WHEN 'count_propose' THEN ${proposalProof} WHEN 'receipt' THEN ${movementProof} ELSE (${movementProof} AND ${approvalProof}) END)`
const receiptKeys =
  'source,action,commandId,variantId,variantUuid,warehouseId,balanceVersion,physicalQuantity,physicalDelta,proposedPhysicalDelta,proposalId,updated'
function storedReceipt(raw: unknown): InventoryCommandReceipt {
  if (typeof raw !== 'string') throw new Error('inventory_receipt_invalid')
  const parsed: unknown = JSON.parse(raw),
    valid = inventoryCommandReceiptSchema.safeParse(parsed)
  if (!valid.success || !parsed || typeof parsed !== 'object' || Object.keys(parsed).join(',') !== receiptKeys)
    throw new Error('inventory_receipt_invalid')
  // Return the persisted object's order, not a new Zod projection.
  return parsed as InventoryCommandReceipt
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const result = confirmedRows(
    await database
      .prepare(
        `WITH actor AS (${actorSql})
    SELECT c.payload_hash,c.response,(${proof} AND ${effectProof}) AS completed FROM actor
    JOIN inventory_admin_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?5`
      )
      .bind(now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, key)
      .all()
  )
  await authorize(database, claims, 'inventory.write', now)
  if (!result.length) return null
  if (result.length !== 1) throw new Error('inventory_command_source_invalid')
  const row = checked(
    z
      .object({ payload_hash: z.string().length(64), response: z.string(), completed: z.number().int().min(0).max(1) })
      .strict(),
    result[0]
  )
  if (row.payload_hash !== hash) throw new InventoryCommandError('idempotency_conflict')
  if (row.completed !== 1) throw new InventoryCommandError('conflict')
  return storedReceipt(row.response)
}
interface Source {
  variant_uuid: string
  legacy_id: number
  product_uuid: string
  product_legacy_id: number
  sku: string
  format: string
  status: string
  unit_base: string
  unit_label: string
  safety_stock: number
  backorder_allowed: number
  product_status: string
  location_id: string
  code: string
  name: string
  kind: string
  active: number
  location_created_at: string
  physical_quantity: number
  blocked_quantity: number
  version: number
  created_at: string
  updated_at: string
  location_count: number
  reserved_quantity: number
  expiry_pending: number
  ledger_physical: number
  ledger_reserved: number
  movement_count: number
  reservations: string
  sellable_quantity: number
  snapshot: string
}
const sourceSchema = z
  .object({
    variant_uuid: catalogPolicyUuidSchema,
    legacy_id: positive,
    product_uuid: catalogPolicyUuidSchema,
    product_legacy_id: positive,
    sku: z.string().min(1).max(120),
    format: z.string().min(1).max(160),
    status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']),
    unit_base: z.string().min(1).max(32),
    unit_label: z.string().min(1).max(160),
    safety_stock: safe,
    backorder_allowed: z.number().int().min(0).max(1),
    product_status: z.enum(['draft', 'review', 'published', 'hidden', 'discontinued']),
    location_id: z.string().min(1).max(200),
    code: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    kind: z.enum(['warehouse', 'store', 'vehicle', 'supplier']),
    active: z.number().int().min(0).max(1),
    location_created_at: catalogPolicyInstantSchema,
    physical_quantity: safe,
    blocked_quantity: safe,
    version: positive,
    created_at: catalogPolicyInstantSchema,
    updated_at: catalogPolicyInstantSchema,
    location_count: safe,
    reserved_quantity: safe,
    expiry_pending: safe,
    ledger_physical: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    ledger_reserved: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    movement_count: safe,
    reservations: z.string(),
    sellable_quantity: safe,
    snapshot: z.string()
  })
  .strict()
function sourceRow(raw: unknown): Source {
  let copied: unknown
  try {
    copied = catalogPolicyOwnJson(raw)
  } catch {
    throw new Error('inventory_source_invalid')
  }
  const result = sourceSchema.safeParse(copied)
  if (!result.success) throw new Error('inventory_source_invalid')
  const source = result.data
  if (
    [source.location_id, source.code, source.name, source.sku, source.format, source.unit_base, source.unit_label].some(
      (value) => value !== value.trim() || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
  )
    throw new Error('inventory_source_invalid')
  if (source.location_count !== 1 || source.kind !== 'warehouse' || source.active !== 1)
    throw new InventoryCommandError('warehouse_unavailable')
  if (
    source.blocked_quantity > source.physical_quantity ||
    source.ledger_physical !== source.physical_quantity ||
    source.ledger_reserved !== source.reserved_quantity
  )
    throw new InventoryCommandError('reconciliation_required')
  return source
}
async function readSource(database: D1Database, legacy: string, now?: string): Promise<Source> {
  const rows = confirmedRows(
    await database
      .prepare(`WITH ${factsSql} SELECT * FROM state`)
      .bind(now ?? null, null, null, null, null, Number(legacy))
      .all()
  )
  if (!rows.length) throw new InventoryCommandError('not_found')
  if (rows.length !== 1) throw new InventoryCommandError('warehouse_unavailable')
  return sourceRow(rows[0])
}
const countSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    command_id: catalogPolicyUuidSchema,
    variant_id: catalogPolicyUuidSchema,
    location_id: z.string().min(1).max(200),
    actor_id: catalogPolicyUuidSchema,
    expected_version: positive,
    counted_quantity: safe,
    physical_delta: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().min(10).max(500),
    reference: z.string().min(3).max(200),
    before_state: z.string(),
    created_at: catalogPolicyInstantSchema,
    completed: z.number().int().min(0).max(1),
    approved: z.number().int().min(0).max(1)
  })
  .strict()
type Count = z.infer<typeof countSchema>
async function countProposal(database: D1Database, id: string): Promise<Count> {
  const rows = confirmedRows(
    await database
      .prepare(
        `SELECT p.*,
    EXISTS(SELECT 1 FROM inventory_admin_commands c WHERE c.id=p.command_id AND c.proposal_id=p.id AND c.action='count_propose' AND ${proof} AND ${proposalProof}) AS completed,
    EXISTS(SELECT 1 FROM inventory_count_approvals a WHERE a.proposal_id=p.id) AS approved FROM inventory_count_proposals p WHERE p.id=?1`
      )
      .bind(id)
      .all()
  )
  if (rows.length !== 1) throw new InventoryCommandError('proposal_unavailable')
  const parsed = countSchema.safeParse(catalogPolicyOwnJson(rows[0]))
  if (!parsed.success) throw new Error('inventory_count_source_invalid')
  return parsed.data
}
function validateEffect(source: Source, cmd: Command, claims: VerifiedSessionClaims, proposal: Count | null) {
  if (source.version !== cmd.body.expectedBalanceVersion || source.version >= Number.MAX_SAFE_INTEGER)
    throw new InventoryCommandError('version_conflict')
  if (cmd.action === 'count_approve') {
    if (
      !proposal ||
      proposal.completed !== 1 ||
      proposal.approved !== 0 ||
      proposal.variant_id !== source.variant_uuid ||
      proposal.location_id !== source.location_id
    )
      throw new InventoryCommandError('proposal_unavailable')
    if (proposal.actor_id === claims.identityId) throw new InventoryCommandError('approval_self')
    if (proposal.expected_version !== source.version || proposal.before_state !== source.snapshot)
      throw new InventoryCommandError('version_conflict')
  }
  const after =
    cmd.action === 'receipt'
      ? source.physical_quantity + cmd.body.quantity
      : cmd.action === 'count_propose'
        ? cmd.body.countedPhysicalQuantity
        : proposal!.counted_quantity
  if (!Number.isSafeInteger(after) || after > Number.MAX_SAFE_INTEGER) throw new InventoryCommandError('invalid_input')
  if (after === source.physical_quantity) throw new InventoryCommandError('no_change')
  // Receipts may recover an existing backorder deficit. A decrement may NEVER
  // consume blocked units or any persisted reservation, including expired TTLs.
  if (after < source.physical_quantity && after - source.blocked_quantity < source.reserved_quantity)
    throw new InventoryCommandError('insufficient_stock')
  return after
}
const precondition = `s.snapshot=?14 AND s.version=?21 AND s.location_count=1 AND s.active=1 AND s.kind='warehouse'
  AND s.ledger_physical=s.physical_quantity AND s.ledger_reserved=s.reserved_quantity
  AND ?15 BETWEEN 0 AND 9007199254740991 AND s.version<9007199254740991
  AND (?15>=s.physical_quantity OR ?15-s.blocked_quantity>=s.reserved_quantity)
  AND (?7<>'count_approve' OR EXISTS(SELECT 1 FROM inventory_count_proposals p JOIN inventory_admin_commands old ON old.id=p.command_id
    WHERE p.id=?17 AND p.variant_id=s.variant_uuid AND p.location_id=s.location_id AND p.actor_id<>?3
    AND p.expected_version=s.version AND p.before_state=s.snapshot AND p.counted_quantity=?15 AND p.physical_delta=?15-s.physical_quantity
    AND old.action='count_propose' AND old.proposal_id=p.id
    AND EXISTS(SELECT 1 FROM inventory_admin_audit a WHERE ${auditMatch.replaceAll('c.', 'old.')})
    AND NOT EXISTS(SELECT 1 FROM inventory_count_approvals approved WHERE approved.proposal_id=p.id)))`

/** Read-only canonical facts and authority shared by the bounded count importer.
 * Callers must preserve every location, reservation and ledger reconciliation
 * check; neither a missing balance nor an expired reservation means zero. */
export {
  factsSql as inventoryCountFactsSql,
  actorSql as inventoryCountActorSql,
  sourceRow as parseInventoryCountSource
}
export type InventoryCountSource = Source
const afterSql = `CASE WHEN ?7='count_propose' THEN s.snapshot ELSE json_set(s.snapshot,
  '$.balance.physicalQuantity',CAST(?15 AS INTEGER),'$.balance.version',s.version+1,'$.balance.updatedAt',${clock},
  '$.ledger.physical',s.ledger_physical+(CAST(?15 AS INTEGER)-s.physical_quantity),'$.ledger.count',s.movement_count+1) END`
function constraintFailure(error: unknown): boolean {
  if (isD1CheckConstraintFailure(error)) return true
  if (!(error instanceof Error)) return false
  const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value
  if (typeof message !== 'string') return false
  return [
    'inventory_admin_commands_immutable',
    'inventory_admin_audit_command',
    'inventory_admin_audit_immutable',
    'inventory_count_proposals_command',
    'inventory_count_proposals_immutable',
    'inventory_count_approvals_command',
    'inventory_count_approvals_immutable',
    'inventory_admin_movement_immutable'
  ].some(
    (name) =>
      message === name ||
      message === `D1_ERROR: ${name}: SQLITE_CONSTRAINT` ||
      message === `D1_ERROR: ${name}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`
  )
}
/** Single atomic D1 batch; only physical quantity/version change. Proposals are
 * immutable previews, not movements; all adjustments require a different actor. */
export async function executeD1AdminInventoryCommand(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  rawAction: InventoryCommandAction,
  rawTarget: AdminInventoryCommandTarget,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<InventoryCommandReceipt> {
  options = checked(
    z.object({ idempotencyKey: inventoryIdempotencyKeySchema, now: catalogPolicyInstantSchema.optional() }).strict(),
    options
  )
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated')
  if (options.now !== undefined) checked(catalogPolicyInstantSchema, options.now)
  await authorize(database, claims, 'inventory.write', options.now)
  const action = checked(inventoryCommandActionSchema, rawAction),
    target = checked(targetSchema, rawTarget),
    key = checked(inventoryIdempotencyKeySchema, options.idempotencyKey),
    cmd = parseCommand(action, input)
  if ((action === 'count_approve') !== Object.hasOwn(target, 'countId'))
    throw new InventoryCommandError('invalid_input')
  const serialized = canonicalJson(cmd.body),
    serializedTarget = canonicalJson(target),
    hash = await sha256Hex(canonicalJson({ action, target, input: cmd.body }))
  const existing = await replay(database, claims, key, hash, options.now)
  if (existing) return existing
  const source = await readSource(database, target.variantId, options.now),
    proposal = action === 'count_approve' ? await countProposal(database, target.countId!) : null
  await authorize(database, claims, 'inventory.write', options.now)
  const after = validateEffect(source, cmd, claims, proposal),
    id = crypto.randomUUID(),
    nonce = crypto.randomUUID(),
    proposalId = action === 'count_propose' ? crypto.randomUUID() : (target.countId ?? null),
    movementId = action === 'count_propose' ? null : crypto.randomUUID(),
    delta = after - source.physical_quantity
  const parameters = [
    options.now ?? null,
    claims.sessionId,
    claims.identityId,
    claims.sessionVersion,
    null,
    Number(target.variantId),
    action,
    serialized,
    serializedTarget,
    key,
    hash,
    id,
    nonce,
    source.snapshot,
    after,
    action === 'count_propose' ? delta : null,
    proposalId,
    movementId,
    crypto.randomUUID(),
    crypto.randomUUID(),
    cmd.body.expectedBalanceVersion
  ]
  const prefix = `WITH ${requestSql},actor AS (${actorSql}),${factsSql}`
  const commandPrefix = `${prefix},owned AS MATERIALIZED (SELECT c.* FROM inventory_admin_commands c JOIN actor ON actor.id=c.actor_id WHERE ${owned})`
  const sql = [
    `${prefix} INSERT INTO inventory_admin_commands(id,claim_nonce,actor_id,action,target,input,idempotency_key,payload_hash,
      variant_id,legacy_variant_id,location_id,expected_version,result_version,physical_before,physical_after,physical_delta,proposed_delta,
      proposal_id,movement_id,reason,reference,before_state,after_state,response,created_at)
      SELECT ?12,?13,actor.id,?7,?9,?8,?10,?11,s.variant_uuid,s.legacy_id,s.location_id,s.version,s.version+(?7<>'count_propose'),
        s.physical_quantity,CASE WHEN ?7='count_propose' THEN s.physical_quantity ELSE ?15 END,
        CASE WHEN ?7='count_propose' THEN 0 ELSE ?15-s.physical_quantity END,?16,?17,?18,json_extract(?8,'$.reason'),
        CASE WHEN ?7='count_approve' THEN (SELECT reference FROM inventory_count_proposals WHERE id=?17) ELSE json_extract(?8,'$.reference') END,
        s.snapshot,${afterSql},json_object('source','cloudflare','action',?7,'commandId',?12,'variantId',s.legacy_id,'variantUuid',s.variant_uuid,
          'warehouseId',s.location_id,'balanceVersion',s.version+(?7<>'count_propose'),'physicalQuantity',CASE WHEN ?7='count_propose' THEN s.physical_quantity ELSE ?15 END,
          'physicalDelta',CASE WHEN ?7='count_propose' THEN 0 ELSE ?15-s.physical_quantity END,'proposedPhysicalDelta',?16,'proposalId',?17,'updated',json('true')),${clock}
      FROM state s JOIN actor WHERE ${precondition}`,
    `${commandPrefix} UPDATE inventory_balances SET physical_quantity=(SELECT physical_after FROM owned),version=version+1,updated_at=(SELECT created_at FROM owned)
      WHERE ?7<>'count_propose' AND variant_id=(SELECT variant_id FROM owned) AND location_id=(SELECT location_id FROM owned)
      AND version=?21 AND EXISTS(SELECT 1 FROM owned c JOIN state s ON s.variant_uuid=c.variant_id AND s.location_id=c.location_id WHERE ${precondition})`,
    `${commandPrefix} INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
      SELECT c.movement_id,c.variant_id,c.location_id,CASE c.action WHEN 'receipt' THEN 'receipt' ELSE 'adjustment' END,c.physical_delta,0,
        'admin_inventory',c.id,'admin-inventory:'||c.id,c.id,c.reason,c.created_at FROM owned c WHERE c.action<>'count_propose'
        AND EXISTS(SELECT 1 FROM inventory_balances b WHERE b.variant_id=c.variant_id AND b.location_id=c.location_id AND b.version=c.result_version AND b.physical_quantity=c.physical_after)`,
    `${commandPrefix} INSERT INTO inventory_count_proposals(id,command_id,variant_id,location_id,actor_id,expected_version,counted_quantity,physical_delta,reason,reference,before_state,created_at)
      SELECT c.proposal_id,c.id,c.variant_id,c.location_id,c.actor_id,c.expected_version,json_extract(c.input,'$.countedPhysicalQuantity'),c.proposed_delta,c.reason,c.reference,c.before_state,c.created_at
      FROM owned c WHERE c.action='count_propose' AND EXISTS(SELECT 1 FROM state s WHERE s.snapshot=c.before_state)`,
    `${commandPrefix} INSERT INTO inventory_count_approvals(id,proposal_id,command_id,actor_id,reason,created_at)
      SELECT ?20,c.proposal_id,c.id,c.actor_id,c.reason,c.created_at FROM owned c WHERE c.action='count_approve' AND ${movementProof}`,
    `${commandPrefix} INSERT INTO inventory_admin_audit(id,command_id,${auditColumns})
      SELECT ?19,c.id,${auditColumns
        .split(',')
        .map((name) => `c.${name}`)
        .join(',')} FROM owned c WHERE ${effectProof}
      AND EXISTS(SELECT 1 FROM state s WHERE s.variant_uuid=c.variant_id AND s.location_id=c.location_id AND s.snapshot=c.after_state)`,
    `${commandPrefix} INSERT INTO inventory_admin_guards(id,satisfied) SELECT ?12,0 WHERE NOT EXISTS(
      SELECT 1 FROM owned c JOIN state s ON s.variant_uuid=c.variant_id AND s.location_id=c.location_id
      WHERE s.snapshot=c.after_state AND s.ledger_physical=s.physical_quantity AND s.ledger_reserved=s.reserved_quantity AND ${proof} AND ${effectProof})`
  ]
  try {
    confirmedBatch(
      await database.batch(sql.map((statement) => database.prepare(statement).bind(...parameters))),
      sql.length
    )
  } catch (error) {
    if (!constraintFailure(error)) throw error
    await authorize(database, claims, 'inventory.write', options.now)
    const winner = await replay(database, claims, key, hash, options.now)
    if (winner) return winner
    const latest = await readSource(database, target.variantId, options.now),
      latestProposal = action === 'count_approve' ? await countProposal(database, target.countId!) : null
    validateEffect(latest, cmd, claims, latestProposal)
    throw new InventoryCommandError('conflict')
  }
  const completed = await replay(database, claims, key, hash, options.now)
  if (!completed) throw new Error('inventory_command_completion_missing')
  return completed
}

/** Private contextual single-warehouse snapshot. Failed provider results never
 * turn into zero stock or empty history. Re-authorize after every awaited read. */
export async function readD1AdminInventoryVariant(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  legacyVariantId: string,
  options: { page: number; perPage: number; now?: string }
): Promise<AdminInventoryVariant> {
  options = checked(
    z
      .object({ page: positive.max(1_000_000), perPage: positive.max(50), now: catalogPolicyInstantSchema.optional() })
      .strict(),
    options
  )
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
    legacy = checked(inventoryLegacyIdSchema, legacyVariantId),
    page = checked(positive.max(1_000_000), options.page),
    perPage = checked(positive.max(50), options.perPage)
  if (options.now !== undefined) checked(catalogPolicyInstantSchema, options.now)
  const started = Date.now()
  const freshNow = () =>
    options.now === undefined
      ? undefined
      : new Date(Date.parse(options.now) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorize(database, claims, 'inventory.read', freshNow())
  const source = await readSource(database, legacy, options.now)
  await authorize(database, claims, 'inventory.read', freshNow())
  const batches = confirmedBatch(
    await database.batch([
      database
        .prepare(
          `SELECT m.id,m.movement_type AS type,m.physical_delta AS physicalDelta,m.reserved_delta AS reservedDelta,
      m.reason,CASE WHEN m.reference_type='admin_inventory' THEN c.reference ELSE NULL END AS reference,
      CASE WHEN ${proof} AND ${movementProof} THEN c.actor_id ELSE NULL END AS actorId,m.created_at AS createdAt
      FROM inventory_movements m LEFT JOIN inventory_admin_commands c ON c.movement_id=m.id
      WHERE m.variant_id=?1 AND m.location_id=?2 ORDER BY m.created_at DESC,m.id DESC LIMIT ?3 OFFSET ?4`
        )
        .bind(source.variant_uuid, source.location_id, perPage, (page - 1) * perPage),
      database
        .prepare(
          `SELECT p.*,EXISTS(SELECT 1 FROM inventory_admin_commands c WHERE c.id=p.command_id AND c.proposal_id=p.id AND ${proof} AND ${proposalProof}) AS completed,
      EXISTS(SELECT 1 FROM inventory_count_approvals a WHERE a.proposal_id=p.id) AS approved FROM inventory_count_proposals p
      WHERE p.variant_id=?1 AND p.location_id=?2 ORDER BY p.created_at DESC,p.id DESC LIMIT 51`
        )
        .bind(source.variant_uuid, source.location_id)
    ]),
    2
  )
  const latest = await readSource(database, legacy, options.now)
  await authorize(database, claims, 'inventory.read', freshNow())
  if (latest.snapshot !== source.snapshot) throw new InventoryCommandError('version_conflict')
  const write = await authorizeD1Session(database, claims, 'inventory.write', {
    requireMfa: true,
    ...(freshNow() === undefined ? {} : { now: freshNow() })
  })
  await authorize(database, claims, 'inventory.read', freshNow())
  const counts = batches[1]!.slice(0, 50).map((raw) => {
    const result = countSchema.safeParse(catalogPolicyOwnJson(raw))
    if (!result.success || result.data.completed !== 1) throw new Error('inventory_count_source_invalid')
    const p = result.data,
      stale = p.expected_version !== source.version || p.before_state !== source.snapshot
    return {
      id: p.id,
      proposedBy: p.actor_id,
      expectedBalanceVersion: p.expected_version,
      countedPhysicalQuantity: p.counted_quantity,
      physicalDelta: p.physical_delta,
      reason: p.reason,
      reference: p.reference,
      createdAt: p.created_at,
      approved: p.approved === 1,
      stale,
      canApprove: write.allowed && p.actor_id !== claims.identityId && p.approved === 0 && !stale
    }
  })
  const dto = {
    source: 'cloudflare',
    capabilities: {
      inventoryRead: true,
      inventoryReceipt: write.allowed,
      inventoryCountPropose: write.allowed,
      inventoryCountApprove: write.allowed
    },
    variant: {
      id: source.legacy_id,
      uuid: source.variant_uuid,
      productId: source.product_legacy_id,
      productUuid: source.product_uuid,
      sku: source.sku,
      format: source.format,
      status: source.status,
      unitBase: source.unit_base,
      unitLabel: source.unit_label
    },
    warehouse: { id: source.location_id, code: source.code, name: source.name },
    balance: {
      physicalQuantity: source.physical_quantity,
      blockedQuantity: source.blocked_quantity,
      safetyStock: source.safety_stock,
      reservedQuantity: source.reserved_quantity,
      sellableQuantity: source.sellable_quantity,
      version: source.version
    },
    reconciliation: {
      consistent: true,
      physicalLedgerQuantity: source.ledger_physical,
      reservedLedgerQuantity: source.ledger_reserved,
      movementCount: source.movement_count,
      reservationExpiryPending: source.expiry_pending
    },
    ledger: {
      items: batches[0],
      pagination: { page, perPage, total: source.movement_count, pages: Math.ceil(source.movement_count / perPage) }
    },
    counts: { items: counts, hasMore: batches[1]!.length > 50 },
    evaluatedAt: options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  const parsed = adminInventoryVariantSchema.safeParse(dto)
  if (!parsed.success) throw new Error('inventory_private_projection_invalid')
  return parsed.data
}

/** Literal bounded SKU/name lookup for inventory operators, not admin catalog.
 * A single SQL snapshot computes items and total; missing success never means 0. */
export async function readD1AdminInventoryVariants(
  database: D1Database,
  rawClaims: VerifiedSessionClaims | null,
  input: { q: string; page: number; perPage: number },
  now?: string
): Promise<AdminInventoryVariantSearch> {
  const claims = checked(claimsSchema, rawClaims, 'unauthenticated'),
    query = checked(inventoryVariantSearchInputSchema, input)
  if (now !== undefined) checked(catalogPolicyInstantSchema, now)
  const started = Date.now(),
    freshNow = () =>
      now === undefined
        ? undefined
        : new Date(Date.parse(now) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorize(database, claims, 'inventory.read', freshNow())
  const rows = confirmedRows(
    await database
      .prepare(
        `WITH candidates AS MATERIALIZED (
    SELECT v.legacy_id AS id,v.id AS uuid,v.sku,p.name,v.unit_base AS unitBase,v.unit_label AS unitLabel
    FROM variants v JOIN products p ON p.id=v.product_id WHERE v.legacy_id IS NOT NULL
      AND (instr(lower(v.sku),lower(?1))>0 OR instr(lower(p.name),lower(?1))>0)
  ) SELECT json_object('items',json(COALESCE((SELECT json_group_array(json_object('id',id,'uuid',uuid,'sku',sku,'name',name,'unitBase',unitBase,'unitLabel',unitLabel))
    FROM (SELECT * FROM candidates ORDER BY name COLLATE NOCASE,sku COLLATE NOCASE,id LIMIT ?2 OFFSET ?3)),'[]')),
    'total',(SELECT count(*) FROM candidates)) AS projection`
      )
      .bind(query.q, query.perPage, (query.page - 1) * query.perPage)
      .all()
  )
  await authorize(database, claims, 'inventory.read', freshNow())
  if (rows.length !== 1) throw new Error('inventory_search_source_invalid')
  const row = rows[0]
  if (!row || typeof row !== 'object') throw new Error('inventory_search_source_invalid')
  const raw: unknown = Object.getOwnPropertyDescriptor(row, 'projection')?.value
  if (typeof raw !== 'string') throw new Error('inventory_search_source_invalid')
  const projection: unknown = JSON.parse(raw),
    shape = z
      .object({ items: z.array(z.unknown()).max(25), total: safe })
      .strict()
      .safeParse(catalogPolicyOwnJson(projection))
  if (!shape.success) throw new Error('inventory_search_source_invalid')
  const parsed = adminInventoryVariantSearchSchema.safeParse({
    source: 'cloudflare',
    capabilities: { inventoryRead: true, inventorySearch: true },
    items: shape.data.items,
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total: shape.data.total,
      pages: Math.ceil(shape.data.total / query.perPage)
    },
    evaluatedAt: now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  })
  if (!parsed.success) throw new Error('inventory_search_projection_invalid')
  return parsed.data
}
