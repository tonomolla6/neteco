import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'

export const SUPPORT_KNOWLEDGE_CATEGORIES = [
  { id: 'envios', label: 'Envíos' },
  { id: 'pagos', label: 'Pagos' },
  { id: 'facturas', label: 'Facturas' },
  { id: 'devoluciones', label: 'Devoluciones' },
  { id: 'cuenta', label: 'Cuenta' },
  { id: 'productos', label: 'Productos' },
  { id: 'seguridad', label: 'Seguridad' }
] as const
export const supportKnowledgeCategorySchema = z.enum([
  'envios',
  'pagos',
  'facturas',
  'devoluciones',
  'cuenta',
  'productos',
  'seguridad'
])
/** An editor explicitly opts a CMS revision into help. Publication records
 * editorial review, never a chemical/legal approval or invented review cadence. */
export const supportKnowledgeMetadataSchema = z
  .object({ category: supportKnowledgeCategorySchema, reviewDueAt: catalogPolicyInstantSchema })
  .strict()
const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const positive = z.number().int().min(1).max(1_000_000)
export const supportKnowledgeQuerySchema = z
  .object({
    q: z
      .string()
      .max(160)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
      .default(''),
    page: positive.default(1),
    perPage: z.number().int().min(1).max(20).default(10),
    category: supportKnowledgeCategorySchema.optional()
  })
  .strict()
export type SupportKnowledgeQuery = z.infer<typeof supportKnowledgeQuerySchema>
export const supportKnowledgeItemSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    versionId: catalogPolicyUuidSchema,
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(160),
    title: z.string().min(1).max(160),
    excerpt: z.string().min(1).max(180),
    category: supportKnowledgeCategorySchema,
    reviewedAt: catalogPolicyInstantSchema,
    reviewDueAt: catalogPolicyInstantSchema
  })
  .strict()
  .refine((value) => value.reviewDueAt > value.reviewedAt)
export type SupportKnowledgeItem = z.infer<typeof supportKnowledgeItemSchema>
export const supportKnowledgeListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      items: z.array(supportKnowledgeItemSchema).max(20),
      categories: z
        .array(z.object({ id: supportKnowledgeCategorySchema, label: z.string().min(1).max(40) }).strict())
        .max(7),
      total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      page: positive,
      perPage: z.number().int().min(1).max(20),
      feedbackEnabled: z.boolean()
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        new Set(value.items.map((item) => item.id)).size !== value.items.length ||
        new Set(value.categories.map((category) => category.id)).size !== value.categories.length ||
        value.items.length !== Math.min(value.perPage, Math.max(0, value.total - (value.page - 1) * value.perPage))
      )
        ctx.addIssue({ code: 'custom', message: 'Unconfirmed knowledge pagination' })
    })
)
export type SupportKnowledgeList = z.infer<typeof supportKnowledgeListSchema>
export const supportKnowledgeFeedbackInputSchema = z.preprocess(
  own,
  z
    .object({
      pageId: catalogPolicyUuidSchema,
      versionId: catalogPolicyUuidSchema,
      helpful: z.boolean()
    })
    .strict()
)
export const supportKnowledgeFeedbackReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      feedbackId: catalogPolicyUuidSchema,
      pageId: catalogPolicyUuidSchema,
      versionId: catalogPolicyUuidSchema,
      helpful: z.boolean(),
      recorded: z.literal(true)
    })
    .strict()
)
export type SupportKnowledgeFeedbackReceipt = z.infer<typeof supportKnowledgeFeedbackReceiptSchema>
