import type {
  ConveniencePoint,
  ConveniencePointNetwork,
  ConveniencePointOpeningHours
} from '../../shared/shipping-convenience-points'

export class ConveniencePointsError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'ConveniencePointsError'
  }
}

export interface DatabaseAdapter {
  prepare: (query: string) => {
    bind?: (...params: unknown[]) => unknown
    all?: (...params: unknown[]) => unknown
    get?: (...params: unknown[]) => unknown
    first?: (...params: unknown[]) => unknown
    run?: (...params: unknown[]) => unknown
  }
}

export interface ListConveniencePointsInput {
  postalCode: string
  network?: ConveniencePointNetwork
  includeClosed?: boolean
  limit?: number
}

interface RawPointRow {
  id: string
  network: ConveniencePointNetwork
  code: string
  name: string
  street_address: string
  postal_code: string
  city: string
  province: string
  country_code: 'ES'
  latitude: number | null
  longitude: number | null
  opening_hours_json: string
  operating_status: 'active' | 'temporarily_closed'
  max_weight_grams: number
  accepts_returns: number
  has_locker: number
  created_at: string
  updated_at: string
}

function mapRowToPoint(row: RawPointRow): ConveniencePoint {
  let openingHours: ConveniencePointOpeningHours = {}
  try {
    openingHours = JSON.parse(row.opening_hours_json) as ConveniencePointOpeningHours
  } catch {
    // defaults to empty
  }

  return {
    id: row.id,
    network: row.network,
    code: row.code,
    name: row.name,
    streetAddress: row.street_address,
    postalCode: row.postal_code,
    city: row.city,
    province: row.province,
    countryCode: 'ES',
    latitude: row.latitude,
    longitude: row.longitude,
    openingHours,
    operatingStatus: row.operating_status,
    maxWeightGrams: row.max_weight_grams,
    acceptsReturns: row.accepts_returns === 1,
    hasLocker: row.has_locker === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function executeQuery<T>(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<T[]> {
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

export async function listConveniencePoints(
  db: DatabaseAdapter,
  input: ListConveniencePointsInput
): Promise<ConveniencePoint[]> {
  if (!input.postalCode || !/^\d{5}$/.test(input.postalCode)) {
    throw new ConveniencePointsError('invalid_input', 'Postal code must be a 5-digit Spanish code')
  }

  let sql = `
    SELECT id, network, code, name, street_address, postal_code, city, province, country_code,
           latitude, longitude, opening_hours_json, operating_status, max_weight_grams,
           accepts_returns, has_locker, created_at, updated_at
    FROM shipping_convenience_points
    WHERE postal_code = ?
  `
  const params: unknown[] = [input.postalCode]

  if (!input.includeClosed) {
    sql += ` AND operating_status = 'active'`
  }

  if (input.network) {
    sql += ` AND network = ?`
    params.push(input.network)
  }

  sql += ` ORDER BY name ASC`
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  sql += ` LIMIT ?`
  params.push(limit)

  const rows = await executeQuery<RawPointRow>(db, sql, params)
  return rows.map(mapRowToPoint)
}

export async function getConveniencePointById(db: DatabaseAdapter, id: string): Promise<ConveniencePoint | null> {
  const sql = `
    SELECT id, network, code, name, street_address, postal_code, city, province, country_code,
           latitude, longitude, opening_hours_json, operating_status, max_weight_grams,
           accepts_returns, has_locker, created_at, updated_at
    FROM shipping_convenience_points
    WHERE id = ?
    LIMIT 1
  `
  const row = await executeGet<RawPointRow>(db, sql, [id])
  return row ? mapRowToPoint(row) : null
}
