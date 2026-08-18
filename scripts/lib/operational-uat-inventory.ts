import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'

const COMMIT_SHA = /^[0-9a-f]{40}$/i
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PUBLIC_ORDER_NUMBER = /^[A-Z][A-Z0-9_-]{2,63}$/i
const inventoryCaseSchema = z.enum(['baseline', 'pickup', 'cancellation', 'return'])
export type OperationalUatInventoryCase = z.infer<typeof inventoryCaseSchema>

export interface OperationalUatInventoryContext {
  publicNumber: string
  expectedCommit: string
  appEnv: string
  appVersion: string
  caseId: string
  generatedAt?: string
}

export interface InventoryOrderSnapshot {
  publicNumber: string
  orderStatus: string
  paymentStatus: string
  inventoryStatus: string
  fulfillmentStatus: string
  shippingMethod: string
  correlationId: string
  lineCount: number
}

export interface InventoryLineSnapshot {
  sku: string
  quantity: number
  variantId: string
  currentSku: string
}

export interface InventoryBalanceSnapshot {
  sku: string
  locationCode: string
  physicalQuantity: number
  blockedQuantity: number
  safetyStock: number
  activeReservedQuantity: number
  allocatedQuantity: number
  orderCommittedQuantity: number
  ledgerPhysicalQuantity: number
  ledgerReservedDelta: number
  version: number
}

export interface InventoryMovementSnapshot {
  sku: string
  locationCode: string
  movementType: string
  quantity: number
  physicalDelta: number
  reservedDelta: number
  count: number
}

export interface InventoryAuditSnapshot {
  source: 'order_event' | 'audit_log'
  eventType: string
  resourceType: string
  resourceReference: string
  correlationId: string
  createdAt: string
  reasonDigest: string
  reasonLength: number
}

export interface OperationalUatInventorySnapshot {
  order: InventoryOrderSnapshot
  lines: InventoryLineSnapshot[]
  balances: InventoryBalanceSnapshot[]
  movements: InventoryMovementSnapshot[]
  audit: InventoryAuditSnapshot[]
}

export interface OperationalUatInventoryCheck {
  id: string
  pass: boolean
  detail: string
}

export interface OperationalUatInventoryEvidence {
  schemaVersion: 1
  requirementId: 'TST-040'
  kind: 'uat-inventory-evidence'
  case: OperationalUatInventoryCase
  generatedAt: string
  environment: 'staging'
  expectedCommit: string
  orderNumber: string
  order: {
    publicNumber: string
    orderStatus: string
    paymentStatus: string
    inventoryStatus: string
    fulfillmentStatus: string
    shippingMethod: string
    correlationId: string
    lineCount: number
  }
  lines: Array<{ sku: string; quantity: number; currentSku: string }>
  balances: Array<
    InventoryBalanceSnapshot & {
      availableQuantity: number
    }
  >
  movements: InventoryMovementSnapshot[]
  audit: InventoryAuditSnapshot[]
  checks: OperationalUatInventoryCheck[]
  status: 'pass' | 'fail'
  problems: string[]
}

interface OrderRow {
  id: string
  publicNumber: string
  orderStatus: string
  paymentStatus: string
  inventoryStatus: string
  fulfillmentStatus: string
  shippingMethod: string
  correlationId: string
  lineCount: number
}

interface LineRow {
  sku: string
  quantity: number
  variantId: string
  currentSku: string
}

interface BalanceRow {
  sku: string
  locationCode: string
  physicalQuantity: number
  blockedQuantity: number
  safetyStock: number
  activeReservedQuantity: number
  allocatedQuantity: number
  orderCommittedQuantity: number
  ledgerPhysicalQuantity: number
  ledgerReservedDelta: number
  version: number
}

interface MovementRow {
  sku: string
  locationCode: string
  movementType: string
  quantity: number
  physicalDelta: number
  reservedDelta: number
  count: number
}

interface AuditRow {
  source: 'order_event' | 'audit_log'
  eventType: string
  resourceType: string
  resourceReference: string
  correlationId: string
  createdAt: Date
  reason: string
}

interface ReturnReference {
  id: string
  publicNumber: string
}

export interface ReadOnlyDatabase {
  begin<T>(callback: (transaction: TransactionSql) => Promise<T>): Promise<T>
}

