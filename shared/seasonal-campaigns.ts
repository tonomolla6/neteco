import { z } from 'zod'

export const SECTOR_TYPES = [
  'horeca',
  'healthcare',
  'education',
  'industrial',
  'facility_services',
  'food_processing',
  'general_b2b'
] as const
export type SectorType = (typeof SECTOR_TYPES)[number]

export const SECTOR_LABELS: Record<SectorType, string> = {
  horeca: 'Hostelería y Restauración (HORECA)',
  healthcare: 'Sanidad, Clínicas y Residencias',
  education: 'Centros Educativos y Colegios',
  industrial: 'Industria, Fabricación y Talleres',
  facility_services: 'Empresas de Limpieza Profesional',
  food_processing: 'Industria Agroalimentaria',
  general_b2b: 'Comercio General y Oficinas'
}

export const SEASON_TYPES = ['spring', 'summer', 'autumn', 'winter', 'all_year', 'custom'] as const
export type SeasonType = (typeof SEASON_TYPES)[number]

export const SEASON_LABELS: Record<SeasonType, string> = {
  spring: 'Primavera',
  summer: 'Verano',
  autumn: 'Otoño',
  winter: 'Invierno',
  all_year: 'Todo el año',
  custom: 'Especial / Personalizada'
}

export const CAMPAIGN_STATUSES = ['draft', 'planned', 'active', 'paused', 'completed', 'cancelled'] as const
export type SeasonalCampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export const POSTMORTEM_STATUSES = ['draft', 'approved', 'archived'] as const
export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number]

// Pillar 1: Need
export const needPillarSchema = z.object({
  needJustification: z.string().trim().min(10).max(2000),
  targetCustomerProfile: z.enum([
    'all_b2b',
    'horeca_operators',
    'industrial_plants',
    'facility_contractors',
    'clinics_residencias',
    'educational_centers'
  ])
})
export type NeedPillar = z.infer<typeof needPillarSchema>

// Pillar 2: Window
export const windowPillarSchema = z
  .object({
    procurementStartAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    windowStartAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    windowEndAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
  .superRefine((data, ctx) => {
    if (data.windowStartAt < data.procurementStartAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'windowStartAt must be on or after procurementStartAt',
        path: ['windowStartAt']
      })
    }
    if (data.windowEndAt < data.windowStartAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'windowEndAt must be on or after windowStartAt',
        path: ['windowEndAt']
      })
    }
  })
export type WindowPillar = z.infer<typeof windowPillarSchema>

// Pillar 3: Inventory
export const inventoryItemSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  variantId: z.string().trim().min(1).max(100),
  plannedUnits: z.number().int().min(1).max(100_000),
  safetyStockUnits: z.number().int().min(0).max(50_000),
  maxAllocationUnits: z.number().int().min(1).max(200_000)
})

export const inventoryPillarSchema = z.object({
  items: z.array(inventoryItemSchema).min(1).max(100),
  bufferPercentage: z.number().int().min(0).max(100).default(15)
})
export type InventoryPillar = z.infer<typeof inventoryPillarSchema>

// Pillar 4: Logistics
export const logisticsPillarSchema = z.object({
  allowedProfiles: z.array(z.enum(['parcel', 'pallet', 'adr'])).min(1),
  carrierNotes: z.string().trim().max(1000).optional(),
  packagingGuidelines: z.string().trim().max(1000).optional(),
  maxLeadTimeDays: z.number().int().min(1).max(60).default(5),
  localDeliveryPriority: z.boolean().default(false)
})
export type LogisticsPillar = z.infer<typeof logisticsPillarSchema>

// Pillar 5: Content
export const contentPillarSchema = z.object({
  landingSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  bannerSlots: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  emailCampaignCode: z.string().trim().max(100).optional(),
  marketingTags: z.array(z.string().trim().min(1).max(50)).max(20).default([])
})
export type ContentPillar = z.infer<typeof contentPillarSchema>

// Pillar 6: Margin & Financials
export const marginPillarSchema = z.object({
  targetRevenueCents: z.number().int().min(0),
  budgetLimitCents: z.number().int().min(0),
  minMarginBasisPoints: z.number().int().min(0).max(10000),
  maxDiscountBasisPoints: z.number().int().min(0).max(10000)
})
export type MarginPillar = z.infer<typeof marginPillarSchema>

// Postmortem Action Item
export const postmortemActionItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(3).max(200),
  owner: z.string().trim().min(2).max(100),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['open', 'in_progress', 'completed'])
})
export type PostmortemActionItem = z.infer<typeof postmortemActionItemSchema>

// Input Validation Schemas
export const createSeasonalSectorCampaignSchema = z.object({
  code: z.string().trim().min(3).max(100),
  name: z.string().trim().min(3).max(200),
  sector: z.enum(SECTOR_TYPES),
  season: z.enum(SEASON_TYPES),
  year: z.number().int().min(2020).max(2100),
  need: needPillarSchema,
  window: windowPillarSchema,
  inventory: inventoryPillarSchema,
  logistics: logisticsPillarSchema,
  content: contentPillarSchema,
  margin: marginPillarSchema
})
export type CreateSeasonalSectorCampaignInput = z.infer<typeof createSeasonalSectorCampaignSchema>

export const updateSeasonalSectorCampaignSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(3).max(200).optional(),
  need: needPillarSchema.optional(),
  window: windowPillarSchema.optional(),
  inventory: inventoryPillarSchema.optional(),
  logistics: logisticsPillarSchema.optional(),
  content: contentPillarSchema.optional(),
  margin: marginPillarSchema.optional()
})
export type UpdateSeasonalSectorCampaignInput = z.infer<typeof updateSeasonalSectorCampaignSchema>

export const saveSeasonalCampaignPostmortemSchema = z.object({
  expectedVersion: z.number().int().min(1),
  actualRevenueCents: z.number().int().min(0),
  actualMarginBasisPoints: z.number().int().min(-10000).max(10000),
  targetMarginAchieved: z.boolean(),
  stockoutOccurred: z.boolean(),
  stockoutDetails: z.string().trim().max(2000).optional().nullable(),
  logisticsIncidentsCount: z.number().int().min(0),
  logisticsIncidentNotes: z.string().trim().max(2000).optional().nullable(),
  contentPerformanceScore: z.number().int().min(0).max(100).optional().nullable(),
  roiBasisPoints: z.number().int().optional().nullable(),
  keyLearnings: z.string().trim().min(10).max(5000),
  actionItems: z.array(postmortemActionItemSchema).max(50)
})
export type SaveSeasonalCampaignPostmortemInput = z.infer<typeof saveSeasonalCampaignPostmortemSchema>

// Complete Seasonal Campaign Entity
export interface SeasonalSectorCampaign {
  id: string
  code: string
  name: string
  sector: SectorType
  season: SeasonType
  year: number
  status: SeasonalCampaignStatus
  need: NeedPillar
  window: WindowPillar
  inventory: InventoryPillar
  logistics: LogisticsPillar
  content: ContentPillar
  margin: MarginPillar
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
}

// Postmortem Entity
export interface SeasonalCampaignPostmortem {
  id: string
  campaignId: string
  status: PostmortemStatus
  actualRevenueCents: number
  actualMarginBasisPoints: number
  targetMarginAchieved: boolean
  stockoutOccurred: boolean
  stockoutDetails?: string | null
  logisticsIncidentsCount: number
  logisticsIncidentNotes?: string | null
  contentPerformanceScore?: number | null
  roiBasisPoints?: number | null
  keyLearnings: string
  actionItems: PostmortemActionItem[]
  version: number
  createdAt: string
  updatedAt: string
  createdBy: string
}

export interface CoordinationCheckResult {
  isFullyCoordinated: boolean
  missingPillars: string[]
  inconsistencies: string[]
}

/**
 * Validates that all six pillars of a seasonal campaign are coordinated and mutually coherent:
 * 1. Necesidad
 * 2. Ventana
 * 3. Inventario
 * 4. Logística
 * 5. Contenido
 * 6. Margen
 */
export function verifySeasonalCampaignCoordination(campaign: Partial<SeasonalSectorCampaign>): CoordinationCheckResult {
  const missingPillars: string[] = []
  const inconsistencies: string[] = []

  // Check 1: Necesidad
  if (!campaign.need?.needJustification || campaign.need.needJustification.trim().length < 10) {
    missingPillars.push('need')
  }

  // Check 2: Ventana
  if (!campaign.window?.procurementStartAt || !campaign.window?.windowStartAt || !campaign.window?.windowEndAt) {
    missingPillars.push('window')
  } else {
    if (campaign.window.windowStartAt < campaign.window.procurementStartAt) {
      inconsistencies.push('La ventana de campaña no puede iniciarse antes del aprovisionamiento.')
    }
    if (campaign.window.windowEndAt < campaign.window.windowStartAt) {
      inconsistencies.push('La fecha de fin de campaña debe ser posterior a la de inicio.')
    }
  }

  // Check 3: Inventario
  if (!campaign.inventory?.items || campaign.inventory.items.length === 0) {
    missingPillars.push('inventory')
  }

  // Check 4: Logística
  if (!campaign.logistics?.allowedProfiles || campaign.logistics.allowedProfiles.length === 0) {
    missingPillars.push('logistics')
  }

  // Cross-pillar check: Inventory & Logistics coherence
  if (campaign.inventory?.items && campaign.logistics?.allowedProfiles) {
    const hasPallet = campaign.inventory.items.some((i) => i.plannedUnits > 500)
    if (hasPallet && !campaign.logistics.allowedProfiles.includes('pallet')) {
      inconsistencies.push('El volumen planificado requiere perfil logístico palé en logística coordinada.')
    }
  }

  // Check 5: Contenido
  if (
    !campaign.content ||
    (!campaign.content.landingSlug &&
      (!campaign.content.bannerSlots || campaign.content.bannerSlots.length === 0) &&
      !campaign.content.emailCampaignCode)
  ) {
    missingPillars.push('content')
  }

  // Check 6: Margen
  if (
    campaign.margin === undefined ||
    campaign.margin.minMarginBasisPoints === undefined ||
    campaign.margin.targetRevenueCents === undefined
  ) {
    missingPillars.push('margin')
  } else {
    if (
      campaign.margin.budgetLimitCents > campaign.margin.targetRevenueCents &&
      campaign.margin.targetRevenueCents > 0
    ) {
      inconsistencies.push('El presupuesto asignado supera los ingresos previstos de la campaña.')
    }
  }

  return {
    isFullyCoordinated: missingPillars.length === 0 && inconsistencies.length === 0,
    missingPillars,
    inconsistencies
  }
}
