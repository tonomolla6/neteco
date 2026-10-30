import { z } from 'zod'

export class B2bSalesMetricsError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'service_unavailable',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'B2bSalesMetricsError'
  }
}

export const b2bMetricsFilterSchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    companyId: z.string().trim().max(100).optional()
  })
  .strict()

export type B2bMetricsFilter = z.infer<typeof b2bMetricsFilterSchema>

export const recordB2bDailySnapshotSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    totalCompanies: z.number().int().nonnegative(),
    approvedCompanies: z.number().int().nonnegative(),
    activatedCompanies: z.number().int().nonnegative(),
    ordersCount: z.number().int().nonnegative(),
    revenueGrossCents: z.number().int().nonnegative(),
    revenueNetCents: z.number().int().nonnegative(),
    averageOrderValueCents: z.number().int().nonnegative(),
    creditLimitTotalCents: z.number().int().nonnegative(),
    creditUtilizedCents: z.number().int().nonnegative(),
    overdueCents: z.number().int().nonnegative(),
    blockedCompaniesCount: z.number().int().nonnegative()
  })
  .strict()

export type RecordB2bDailySnapshotInput = z.infer<typeof recordB2bDailySnapshotSchema>

export interface B2bActivationMetrics {
  totalRegisteredCompanies: number
  approvedCompanies: number
  activatedCompanies: number
  activationRate: number
  avgDaysToFirstOrder: number
  pendingActivationAging: {
    under30Days: number
    days30to90: number
    over90Days: number
  }
}

export interface B2bConversionMetrics {
  ordersCount: number
  revenueNetCents: number
  averageOrderValueCents: number
  checkoutsCompleted: number
}

export interface B2bRecurrenceMetrics {
  oneTimeBuyers: number
  repeatBuyers: number
  repeatPurchaseRate: number
  avgDaysBetweenOrders: number
}

export interface B2bPaymentTermsDistributionItem {
  paymentDays: number
  companiesCount: number
}

export interface B2bPricingTierDistributionItem {
  priceListId: string
  companiesCount: number
}

export interface B2bCommercialTermsMetrics {
  paymentTermsDistribution: B2bPaymentTermsDistributionItem[]
  creditExposure: {
    totalCreditLimitCents: number
    blockedCompaniesCount: number
  }
  pricingTiersDistribution: B2bPricingTierDistributionItem[]
}

export interface B2bTopCompanyItem {
  companyId: string
  legalName: string
  ordersCount: number
  revenueNetCents: number
}

export interface B2bSalesMetricsResponse {
  activation: B2bActivationMetrics
  conversion: B2bConversionMetrics
  recurrence: B2bRecurrenceMetrics
  commercialTerms: B2bCommercialTermsMetrics
  topCompanies: B2bTopCompanyItem[]
}
