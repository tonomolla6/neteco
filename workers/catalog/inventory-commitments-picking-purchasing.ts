import {
  COMMITMENT_EXPIRING_SOON_DAYS,
  MAX_COMMITMENT_DAYS,
  inventoryOpsIntentHash,
  inventoryOpsReceiptSchema,
  inventoryOpsTargetSchema,
  lineDiscrepancy,
  maxCumulativeReceipt,
  parseInventoryOpsInput,
  type InventoryOpsAction,
  type InventoryOpsErrorCode,
  type InventoryOpsReceipt,
  type LineDiscrepancy
} from '../../shared/inventory-commitments-picking-purchasing'
import { InventoryError, reserveInventory, sellableExpression } from './inventory'

export class InventoryOpsError extends Error {
  constructor(readonly code: InventoryOpsErrorCode) {
    super(code)
    this.name = 'InventoryOpsError'
  }
}

interface Clock {
  now?: () => string
}
interface Claims {
  identityId: string
  sessionId: string
  sessionVersion: number
}
interface Gate {
  sql: string
  binds: (string | number)[]
}
interface Plan {
  statements: D1PreparedStatement[]
  /** Proof that this very command applied its compare-and-set. */
  gate: Gate
  data: Record<string, unknown>
  resultVersion: number
}
interface Context {
  database: D1Database
  claims: Claims
  commandId: string
  targetId: string
  input: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  now: string
}

const DAY_MS = 86_400_000
const fail = (code: InventoryOpsErrorCode): never => {
  throw new InventoryOpsError(code)
}
const stamp = (clock?: Clock) => clock?.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const plusDays = (instant: string, days: number) =>
  new Date(Date.parse(instant) + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')

async function deriveUuid(seed: string): Promise<string> {
  const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))), (b) =>
    b.toString(16).padStart(2, '0')
  )
    .join('')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Appends `AND <gate>` to a statement that already has a WHERE clause. */
function gated(database: D1Database, sql: string, binds: (string | number | null)[], gate: Gate) {
  return database.prepare(`${sql} AND ${gate.sql}`).bind(...binds, ...gate.binds)
}
const gateOf = (table: string, idColumn: string, id: string, commandId: string): Gate => ({
  sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${idColumn} = ? AND last_command_id = ?)`,
  binds: [id, commandId]
})

async function singleWarehouse(database: D1Database): Promise<string> {
  const { results } = await database
    .prepare("SELECT id FROM inventory_locations WHERE kind = 'warehouse' AND active = 1 LIMIT 2")
    .all<{ id: string }>()
  if (results.length !== 1) return fail('single_warehouse_required')
  return results[0]!.id
}

async function variantExists(database: D1Database, variantId: string) {
  const row = await database.prepare('SELECT 1 AS ok FROM variants WHERE id = ?').bind(variantId).first()
  if (!row) fail('variant_not_found')
}

// ------------------------------------------------------------------ INV-014
async function createCommitment(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  if (input.expiresAt <= now || input.expiresAt > plusDays(now, MAX_COMMITMENT_DAYS)) fail('commitment_term_invalid')
  await variantExists(database, input.variantId)
  if (input.customerId) {
    const customer = await database.prepare('SELECT 1 AS ok FROM customers WHERE id = ?').bind(input.customerId).first()
    if (!customer) fail('not_found')
  }
  const locationId = await singleWarehouse(database)
  const position = await database
    .prepare(
      `SELECT ${sellableExpression()} AS sellable FROM inventory_balances b WHERE b.variant_id = ? AND b.location_id = ?`
    )
    .bind(input.variantId, locationId)
    .first<{ sellable: number }>()
  // A contract never rides on backorder: the units must exist and be free.
  if (!position || position.sellable < input.quantity) fail('insufficient_stock')

  const reservationKey = `commitment:${targetId}`
  try {
    const reserved = await reserveInventory(database, {
      idempotencyKey: reservationKey,
      correlationId: commandId,
      lines: [{ variantId: input.variantId, locationId, quantity: input.quantity }],
      expiresAt: input.expiresAt,
      reason: `contract:${input.contractRef}`,
      now
    })
    if (reserved.outcome === 'conflict') fail('concurrency_conflict')
  } catch (error) {
    if (error instanceof InventoryError)
      fail(error.code === 'insufficient_stock' ? 'insufficient_stock' : 'invalid_input')
    throw error
  }
  const statement = database
    .prepare(
      `INSERT INTO inventory_contract_commitments(
         id, reservation_id, variant_id, location_id, customer_id, contract_ref, quantity, committed_until,
         max_renewals, renewal_count, version, last_command_id, created_by, created_at, updated_at)
       SELECT ?1, r.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 1, ?9, ?10, ?11, ?11
       FROM inventory_reservations r WHERE r.id = ?12 AND r.status = 'reserved'`
    )
    .bind(
      targetId,
      input.variantId,
      locationId,
      input.customerId ?? null,
      input.contractRef,
      input.quantity,
      input.expiresAt,
      input.maxRenewals,
      commandId,
      c.claims.identityId,
      now,
      reservationKey
    )
  return {
    statements: [statement],
    gate: gateOf('inventory_contract_commitments', 'id', targetId, commandId),
    resultVersion: 1,
    data: {
      commitmentId: targetId,
      reservationId: reservationKey,
      variantId: input.variantId,
      customerId: input.customerId ?? null,
      contractRef: input.contractRef,
      quantity: input.quantity,
      expiresAt: input.expiresAt,
      maxRenewals: input.maxRenewals,
      status: 'active'
    }
  }
}

async function loadCommitment(database: D1Database, id: string) {
  const row = await database
    .prepare(
      `SELECT c.id, c.reservation_id AS reservationId, c.version, c.renewal_count AS renewalCount,
              c.max_renewals AS maxRenewals, c.committed_until AS committedUntil, r.status AS reservationStatus
       FROM inventory_contract_commitments c JOIN inventory_reservations r ON r.id = c.reservation_id WHERE c.id = ?`
    )
    .bind(id)
    .first<{
      id: string
      reservationId: string
      version: number
      renewalCount: number
      maxRenewals: number
      committedUntil: string
      reservationStatus: string
    }>()
  return row ?? fail('not_found')
}

const reservationActive = `EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.id = c.reservation_id AND r.status = 'reserved'`

async function renewCommitment(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const current = await loadCommitment(database, targetId)
  if (current.version !== input.expectedVersion) fail('concurrency_conflict')
  if (current.reservationStatus !== 'reserved' || current.committedUntil <= now) fail('commitment_not_active')
  if (current.renewalCount >= current.maxRenewals) fail('commitment_renewals_exhausted')
  if (input.expiresAt <= current.committedUntil || input.expiresAt > plusDays(now, MAX_COMMITMENT_DAYS))
    fail('commitment_term_invalid')
  const gate = gateOf('inventory_contract_commitments', 'id', targetId, commandId)
  return {
    statements: [
      database
        .prepare(
          `UPDATE inventory_contract_commitments AS c
           SET committed_until = ?1, renewal_count = renewal_count + 1, version = version + 1,
               last_command_id = ?2, updated_at = ?3
           WHERE c.id = ?4 AND c.version = ?5 AND c.renewal_count < c.max_renewals
             AND ${reservationActive} AND r.expires_at > ?3)`
        )
        .bind(input.expiresAt, commandId, now, targetId, input.expectedVersion),
      gated(
        database,
        `UPDATE inventory_reservations SET expires_at = ?1, renewed_at = ?2, updated_at = ?2
         WHERE id = ?3 AND status = 'reserved' AND expires_at > ?2 AND expires_at < ?1`,
        [input.expiresAt, now, current.reservationId],
        gate
      )
    ],
    gate,
    resultVersion: current.version + 1,
    data: {
      commitmentId: targetId,
      status: 'active',
      expiresAt: input.expiresAt,
      renewalCount: current.renewalCount + 1
    }
  }
}

async function releaseCommitment(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const current = await loadCommitment(database, targetId)
  if (current.version !== input.expectedVersion) fail('concurrency_conflict')
  if (current.reservationStatus !== 'reserved') fail('commitment_not_active')
  const gate = gateOf('inventory_contract_commitments', 'id', targetId, commandId)
  return {
    statements: [
      database
        .prepare(
          `UPDATE inventory_contract_commitments AS c
           SET version = version + 1, release_reason = ?1, last_command_id = ?2, updated_at = ?3
           WHERE c.id = ?4 AND c.version = ?5 AND ${reservationActive})`
        )
        .bind(input.reason, commandId, now, targetId, input.expectedVersion),
      gated(
        database,
        `UPDATE inventory_reservations SET status = 'released', released_at = ?1, updated_at = ?1
         WHERE id = ?2 AND status = 'reserved'`,
        [now, current.reservationId],
        gate
      ),
      gated(
        database,
        `INSERT INTO inventory_movements(id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, reference_id, idempotency_key, correlation_id, reason, created_at)
         SELECT ?1 || ':release:' || l.variant_id || ':' || l.location_id, l.variant_id, l.location_id, 'release', 0,
                -l.quantity, 'reservation', l.reservation_id, ?1 || ':release:' || l.variant_id || ':' || l.location_id,
                ?2, ?3, ?4
         FROM inventory_reservation_lines l
         WHERE l.reservation_id = ?1 AND EXISTS (SELECT 1 FROM inventory_reservations WHERE id = ?1 AND status = 'released')`,
        [current.reservationId, commandId, input.reason, now],
        gate
      )
    ],
    gate,
    resultVersion: current.version + 1,
    data: { commitmentId: targetId, status: 'released' }
  }
}

// ------------------------------------------------------------------ INV-015
async function loadPickLocation(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT p.id, p.code, p.active, p.version, p.capacity_units AS capacityUnits, p.warehouse_location_id AS warehouseLocationId,
              COALESCE((SELECT SUM(quantity) FROM inventory_pick_stock WHERE pick_location_id = p.id), 0) AS stockUnits
       FROM inventory_pick_locations p WHERE p.id = ?`
    )
    .bind(id)
    .first<{
      id: string
      code: string
      active: number
      version: number
      capacityUnits: number | null
      warehouseLocationId: string
      stockUnits: number
    }>()
}
async function requirePickLocation(database: D1Database, id: string, mustBeActive: boolean) {
  const bin = (await loadPickLocation(database, id)) ?? fail('pick_location_not_found')
  if (mustBeActive && bin.active !== 1) fail('pick_location_inactive')
  return bin
}
async function loadPickStock(database: D1Database, pickLocationId: string, variantId: string) {
  return database
    .prepare('SELECT quantity, version FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ?')
    .bind(pickLocationId, variantId)
    .first<{ quantity: number; version: number }>()
}