function error(message: string): never {
  throw new Error(`Operational UAT inventory evidence: ${message}`)
}

export function validateOperationalUatInventoryContext(input: OperationalUatInventoryContext) {
  const publicNumber = input.publicNumber.trim()
  const expectedCommit = input.expectedCommit.trim().toLowerCase()
  const appVersion = input.appVersion.trim().toLowerCase()
  const caseId = inventoryCaseSchema.parse(input.caseId)

  if (input.appEnv !== 'staging') error('APP_ENV must be exactly staging')
  if (!PUBLIC_ORDER_NUMBER.test(publicNumber)) error('public order number has an invalid format')
  if (!COMMIT_SHA.test(expectedCommit)) error('expected commit must be a 40-character SHA')
  if (!COMMIT_SHA.test(appVersion)) error('APP_VERSION must be a 40-character SHA')
  if (appVersion !== expectedCommit) error('APP_VERSION does not match the expected commit')

  return {
    publicNumber,
    expectedCommit,
    appEnv: 'staging' as const,
    appVersion,
    caseId,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  }
}

function reasonDigest(reason: string) {
  return createHash('sha256').update(reason).digest('hex')
}

function publicAudit(row: AuditRow): InventoryAuditSnapshot {
  const reason = row.reason.trim()
  return {
    source: row.source,
    eventType: row.eventType,
    resourceType: row.resourceType,
    resourceReference: row.resourceReference,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    reasonDigest: reasonDigest(reason),
    reasonLength: reason.length
  }
}

