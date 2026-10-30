import { z } from 'zod'

export class SeoContentDashboardError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden' | 'invalid_input' | 'not_found' | 'conflict' | 'service_unavailable',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'SeoContentDashboardError'
  }
}

export const seoDeviceSchema = z.enum(['desktop', 'mobile', 'tablet', 'all'])
export type SeoDevice = z.infer<typeof seoDeviceSchema>

export const seoContentCostTypeSchema = z.enum(['copywriting', 'translation', 'design', 'update', 'audit', 'general'])
export type SeoContentCostType = z.infer<typeof seoContentCostTypeSchema>

export const seoMetricItemSchema = z
  .object({
    landingPath: z.string().trim().min(1).max(500),
    query: z.string().trim().min(1).max(250),
    device: seoDeviceSchema.default('all'),
    impressions: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    avgPosition: z.number().nonnegative(),
    assistedOrdersCount: z.number().int().nonnegative().default(0),
    assistedRevenueGrossCents: z.number().int().nonnegative().default(0),
    assistedRevenueNetCents: z.number().int().nonnegative().default(0)
  })
  .strict()
  .refine((data) => data.clicks <= data.impressions, {
    message: 'Clicks cannot exceed impressions'
  })

export type SeoMetricItem = z.infer<typeof seoMetricItemSchema>

export const syncSeoMetricsInputSchema = z
  .object({
    syncDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dataThroughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: z.string().trim().min(1).max(100),
    metrics: z.array(seoMetricItemSchema).min(1).max(1000)
  })
  .strict()

export type SyncSeoMetricsInput = z.infer<typeof syncSeoMetricsInputSchema>

export const recordSeoCostInputSchema = z
  .object({
    landingPath: z.string().trim().min(1).max(500),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    costCents: z.number().int().nonnegative(),
    costType: seoContentCostTypeSchema,
    description: z.string().trim().min(1).max(500)
  })
  .strict()
  .refine((data) => data.periodEnd >= data.periodStart, {
    message: 'periodEnd must be after or equal to periodStart'
  })

export type RecordSeoCostInput = z.infer<typeof recordSeoCostInputSchema>

export const seoDashboardFilterSchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    device: seoDeviceSchema.optional(),
    landingPath: z.string().trim().max(500).optional(),
    query: z.string().trim().max(250).optional()
  })
  .strict()

export type SeoDashboardFilter = z.infer<typeof seoDashboardFilterSchema>

export interface SeoSummary {
  totalImpressions: number
  totalClicks: number
  overallCtr: number
  avgPosition: number
  assistedOrdersCount: number
  assistedRevenueGrossCents: number
  assistedRevenueNetCents: number
  totalContentCostCents: number
  seoRoi: number
}

export interface SeoQueryItem {
  query: string
  impressions: number
  clicks: number
  ctr: number
  avgPosition: number
  assistedOrdersCount: number
  assistedRevenueGrossCents: number
  assistedRevenueNetCents: number
}

export interface SeoLandingItem {
  landingPath: string
  impressions: number
  clicks: number
  ctr: number
  avgPosition: number
  assistedOrdersCount: number
  assistedRevenueGrossCents: number
  assistedRevenueNetCents: number
  contentCostCents: number
  seoRoi: number
}

export interface SeoSyncStatus {
  status: 'synced' | 'pending' | 'never'
  dataThroughDate: string | null
  lastSyncAt: string | null
}

export interface SeoContentDashboardResponse {
  summary: SeoSummary
  queries: SeoQueryItem[]
  landingPages: SeoLandingItem[]
  syncStatus: SeoSyncStatus
}
