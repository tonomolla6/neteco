import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'
import { fulfillmentBlockerSchema, fulfillmentStateSchema } from './order-fulfillment'

const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value === value.trim() && [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    )
export const packingActionSchema = z.enum(['pack', 'manual_dispatch'])
export type PackingAction = z.infer<typeof packingActionSchema>
export const packingAllocationSchema = z.object({ lineIndex: safe, quantity: safe.min(1) }).strict()
// Input bounds only: these dimensions/weights do not certify carrier eligibility.
export const packingParcelSchema = z
  .object({
    weightGrams: safe.min(1).max(1_000_000),
    widthMm: safe.min(1).max(3000),
    heightMm: safe.min(1).max(3000),
    depthMm: safe.min(1).max(3000),
    contents: z.array(packingAllocationSchema).min(1).max(200)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.contents.map((line) => line.lineIndex)).size !== value.contents.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate line within parcel' })
  })
const parcels = z
  .array(packingParcelSchema)
  .min(1)
  .max(20)
  .superRefine((value, ctx) => {
    if (value.reduce((count, parcel) => count + parcel.contents.length, 0) > 200)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At most 200 allocations' })
  })
export const packingShipmentSchema = z
  .object({
    parcelIndex: safe.max(19),
    carrier: text(1, 100),
    shipmentNumber: text(1, 120),
    trackingNumber: text(1, 120),
    externalLabelReference: text(1, 200).refine(
      (value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
      'An operational reference, not a URL'
    )
  })
  .strict()
const shipments = z
  .array(packingShipmentSchema)
  .min(1)
  .max(20)
  .superRefine((value, ctx) => {
    if (new Set(value.map((item) => item.parcelIndex)).size !== value.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate parcel shipment' })
  })
const common = {
  expectedVersion: safe.max(Number.MAX_SAFE_INTEGER - 1),
  expectedFulfillmentVersion: safe.max(Number.MAX_SAFE_INTEGER - 1),
  reason: text(10, 500)
}
export const orderPackingInputSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('pack'), parcels }).strict(),
  z
    .object({
      ...common,
      action: z.literal('manual_dispatch'),
      shipments,
      actualNetCents: safe.max(1_000_000_000),
      taxBps: safe.max(10000)
    })
    .strict()
])
export type OrderPackingInput = z.infer<typeof orderPackingInputSchema>
export const orderPackingReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    orderId: uuid,
    action: packingActionSchema,
    version: safe.min(1),
    fulfillmentVersion: safe,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    parcelCount: safe.min(1).max(20),
    recordedAt: instant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none'),
    providerEffect: z.literal('none')
  })
  .strict()
export type OrderPackingReceipt = z.infer<typeof orderPackingReceiptSchema>
export const orderPackingCommandResponseSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: orderPackingReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown') }).strict()
])
export type OrderPackingCommandResponse = z.infer<typeof orderPackingCommandResponseSchema>
export const adminOrderPackingSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: uuid,
    version: safe,
    state: z.enum(['unpacked', 'packed', 'manual_dispatch_recorded']),
    fulfillmentVersion: safe,
    fulfillmentState: fulfillmentStateSchema,
    shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']).nullable(),
    lines: z
      .array(z.object({ lineIndex: safe, sku: text(1, 200), name: text(1, 300), quantity: safe.min(1) }).strict())
      .min(1)
      .max(200),
    parcels: z.array(packingParcelSchema).max(20),
    dispatch: z
      .object({
        commandId: uuid,
        packingVersion: safe.min(1),
        shipments,
        actualNetCents: safe.max(1_000_000_000),
        taxBps: safe.max(10000),
        actualTaxCents: safe,
        actualGrossCents: safe,
        quotedGrossCents: safe,
        varianceGrossCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
        recordedAt: instant,
        labelVerification: z.literal('unverified_reference_only')
      })
      .strict()
      .nullable(),
    quotedGrossCents: safe,
    readiness: z.object({ ready: z.boolean(), blockers: z.array(fulfillmentBlockerSchema).max(6) }).strict(),
    capabilities: z.object({ packingWrite: z.boolean(), manualDispatch: z.boolean() }).strict(),
    evaluatedAt: instant
  })
  .strict()
  .superRefine((value, ctx) => {
    const amounts = new Map<number, number>()
    for (const parcel of value.parcels)
      for (const content of parcel.contents)
        amounts.set(content.lineIndex, (amounts.get(content.lineIndex) ?? 0) + content.quantity)
    const packed = value.version > 0
    if (
      value.readiness.ready !== (value.readiness.blockers.length === 0) ||
      new Set(value.lines.map((line) => line.lineIndex)).size !== value.lines.length ||
      (!packed && (value.state !== 'unpacked' || value.parcels.length !== 0 || value.dispatch !== null)) ||
      (packed &&
        (value.parcels.length === 0 ||
          value.lines.some((line) => amounts.get(line.lineIndex) !== line.quantity) ||
          amounts.size !== value.lines.length)) ||
      value.parcels.reduce((n, parcel) => n + parcel.contents.length, 0) > 200 ||
      (value.state === 'manual_dispatch_recorded') !== (value.dispatch !== null) ||
      (!value.readiness.ready && (value.capabilities.packingWrite || value.capabilities.manualDispatch)) ||
      (value.dispatch !== null &&
        (value.capabilities.packingWrite ||
          value.capabilities.manualDispatch ||
          value.dispatch.shipments.length !== value.parcels.length ||
          value.dispatch.shipments.some((shipment) => shipment.parcelIndex >= value.parcels.length) ||
          value.dispatch.actualGrossCents !== value.dispatch.actualNetCents + value.dispatch.actualTaxCents ||
          value.dispatch.varianceGrossCents !== value.dispatch.actualGrossCents - value.dispatch.quotedGrossCents))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incoherent packing projection' })
  })
export type AdminOrderPacking = z.infer<typeof adminOrderPackingSchema>

export async function orderPackingIntentHash(orderId: string, raw: unknown): Promise<string> {
  uuid.parse(orderId)
  const input = orderPackingInputSchema.parse(raw)
  // Stable key order comes from this shared strict schema, for UI and Worker.
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ orderId, input }))
  )
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
