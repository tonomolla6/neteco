import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const page = z.coerce.number().int().min(1).max(10000).default(1)
const perPage = z.coerce.number().int().min(1).max(25).default(25)
export const customer360ListQuerySchema = z.object({ q: z.string().trim().max(80).default(''), page, perPage }).strict()
export const customer360QuerySchema = z
  .object({ ordersPage: page, ticketsPage: page, invoicesPage: page, perPage })
  .strict()
const customer = z
  .object({ id: uuid, name: z.string().max(200).nullable(), status: z.enum(['active', 'blocked']) })
  .strict()
const pagination = { page: integer.positive(), perPage: integer.positive().max(25), total: integer, pages: integer }
export const customer360ListSchema = z
  .object({ source: z.literal('cloudflare'), items: z.array(customer).max(25), ...pagination })
  .strict()
const redacted = z.object({ visibility: z.literal('redacted'), data: z.null() }).strict()
const visible = <T extends z.ZodTypeAny>(schema: T) =>
  z.discriminatedUnion('visibility', [redacted, z.object({ visibility: z.literal('visible'), data: schema }).strict()])
const order = z
  .object({
    id: uuid,
    status: z.string().min(1).max(40),
    shippingMethod: z.string().max(40).nullable(),
    createdAt: instant
  })
  .strict()
const ticket = z
  .object({
    publicRef: z.string().min(1).max(40),
    category: z.string().max(40),
    state: z.string().max(40),
    priority: z.string().max(40),
    nextActionAt: instant.nullable(),
    ownerAssigned: z.boolean(),
    updatedAt: instant
  })
  .strict()
const invoice = z
  .object({
    orderId: uuid,
    status: z.string().max(40),
    validationOnly: z.boolean(),
    grossCents: integer,
    currency: z.literal('EUR'),
    createdAt: instant
  })
  .strict()
const paged = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({ ...pagination, items: z.array(schema).max(25) }).strict()
const choice = z
  .object({
    value: z.boolean(),
    version: integer,
    updatedAt: instant.nullable(),
    basis: z.enum(['recorded', 'default'])
  })
  .strict()
export const customer360Schema = z
  .object({
    source: z.literal('cloudflare'),
    customer,
    evaluatedAt: instant,
    orders: visible(paged(order)),
    tickets: visible(paged(ticket)),
    invoices: visible(paged(invoice)),
    value: visible(
      z
        .object({
          currency: z.literal('EUR'),
          orderCount: integer,
          paidOrderCount: integer,
          paidGrossCents: integer,
          settledRefundGrossCents: integer,
          validationRefundGrossCents: integer,
          netCollectedGrossCents: integer
        })
        .strict()
    ),
    consent: visible(
      z
        .object({
          productUpdates: choice,
          replenishment: choice,
          deliveryUpdates: choice,
          newsletter: z.object({ status: z.literal('unknown'), reason: z.literal('identity_unlinked') }).strict()
        })
        .strict()
    ),
    nextAction: visible(
      z
        .object({
          kind: z.literal('support_follow_up'),
          ticketRef: z.string().min(1).max(40),
          dueAt: instant,
          ownerAssigned: z.boolean()
        })
        .strict()
        .nullable()
    )
  })
  .strict()
export type Customer360 = z.infer<typeof customer360Schema>
export type Customer360List = z.infer<typeof customer360ListSchema>