async function createPickLocation(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const warehouse = await singleWarehouse(database)
  return {
    statements: [
      database
        .prepare(
          `INSERT INTO inventory_pick_locations(id, warehouse_location_id, code, zone, kind, pick_sequence, capacity_units,
             active, version, last_command_id, created_at, updated_at)
           VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?9, ?9)`
        )
        .bind(
          targetId,
          warehouse,
          input.code,
          input.zone,
          input.kind,
          input.pickSequence,
          input.capacityUnits ?? null,
          commandId,
          now
        )
    ],
    gate: gateOf('inventory_pick_locations', 'id', targetId, commandId),
    resultVersion: 1,
    data: { pickLocationId: targetId, code: input.code, warehouseLocationId: warehouse, kind: input.kind }
  }
}

async function updatePickLocation(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const bin = (await loadPickLocation(database, targetId)) ?? fail('not_found')
  if (bin.version !== input.expectedVersion) fail('concurrency_conflict')
  if (input.active === false && bin.stockUnits > 0) fail('pick_location_not_empty')
  const capacity = input.capacityUnits === undefined ? bin.capacityUnits : input.capacityUnits
  if (capacity !== null && capacity < bin.stockUnits) fail('pick_location_capacity_exceeded')
  const sets: string[] = []
  const binds: (string | number | null)[] = []
  if (input.pickSequence !== undefined) {
    sets.push('pick_sequence = ?')
    binds.push(input.pickSequence)
  }
  if (input.capacityUnits !== undefined) {
    sets.push('capacity_units = ?')
    binds.push(input.capacityUnits)
  }
  if (input.active !== undefined) {
    sets.push('active = ?')
    binds.push(input.active ? 1 : 0)
  }
  return {
    statements: [
      database
        .prepare(
          `UPDATE inventory_pick_locations SET ${sets.join(', ')}, version = version + 1, last_command_id = ?, updated_at = ?
           WHERE id = ? AND version = ?
             AND (? = 1 OR NOT EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND quantity > 0))`
        )
        .bind(...binds, commandId, now, targetId, input.expectedVersion, input.active === false ? 0 : 1, targetId)
    ],
    gate: gateOf('inventory_pick_locations', 'id', targetId, commandId),
    resultVersion: bin.version + 1,
    data: { pickLocationId: targetId, active: input.active ?? bin.active === 1 }
  }
}

