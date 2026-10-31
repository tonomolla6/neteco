import { z } from 'zod'

export const ACCREDITED_STANDARDS = [
  'ISO-9001',
  'ISO-14001',
  'ECOLABEL-EU',
  'UNE-EN-ISO-22716',
  'ADR-SAFETY-CONSULTANT',
  'ROESB-BIOCIDAS',
  'IFS-HPC'
] as const

export const accreditedStandardSchema = z.enum(ACCREDITED_STANDARDS)
export type AccreditedStandard = z.infer<typeof accreditedStandardSchema>

export const brandAssetCategorySchema = z.enum(['logo', 'symbol', 'guideline', 'typography', 'palette'])
export type BrandAssetCategory = z.infer<typeof brandAssetCategorySchema>

export const brandAssetVariantSchema = z.enum(['primary', 'monochrome', 'negative', 'symbol', 'spec'])
export type BrandAssetVariant = z.infer<typeof brandAssetVariantSchema>

export const brandAssetFormatSchema = z.enum(['svg', 'png', 'pdf', 'json'])
export type BrandAssetFormat = z.infer<typeof brandAssetFormatSchema>

export const brandAssetSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    category: brandAssetCategorySchema,
    format: brandAssetFormatSchema,
    variant: brandAssetVariantSchema,
    url: z.string().trim().min(5).max(500),
    minClearspacePx: z.number().int().nonnegative(),
    prohibitedUses: z.array(z.string().trim().min(3).max(300)),
    status: z.enum(['active', 'deprecated']),
    version: z.number().int().positive(),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type BrandAsset = z.infer<typeof brandAssetSchema>

export const brandAuthorizationScopeSchema = z.enum([
  'distribuidor_oficial',
  'partner_logistico',
  'proveedor_homologado',
  'prensa_medios'
])
export type BrandAuthorizationScope = z.infer<typeof brandAuthorizationScopeSchema>

export const brandAuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    partnerName: z.string().trim().min(2).max(160),
    authorizedDomain: z.string().trim().min(3).max(160),
    scope: brandAuthorizationScopeSchema,
    status: z.enum(['active', 'revoked', 'expired']),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable(),
    authorizedBy: z.string().uuid(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type BrandAuthorization = z.infer<typeof brandAuthorizationSchema>

export const officialCertificationSchema = z
  .object({
    id: z.string().uuid(),
    standardCode: accreditedStandardSchema,
    title: z.string().trim().min(3).max(200),
    issuer: z.string().trim().min(2).max(160),
    certificateNumber: z.string().trim().min(3).max(100),
    scope: z.string().trim().min(10).max(1000),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    verificationUrl: z.string().url().max(500),
    documentUrl: z.string().max(500),
    status: z.enum(['active', 'expired', 'suspended']),
    version: z.number().int().positive(),
    auditedBy: z.string().trim().min(2).max(120),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
  .refine((cert) => cert.validUntil > cert.validFrom, {
    message: 'validUntil must be after validFrom'
  })
export type OfficialCertification = z.infer<typeof officialCertificationSchema>

export const brandCenterViewSchema = z
  .object({
    source: z.literal('cloudflare'),
    brandAssets: z.array(brandAssetSchema),
    certifications: z.array(officialCertificationSchema),
    authorizations: z.array(brandAuthorizationSchema),
    usageGuidelines: z.object({
      generalRules: z.array(z.string()),
      minimumClearspaceFormula: z.string(),
      unauthorizedPractices: z.array(z.string())
    }),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .strict()
export type BrandCenterView = z.infer<typeof brandCenterViewSchema>

export const createCertificationInputSchema = z
  .object({
    commandId: z.string().uuid(),
    standardCode: accreditedStandardSchema,
    title: z.string().trim().min(3).max(200),
    issuer: z.string().trim().min(2).max(160),
    certificateNumber: z.string().trim().min(3).max(100),
    scope: z.string().trim().min(10).max(1000),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    verificationUrl: z.string().url().max(500),
    documentUrl: z.string().max(500),
    auditedBy: z.string().trim().min(2).max(120)
  })
  .strict()
  .refine((cert) => cert.validUntil > cert.validFrom, {
    message: 'validUntil must be after validFrom'
  })
export type CreateCertificationInput = z.infer<typeof createCertificationInputSchema>

export const authorizePartnerInputSchema = z
  .object({
    commandId: z.string().uuid(),
    partnerName: z.string().trim().min(2).max(160),
    authorizedDomain: z.string().trim().min(3).max(160),
    scope: brandAuthorizationScopeSchema,
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .nullable()
  })
  .strict()
export type AuthorizePartnerInput = z.infer<typeof authorizePartnerInputSchema>