function makeChecks(
  snapshot: OperationalUatInventorySnapshot,
  expectedPublicNumber: string,
  caseId: OperationalUatInventoryCase
) {
  const checks: OperationalUatInventoryCheck[] = []
  const problems: string[] = []
  const add = (id: string, pass: boolean, detail: string) => {
    checks.push({ id, pass, detail })
    if (!pass) problems.push(`${id}: ${detail}`)
  }

  const order = snapshot.order
  add('order-public-reference', PUBLIC_ORDER_NUMBER.test(order.publicNumber), 'public order reference is safe')
  add(
    'order-reference-match',
    order.publicNumber === expectedPublicNumber,
    `queried=${expectedPublicNumber} returned=${order.publicNumber}`
  )
  add('order-correlation', CORRELATION_ID.test(order.correlationId), 'order correlation is a UUID')
  add(
    'payment-captured',
    ['captured', 'partially_refunded', 'refunded'].includes(order.paymentStatus),
    `payment status is ${order.paymentStatus}`
  )
  add('order-has-lines', snapshot.lines.length > 0, `${snapshot.lines.length} order line(s) read`)
  add(
    'order-line-count',
    order.lineCount === snapshot.lines.length,
    `order=${order.lineCount} evidence=${snapshot.lines.length}`
  )
  add(
    'line-count-match',
    snapshot.order.lineCount === snapshot.lines.length,
    `order reports ${snapshot.order.lineCount} line(s), query returned ${snapshot.lines.length}`
  )
  add(
    'line-quantities-positive',
    snapshot.lines.every((line) => Number.isSafeInteger(line.quantity) && line.quantity > 0),
    'all order line quantities are positive integers'
  )
  add('inventory-balances-present', snapshot.balances.length > 0, `${snapshot.balances.length} balance row(s) read`)

  for (const balance of snapshot.balances) {
    const key = `${balance.sku}@${balance.locationCode}`
    add(`physical-nonnegative:${key}`, balance.physicalQuantity >= 0, `physical=${balance.physicalQuantity}`)
    add(
      `blocked-within-physical:${key}`,
      balance.blockedQuantity >= 0 && balance.blockedQuantity <= balance.physicalQuantity,
      `blocked=${balance.blockedQuantity} physical=${balance.physicalQuantity}`
    )
    add(
      `reservations-nonnegative:${key}`,
      balance.activeReservedQuantity >= 0 && balance.allocatedQuantity >= 0 && balance.orderCommittedQuantity >= 0,
      'reservation quantities are non-negative'
    )
    add(
      `ledger-physical:${key}`,
      balance.physicalQuantity === balance.ledgerPhysicalQuantity,
      `balance=${balance.physicalQuantity} ledger=${balance.ledgerPhysicalQuantity}`
    )
    add(
      `order-commitment-bounded:${key}`,
      balance.orderCommittedQuantity <=
        snapshot.lines.filter((line) => line.sku === balance.sku).reduce((sum, line) => sum + line.quantity, 0),
      `order committed=${balance.orderCommittedQuantity}`
    )
  }

  const quantities = new Map<string, number>()
  for (const line of snapshot.lines) quantities.set(line.sku, (quantities.get(line.sku) ?? 0) + line.quantity)
  const balanceSkus = new Set(snapshot.balances.map((balance) => balance.sku))
  for (const [sku, quantity] of quantities) {
    add(`balance-for-line:${sku}`, balanceSkus.has(sku), `line quantity=${quantity}`)
  }

  const committedBySku = new Map<string, number>()
  for (const balance of snapshot.balances) {
    committedBySku.set(balance.sku, (committedBySku.get(balance.sku) ?? 0) + balance.orderCommittedQuantity)
  }
  for (const [sku, quantity] of quantities) {
    const committed = committedBySku.get(sku) ?? 0
    const expected = ['reserved', 'allocated', 'picked', 'shipped'].includes(order.inventoryStatus) ? quantity : null
    if (expected !== null) {
      add(
        `order-commitment-state:${sku}`,
        committed === expected,
        `inventory=${order.inventoryStatus} committed=${committed} expected=${expected}`
      )
    }
    if (order.inventoryStatus === 'released') {
      add(`released-reservation:${sku}`, committed === 0, `released order committed=${committed}`)
    }
  }

  add(
    'correlated-operational-reason',
    snapshot.audit.length > 0 && snapshot.audit.every((entry) => CORRELATION_ID.test(entry.correlationId)),
    snapshot.audit.length > 0
      ? 'at least one reason-bearing correlated audit/event record exists'
      : 'no reason-bearing audit/event record exists'
  )
  add(
    'movement-evidence',
    snapshot.movements.length > 0,
    snapshot.movements.length > 0
      ? `${snapshot.movements.length} movement aggregate(s) read`
      : 'no order/return movement found'
  )
  if (caseId === 'pickup') {
    add(
      'pickup-final-state',
      order.shippingMethod === 'recogida' && order.fulfillmentStatus === 'delivered',
      `shipping=${order.shippingMethod} fulfillment=${order.fulfillmentStatus}`
    )
  } else if (caseId === 'cancellation') {
    add(
      'cancellation-final-state',
      order.inventoryStatus === 'released' &&
        snapshot.movements.some((movement) => movement.movementType === 'release'),
      `inventory=${order.inventoryStatus}`
    )
  } else if (caseId === 'return') {
    add(
      'return-final-state',
      order.inventoryStatus === 'returned' && snapshot.movements.some((movement) => movement.movementType === 'return'),
      `inventory=${order.inventoryStatus}`
    )
  }
  const movementSkus = new Set(snapshot.movements.map((movement) => movement.sku))
  for (const sku of quantities.keys()) {
    add(`movement-for-line:${sku}`, movementSkus.has(sku), 'at least one order/return movement is present')
  }

  return { checks, problems }
}

export function buildOperationalUatInventoryEvidence(
  context: OperationalUatInventoryContext,
  snapshot: OperationalUatInventorySnapshot
): OperationalUatInventoryEvidence {
  const validated = validateOperationalUatInventoryContext(context)
  const { checks, problems } = makeChecks(snapshot, validated.publicNumber, validated.caseId)
  return {
    schemaVersion: 1,
    requirementId: 'TST-040',
    kind: 'uat-inventory-evidence',
    case: validated.caseId,
    generatedAt: validated.generatedAt,
    environment: 'staging',
    expectedCommit: validated.expectedCommit,
    orderNumber: snapshot.order.publicNumber,
    order: {
      publicNumber: snapshot.order.publicNumber,
      orderStatus: snapshot.order.orderStatus,
      paymentStatus: snapshot.order.paymentStatus,
      inventoryStatus: snapshot.order.inventoryStatus,
      fulfillmentStatus: snapshot.order.fulfillmentStatus,
      shippingMethod: snapshot.order.shippingMethod,
      correlationId: snapshot.order.correlationId,
      lineCount: snapshot.order.lineCount
    },
    lines: snapshot.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, currentSku: line.currentSku })),
    balances: snapshot.balances.map((balance) => ({
      ...balance,
      availableQuantity: Math.max(
        balance.physicalQuantity - balance.blockedQuantity - balance.activeReservedQuantity - balance.safetyStock,
        0
      )
    })),
    movements: snapshot.movements,
    audit: snapshot.audit,
    checks,
    status: problems.length === 0 ? 'pass' : 'fail',
    problems
  }
}

