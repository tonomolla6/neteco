import { z } from 'zod'

export const ediContractVersionSchema = z.enum(['2026-01', '2026-10'])
export type EdiContractVersion = z.infer<typeof ediContractVersionSchema>

export const ediEnvironmentSchema = z.enum(['sandbox', 'live'])
export type EdiEnvironment = z.infer<typeof ediEnvironmentSchema>

export const ediClientStatusSchema = z.enum(['active', 'suspended', 'revoked'])
export type EdiClientStatus = z.infer<typeof ediClientStatusSchema>

export const ediClientRegisterInputSchema = z
  .object({
    companyId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    environment: ediEnvironmentSchema.default('sandbox'),
    rateLimitPerMinute: z.number().int().min(1).max(10000).default(60),
    dailyRequestQuota: z.number().int().min(10).max(1000000).default(5000),
    supportedVersions: z.array(ediContractVersionSchema).min(1).default(['2026-01', '2026-10'])
  })
  .strict()

export type EdiClientRegisterInput = z.infer<typeof ediClientRegisterInputSchema>

export const ediApiKeyCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    expiresAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .optional()
      .nullable()
  })
  .strict()

export type EdiApiKeyCreateInput = z.infer<typeof ediApiKeyCreateInputSchema>

export const ediOrderLineInputSchema = z
  .object({
    variantId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(999),
    expectedUnitGrossCents: z.number().int().min(0).optional().nullable()
  })
  .strict()

export const ediOrderPlacementInputSchema = z
  .object({
    orderReference: z.string().trim().min(1).max(80),
    lines: z.array(ediOrderLineInputSchema).min(1).max(100),
    shippingAddress: z
      .object({
        street: z.string().trim().min(1).max(200),
        postalCode: z.string().trim().min(3).max(12),
        city: z.string().trim().min(1).max(100),
        countryCode: z.string().length(2).default('ES')
      })
      .strict(),
    contactEmail: z.string().trim().email().max(254),
    simulateError: z.enum(['out_of_stock', 'pricing_mismatch', 'invalid_address']).optional().nullable()
  })
  .strict()

export type EdiOrderPlacementInput = z.infer<typeof ediOrderPlacementInputSchema>

export interface EdiOrderResponseLine {
  variantId: string
  quantity: number
  unitGrossCents: number
  totalGrossCents: number
  status: 'confirmed' | 'backordered' | 'unavailable'
}

export interface EdiOrderResponse {
  ediOrderId: string
  clientReference: string
  environment: EdiEnvironment
  contractVersion: EdiContractVersion
  status: 'accepted' | 'sandbox_accepted' | 'rejected'
  currency: 'EUR'
  totalGrossCents: number
  lines: EdiOrderResponseLine[]
  estimatedDeliveryDate: string
  idempotentReplay: boolean
  createdAt: string
}

export interface EdiMonitoringSummary {
  clientId: string
  clientName: string
  environment: EdiEnvironment
  contractVersions: EdiContractVersion[]
  requestsToday: number
  dailyQuota: number
  quotaRemaining: number
  rateLimitPerMinute: number
  successCount: number
  errorCount: number
  averageLatencyMs: number
  p95LatencyMs: number
  recentLogs: Array<{
    id: string
    endpoint: string
    contractVersion: string
    statusCode: number
    latencyMs: number
    payloadSizeBytes: number
    errorCode: string | null
    createdAt: string
  }>
}
