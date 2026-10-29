import { z } from 'zod'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'

function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const text = (minimum: number, maximum: number, multiline = false) =>
  z
    .string()
    .refine((value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code !== 127 && (code >= 32 || (multiline && [9, 10, 13].includes(code)))
      })
    )
    .transform((value) => value.trim())
    .pipe(z.string().min(minimum).max(maximum))
export const editorialMetadataSchema = z
  .object({
    name: text(3, 160),
    shortDesc: text(5, 500),
    description: text(5, 10000, true),
    usage: text(0, 2000, true)
      .nullable()
      .transform((value) => value || null),
    series: text(0, 160)
      .nullable()
      .transform((value) => value || null),
    featured: z.boolean()
  })
  .strict()
export type EditorialMetadata = z.infer<typeof editorialMetadataSchema>

// Existing drafts can legitimately have incomplete metadata. Keep this exact
// prestate, including null versus empty; rollback must not fabricate content.
const beforeSchema = z
  .object({
    name: z.string().max(20000),
    shortDesc: z.string().max(20000).nullable(),
    description: z.string().max(20000).nullable(),
    usage: z.string().max(20000).nullable(),
    series: z.string().max(20000).nullable(),
    featured: z.boolean()
  })
  .strict()
export const editorialPreviewProductSchema = z
  .object({
    productId: uuid,
    legacyId: positive,
    expectedVersion: positive.max(Number.MAX_SAFE_INTEGER - 2),
    before: beforeSchema,
    after: editorialMetadataSchema
  })
  .strict()
const products = z
  .array(editorialPreviewProductSchema)
  .min(1)
  .max(100)
  .refine(
    (items) =>
      new Set(items.map((item) => item.productId)).size === items.length &&
      new Set(items.map((item) => item.legacyId)).size === items.length
  )
export const editorialPreviewSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('preview'),
      id: uuid,
      hash,
      createdAt: instant,
      expiresAt: instant,
      status: z.enum(['pending', 'expired', 'applied', 'reverted']),
      products
    })
    .strict()
    .refine((value) => value.expiresAt > value.createdAt)
)
export type EditorialPreview = z.infer<typeof editorialPreviewSchema>
export const editorialInvalidSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('invalid'),
      issues: z
        .array(
          z
            .object({
              code: z.string().min(1).max(80),
              row: positive.optional(),
              field: z.string().min(1).max(80).optional(),
              message: z.string().min(1).max(500)
            })
            .strict()
        )
        .min(1)
        .max(100)
    })
    .strict()
)
export type EditorialInvalid = z.infer<typeof editorialInvalidSchema>
export const editorialReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.enum(['apply', 'revert']),
      previewId: uuid,
      previewHash: hash,
      commandId: uuid,
      productCount: z.number().int().min(1).max(100),
      updated: z.literal(true)
    })
    .strict()
)
export type EditorialReceipt = z.infer<typeof editorialReceiptSchema>
export const editorialCommandInputSchema = z.preprocess(
  own,
  z
    .object({
      previewHash: hash,
      reason: text(3, 500)
    })
    .strict()
)
export const editorialPreviewInputSchema = z.preprocess(
  own,
  z
    .object({
      csv: z.string().min(1).max(1_000_000)
    })
    .strict()
)