function putawayStatements(
  database: D1Database,
  p: {
    pickLocationId: string
    variantId: string
    quantity: number
    expectedVersion: number
    commandId: string
    now: string
  },
  extraWhere: Gate
) {
  if (p.expectedVersion === 0)
    return gated(
      database,
      `INSERT INTO inventory_pick_stock(pick_location_id, variant_id, quantity, version, last_command_id, updated_at)
       SELECT ?1, ?2, ?3, 1, ?4, ?5
       WHERE NOT EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ?1 AND variant_id = ?2)`,
      [p.pickLocationId, p.variantId, p.quantity, p.commandId, p.now],
      extraWhere
    )
  return gated(
    database,
    `UPDATE inventory_pick_stock SET quantity = quantity + ?3, version = version + 1, last_command_id = ?4, updated_at = ?5
     WHERE pick_location_id = ?1 AND variant_id = ?2 AND version = ?6`,
    [p.pickLocationId, p.variantId, p.quantity, p.commandId, p.now, p.expectedVersion],
    extraWhere
  )
}
const always: Gate = { sql: '1 = 1', binds: [] }

async function putaway(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  await requirePickLocation(database, input.pickLocationId, true)
  await variantExists(database, input.variantId)
  const stock = await loadPickStock(database, input.pickLocationId, input.variantId)
  if ((stock?.version ?? 0) !== input.expectedVersion) fail('concurrency_conflict')
  const gate: Gate = {
    sql: 'EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ? AND last_command_id = ?)',
    binds: [input.pickLocationId, input.variantId, commandId]
  }
  return {
    statements: [
      putawayStatements(database, { ...input, commandId, now } as never, always),
      gated(
        database,
        `INSERT INTO inventory_pick_movements(id, kind, variant_id, from_pick_location_id, to_pick_location_id, quantity, reference, command_id, created_at)
         SELECT ?1, 'putaway', ?2, NULL, ?3, ?4, NULL, ?5, ?6 WHERE 1 = 1`,
        [targetId, input.variantId, input.pickLocationId, input.quantity, commandId, now],
        gate
      )
    ],
    gate: { sql: 'EXISTS (SELECT 1 FROM inventory_pick_movements WHERE id = ?)', binds: [targetId] },
    resultVersion: input.expectedVersion + 1,
    data: {
      movementId: targetId,
      kind: 'putaway',
      variantId: input.variantId,
      pickLocationId: input.pickLocationId,
      quantity: input.quantity,
      stockVersion: input.expectedVersion + 1
    }
  }
}

async function relocate(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  await requirePickLocation(database, input.fromPickLocationId, false)
  await requirePickLocation(database, input.toPickLocationId, true)
  const from = await loadPickStock(database, input.fromPickLocationId, input.variantId)
  if (!from || from.quantity < input.quantity) fail('pick_stock_insufficient')
  if (from.version !== input.expectedFromVersion) fail('concurrency_conflict')
  const to = await loadPickStock(database, input.toPickLocationId, input.variantId)
  if ((to?.version ?? 0) !== input.expectedToVersion) fail('concurrency_conflict')
  const fromGate: Gate = {
    sql: 'EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ? AND last_command_id = ?)',
    binds: [input.fromPickLocationId, input.variantId, commandId]
  }
  const toGate: Gate = { ...fromGate, binds: [input.toPickLocationId, input.variantId, commandId] }
  const destinationReady: Gate =
    input.expectedToVersion === 0
      ? {
          sql: `NOT EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ?)
                AND EXISTS (SELECT 1 FROM inventory_pick_locations WHERE id = ? AND active = 1)`,
          binds: [input.toPickLocationId, input.variantId, input.toPickLocationId]
        }
      : {
          sql: `EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ? AND version = ?)
                AND EXISTS (SELECT 1 FROM inventory_pick_locations WHERE id = ? AND active = 1)`,
          binds: [input.toPickLocationId, input.variantId, input.expectedToVersion, input.toPickLocationId]
        }
  return {
    statements: [
      // Source and destination preconditions are checked together so the move is all-or-nothing.
      gated(
        database,
        `UPDATE inventory_pick_stock SET quantity = quantity - ?3, version = version + 1, last_command_id = ?4, updated_at = ?5
         WHERE pick_location_id = ?1 AND variant_id = ?2 AND version = ?6 AND quantity >= ?3`,
        [input.fromPickLocationId, input.variantId, input.quantity, commandId, now, input.expectedFromVersion],
        destinationReady
      ),
      putawayStatements(
        database,
        {
          pickLocationId: input.toPickLocationId,
          variantId: input.variantId,
          quantity: input.quantity,
          expectedVersion: input.expectedToVersion,
          commandId,
          now
        },
        fromGate
      ),
      gated(
        database,
        `INSERT INTO inventory_pick_movements(id, kind, variant_id, from_pick_location_id, to_pick_location_id, quantity, reference, command_id, created_at)
         SELECT ?1, 'relocate', ?2, ?3, ?4, ?5, NULL, ?6, ?7 WHERE ${toGate.sql}`,
        [
          targetId,
          input.variantId,
          input.fromPickLocationId,
          input.toPickLocationId,
          input.quantity,
          commandId,
          now,
          ...toGate.binds
        ],
        fromGate
      )
    ],
    gate: { sql: 'EXISTS (SELECT 1 FROM inventory_pick_movements WHERE id = ?)', binds: [targetId] },
    resultVersion: input.expectedFromVersion + 1,
    data: {
      movementId: targetId,
      kind: 'relocate',
      variantId: input.variantId,
      fromPickLocationId: input.fromPickLocationId,
      toPickLocationId: input.toPickLocationId,
      quantity: input.quantity
    }
  }
}

async function confirmPick(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  await requirePickLocation(database, input.pickLocationId, false)
  const stock = await loadPickStock(database, input.pickLocationId, input.variantId)
  if (!stock || stock.quantity < input.quantity) fail('pick_stock_insufficient')
  if (stock.version !== input.expectedVersion) fail('concurrency_conflict')
  const gate: Gate = {
    sql: 'EXISTS (SELECT 1 FROM inventory_pick_stock WHERE pick_location_id = ? AND variant_id = ? AND last_command_id = ?)',
    binds: [input.pickLocationId, input.variantId, commandId]
  }
  return {
    statements: [
      gated(
        database,
        `UPDATE inventory_pick_stock SET quantity = quantity - ?3, version = version + 1, last_command_id = ?4, updated_at = ?5
         WHERE pick_location_id = ?1 AND variant_id = ?2 AND version = ?6 AND quantity >= ?3`,
        [input.pickLocationId, input.variantId, input.quantity, commandId, now, input.expectedVersion],
        always
      ),
      gated(
        database,
        `INSERT INTO inventory_pick_movements(id, kind, variant_id, from_pick_location_id, to_pick_location_id, quantity, reference, command_id, created_at)
         SELECT ?1, 'pick', ?2, ?3, NULL, ?4, ?5, ?6, ?7 WHERE 1 = 1`,
        [targetId, input.variantId, input.pickLocationId, input.quantity, input.reference, commandId, now],
        gate
      )
    ],
    gate: { sql: 'EXISTS (SELECT 1 FROM inventory_pick_movements WHERE id = ?)', binds: [targetId] },
    resultVersion: input.expectedVersion + 1,
    data: {
      movementId: targetId,
      kind: 'pick',
      variantId: input.variantId,
      pickLocationId: input.pickLocationId,
      quantity: input.quantity,
      reference: input.reference
    }
  }
}

