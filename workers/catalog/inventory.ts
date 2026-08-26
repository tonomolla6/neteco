/**
 * Cloudflare-native inventory operations over D1.
 *
 * Atomicity model: every mutation runs as ONE `database.batch([...])`, which D1
 * executes as a single implicit SQL transaction. Instead of trusting JavaScript
 * control flow, each mutating batch ends with a GUARD statement that attempts to
 * insert a deliberately invalid ledger row whenever a post-condition does not
 * hold. The CHECK constraint rejects that row and the whole transaction rolls
 * back, so partial effects cannot survive.
 *
 * Idempotency model: commands carry caller-supplied unique keys. A reservation
 * id IS its idempotency key; replays return the persisted reservation state
 * without new ledger effects (movement keys are deterministic, INSERT .. ON
 * CONFLICT DO NOTHING). The stored payload hash rejects key reuse with a
 * different payload. The coordinator separately preserves the exact first HTTP
 * response for retry-after-lost-response semantics.
 * Delivery is treated as at-least-once everywhere.
 *
 * Quantity semantics mirror server/domain/inventory.ts:
 *   sellable = physical - blocked - safety - SUM(active reservation lines)
 * Active commitments live only in inventory_reservations/_lines; balances never
 * duplicate them. The append-only ledger reconstructs physical quantities and
 * explains reserved deltas.
 */

export type ReservationStatus = 'reserved' | 'assigned' | 'released' | 'expired'

export const INVENTORY_COORDINATOR_NAME = 'neteco-inventory-global'

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

export class InventoryError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'conflict' | 'not_found' | 'not_active' | 'insufficient_stock',
    message: string
  ) {
    super(message)
    this.name = 'InventoryError'
  }
}

export interface ReservationLineInput {
  variantId: string
  locationId: string
  quantity: number
}

export interface ReserveInput {
  idempotencyKey: string
  correlationId: string
  lines: ReservationLineInput[]
  expiresAt: string
  reason?: string
  /** Canonical UTC evaluation instant. Server-side only, never client input. */
  now: string
}

export type ReserveResult =
  | { outcome: 'reserved'; reservationId: string; expiresAt: string }
  | { outcome: 'replayed'; reservationId: string; status: ReservationStatus; expiresAt: string }
  | { outcome: 'conflict'; reservationId: string; status: ReservationStatus }

export interface OperationInput {
  idempotencyKey: string
  correlationId: string
  reason?: string
  now: string
}

export type AssignResult =
  | { outcome: 'assigned'; reservationId: string }
  | { outcome: 'replayed'; reservationId: string; status: ReservationStatus }
  | { outcome: 'expired'; reservationId: string; status: ReservationStatus }

export type SimpleResult =
  | { outcome: 'applied'; reservationId: string; expiresAt?: string }
  | { outcome: 'replayed'; reservationId: string; status: ReservationStatus; expiresAt?: string }
  | { outcome: 'not_active'; reservationId: string; status: ReservationStatus }

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const MAX_KEY_LENGTH = 200
const MAX_REASON_LENGTH = 500
const MAX_RESERVATION_LINES = 100
const GUARD_PAYLOAD_HASH = '0'.repeat(64)

export function isCanonicalInventoryInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().replace('.000Z', 'Z') === value
}

function assertCanonicalInstant(value: string, name: string) {
  if (!isCanonicalInventoryInstant(value))
    throw new InventoryError('invalid_input', `${name} must be canonical ISO-8601 UTC seconds`)
}

function assertKey(value: string, name: string) {
  if (!value || value.length > MAX_KEY_LENGTH || hasControlCharacters(value))
    throw new InventoryError('invalid_input', `${name} is invalid`)
}

function assertQuantity(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new InventoryError('invalid_input', `${name} must be a positive integer`)
}

