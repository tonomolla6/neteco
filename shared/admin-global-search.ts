import { z } from 'zod'

export const adminGlobalSearchQuerySchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(2)
      .max(100)
      .refine((value) =>
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      )
  )
const legacyId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)))
export const adminGlobalSearchItemSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('product'),
        id: legacyId,
        label: z.string().min(1).max(200),
        description: z.string().max(160),
        to: z.string()
      })
      .strict(),
    z
      .object({
        kind: z.literal('order'),
        id: z.string().uuid(),
        label: z.string().max(200),
        description: z.literal('Pedido'),
        to: z.string()
      })
      .strict()
  ])
  .superRefine((value, context) => {
    if (
      value.to !== `/admin/${value.kind === 'product' ? 'productos' : 'pedidos'}/${value.id}` ||
      (value.kind === 'order' && value.label !== `Pedido ${value.id}`)
    )
      context.addIssue({ code: 'custom', message: 'Invalid canonical destination or label' })
  })
export const adminGlobalSearchResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    query: adminGlobalSearchQuerySchema,
    items: z.array(adminGlobalSearchItemSchema).max(20)
  })
  .strict()
export type AdminGlobalSearchItem = z.infer<typeof adminGlobalSearchItemSchema>
export type AdminGlobalSearchResponse = z.infer<typeof adminGlobalSearchResponseSchema>
