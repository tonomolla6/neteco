import { z } from 'zod'

/** SHP-027 delivery driver app contracts shared by the Worker, the PWA and the offline queue. */
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
const commandId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
const id = z.string().min(1).max(36)

export const incidentCategorySchema = z.enum([
  'customer_absent',
  'wrong_address',
  'access_blocked',
  'damaged_parcel',
  'refused',
  'vehicle_issue',
  'other'
])
export type IncidentCategory = z.infer<typeof incidentCategorySchema>

export const failureReasonSchema = z.enum([
  'customer_absent',
  'wrong_address',
  'access_blocked',
  'refused',
  'damaged_parcel',
  'other'
])

export const podSchema = z
  .object({
    method: z.enum(['signature', 'photo', 'neighbour']),
    receivedBy: z.string().trim().min(2).max(100),
    evidence: z
      .object({
        mime: z.enum(['image/png', 'image/jpeg']),
        base64: z
          .string()
          .min(4)
          .max(200000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      })
      .strict()
      .optional(),
    location: z
      .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
      .strict()
      .optional()
  })
  .strict()
export type PodInput = z.infer<typeof podSchema>

export const deliveryEventInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start_route'), commandId, routeId: id, occurredAt: instant }).strict(),
  z.object({ kind: z.literal('start'), commandId, stopId: id, occurredAt: instant }).strict(),
  z.object({ kind: z.literal('deliver'), commandId, stopId: id, occurredAt: instant, pod: podSchema }).strict(),
  z
    .object({
      kind: z.literal('fail'),
      commandId,
      stopId: id,
      occurredAt: instant,
      reason: failureReasonSchema,
      note: z.string().trim().max(300).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('incident'),
      commandId,
      stopId: id,
      occurredAt: instant,
      category: incidentCategorySchema,
      note: z.string().trim().max(500)
    })
    .strict()
])
export type DeliveryEventInput = z.infer<typeof deliveryEventInputSchema>

export const syncRequestSchema = z.object({ events: z.array(deliveryEventInputSchema).min(1).max(50) }).strict()

export const eventResultSchema = z.object({
  commandId: z.string(),
  outcome: z.enum(['applied', 'replayed', 'rejected', 'retry']),
  error: z.object({ code: z.string() }).optional()
})
export type DeliveryEventResult = z.infer<typeof eventResultSchema>

export const driverStopSchema = z.object({
  id,
  sequenceIndex: z.number().int(),
  recipientName: z.string(),
  streetAddress: z.string(),
  postalCode: z.string(),
  city: z.string(),
  parcelCount: z.number().int(),
  weightGrams: z.number().int(),
  timeWindowStart: z.string().nullable(),
  timeWindowEnd: z.string().nullable(),
  status: z.enum(['pending', 'in_progress', 'delivered', 'failed']),
  failureReason: z.string().nullable(),
  completedAt: z.string().nullable(),
  incidentCount: z.number().int(),
  pod: z.object({ method: z.string(), receivedBy: z.string(), capturedAt: z.string() }).nullable()
})
export const driverRouteSchema = z.object({
  id,
  routeDate: z.string(),
  status: z.enum(['draft', 'planned', 'in_progress', 'completed', 'cancelled']),
  version: z.number().int(),
  windowStart: z.string(),
  windowEnd: z.string(),
  vehicleName: z.string().nullable(),
  totalStops: z.number().int(),
  totalParcels: z.number().int(),
  stops: z.array(driverStopSchema)
})
export const driverManifestSchema = z.object({
  serverTime: instant,
  routeDate: z.string(),
  routes: z.array(driverRouteSchema)
})
export type DriverStopView = z.infer<typeof driverStopSchema>
export type DriverRouteView = z.infer<typeof driverRouteSchema>
export type DriverManifest = z.infer<typeof driverManifestSchema>

/** Deep link to the driver's own maps app; the address is a single encoded parameter, nothing is fetched. */
export function buildNavigationUrl(stop: { streetAddress: string; postalCode: string; city: string }): string {
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  url.searchParams.set('travelmode', 'driving')
  url.searchParams.set('destination', `${stop.streetAddress}, ${stop.postalCode} ${stop.city}`)
  return url.toString()
}
