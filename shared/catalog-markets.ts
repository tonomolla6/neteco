import { z } from 'zod'

export class MarketCatalogError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable' | 'non_compliant'
  ) {
    super(code)
    this.name = 'MarketCatalogError'
  }
}

export class InternationalShippingError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'unavailable'
      | 'shipping_not_allowed'
  ) {
    super(code)
    this.name = 'InternationalShippingError'
  }
}

export class CatalogLotRecallError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'unavailable'
      | 'expedition_blocked'
  ) {
    super(code)
    this.name = 'CatalogLotRecallError'
  }
}

export const marketCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2,5}$/)
export const localeSchema = z.string().trim().min(2).max(10)

export const catalogMarketConfigInputSchema = z
  .object({
    action: z.enum(['configure', 'set_availability', 'set_compliance', 'deactivate']),
    expectedVersion: z.number().int().min(0),
    marketCode: marketCodeSchema,
    locale: localeSchema.default('es-ES'),
    isAvailable: z.boolean().default(true),
    availabilityStatus: z
      .enum(['available', 'preorder', 'discontinued', 'restricted', 'b2b_only'])
      .default('available'),
    minOrderQuantity: z.number().int().positive().default(1),
    maxOrderQuantity: z.number().int().positive().optional(),
    restrictionReason: z.string().trim().max(500).optional(),
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().min(1),
    slug: z.string().trim().min(1).max(255),
    metaTitle: z.string().trim().max(255).optional(),
    metaDescription: z.string().trim().max(500).optional(),
    usageInstructions: z.string().trim().optional(),
    isCompliant: z.boolean().default(true),
    clpWarnings: z.array(z.string().trim()).default([]),
    ufiCode: z.string().trim().min(4).max(40).optional(),
    registrationNumber: z.string().trim().max(100).optional(),
    sdsUrl: z
      .string()
      .trim()
      .url()
      .regex(/^https:\/\//, 'sdsUrl must use https scheme')
      .optional(),
    complianceNotes: z.string().trim().optional()
  })
  .strict()
  .refine((data) => !data.isAvailable || data.isCompliant, {
    message: 'Product cannot be marked available in market if it is not compliant',
    path: ['isAvailable']
  })
  .refine((data) => !data.maxOrderQuantity || data.maxOrderQuantity >= data.minOrderQuantity, {
    message: 'maxOrderQuantity must be greater than or equal to minOrderQuantity',
    path: ['maxOrderQuantity']
  })

export type CatalogMarketConfigInput = z.infer<typeof catalogMarketConfigInputSchema>

export interface CatalogMarketConfig {
  id: string
  productId: string
  marketCode: string
  version: number
  isAvailable: number
  availabilityStatus: string
  minOrderQuantity: number
  maxOrderQuantity?: number | null
  restrictionReason?: string | null
  locale: string
  title: string
  description: string
  slug: string
  metaTitle?: string | null
  metaDescription?: string | null
  usageInstructions?: string | null
  isCompliant: number
  clpWarnings: string[]
  ufiCode?: string | null
  registrationNumber?: string | null
  sdsUrl?: string | null
  complianceNotes?: string | null
  createdAt: string
  updatedAt: string
}

export const internationalShippingPolicyInputSchema = z
  .object({
    marketCode: marketCodeSchema,
    expectedVersion: z.number().int().min(0),
    customsDeclaredValueRequired: z.boolean().default(false),
    dutyCollectionType: z.enum(['exempt', 'ddp', 'dap']).default('exempt'),
    hsTariffCodeRequired: z.boolean().default(false),
    deMinimisThresholdCents: z.number().int().min(0).default(15000),
    estimatedDutyRateBps: z.number().int().min(0).max(10000).default(0),
    customsHandlingFeeCents: z.number().int().min(0).default(0),
    requiredDocuments: z.array(z.string().trim()).default([]),
    customsDeclarationNotes: z.string().trim().optional(),
    adrAllowed: z.boolean().default(true),
    maxHazardClass: z
      .enum(['none', 'unrestricted', 'limited_quantity_only', 'class_2', 'class_3', 'class_8'])
      .default('unrestricted'),
    prohibitedUnNumbers: z.array(z.string().trim().toUpperCase()).default([]),
    maxDangerousGoodsVolumeLiters: z.number().int().min(0).default(50),
    requiresSpecialAdrCarrier: z.boolean().default(false),
    returnsPermitted: z.boolean().default(true),
    returnWindowDays: z.number().int().min(0).max(365).default(14),
    hazardousReturnsAllowed: z.boolean().default(false),
    returnCarrierCode: z.string().trim().max(50).optional(),
    customerReturnFeeCents: z.number().int().min(0).default(0),
    returnPolicyNotes: z.string().trim().optional()
  })
  .strict()

export type InternationalShippingPolicyInput = z.infer<typeof internationalShippingPolicyInputSchema>

export interface InternationalShippingPolicy {
  marketCode: string
  version: number
  customsDeclaredValueRequired: number
  dutyCollectionType: 'exempt' | 'ddp' | 'dap'
  hsTariffCodeRequired: number
  deMinimisThresholdCents: number
  estimatedDutyRateBps: number
  customsHandlingFeeCents: number
  requiredDocuments: string[]
  customsDeclarationNotes?: string | null
  adrAllowed: number
  maxHazardClass: string
  prohibitedUnNumbers: string[]
  maxDangerousGoodsVolumeLiters: number
  requiresSpecialAdrCarrier: number
  returnsPermitted: number
  returnWindowDays: number
  hazardousReturnsAllowed: number
  returnCarrierCode?: string | null
  customerReturnFeeCents: number
  returnPolicyNotes?: string | null
  createdAt: string
  updatedAt: string
}

export interface ShippingEvaluationItem {
  variantId: string
  quantity: number
  isDangerousGoods?: boolean
  unNumber?: string
  hazardClass?: string
  volumeLiters?: number
  weightGrams?: number
  valueCents: number
}

export interface InternationalShippingEvaluation {
  marketCode: string
  allowed: boolean
  blockReason?:
    | 'adr_not_allowed_in_market'
    | 'prohibited_chemical_un_number'
    | 'dangerous_goods_volume_limit_exceeded'
    | 'hazard_class_exceeded'
    | null
  violations: string[]
  duties: {
    declaredValueRequired: boolean
    dutyCollectionType: 'exempt' | 'ddp' | 'dap'
    exceedsDeMinimis: boolean
    estimatedDutyCents: number
    customsHandlingFeeCents: number
    totalCustomsFeesCents: number
  }
  documentation: {
    requiredDocuments: string[]
    customsNotes?: string | null
  }
  returns: {
    returnsPermitted: boolean
    returnWindowDays: number
    hazardousReturnsAllowed: boolean
    returnFeeCents: number
    returnCarrierCode?: string | null
  }
}

export const variantLotTrackingPolicyInputSchema = z
  .object({
    variantId: z.string().trim().min(1),
    expectedVersion: z.number().int().min(0),
    lotTrackingRequired: z.boolean().default(true),
    shelfLifeDays: z.number().int().positive().default(365),
    minShelfLifeDispatchDays: z.number().int().min(0).default(30),
    quarantineOnExpiry: z.boolean().default(true)
  })
  .strict()

export type VariantLotTrackingPolicyInput = z.infer<typeof variantLotTrackingPolicyInputSchema>

export const lotExpeditionBlockInputSchema = z
  .object({
    lotId: z.string().uuid(),
    blockReason: z.enum(['lot_expired', 'lot_recalled', 'lot_quarantined', 'manual_quarantine']),
    evidence: z
      .string()
      .trim()
      .min(4)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
  })
  .strict()

export type LotExpeditionBlockInput = z.infer<typeof lotExpeditionBlockInputSchema>
