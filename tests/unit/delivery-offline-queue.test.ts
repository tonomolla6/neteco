import { describe, expect, it } from 'vitest'
import {
  MAX_QUEUED_EVENTS,
  applyEventToManifest,
  applySyncResults,
  emptyQueue,
  enqueueEvent,
  parseManifestCache,
  parseQueueSnapshot,
  takeBatch
} from '../../shared/delivery-offline-queue'
import { buildNavigationUrl, deliveryEventInputSchema } from '../../shared/delivery-driver-app'

const NOW = '2026-10-29T10:00:00Z'
const incident = (n: number) => ({
  commandId: `cmd-${String(n).padStart(6, '0')}`,
  kind: 'incident' as const,
  stopId: 's-1',
  occurredAt: NOW,
  category: 'customer_absent' as const,
  note: 'Nadie en casa'
})
const png = 'iVBORw0KGgo='

describe('SHP-027 shared delivery contracts', () => {
  it('accepts well-formed events and rejects malformed, extra and oversized ones', () => {
    expect(deliveryEventInputSchema.safeParse(incident(1)).success).toBe(true)
    expect(deliveryEventInputSchema.safeParse({ ...incident(1), extra: 1 }).success).toBe(false)
    expect(deliveryEventInputSchema.safeParse({ ...incident(1), category: 'nope' }).success).toBe(false)
    expect(deliveryEventInputSchema.safeParse({ ...incident(1), note: 'x'.repeat(501) }).success).toBe(false)
    expect(deliveryEventInputSchema.safeParse({ ...incident(1), occurredAt: '2026-10-29' }).success).toBe(false)
    expect(deliveryEventInputSchema.safeParse({ ...incident(1), commandId: 'short' }).success).toBe(false)
    const deliver = {
      commandId: 'cmd-deliver-1',
      kind: 'deliver',
      stopId: 's-1',
      occurredAt: NOW,
      pod: { method: 'signature', receivedBy: 'Ana', evidence: { mime: 'image/png', base64: png } }
    }
    expect(deliveryEventInputSchema.safeParse(deliver).success).toBe(true)
    expect(deliveryEventInputSchema.safeParse({ ...deliver, pod: { ...deliver.pod, method: 'pin' } }).success).toBe(
      false
    )
    expect(
      deliveryEventInputSchema.safeParse({
        ...deliver,
        pod: { ...deliver.pod, location: { latitude: 91, longitude: 0 } }
      }).success
    ).toBe(false)
    expect(
      deliveryEventInputSchema.safeParse({
        ...deliver,
        pod: { ...deliver.pod, evidence: { mime: 'image/gif', base64: png } }
      }).success
    ).toBe(false)
    expect(
      deliveryEventInputSchema.safeParse({
        ...deliver,
        pod: { ...deliver.pod, evidence: { mime: 'image/png', base64: '***' } }
      }).success
    ).toBe(false)
  })

  it('builds a navigation URL that encodes the address and never injects parameters', () => {
    const url = new URL(
      buildNavigationUrl({ streetAddress: 'Calle Mayor 1 & 2, #3', postalCode: '46870', city: 'Ontinyent' })
    )
    expect(url.origin).toBe('https://www.google.com')
    expect(url.pathname).toBe('/maps/dir/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('travelmode')).toBe('driving')
    expect(url.searchParams.get('destination')).toBe('Calle Mayor 1 & 2, #3, 46870 Ontinyent')
    expect([...url.searchParams.keys()].sort()).toEqual(['api', 'destination', 'travelmode'])
  })
})

describe('SHP-027 offline queue', () => {
  it('enqueues in order, ignores duplicate command ids and caps the size', () => {
    let q = emptyQueue()
    let r = enqueueEvent(q, incident(1), NOW)
    q = r.state
    expect(r.accepted).toBe(true)
    r = enqueueEvent(q, incident(1), NOW)
    expect(r.accepted).toBe(false)
    expect(r.reason).toBe('duplicate')
    expect(r.state.events).toHaveLength(1)
    q = r.state
    for (let i = 2; q.events.length < MAX_QUEUED_EVENTS; i += 1) q = enqueueEvent(q, incident(i), NOW).state
    const full = enqueueEvent(q, incident(9999), NOW)
    expect(full.accepted).toBe(false)
    expect(full.reason).toBe('queue_full')
    expect(full.state.events).toHaveLength(MAX_QUEUED_EVENTS)
  })

  it('does not mutate the previous state', () => {
    const q = emptyQueue()
    enqueueEvent(q, incident(1), NOW)
    expect(q.events).toHaveLength(0)
  })

  it('takes bounded batches by count and by bytes, always making progress', () => {
    let q = emptyQueue()
    for (let i = 1; i <= 60; i += 1) q = enqueueEvent(q, incident(i), NOW).state
    expect(takeBatch(q, { maxEvents: 50, maxBytes: 1_000_000 })).toHaveLength(50)
    expect(takeBatch(q, { maxEvents: 50, maxBytes: 1 })).toHaveLength(1)
    expect(takeBatch(emptyQueue(), { maxEvents: 50, maxBytes: 100 })).toEqual([])
    expect(takeBatch(q, { maxEvents: 3, maxBytes: 1_000_000 }).map((e) => e.commandId)).toEqual([
      'cmd-000001',
      'cmd-000002',
      'cmd-000003'
    ])
  })

  it('drops applied, replayed and permanently rejected events, keeps transient ones', () => {
    let q = emptyQueue()
    for (let i = 1; i <= 4; i += 1) q = enqueueEvent(q, incident(i), NOW).state
    const next = applySyncResults(q, [
      { commandId: 'cmd-000001', outcome: 'applied' },
      { commandId: 'cmd-000002', outcome: 'replayed' },
      { commandId: 'cmd-000003', outcome: 'rejected', error: { code: 'invalid_transition' } },
      { commandId: 'cmd-000004', outcome: 'retry' },
      { commandId: 'cmd-unknown', outcome: 'applied' }
    ])
    expect(next.state.events.map((e) => e.commandId)).toEqual(['cmd-000004'])
    expect(next.state.events[0]!.attempts).toBe(1)
    expect(next.rejected).toEqual([{ commandId: 'cmd-000003', code: 'invalid_transition' }])
  })

  it('restores a snapshot defensively: invalid JSON, tampered entries and expired entries never throw', () => {
    let q = emptyQueue()
    q = enqueueEvent(q, incident(1), '2026-10-29T09:00:00Z').state
    q = enqueueEvent(q, incident(2), '2026-10-20T09:00:00Z').state
    const raw = JSON.parse(JSON.stringify(q))
    raw.events.push({ commandId: 'cmd-evil-001', kind: 'deliver', payload: { nope: true }, queuedAt: NOW, attempts: 0 })
    const restored = parseQueueSnapshot(raw, NOW, 3 * 24 * 3600 * 1000)
    expect(restored.events.map((e) => e.commandId)).toEqual(['cmd-000001'])
    for (const junk of [null, undefined, 5, 'x', [], { version: 2, events: [] }, { version: 1, events: 'x' }])
      expect(parseQueueSnapshot(junk, NOW, 1000)).toEqual(emptyQueue())
  })

  it('expires the cached manifest and refuses malformed caches', () => {
    const manifest = { routes: [], routeDate: '2026-10-29', serverTime: NOW }
    expect(parseManifestCache({ savedAt: '2026-10-29T08:00:00Z', manifest }, NOW, 12 * 3600 * 1000)).toEqual(manifest)
    expect(parseManifestCache({ savedAt: '2026-10-28T08:00:00Z', manifest }, NOW, 12 * 3600 * 1000)).toBeNull()
    expect(parseManifestCache({ savedAt: 'bad', manifest }, NOW, 1000)).toBeNull()
    expect(parseManifestCache({ savedAt: NOW, manifest: { routes: 'x' } }, NOW, 1000)).toBeNull()
    expect(parseManifestCache(null, NOW, 1000)).toBeNull()
  })
})

describe('SHP-027 optimistic local application', () => {
  const stop = (id: string, status: 'pending' | 'in_progress' | 'delivered' | 'failed' = 'pending') => ({
    id,
    sequenceIndex: 0,
    recipientName: 'A',
    streetAddress: 'C 1',
    postalCode: '46870',
    city: 'Ontinyent',
    parcelCount: 1,
    weightGrams: 1,
    timeWindowStart: null,
    timeWindowEnd: null,
    status,
    failureReason: null,
    completedAt: null,
    incidentCount: 0,
    pod: null
  })
  const manifest = () => ({
    serverTime: NOW,
    routeDate: '2026-10-29',
    routes: [
      {
        id: 'r-1',
        routeDate: '2026-10-29',
        status: 'planned' as const,
        version: 1,
        windowStart: '08:00',
        windowEnd: '16:00',
        vehicleName: null,
        totalStops: 2,
        totalParcels: 2,
        stops: [stop('s-1'), stop('s-2')]
      }
    ]
  })
  const ev = (extra: Record<string, unknown>) => ({ commandId: 'cmd-local-001', occurredAt: NOW, ...extra }) as never

  it('mirrors the server state machine without mutating the input', () => {
    const base = manifest()
    const started = applyEventToManifest(base, ev({ kind: 'start_route', routeId: 'r-1' }))
    expect(started.routes[0]!.status).toBe('in_progress')
    expect(base.routes[0]!.status).toBe('planned')
    const delivered = applyEventToManifest(
      started,
      ev({ kind: 'deliver', stopId: 's-1', pod: { method: 'neighbour', receivedBy: 'Vecino Pepe' } })
    )
    expect(delivered.routes[0]!.stops[0]).toMatchObject({
      status: 'delivered',
      completedAt: NOW,
      pod: { method: 'neighbour', receivedBy: 'Vecino Pepe' }
    })
    expect(delivered.routes[0]!.status).toBe('in_progress')
    const failed = applyEventToManifest(delivered, ev({ kind: 'fail', stopId: 's-2', reason: 'refused' }))
    expect(failed.routes[0]!.status).toBe('completed')
    expect(failed.routes[0]!.stops[1]).toMatchObject({ status: 'failed', failureReason: 'refused' })
  })

  it('counts incidents, starts stops and ignores impossible or unknown events', () => {
    const base = applyEventToManifest(manifest(), ev({ kind: 'start_route', routeId: 'r-1' }))
    const withIncident = applyEventToManifest(
      base,
      ev({ kind: 'incident', stopId: 's-1', category: 'other', note: 'x' })
    )
    expect(withIncident.routes[0]!.stops[0]!.incidentCount).toBe(1)
    expect(applyEventToManifest(base, ev({ kind: 'start', stopId: 's-1' })).routes[0]!.stops[0]!.status).toBe(
      'in_progress'
    )
    expect(applyEventToManifest(manifest(), ev({ kind: 'start', stopId: 's-1' }))).toEqual(manifest())
    expect(applyEventToManifest(base, ev({ kind: 'start', stopId: 'nope' }))).toEqual(base)
    const done = applyEventToManifest(
      base,
      ev({ kind: 'deliver', stopId: 's-1', pod: { method: 'neighbour', receivedBy: 'Vecino Pepe' } })
    )
    expect(
      applyEventToManifest(
        done,
        ev({ kind: 'deliver', stopId: 's-1', pod: { method: 'neighbour', receivedBy: 'Otro' } })
      )
    ).toEqual(done)
  })
})