function assertReason(value: string | undefined) {
  if (value !== undefined && (value.length < 3 || value.length > MAX_REASON_LENGTH || hasControlCharacters(value)))
    throw new InventoryError('invalid_input', 'reason is invalid')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

export function reservationPayload(
  input: Pick<ReserveInput, 'expiresAt' | 'reason'>,
  lines: ReservationLineInput[]
): string {
  return canonicalJson({
    expiresAt: input.expiresAt,
    lines: [...lines]
      .map((line) => ({ locationId: line.locationId, quantity: line.quantity, variantId: line.variantId }))
      .sort(
        (left, right) =>
          left.variantId.localeCompare(right.variantId) ||
          left.locationId.localeCompare(right.locationId) ||
          left.quantity - right.quantity
      ),
    reason: input.reason ?? null
  })
}

export function reservationPayloadHash(
  input: Pick<ReserveInput, 'expiresAt' | 'reason'>,
  lines: ReservationLineInput[]
): Promise<string> {
  return sha256Hex(reservationPayload(input, lines))
}

interface ReservationRow {
  id: string
  status: ReservationStatus
  payload_hash: string
  expires_at: string
}

async function findReservationByKey(database: D1Database, idempotencyKey: string) {
  return database
    .prepare('SELECT id, status, payload_hash, expires_at FROM inventory_reservations WHERE idempotency_key = ?1')
    .bind(idempotencyKey)
    .first<ReservationRow>()
}

/** Unclamped sellable delta; negative values indicate a broken invariant. */
function safetyStockExpression() {
  return `COALESCE((SELECT policy.safety_stock FROM variants policy WHERE policy.id = b.variant_id), 0)`
}

function rawSellableDelta() {
  return `(b.physical_quantity - b.blocked_quantity - ${safetyStockExpression()} - COALESCE((
    SELECT SUM(active_lines.quantity)
    FROM inventory_reservation_lines active_lines
    JOIN inventory_reservations active_reservations ON active_reservations.id = active_lines.reservation_id
    WHERE active_reservations.status = 'reserved'
      AND active_lines.variant_id = b.variant_id
      AND active_lines.location_id = b.location_id
  ), 0))`
}

/** Non-negative sellable expression evaluated against one `inventory_balances` row aliased `b`. */
export function sellableExpression() {
  return `max(0, b.physical_quantity - b.blocked_quantity - ${safetyStockExpression()} - COALESCE((
    SELECT SUM(active_lines.quantity)
    FROM inventory_reservation_lines active_lines
    JOIN inventory_reservations active_reservations ON active_reservations.id = active_lines.reservation_id
    WHERE active_reservations.status = 'reserved'
      AND active_lines.variant_id = b.variant_id
      AND active_lines.location_id = b.location_id
  ), 0))`
}

/**
 * GUARD statement factory: attempts to insert a reservation row whose status
 * violates the schema CHECK iff `condition` holds, aborting the whole
 * transaction. The statement reads no business rows itself, so it fires even
 * when the offending reservation ended up with zero lines.
 */
function guardStatement(condition: string): string {
  return `
    INSERT INTO inventory_reservations (
      id, idempotency_key, payload_hash, status, correlation_id,
      expires_at, created_at, updated_at
    )
    SELECT 'inventory-guard:' || ?1, 'inventory-guard:' || ?1, '${GUARD_PAYLOAD_HASH}',
           'guard-impossible', ?2, '9999-12-31T23:59:59Z', ?3, ?3
    WHERE ${condition}
    LIMIT 1`
}

export async function reserveInventory(database: D1Database, input: ReserveInput): Promise<ReserveResult> {
  assertKey(input.idempotencyKey, 'idempotencyKey')
  assertKey(input.correlationId, 'correlationId')
  assertCanonicalInstant(input.now, 'now')
  assertCanonicalInstant(input.expiresAt, 'expiresAt')
  assertReason(input.reason)
  if (input.expiresAt <= input.now) throw new InventoryError('invalid_input', 'expiresAt must be after now')
  const lines = input.lines.map((line) => {
    assertKey(line.variantId, 'variantId')
    assertKey(line.locationId, 'locationId')
    assertQuantity(line.quantity, 'quantity')
    return { locationId: line.locationId, quantity: line.quantity, variantId: line.variantId }
  })
  if (!lines.length) throw new InventoryError('invalid_input', 'At least one reservation line is required')
  if (lines.length > MAX_RESERVATION_LINES)
    throw new InventoryError('invalid_input', `At most ${MAX_RESERVATION_LINES} reservation lines are allowed`)
  const lineKeys = lines.map((line) => `${line.variantId}\u0000${line.locationId}`)
  if (new Set(lineKeys).size !== lineKeys.length)
    throw new InventoryError('invalid_input', 'Reservation lines must be unique by variant and location')

  const payloadHash = await reservationPayloadHash(input, lines)
  const existing = await findReservationByKey(database, input.idempotencyKey)
  if (existing) {
    return existing.payload_hash === payloadHash
      ? { outcome: 'replayed', reservationId: existing.id, status: existing.status, expiresAt: existing.expires_at }
      : { outcome: 'conflict', reservationId: existing.id, status: existing.status }
  }

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO inventory_reservations (
             id, idempotency_key, payload_hash, status, correlation_id, reason,
             expires_at, created_at, updated_at
           )
           SELECT ?1, ?1, ?2, 'reserved', ?3, ?4, ?5, ?6, ?6
           WHERE NOT EXISTS (SELECT 1 FROM inventory_reservations WHERE idempotency_key = ?1)`
        )
        .bind(input.idempotencyKey, payloadHash, input.correlationId, input.reason ?? null, input.expiresAt, input.now),
      ...lines.flatMap((line, index) => [
        database
          .prepare(
            `INSERT INTO inventory_reservation_lines (reservation_id, variant_id, location_id, quantity)
             SELECT ?1, ?2, ?3, ?4
             WHERE EXISTS (
               SELECT 1 FROM inventory_reservations
               WHERE id = ?1 AND payload_hash = ?5 AND status = 'reserved'
             )
             AND EXISTS (
               SELECT 1
               FROM inventory_balances b
               JOIN inventory_locations location ON location.id = b.location_id AND location.active = 1
               JOIN variants v ON v.id = b.variant_id
               WHERE b.variant_id = ?2 AND b.location_id = ?3 AND (
                 v.backorder_allowed = 1
                 OR ?4 <= ${sellableExpression()}
               )
             )`
          )
          .bind(input.idempotencyKey, line.variantId, line.locationId, line.quantity, payloadHash),
        database
          .prepare(
            `INSERT INTO inventory_movements (
               id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
               reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
             )
             SELECT ?7, ?2, ?3, 'reserve', 0, ?4, 'reservation', ?1, ?7, ?8, ?9, ?6
             WHERE EXISTS (
               SELECT 1 FROM inventory_reservations
               WHERE id = ?1 AND payload_hash = ?5 AND status = 'reserved'
             )
             AND EXISTS (
               SELECT 1 FROM inventory_reservation_lines
               WHERE reservation_id = ?1 AND variant_id = ?2 AND location_id = ?3
             )
             ON CONFLICT (idempotency_key) DO NOTHING`
          )
          .bind(
            input.idempotencyKey,
            line.variantId,
            line.locationId,
            line.quantity,
            payloadHash,
            input.now,
            `${input.idempotencyKey}:reserve:${index}`,
            input.correlationId,
            input.reason ?? null
          )
      ]),
      // GUARD: header must exist as freshly requested and carry exactly N lines.
      database
        .prepare(
          guardStatement(
            `EXISTS (SELECT 1 FROM inventory_reservations WHERE id = ?1)
             AND (SELECT count(*) FROM inventory_reservation_lines WHERE reservation_id = ?1) <> ?4`
          )
        )
        .bind(input.idempotencyKey, input.correlationId, input.now, lines.length)
    ])
  } catch (error) {
    // The guard fired (insufficient stock) or a same-key race resolved against us.
    const raced = await findReservationByKey(database, input.idempotencyKey)
    if (raced)
      return raced.payload_hash === payloadHash
        ? { outcome: 'replayed', reservationId: raced.id, status: raced.status, expiresAt: raced.expires_at }
        : { outcome: 'conflict', reservationId: raced.id, status: raced.status }
    const availability = await Promise.all(
      lines.map((line) => listAvailability(database, { variantId: line.variantId, locationId: line.locationId }))
    )
    const unavailable = availability.some((positions, index) => {
      const position = positions[0]
      return !position || (!position.backorderAllowed && position.sellableQuantity < lines[index]!.quantity)
    })
    if (unavailable)
      throw new InventoryError('insufficient_stock', 'Insufficient sellable inventory for one or more lines')
    throw error
  }

  const stored = await findReservationByKey(database, input.idempotencyKey)
  if (!stored) throw new InventoryError('insufficient_stock', 'Insufficient sellable inventory for one or more lines')
  if (stored.payload_hash !== payloadHash)
    return { outcome: 'conflict', reservationId: stored.id, status: stored.status }
  return { outcome: 'reserved', reservationId: stored.id, expiresAt: stored.expires_at }
}

async function reservationLines(database: D1Database, idempotencyKey: string) {
  const { results } = await database
    .prepare(
      `SELECT l.variant_id AS variantId, l.location_id AS locationId, l.quantity
       FROM inventory_reservation_lines l
       WHERE l.reservation_id = ?1
       ORDER BY l.variant_id, l.location_id`
    )
    .bind(idempotencyKey)
    .all<{ variantId: string; locationId: string; quantity: number }>()
  return results
}

export async function assignReservation(database: D1Database, input: OperationInput): Promise<AssignResult> {
  assertKey(input.idempotencyKey, 'idempotencyKey')
  assertKey(input.correlationId, 'correlationId')
  assertCanonicalInstant(input.now, 'now')
  assertReason(input.reason)

  const existing = await findReservationByKey(database, input.idempotencyKey)
  if (!existing) throw new InventoryError('not_found', 'Reservation not found')
  if (existing.status === 'assigned')
    return { outcome: 'replayed', reservationId: existing.id, status: existing.status }
  if (existing.status !== 'reserved') return { outcome: 'expired', reservationId: existing.id, status: existing.status }
  if (existing.expires_at <= input.now) return { outcome: 'expired', reservationId: existing.id, status: 'reserved' }

  await database.batch([
    database
      .prepare(
        `UPDATE inventory_reservations
         SET status = 'assigned', assigned_at = ?2, updated_at = ?2
         WHERE idempotency_key = ?1 AND status = 'reserved' AND expires_at > ?2`
      )
      .bind(input.idempotencyKey, input.now),
    ...(await reservationLines(database, input.idempotencyKey)).flatMap((line) => {
      const allocateKey = `${input.idempotencyKey}:allocate:${line.variantId}:${line.locationId}`
      return [
        // One-shot decrement: gated on this allocate movement not existing yet,
        // so concurrent/retried assignments of the same reservation never apply
        // the physical reduction twice.
        database
          .prepare(
            `UPDATE inventory_balances
             SET physical_quantity = physical_quantity - ?3,
                 version = version + 1,
                 updated_at = ?4
             WHERE variant_id = ?1 AND location_id = ?2
               AND EXISTS (
                 SELECT 1 FROM inventory_reservations
                 WHERE idempotency_key = ?5 AND status = 'assigned'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements WHERE idempotency_key = ?6
               )`
          )
          .bind(line.variantId, line.locationId, line.quantity, input.now, input.idempotencyKey, allocateKey),
        database
          .prepare(
            `INSERT INTO inventory_movements (
               id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
               reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
             )
             SELECT ?7, ?2, ?3, 'allocate', -?4, -?4, 'reservation', ?1, ?7, ?5, ?9, ?6
             WHERE EXISTS (
               SELECT 1 FROM inventory_reservations
               WHERE idempotency_key = ?1 AND status = 'assigned'
             )
             ON CONFLICT (idempotency_key) DO NOTHING`
          )
          .bind(
            input.idempotencyKey,
            line.variantId,
            line.locationId,
            line.quantity,
            input.correlationId,
            input.now,
            allocateKey,
            input.reason ?? null
          )
      ]
    }),
    // GUARD: after assignment no touched balance may violate sellability.
    database
      .prepare(
        guardStatement(
          `EXISTS (
             SELECT 1 FROM inventory_reservations r
             WHERE r.idempotency_key = ?1 AND r.status = 'assigned'
               AND EXISTS (
                 SELECT 1
                 FROM inventory_reservation_lines l2
                 JOIN inventory_balances b ON b.variant_id = l2.variant_id AND b.location_id = l2.location_id
                 WHERE l2.reservation_id = r.id
                   AND ${rawSellableDelta()} < 0
               )
           ) OR EXISTS (
             SELECT 1
             FROM inventory_reservations r
             JOIN inventory_reservation_lines l ON l.reservation_id = r.id
             WHERE r.idempotency_key = ?1 AND r.status = 'assigned'
               AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements movement
                 WHERE movement.idempotency_key = ?1 || ':allocate:' || l.variant_id || ':' || l.location_id
                   AND movement.movement_type = 'allocate'
                   AND movement.reference_type = 'reservation'
                   AND movement.reference_id = r.id
                   AND movement.variant_id = l.variant_id
                   AND movement.location_id = l.location_id
                   AND movement.physical_delta = -l.quantity
                   AND movement.reserved_delta = -l.quantity
                   AND movement.correlation_id = ?2
                   AND movement.created_at = ?3
               )
           )`
        )
      )
      .bind(input.idempotencyKey, input.correlationId, input.now)
  ])

  const stored = await findReservationByKey(database, input.idempotencyKey)
  if (stored?.status !== 'assigned')
    throw new InventoryError('not_active', 'Assignment could not be completed atomically')
  return { outcome: 'assigned', reservationId: stored.id }
}

export async function releaseReservation(database: D1Database, input: OperationInput): Promise<SimpleResult> {
  assertKey(input.idempotencyKey, 'idempotencyKey')
  assertKey(input.correlationId, 'correlationId')
  assertCanonicalInstant(input.now, 'now')
  assertReason(input.reason)

  const existing = await findReservationByKey(database, input.idempotencyKey)
  if (!existing) throw new InventoryError('not_found', 'Reservation not found')
  if (existing.status === 'released')
    return { outcome: 'replayed', reservationId: existing.id, status: existing.status }
  if (existing.status !== 'reserved')
    return { outcome: 'not_active', reservationId: existing.id, status: existing.status }

  await database.batch([
    database
      .prepare(
        `UPDATE inventory_reservations
         SET status = 'released', released_at = ?2, updated_at = ?2
         WHERE idempotency_key = ?1 AND status = 'reserved'`
      )
      .bind(input.idempotencyKey, input.now),
    database
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
         )
         SELECT ?1 || ':release:' || l.variant_id || ':' || l.location_id,
                l.variant_id, l.location_id, 'release', 0, -l.quantity,
                'reservation', l.reservation_id,
                ?1 || ':release:' || l.variant_id || ':' || l.location_id,
                ?2, ?3, ?4
         FROM inventory_reservation_lines l
         WHERE l.reservation_id = ?1
           AND EXISTS (SELECT 1 FROM inventory_reservations WHERE id = ?1 AND status = 'released')
         ON CONFLICT (idempotency_key) DO NOTHING`
      )
      .bind(input.idempotencyKey, input.correlationId, input.reason ?? 'Reservation released', input.now),
    database
      .prepare(
        guardStatement(
          `EXISTS (
             SELECT 1
             FROM inventory_reservations r
             JOIN inventory_reservation_lines l ON l.reservation_id = r.id
             WHERE r.idempotency_key = ?1 AND r.status = 'released'
               AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements movement
                 WHERE movement.idempotency_key = ?1 || ':release:' || l.variant_id || ':' || l.location_id
                   AND movement.movement_type = 'release'
                   AND movement.reference_type = 'reservation'
                   AND movement.reference_id = r.id
                   AND movement.variant_id = l.variant_id
                   AND movement.location_id = l.location_id
                   AND movement.physical_delta = 0
                   AND movement.reserved_delta = -l.quantity
                   AND movement.correlation_id = ?2
                   AND movement.created_at = ?3
               )
           )`
        )
      )
      .bind(input.idempotencyKey, input.correlationId, input.now)
  ])

  const stored = await findReservationByKey(database, input.idempotencyKey)
  if (stored?.status !== 'released') throw new InventoryError('not_active', 'Release could not be applied atomically')
  return { outcome: 'applied', reservationId: stored.id }
}

