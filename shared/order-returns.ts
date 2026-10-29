import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { inventoryIdempotencyKeySchema } from './inventory-commands'

/** Physical custody only: no implicit policy, restock, refund or fiscal authority. */
export const returnOrderIdSchema = catalogPolicyUuidSchema
export const returnIdempotencyKeySchema = inventoryIdempotencyKeySchema
export const returnPublicRefSchema = z.string().regex(/^RMA-[0-9A-F]{24}$/)
export const returnStateSchema = z.enum([
  'requested',
  'approved',
  'rejected',
  'received',
  'inspected',
  'resolution_ready'
])
export const returnActionSchema = z.enum(['approved', 'rejected', 'received', 'inspected', 'resolution_ready'])
export type ReturnState = z.infer<typeof returnStateSchema>
export type ReturnAction = z.infer<typeof returnActionSchema>
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const version = integer.max(Number.MAX_SAFE_INTEGER - 1)
const quantity = integer.max(999)
const lineIndex = integer.max(99)
const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => value.trim() === value && [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    )
function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const unique = <T extends { lineIndex: number }>(items: T[]) =>
  new Set(items.map((item) => item.lineIndex)).size === items.length
const lines = z
  .array(z.object({ lineIndex, quantity: quantity.min(1) }).strict())
  .min(1)
  .max(100)
  .refine(unique)
export const returnRequestInputSchema = z.preprocess(
  own,
  z.object({ expectedVersion: version, reason: text(10, 500), lines }).strict()
)
export type ReturnRequestInput = z.infer<typeof returnRequestInputSchema>
const common = {
  expectedVersion: version.min(1),
  reason: text(10, 500),
  publicMessage: text(10, 500),
  evidence: text(10, 500)
}
export const returnConditionSchema = z.enum(['sealed', 'opened', 'damaged', 'unknown'])
export const returnDispositionSchema = z.enum(['quarantine', 'non_restockable', 'review_restock'])
export const returnCostSchema = z
  .object({
    amountCents: integer.max(1_000_000_000),
    currency: z.literal('EUR'),
    category: z.enum(['handling', 'return_shipping', 'other']),
    evidenceRef: text(3, 200),
    description: text(10, 500)
  })
  .strict()
export const returnTransitionInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z
      .object({
        ...common,
        action: z.literal('approved'),
        decisionRef: text(3, 200),
        lines: z
          .array(z.object({ lineIndex, quantity }).strict())
          .min(1)
          .max(100)
          .refine((items) => unique(items) && items.some((item) => item.quantity > 0))
      })
      .strict(),
    z.object({ ...common, action: z.literal('rejected') }).strict(),
    z.object({ ...common, action: z.literal('received'), lines }).strict(),
    z
      .object({
        ...common,
        action: z.literal('inspected'),
        lines: z
          .array(
            z
              .object({
                lineIndex,
                quantity: quantity.min(1),
                condition: returnConditionSchema,
                disposition: returnDispositionSchema,
                note: text(10, 500).optional()
              })
              .strict()
          )
          .min(1)
          .max(100)
          .refine(unique)
      })
      .strict(),
    z
      .object({
        ...common,
        action: z.literal('resolution_ready'),
        resolution: text(10, 500),
        cost: returnCostSchema.optional()
      })
      .strict()
  ])
)
export type ReturnTransitionInput = z.infer<typeof returnTransitionInputSchema>
export const returnCommandReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      commandId: catalogPolicyUuidSchema,
      returnId: catalogPolicyUuidSchema,
      publicRef: returnPublicRefSchema,
      orderId: returnOrderIdSchema,
      action: returnStateSchema,
      state: returnStateSchema,
      version: integer.min(1),
      orderVersion: integer.min(1),
      inventoryEffect: z.literal('none'),
      custody: z.literal('non_sellable'),
      updated: z.literal(true)
    })
    .strict()
    .refine((value) => value.action === value.state)
)
export type ReturnCommandReceipt = z.infer<typeof returnCommandReceiptSchema>
export const returnBlockerSchema = z.enum([
  'order_cancelled',
  'payment_unconfirmed',
  'delivery_unconfirmed',
  'warehouse_unavailable',
  'history_unconfirmed'
])
export type ReturnBlocker = z.infer<typeof returnBlockerSchema>
const pagination = z
  .object({ page: integer.min(1).max(1_000_000), perPage: integer.min(1).max(50), total: integer, pages: integer })
  .strict()
  .refine((value) => value.pages === Math.ceil(value.total / value.perPage))
