import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'
import { fulfillmentStateSchema } from './order-fulfillment'

const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value === value.trim() &&
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    )
export const orderTrackingAudienceSchema = z.enum(['customer', 'admin', 'guest'])
export const orderTrackingSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: uuid,
    audience: orderTrackingAudienceSchema,
    shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']).nullable(),
    fulfillment: z.object({ state: fulfillmentStateSchema, version: safe, updatedAt: instant.nullable() }).strict(),
    packing: z.object({ parcelCount: safe.max(20), recordedAt: instant.nullable() }).strict(),
    shipments: z
      .array(
        z
          .object({
            parcelIndex: safe.max(19),
            carrier: text(100),
            trackingNumber: text(120),
            recordedAt: instant,
            verification: z.literal('manual_unverified')
          })
          .strict()
      )
      .max(20),
    carrierEvents: z.tuple([]),
    carrierStatus: z.literal('not_connected'),
    fallback: z.object({ kind: z.literal('contact_neteco'), contactPath: z.literal('/contacto') }).strict(),
    evaluatedAt: instant
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.fulfillment.version === 0) !== (value.fulfillment.updatedAt === null) ||
      (value.fulfillment.version === 0 && value.fulfillment.state !== 'pending') ||
      (value.packing.parcelCount === 0) !== (value.packing.recordedAt === null) ||
      (value.shipments.length > 0 &&
        (value.shippingMethod !== 'parcel' || value.shipments.length !== value.packing.parcelCount)) ||
      new Set(value.shipments.map((item) => item.parcelIndex)).size !== value.shipments.length ||
      value.shipments.some(
        (item) => item.parcelIndex >= value.packing.parcelCount || item.recordedAt > value.evaluatedAt
      ) ||
      [value.fulfillment.updatedAt, value.packing.recordedAt].some((time) => time !== null && time > value.evaluatedAt)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed operational tracking projection' })
  })
export type OrderTracking = z.infer<typeof orderTrackingSchema>
export type OrderTrackingAudience = z.infer<typeof orderTrackingAudienceSchema>