// ------------------------------------------------------------------ INV-016
async function loadPurchaseOrder(database: D1Database, id: string) {
  const header = await database
    .prepare('SELECT id, status, version, currency, supplier_id AS supplierId FROM purchase_orders WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string; version: number; currency: string; supplierId: string }>()
  if (!header) return fail('not_found')
  const { results: lines } = await database
    .prepare(
      `SELECT line_index AS lineIndex, variant_id AS variantId, expected_quantity AS expectedQuantity,
              received_quantity AS receivedQuantity, rejected_quantity AS rejectedQuantity, unit_cost_cents AS unitCostCents
       FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_index`
    )
    .bind(id)
    .all<{
      lineIndex: number
      variantId: string
      expectedQuantity: number
      receivedQuantity: number
      rejectedQuantity: number
      unitCostCents: number
    }>()
  return { ...header, lines }
}

async function createPurchaseOrder(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const supplier = await database
    .prepare('SELECT currency FROM catalog_suppliers WHERE id = ? AND is_active = 1')
    .bind(input.supplierId)
    .first<{ currency: string }>()
  if (!supplier) fail('supplier_not_found')
  const lines = input.lines as { variantId: string; expectedQuantity: number; unitCostCents: number }[]
  const marks = lines.map(() => '?').join(',')
  const found = await database
    .prepare(`SELECT id FROM variants WHERE id IN (${marks})`)
    .bind(...lines.map((l) => l.variantId))
    .all<{ id: string }>()
  if (found.results.length !== lines.length) fail('variant_not_found')
  const total = lines.reduce((sum, l) => sum + l.expectedQuantity * l.unitCostCents, 0)
  const gate = gateOf('purchase_orders', 'id', targetId, commandId)
  return {
    statements: [
      database
        .prepare(
          `INSERT INTO purchase_orders(id, po_number, supplier_id, status, currency, expected_at, notes, version, last_command_id, created_by, created_at, updated_at)
           VALUES(?1, ?2, ?3, 'draft', ?4, ?5, ?6, 1, ?7, ?8, ?9, ?9)`
        )
        .bind(
          targetId,
          input.poNumber,
          input.supplierId,
          supplier!.currency,
          input.expectedAt ?? null,
          input.notes ?? null,
          commandId,
          c.claims.identityId,
          now
        ),
      ...lines.map((line, index) =>
        gated(
          database,
          `INSERT INTO purchase_order_lines(purchase_order_id, line_index, variant_id, expected_quantity, received_quantity, rejected_quantity, unit_cost_cents)
           SELECT ?1, ?2, ?3, ?4, 0, 0, ?5 WHERE 1 = 1`,
          [targetId, index, line.variantId, line.expectedQuantity, line.unitCostCents],
          gate
        )
      )
    ],
    gate,
    resultVersion: 1,
    data: {
      purchaseOrderId: targetId,
      poNumber: input.poNumber,
      supplierId: input.supplierId,
      status: 'draft',
      currency: supplier!.currency,
      totalCostCents: total,
      lineCount: lines.length
    }
  }
}

function transition(
  nextStatus: 'ordered' | 'cancelled' | 'closed',
  allowed: string[],
  extraReason: boolean
): (c: Context) => Promise<Plan> {
  return async (c) => {
    const { database, input, now, targetId, commandId } = c
    const po = await loadPurchaseOrder(database, targetId)
    if (po.version !== input.expectedVersion) fail('concurrency_conflict')
    if (!allowed.includes(po.status)) fail('purchase_order_state_invalid')
    const statuses = allowed.map((s) => `'${s}'`).join(',')
    return {
      statements: [
        database
          .prepare(
            `UPDATE purchase_orders SET status = ?1, version = version + 1, last_command_id = ?2, updated_at = ?3
             ${nextStatus === 'cancelled' ? ', cancel_reason = ?6' : ''}
             WHERE id = ?4 AND version = ?5 AND status IN (${statuses})`
          )
          .bind(nextStatus, commandId, now, targetId, input.expectedVersion, ...(extraReason ? [input.reason] : []))
      ],
      gate: gateOf('purchase_orders', 'id', targetId, commandId),
      resultVersion: po.version + 1,
      data: { purchaseOrderId: targetId, status: nextStatus }
    }
  }
}

async function recordReceipt(c: Context): Promise<Plan> {
  const { database, input, now, targetId: receiptId, commandId } = c
  const poId = input.purchaseOrderId as string
  const po = await loadPurchaseOrder(database, poId)
  if (po.version !== input.expectedVersion) fail('concurrency_conflict')
  if (!['ordered', 'partially_received'].includes(po.status)) fail('purchase_order_state_invalid')
  const duplicate = await database
    .prepare('SELECT 1 AS ok FROM purchase_receipts WHERE purchase_order_id = ? AND receipt_number = ?')
    .bind(poId, input.receiptNumber)
    .first()
  if (duplicate) fail('duplicate_receipt_number')
  const warehouse = await singleWarehouse(database)
  const byIndex = new Map(po.lines.map((l) => [l.lineIndex, l]))
  const received = input.lines as {
    lineIndex: number
    receivedQuantity: number
    rejectedQuantity: number
    pickLocationId?: string
  }[]
  const discrepancies: Record<string, unknown>[] = []
  const after = new Map(po.lines.map((l) => [l.lineIndex, { ...l }]))
  for (const line of received) {
    const base = byIndex.get(line.lineIndex) ?? fail('receipt_line_not_found')
    const next = after.get(line.lineIndex)!
    next.receivedQuantity = base.receivedQuantity + line.receivedQuantity
    next.rejectedQuantity = base.rejectedQuantity + line.rejectedQuantity
    if (next.receivedQuantity > maxCumulativeReceipt(base.expectedQuantity)) fail('over_receipt_exceeds_tolerance')
    if (line.pickLocationId) {
      const bin = await requirePickLocation(database, line.pickLocationId, true)
      if (bin.warehouseLocationId !== warehouse) fail('single_warehouse_required')
    }
    const kind = lineDiscrepancy(next)
    if (kind === 'over' || kind === 'rejected')
      discrepancies.push({
        lineIndex: line.lineIndex,
        variantId: base.variantId,
        kind,
        expectedQuantity: base.expectedQuantity,
        receivedQuantity: next.receivedQuantity,
        rejectedQuantity: next.rejectedQuantity
      })
  }
  const complete = [...after.values()].every((l) => l.receivedQuantity >= l.expectedQuantity)
  const status = complete ? 'received' : 'partially_received'
  const gate = gateOf('purchase_orders', 'id', poId, commandId)
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE purchase_orders SET status = ?1, version = version + 1, last_command_id = ?2, updated_at = ?3
         WHERE id = ?4 AND version = ?5 AND status IN ('ordered', 'partially_received')`
      )
      .bind(status, commandId, now, poId, input.expectedVersion),
    gated(
      database,
      `INSERT INTO purchase_receipts(id, purchase_order_id, receipt_number, received_at, notes, command_id, actor_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE 1 = 1`,
      [
        receiptId,
        poId,
        input.receiptNumber,
        input.receivedAt,
        input.notes ?? null,
        commandId,
        c.claims.identityId,
        now
      ],
      gate
    )
  ]
  let receivedUnits = 0
  for (const line of received) {
    const base = byIndex.get(line.lineIndex)!
    const movementId = `${receiptId}:${line.lineIndex}`
    if (line.receivedQuantity > 0) {
      receivedUnits += line.receivedQuantity
      statements.push(
        gated(
          database,
          `INSERT INTO inventory_balances(variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at)
           SELECT ?1, ?2, 0, 0, 1, ?3, ?3
           WHERE NOT EXISTS (SELECT 1 FROM inventory_balances WHERE variant_id = ?1 AND location_id = ?2)`,
          [base.variantId, warehouse, now],
          gate
        ),
        gated(
          database,
          `UPDATE inventory_balances SET physical_quantity = physical_quantity + ?3, version = version + 1, updated_at = ?4
           WHERE variant_id = ?1 AND location_id = ?2`,
          [base.variantId, warehouse, line.receivedQuantity, now],
          gate
        ),
        gated(
          database,
          `INSERT INTO inventory_movements(id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
             reference_type, reference_id, idempotency_key, correlation_id, reason, created_at)
           SELECT ?1, ?2, ?3, 'receipt', ?4, 0, 'purchase_receipt', ?5, ?1, ?6, ?7, ?8 WHERE 1 = 1`,
          [
            movementId,
            base.variantId,
            warehouse,
            line.receivedQuantity,
            receiptId,
            commandId,
            `Recepcion ${input.receiptNumber}`,
            now
          ],
          gate
        )
      )
    }
    statements.push(
      gated(
        database,
        `INSERT INTO purchase_receipt_lines(receipt_id, line_index, variant_id, received_quantity, rejected_quantity, unit_cost_cents, movement_id, pick_location_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE 1 = 1`,
        [
          receiptId,
          line.lineIndex,
          base.variantId,
          line.receivedQuantity,
          line.rejectedQuantity,
          base.unitCostCents,
          line.receivedQuantity > 0 ? movementId : null,
          line.pickLocationId ?? null
        ],
        gate
      ),
      gated(
        database,
        `UPDATE purchase_order_lines SET received_quantity = received_quantity + ?3, rejected_quantity = rejected_quantity + ?4
         WHERE purchase_order_id = ?1 AND line_index = ?2`,
        [poId, line.lineIndex, line.receivedQuantity, line.rejectedQuantity],
        gate
      )
    )
    if (line.pickLocationId) {
      statements.push(
        database
          .prepare(
            `INSERT INTO inventory_pick_stock(pick_location_id, variant_id, quantity, version, last_command_id, updated_at)
             SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE EXISTS (SELECT 1 FROM purchase_orders WHERE id = ?6 AND last_command_id = ?4)
             ON CONFLICT(pick_location_id, variant_id) DO UPDATE SET quantity = quantity + excluded.quantity,
               version = version + 1, last_command_id = excluded.last_command_id, updated_at = excluded.updated_at`
          )
          .bind(line.pickLocationId, base.variantId, line.receivedQuantity, commandId, now, poId),
        gated(
          database,
          `INSERT INTO inventory_pick_movements(id, kind, variant_id, from_pick_location_id, to_pick_location_id, quantity, reference, command_id, created_at)
           SELECT ?1, 'receipt_putaway', ?2, NULL, ?3, ?4, ?5, ?6, ?7 WHERE 1 = 1`,
          [
            await deriveUuid(`${movementId}:putaway`),
            base.variantId,
            line.pickLocationId,
            line.receivedQuantity,
            input.receiptNumber,
            commandId,
            now
          ],
          gate
        )
      )
    }
  }
  for (const [index, document] of (input.documents as Record<string, unknown>[]).entries()) {
    const documentId = await deriveUuid(`${receiptId}:document:${index}`)
    statements.push(
      gated(
        database,
        `INSERT INTO purchase_documents(id, purchase_order_id, receipt_id, kind, reference, sha256, size_bytes, media_type, command_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE 1 = 1`,
        [
          documentId,
          poId,
          receiptId,
          document.kind as string,
          document.reference as string,
          document.sha256 as string,
          document.sizeBytes as number,
          document.mediaType as string,
          commandId,
          now
        ],
        gate
      )
    )
  }
  return {
    statements,
    gate: {
      sql: 'EXISTS (SELECT 1 FROM purchase_receipts WHERE id = ? AND command_id = ?)',
      binds: [receiptId, commandId]
    },
    resultVersion: po.version + 1,
    data: {
      receiptId,
      purchaseOrderId: poId,
      receiptNumber: input.receiptNumber,
      status,
      receivedUnits,
      discrepancies
    }
  }
}

async function attachDocument(c: Context): Promise<Plan> {
  const { database, input, now, targetId, commandId } = c
  const po = await database
    .prepare('SELECT 1 AS ok FROM purchase_orders WHERE id = ?')
    .bind(input.purchaseOrderId)
    .first()
  if (!po) fail('not_found')
  if (input.receiptId) {
    const receipt = await database
      .prepare('SELECT 1 AS ok FROM purchase_receipts WHERE id = ? AND purchase_order_id = ?')
      .bind(input.receiptId, input.purchaseOrderId)
      .first()
    if (!receipt) fail('not_found')
  }
  return {
    statements: [
      database
        .prepare(
          `INSERT INTO purchase_documents(id, purchase_order_id, receipt_id, kind, reference, sha256, size_bytes, media_type, command_id, created_at)
           VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          targetId,
          input.purchaseOrderId,
          input.receiptId ?? null,
          input.kind,
          input.reference,
          input.sha256,
          input.sizeBytes,
          input.mediaType,
          commandId,
          now
        )
    ],
    gate: {
      sql: 'EXISTS (SELECT 1 FROM purchase_documents WHERE id = ? AND command_id = ?)',
      binds: [targetId, commandId]
    },
    resultVersion: 1,
    data: {
      documentId: targetId,
      purchaseOrderId: input.purchaseOrderId,
      receiptId: input.receiptId ?? null,
      kind: input.kind
    }
  }
}

const handlers: Record<InventoryOpsAction, (c: Context) => Promise<Plan>> = {
  create_commitment: createCommitment,
  renew_commitment: renewCommitment,
  release_commitment: releaseCommitment,
  create_pick_location: createPickLocation,
  update_pick_location: updatePickLocation,
  putaway,
  relocate,
  confirm_pick: confirmPick,
  create_purchase_order: createPurchaseOrder,
  submit_purchase_order: transition('ordered', ['draft'], false),
  cancel_purchase_order: transition('cancelled', ['draft', 'ordered'], true),
  close_purchase_order: transition('closed', ['partially_received'], false),
  record_receipt: recordReceipt,
  attach_document: attachDocument
}

function mapDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  const table: [string, InventoryOpsErrorCode][] = [
    ['pick_stock_exceeds_physical', 'pick_stock_exceeds_physical'],
    ['pick_location_capacity_exceeded', 'pick_location_capacity_exceeded'],
    ['pick_location_inactive', 'pick_location_inactive'],
    ['pick_location_requires_active_warehouse', 'single_warehouse_required'],
    ['purchase_orders.po_number', 'duplicate_po_number'],
    ['purchase_receipts.purchase_order_id, purchase_receipts.receipt_number', 'duplicate_receipt_number'],
    ['purchase_documents.sha256', 'duplicate_document'],
    ['inventory_pick_locations.warehouse_location_id, inventory_pick_locations.code', 'duplicate_pick_location'],
    ['UNIQUE constraint failed', 'concurrency_conflict'],
    ['FOREIGN KEY constraint failed', 'concurrency_conflict']
  ]
  for (const [needle, code] of table) if (message.includes(needle)) throw new InventoryOpsError(code)
  throw error
}

