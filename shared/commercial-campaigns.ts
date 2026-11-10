import { z } from 'zod'

export const CAMPAIGN_ASSET_TYPES = ['banner', 'promotion', 'modal', 'email', 'landing'] as const
export type CampaignAssetType = (typeof CAMPAIGN_ASSET_TYPES)[number]

export const CAMPAIGN_CHANNEL_TYPES = ['omnichannel', 'web', 'email', 'mobile'] as const
export type CampaignChannelType = (typeof CAMPAIGN_CHANNEL_TYPES)[number]

export const CAMPAIGN_AUDIENCES = ['all', 'b2b', 'b2c', 'vip', 'new_customers'] as const
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number]

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled'] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export interface CommercialCampaign {
  id: string
  code: string
  name: string
  description: string
  status: CampaignStatus
  channelType: CampaignChannelType
  targetAudience: CampaignAudience
  priority: number
  budgetLimitCents?: number | null
  startAt: string
  endAt: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface CampaignLinkedAsset {
  id: string
  campaignId: string
  assetType: CampaignAssetType
  assetId: string
  assetName: string
  placementOrSlot?: string | null
  startAt: string
  endAt: string
  status: 'linked' | 'active' | 'inactive' | 'paused'
  config?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface CampaignConflict {
  conflictId: string
  type: 'banner_slot_overlap' | 'modal_collision' | 'promotion_clash' | 'email_schedule_fatigue' | 'date_inconsistency'
  severity: 'critical' | 'warning'
  message: string
  placementOrSlot?: string
  campaignA: {
    id: string
    code: string
    name: string
    startAt: string
    endAt: string
  }
  campaignB: {
    id: string
    code: string
    name: string
    startAt: string
    endAt: string
  }
  assetA?: {
    id: string
    assetType: CampaignAssetType
    assetId: string
    assetName: string
  }
  assetB?: {
    id: string
    assetType: CampaignAssetType
    assetId: string
    assetName: string
  }
}

export interface CommercialCalendarDay {
  date: string
  campaignsCount: number
  campaigns: Array<{ id: string; name: string; priority: number; status: string }>
  assets: Array<{ id: string; campaignId: string; assetType: CampaignAssetType; assetName: string; placement?: string }>
  conflicts: CampaignConflict[]
}

export interface CommercialCalendarFeed {
  month: string
  campaigns: CommercialCampaign[]
  days: CommercialCalendarDay[]
  activeConflicts: CampaignConflict[]
}

export const createCommercialCampaignSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    code: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    name: z.string().trim().min(3).max(200),
    description: z.string().trim().max(2000).default(''),
    channelType: z.enum(CAMPAIGN_CHANNEL_TYPES),
    targetAudience: z.enum(CAMPAIGN_AUDIENCES).default('all'),
    priority: z.number().int().min(1).max(100).default(50),
    budgetLimitCents: z.number().int().min(0).optional(),
    startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    endAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    now: z.string().optional()
  })
  .strict()
  .refine((d) => d.endAt >= d.startAt, { message: 'endAt must be >= startAt', path: ['endAt'] })

export const linkCampaignAssetSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    campaignId: z.string().uuid(),
    assetType: z.enum(CAMPAIGN_ASSET_TYPES),
    assetId: z.string().trim().min(1).max(100),
    assetName: z.string().trim().min(2).max(200),
    placementOrSlot: z.string().trim().min(1).max(100).optional(),
    startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    endAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    config: z.record(z.string(), z.unknown()).optional(),
    now: z.string().optional()
  })
  .strict()
  .refine((d) => d.endAt >= d.startAt, { message: 'endAt must be >= startAt', path: ['endAt'] })

export const updateCommercialCampaignSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    expectedVersion: z.number().int().min(0),
    name: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    priority: z.number().int().min(1).max(100).optional(),
    startAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .optional(),
    endAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      .optional()
  })
  .strict()
  .refine((d) => !d.startAt || !d.endAt || d.endAt >= d.startAt, {
    message: 'endAt must be >= startAt',
    path: ['endAt']
  })

function datesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA <= endB && startB <= endA
}