export async function renewReservation(
  database: D1Database,
  input: OperationInput & { expiresAt: string }
): Promise<SimpleResult> {
  assertKey(input.idempotencyKey, 'idempotencyKey')
  assertCanonicalInstant(input.now, 'now')
  assertCanonicalInstant(input.expiresAt, 'expiresAt')
  assertKey(input.correlationId, 'correlationId')
  assertReason(input.reason)

  const existing = await findReservationByKey(database, input.idempotencyKey)
  if (!existing) throw new InventoryError('not_found', 'Reservation not found')
  if (existing.status !== 'reserved')
    return { outcome: 'not_active', reservationId: existing.id, status: existing.status }
  if (existing.expires_at <= input.now)
    return { outcome: 'not_active', reservationId: existing.id, status: existing.status }
  if (input.expiresAt <= input.now) throw new InventoryError('invalid_input', 'expiresAt must be after now')
  if (input.expiresAt <= existing.expires_at)
    return { outcome: 'replayed', reservationId: existing.id, status: existing.status, expiresAt: existing.expires_at }

  await database
    .prepare(
      `UPDATE inventory_reservations
       SET expires_at = ?2, renewed_at = ?3, updated_at = ?3
       WHERE idempotency_key = ?1 AND status = 'reserved'
         AND expires_at > ?3 AND expires_at < ?2`
    )
    .bind(input.idempotencyKey, input.expiresAt, input.now)
    .run()

  const stored = await findReservationByKey(database, input.idempotencyKey)
  if (stored?.status !== 'reserved')
    return { outcome: 'not_active', reservationId: existing.id, status: stored?.status ?? existing.status }
  return { outcome: 'applied', reservationId: stored.id, expiresAt: stored.expires_at }
}