async function findCommand(database: D1Database, commandId: string) {
  return database
    .prepare(
      'SELECT actor_id AS actorId, action, target_id AS targetId, payload_hash AS payloadHash, response FROM inventory_ops_commands WHERE command_id = ?'
    )
    .bind(commandId)
    .first<{ actorId: string; action: string; targetId: string; payloadHash: string; response: string }>()
}

function replay(
  stored: NonNullable<Awaited<ReturnType<typeof findCommand>>>,
  claims: Claims,
  action: string,
  targetId: string,
  payloadHash: string
): InventoryOpsReceipt {
  if (
    stored.payloadHash !== payloadHash ||
    stored.action !== action ||
    stored.targetId !== targetId ||
    stored.actorId !== claims.identityId
  )
    return fail('idempotency_payload_mismatch')
  return inventoryOpsReceiptSchema.parse(JSON.parse(stored.response))
}

/** Single entry point for every write of INV-014/015/016. */
export async function executeInventoryOpsCommand(
  database: D1Database,
  claims: Claims,
  action: InventoryOpsAction,
  targetId: string,
  input: unknown,
  commandId: string,
  clock?: Clock
): Promise<InventoryOpsReceipt> {
  const now = stamp(clock)
  if (!inventoryOpsTargetSchema.safeParse(targetId).success || !inventoryOpsTargetSchema.safeParse(commandId).success)
    fail('invalid_input')
  let parsed: Record<string, unknown>
  let payloadHash: string
  try {
    parsed = parseInventoryOpsInput(action, input)
    payloadHash = await inventoryOpsIntentHash(action, targetId, input)
  } catch {
    return fail('invalid_input')
  }
  const stored = await findCommand(database, commandId)
  if (stored) return replay(stored, claims, action, targetId, payloadHash)

  const plan = await handlers[action]({ database, claims, commandId, targetId, input: parsed, now })
  const receipt: InventoryOpsReceipt = {
    source: 'cloudflare',
    commandId,
    action,
    targetId,
    payloadHash,
    resultVersion: plan.resultVersion,
    data: plan.data,
    createdAt: now
  }
  const journal = database
    .prepare(
      `INSERT INTO inventory_ops_commands(command_id, actor_id, action, target_id, payload_hash, response, result_version, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${plan.gate.sql}`
    )
    .bind(
      commandId,
      claims.identityId,
      action,
      targetId,
      payloadHash,
      JSON.stringify(receipt),
      plan.resultVersion,
      now,
      ...plan.gate.binds
    )
  try {
    await database.batch([...plan.statements, journal])
  } catch (error) {
    const raced = await findCommand(database, commandId)
    if (raced) return replay(raced, claims, action, targetId, payloadHash)
    mapDatabaseError(error)
  }
  const done = await findCommand(database, commandId)
  if (!done) return fail('concurrency_conflict')
  return receipt
}

