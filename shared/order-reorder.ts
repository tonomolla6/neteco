import { z } from 'zod'

const amount = z.number().int().nonnegative().safe()
const quantity = z.number().int().positive().safe()

/** Observation for the original line quantity, never a reservation or a quote. */
export const orderReorderOfferSchema = z
  .object({
    evaluatedAt: z.string().datetime({ offset: false }),
    unitGross: amount.positive(),
    lineGross: amount.positive(),
    unitNet: amount,
    lineNet: amount,
    taxRateBasisPoints: z.number().int().min(0).max(10000),
    pricingVersion: z.string().min(1),
    minimumQuantity: quantity,
    maximumQuantity: quantity.nullable(),
    quantityIncrement: quantity,
    /** Maximum sellable stock at one active location, not a cross-location sum. */
    availableQuantity: amount,
    backorderAllowed: z.boolean(),
    quantityAllowed: z.boolean(),
    stockSufficient: z.boolean(),
    purchasable: z.boolean()
  })
  .strict()

export type OrderReorderOffer = z.infer<typeof orderReorderOfferSchema>
