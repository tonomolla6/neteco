import { z } from 'zod'
import { COMPANY_STATUSES } from '../server/domain/company'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'

export const companyReviewStatusSchema = z.enum(COMPANY_STATUSES)
export const companyReviewQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .transform((value) => value.normalize('NFC'))
      .default(''),
    status: companyReviewStatusSchema.optional(),
    page: z.number().int().min(1).max(100000).default(1),
    perPage: z.number().int().min(1).max(50).default(20)
  })
  .strict()
export const companyReviewInputSchema = z
  .object({
    expectedChangeId: z.string().uuid().nullable(),
    expectedStatus: companyReviewStatusSchema,
    status: companyReviewStatusSchema,
    reason: z.string().trim().min(3).max(500)
  })
  .strict()
export const companyReviewItemSchema = z
  .object({
    id: z.string().uuid(),
    legalName: z.string().min(1).max(200),
    tradeName: z.string().min(1).max(200).nullable(),
    taxId: z.string().min(3).max(32).nullable(),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    status: companyReviewStatusSchema,
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema,
    contactEmail: z.string().email().max(320).nullable(),
    currentChangeId: z.string().uuid().nullable(),
    reviewedAt: catalogPolicyInstantSchema.nullable(),
    rejectionReason: z.string().max(500).nullable()
  })
  .strict()
export const companyReviewListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(companyReviewItemSchema).max(50),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive(),
    perPage: z.number().int().min(1).max(50)
  })
  .strict()
export const companyReviewReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    status: companyReviewStatusSchema,
    changeId: z.string().uuid(),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
  .refine((value) => value.changeId === value.commandId)
export const companyReviewCommandSchema = z
  .object({
    source: z.literal('cloudflare'),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    outcome: z.enum(['applied', 'unknown']),
    receipt: companyReviewReceiptSchema.nullable()
  })
  .strict()
  .refine((value) =>
    value.outcome === 'applied'
      ? value.receipt !== null &&
        value.receipt.companyId === value.companyId &&
        value.receipt.commandId === value.commandId
      : value.receipt === null
  )
export type CompanyReviewInput = z.infer<typeof companyReviewInputSchema>
export type CompanyReviewItem = z.infer<typeof companyReviewItemSchema>
export type CompanyReviewQuery = z.infer<typeof companyReviewQuerySchema>
export type CompanyReviewReceipt = z.infer<typeof companyReviewReceiptSchema>
