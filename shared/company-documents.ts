import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const COMPANY_DOCUMENT_LIMIT = 5
export const COMPANY_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024
export const COMPANY_DOCUMENT_KINDS = [
  'tax_certificate',
  'commercial_register',
  'authorization_letter',
  'bank_certificate',
  'other'
] as const
export const COMPANY_DOCUMENT_TYPES = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png']
} as const
const noControl = (value: string) => ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
/** Metadata only: file bytes never enter this API; a scanned upload pipeline stays out of scope. */
export const companyDocumentInputSchema = z
  .object({
    kind: z.enum(COMPANY_DOCUMENT_KINDS),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => v === v.trim() && !/[\\/]/.test(v) && !v.includes('..') && noControl(v), 'unsafe_file_name'),
    contentType: z.enum(Object.keys(COMPANY_DOCUMENT_TYPES) as ['application/pdf', 'image/jpeg', 'image/png']),
    sizeBytes: z.number().int().min(1).max(COMPANY_DOCUMENT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
  .refine((v) => {
    const extension = v.fileName.split('.').pop()?.toLowerCase() ?? ''
    return (COMPANY_DOCUMENT_TYPES[v.contentType] as readonly string[]).includes(extension)
  }, 'extension_mismatch')
const documentShape = {
  id: catalogPolicyUuidSchema,
  companyId: catalogPolicyUuidSchema,
  kind: z.enum(COMPANY_DOCUMENT_KINDS),
  fileName: z.string().min(1).max(120),
  contentType: z.string(),
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['active', 'removed']),
  createdAt: catalogPolicyInstantSchema,
  removedAt: catalogPolicyInstantSchema.nullable()
}
export const companyDocumentSchema = z.object(documentShape).strict()
export const companyDocumentReceiptSchema = z
  .object({ source: z.literal('cloudflare'), commandId: catalogPolicyUuidSchema.nullable(), ...documentShape })
  .strict()
export const companyDocumentListSchema = z
  .object({
    source: z.literal('cloudflare'),
    companyStatus: z.enum(['pending', 'approved', 'rejected', 'suspended']),
    limit: z.literal(COMPANY_DOCUMENT_LIMIT),
    documents: z.array(companyDocumentSchema).max(COMPANY_DOCUMENT_LIMIT)
  })
  .strict()
export const companyDocumentReviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    companyId: catalogPolicyUuidSchema,
    documents: z
      .array(
        z
          .object({
            ...documentShape,
            createdBy: catalogPolicyUuidSchema,
            removedBy: catalogPolicyUuidSchema.nullable()
          })
          .strict()
      )
      .max(200)
  })
  .strict()
export type CompanyDocumentInput = z.input<typeof companyDocumentInputSchema>
export type CompanyDocumentReceipt = z.infer<typeof companyDocumentReceiptSchema>
export type CompanyDocumentList = z.infer<typeof companyDocumentListSchema>
