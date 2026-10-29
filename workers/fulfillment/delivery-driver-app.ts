import {
  deliveryEventInputSchema,
  syncRequestSchema,
  type DeliveryEventInput,
  type DeliveryEventResult,
  type DriverManifest,
  type DriverRouteView
} from '../../shared/delivery-driver-app'
import {
  ShippingOpsError,
  allRows,
  atomicBatch,
  firstRow,
  hashPayload,
  liveDriverSql,
  nowIso,
  randomId,
  requireAdmin,
  sha256HexBytes
} from './shipping-ops-common'

const MAX_EVIDENCE_BYTES = 150_000
const FUTURE_SKEW_MS = 5 * 60 * 1000
const PAST_LIMIT_MS = 7 * 24 * 3600 * 1000

export interface DeliveryApplyResult {
  commandId: string
  outcome: 'applied' | 'replayed'
  kind: DeliveryEventInput['kind']
  routeId: string
  stopId: string | null
  routeStatus: string
  stopStatus: string | null
  routeVersion: number
}

interface RouteRow {
  id: string
  status: string
  version: number
  driver_id: string | null
}
interface StopRow {
  id: string
  route_id: string
  status: 'pending' | 'in_progress' | 'delivered' | 'failed'
}

function validDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}
const validInstant = (value: string) => {
  const d = new Date(value)
  return !Number.isNaN(d.getTime()) && `${d.toISOString().slice(0, 19)}Z` === value
}

