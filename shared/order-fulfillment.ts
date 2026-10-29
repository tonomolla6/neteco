import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { inventoryIdempotencyKeySchema } from './inventory-commands'

export const fulfillmentOrderIdSchema = catalogPolicyUuidSchema
export const fulfillmentIdempotencyKeySchema = inventoryIdempotencyKeySchema
export const fulfillmentActionSchema = z.enum([
  'picking',
  'packed',
  'ready_for_pickup',
  'in_transit',
  'delivered',
  'exception'
])
export const fulfillmentStateSchema = z.enum([
  'pending',
  'picking',
  'packed',
  'ready_for_pickup',
  'in_transit',
  'delivered',
  'exception'
])
export type FulfillmentAction = z.infer<typeof fulfillmentActionSchema>
export type OrderFulfillmentState = z.infer<typeof fulfillmentStateSchema>
export const fulfillmentBlockerSchema = z.enum([
  'order_cancelled',
  'payment_unconfirmed',
  'inventory_unconfirmed',
  'warehouse_unavailable',
  'shipping_mode_unavailable',
  'history_unconfirmed'
])
export type FulfillmentBlocker = z.infer<typeof fulfillmentBlockerSchema>
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value === value.trim() && [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    )
function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const fulfillmentTransitionInputSchema = z.preprocess(
  own,
  z
    .object({
      action: fulfillmentActionSchema,
      expectedVersion: safe.max(Number.MAX_SAFE_INTEGER - 1),
      reason: text(10, 500),
      evidence: text(10, 500).optional()
    })
    .strict()
    .superRefine((value, ctx) => {
      if (['in_transit', 'delivered', 'exception'].includes(value.action) && value.evidence === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Verified operational evidence is required',
          path: ['evidence']
        })
    })
)
export type FulfillmentTransitionInput = z.infer<typeof fulfillmentTransitionInputSchema>
export const fulfillmentCommandReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: fulfillmentActionSchema,
      commandId: catalogPolicyUuidSchema,
      orderId: fulfillmentOrderIdSchema,
      warehouseId: text(1, 200),
      state: fulfillmentStateSchema,
      interruptedState: fulfillmentStateSchema.nullable(),
      version: safe.min(1),
      inventoryEffect: z.literal('none'),
      updated: z.literal(true)
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        value.state !== value.action ||
        (value.state === 'exception'
          ? value.interruptedState === null || ['exception', 'delivered'].includes(value.interruptedState)
          : value.interruptedState !== null)
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid operational transition receipt' })
    })
)
export type FulfillmentCommandReceipt = z.infer<typeof fulfillmentCommandReceiptSchema>
const timelineItem = z
  .object({
    commandId: catalogPolicyUuidSchema,
    actorId: catalogPolicyUuidSchema,
    action: fulfillmentActionSchema,
    fromState: fulfillmentStateSchema,
    toState: fulfillmentStateSchema,
    interruptedState: fulfillmentStateSchema.nullable(),
    version: safe.min(1),
    reason: text(10, 500),
    evidence: text(10, 500).nullable(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export const adminOrderFulfillmentSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      orderId: fulfillmentOrderIdSchema,
      purchaseOrderReference: text(1, 120).nullable().optional(),
      warehouse: z
        .object({ id: text(1, 200), code: text(1, 100), name: text(1, 200) })
        .strict()
        .nullable(),
      shippingMethod: z.enum(['pickup', 'own_delivery', 'parcel']).nullable(),
      state: fulfillmentStateSchema,
      interruptedState: fulfillmentStateSchema.nullable(),
      version: safe,
      readiness: z.object({ ready: z.boolean(), blockers: z.array(fulfillmentBlockerSchema).max(6) }).strict(),
      capabilities: z
        .object({
          fulfillmentRead: z.literal(true),
          fulfillmentTransitions: z.boolean(),
          allowedActions: z.array(fulfillmentActionSchema).max(6)
        })
        .strict(),
      inventoryPolicy: z.literal('allocated_on_payment_no_fulfillment_decrement'),
      timeline: z
        .object({
          items: z.array(timelineItem).max(50),
          pagination: z
            .object({ page: safe.min(1).max(1_000_000), perPage: safe.min(1).max(50), total: safe, pages: safe })
            .strict()
        })
        .strict(),
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
    .superRefine((value, ctx) => {
      const actions = value.capabilities.allowedActions,
        expectedActions = value.shippingMethod
          ? allowedFulfillmentActions(value.state, value.interruptedState, value.shippingMethod)
          : []
      if (
        value.readiness.ready !== (value.readiness.blockers.length === 0) ||
        (!value.readiness.ready && value.capabilities.allowedActions.length > 0) ||
        (!value.capabilities.fulfillmentTransitions && value.capabilities.allowedActions.length > 0) ||
        (value.state === 'exception'
          ? value.interruptedState === null || ['exception', 'delivered'].includes(value.interruptedState)
          : value.interruptedState !== null) ||
        (value.version === 0 && value.state !== 'pending') ||
        (value.capabilities.fulfillmentTransitions &&
          (!value.readiness.ready ||
            value.warehouse === null ||
            value.shippingMethod === null ||
            actions.length !== expectedActions.length ||
            actions.some((action, index) => action !== expectedActions[index]))) ||
        new Set(value.readiness.blockers).size !== value.readiness.blockers.length ||
        value.timeline.pagination.total !== value.version ||
        value.timeline.pagination.pages !== Math.ceil(value.version / value.timeline.pagination.perPage) ||
        value.timeline.items.length > value.timeline.pagination.perPage ||
        value.timeline.items.some(
          (item, index) =>
            item.version > value.version ||
            item.toState !== item.action ||
            (index > 0 && item.version >= value.timeline.items[index - 1]!.version)
        )
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid fulfillment readiness' })
    })
)
export type AdminOrderFulfillment = z.infer<typeof adminOrderFulfillmentSchema>

/** Explicit individual steps. An exception resumes its recorded interrupted
 * stage, never arbitrary work. A pending exception resumes by starting picking. */
export function allowedFulfillmentActions(
  state: OrderFulfillmentState,
  interrupted: OrderFulfillmentState | null,
  method: 'pickup' | 'own_delivery' | 'parcel'
): FulfillmentAction[] {
  if (state === 'delivered') return []
  if (state === 'exception')
    return interrupted && interrupted !== 'exception' && interrupted !== 'delivered'
      ? [interrupted === 'pending' ? 'picking' : interrupted]
      : []
  const next: Partial<Record<OrderFulfillmentState, FulfillmentAction>> = {
    pending: 'picking',
    picking: 'packed',
    packed: method === 'pickup' ? 'ready_for_pickup' : 'in_transit',
    ready_for_pickup: 'delivered',
    in_transit: 'delivered'
  }
  return next[state] ? [next[state]!, 'exception'] : []
}
