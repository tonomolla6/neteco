import { z } from 'zod'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'
const uuid = z.string().uuid()
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.codePointAt(0)!
          return character === '<' || character === '>' || code === 127 || (code < 32 && ![9, 10, 13].includes(code))
        }),
      'plain_text_required'
    )
export const orderAnnotationLabelsSchema = z
  .array(plain(40))
  .max(8)
  .refine((value) => new Set(value).size === value.length, 'duplicate_labels')
export const orderAnnotationsInputSchema = z
  .object({ expectedVersion: version, note: plain(2000).optional(), labels: orderAnnotationLabelsSchema.optional() })
  .strict()
  .refine((value) => value.note !== undefined || value.labels !== undefined, 'empty_command')
export const orderAnnotationNoteSchema = z
  .object({ id: uuid, authorId: uuid, createdAt: catalogPolicyInstantSchema, text: plain(2000) })
  .strict()
export const orderAnnotationsResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: uuid,
    version,
    labels: orderAnnotationLabelsSchema,
    notes: z.array(orderAnnotationNoteSchema).max(50),
    nextCursor: uuid.nullable()
  })
  .strict()
export const orderAnnotationsReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    orderId: uuid,
    commandId: uuid,
    version: version.refine((value) => value > 0),
    noteId: uuid.nullable(),
    labels: orderAnnotationLabelsSchema,
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export const orderAnnotationCommandSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        source: z.literal('cloudflare'),
        orderId: uuid,
        commandId: uuid,
        outcome: z.literal('applied'),
        receipt: orderAnnotationsReceiptSchema
      })
      .strict(),
    z
      .object({
        source: z.literal('cloudflare'),
        orderId: uuid,
        commandId: uuid,
        outcome: z.literal('unknown'),
        receipt: z.null()
      })
      .strict()
  ])
  .refine(
    (value) =>
      value.receipt === null ||
      (value.receipt.orderId === value.orderId && value.receipt.commandId === value.commandId),
    'receipt_mismatch'
  )
export type OrderAnnotationsInput = z.infer<typeof orderAnnotationsInputSchema>
export type OrderAnnotationsResponse = z.infer<typeof orderAnnotationsResponseSchema>
export type OrderAnnotationsReceipt = z.infer<typeof orderAnnotationsReceiptSchema>
export type OrderAnnotationCommand = z.infer<typeof orderAnnotationCommandSchema>