async function requireDriver(db: D1Database, identityId: string): Promise<string> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT d.id FROM delivery_drivers d JOIN identities i ON i.id = d.identity_id
      WHERE d.identity_id = ?1 AND d.status = 'active' AND i.status = 'active'`,
    identityId
  )
  if (!row) throw new ShippingOpsError('forbidden')
  return row.id
}

export async function getDriverManifest(
  db: D1Database,
  args: { identityId: string; routeDate?: string; now?: string }
): Promise<DriverManifest> {
  const now = nowIso(args.now)
  const routeDate = args.routeDate ?? now.slice(0, 10)
  if (!validDate(routeDate)) throw new ShippingOpsError('invalid_input')
  const driverId = await requireDriver(db, args.identityId)
  const routes = await allRows<{
    id: string
    route_date: string
    status: DriverRouteView['status']
    version: number
    window_start: string
    window_end: string
    vehicle_name: string | null
    total_stops: number
    total_parcels: number
  }>(
    db,
    `SELECT r.id, r.route_date, r.status, r.version, r.window_start, r.window_end, v.name AS vehicle_name, r.total_stops, r.total_parcels
       FROM delivery_routes r LEFT JOIN delivery_vehicles v ON v.id = r.vehicle_id
      WHERE r.driver_id = ?1 AND r.route_date = ?2 AND r.status IN ('planned','in_progress','completed')
      ORDER BY r.window_start, r.id`,
    driverId,
    routeDate
  )
  const stops = routes.length
    ? await allRows<{
        id: string
        route_id: string
        sequence_index: number
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
        incident_count: number
        pod_method: string | null
        pod_received_by: string | null
        pod_captured_at: string | null
      }>(
        db,
        `SELECT s.id, s.route_id, s.sequence_index, s.recipient_name, s.street_address, s.postal_code, s.city, s.parcel_count,
                s.weight_grams, s.time_window_start, s.time_window_end, s.status, s.failure_reason, s.completed_at,
                (SELECT count(*) FROM delivery_incidents i WHERE i.stop_id = s.id) AS incident_count,
                p.method AS pod_method, p.received_by AS pod_received_by, p.captured_at AS pod_captured_at
           FROM delivery_route_stops s LEFT JOIN delivery_pods p ON p.stop_id = s.id
          WHERE s.route_id IN (${routes.map((_, i) => `?${i + 1}`).join(',')})
          ORDER BY s.route_id, s.sequence_index`,
        ...routes.map((r) => r.id)
      )
    : []
  return {
    serverTime: now,
    routeDate,
    routes: routes.map((r) => ({
      id: r.id,
      routeDate: r.route_date,
      status: r.status,
      version: r.version,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      vehicleName: r.vehicle_name,
      totalStops: r.total_stops,
      totalParcels: r.total_parcels,
      stops: stops
        .filter((s) => s.route_id === r.id)
        .map((s) => ({
          id: s.id,
          sequenceIndex: s.sequence_index,
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
          completedAt: s.completed_at,
          incidentCount: s.incident_count,
          pod: s.pod_method
            ? { method: s.pod_method, receivedBy: s.pod_received_by!, capturedAt: s.pod_captured_at! }
            : null
        }))
    }))
  }
}

interface Evidence {
  mime: 'image/png' | 'image/jpeg'
  base64: string
  sha256: string
  bytes: number
}

async function checkEvidence(pod: Extract<DeliveryEventInput, { kind: 'deliver' }>['pod']): Promise<Evidence | null> {
  const needs = pod.method === 'signature' || pod.method === 'photo'
  if (!pod.evidence) {
    if (needs) throw new ShippingOpsError('invalid_input', { reason: 'evidence_required' })
    return null
  }
  if (!needs) throw new ShippingOpsError('invalid_input', { reason: 'evidence_not_allowed' })
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(pod.evidence.base64), (c) => c.charCodeAt(0))
  } catch {
    throw new ShippingOpsError('invalid_input', { reason: 'evidence_encoding' })
  }
  const png = bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const jpg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES || (pod.evidence.mime === 'image/png' ? !png : !jpg))
    throw new ShippingOpsError('invalid_input', { reason: 'evidence_content' })
  return {
    mime: pod.evidence.mime,
    base64: pod.evidence.base64,
    sha256: await sha256HexBytes(bytes),
    bytes: bytes.length
  }
}

interface Plan {
  route: RouteRow
  stop: StopRow | null
  routeStatus: string
  stopStatus: string | null
  routeVersion: number
}

async function plan(db: D1Database, driverId: string, input: DeliveryEventInput): Promise<Plan> {
  let stop: StopRow | null = null
  let route: RouteRow | null
  if (input.kind === 'start_route') {
    route = await firstRow<RouteRow>(
      db,
      `SELECT id, status, version, driver_id FROM delivery_routes WHERE id = ?1`,
      input.routeId
    )
  } else {
    stop = await firstRow<StopRow>(
      db,
      `SELECT id, route_id, status FROM delivery_route_stops WHERE id = ?1`,
      input.stopId
    )
    route = stop
      ? await firstRow<RouteRow>(
          db,
          `SELECT id, status, version, driver_id FROM delivery_routes WHERE id = ?1`,
          stop.route_id
        )
      : null
  }
  if (!route) throw new ShippingOpsError('not_found')
  if (route.driver_id !== driverId) throw new ShippingOpsError('forbidden')
  const invalid = () => new ShippingOpsError('invalid_transition')
  switch (input.kind) {
    case 'start_route':
      if (route.status !== 'planned') throw invalid()
      return { route, stop, routeStatus: 'in_progress', stopStatus: null, routeVersion: route.version + 1 }
    case 'start':
      if (route.status !== 'in_progress' || stop!.status !== 'pending') throw invalid()
      return { route, stop, routeStatus: route.status, stopStatus: 'in_progress', routeVersion: route.version }
    case 'incident':
      if (!['planned', 'in_progress', 'completed'].includes(route.status)) throw invalid()
      return { route, stop, routeStatus: route.status, stopStatus: stop!.status, routeVersion: route.version }
    case 'deliver':
    case 'fail': {
      if (route.status !== 'in_progress' || !['pending', 'in_progress', 'failed'].includes(stop!.status))
        throw invalid()
      if (input.kind === 'fail' && stop!.status === 'failed') throw invalid()
      const open = await firstRow<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM delivery_route_stops WHERE route_id = ?1 AND id <> ?2 AND status IN ('pending','in_progress')`,
        route.id,
        stop!.id
      )
      return {
        route,
        stop,
        routeStatus: open!.n === 0 ? 'completed' : route.status,
        stopStatus: input.kind === 'deliver' ? 'delivered' : 'failed',
        routeVersion: route.version + 1
      }
    }
  }
}