const effects = { inventoryEffect: z.literal('none'), custody: z.literal('non_sellable') }
const disabled = {
  refunds: z.literal(false),
  fiscal: z.literal(false),
  carrier: z.literal(false),
  attachments: z.literal(false)
}
const returnLineSchema = z
  .object({
    lineIndex,
    sku: text(1, 160),
    name: text(1, 500),
    purchasedQuantity: quantity.min(1),
    requestedQuantity: quantity.min(1),
    authorizedQuantity: quantity,
    receivedQuantity: quantity,
    inspectedQuantity: quantity,
    claimedQuantity: quantity,
    unitGrossCents: integer,
    lineGrossCents: integer,
    currency: z.literal('EUR')
  })
  .strict()
  .refine(
    (value) =>
      value.claimedQuantity >= value.receivedQuantity &&
      value.claimedQuantity <= value.requestedQuantity &&
      value.requestedQuantity <= value.purchasedQuantity &&
      value.receivedQuantity <= value.authorizedQuantity &&
      value.authorizedQuantity <= value.requestedQuantity &&
      value.inspectedQuantity <= value.receivedQuantity
  )
const publicTimeline = z
  .object({
    action: returnStateSchema,
    version: integer.min(1),
    message: text(10, 500),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
const detail = {
  source: z.literal('cloudflare'),
  id: catalogPolicyUuidSchema,
  publicRef: returnPublicRefSchema,
  orderId: returnOrderIdSchema,
  state: returnStateSchema,
  version: integer.min(1),
  orderVersion: integer.min(1),
  reason: text(10, 500),
  publicMessage: text(10, 500),
  createdAt: catalogPolicyInstantSchema,
  updatedAt: catalogPolicyInstantSchema,
  eligibility: z
    .object({
      status: z.enum(['review_required', 'admitted_after_review', 'rejected']),
      automaticallyEligible: z.literal(false),
      policyVersion: z.null()
    })
    .strict(),
  warehouse: z.object({ id: text(1, 200), name: text(1, 200) }).strict(),
  lines: z.array(returnLineSchema).min(1).max(100),
  ...effects
}
const readiness = z
  .object({ ready: z.boolean(), blockers: z.array(returnBlockerSchema).max(5) })
  .strict()
  .refine(
    (value) => value.ready === (value.blockers.length === 0) && new Set(value.blockers).size === value.blockers.length
  )
export const adminOrderReturnSchema = z.preprocess(
  own,
  z
    .object({
      ...detail,
      readiness,
      capabilities: z
        .object({
          returnsRead: z.literal(true),
          returnsTransitions: z.boolean(),
          allowedActions: z.array(returnActionSchema).max(2),
          ...disabled
        })
        .strict(),
      decisionRef: text(3, 200).nullable(),
      resolution: text(10, 500).nullable(),
      timeline: z
        .object({
          items: z
            .array(
              z
                .object({
                  commandId: catalogPolicyUuidSchema,
                  actorId: catalogPolicyUuidSchema,
                  actorType: z.enum(['admin', 'customer']),
                  action: returnStateSchema,
                  version: integer.min(1),
                  reason: text(10, 500),
                  evidence: text(10, 500).nullable(),
                  message: text(10, 500),
                  lines: z
                    .array(
                      z
                        .object({
                          lineIndex,
                          quantity,
                          condition: returnConditionSchema.optional(),
                          disposition: returnDispositionSchema.optional(),
                          note: text(10, 500).optional()
                        })
                        .strict()
                    )
                    .max(100),
                  cost: returnCostSchema.nullable(),
                  createdAt: catalogPolicyInstantSchema
                })
                .strict()
            )
            .max(50),
          pagination
        })
        .strict(),
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
    .superRefine((value, ctx) => {
      const received = value.lines.every((line) => line.receivedQuantity === line.authorizedQuantity),
        inspected = value.lines.every((line) => line.inspectedQuantity === line.receivedQuantity)
      const allowed = value.readiness.ready ? allowedReturnActions(value.state, received, inspected) : []
      if (
        value.capabilities.returnsTransitions !== allowed.length > 0 ||
        allowed.join() !== value.capabilities.allowedActions.join() ||
        value.timeline.pagination.total !== value.version ||
        new Set(value.lines.map((line) => line.lineIndex)).size !== value.lines.length ||
        value.timeline.items.some(
          (item, i) => item.version > value.version || (i > 0 && item.version >= value.timeline.items[i - 1]!.version)
        )
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed RMA projection' })
    })
)
export type AdminOrderReturn = z.infer<typeof adminOrderReturnSchema>
export const customerOrderReturnSchema = z.preprocess(
  own,
  z
    .object({
      ...detail,
      timeline: z.object({ items: z.array(publicTimeline).max(50), pagination }).strict(),
      capabilities: z.object({ returnsRead: z.literal(true), ...disabled }).strict()
    })
    .strict()
    .refine(
      (value) =>
        value.timeline.pagination.total === value.version &&
        unique(value.lines) &&
        value.timeline.items.every(
          (item, i) => item.version <= value.version && (i === 0 || item.version < value.timeline.items[i - 1]!.version)
        )
    )
)
export type CustomerOrderReturn = z.infer<typeof customerOrderReturnSchema>
export const customerOrderReturnsSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      orderId: returnOrderIdSchema,
      version,
      readiness,
      eligibility: z
        .object({
          status: z.literal('review_required'),
          automaticallyEligible: z.literal(false),
          policyVersion: z.null()
        })
        .strict(),
      lines: z
        .array(
          z
            .object({
              lineIndex,
              sku: text(1, 160),
              name: text(1, 500),
              purchasedQuantity: quantity.min(1),
              claimedQuantity: quantity,
              availableQuantity: quantity,
              unitGrossCents: integer,
              lineGrossCents: integer,
              currency: z.literal('EUR')
            })
            .strict()
            .refine((value) => value.claimedQuantity + value.availableQuantity === value.purchasedQuantity)
        )
        .min(1)
        .max(100),
      returns: z.array(customerOrderReturnSchema).max(50),
      pagination,
      capabilities: z
        .object({
          returnsRead: z.literal(true),
          returnRequest: z.boolean(),
          guestVerification: z.literal(false),
          ...disabled
        })
        .strict(),
      ...effects,
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
    .refine(
      (value) =>
        value.capabilities.returnRequest ===
          (value.readiness.ready && value.lines.some((line) => line.availableQuantity > 0)) &&
        unique(value.lines) &&
        new Set(value.returns.map((item) => item.id)).size === value.returns.length &&
        value.returns.every((item) => item.orderId === value.orderId && item.orderVersion <= value.version)
    )
)
export type CustomerOrderReturns = z.infer<typeof customerOrderReturnsSchema>
export const adminReturnListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      items: z
        .array(
          z
            .object({
              id: catalogPolicyUuidSchema,
              publicRef: returnPublicRefSchema,
              orderId: returnOrderIdSchema,
              state: returnStateSchema,
              version: integer.min(1),
              reason: text(10, 500),
              customerName: text(2, 160).nullable(),
              requestedQuantity: integer.min(1),
              receivedQuantity: integer,
              createdAt: catalogPolicyInstantSchema,
              updatedAt: catalogPolicyInstantSchema
            })
            .strict()
        )
        .max(50),
      pagination,
      capabilities: z.object({ returnsRead: z.literal(true), ...disabled }).strict(),
      evaluatedAt: catalogPolicyInstantSchema
    })
    .strict()
)
export type AdminReturnList = z.infer<typeof adminReturnListSchema>

export function allowedReturnActions(
  state: ReturnState,
  fullyReceived: boolean,
  fullyInspected: boolean
): ReturnAction[] {
  if (state === 'requested') return ['approved', 'rejected']
  if (state === 'approved') return ['received']
  if (state === 'received') return fullyReceived ? ['inspected'] : ['received']
  if (state === 'inspected') return fullyInspected ? ['resolution_ready'] : ['inspected']
  return []
}

export const returnStateLabels: Record<ReturnState, string> = {
  requested: 'Solicitada · revisión pendiente',
  approved: 'Admitida tras revisión',
  rejected: 'No admitida',
  received: 'Recibida en custodia',
  inspected: 'Inspección registrada',
  resolution_ready: 'Resolución preparada · siguientes decisiones pendientes'
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}
/** Read only ofetch's response callback, never FetchError accessors. */
export function returnResponseErrorCode(context: unknown): string | null {
  const response = field(context, 'response')
  let status = field(response, 'status')
  if (status === undefined && response instanceof Response) {
    try {
      status = Object.getOwnPropertyDescriptor(Response.prototype, 'status')?.get?.call(response)
    } catch {
      return null
    }
  }
  if (typeof status !== 'number' || status < 400 || status >= 500) return null
  try {
    const code = field(field(catalogPolicyOwnJson(field(response, '_data')), 'error'), 'code')
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}
export function definiteReturnRejection(code: string | null, sent: boolean, recovery: boolean): boolean {
  if (code === null) return false
  if (['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'].includes(code)) return !sent && !recovery
  return [
    'invalid_input',
    'not_found',
    'version_conflict',
    'idempotency_conflict',
    'invalid_transition',
    'quantity_unavailable',
    'line_not_found',
    'order_cancelled',
    'payment_unconfirmed',
    'delivery_unconfirmed',
    'warehouse_unavailable',
    'csrf_rejected',
    'invalid_idempotency_key',
    'rate_limited',
    'body_too_large',
    'json_required',
    'invalid_json',
    'guest_verification_required'
  ].includes(code)
}
export function freezeReturnIntent<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeReturnIntent(nested)
    Object.freeze(value)
  }
  return value
}