// ------------------------------------------------------------------ reads
export interface CommitmentView {
  id: string
  reservationId: string
  variantId: string
  sku: string | null
  customerId: string | null
  contractRef: string
  quantity: number
  locationId: string
  expiresAt: string
  status: 'active' | 'fulfilled' | 'released' | 'expired'
  overdue: boolean
  expiringSoon: boolean
  renewalCount: number
  maxRenewals: number
  renewalsRemaining: number
  releaseReason: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export async function listCommitments(
  database: D1Database,
  filter: { variantId?: string; customerId?: string; status?: string },
  now: string
): Promise<CommitmentView[]> {
  const soon = plusDays(now, COMMITMENT_EXPIRING_SOON_DAYS)
  const conditions: string[] = []
  const binds: (string | number)[] = [now, soon]
  if (filter.variantId) {
    conditions.push('c.variant_id = ?')
    binds.push(filter.variantId)
  }
  if (filter.customerId) {
    conditions.push('c.customer_id = ?')
    binds.push(filter.customerId)
  }
  const outer = filter.status ? 'WHERE status = ?' : ''
  if (filter.status) binds.push(filter.status)
  const { results } = await database
    .prepare(
      `SELECT * FROM (
         SELECT c.id, c.reservation_id AS reservationId, c.variant_id AS variantId, v.sku AS sku, c.customer_id AS customerId,
                c.contract_ref AS contractRef, c.quantity, c.location_id AS locationId, r.expires_at AS expiresAt,
                CASE r.status WHEN 'reserved' THEN 'active' WHEN 'assigned' THEN 'fulfilled' ELSE r.status END AS status,
                (r.status = 'reserved' AND r.expires_at <= ?1) AS overdue,
                (r.status = 'reserved' AND r.expires_at > ?1 AND r.expires_at <= ?2) AS expiringSoon,
                c.renewal_count AS renewalCount, c.max_renewals AS maxRenewals, c.release_reason AS releaseReason,
                c.version, c.created_at AS createdAt, c.updated_at AS updatedAt
         FROM inventory_contract_commitments c
         JOIN inventory_reservations r ON r.id = c.reservation_id
         JOIN variants v ON v.id = c.variant_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ) ${outer} ORDER BY expiresAt, id LIMIT 200`
    )
    .bind(...binds)
    .all<Record<string, unknown>>()
  return results.map((row) => ({
    ...(row as unknown as CommitmentView),
    overdue: Number(row.overdue) === 1,
    expiringSoon: Number(row.expiringSoon) === 1,
    renewalsRemaining: Number(row.maxRenewals) - Number(row.renewalCount)
  }))
}

export interface PickLocationView {
  id: string
  code: string
  zone: string
  kind: string
  pickSequence: number
  capacityUnits: number | null
  active: boolean
  warehouseLocationId: string
  stockUnits: number
  version: number
}
export async function listPickLocations(
  database: D1Database,
  _filter: Record<string, never> | object = {}
): Promise<PickLocationView[]> {
  const { results } = await database
    .prepare(
      `SELECT p.id, p.code, p.zone, p.kind, p.pick_sequence AS pickSequence, p.capacity_units AS capacityUnits, p.active,
              p.warehouse_location_id AS warehouseLocationId, p.version,
              COALESCE((SELECT SUM(s.quantity) FROM inventory_pick_stock s WHERE s.pick_location_id = p.id), 0) AS stockUnits
       FROM inventory_pick_locations p ORDER BY p.pick_sequence, p.code LIMIT 500`
    )
    .all<Record<string, unknown>>()
  return results.map((row) => ({ ...(row as unknown as PickLocationView), active: Number(row.active) === 1 }))
}

export async function listPickStock(database: D1Database, variantId: string) {
  const { results } = await database
    .prepare(
      `SELECT s.pick_location_id AS pickLocationId, p.code, p.zone, p.kind, s.variant_id AS variantId, s.quantity, s.version
       FROM inventory_pick_stock s JOIN inventory_pick_locations p ON p.id = s.pick_location_id
       WHERE s.variant_id = ? ORDER BY p.pick_sequence, p.code`
    )
    .bind(variantId)
    .all<{
      pickLocationId: string
      code: string
      zone: string
      kind: string
      variantId: string
      quantity: number
      version: number
    }>()
  return results
}

export async function planPick(database: D1Database, variantId: string, quantity: number) {
  const { results } = await database
    .prepare(
      `SELECT s.pick_location_id AS pickLocationId, p.code, p.zone, s.quantity AS available
       FROM inventory_pick_stock s JOIN inventory_pick_locations p ON p.id = s.pick_location_id
       WHERE s.variant_id = ? AND s.quantity > 0 AND p.active = 1 AND p.kind = 'pick'
       ORDER BY p.pick_sequence, p.code`
    )
    .bind(variantId)
    .all<{ pickLocationId: string; code: string; zone: string; available: number }>()
  let remaining = quantity
  const allocations: { pickLocationId: string; code: string; zone: string; quantity: number; available: number }[] = []
  for (const bin of results) {
    if (remaining <= 0) break
    const take = Math.min(remaining, bin.available)
    allocations.push({ ...bin, quantity: take })
    remaining -= take
  }
  return { variantId, requested: quantity, allocations, allocated: quantity - remaining, shortfall: remaining }
}

export async function readPickConsistency(database: D1Database, variantId?: string) {
  const { results } = await database
    .prepare(
      `SELECT b.variant_id AS variantId, b.location_id AS locationId, b.physical_quantity AS physicalQuantity,
              b.blocked_quantity AS blockedQuantity,
              COALESCE((SELECT SUM(l.quantity) FROM inventory_reservation_lines l
                        JOIN inventory_reservations r ON r.id = l.reservation_id
                        WHERE r.status = 'reserved' AND l.variant_id = b.variant_id AND l.location_id = b.location_id), 0) AS reservedQuantity,
              ${sellableExpression()} AS sellableQuantity,
              COALESCE((SELECT SUM(s.quantity) FROM inventory_pick_stock s
                        JOIN inventory_pick_locations p ON p.id = s.pick_location_id
                        WHERE s.variant_id = b.variant_id AND p.warehouse_location_id = b.location_id), 0) AS locatedQuantity
       FROM inventory_balances b
       ${variantId ? 'WHERE b.variant_id = ?' : ''}
       ORDER BY b.variant_id LIMIT 500`
    )
    .bind(...(variantId ? [variantId] : []))
    .all<Record<string, number | string>>()
  return {
    items: results.map((row) => {
      const located = Number(row.locatedQuantity)
      const physical = Number(row.physicalQuantity)
      return {
        ...row,
        locatedQuantity: located,
        unlocatedQuantity: physical - located,
        consistent: located <= physical
      } as Record<string, number | string | boolean>
    })
  }
}

export interface PurchaseOrderSummaryRow {
  id: string
  poNumber: string
  supplierId: string
  supplierName: string
  status: string
  currency: string
  expectedAt: string | null
  totalCostCents: number
  receivedCostCents: number
  expectedUnits: number
  receivedUnits: number
  rejectedUnits: number
  hasDiscrepancy: boolean
  version: number
  createdAt: string
}

const poDiscrepancySql = `EXISTS (SELECT 1 FROM purchase_order_lines x WHERE x.purchase_order_id = po.id
  AND (x.received_quantity > x.expected_quantity OR x.rejected_quantity > 0
       OR (po.status = 'closed' AND x.received_quantity < x.expected_quantity)))`

export async function listPurchaseOrders(
  database: D1Database,
  filter: { status?: string; supplierId?: string }
): Promise<PurchaseOrderSummaryRow[]> {
  const conditions: string[] = []
  const binds: string[] = []
  if (filter.status) {
    conditions.push('po.status = ?')
    binds.push(filter.status)
  }
  if (filter.supplierId) {
    conditions.push('po.supplier_id = ?')
    binds.push(filter.supplierId)
  }
  const { results } = await database
    .prepare(
      `SELECT po.id, po.po_number AS poNumber, po.supplier_id AS supplierId, s.name AS supplierName, po.status, po.currency,
              po.expected_at AS expectedAt, po.version, po.created_at AS createdAt,
              COALESCE(SUM(l.expected_quantity * l.unit_cost_cents), 0) AS totalCostCents,
              COALESCE(SUM(l.received_quantity * l.unit_cost_cents), 0) AS receivedCostCents,
              COALESCE(SUM(l.expected_quantity), 0) AS expectedUnits,
              COALESCE(SUM(l.received_quantity), 0) AS receivedUnits,
              COALESCE(SUM(l.rejected_quantity), 0) AS rejectedUnits,
              ${poDiscrepancySql} AS hasDiscrepancy
       FROM purchase_orders po
       JOIN catalog_suppliers s ON s.id = po.supplier_id
       LEFT JOIN purchase_order_lines l ON l.purchase_order_id = po.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       GROUP BY po.id ORDER BY po.created_at DESC, po.id LIMIT 200`
    )
    .bind(...binds)
    .all<Record<string, unknown>>()
  return results.map((row) => ({
    ...(row as unknown as PurchaseOrderSummaryRow),
    hasDiscrepancy: Number(row.hasDiscrepancy) === 1
  }))
}

export async function readPurchaseOrder(database: D1Database, id: string) {
  const header = await database
    .prepare(
      `SELECT po.id, po.po_number AS poNumber, po.supplier_id AS supplierId, s.name AS supplierName, po.status, po.currency,
              po.expected_at AS expectedAt, po.notes, po.cancel_reason AS cancelReason, po.version,
              po.created_at AS createdAt, po.updated_at AS updatedAt
       FROM purchase_orders po JOIN catalog_suppliers s ON s.id = po.supplier_id WHERE po.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>()
  if (!header) return null
  const [lines, receipts, receiptLines, documents] = await Promise.all([
    database
      .prepare(
        `SELECT l.line_index AS lineIndex, l.variant_id AS variantId, v.sku, l.expected_quantity AS expectedQuantity,
                l.received_quantity AS receivedQuantity, l.rejected_quantity AS rejectedQuantity, l.unit_cost_cents AS unitCostCents
         FROM purchase_order_lines l JOIN variants v ON v.id = l.variant_id WHERE l.purchase_order_id = ? ORDER BY l.line_index`
      )
      .bind(id)
      .all<{
        lineIndex: number
        variantId: string
        sku: string
        expectedQuantity: number
        receivedQuantity: number
        rejectedQuantity: number
        unitCostCents: number
      }>(),
    database
      .prepare(
        `SELECT id, receipt_number AS receiptNumber, received_at AS receivedAt, notes, actor_id AS actorId, created_at AS createdAt
         FROM purchase_receipts WHERE purchase_order_id = ? ORDER BY created_at, id`
      )
      .bind(id)
      .all<{
        id: string
        receiptNumber: string
        receivedAt: string
        notes: string | null
        actorId: string
        createdAt: string
      }>(),
    database
      .prepare(
        `SELECT rl.receipt_id AS receiptId, rl.line_index AS lineIndex, rl.variant_id AS variantId, rl.received_quantity AS receivedQuantity,
                rl.rejected_quantity AS rejectedQuantity, rl.unit_cost_cents AS unitCostCents, rl.movement_id AS movementId,
                rl.pick_location_id AS pickLocationId
         FROM purchase_receipt_lines rl JOIN purchase_receipts r ON r.id = rl.receipt_id
         WHERE r.purchase_order_id = ? ORDER BY rl.receipt_id, rl.line_index`
      )
      .bind(id)
      .all<{
        receiptId: string
        lineIndex: number
        variantId: string
        receivedQuantity: number
        rejectedQuantity: number
        unitCostCents: number
        movementId: string | null
        pickLocationId: string | null
      }>(),
    database
      .prepare(
        `SELECT id, receipt_id AS receiptId, kind, reference, sha256, size_bytes AS sizeBytes, media_type AS mediaType, created_at AS createdAt
         FROM purchase_documents WHERE purchase_order_id = ? ORDER BY created_at, id`
      )
      .bind(id)
      .all<{
        id: string
        receiptId: string | null
        kind: string
        reference: string
        sha256: string
        sizeBytes: number
        mediaType: string
        createdAt: string
      }>()
  ])
  const detailedLines = lines.results.map((line) => ({
    ...line,
    discrepancy: closedShort(String(header.status), line),
    openQuantity: Math.max(0, line.expectedQuantity - line.receivedQuantity)
  }))
  const sum = (key: 'expectedQuantity' | 'receivedQuantity' | 'rejectedQuantity') =>
    detailedLines.reduce((total, line) => total + line[key], 0)
  const totalCostCents = detailedLines.reduce((total, l) => total + l.expectedQuantity * l.unitCostCents, 0)
  const receivedCostCents = detailedLines.reduce((total, l) => total + l.receivedQuantity * l.unitCostCents, 0)
  return {
    ...(header as {
      id: string
      poNumber: string
      supplierId: string
      supplierName: string
      status: string
      currency: string
      expectedAt: string | null
      notes: string | null
      cancelReason: string | null
      version: number
      createdAt: string
      updatedAt: string
    }),
    totalCostCents,
    receivedCostCents,
    lines: detailedLines,
    receipts: receipts.results.map((receipt) => ({
      ...receipt,
      lines: receiptLines.results.filter((line) => line.receiptId === receipt.id)
    })),
    documents: documents.results,
    summary: {
      expectedUnits: sum('expectedQuantity'),
      receivedUnits: sum('receivedQuantity'),
      rejectedUnits: sum('rejectedQuantity'),
      openUnits: detailedLines.reduce((total, l) => total + l.openQuantity, 0),
      hasDiscrepancy: detailedLines.some(
        (l) =>
          l.discrepancy === 'over' ||
          l.discrepancy === 'rejected' ||
          (header.status === 'closed' && l.discrepancy === 'short')
      )
    }
  }
}

function closedShort(
  _status: string,
  line: { expectedQuantity: number; receivedQuantity: number; rejectedQuantity: number }
): LineDiscrepancy {
  return lineDiscrepancy(line)
}
