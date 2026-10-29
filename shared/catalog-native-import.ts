import { z } from 'zod'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'
import { catalogTabularColumns, CATALOG_TABULAR_MAX_CELL_CHARACTERS } from './catalog-tabular-core'

export const CATALOG_NATIVE_IMPORT_MAX_ROWS = 500
export const CATALOG_NATIVE_IMPORT_MAX_BYTES = 900_000

function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const count = z.number().int().min(1).max(CATALOG_NATIVE_IMPORT_MAX_ROWS)
const counts = z.object({ products: count, variants: count, assets: count, mappings: count }).strict()
const record = z
  .object(
    Object.fromEntries(
      catalogTabularColumns.map((column) => [column, z.string().max(CATALOG_TABULAR_MAX_CELL_CHARACTERS)])
    ) as {
      [Column in (typeof catalogTabularColumns)[number]]: z.ZodString
    }
  )
  .strict()
const reason = z
  .string()
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
  .transform((value) => value.trim())
  .pipe(z.string().min(3).max(500))

export const nativeImportInputSchema = z.preprocess(
  own,
  z.object({ records: z.array(record).min(1).max(CATALOG_NATIVE_IMPORT_MAX_ROWS) }).strict()
)
export type NativeImportInput = z.infer<typeof nativeImportInputSchema>
export const nativeImportCommandInputSchema = z.preprocess(own, z.object({ previewHash: hash, reason }).strict())
export type NativeImportCommandInput = z.infer<typeof nativeImportCommandInputSchema>
export const nativeImportPreviewSchema = z.preprocess(
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
      counts,
      policy: z
        .object({
          publication: z.literal('draft_only'),
          media: z.literal('pending_verification'),
          priceStock: z.literal('authorized_initialization')
        })
        .strict()
    })
    .strict()
    .refine((value) => value.expiresAt > value.createdAt)
)
export type NativeImportPreview = z.infer<typeof nativeImportPreviewSchema>
export const nativeImportInvalidSchema = z.preprocess(
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
export type NativeImportInvalid = z.infer<typeof nativeImportInvalidSchema>
export const nativeImportReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.enum(['apply', 'revert']),
      previewId: uuid,
      previewHash: hash,
      commandId: uuid,
      counts,
      updated: z.literal(true)
    })
    .strict()
)
export type NativeImportReceipt = z.infer<typeof nativeImportReceiptSchema>
