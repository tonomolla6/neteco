import { z } from 'zod'

export const TARGET_TYPES = ['customer', 'company', 'sector'] as const
export const TARIFF_TYPES = ['percentage_discount', 'fixed_price', 'rate_table', 'rebate_bonus'] as const
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'] as const

export const PROHIBITED_KEYS = [
  'sede',
  'sedeid',
  'sede_id',
  'branch',
  'branchid',
  'branch_id',
  'site',
  'siteid',
  'site_id',
  'store',
  'storeid',
  'store_id',
  'hierarchy',
  'buyerhierarchy',
  'buyer_hierarchy',
  'delegatedbuyer',
  'delegated_buyer',
  'departmenthead',
  'department_head'
]

export function validateStrictNoSedeNoHierarchy(payload: Record<string, unknown>): {
  valid: boolean
  reason?: string
} {
  const keys = Object.keys(payload).map((k) => k.toLowerCase().replace(/[-_]/g, ''))
  for (const forbidden of PROHIBITED_KEYS) {
    const normalizedForbidden = forbidden.replace(/[-_]/g, '')
    if (keys.some((k) => k.includes(normalizedForbidden))) {
      return {
        valid: false,
        reason: `Targeting o segmentación por sede o jerarquía de compradores estrictamente prohibido en NETECO (almacén único y estructura plana). Campo no permitido detectado.`
      }
    }
  }
  return { valid: true }
}

export const targetedCampaignBaseSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'Código debe contener solo caracteres alfanuméricos, guiones y guiones bajos'),
  name: z.string().min(3).max(200),
  description: z.string().min(5).max(1000),
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().min(1).max(64),
  tariffType: z.enum(TARIFF_TYPES),
  discountPercent: z.number().int().min(1).max(50).optional(),
  fixedPriceCents: z.number().int().positive().optional(),
  rateTableCode: z.string().min(1).max(32).optional(),
  minOrderNetCents: z.number().int().min(0).default(0),
  marginFloorBasisPoints: z.number().int().min(500).max(5000).default(1500),
  startAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'startAt debe tener formato ISO YYYY-MM-DDTHH:MM:SSZ'),
  endAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'endAt debe tener formato ISO YYYY-MM-DDTHH:MM:SSZ'),
  status: z.enum(CAMPAIGN_STATUSES).default('draft')
})

export const createTargetedCampaignSchema = targetedCampaignBaseSchema
  .refine((data) => data.endAt >= data.startAt, {
    message: 'endAt debe ser igual o posterior a startAt',
    path: ['endAt']
  })
  .refine((data) => validateStrictNoSedeNoHierarchy(data as unknown as Record<string, unknown>).valid, {
    message: 'No se permite targeting por sede o jerarquía',
    path: ['targetType']
  })

export type CreateTargetedCampaignInput = z.infer<typeof createTargetedCampaignSchema>

export const updateTargetedCampaignSchema = targetedCampaignBaseSchema.partial().extend({
  version: z.number().int().min(1)
})

export type UpdateTargetedCampaignInput = z.infer<typeof updateTargetedCampaignSchema>

export interface TargetedCampaign {
  id: string
  code: string
  name: string
  description: string
  targetType: 'customer' | 'company' | 'sector'
  targetId: string
  tariffType: 'percentage_discount' | 'fixed_price' | 'rate_table' | 'rebate_bonus'
  discountPercent: number | null
  fixedPriceCents: number | null
  rateTableCode: string | null
  minOrderNetCents: number
  marginFloorBasisPoints: number
  startAt: string
  endAt: string
  status: 'draft' | 'active' | 'paused' | 'completed'
  version: number
  createdAt: string
  updatedAt: string
}

export interface CampaignDispatchItem {
  id: string
  campaignId: string
  customerId: string
  status: 'dispatched' | 'opened' | 'clicked' | 'converted' | 'bounced' | 'suppressed'
  openedAt: string | null
  clickedAt: string | null
  convertedAt: string | null
  convertedOrderId: string | null
  revenueNetCents: number
}

export interface CampaignReportingMetrics {
  totalDispatched: number
  totalOpened: number
  totalClicked: number
  totalConverted: number
  totalRevenueNetCents: number
  openRatePercent: number
  clickRatePercent: number
  conversionRatePercent: number
}

export function computeCampaignMetrics(dispatches: CampaignDispatchItem[]): CampaignReportingMetrics {
  const totalDispatched = dispatches.length
  if (totalDispatched === 0) {
    return {
      totalDispatched: 0,
      totalOpened: 0,
      totalClicked: 0,
      totalConverted: 0,
      totalRevenueNetCents: 0,
      openRatePercent: 0,
      clickRatePercent: 0,
      conversionRatePercent: 0
    }
  }

  let totalOpened = 0
  let totalClicked = 0
  let totalConverted = 0
  let totalRevenueNetCents = 0

  for (const d of dispatches) {
    if (d.openedAt || ['opened', 'clicked', 'converted'].includes(d.status)) {
      totalOpened += 1
    }
    if (d.clickedAt || ['clicked', 'converted'].includes(d.status)) {
      totalClicked += 1
    }
    if (d.convertedAt || d.status === 'converted') {
      totalConverted += 1
      totalRevenueNetCents += d.revenueNetCents ?? 0
    }
  }

  const openRatePercent = Number(((totalOpened / totalDispatched) * 100).toFixed(1))
  const clickRatePercent = Number(((totalClicked / totalDispatched) * 100).toFixed(1))
  const conversionRatePercent = Number(((totalConverted / totalDispatched) * 100).toFixed(1))

  return {
    totalDispatched,
    totalOpened,
    totalClicked,
    totalConverted,
    totalRevenueNetCents,
    openRatePercent,
    clickRatePercent,
    conversionRatePercent
  }
}
