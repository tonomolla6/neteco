import { z } from 'zod'
import { supportInstant, supportUuid } from './support-operations'

export const ADMIN_ORDER_VIEW_COLUMNS = [
  'createdAt',
  'customer',
  'total',
  'paymentStatus',
  'fulfillmentStatus',
  'shippingMethod',
  'invoiceStatus'
] as const
export const adminOrderViewNameSchema = z
  .string()
  .max(256)
  .refine((value) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) return false
    }
    return true
  })
  .transform((value) => value.normalize('NFC').trim())
  .pipe(z.string().min(1).max(60))
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00Z`)
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value && value <= '9999-12-30'
  })
export const adminOrderViewDefinitionSchema = z
  .object({
    bucket: z.enum(['todos', 'por_preparar', 'por_cobrar', 'incidencia']),
    sortKey: z.enum(['id', 'createdAt', 'name', 'total']),
    sortDir: z.enum(['asc', 'desc']),
    paymentStatus: z
      .enum(['pending', 'processing', 'authorized', 'captured', 'failed', 'cancelled', 'stock_exception'])
      .optional(),
    orderStatus: z.enum(['awaiting_payment', 'cancelled']).optional(),
    shippingMethod: z.enum(['pickup', 'parcel', 'own_delivery']).optional(),
    customerType: z.enum(['b2c', 'b2b']).optional(),
    from: date.optional(),
    to: date.optional(),
    columns: z
      .array(z.enum(ADMIN_ORDER_VIEW_COLUMNS))
      .min(1)
      .max(7)
      .refine((value) => new Set(value).size === value.length)
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to)
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const adminOrderViewCreateInputSchema = z
  .object({ name: adminOrderViewNameSchema, definition: adminOrderViewDefinitionSchema })
  .strict()
export const adminOrderViewUpdateInputSchema = z
  .object({ expectedVersion: version, name: adminOrderViewNameSchema, definition: adminOrderViewDefinitionSchema })
  .strict()
export const adminOrderViewArchiveInputSchema = z.object({ expectedVersion: version }).strict()
export const adminOrderViewSchema = z
  .object({
    id: supportUuid,
    name: adminOrderViewNameSchema,
    definition: adminOrderViewDefinitionSchema,
    version,
    archived: z.boolean(),
    createdAt: supportInstant,
    updatedAt: supportInstant,
    archivedAt: supportInstant.nullable()
  })
  .strict()
  .refine(
    (value) =>
      value.archived === (value.archivedAt !== null) &&
      value.updatedAt >= value.createdAt &&
      (!value.archivedAt || value.archivedAt === value.updatedAt)
  )
export const adminOrderViewListSchema = z
  .object({ source: z.literal('cloudflare'), items: z.array(adminOrderViewSchema).max(20) })
  .strict()
export const adminOrderViewDetailSchema = z
  .object({ source: z.literal('cloudflare'), view: adminOrderViewSchema })
  .strict()
export const adminOrderViewHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const adminOrderViewReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: supportUuid,
    payloadHash: adminOrderViewHashSchema,
    action: z.enum(['create', 'update', 'archive']),
    viewId: supportUuid,
    version,
    recordedAt: supportInstant
  })
  .strict()
export const adminOrderViewCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: adminOrderViewReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type AdminOrderViewDefinition = z.infer<typeof adminOrderViewDefinitionSchema>
export type AdminOrderView = z.infer<typeof adminOrderViewSchema>
export type AdminOrderViewList = z.infer<typeof adminOrderViewListSchema>
export type AdminOrderViewDetail = z.infer<typeof adminOrderViewDetailSchema>
export type AdminOrderViewReceipt = z.infer<typeof adminOrderViewReceiptSchema>
export type AdminOrderViewCommand = z.infer<typeof adminOrderViewCommandSchema>
export type AdminOrderViewCreateInput = z.infer<typeof adminOrderViewCreateInputSchema>
export type AdminOrderViewUpdateInput = z.infer<typeof adminOrderViewUpdateInputSchema>
export type AdminOrderViewArchiveInput = z.infer<typeof adminOrderViewArchiveInputSchema>
export async function adminOrderViewIntentHash(
  action: 'create' | 'update' | 'archive',
  targetId: string | null,
  raw: unknown
) {
  const input =
    action === 'create'
      ? adminOrderViewCreateInputSchema.parse(raw)
      : action === 'update'
        ? adminOrderViewUpdateInputSchema.parse(raw)
        : adminOrderViewArchiveInputSchema.parse(raw)
  if (action === 'create' ? targetId !== null : !supportUuid.safeParse(targetId).success)
    throw new Error('invalid_input')
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ purpose: 'admin-order-view-v1', action, targetId, input }))
  )
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
