import { createHash, randomUUID } from 'node:crypto'
import type {
  DeliveryDriver,
  DeliveryRoute,
  DeliveryRouteStop,
  DeliveryVehicle,
  ReoptimizeDeliveryRouteResult
} from '../../shared/delivery-route-planning'
import type { DatabaseAdapter } from './convenience-points'

export class DeliveryRouteError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'capacity_exceeded'
      | 'forbidden'
      | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'DeliveryRouteError'
  }
}

async function executeGet<T>(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<T | null> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    let bound = false
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
      bound = true
    }
    if (typeof stmt.first === 'function') {
      const res = await stmt.first(...(bound ? [] : params))
      return (res as T) ?? null
    }
    if (typeof stmt.get === 'function') {
      const res = await stmt.get(...params)
      return (res as T) ?? null
    }
  }
  return null
}

async function executeAll<T>(db: DatabaseAdapter, sql: string, params: unknown[] = []): Promise<T[]> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    let bound = false
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
      bound = true
    }
    if (typeof stmt.all === 'function') {
      const res = await stmt.all(...(bound ? [] : params))
      if (Array.isArray(res)) return res as T[]
      if (res && typeof res === 'object' && Array.isArray((res as { results?: unknown[] }).results)) {
        return (res as { results: T[] }).results
      }
      return []
    }
  }
  return []
}

async function executeRun(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<void> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    let bound = false
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
      bound = true
    }
    if (typeof stmt.run === 'function') {
      await stmt.run(...(bound ? [] : params))
    }
  }
}

type AtomicStatement = { sql: string; params: unknown[] }

async function routeCommandReplay<T>(
  db: DatabaseAdapter,
  routeId: string,
  commandId: string,
  action: string,
  actorId: string,
  payloadHash: string
): Promise<T | null> {
  const row = await executeGet<{ action: string; actor_id: string; payload_hash: string; payload_json: string }>(
    db,
    'SELECT action, actor_id, payload_hash, payload_json FROM delivery_route_commands WHERE route_id = ? AND command_id = ?',
    [routeId, commandId]
  )
  if (!row) return null
  if (row.action !== action || row.actor_id !== actorId || row.payload_hash !== payloadHash) {
    throw new DeliveryRouteError('idempotency_conflict', 'Command ID already used with different input')
  }
  const payload = JSON.parse(row.payload_json) as { receipt?: T }
  if (!payload.receipt) throw new DeliveryRouteError('internal', 'Command receipt missing')
  return payload.receipt
}

/** D1 batches are transactional; SQLite adapters use an explicit transaction. */
async function applyRouteMutation(db: DatabaseAdapter, statements: AtomicStatement[], expectedVersion: number) {
  const batch = (db as unknown as { batch?: (statements: D1PreparedStatement[]) => Promise<D1Result[]> }).batch
  if (batch) {
    const prepared = statements.map(({ sql, params }) => (db.prepare(sql) as D1PreparedStatement).bind(...params))
    const results = await batch.call(db, prepared)
    if (!results[0]?.results?.length) {
      throw new DeliveryRouteError('version_conflict', `Version conflict: expected ${expectedVersion}`)
    }
    return
  }
  await executeRun(db, 'BEGIN IMMEDIATE', [])
  try {
    const first = statements[0]!
    const claimed = await executeGet<{ id: string }>(db, first.sql, first.params)
    if (!claimed) throw new DeliveryRouteError('version_conflict', `Version conflict: expected ${expectedVersion}`)
    for (const statement of statements.slice(1)) await executeRun(db, statement.sql, statement.params)
    await executeRun(db, 'COMMIT', [])
  } catch (error) {
    await executeRun(db, 'ROLLBACK', [])
    throw error
  }
}

interface RawVehicleRow {
  id: string
  name: string
  registration_plate: string
  max_weight_grams: number
  max_parcels: number
  status: 'active' | 'maintenance' | 'inactive'
  created_at: string
  updated_at: string
}

interface RawDriverRow {
  id: string
  identity_id: string | null
  name: string
  phone: string
  license_number: string
  status: 'active' | 'off_duty'
  created_at: string
  updated_at: string
}

interface RawRouteRow {
  id: string
  route_date: string
  vehicle_id: string | null
  driver_id: string | null
  status: 'draft' | 'planned' | 'in_progress' | 'completed' | 'cancelled'
  window_start: string
  window_end: string
  total_stops: number
  total_parcels: number
  total_weight_grams: number
  version: number
  created_at: string
  updated_at: string
}