async function replayOf(db: D1Database, commandId: string, hash: string): Promise<DeliveryApplyResult | null> {
  const row = await firstRow<{ payload_hash: string; response_json: string }>(
    db,
    `SELECT payload_hash, response_json FROM delivery_stop_events WHERE command_id = ?1`,
    commandId
  )
  if (!row) return null
  if (row.payload_hash !== hash) throw new ShippingOpsError('idempotency_conflict')
  return { ...(JSON.parse(row.response_json) as DeliveryApplyResult), outcome: 'replayed' }
}

export async function applyDeliveryEvent(
  db: D1Database,
  args: { identityId: string; input: unknown; now?: string }
): Promise<DeliveryApplyResult> {
  const parsed = deliveryEventInputSchema.safeParse(args.input)
  if (!parsed.success) throw new ShippingOpsError('invalid_input')
  const input = parsed.data
  const now = nowIso(args.now)
  const occurred = Date.parse(input.occurredAt)
  if (
    !validInstant(input.occurredAt) ||
    occurred > Date.parse(now) + FUTURE_SKEW_MS ||
    occurred < Date.parse(now) - PAST_LIMIT_MS
  )
    throw new ShippingOpsError('invalid_input', { reason: 'occurred_at' })
  const evidence = input.kind === 'deliver' ? await checkEvidence(input.pod) : null
  const driverId = await requireDriver(db, args.identityId)
  const hash = await hashPayload({ identityId: args.identityId, ...input })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = await replayOf(db, input.commandId, hash)
    if (replay) return replay
    const p = await plan(db, driverId, input)
    const result: DeliveryApplyResult = {
      commandId: input.commandId,
      outcome: 'applied',
      kind: input.kind,
      routeId: p.route.id,
      stopId: p.stop?.id ?? null,
      routeStatus: p.routeStatus,
      stopStatus: p.stopStatus,
      routeVersion: p.routeVersion
    }
    const payload = JSON.stringify(
      input.kind === 'deliver'
        ? {
            ...input,
            pod: {
              method: input.pod.method,
              receivedBy: input.pod.receivedBy,
              evidenceSha256: evidence?.sha256 ?? null,
              location: input.pod.location ?? null
            }
          }
        : input
    )
    try {
      await atomicBatch(db, (g) => {
        const routeId = p.route.id
        const stopId = p.stop?.id ?? null
        const live = liveDriverSql('?5', '?4')
        const allowedRoute =
          input.kind === 'incident'
            ? `('planned','in_progress','completed')`
            : input.kind === 'start_route'
              ? `('planned')`
              : `('in_progress')`
        const allowedStop =
          input.kind === 'start'
            ? `('pending')`
            : input.kind === 'deliver'
              ? `('pending','in_progress','failed')`
              : input.kind === 'fail'
                ? `('pending','in_progress')`
                : `('pending','in_progress','delivered','failed')`
        const stopCondition =
          stopId === null
            ? '1'
            : `EXISTS(SELECT 1 FROM delivery_route_stops s WHERE s.id = ?3 AND s.route_id = ?2 AND s.status IN ${allowedStop})`
        const eventInsert = db
          .prepare(
            `INSERT INTO delivery_stop_events(command_id,route_id,stop_id,driver_id,actor_id,kind,payload_hash,payload_json,response_json,occurred_at,received_at)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
              WHERE ${live} AND ${stopCondition}
                AND EXISTS(SELECT 1 FROM delivery_routes r WHERE r.id = ?2 AND r.driver_id = ?4 AND r.status IN ${allowedRoute}${
                  input.kind === 'start_route' ? ' AND r.version = ?12' : ''
                })`
          )
          .bind(
            input.commandId,
            routeId,
            stopId,
            driverId,
            args.identityId,
            input.kind,
            hash,
            payload,
            JSON.stringify(result),
            input.occurredAt,
            now,
            ...(input.kind === 'start_route' ? [p.route.version] : [])
          )
        const routeCommand = (action: 'dispatch' | 'complete_stop') =>
          db
            .prepare(
              `INSERT INTO delivery_route_commands(id,route_id,actor_id,action,command_id,payload_hash,payload_json,expected_version,applied_version,created_at)
               SELECT ?1, r.id, ?2, ?3, ?4, ?5, ?6, r.version - 1, r.version, ?7 FROM delivery_routes r WHERE r.id = ?8`
            )
            .bind(randomId(), args.identityId, action, input.commandId, hash, payload, now, routeId)
        switch (input.kind) {
          case 'start_route':
            return [
              eventInsert,
              g.expectOne(),
              db
                .prepare(
                  `UPDATE delivery_routes SET status = 'in_progress', version = version + 1, updated_at = ?3
                   WHERE id = ?1 AND driver_id = ?2 AND status = 'planned' AND version = ?4 AND ${liveDriverSql('?5', '?2')}`
                )
                .bind(routeId, driverId, now, p.route.version, args.identityId),
              g.expectOne(),
              routeCommand('dispatch')
            ]
          case 'start':
            return [
              eventInsert,
              g.expectOne(),
              db
                .prepare(`UPDATE delivery_route_stops SET status = 'in_progress' WHERE id = ?1 AND status = 'pending'`)
                .bind(stopId),
              g.expectOne()
            ]
          case 'incident':
            return [
              eventInsert,
              g.expectOne(),
              db
                .prepare(
                  `INSERT INTO delivery_incidents(id,command_id,route_id,stop_id,driver_id,category,note,occurred_at,created_at)
                   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`
                )
                .bind(
                  randomId(),
                  input.commandId,
                  routeId,
                  stopId,
                  driverId,
                  input.category,
                  input.note,
                  input.occurredAt,
                  now
                )
            ]
          case 'fail':
          case 'deliver': {
            const delivering = input.kind === 'deliver'
            const reason = input.kind === 'fail' ? (input.note ? `${input.reason}: ${input.note}` : input.reason) : null
            const statements = [
              eventInsert,
              g.expectOne(),
              db
                .prepare(
                  `UPDATE delivery_route_stops SET status = ?2, failure_reason = ?3, completed_at = ?4
                   WHERE id = ?1 AND status IN ${allowedStop}`
                )
                .bind(stopId, delivering ? 'delivered' : 'failed', reason, input.occurredAt),
              g.expectOne()
            ]
            if (input.kind === 'deliver') {
              statements.push(
                db
                  .prepare(
                    `INSERT INTO delivery_pods(stop_id,command_id,method,received_by,evidence_mime,evidence_base64,evidence_sha256,evidence_bytes,latitude_e5,longitude_e5,captured_at,created_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
                  )
                  .bind(
                    stopId,
                    input.commandId,
                    input.pod.method,
                    input.pod.receivedBy,
                    evidence?.mime ?? null,
                    evidence?.base64 ?? null,
                    evidence?.sha256 ?? null,
                    evidence?.bytes ?? null,
                    input.pod.location ? Math.round(input.pod.location.latitude * 1e5) : null,
                    input.pod.location ? Math.round(input.pod.location.longitude * 1e5) : null,
                    input.occurredAt,
                    now
                  )
              )
            }
            statements.push(
              db
                .prepare(
                  `UPDATE delivery_routes SET version = version + 1, updated_at = ?2,
                     status = CASE WHEN NOT EXISTS(SELECT 1 FROM delivery_route_stops WHERE route_id = ?1 AND status IN ('pending','in_progress')) THEN 'completed' ELSE status END
                   WHERE id = ?1 AND version = ?3 AND status = 'in_progress'`
                )
                .bind(routeId, now, p.route.version),
              g.expectOne(),
              routeCommand('complete_stop')
            )
            return statements
          }
        }
      })
      return result
    } catch {
      // Lost a race (replay), lost authorisation, or the state moved: re-derive the precise reason.
      const raced = await replayOf(db, input.commandId, hash)
      if (raced) return raced
      await requireDriver(db, args.identityId)
      await plan(db, driverId, input)
    }
  }
  throw new ShippingOpsError('internal')
}

export async function syncDeliveryEvents(
  db: D1Database,
  args: { identityId: string; input: unknown; now?: string }
): Promise<{ results: DeliveryEventResult[] }> {
  const parsed = syncRequestSchema.safeParse(args.input)
  if (!parsed.success) throw new ShippingOpsError('invalid_input')
  await requireDriver(db, args.identityId)
  const results: DeliveryEventResult[] = []
  for (const event of parsed.data.events) {
    try {
      const applied = await applyDeliveryEvent(db, { identityId: args.identityId, input: event, now: args.now })
      results.push({ commandId: event.commandId, outcome: applied.outcome })
    } catch (error) {
      if (error instanceof ShippingOpsError && error.code !== 'internal') {
        results.push({ commandId: event.commandId, outcome: 'rejected', error: { code: error.code } })
      } else {
        results.push({ commandId: event.commandId, outcome: 'retry' })
        break
      }
    }
  }
  return { results }
}

export async function getRouteReport(db: D1Database, actorId: string, routeId: string) {
  await requireAdmin(db, actorId)
  const route = await firstRow<{ id: string; status: string; version: number; route_date: string }>(
    db,
    `SELECT id, status, version, route_date FROM delivery_routes WHERE id = ?1`,
    routeId
  )
  if (!route) throw new ShippingOpsError('not_found')
  const events = await allRows<{
    command_id: string
    kind: string
    stop_id: string | null
    driver_id: string
    occurred_at: string
    received_at: string
  }>(
    db,
    `SELECT command_id, kind, stop_id, driver_id, occurred_at, received_at FROM delivery_stop_events WHERE route_id = ?1 ORDER BY received_at, rowid`,
    routeId
  )
  const incidents = await allRows<{ id: string; stop_id: string; category: string; note: string; occurred_at: string }>(
    db,
    `SELECT id, stop_id, category, note, occurred_at FROM delivery_incidents WHERE route_id = ?1 ORDER BY occurred_at, rowid`,
    routeId
  )
  const pods = await allRows<{
    stop_id: string
    method: string
    received_by: string
    captured_at: string
    evidence_sha256: string | null
    evidence_bytes: number | null
  }>(
    db,
    `SELECT p.stop_id, p.method, p.received_by, p.captured_at, p.evidence_sha256, p.evidence_bytes
       FROM delivery_pods p JOIN delivery_route_stops s ON s.id = p.stop_id WHERE s.route_id = ?1 ORDER BY p.captured_at, p.stop_id`,
    routeId
  )
  await requireAdmin(db, actorId)
  return {
    route: { id: route.id, status: route.status, version: route.version, routeDate: route.route_date },
    events: events.map((e) => ({
      commandId: e.command_id,
      kind: e.kind,
      stopId: e.stop_id,
      driverId: e.driver_id,
      occurredAt: e.occurred_at,
      receivedAt: e.received_at
    })),
    incidents: incidents.map((i) => ({
      id: i.id,
      stopId: i.stop_id,
      category: i.category,
      note: i.note,
      occurredAt: i.occurred_at
    })),
    pods: pods.map((p) => ({
      stopId: p.stop_id,
      method: p.method,
      receivedBy: p.received_by,
      capturedAt: p.captured_at,
      hasEvidence: p.evidence_sha256 !== null,
      evidenceSha256: p.evidence_sha256,
      evidenceBytes: p.evidence_bytes
    }))
  }
}

export async function getDeliveryEvidence(db: D1Database, actorId: string, stopId: string) {
  await requireAdmin(db, actorId)
  const pod = await firstRow<{
    evidence_mime: 'image/png' | 'image/jpeg' | null
    evidence_base64: string | null
    evidence_sha256: string | null
  }>(db, `SELECT evidence_mime, evidence_base64, evidence_sha256 FROM delivery_pods WHERE stop_id = ?1`, stopId)
  if (!pod?.evidence_base64 || !pod.evidence_mime) throw new ShippingOpsError('not_found')
  const bytes = Uint8Array.from(atob(pod.evidence_base64), (c) => c.charCodeAt(0))
  if ((await sha256HexBytes(bytes)) !== pod.evidence_sha256)
    throw new ShippingOpsError('internal', { reason: 'evidence_hash_mismatch' })
  await requireAdmin(db, actorId)
  return { mime: pod.evidence_mime, bytes, sha256: pod.evidence_sha256 }
}