export function assertOperationalUatInventoryEvidence(evidence: OperationalUatInventoryEvidence) {
  if (evidence.status !== 'pass') {
    throw new Error(`Operational UAT inventory evidence is incoherent:\n- ${evidence.problems.join('\n- ')}`)
  }
  return evidence
}

const inventoryEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementId: z.literal('TST-040'),
    kind: z.literal('uat-inventory-evidence'),
    case: inventoryCaseSchema,
    generatedAt: z.string().datetime(),
    environment: z.literal('staging'),
    expectedCommit: z.string().regex(COMMIT_SHA),
    orderNumber: z.string().regex(PUBLIC_ORDER_NUMBER),
    order: z
      .object({
        publicNumber: z.string().regex(PUBLIC_ORDER_NUMBER),
        orderStatus: z.string().min(1),
        paymentStatus: z.string().min(1),
        inventoryStatus: z.string().min(1),
        fulfillmentStatus: z.string().min(1),
        shippingMethod: z.string().min(1),
        correlationId: z.string().regex(CORRELATION_ID),
        lineCount: z.number().int().positive()
      })
      .strict(),
    lines: z
      .array(
        z
          .object({
            sku: z.string().min(1),
            quantity: z.number().int().positive(),
            currentSku: z.string().min(1)
          })
          .strict()
      )
      .min(1),
    balances: z
      .array(
        z
          .object({
            sku: z.string().min(1),
            locationCode: z.string().min(1),
            physicalQuantity: z.number().int(),
            blockedQuantity: z.number().int(),
            safetyStock: z.number().int(),
            activeReservedQuantity: z.number().int(),
            allocatedQuantity: z.number().int(),
            orderCommittedQuantity: z.number().int(),
            ledgerPhysicalQuantity: z.number().int(),
            ledgerReservedDelta: z.number().int(),
            version: z.number().int().positive(),
            availableQuantity: z.number().int().nonnegative()
          })
          .strict()
      )
      .min(1),
    movements: z
      .array(
        z
          .object({
            sku: z.string().min(1),
            locationCode: z.string().min(1),
            movementType: z.string().min(1),
            quantity: z.number().int(),
            physicalDelta: z.number().int(),
            reservedDelta: z.number().int(),
            count: z.number().int().positive()
          })
          .strict()
      )
      .min(1),
    audit: z.array(
      z
        .object({
          source: z.enum(['order_event', 'audit_log']),
          eventType: z.string().min(1),
          resourceType: z.string().min(1),
          resourceReference: z.string().min(1),
          correlationId: z.string().regex(CORRELATION_ID),
          createdAt: z.string().datetime(),
          reasonDigest: z.string().regex(/^[0-9a-f]{64}$/i),
          reasonLength: z.number().int().positive()
        })
        .strict()
    ),
    checks: z.array(z.object({ id: z.string().min(1), pass: z.boolean(), detail: z.string().min(1) }).strict()).min(1),
    status: z.enum(['pass', 'fail']),
    problems: z.array(z.string().min(1))
  })
  .strict()

