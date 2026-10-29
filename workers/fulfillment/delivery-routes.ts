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
    readonly code: 'invalid_input' | 'not_found' | 'version_conflict' | 'capacity_exceeded' | 'forbidden' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'DeliveryRouteError'
  }
}

async function executeGet<T>(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<T | null> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
    }
    if (typeof stmt.first === 'function') {
      const res = await stmt.first(...params)
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
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
    }
    if (typeof stmt.all === 'function') {
      const res = await stmt.all(...params)
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
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
    }
    if (typeof stmt.run === 'function') {
      await stmt.run(...params)
    }
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

  const parcelCount = input.parcelCount ?? 1
  const weightGrams = input.weightGrams ?? 1000

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
  const nextVersion = route.version + 1
  const stopId = randomUUID()

  const payload = {
    stopId,
    routeId: input.routeId,
    recipientName: input.recipientName,
    streetAddress: input.streetAddress,
    postalCode: input.postalCode,
    city: input.city,
    parcelCount,
    weightGrams,
    timeWindowStart: input.timeWindowStart,
    timeWindowEnd: input.timeWindowEnd,
    sequenceIndex: nextSeq,
    commandId: input.commandId
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  await executeRun(
    db,
    `INSERT INTO delivery_route_stops (
       id, route_id, sequence_index, order_id, recipient_name, street_address,
       postal_code, city, parcel_count, weight_grams, time_window_start, time_window_end,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
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
  )

  await executeRun(
    db,
    `UPDATE delivery_routes
     SET total_stops = total_stops + 1,
         total_parcels = total_parcels + ?,
         total_weight_grams = total_weight_grams + ?,
         version = ?,
         updated_at = ?
     WHERE id = ?`,
    [parcelCount, weightGrams, nextVersion, now, input.routeId]
  )

  await executeRun(
    db,
    `INSERT INTO delivery_route_commands (
       id, route_id, actor_id, action, command_id, payload_hash, payload_json, expected_version, applied_version, created_at
     ) VALUES (?, ?, ?, 'add_stop', ?, ?, ?, ?, ?, ?)`,
    [
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
  )

  const updated = await getDeliveryRouteById(db, input.routeId)
  if (!updated) throw new DeliveryRouteError('internal', 'Failed to retrieve route after adding stop')
  return updated
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

  const strategy = input.optimizationStrategy ?? 'window_priority'

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

  // Update sequenceIndex in database using a high positive offset first to avoid unique constraint collision
  for (let i = 0; i < resequenced.length; i++) {
    const s = resequenced[i]!
    await executeRun(db, `UPDATE delivery_route_stops SET sequence_index = ? WHERE id = ?`, [10000 + i, s.id])
  }
  for (let i = 0; i < resequenced.length; i++) {
    const s = resequenced[i]!
    await executeRun(db, `UPDATE delivery_route_stops SET sequence_index = ? WHERE id = ?`, [i, s.id])
  }

  const nextVersion = route.version + 1
  const payload = {
    routeId: input.routeId,
    strategy,
    resequencedCount: pendingStops.length,
    commandId: input.commandId
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')

  await executeRun(
    db,
    `UPDATE delivery_routes
     SET version = ?, updated_at = ?
     WHERE id = ?`,
    [nextVersion, now, input.routeId]
  )

  await executeRun(
    db,
    `INSERT INTO delivery_route_commands (
       id, route_id, actor_id, action, command_id, payload_hash, payload_json, expected_version, applied_version, created_at
     ) VALUES (?, ?, ?, 'reoptimize', ?, ?, ?, ?, ?, ?)`,
    [
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
  )

  const updatedRoute = await getDeliveryRouteById(db, input.routeId)
  if (!updatedRoute) throw new DeliveryRouteError('internal', 'Failed to retrieve reoptimized route')

  const capacityOk =
    !updatedRoute.vehicle ||
    (updatedRoute.totalWeightGrams <= updatedRoute.vehicle.maxWeightGrams &&
      updatedRoute.totalParcels <= updatedRoute.vehicle.maxParcels)

  return {
    routeId: input.routeId,
    newVersion: nextVersion,
    resequencedStopsCount: pendingStops.length,
    totalStops: updatedRoute.totalStops,
    totalWeightGrams: updatedRoute.totalWeightGrams,
    totalParcels: updatedRoute.totalParcels,
    capacityOk,
    route: updatedRoute
  }
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