interface RawStopRow {
  id: string
  route_id: string
  sequence_index: number
  order_id: string | null
  recipient_name: string
  street_address: string
  postal_code: string
  city: string
  parcel_count: number
  weight_grams: number
  time_window_start: string | null
  time_window_end: string | null
  status: 'pending' | 'in_progress' | 'delivered' | 'failed'
  failure_reason: string | null
  completed_at: string | null
}

// Vehicle operations
export async function createDeliveryVehicle(
  db: DatabaseAdapter,
  input: {
    id: string
    name: string
    registrationPlate: string
    maxWeightGrams: number
    maxParcels: number
    status?: 'active' | 'maintenance' | 'inactive'
    now?: string
  }
): Promise<DeliveryVehicle> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await executeRun(
    db,
    `INSERT INTO delivery_vehicles (
       id, name, registration_plate, max_weight_grams, max_parcels, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.name,
      input.registrationPlate,
      input.maxWeightGrams,
      input.maxParcels,
      input.status ?? 'active',
      now,
      now
    ]
  )

  return {
    id: input.id,
    name: input.name,
    registrationPlate: input.registrationPlate,
    maxWeightGrams: input.maxWeightGrams,
    maxParcels: input.maxParcels,
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now
  }
}

export async function listDeliveryVehicles(db: DatabaseAdapter): Promise<DeliveryVehicle[]> {
  const rows = await executeAll<RawVehicleRow>(db, `SELECT * FROM delivery_vehicles ORDER BY name ASC`)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    registrationPlate: r.registration_plate,
    maxWeightGrams: r.max_weight_grams,
    maxParcels: r.max_parcels,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

// Driver operations
export async function createDeliveryDriver(
  db: DatabaseAdapter,
  input: {
    id: string
    identityId?: string | null
    name: string
    phone: string
    licenseNumber: string
    status?: 'active' | 'off_duty'
    now?: string
  }
): Promise<DeliveryDriver> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await executeRun(
    db,
    `INSERT INTO delivery_drivers (
       id, identity_id, name, phone, license_number, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.identityId ?? null,
      input.name,
      input.phone,
      input.licenseNumber,
      input.status ?? 'active',
      now,
      now
    ]
  )

  return {
    id: input.id,
    identityId: input.identityId ?? null,
    name: input.name,
    phone: input.phone,
    licenseNumber: input.licenseNumber,
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now
  }
}