export function validateOperationalUatInventoryArtifact(value: unknown, expectedCommit: string) {
  const evidence = inventoryEvidenceSchema.parse(value)
  if (evidence.expectedCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    error('artifact commit does not match the evidence release')
  }
  if (evidence.order.publicNumber !== evidence.orderNumber) error('artifact order references do not match')

  const snapshot: OperationalUatInventorySnapshot = {
    order: evidence.order,
    lines: evidence.lines.map((line) => ({ ...line, variantId: '' })),
    balances: evidence.balances.map(({ availableQuantity: _availableQuantity, ...balance }) => balance),
    movements: evidence.movements,
    audit: evidence.audit
  }
  const recomputed = makeChecks(snapshot, evidence.orderNumber, evidence.case)
  const availableQuantitiesMatch = evidence.balances.every(
    (balance) =>
      balance.availableQuantity ===
      Math.max(
        balance.physicalQuantity - balance.blockedQuantity - balance.activeReservedQuantity - balance.safetyStock,
        0
      )
  )
  if (
    !availableQuantitiesMatch ||
    JSON.stringify(evidence.checks) !== JSON.stringify(recomputed.checks) ||
    JSON.stringify(evidence.problems) !== JSON.stringify(recomputed.problems) ||
    evidence.status !== (recomputed.problems.length === 0 ? 'pass' : 'fail')
  ) {
    error('artifact reconciliation does not match its raw inventory snapshot')
  }
  return assertOperationalUatInventoryEvidence(evidence)
}

