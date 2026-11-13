import { z } from 'zod'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import type { OrderDetailLines } from '../composables/useAccount'
import { orderReorderOfferSchema } from '~~/shared/order-reorder'
import { MAX_CART_QUANTITY } from '~~/shared/cart-limits'
import { splitGross, validateQuantity } from '../../server/domain/money'

const text = z.string()
const nullableText = text.nullable()
const amount = z.number().finite().nonnegative()
const instant = z.string().datetime({ offset: true })
const lineSchema = z
  .object({
    sku: text,
    name: text,
    format: text,
    quantity: z.number().int().positive().safe(),
    unitGross: amount,
    lineGross: amount,
    variantId: z.number().int().positive().safe().nullable(),
    slug: nullableText,
    image: nullableText,
    imageAlt: nullableText.optional(),
    visual: z.object({ type: text, color: text }).strict().nullable(),
    available: z.boolean(),
    reason: nullableText,
    reorderOffer: orderReorderOfferSchema.nullable().optional()
  })
  .strict()
  .refine((line) => !line.available || line.variantId !== null)
  .refine((line) => {
    const offer = line.reorderOffer
    if (!offer) return true
    let quantityAllowed = line.quantity <= MAX_CART_QUANTITY
    try {
      validateQuantity(line.quantity, offer)
    } catch {
      quantityAllowed = false
    }
    return (
      offer.lineGross === offer.unitGross * line.quantity &&
      offer.unitNet === splitGross(offer.unitGross, offer.taxRateBasisPoints).netCents &&
      offer.lineNet === splitGross(offer.lineGross, offer.taxRateBasisPoints).netCents &&
      offer.quantityAllowed === quantityAllowed &&
      (offer.backorderAllowed || offer.stockSufficient === offer.availableQuantity >= line.quantity) &&
      offer.purchasable === (offer.quantityAllowed && offer.stockSufficient)
    )
  })
const schema = z
  .object({
    orderId: text.min(1),
    orderedAt: instant,
    shippingMethod: text,
    paymentMethod: nullableText,
    fulfillmentStatus: nullableText,
    destination: z.object({ line1: nullableText, postalCode: nullableText, city: text }).strict().nullable(),
    totals: z.object({ subtotalNet: amount, shippingNet: amount, tax: amount, total: amount }).strict(),
    shipment: z
      .object({ status: text, trackingNumber: nullableText, provider: text, updatedAt: instant })
      .strict()
      .nullable(),
    shipmentPlan: z
      .object({
        mode: z.enum(['together', 'split']),
        shipments: z
          .array(
            z
              .object({
                index: z.number().int().nonnegative(),
                leadDays: z.number().int().nonnegative(),
                from: nullableText,
                to: nullableText,
                shippingGross: amount,
                lines: z.array(z.object({ sku: text, quantity: z.number().int().positive().safe() }).strict()).max(1000)
              })
              .strict()
          )
          .min(1)
          .max(10)
      })
      .strict()
      .nullable()
      .optional(),
    lines: z.array(lineSchema).max(1000)
  })
  .strict()

/** Validate and copy both Node and D1 order snapshots, never treating their
 * historical prices or current availability decoration as mutation authority. */
export function readOrderDetail(value: unknown, expectedOrderId: string): OrderDetailLines | null {
  try {
    const result = schema.safeParse(catalogPolicyOwnJson(value))
    return result.success && result.data.orderId === expectedOrderId ? result.data : null
  } catch {
    return null
  }
}
