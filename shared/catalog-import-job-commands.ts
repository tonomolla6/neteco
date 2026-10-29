import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { CATALOG_IMPORT_JOB_MAX_ROWS } from './catalog-import-job'

export { catalogImportJobCommandInputSchema, type CatalogImportJobCommandInput } from './catalog-import-job'

function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const count = z.number().int().min(1).max(CATALOG_IMPORT_JOB_MAX_ROWS)

/** Public durable acknowledgement only; never expose row audit snapshots. */
export const catalogImportJobReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: z.enum(['apply', 'revert']),
      jobId: catalogPolicyUuidSchema,
      jobHash: z.string().regex(/^[0-9a-f]{64}$/),
      commandId: catalogPolicyUuidSchema,
      counts: z.object({ products: count, variants: count, assets: count, mappings: count }).strict(),
      updated: z.literal(true)
    })
    .strict()
)
export type CatalogImportJobReceipt = z.infer<typeof catalogImportJobReceiptSchema>