async function queryInventorySnapshot(transaction: TransactionSql, publicNumber: string) {
  const [order] = await transaction<OrderRow[]>`
    SELECT orders.id, orders.public_number AS "publicNumber", orders.order_status AS "orderStatus",
           orders.payment_status AS "paymentStatus", orders.inventory_status AS "inventoryStatus",
           orders.fulfillment_status AS "fulfillmentStatus", orders.shipping_method AS "shippingMethod",
           orders.correlation_id AS "correlationId",
           count(lines.id)::int AS "lineCount"
    FROM orders
    LEFT JOIN order_lines lines ON lines.order_id = orders.id
    WHERE orders.public_number = ${publicNumber}
    GROUP BY orders.id
  `
  if (!order) error(`public order ${publicNumber} was not found`)

  const lines = await transaction<LineRow[]>`
    SELECT line.sku, line.quantity, line.variant_id AS "variantId", variant.sku AS "currentSku"
    FROM order_lines line
    JOIN variants variant ON variant.id = line.variant_id
    WHERE line.order_id = ${order.id}
    ORDER BY line.id
  `

  const balances = await transaction<BalanceRow[]>`
    WITH order_variants AS (
      SELECT DISTINCT variant_id FROM order_lines WHERE order_id = ${order.id}
    )
    SELECT variant.sku, location.code AS "locationCode",
           balance.physical_quantity AS "physicalQuantity",
           balance.blocked_quantity AS "blockedQuantity", variant.safety_stock AS "safetyStock",
           COALESCE((
             SELECT sum(reservation.quantity)::int FROM inventory_reservations reservation
             WHERE reservation.variant_id = balance.variant_id AND reservation.location_id = balance.location_id
               AND reservation.status = 'active' AND reservation.expires_at > now()
           ), 0)::int AS "activeReservedQuantity",
           COALESCE((
             SELECT sum(reservation.quantity)::int FROM inventory_reservations reservation
             WHERE reservation.variant_id = balance.variant_id AND reservation.location_id = balance.location_id
               AND reservation.status = 'allocated'
           ), 0)::int AS "allocatedQuantity",
           COALESCE((
             SELECT sum(reservation.quantity)::int FROM inventory_reservations reservation
             WHERE reservation.variant_id = balance.variant_id AND reservation.location_id = balance.location_id
               AND reservation.order_id = ${order.id} AND reservation.status IN ('active', 'allocated')
           ), 0)::int AS "orderCommittedQuantity",
           COALESCE((
             SELECT sum(movement.physical_delta)::int FROM inventory_movements movement
             WHERE movement.variant_id = balance.variant_id AND movement.location_id = balance.location_id
           ), 0)::int AS "ledgerPhysicalQuantity",
           COALESCE((
             SELECT sum(movement.reserved_delta)::int FROM inventory_movements movement
             WHERE movement.variant_id = balance.variant_id AND movement.location_id = balance.location_id
           ), 0)::int AS "ledgerReservedDelta",
           balance.version::int AS version
    FROM inventory_balances balance
    JOIN order_variants ON order_variants.variant_id = balance.variant_id
    JOIN variants variant ON variant.id = balance.variant_id
    JOIN inventory_locations location ON location.id = balance.location_id
    ORDER BY variant.sku, location.code
  `

  const returnReferences = await transaction<ReturnReference[]>`
    SELECT id, public_number AS "publicNumber" FROM returns WHERE order_id = ${order.id} ORDER BY created_at, id
  `

  const orderMovements = await transaction<MovementRow[]>`
    SELECT variant.sku, location.code AS "locationCode", movement.movement_type AS "movementType",
           sum(movement.quantity)::int AS quantity, sum(movement.physical_delta)::int AS "physicalDelta",
           sum(movement.reserved_delta)::int AS "reservedDelta", count(*)::int AS count
    FROM inventory_movements movement
    JOIN variants variant ON variant.id = movement.variant_id
    JOIN inventory_locations location ON location.id = movement.location_id
    WHERE movement.reference_type = 'order' AND movement.reference_id = ${order.id}
    GROUP BY variant.sku, location.code, movement.movement_type
  `
  const returnMovements = returnReferences.length
    ? await transaction<MovementRow[]>`
        SELECT variant.sku, location.code AS "locationCode", movement.movement_type AS "movementType",
               sum(movement.quantity)::int AS quantity, sum(movement.physical_delta)::int AS "physicalDelta",
               sum(movement.reserved_delta)::int AS "reservedDelta", count(*)::int AS count
        FROM inventory_movements movement
        JOIN variants variant ON variant.id = movement.variant_id
        JOIN inventory_locations location ON location.id = movement.location_id
        WHERE movement.reference_type = 'return'
          AND movement.reference_id IN ${transaction(returnReferences.map((item) => item.id))}
        GROUP BY variant.sku, location.code, movement.movement_type
      `
    : []

  const orderAudit = await transaction<AuditRow[]>`
    SELECT 'order_event'::text AS source, event.event_type AS "eventType", 'order'::text AS "resourceType",
           orders.public_number AS "resourceReference", event.correlation_id AS "correlationId",
           event.created_at AS "createdAt", event.reason
    FROM order_events event
    JOIN orders ON orders.id = event.order_id
    WHERE event.order_id = ${order.id} AND event.actor_type = 'staff'
      AND event.reason IS NOT NULL AND length(trim(event.reason)) > 0
    ORDER BY event.created_at DESC, event.id DESC
    LIMIT 50
  `
  const orderAuditLog = await transaction<AuditRow[]>`
    SELECT 'audit_log'::text AS source, audit.action AS "eventType", audit.resource_type AS "resourceType",
           audit.resource_id AS "resourceReference", audit.correlation_id AS "correlationId",
           audit.created_at AS "createdAt", audit.reason
    FROM audit_log audit
    WHERE audit.resource_id = ${publicNumber} AND audit.reason IS NOT NULL AND length(trim(audit.reason)) > 0
      AND audit.actor_type = 'staff'
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT 50
  `
  const returnAuditLog = returnReferences.length
    ? await transaction<AuditRow[]>`
        SELECT 'audit_log'::text AS source, audit.action AS "eventType", audit.resource_type AS "resourceType",
               audit.resource_id AS "resourceReference", audit.correlation_id AS "correlationId",
               audit.created_at AS "createdAt", audit.reason
        FROM audit_log audit
        WHERE audit.resource_id IN ${transaction(returnReferences.map((item) => item.publicNumber))}
          AND audit.reason IS NOT NULL AND length(trim(audit.reason)) > 0
          AND audit.actor_type = 'staff'
        ORDER BY audit.created_at DESC, audit.id DESC
        LIMIT 50
      `
    : []

  return {
    order,
    lines,
    balances,
    movements: [...orderMovements, ...returnMovements],
    audit: [...orderAudit, ...orderAuditLog, ...returnAuditLog]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(publicAudit)
  } satisfies OperationalUatInventorySnapshot
}

export async function collectOperationalUatInventoryEvidence(
  database: ReadOnlyDatabase | Sql,
  context: OperationalUatInventoryContext
) {
  const validated = validateOperationalUatInventoryContext(context)
  const snapshot = await database.begin(async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await transaction`SET LOCAL statement_timeout = '10000ms'`
    return queryInventorySnapshot(transaction, validated.publicNumber)
  })
  return buildOperationalUatInventoryEvidence(validated, snapshot)
}

export function inventoryReasonDigest(reason: string) {
  return reasonDigest(reason)
}
