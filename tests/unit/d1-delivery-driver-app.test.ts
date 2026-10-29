import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyDeliveryEvent,
  getDeliveryEvidence,
  getDriverManifest,
  getRouteReport,
  syncDeliveryEvents
} from '../../workers/fulfillment/delivery-driver-app'
import { ShippingOpsError } from '../../workers/fulfillment/shipping-ops-common'
import { ADMIN, DRIVER_IDENTITY, DRIVER_IDENTITY_2, NOW, OTHER, opsWorld, type OpsWorld } from './shipping-ops-fixture'

let w: OpsWorld
const code = (e: unknown) => (e instanceof ShippingOpsError ? e.code : `not-ops:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)
const T = '2026-10-29T09:30:00Z'
// 1x1 PNG and a minimal JPEG header, both valid magic numbers.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')

beforeEach(async () => {
  w = await opsWorld()
  w.sqlite.exec(`
    INSERT INTO delivery_vehicles(id,name,registration_plate,max_weight_grams,max_parcels,status,created_at,updated_at) VALUES('v-1','Furgoneta 1','1111-AAA',1000000,50,'active','${NOW}','${NOW}');
    INSERT INTO delivery_drivers(id,identity_id,name,phone,license_number,status,created_at,updated_at) VALUES
      ('d-1','${DRIVER_IDENTITY}','Conductor Uno','+34600111222','LIC-1','active','${NOW}','${NOW}'),
      ('d-2','${DRIVER_IDENTITY_2}','Conductor Dos','+34600333444','LIC-2','active','${NOW}','${NOW}');
    INSERT INTO delivery_routes(id,route_date,vehicle_id,driver_id,status,window_start,window_end,total_stops,total_parcels,total_weight_grams,version,created_at,updated_at) VALUES
      ('r-1','2026-10-29','v-1','d-1','planned','08:00','16:00',3,5,9000,1,'${NOW}','${NOW}'),
      ('r-2','2026-10-29','v-1','d-2','planned','08:00','16:00',1,1,1000,1,'${NOW}','${NOW}'),
      ('r-old','2026-10-28','v-1','d-1','completed','08:00','16:00',0,0,0,1,'${NOW}','${NOW}');
    INSERT INTO delivery_route_stops(id,route_id,sequence_index,order_id,recipient_name,street_address,postal_code,city,parcel_count,weight_grams,status) VALUES
      ('s-1','r-1',0,'ord-secret-1','Taller Alfa','Calle A 1','46870','Ontinyent',2,3000,'pending'),
      ('s-2','r-1',1,'ord-secret-2','Bar Beta','Calle B 2','46870','Ontinyent',2,3000,'pending'),
      ('s-3','r-1',2,NULL,'Casa Gamma','Calle C 3','46870','Ontinyent',1,3000,'pending'),
      ('s-x','r-2',0,NULL,'Otro Cliente','Calle X 9','46870','Ontinyent',1,1000,'pending');
  `)
})
afterEach(() => w.close())

let n = 0
const cid = () => `cmd-${String(++n).padStart(8, '0')}`
const apply = (event: Record<string, unknown>, identityId = DRIVER_IDENTITY) =>
  applyDeliveryEvent(w.db, { identityId, input: { commandId: cid(), occurredAt: T, ...event }, now: NOW })
const startRoute = (routeId = 'r-1', identityId = DRIVER_IDENTITY) =>
  apply({ kind: 'start_route', routeId }, identityId)
const deliver = (
  stopId: string,
  pod: Record<string, unknown> = {
    method: 'signature',
    receivedBy: 'Ana',
    evidence: { mime: 'image/png', base64: PNG }
  },
  identityId = DRIVER_IDENTITY
) => apply({ kind: 'deliver', stopId, pod }, identityId)
const count = (table: string) => (w.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n
const stop = (id: string) =>
  w.sqlite.prepare('SELECT * FROM delivery_route_stops WHERE id = ?').get(id) as Record<string, unknown>
const route = (id: string) =>
  w.sqlite.prepare('SELECT * FROM delivery_routes WHERE id = ?').get(id) as Record<string, unknown>

describe('SHP-027 driver manifest', () => {
  it('returns only the own routes for the day with ordered stops and minimal PII', async () => {
    const m = await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, now: NOW })
    expect(m.routeDate).toBe('2026-10-29')
    expect(m.routes.map((r) => r.id)).toEqual(['r-1'])
    expect(m.routes[0]!.stops.map((s) => s.id)).toEqual(['s-1', 's-2', 's-3'])
    expect(m.routes[0]!.vehicleName).toBe('Furgoneta 1')
    const text = JSON.stringify(m)
    for (const secret of ['ord-secret', '+34600', 'LIC-', '1111-AAA', 'Otro Cliente'])
      expect(text).not.toContain(secret)
    const other = await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY_2, now: NOW })
    expect(other.routes.map((r) => r.id)).toEqual(['r-2'])
  })

  it('supports another date, rejects malformed dates and empty days', async () => {
    expect(
      (await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, routeDate: '2026-10-28', now: NOW })).routes.map(
        (r) => r.id
      )
    ).toEqual(['r-old'])
    expect(
      (await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, routeDate: '2027-01-01', now: NOW })).routes
    ).toEqual([])
    expect(
      await fails(getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, routeDate: '2026-13-40', now: NOW }))
    ).toBe('invalid_input')
    expect(await fails(getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, routeDate: 'hoy', now: NOW }))).toBe(
      'invalid_input'
    )
  })

  it('hides draft routes and refuses non drivers, off-duty drivers and disabled identities', async () => {
    w.sqlite.exec(`UPDATE delivery_routes SET status = 'draft' WHERE id = 'r-1'`)
    expect((await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, now: NOW })).routes).toEqual([])
    expect(await fails(getDriverManifest(w.db, { identityId: OTHER, now: NOW }))).toBe('forbidden')
    expect(await fails(getDriverManifest(w.db, { identityId: ADMIN, now: NOW }))).toBe('forbidden')
    w.sqlite.exec(`UPDATE delivery_drivers SET status = 'off_duty' WHERE id = 'd-1'`)
    expect(await fails(getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, now: NOW }))).toBe('forbidden')
    w.sqlite.exec(
      `UPDATE delivery_drivers SET status = 'active' WHERE id = 'd-1'; UPDATE identities SET status = 'disabled' WHERE id = '${DRIVER_IDENTITY}'`
    )
    expect(await fails(getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, now: NOW }))).toBe('forbidden')
  })
})

describe('SHP-027 route and stop lifecycle', () => {
  it('starts the route once, bumps its version and records the route command', async () => {
    const r = await startRoute()
    expect(r).toMatchObject({ outcome: 'applied', kind: 'start_route', routeStatus: 'in_progress', routeVersion: 2 })
    expect(route('r-1')).toMatchObject({ status: 'in_progress', version: 2 })
    expect(
      w.sqlite
        .prepare(`SELECT action, expected_version, applied_version FROM delivery_route_commands WHERE route_id = 'r-1'`)
        .get()
    ).toEqual({ action: 'dispatch', expected_version: 1, applied_version: 2 })
    expect(await fails(startRoute())).toBe('invalid_transition')
    expect(route('r-1').version).toBe(2)
  })

  it('refuses stop events before the route is started and routes of other drivers', async () => {
    expect(await fails(apply({ kind: 'start', stopId: 's-1' }))).toBe('invalid_transition')
    expect(await fails(deliver('s-1'))).toBe('invalid_transition')
    expect(await fails(startRoute('r-2'))).toBe('forbidden')
    expect(await fails(startRoute('r-missing'))).toBe('not_found')
    expect(await fails(apply({ kind: 'start', stopId: 's-x' }))).toBe('forbidden')
    expect(await fails(apply({ kind: 'start', stopId: 'nope' }))).toBe('not_found')
    expect(count('delivery_stop_events')).toBe(0)
  })

  it('moves a stop pending -> in_progress once', async () => {
    await startRoute()
    expect(await apply({ kind: 'start', stopId: 's-1' })).toMatchObject({ stopStatus: 'in_progress' })
    expect(await fails(apply({ kind: 'start', stopId: 's-1' }))).toBe('invalid_transition')
    expect(route('r-1').version).toBe(2)
  })

  it('delivers with a signature, stores hash-verified evidence and a route command', async () => {
    await startRoute()
    const r = await deliver('s-1')
    expect(r).toMatchObject({
      outcome: 'applied',
      stopStatus: 'delivered',
      routeStatus: 'in_progress',
      routeVersion: 3
    })
    expect(stop('s-1')).toMatchObject({ status: 'delivered', completed_at: T, failure_reason: null })
    const pod = w.sqlite.prepare('SELECT * FROM delivery_pods WHERE stop_id = ?').get('s-1') as Record<string, unknown>
    expect(pod).toMatchObject({ method: 'signature', received_by: 'Ana', evidence_mime: 'image/png' })
    expect(pod.evidence_sha256).toBe(createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex'))
    expect(pod.evidence_bytes).toBe(Buffer.from(PNG, 'base64').length)
    expect(
      w.sqlite
        .prepare(`SELECT action FROM delivery_route_commands WHERE route_id = 'r-1' ORDER BY applied_version`)
        .all()
    ).toEqual([{ action: 'dispatch' }, { action: 'complete_stop' }])
  })

  it('validates proof of delivery: required evidence, magic bytes, mime match, size, coordinates', async () => {
    await startRoute()
    const bad = (pod: Record<string, unknown>) => fails(deliver('s-1', pod))
    expect(await bad({ method: 'signature', receivedBy: 'Ana' })).toBe('invalid_input')
    expect(await bad({ method: 'photo', receivedBy: 'Ana' })).toBe('invalid_input')
    expect(await bad({ method: 'signature', receivedBy: 'Ana', evidence: { mime: 'image/png', base64: JPG } })).toBe(
      'invalid_input'
    )
    expect(await bad({ method: 'signature', receivedBy: 'Ana', evidence: { mime: 'image/jpeg', base64: PNG } })).toBe(
      'invalid_input'
    )
    expect(
      await bad({
        method: 'signature',
        receivedBy: 'Ana',
        evidence: { mime: 'image/png', base64: Buffer.from('<svg onload=alert(1)>').toString('base64') }
      })
    ).toBe('invalid_input')
    expect(await bad({ method: 'neighbour', receivedBy: 'A' })).toBe('invalid_input')
    expect(
      await bad({
        method: 'signature',
        receivedBy: 'Ana',
        evidence: { mime: 'image/png', base64: 'iVBORw0KGgo' + 'A'.repeat(200_000) }
      })
    ).toBe('invalid_input')
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(150_000)]).toString('base64')
    expect(await bad({ method: 'photo', receivedBy: 'Ana', evidence: { mime: 'image/png', base64: big } })).toBe(
      'invalid_input'
    )
    expect(count('delivery_pods')).toBe(0)
    expect(stop('s-1').status).toBe('pending')
    const ok = await deliver('s-1', {
      method: 'photo',
      receivedBy: 'Vecino',
      evidence: { mime: 'image/jpeg', base64: JPG },
      location: { latitude: 38.82, longitude: -0.6 }
    })
    expect(ok.stopStatus).toBe('delivered')
    expect(w.sqlite.prepare('SELECT latitude_e5, longitude_e5 FROM delivery_pods').get()).toEqual({
      latitude_e5: 3882000,
      longitude_e5: -60000
    })
    const neighbour = await deliver('s-2', { method: 'neighbour', receivedBy: 'Vecina Maria' })
    expect(neighbour.stopStatus).toBe('delivered')
  })

  it('does not deliver twice, and allows delivery after a failed attempt', async () => {
    await startRoute()
    await deliver('s-1')
    expect(await fails(deliver('s-1'))).toBe('invalid_transition')
    expect(count('delivery_pods')).toBe(1)
    const failed = await apply({ kind: 'fail', stopId: 's-2', reason: 'customer_absent', note: 'Persiana bajada' })
    expect(failed).toMatchObject({ stopStatus: 'failed' })
    expect(stop('s-2')).toMatchObject({ status: 'failed', failure_reason: 'customer_absent: Persiana bajada' })
    expect(await fails(apply({ kind: 'fail', stopId: 's-1', reason: 'other' }))).toBe('invalid_transition')
    const retried = await deliver('s-2', { method: 'neighbour', receivedBy: 'Vecina Maria' })
    expect(retried.stopStatus).toBe('delivered')
    expect(stop('s-2').failure_reason).toBeNull()
  })

  it('completes the route when every stop is terminal and then refuses stop changes', async () => {
    await startRoute()
    await deliver('s-1')
    await apply({ kind: 'fail', stopId: 's-2', reason: 'refused' })
    const last = await deliver('s-3', { method: 'neighbour', receivedBy: 'Vecino Pepe' })
    expect(last).toMatchObject({ routeStatus: 'completed' })
    expect(route('r-1').status).toBe('completed')
    expect(await fails(deliver('s-2', { method: 'neighbour', receivedBy: 'Vecino Pepe' }))).toBe('invalid_transition')
    const incident = await apply({ kind: 'incident', stopId: 's-2', category: 'refused', note: 'Devolver a almacen' })
    expect(incident.outcome).toBe('applied')
  })

  it('records incidents without changing the stop, validating category and ownership', async () => {
    await startRoute()
    const r = await apply({ kind: 'incident', stopId: 's-1', category: 'damaged_parcel', note: 'Caja golpeada' })
    expect(r).toMatchObject({ outcome: 'applied', stopStatus: 'pending' })
    expect(stop('s-1').status).toBe('pending')
    expect(w.sqlite.prepare('SELECT category, driver_id FROM delivery_incidents').get()).toEqual({
      category: 'damaged_parcel',
      driver_id: 'd-1'
    })
    expect(route('r-1').version).toBe(2)
    expect(await fails(apply({ kind: 'incident', stopId: 's-1', category: 'bogus', note: 'x' }))).toBe('invalid_input')
    expect(await fails(apply({ kind: 'incident', stopId: 's-x', category: 'other', note: 'ajeno' }))).toBe('forbidden')
    const m = await getDriverManifest(w.db, { identityId: DRIVER_IDENTITY, now: NOW })
    expect(m.routes[0]!.stops[0]!.incidentCount).toBe(1)
  })

  it('refuses events on a cancelled route', async () => {
    await startRoute()
    w.sqlite.exec(`UPDATE delivery_routes SET status = 'cancelled' WHERE id = 'r-1'`)
    expect(await fails(deliver('s-1'))).toBe('invalid_transition')
    expect(await fails(apply({ kind: 'incident', stopId: 's-1', category: 'other', note: 'x' }))).toBe(
      'invalid_transition'
    )
  })

  it('rejects implausible device clocks', async () => {
    await startRoute()
    expect(await fails(apply({ kind: 'start', stopId: 's-1', occurredAt: '2026-10-29T11:00:00Z' }))).toBe(
      'invalid_input'
    )
    expect(await fails(apply({ kind: 'start', stopId: 's-1', occurredAt: '2026-10-01T09:00:00Z' }))).toBe(
      'invalid_input'
    )
    expect(await fails(apply({ kind: 'start', stopId: 's-1', occurredAt: '2026-02-30T09:00:00Z' }))).toBe(
      'invalid_input'
    )
  })
})

describe('SHP-027 idempotency, concurrency and live authorisation', () => {
  it('replays a command id without repeating its effect, and detects payload reuse', async () => {
    await startRoute()
    const input = {
      commandId: 'cmd-replay-001',
      kind: 'deliver',
      stopId: 's-1',
      occurredAt: T,
      pod: { method: 'neighbour', receivedBy: 'Vecina Maria' }
    }
    const a = await applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY, input, now: NOW })
    const b = await applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY, input, now: NOW })
    expect(a.outcome).toBe('applied')
    expect(b).toMatchObject({ outcome: 'replayed', stopStatus: 'delivered', routeVersion: a.routeVersion })
    expect(count('delivery_pods')).toBe(1)
    expect(route('r-1').version).toBe(3)
    expect(
      await fails(
        applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY, input: { ...input, stopId: 's-2' }, now: NOW })
      )
    ).toBe('idempotency_conflict')
    expect(await fails(applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY_2, input, now: NOW }))).toBe(
      'idempotency_conflict'
    )
  })

  it('applies a duplicated concurrent delivery exactly once', async () => {
    await startRoute()
    const input = {
      commandId: 'cmd-race-0001',
      kind: 'deliver',
      stopId: 's-1',
      occurredAt: T,
      pod: { method: 'neighbour', receivedBy: 'Vecina Maria' }
    }
    const results = await Promise.allSettled([
      applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY, input, now: NOW }),
      applyDeliveryEvent(w.db, { identityId: DRIVER_IDENTITY, input, now: NOW })
    ])
    const values = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applyDeliveryEvent>>> => r.status === 'fulfilled'
      )
      .map((r) => r.value.outcome)
    expect(values).toContain('applied')
    expect(count('delivery_pods')).toBe(1)
    expect(count('delivery_stop_events')).toBe(2)
  })

  it('serialises different drivers: each can only write its own route', async () => {
    await startRoute('r-1')
    await startRoute('r-2', DRIVER_IDENTITY_2)
    expect(await fails(deliver('s-x'))).toBe('forbidden')
    expect(
      (await deliver('s-x', { method: 'neighbour', receivedBy: 'Vecino Pepe' }, DRIVER_IDENTITY_2)).routeStatus
    ).toBe('completed')
    expect(stop('s-1').status).toBe('pending')
  })

  it('authorises live inside the write: off-duty or disabled drivers cannot change anything', async () => {
    await startRoute()
    w.sqlite.exec(`UPDATE delivery_drivers SET status = 'off_duty' WHERE id = 'd-1'`)
    expect(await fails(deliver('s-1'))).toBe('forbidden')
    expect(stop('s-1').status).toBe('pending')
    w.sqlite.exec(
      `UPDATE delivery_drivers SET status = 'active' WHERE id = 'd-1'; UPDATE identities SET status = 'locked' WHERE id = '${DRIVER_IDENTITY}'`
    )
    expect(await fails(deliver('s-1'))).toBe('forbidden')
    expect(count('delivery_pods')).toBe(0)
  })

  it('keeps events, pods and incidents append-only', async () => {
    await startRoute()
    await deliver('s-1')
    await apply({ kind: 'incident', stopId: 's-2', category: 'other', note: 'Aviso' })
    for (const table of ['delivery_stop_events', 'delivery_pods', 'delivery_incidents']) {
      expect(() => w.sqlite.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
    }
    expect(() => w.sqlite.exec(`UPDATE delivery_pods SET received_by = 'Otro'`)).toThrow(/immutable/)
    expect(() => w.sqlite.exec(`UPDATE delivery_stop_events SET kind = 'start'`)).toThrow(/immutable/)
  })
})

describe('SHP-027 offline sync', () => {
  const batch = (events: Array<Record<string, unknown>>, identityId = DRIVER_IDENTITY) =>
    syncDeliveryEvents(w.db, {
      identityId,
      input: { events: events.map((e) => ({ commandId: cid(), occurredAt: T, ...e })) },
      now: NOW
    })

  it('applies a queued sequence in order and reports per-event outcomes', async () => {
    const r = await batch([
      { kind: 'start_route', routeId: 'r-1' },
      { kind: 'start', stopId: 's-1' },
      { kind: 'deliver', stopId: 's-1', pod: { method: 'neighbour', receivedBy: 'Vecina Maria' } },
      { kind: 'fail', stopId: 's-2', reason: 'customer_absent' },
      { kind: 'incident', stopId: 's-3', category: 'access_blocked', note: 'Obras' }
    ])
    expect(r.results.map((x) => x.outcome)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied'])
    expect(stop('s-1').status).toBe('delivered')
    expect(stop('s-2').status).toBe('failed')
  })

  it('rejects the impossible ones permanently, keeps going, and replays an interrupted resend', async () => {
    const first = [
      { commandId: 'cmd-sync-0001', kind: 'start_route', routeId: 'r-1' },
      {
        commandId: 'cmd-sync-0002',
        kind: 'deliver',
        stopId: 's-x',
        pod: { method: 'neighbour', receivedBy: 'Vecino Pepe' }
      },
      { commandId: 'cmd-sync-0003', kind: 'start', stopId: 's-1' }
    ]
    const a = await batch(first)
    expect(a.results.map((x) => x.outcome)).toEqual(['applied', 'rejected', 'applied'])
    expect(a.results[1]!.error).toEqual({ code: 'forbidden' })
    const b = await batch(first)
    expect(b.results.map((x) => x.outcome)).toEqual(['replayed', 'rejected', 'replayed'])
    expect(route('r-1').version).toBe(2)
  })

  it('bounds the batch and refuses malformed or non-driver callers', async () => {
    expect(
      await fails(syncDeliveryEvents(w.db, { identityId: DRIVER_IDENTITY, input: { events: [] }, now: NOW }))
    ).toBe('invalid_input')
    expect(
      await fails(
        syncDeliveryEvents(w.db, {
          identityId: DRIVER_IDENTITY,
          input: { events: Array.from({ length: 51 }, () => ({})) },
          now: NOW
        })
      )
    ).toBe('invalid_input')
    expect(
      await fails(syncDeliveryEvents(w.db, { identityId: DRIVER_IDENTITY, input: { events: [{ nope: 1 }] }, now: NOW }))
    ).toBe('invalid_input')
    expect(
      await fails(
        syncDeliveryEvents(w.db, {
          identityId: OTHER,
          input: { events: [{ commandId: 'cmd-sync-9999', kind: 'start', stopId: 's-1', occurredAt: T }] },
          now: NOW
        })
      )
    ).toBe('forbidden')
  })
})

describe('SHP-027 admin report and evidence', () => {
  it('lets admins read events, incidents, pod metadata and the evidence bytes; drivers cannot', async () => {
    await startRoute()
    await deliver('s-1')
    await apply({ kind: 'incident', stopId: 's-2', category: 'wrong_address', note: 'Numero inexistente' })
    const report = await getRouteReport(w.db, ADMIN, 'r-1')
    expect(report.events.map((e) => e.kind)).toEqual(['start_route', 'deliver', 'incident'])
    expect(report.incidents).toHaveLength(1)
    expect(report.pods[0]).toMatchObject({ stopId: 's-1', method: 'signature', receivedBy: 'Ana', hasEvidence: true })
    expect(JSON.stringify(report)).not.toContain(PNG)
    const evidence = await getDeliveryEvidence(w.db, ADMIN, 's-1')
    expect(evidence.mime).toBe('image/png')
    expect(Buffer.from(evidence.bytes).toString('base64')).toBe(PNG)
    expect(await fails(getRouteReport(w.db, DRIVER_IDENTITY, 'r-1'))).toBe('forbidden')
    expect(await fails(getDeliveryEvidence(w.db, DRIVER_IDENTITY, 's-1'))).toBe('forbidden')
    expect(await fails(getRouteReport(w.db, ADMIN, 'nope'))).toBe('not_found')
    expect(await fails(getDeliveryEvidence(w.db, ADMIN, 's-2'))).toBe('not_found')
    w.sqlite.exec(
      `DROP TRIGGER delivery_pods_no_update; UPDATE delivery_pods SET evidence_base64 = '${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString('base64')}'`
    )
    expect(await fails(getDeliveryEvidence(w.db, ADMIN, 's-1'))).toBe('internal')
  })
})