export function detectCommercialCampaignConflicts(
  campaigns: Array<{
    id: string
    code: string
    name: string
    startAt: string
    endAt: string
    targetAudience?: string
  }>,
  assets: Array<{
    id: string
    campaignId: string
    assetType: CampaignAssetType
    assetId: string
    assetName: string
    placementOrSlot?: string | null
    startAt: string
    endAt: string
  }>
): CampaignConflict[] {
  const conflicts: CampaignConflict[] = []
  const campMap = new Map(campaigns.map((c) => [c.id, c]))

  // 1. Check Banner slot overlaps
  const banners = assets.filter((a) => a.assetType === 'banner' && a.placementOrSlot)
  for (let i = 0; i < banners.length; i++) {
    for (let j = i + 1; j < banners.length; j++) {
      const b1 = banners[i]
      const b2 = banners[j]
      if (!b1 || !b2) continue
      if (b1.campaignId !== b2.campaignId && b1.placementOrSlot === b2.placementOrSlot) {
        if (datesOverlap(b1.startAt, b1.endAt, b2.startAt, b2.endAt)) {
          const c1 = campMap.get(b1.campaignId)
          const c2 = campMap.get(b2.campaignId)
          if (c1 && c2) {
            conflicts.push({
              conflictId: `conflict-banner-${b1.id}-${b2.id}`,
              type: 'banner_slot_overlap',
              severity: 'critical',
              message: `Colisión en slot de banner '${b1.placementOrSlot}': '${c1.name}' y '${c2.name}' programados simultáneamente.`,
              placementOrSlot: b1.placementOrSlot ?? undefined,
              campaignA: { id: c1.id, code: c1.code, name: c1.name, startAt: c1.startAt, endAt: c1.endAt },
              campaignB: { id: c2.id, code: c2.code, name: c2.name, startAt: c2.startAt, endAt: c2.endAt },
              assetA: { id: b1.id, assetType: 'banner', assetId: b1.assetId, assetName: b1.assetName },
              assetB: { id: b2.id, assetType: 'banner', assetId: b2.assetId, assetName: b2.assetName }
            })
          }
        }
      }
    }
  }

  // 2. Check Modal collisions
  const modals = assets.filter((a) => a.assetType === 'modal')
  for (let i = 0; i < modals.length; i++) {
    for (let j = i + 1; j < modals.length; j++) {
      const m1 = modals[i]
      const m2 = modals[j]
      if (!m1 || !m2) continue
      if (m1.campaignId !== m2.campaignId) {
        if (datesOverlap(m1.startAt, m1.endAt, m2.startAt, m2.endAt)) {
          const c1 = campMap.get(m1.campaignId)
          const c2 = campMap.get(m2.campaignId)
          if (c1 && c2) {
            conflicts.push({
              conflictId: `conflict-modal-${m1.id}-${m2.id}`,
              type: 'modal_collision',
              severity: 'critical',
              message: `Múltiples modales programados en las mismas fechas: '${m1.assetName}' y '${m2.assetName}'.`,
              campaignA: { id: c1.id, code: c1.code, name: c1.name, startAt: c1.startAt, endAt: c1.endAt },
              campaignB: { id: c2.id, code: c2.code, name: c2.name, startAt: c2.startAt, endAt: c2.endAt },
              assetA: { id: m1.id, assetType: 'modal', assetId: m1.assetId, assetName: m1.assetName },
              assetB: { id: m2.id, assetType: 'modal', assetId: m2.assetId, assetName: m2.assetName }
            })
          }
        }
      }
    }
  }

  // 3. Check Email fatigue clashes (emails dispatched on same day for same audience)
  const emails = assets.filter((a) => a.assetType === 'email')
  for (let i = 0; i < emails.length; i++) {
    for (let j = i + 1; j < emails.length; j++) {
      const e1 = emails[i]
      const e2 = emails[j]
      if (!e1 || !e2) continue
      if (e1.campaignId !== e2.campaignId) {
        const day1 = e1.startAt.slice(0, 10)
        const day2 = e2.startAt.slice(0, 10)
        if (day1 === day2) {
          const c1 = campMap.get(e1.campaignId)
          const c2 = campMap.get(e2.campaignId)
          if (
            c1 &&
            c2 &&
            (c1.targetAudience === c2.targetAudience || c1.targetAudience === 'all' || c2.targetAudience === 'all')
          ) {
            conflicts.push({
              conflictId: `conflict-email-${e1.id}-${e2.id}`,
              type: 'email_schedule_fatigue',
              severity: 'warning',
              message: `Riesgo de fatiga por email en fecha ${day1}: dos envíos programados ('${e1.assetName}' y '${e2.assetName}').`,
              campaignA: { id: c1.id, code: c1.code, name: c1.name, startAt: c1.startAt, endAt: c1.endAt },
              campaignB: { id: c2.id, code: c2.code, name: c2.name, startAt: c2.startAt, endAt: c2.endAt },
              assetA: { id: e1.id, assetType: 'email', assetId: e1.assetId, assetName: e1.assetName },
              assetB: { id: e2.id, assetType: 'email', assetId: e2.assetId, assetName: e2.assetName }
            })
          }
        }
      }
    }
  }

  return conflicts
}
