import { z } from 'zod'
import {
  CATALOG_NATIVE_IMPORT_MAX_BYTES,
  CATALOG_NATIVE_IMPORT_MAX_ROWS,
  nativeImportInputSchema,
  nativeImportCommandInputSchema
} from './catalog-native-import'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { CATALOG_TABULAR_MAX_ROWS, type CatalogTabularRecord } from './catalog-tabular-core'

// The 20 MB source-file limit belongs to the file decoder. JSON repeats all 71
// column names per record, so staging has a separate bounded expanded budget.
export const CATALOG_IMPORT_JOB_MAX_BYTES = 100_000_000
export const CATALOG_IMPORT_JOB_MAX_PAGES = 1000
export const CATALOG_IMPORT_JOB_MAX_ROWS = CATALOG_TABULAR_MAX_ROWS
export class CatalogImportJobError extends Error {
  constructor(
    readonly code:
      'invalid_catalog_records' | 'catalog_row_limit' | 'catalog_record_too_large' | 'catalog_job_too_large'
  ) {
    super(code)
  }
}
export interface CatalogImportJobPage {
  index: number
  records: CatalogTabularRecord[]
  byteLength: number
}
export interface CatalogImportJobPlan {
  pages: CatalogImportJobPage[]
  recordCount: number
  totalBytes: number
}

/** Pure source-row planner, not catalog validation or write authorization.
 * Inspect the large root array by descriptors rather than using the own-JSON
 * helper's 1000-item limit or evaluating root element accessors. Each record is
 * validated and detached once; only a single record JSON is allocated at a time.
 */
export function planCatalogImportJob(records: unknown): CatalogImportJobPlan {
  let descriptors: Record<string, PropertyDescriptor>, length: number
  try {
    if (!Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype)
      throw new CatalogImportJobError('invalid_catalog_records')
    const size: unknown = Object.getOwnPropertyDescriptor(records, 'length')?.value
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1)
      throw new CatalogImportJobError('invalid_catalog_records')
    if (size > CATALOG_IMPORT_JOB_MAX_ROWS) throw new CatalogImportJobError('catalog_row_limit')
    length = size
    descriptors = Object.getOwnPropertyDescriptors(records)
    const keys = Reflect.ownKeys(records)
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length))
      )
    )
      throw new CatalogImportJobError('invalid_catalog_records')
  } catch (error) {
    if (error instanceof CatalogImportJobError) throw error
    throw new CatalogImportJobError('invalid_catalog_records')
  }
  const encoder = new TextEncoder()
  const envelopeBytes = encoder.encode('{"records":[]}').byteLength
  const pages: CatalogImportJobPage[] = []
  let page: CatalogImportJobPage = { index: 0, records: [], byteLength: envelopeBytes }
  let totalBytes = 0
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new CatalogImportJobError('invalid_catalog_records')
    const parsed = nativeImportInputSchema.safeParse({ records: [descriptor.value] })
    if (!parsed.success) throw new CatalogImportJobError('invalid_catalog_records')
    const record = parsed.data.records[0]!
    const rowBytes = encoder.encode(JSON.stringify(record)).byteLength
    if (rowBytes + envelopeBytes > CATALOG_NATIVE_IMPORT_MAX_BYTES)
      throw new CatalogImportJobError('catalog_record_too_large')
    if (
      page.records.length === CATALOG_NATIVE_IMPORT_MAX_ROWS ||
      page.byteLength + rowBytes + (page.records.length ? 1 : 0) > CATALOG_NATIVE_IMPORT_MAX_BYTES
    ) {
      pages.push(page)
      totalBytes += page.byteLength
      if (pages.length >= CATALOG_IMPORT_JOB_MAX_PAGES) throw new CatalogImportJobError('catalog_job_too_large')
      page = { index: pages.length, records: [], byteLength: envelopeBytes }
    }
    page.byteLength += rowBytes + (page.records.length ? 1 : 0)
    page.records.push(record)
    if (totalBytes + page.byteLength > CATALOG_IMPORT_JOB_MAX_BYTES)
      throw new CatalogImportJobError('catalog_job_too_large')
  }
  pages.push(page)
  return { pages, recordCount: length, totalBytes: totalBytes + page.byteLength }
}

function own(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const count = z.number().int().min(0).max(CATALOG_IMPORT_JOB_MAX_ROWS)
const totalPages = z.number().int().min(1).max(CATALOG_IMPORT_JOB_MAX_PAGES)
const recordCount = z.number().int().min(1).max(CATALOG_IMPORT_JOB_MAX_ROWS)
const reason = z
  .string()
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
  .transform((value) => value.trim())
  .pipe(z.string().min(3).max(500))
export const catalogImportJobSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      outcome: z.literal('job'),
      id: catalogPolicyUuidSchema,
      status: z.enum(['uploading', 'ready', 'applied', 'reverted']),
      createdAt: catalogPolicyInstantSchema,
      expiresAt: catalogPolicyInstantSchema,
      totalPages,
      receivedPages: z.number().int().min(0).max(CATALOG_IMPORT_JOB_MAX_PAGES),
      recordCount,
      hash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
      counts: z.object({ products: count, variants: count, assets: count, mappings: count }).strict(),
      policy: z
        .object({
          publication: z.literal('draft_only'),
          media: z.literal('pending_verification'),
          priceStock: z.literal('authorized_initialization')
        })
        .strict()
    })
    .strict()
    .refine((value) => {
      if (value.expiresAt <= value.createdAt || value.receivedPages > value.totalPages) return false
      const counts = Object.values(value.counts)
      if (counts.some((count) => count > value.recordCount)) return false
      if (value.status === 'uploading')
        return value.hash === null && (value.receivedPages > 0 || counts.every((count) => count === 0))
      return value.hash !== null && value.receivedPages === value.totalPages && counts.every((count) => count > 0)
    })
)
export type CatalogImportJob = z.infer<typeof catalogImportJobSchema>
export const catalogImportJobCreateInputSchema = z.preprocess(own, z.object({ totalPages, recordCount }).strict())
export type CatalogImportJobCreateInput = z.infer<typeof catalogImportJobCreateInputSchema>
export const catalogImportJobPageInputSchema = z.preprocess(
  own,
  z
    .object({
      index: z
        .number()
        .int()
        .min(0)
        .max(CATALOG_IMPORT_JOB_MAX_PAGES - 1),
      records: z.unknown()
    })
    .strict()
    .transform((value, context) => {
      const parsed = nativeImportInputSchema.safeParse({ records: value.records })
      if (!parsed.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_catalog_records' })
        return z.NEVER
      }
      return { index: value.index, records: parsed.data.records }
    })
)
export type CatalogImportJobPageInput = z.infer<typeof catalogImportJobPageInputSchema>
export const catalogImportJobFinalizeInputSchema = z.preprocess(own, z.object({ reason }).strict())
export type CatalogImportJobFinalizeInput = z.infer<typeof catalogImportJobFinalizeInputSchema>
export const catalogImportJobCommandInputSchema = nativeImportCommandInputSchema
export type CatalogImportJobCommandInput = z.infer<typeof catalogImportJobCommandInputSchema>
