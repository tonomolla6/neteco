import { z } from 'zod'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'

export const orderCancellationAudienceSchema = z.enum(['customer', 'admin'])
export const orderCancellationInputSchema = z
  .object({
    expectedStatus: z.literal('awaiting_payment'),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .refine((value) =>
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      )
  })
  .strict()
export const orderCancellationEligibilitySchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: z.string().uuid(),
    eligible: z.boolean(),
    blocker: z
      .enum([
        'order_not_awaiting_payment',
        'payment_history',
        'preparation_history',
        'fiscal_history',
        'reservation_unavailable'
      ])
      .nullable(),
    orderStatus: z.enum(['awaiting_payment', 'cancelled']),
    paymentStatus: z
      .enum(['awaiting_payment', 'processing', 'paid', 'failed', 'cancelled', 'provider_authorised', 'stock_exception'])
      .nullable(),
    reservationStatus: z.enum(['reserved', 'assigned', 'released', 'expired']).nullable()
  })
  .strict()
  .refine((value) => value.eligible === (value.blocker === null))
export const orderCancellationReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: z.string().uuid(),
    commandId: z.string().uuid(),
    outcome: z.literal('cancelled'),
    orderStatus: z.literal('cancelled'),
    inventoryEffect: z.enum(['released', 'already_released', 'expired']),
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()
export const orderCancellationCommandSchema = z.union([
  orderCancellationReceiptSchema,
  z
    .object({
      source: z.literal('cloudflare'),
      orderId: z.string().uuid(),
      commandId: z.string().uuid(),
      outcome: z.literal('unknown')
    })
    .strict()
])
export type OrderCancellationInput = z.infer<typeof orderCancellationInputSchema>
export type OrderCancellationReceipt = z.infer<typeof orderCancellationReceiptSchema>
export type OrderCancellationEligibility = z.infer<typeof orderCancellationEligibilitySchema>
export type OrderCancellationCommand = z.infer<typeof orderCancellationCommandSchema>
export type OrderCancellationAudience = z.infer<typeof orderCancellationAudienceSchema>
