import { z } from 'zod'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'
export const ORDER_TIMELINE_STATES = {
  checkout: ['created', 'cancelled'],
  payment: [
    'notification_pending',
    'notification_failed',
    'notification_cancelled',
    'provider_authorised',
    'captured',
    'stock_exception',
    'notification_mismatch'
  ],
  fulfillment: ['picking', 'packed', 'ready_for_pickup', 'in_transit', 'delivered', 'exception'],
  return: ['requested', 'approved', 'rejected', 'received', 'inspected', 'resolution_ready'],
  refund: ['succeeded'],
  fiscal: ['issued', 'fiscal_pending'],
  credit: ['issued', 'fiscal_pending']
} as const
export const orderTimelineAudienceSchema = z.enum(['customer', 'admin'])
export type OrderTimelineAudience = z.infer<typeof orderTimelineAudienceSchema>
export type OrderTimelineKind = keyof typeof ORDER_TIMELINE_STATES
const sourceId = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const event = <K extends OrderTimelineKind>(kind: K) =>
  z
    .object({
      id: sourceId.refine((value) => value.startsWith(kind + ':') && value.length > kind.length + 1),
      kind: z.literal(kind),
      state: z.enum(ORDER_TIMELINE_STATES[kind]),
      createdAt: catalogPolicyInstantSchema,
      validationOnly: kind === 'refund' || kind === 'fiscal' || kind === 'credit' ? z.boolean() : z.null()
    })
    .strict()
export const orderTimelineItemSchema = z.discriminatedUnion('kind', [
  event('checkout'),
  event('payment'),
  event('fulfillment'),
  event('return'),
  event('refund'),
  event('fiscal'),
  event('credit')
])
export const orderTimelineCursorSchema = z
  .object({
    v: z.literal(1),
    orderId: z.string().uuid(),
    audience: orderTimelineAudienceSchema,
    asOf: catalogPolicyInstantSchema,
    at: catalogPolicyInstantSchema,
    id: sourceId.refine((value) =>
      Object.keys(ORDER_TIMELINE_STATES).some((kind) => value.startsWith(kind + ':') && value.length > kind.length + 1)
    )
  })
  .strict()
  .refine((value) => value.at <= value.asOf)
export function encodeOrderTimelineCursor(value: z.infer<typeof orderTimelineCursorSchema>) {
  return btoa(JSON.stringify(orderTimelineCursorSchema.parse(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
export function decodeOrderTimelineCursor(value: string) {
  if (!/^[A-Za-z0-9_-]{1,768}$/.test(value)) throw new Error('invalid_timeline_cursor')
  const parsed = orderTimelineCursorSchema.parse(JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))))
  if (encodeOrderTimelineCursor(parsed) !== value) throw new Error('invalid_timeline_cursor')
  return parsed
}
export const orderTimelineResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: z.string().uuid(),
    audience: orderTimelineAudienceSchema,
    items: z.array(orderTimelineItemSchema).max(20),
    nextCursor: z.string().min(1).max(768).nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.nextCursor !== null) {
      try {
        const cursor = decodeOrderTimelineCursor(value.nextCursor),
          last = value.items.at(-1)
        if (
          cursor.orderId !== value.orderId ||
          cursor.audience !== value.audience ||
          !last ||
          cursor.id !== last.id ||
          cursor.at !== last.createdAt ||
          value.items.some((item) => item.createdAt > cursor.asOf)
        )
          throw new Error('invalid_cursor')
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid timeline cursor' })
      }
    }
  })
export type OrderTimelineItem = z.infer<typeof orderTimelineItemSchema>
export type OrderTimelineResponse = z.infer<typeof orderTimelineResponseSchema>
