import { z } from 'zod'

export class CostToServeError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'service_unavailable',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'CostToServeError'
  }
}

export const profitabilityTierSchema = z.enum(['high_margin', 'healthy_margin', 'low_margin', 'loss_making'])
export type ProfitabilityTier = z.infer<typeof profitabilityTierSchema>

export const calculateCostToServeInputSchema = z
  .object({
    orderId: z.string().trim().min(1).max(100),
    expectedVersion: z.number().int().nonnegative().default(0),
    cogsCents: z.number().int().nonnegative(),
    discountCents: z.number().int().nonnegative().default(0),
    paymentFeeCents: z.number().int().nonnegative().default(0),
    pickingCostCents: z.number().int().nonnegative().default(0),
    shippingRealCostCents: z.number().int().nonnegative().default(0),
    returnsCostCents: z.number().int().nonnegative().default(0),
    supportCostCents: z.number().int().nonnegative().default(0),
    notes: z.string().trim().max(1000).optional(),
    commandId: z.string().trim().max(128).optional()
  })
  .strict()

export type CalculateCostToServeInput = z.infer<typeof calculateCostToServeInputSchema>

export const costToServeFilterSchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    profitabilityTier: profitabilityTierSchema.optional(),
    orderId: z.string().trim().max(100).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0)
  })
  .strict()

export type CostToServeFilter = z.infer<typeof costToServeFilterSchema>

export interface OrderCostToServeRecord {
  id: string
  orderId: string
  currency: string
  grossRevenueCents: number
  netRevenueCents: number
  taxCents: number
  cogsCents: number
  discountCents: number
  paymentFeeCents: number
  pickingCostCents: number
  shippingRealCostCents: number
  returnsCostCents: number
  supportCostCents: number
  totalCostToServeCents: number
  contributionMarginCents: number
  marginRatio: number
  profitabilityTier: ProfitabilityTier
  costBreakdownJson: string
  version: number
  createdAt: string
  updatedAt: string
  idempotentReplay?: boolean
}

export interface CostToServeTiersBreakdown {
  highMarginCount: number
  healthyMarginCount: number
  lowMarginCount: number
  lossMakingCount: number
}

export interface CostToServeSummary {
  totalOrdersAnalyzed: number
  totalGrossRevenueCents: number
  totalNetRevenueCents: number
  totalTaxCents: number
  totalCogsCents: number
  totalDiscountCents: number
  totalPaymentFeeCents: number
  totalPickingCostCents: number
  totalShippingRealCostCents: number
  totalReturnsCostCents: number
  totalSupportCostCents: number
  totalCostToServeCents: number
  totalContributionMarginCents: number
  overallMarginRatio: number
  profitableOrdersCount: number
  lossMakingOrdersCount: number
  lossMakingRate: number
  tiersBreakdown: CostToServeTiersBreakdown
}

export interface CostToServeDashboardResponse {
  summary: CostToServeSummary
  orders: OrderCostToServeRecord[]
}

export function classifyProfitabilityTier(marginRatio: number): ProfitabilityTier {
  if (marginRatio < 0) return 'loss_making'
  if (marginRatio < 0.1) return 'low_margin'
  if (marginRatio < 0.3) return 'healthy_margin'
  return 'high_margin'
}
