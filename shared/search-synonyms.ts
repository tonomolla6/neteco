import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const SEARCH_SYNONYM_MAX_REPLACEMENTS = 8
export function normalizeSynonymTerm(value: string) {
  return value.trim().replace(/\s+/gu, ' ').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es-ES')
}
const term = z
  .string()
  .min(2)
  .max(160)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
  .transform((value) => value.trim().replace(/\s+/gu, ' '))
  .pipe(z.string().min(2).max(160))
  .refine((value) => normalizeSynonymTerm(value).length >= 2)
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const fields = {
  id: catalogPolicyUuidSchema.nullable(),
  expectedVersion: version,
  sourceTerm: term,
  replacements: z.array(term).min(1).max(SEARCH_SYNONYM_MAX_REPLACEMENTS),
  active: z.boolean(),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  action: z.enum(['save', 'retire'])
}
const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const searchSynonymDraftSchema = z.preprocess(
  own,
  z
    .object(fields)
    .strict()
    .superRefine((value, context) => {
      const terms = [value.sourceTerm, ...value.replacements].map(normalizeSynonymTerm)
      if (new Set(terms).size !== terms.length || terms.some((value) => !/[\p{L}\p{N}]/u.test(value)))
        context.addIssue({ code: 'custom', message: 'Los términos deben ser distintos y contener letras o números.' })
      if ((value.id === null) !== (value.expectedVersion === 0) || (value.action === 'retire' && value.id === null))
        context.addIssue({ code: 'custom', message: 'La identidad y versión no corresponden.' })
    })
)
export type SearchSynonymDraft = z.infer<typeof searchSynonymDraftSchema>
export const searchSynonymPreviewInputSchema = z.preprocess(
  own,
  z.object({ draft: searchSynonymDraftSchema, query: term }).strict()
)
export const searchSynonymCommandInputSchema = z.preprocess(
  own,
  z
    .object({
      previewId: catalogPolicyUuidSchema,
      previewHash: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
)
export const searchSynonymItemSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    sourceTerm: term,
    replacements: z.array(term).min(1).max(8),
    active: z.boolean(),
    version: version.refine((value) => value > 0),
    updatedAt: z.string(),
    retired: z.boolean()
  })
  .strict()
export type SearchSynonymItem = z.infer<typeof searchSynonymItemSchema>
export const searchSynonymListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(searchSynonymItemSchema).max(100),
    total: version,
    page: version.refine((value) => value > 0),
    perPage: z.number().int().min(1).max(100)
  })
  .strict()
export const searchSynonymReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    previewId: catalogPolicyUuidSchema,
    action: z.enum(['save', 'retire']),
    item: searchSynonymItemSchema
  })
  .strict()
export type SearchSynonymReceipt = z.infer<typeof searchSynonymReceiptSchema>
const result = z.object({ slug: z.string().max(500), name: z.string().max(500) }).strict()
export const searchSynonymPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    previewId: catalogPolicyUuidSchema,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string(),
    draft: searchSynonymDraftSchema,
    query: term,
    before: z.array(result).max(8),
    after: z.array(result).max(8),
    beforeTerms: z.array(term).max(9),
    afterTerms: z.array(term).max(9)
  })
  .strict()
export type SearchSynonymPreview = z.infer<typeof searchSynonymPreviewSchema>