export async function listDeliveryDrivers(db: DatabaseAdapter): Promise<DeliveryDriver[]> {
  const rows = await executeAll<RawDriverRow>(db, `SELECT * FROM delivery_drivers ORDER BY name ASC`)
  return rows.map((r) => ({
    id: r.id,
    identityId: r.identity_id,
    name: r.name,
    phone: r.phone,
    licenseNumber: r.license_number,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

// Route operations
export async function createDeliveryRoute(
  db: DatabaseAdapter,
  input: {
    actorId: string
    id?: string
    routeDate: string
    vehicleId?: string | null
    driverId?: string | null
    windowStart?: string
    windowEnd?: string
    commandId: string
    now?: string
  }
): Promise<DeliveryRoute> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const routeId = input.id ?? randomUUID()
  const windowStart = input.windowStart ?? '08:00'
  const windowEnd = input.windowEnd ?? '16:00'

  const payload = {
    routeId,
    routeDate: input.routeDate,
    vehicleId: input.vehicleId,
    driverId: input.driverId,
    windowStart,
    windowEnd,
    commandId: input.commandId
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  await executeRun(
    db,
    `INSERT INTO delivery_routes (
       id, route_date, vehicle_id, driver_id, status, window_start, window_end,
       total_stops, total_parcels, total_weight_grams, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'draft', ?, ?, 0, 0, 0, 1, ?, ?)`,
    [routeId, input.routeDate, input.vehicleId ?? null, input.driverId ?? null, windowStart, windowEnd, now, now]
  )

  await executeRun(
    db,
    `INSERT INTO delivery_route_commands (
       id, route_id, actor_id, action, command_id, payload_hash, payload_json, expected_version, applied_version, created_at
     ) VALUES (?, ?, ?, 'create', ?, ?, ?, 0, 1, ?)`,
    [randomUUID(), routeId, input.actorId, input.commandId, payloadHash, JSON.stringify(payload), now]
  )

  const created = await getDeliveryRouteById(db, routeId)
  if (!created) throw new DeliveryRouteError('internal', 'Failed to retrieve created route')
  return created
}

export async function addDeliveryRouteStop(
  db: DatabaseAdapter,
  input: {
    actorId: string
    routeId: string
    orderId?: string | null
    recipientName: string
    streetAddress: string
    postalCode: string
    city: string
    parcelCount?: number
    weightGrams?: number
    timeWindowStart?: string | null
    timeWindowEnd?: string | null
    expectedVersion: number
    commandId: string
    now?: string
  }
): Promise<DeliveryRoute> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const parcelCount = input.parcelCount ?? 1
  const weightGrams = input.weightGrams ?? 1000
  const commandInput = {
    actorId: input.actorId,
    routeId: input.routeId,
    orderId: input.orderId ?? null,
    recipientName: input.recipientName,
    streetAddress: input.streetAddress,
    postalCode: input.postalCode,
    city: input.city,
    parcelCount,
    weightGrams,
    timeWindowStart: input.timeWindowStart ?? null,
    timeWindowEnd: input.timeWindowEnd ?? null,
    expectedVersion: input.expectedVersion
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(commandInput)).digest('hex')
  const replay = await routeCommandReplay<DeliveryRoute>(
    db,
    input.routeId,
    input.commandId,
    'add_stop',
    input.actorId,
    payloadHash
  )
  if (replay) return replay
  const route = await getDeliveryRouteById(db, input.routeId)
  if (!route) throw new DeliveryRouteError('not_found', 'Route not found')

  if (route.status === 'completed' || route.status === 'cancelled') {
    throw new DeliveryRouteError('forbidden', `Cannot add stops to route in '${route.status}' status`)
  }

  if (route.version !== input.expectedVersion) {
    throw new DeliveryRouteError(
      'version_conflict',
      `Version conflict: expected ${input.expectedVersion}, actual ${route.version}`
    )
  }

  // Check vehicle capacity constraints if vehicle assigned
  if (route.vehicle) {
    if (route.totalWeightGrams + weightGrams > route.vehicle.maxWeightGrams) {
      throw new DeliveryRouteError(
        'capacity_exceeded',
        `Vehicle weight capacity exceeded: current ${route.totalWeightGrams}g + new ${weightGrams}g > max ${route.vehicle.maxWeightGrams}g`
      )
    }
    if (route.totalParcels + parcelCount > route.vehicle.maxParcels) {
      throw new DeliveryRouteError(
        'capacity_exceeded',
        `Vehicle parcel capacity exceeded: current ${route.totalParcels} + new ${parcelCount} > max ${route.vehicle.maxParcels}`
      )
    }
  }

  const nextSeq = route.totalStops
  const nextVersion = input.expectedVersion + 1
  const stopId = randomUUID()

  const stop: DeliveryRouteStop = {
    id: stopId,
    routeId: input.routeId,
    sequenceIndex: nextSeq,
    orderId: input.orderId ?? null,
    recipientName: input.recipientName,
    streetAddress: input.streetAddress,
    postalCode: input.postalCode,
    city: input.city,
    parcelCount,
    weightGrams,
    timeWindowStart: input.timeWindowStart ?? null,
    timeWindowEnd: input.timeWindowEnd ?? null,
    status: 'pending',
    failureReason: null,
    completedAt: null
  }
  const receipt: DeliveryRoute = JSON.parse(
    JSON.stringify({
      ...route,
      totalStops: route.totalStops + 1,
      totalParcels: route.totalParcels + parcelCount,
      totalWeightGrams: route.totalWeightGrams + weightGrams,
      version: nextVersion,
      updatedAt: now,
      stops: [...route.stops, stop]
    })
  )
  const payload = { commandInput, receipt }

  try {
    await applyRouteMutation(
      db,
      [
        {
          sql: `UPDATE delivery_routes SET total_stops = total_stops + 1, total_parcels = total_parcels + ?,
        total_weight_grams = total_weight_grams + ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ? RETURNING id`,
          params: [parcelCount, weightGrams, nextVersion, now, input.routeId, input.expectedVersion]
        },
        {
          sql: `INSERT INTO delivery_route_commands (
        id, route_id, actor_id, action, command_id, payload_hash, payload_json, expected_version, applied_version, created_at
      ) SELECT ?, ?, ?, 'add_stop', ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
          params: [
            randomUUID(),
            input.routeId,
            input.actorId,
            input.commandId,
            payloadHash,
            JSON.stringify(payload),
            input.expectedVersion,
            nextVersion,
            now
          ]
        },
        {
          sql: `INSERT INTO delivery_route_stops (
        id, route_id, sequence_index, order_id, recipient_name, street_address, postal_code, city,
        parcel_count, weight_grams, time_window_start, time_window_end, status
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending' WHERE changes() = 1`,
          params: [
            stopId,
            input.routeId,
            nextSeq,
            input.orderId ?? null,
            input.recipientName,
            input.streetAddress,
            input.postalCode,
            input.city,
            parcelCount,
            weightGrams,
            input.timeWindowStart ?? null,
            input.timeWindowEnd ?? null
          ]
        }
      ],
      input.expectedVersion
    )
  } catch (error) {
    const raced = await routeCommandReplay<DeliveryRoute>(
      db,
      input.routeId,
      input.commandId,
      'add_stop',
      input.actorId,
      payloadHash
    )
    if (raced) return raced
    throw error
  }
  return receipt
}

export async function reoptimizeDeliveryRoute(
  db: DatabaseAdapter,
  input: {
    actorId: string
    routeId: string
    expectedVersion: number
    commandId: string
    optimizationStrategy?: 'balanced' | 'window_priority' | 'distance_priority'
    now?: string
  }
): Promise<ReoptimizeDeliveryRouteResult> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const strategy = input.optimizationStrategy ?? 'window_priority'
  const commandInput = {
    actorId: input.actorId,
    routeId: input.routeId,
    expectedVersion: input.expectedVersion,
    strategy
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(commandInput)).digest('hex')
  const replay = await routeCommandReplay<ReoptimizeDeliveryRouteResult>(
    db,
    input.routeId,
    input.commandId,
    'reoptimize',
    input.actorId,
    payloadHash
  )
  if (replay) return replay
  const route = await getDeliveryRouteById(db, input.routeId)
  if (!route) throw new DeliveryRouteError('not_found', 'Route not found')

  if (route.status === 'completed' || route.status === 'cancelled') {
    throw new DeliveryRouteError('forbidden', `Cannot reoptimize route in '${route.status}' status`)
  }

  if (route.version !== input.expectedVersion) {
    throw new DeliveryRouteError(
      'version_conflict',
      `Version conflict: expected ${input.expectedVersion}, actual ${route.version}`
    )
  }

  // Separate executed stops (delivered, in_progress, failed) from pending stops
  const stops = route.stops
  const lockedStops = stops.filter((s) => s.status !== 'pending')
  const pendingStops = stops.filter((s) => s.status === 'pending')

  // Resequence pending stops deterministically
  if (strategy === 'window_priority') {
    pendingStops.sort((a, b) => {
      const windowA = a.timeWindowStart ?? '99:99'
      const windowB = b.timeWindowStart ?? '99:99'
      if (windowA !== windowB) return windowA.localeCompare(windowB)
      if (a.postalCode !== b.postalCode) return a.postalCode.localeCompare(b.postalCode)
      return a.streetAddress.localeCompare(b.streetAddress)
    })
  } else {
    pendingStops.sort((a, b) => {
      if (a.postalCode !== b.postalCode) return a.postalCode.localeCompare(b.postalCode)
      const windowA = a.timeWindowStart ?? '99:99'
      const windowB = b.timeWindowStart ?? '99:99'
      if (windowA !== windowB) return windowA.localeCompare(windowB)
      return a.streetAddress.localeCompare(b.streetAddress)
    })
  }

  // Combine: locked stops keep their sequence positions, pending stops fill remaining
  const resequenced = [...lockedStops, ...pendingStops]

  const nextVersion = input.expectedVersion + 1
  const updatedRoute: DeliveryRoute = {
    ...route,
    version: nextVersion,
    updatedAt: now,
    stops: resequenced.map((stop, sequenceIndex) => ({ ...stop, sequenceIndex }))
  }
  const capacityOk =
    !updatedRoute.vehicle ||
    (updatedRoute.totalWeightGrams <= updatedRoute.vehicle.maxWeightGrams &&
      updatedRoute.totalParcels <= updatedRoute.vehicle.maxParcels)
  const receipt: ReoptimizeDeliveryRouteResult = JSON.parse(
    JSON.stringify({
      routeId: input.routeId,
      newVersion: nextVersion,
      resequencedStopsCount: pendingStops.length,
      totalStops: updatedRoute.totalStops,
      totalWeightGrams: updatedRoute.totalWeightGrams,
      totalParcels: updatedRoute.totalParcels,
      capacityOk,
      route: updatedRoute
    })
  )
  const payload = { commandInput, receipt }
  const commandRowId = randomUUID()
  const statements: AtomicStatement[] = [
    {
      sql: `UPDATE delivery_routes SET version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id`,
      params: [nextVersion, now, input.routeId, input.expectedVersion]
    },
    {
      sql: `INSERT INTO delivery_route_commands (
        id, route_id, actor_id, action, command_id, payload_hash, payload_json, expected_version, applied_version, created_at
      ) SELECT ?, ?, ?, 'reoptimize', ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      params: [
        commandRowId,
        input.routeId,
        input.actorId,
        input.commandId,
        payloadHash,
        JSON.stringify(payload),
        input.expectedVersion,
        nextVersion,
        now
      ]
    }
  ]
  for (const [index, stop] of resequenced.entries()) {
    statements.push({
      sql: `UPDATE delivery_route_stops SET sequence_index = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM delivery_route_commands WHERE id = ?)`,
      params: [10000 + index, stop.id, commandRowId]
    })
  }
  for (const [index, stop] of resequenced.entries()) {
    statements.push({
      sql: `UPDATE delivery_route_stops SET sequence_index = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM delivery_route_commands WHERE id = ?)`,
      params: [index, stop.id, commandRowId]
    })
  }
  try {
    await applyRouteMutation(db, statements, input.expectedVersion)
  } catch (error) {
    const raced = await routeCommandReplay<ReoptimizeDeliveryRouteResult>(
      db,
      input.routeId,
      input.commandId,
      'reoptimize',
      input.actorId,
      payloadHash
    )
    if (raced) return raced
    throw error
  }
  return receipt
}

export async function getDeliveryRouteById(db: DatabaseAdapter, id: string): Promise<DeliveryRoute | null> {
  const row = await executeGet<RawRouteRow>(db, `SELECT * FROM delivery_routes WHERE id = ? LIMIT 1`, [id])
  if (!row) return null

  let vehicle: DeliveryVehicle | null = null
  if (row.vehicle_id) {
    const v = await executeGet<RawVehicleRow>(db, `SELECT * FROM delivery_vehicles WHERE id = ? LIMIT 1`, [
      row.vehicle_id
    ])
    if (v) {
      vehicle = {
        id: v.id,
        name: v.name,
        registrationPlate: v.registration_plate,
        maxWeightGrams: v.max_weight_grams,
        maxParcels: v.max_parcels,
        status: v.status,
        createdAt: v.created_at,
        updatedAt: v.updated_at
      }
    }
  }

  let driver: DeliveryDriver | null = null
  if (row.driver_id) {
    const d = await executeGet<RawDriverRow>(db, `SELECT * FROM delivery_drivers WHERE id = ? LIMIT 1`, [row.driver_id])
    if (d) {
      driver = {
        id: d.id,
        identityId: d.identity_id,
        name: d.name,
        phone: d.phone,
        licenseNumber: d.license_number,
        status: d.status,
        createdAt: d.created_at,
        updatedAt: d.updated_at
      }
    }
  }

  const stopRows = await executeAll<RawStopRow>(
    db,
    `SELECT * FROM delivery_route_stops WHERE route_id = ? ORDER BY sequence_index ASC`,
    [id]
  )

  const stops: DeliveryRouteStop[] = stopRows.map((s) => ({
    id: s.id,
    routeId: s.route_id,
    sequenceIndex: s.sequence_index,
    orderId: s.order_id,
    recipientName: s.recipient_name,
    streetAddress: s.street_address,
    postalCode: s.postal_code,
    city: s.city,
    parcelCount: s.parcel_count,
    weightGrams: s.weight_grams,
    timeWindowStart: s.time_window_start,
    timeWindowEnd: s.time_window_end,
    status: s.status,
    failureReason: s.failure_reason,
    completedAt: s.completed_at
  }))

  return {
    id: row.id,
    routeDate: row.route_date,
    vehicleId: row.vehicle_id,
    driverId: row.driver_id,
    status: row.status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    totalStops: row.total_stops,
    totalParcels: row.total_parcels,
    totalWeightGrams: row.total_weight_grams,
    maxWeightGrams: vehicle?.maxWeightGrams,
    maxParcels: vehicle?.maxParcels,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vehicle,
    driver,
    stops
  }
}

export async function listDeliveryRoutes(
  db: DatabaseAdapter,
  filter?: { routeDate?: string; status?: string }
): Promise<DeliveryRoute[]> {
  let sql = `SELECT id FROM delivery_routes WHERE 1=1`
  const params: unknown[] = []
  if (filter?.routeDate) {
    sql += ` AND route_date = ?`
    params.push(filter.routeDate)
  }
  if (filter?.status) {
    sql += ` AND status = ?`
    params.push(filter.status)
  }
  sql += ` ORDER BY route_date DESC, created_at DESC`
  const rows = await executeAll<{ id: string }>(db, sql, params)
  const routes: DeliveryRoute[] = []
  for (const r of rows) {
    const route = await getDeliveryRouteById(db, r.id)
    if (route) routes.push(route)
  }
  return routes
}