export interface ExpireReport {
  expiredCount: number
  at: string
}

/**
 * Expiries are gated on the CURRENT expires_at, so stale expiry callers (old
 * alarms or queue redeliveries carrying superseded instants) become no-ops.
 */
export async function expireExpiredReservations(
  database: D1Database,
  input: { at: string; correlationId: string }
): Promise<ExpireReport> {
  assertCanonicalInstant(input.at, 'at')
  assertKey(input.correlationId, 'correlationId')

  const before = await database
    .prepare("SELECT count(*) AS total FROM inventory_reservations WHERE status = 'expired'")
    .first<{ total: number }>()

  await database.batch([
    database
      .prepare(
        `UPDATE inventory_reservations
         SET status = 'expired', expired_at = ?1, updated_at = ?1
         WHERE status = 'reserved' AND expires_at <= ?1`
      )
      .bind(input.at),
    database
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, reference_id, idempotency_key, correlation_id, reason, created_at
         )
         SELECT r.idempotency_key || ':expiry:' || l.variant_id || ':' || l.location_id,
                l.variant_id, l.location_id, 'release', 0, -l.quantity,
                'reservation', r.id,
                r.idempotency_key || ':expiry:' || l.variant_id || ':' || l.location_id,
                ?2, 'Reservation TTL expired', ?1
         FROM inventory_reservations r
         JOIN inventory_reservation_lines l ON l.reservation_id = r.id
         WHERE r.status = 'expired'
         ON CONFLICT (idempotency_key) DO NOTHING`
      )
      .bind(input.at, input.correlationId),
    database
      .prepare(
        guardStatement(
          `EXISTS (
             SELECT 1
             FROM inventory_reservations r
             JOIN inventory_reservation_lines l ON l.reservation_id = r.id
             WHERE r.status = 'expired' AND r.expired_at = ?3
               AND NOT EXISTS (
                 SELECT 1 FROM inventory_movements movement
                 WHERE movement.idempotency_key = r.idempotency_key || ':expiry:' || l.variant_id || ':' || l.location_id
                   AND movement.movement_type = 'release'
                   AND movement.reference_type = 'reservation'
                   AND movement.reference_id = r.id
                   AND movement.variant_id = l.variant_id
                   AND movement.location_id = l.location_id
                   AND movement.physical_delta = 0
                   AND movement.reserved_delta = -l.quantity
                   AND movement.correlation_id = ?2
                   AND movement.created_at = ?3
               )
           )`
        )
      )
      .bind(`expiry:${input.at}`, input.correlationId, input.at)
  ])

  const after = await database
    .prepare("SELECT count(*) AS total FROM inventory_reservations WHERE status = 'expired'")
    .first<{ total: number }>()
  return { expiredCount: Number(after?.total ?? 0) - Number(before?.total ?? 0), at: input.at }
}

export interface AvailabilityRow {
  variantId: string
  locationId: string
  physicalQuantity: number
  blockedQuantity: number
  safetyStock: number
  reservedQuantity: number
  sellableQuantity: number
  backorderAllowed: boolean
  version: number
}

export async function listAvailability(
  database: D1Database,
  filter: { variantId?: string; locationId?: string } = {}
): Promise<AvailabilityRow[]> {
  const conditions: string[] = []
  const parameters: string[] = []
  if (filter.variantId) {
    conditions.push('b.variant_id = ?')
    parameters.push(filter.variantId)
  }
  if (filter.locationId) {
    conditions.push('b.location_id = ?')
    parameters.push(filter.locationId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { results } = await database
    .prepare(
      `SELECT b.variant_id AS variantId,
              b.location_id AS locationId,
              b.physical_quantity AS physicalQuantity,
              b.blocked_quantity AS blockedQuantity,
              v.safety_stock AS safetyStock,
              COALESCE((
                SELECT SUM(active_lines.quantity)
                FROM inventory_reservation_lines active_lines
                JOIN inventory_reservations active_reservations
                  ON active_reservations.id = active_lines.reservation_id
                WHERE active_reservations.status = 'reserved'
                  AND active_lines.variant_id = b.variant_id
                  AND active_lines.location_id = b.location_id
              ), 0) AS reservedQuantity,
              ${sellableExpression()} AS sellableQuantity,
              v.backorder_allowed AS backorderAllowed,
              b.version AS version
       FROM inventory_balances b
       JOIN variants v ON v.id = b.variant_id
       ${where}
       ORDER BY b.variant_id, b.location_id`
    )
    .bind(...parameters)
    .all<Omit<AvailabilityRow, 'backorderAllowed'> & { backorderAllowed: number }>()
  return results.map((row) => ({ ...row, backorderAllowed: row.backorderAllowed === 1 }))
}

export interface ReconciliationViolation {
  code: 'ledger_physical_mismatch' | 'ledger_reserved_mismatch' | 'orphan_reference'
  detail: string
}

export interface ReconciliationReport {
  ok: boolean
  violations: ReconciliationViolation[]
}

/** Reconciles balances, active reservations and the append-only ledger. */
export async function reconcileInventory(database: D1Database): Promise<ReconciliationReport> {
  const violations: ReconciliationViolation[] = []

  const physicalMismatches = await database
    .prepare(
      `WITH ledger_physical AS (
         SELECT variant_id, location_id, SUM(physical_delta) AS delta
         FROM inventory_movements
         GROUP BY variant_id, location_id
       )
       SELECT b.variant_id AS variantId, b.location_id AS locationId,
              b.physical_quantity AS balanceQuantity, COALESCE(m.delta, 0) AS ledgerDelta
       FROM inventory_balances b
       LEFT JOIN ledger_physical m ON m.variant_id = b.variant_id AND m.location_id = b.location_id
       WHERE b.physical_quantity <> COALESCE(m.delta, 0)
       UNION ALL
       SELECT m.variant_id AS variantId, m.location_id AS locationId,
              0 AS balanceQuantity, m.delta AS ledgerDelta
       FROM ledger_physical m
       WHERE NOT EXISTS (
         SELECT 1 FROM inventory_balances b
         WHERE b.variant_id = m.variant_id AND b.location_id = m.location_id
       ) AND m.delta <> 0`
    )
    .all<{ variantId: string; locationId: string; balanceQuantity: number; ledgerDelta: number }>()
  for (const row of physicalMismatches.results)
    violations.push({
      code: 'ledger_physical_mismatch',
      detail: `${row.variantId}/${row.locationId}: balance=${row.balanceQuantity} ledger=${row.ledgerDelta}`
    })

  const reservedMismatches = await database
    .prepare(
      `WITH ledger_reserved AS (
         SELECT variant_id, location_id, SUM(reserved_delta) AS delta
         FROM inventory_movements
         GROUP BY variant_id, location_id
       ), active_reserved AS (
         SELECT l.variant_id, l.location_id, SUM(l.quantity) AS qty
         FROM inventory_reservation_lines l
         JOIN inventory_reservations r ON r.id = l.reservation_id
         WHERE r.status = 'reserved'
         GROUP BY l.variant_id, l.location_id
       )
       SELECT COALESCE(a.variant_id, d.variant_id) AS variantId,
              COALESCE(a.location_id, d.location_id) AS locationId,
              COALESCE(a.qty, 0) AS activeQty,
              COALESCE(d.delta, 0) AS ledgerDelta
       FROM active_reserved a
       LEFT JOIN ledger_reserved d ON d.variant_id = a.variant_id AND d.location_id = a.location_id
       WHERE COALESCE(a.qty, 0) <> COALESCE(d.delta, 0)
       UNION ALL
       SELECT d.variant_id AS variantId, d.location_id AS locationId,
              0 AS activeQty, d.delta AS ledgerDelta
       FROM ledger_reserved d
       WHERE d.delta <> 0
         AND NOT EXISTS (
           SELECT 1 FROM active_reserved a
           WHERE a.variant_id = d.variant_id AND a.location_id = d.location_id
         )`
    )
    .all<{ variantId: string; locationId: string; activeQty: number; ledgerDelta: number }>()
  for (const row of reservedMismatches.results)
    violations.push({
      code: 'ledger_reserved_mismatch',
      detail: `${row.variantId}/${row.locationId}: active=${row.activeQty} ledger=${row.ledgerDelta}`
    })

  const orphanLines = await database
    .prepare(
      `SELECT count(*) AS total
       FROM inventory_reservation_lines l
       LEFT JOIN inventory_reservations r ON r.id = l.reservation_id
       LEFT JOIN variants v ON v.id = l.variant_id
       LEFT JOIN inventory_locations loc ON loc.id = l.location_id
       WHERE r.id IS NULL OR v.id IS NULL OR loc.id IS NULL`
    )
    .first<{ total: number }>()
  if (Number(orphanLines?.total ?? 0) !== 0)
    violations.push({ code: 'orphan_reference', detail: `${orphanLines?.total} orphan reservation lines` })

  return { ok: violations.length === 0, violations }
}
