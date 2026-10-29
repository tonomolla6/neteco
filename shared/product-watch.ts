import { z } from 'zod'
import { catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

export const PRODUCT_WATCH_POLICY_VERSION = 'product-watch-2026-10-10' as const
export const PRODUCT_WATCH_NOTICE_TEXT =
  'Solicito por email el aviso elegido para esta variante. Debo confirmar el enlace enviado a mi correo. Depende de mis preferencias comerciales; puedo cancelarlo en cualquier momento. No reserva stock ni garantiza disponibilidad, precio o entrega. No me suscribe a la newsletter.' as const
export const productWatchKindSchema = z.enum(['back_in_stock', 'price_drop'])
const uuid = z.string().uuid()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const productWatchCreateInputSchema = z
  .object({
    variantId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: productWatchKindSchema,
    consent: z.literal(true),
    policyVersion: z.literal(PRODUCT_WATCH_POLICY_VERSION)
  })
  .strict()
export const productWatchConfirmInputSchema = z
  .object({
    expectedVersion: version,
    token: z.string().regex(/^pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}$/)
  })
  .strict()
export const productWatchCancelInputSchema = z.object({ expectedVersion: version }).strict()
export const productWatchItemSchema = z
  .object({
    id: uuid,
    variantId: z.number().int().positive(),
    kind: productWatchKindSchema,
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    version,
    createdAt: instant,
    confirmationExpiresAt: instant,
    confirmedAt: instant.nullable(),
    cancelledAt: instant.nullable(),
    baselineGrossCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    suppressedByPreferences: z.boolean(),
    notifications: z.number().int().nonnegative()
  })
  .strict()
export const productWatchListSchema = z
  .object({
    source: z.literal('cloudflare'),
    page: z.number().int().positive(),
    perPage: z.number().int().min(1).max(25),
    total: z.number().int().nonnegative(),
    items: z.array(productWatchItemSchema).max(25),
    policyVersion: z.literal(PRODUCT_WATCH_POLICY_VERSION),
    noticeText: z.literal(PRODUCT_WATCH_NOTICE_TEXT),
    evaluatedAt: instant
  })
  .strict()
export const productWatchDetailSchema = z
  .object({
    source: z.literal('cloudflare'),
    item: productWatchItemSchema,
    evaluatedAt: instant
  })
  .strict()
export const productWatchReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    action: z.enum(['create', 'confirm', 'cancel']),
    watchId: uuid,
    payloadHash: hash,
    version,
    status: z.enum(['pending', 'confirmed', 'cancelled']),
    recordedAt: instant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none')
  })
  .strict()
export const productWatchCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: productWatchReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type ProductWatchCreateInput = z.infer<typeof productWatchCreateInputSchema>
export type ProductWatchItem = z.infer<typeof productWatchItemSchema>
export type ProductWatchReceipt = z.infer<typeof productWatchReceiptSchema>
export type ProductWatchList = z.infer<typeof productWatchListSchema>
export type ProductWatchDetail = z.infer<typeof productWatchDetailSchema>
export type ProductWatchCommand = z.infer<typeof productWatchCommandSchema>

export async function productWatchIntentHash(
  action: 'create' | 'confirm' | 'cancel',
  targetId: string | null,
  raw: unknown
) {
  const input =
    action === 'create'
      ? productWatchCreateInputSchema.parse(raw)
      : action === 'confirm'
        ? productWatchConfirmInputSchema.parse(raw)
        : productWatchCancelInputSchema.parse(raw)
  if (action === 'create' ? targetId !== null : !uuid.safeParse(targetId).success) throw new Error('invalid_input')
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ action, targetId, input }))
  )
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
