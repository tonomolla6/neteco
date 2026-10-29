import { z } from 'zod'
import {
  deliveryEventInputSchema,
  driverManifestSchema,
  type DeliveryEventInput,
  type DeliveryEventResult,
  type DriverManifest
} from './delivery-driver-app'

/**
 * Pure offline queue for the delivery PWA. Nothing here touches storage or the network: the page
 * persists `serializeQueue(state)` and restores it with `parseQueueSnapshot`, which never trusts it.
 */
export const MAX_QUEUED_EVENTS = 200
export const QUEUE_VERSION = 1

export interface QueuedEvent {
  commandId: string
  payload: DeliveryEventInput
  queuedAt: string
  attempts: number
}
export interface OfflineQueueState {
  version: 1
  events: QueuedEvent[]
}

const snapshotSchema = z.object({
  version: z.literal(QUEUE_VERSION),
  events: z.array(z.unknown()).max(MAX_QUEUED_EVENTS * 2)
})
const queuedEventSchema = z.object({
  commandId: z.string(),
  payload: deliveryEventInputSchema,
  queuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  attempts: z.number().int().min(0).max(1000)
})

export const emptyQueue = (): OfflineQueueState => ({ version: QUEUE_VERSION, events: [] })

export function enqueueEvent(
  state: OfflineQueueState,
  event: DeliveryEventInput,
  nowIso: string
): { state: OfflineQueueState; accepted: boolean; reason?: 'duplicate' | 'queue_full' | 'invalid' } {
  const parsed = deliveryEventInputSchema.safeParse(event)
  if (!parsed.success) return { state, accepted: false, reason: 'invalid' }
  if (state.events.some((e) => e.commandId === parsed.data.commandId))
    return { state, accepted: false, reason: 'duplicate' }
  if (state.events.length >= MAX_QUEUED_EVENTS) return { state, accepted: false, reason: 'queue_full' }
  return {
    state: {
      version: QUEUE_VERSION,
      events: [
        ...state.events,
        { commandId: parsed.data.commandId, payload: parsed.data, queuedAt: nowIso, attempts: 0 }
      ]
    },
    accepted: true
  }
}

/** Oldest-first batch bounded by count and serialized size; a first oversized event still goes alone. */
export function takeBatch(
  state: OfflineQueueState,
  limits: { maxEvents: number; maxBytes: number }
): DeliveryEventInput[] {
  const batch: DeliveryEventInput[] = []
  let bytes = 0
  for (const item of state.events) {
    if (batch.length >= limits.maxEvents) break
    const size = JSON.stringify(item.payload).length
    if (batch.length > 0 && bytes + size > limits.maxBytes) break
    batch.push(item.payload)
    bytes += size
  }
  return batch
}

export function applySyncResults(
  state: OfflineQueueState,
  results: readonly DeliveryEventResult[]
): { state: OfflineQueueState; rejected: Array<{ commandId: string; code: string }> } {
  const byId = new Map(results.map((r) => [r.commandId, r]))
  const rejected: Array<{ commandId: string; code: string }> = []
  const events: QueuedEvent[] = []
  for (const item of state.events) {
    const result = byId.get(item.commandId)
    if (!result) {
      events.push(item)
    } else if (result.outcome === 'applied' || result.outcome === 'replayed') {
      continue
    } else if (result.outcome === 'rejected') {
      rejected.push({ commandId: item.commandId, code: result.error?.code ?? 'rejected' })
    } else {
      events.push({ ...item, attempts: item.attempts + 1 })
    }
  }
  return { state: { version: QUEUE_VERSION, events }, rejected }
}

export function serializeQueue(state: OfflineQueueState): string {
  return JSON.stringify(state)
}

/** Never throws: anything malformed, tampered with or older than `ttlMs` is dropped. */
export function parseQueueSnapshot(raw: unknown, nowIso: string, ttlMs: number): OfflineQueueState {
  const snapshot = snapshotSchema.safeParse(raw)
  if (!snapshot.success) return emptyQueue()
  const now = Date.parse(nowIso)
  const seen = new Set<string>()
  const events: QueuedEvent[] = []
  for (const candidate of snapshot.data.events) {
    const item = queuedEventSchema.safeParse(candidate)
    if (!item.success) continue
    if (item.data.commandId !== item.data.payload.commandId || seen.has(item.data.commandId)) continue
    if (now - Date.parse(item.data.queuedAt) > ttlMs) continue
    seen.add(item.data.commandId)
    events.push(item.data)
    if (events.length >= MAX_QUEUED_EVENTS) break
  }
  return { version: QUEUE_VERSION, events }
}

export function parseManifestCache(raw: unknown, nowIso: string, ttlMs: number): DriverManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const { savedAt, manifest } = raw as { savedAt?: unknown; manifest?: unknown }
  const saved = typeof savedAt === 'string' ? Date.parse(savedAt) : Number.NaN
  if (!Number.isFinite(saved) || Date.parse(nowIso) - saved > ttlMs || saved - Date.parse(nowIso) > 60_000) return null
  const parsed = driverManifestSchema.safeParse(manifest)
  return parsed.success ? parsed.data : null
}

/**
 * Optimistic mirror of the server state machine so the driver sees progress while offline.
 * The server stays authoritative: the next manifest fetch replaces this projection.
 */
export function applyEventToManifest(manifest: DriverManifest, event: DeliveryEventInput): DriverManifest {
  const routes = manifest.routes.map((route) => {
    if (event.kind === 'start_route') {
      return event.routeId === route.id && route.status === 'planned'
        ? { ...route, status: 'in_progress' as const, version: route.version + 1 }
        : route
    }
    const target = route.stops.find((s) => s.id === event.stopId)
    if (!target) return route
    let stop = target
    let changed = false
    if (event.kind === 'incident') {
      if (['planned', 'in_progress', 'completed'].includes(route.status)) {
        stop = { ...target, incidentCount: target.incidentCount + 1 }
        changed = true
      }
    } else if (route.status === 'in_progress') {
      if (event.kind === 'start' && target.status === 'pending') {
        stop = { ...target, status: 'in_progress' }
        changed = true
      } else if (event.kind === 'deliver' && target.status !== 'delivered') {
        stop = {
          ...target,
          status: 'delivered',
          failureReason: null,
          completedAt: event.occurredAt,
          pod: { method: event.pod.method, receivedBy: event.pod.receivedBy, capturedAt: event.occurredAt }
        }
        changed = true
      } else if (event.kind === 'fail' && (target.status === 'pending' || target.status === 'in_progress')) {
        stop = { ...target, status: 'failed', failureReason: event.reason, completedAt: event.occurredAt }
        changed = true
      }
    }
    if (!changed) return route
    const stops = route.stops.map((s) => (s.id === stop.id ? stop : s))
    const finished = stops.every((s) => s.status === 'delivered' || s.status === 'failed')
    const bumps = event.kind === 'deliver' || event.kind === 'fail'
    return {
      ...route,
      stops,
      version: bumps ? route.version + 1 : route.version,
      status: bumps && finished && route.status === 'in_progress' ? ('completed' as const) : route.status
    }
  })
  return { ...manifest, routes }
}
