import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const MARKETING_AUTOMATION_WORKFLOWS = [
  'welcome_series',
  'abandoned_cart',
  'inactivity_winback',
  'postpurchase_replenishment',
  'price_drop_alert',
  'back_in_stock'
] as const

export type MarketingAutomationWorkflow = (typeof MARKETING_AUTOMATION_WORKFLOWS)[number] | (string & {})

export const MARKETING_WORKFLOW_LABELS: Record<string, string> = {
  welcome_series: 'Serie de Bienvenida',
  abandoned_cart: 'Recuperación Carrito',
  inactivity_winback: 'Reactivación Inactivos',
  postpurchase_replenishment: 'Reposición Post-compra',
  price_drop_alert: 'Bajada de Precio',
  back_in_stock: 'Vuelta a Stock'
}

export const MARKETING_OBSERVABILITY_EVENT_TYPES = [
  'trigger',
  'suppression',
  'delivery',
  'conversion',
  'complaint',
  'error'
] as const

export type MarketingObservabilityEventType = (typeof MARKETING_OBSERVABILITY_EVENT_TYPES)[number]

export const MARKETING_OBSERVABILITY_CHANNELS = ['email', 'sms', 'push', 'portal', 'internal'] as const
export type MarketingObservabilityChannel = (typeof MARKETING_OBSERVABILITY_CHANNELS)[number]

export const MARKETING_SUPPRESSION_REASONS = [
  'fatigue_limit',
  'unsubscribed',
  'quiet_hours',
  'no_consent',
  'open_debt',
  'inventory_out_of_stock',
  'recent_purchase',
  'cooldown_active'
] as const

export type MarketingSuppressionReason = (typeof MARKETING_SUPPRESSION_REASONS)[number] | (string & {})

export function calculateAutomationMargin(grossRevenueCents: number, costCents: number, discountCents: number): number {
  return grossRevenueCents - costCents - discountCents
}

export function calculateMarginBasisPoints(netMarginCents: number, grossRevenueCents: number): number {
  if (grossRevenueCents <= 0) return 0
  return Math.round((netMarginCents / grossRevenueCents) * 10000)
}

export const marketingObservabilityEventInputSchema = z
  .object({
    workflowId: z.string().trim().min(2).max(64),
    executionId: z.string().trim().min(3).max(128),
    eventType: z.enum(MARKETING_OBSERVABILITY_EVENT_TYPES),
    channel: z.enum(MARKETING_OBSERVABILITY_CHANNELS),
    customerId: catalogPolicyUuidSchema.optional().nullable(),
    suppressionReason: z.string().trim().min(2).max(64).optional().nullable(),
    errorCode: z.string().trim().min(2).max(64).optional().nullable(),
    errorMessage: z.string().trim().max(500).optional().nullable(),
    discountCents: z.number().int().nonnegative().default(0),
    grossRevenueCents: z.number().int().nonnegative().default(0),
    costCents: z.number().int().nonnegative().default(0),
    metadata: z.record(z.unknown()).optional(),
    occurredAt: catalogPolicyInstantSchema
  })
  .strict()

export type MarketingObservabilityEventInput = z.infer<typeof marketingObservabilityEventInputSchema>

export interface MarketingWorkflowMetricsSummary {
  workflowId: string
  workflowName: string
  triggers: number
  suppressions: number
  deliveries: number
  conversions: number
  complaints: number
  errors: number
  totalGrossRevenueCents: number
  totalCostCents: number
  totalDiscountCents: number
  totalNetMarginCents: number
  marginBasisPoints: number
  deliveryRatePercent: number
  conversionRatePercent: number
  complaintRatePercent: number
  errorRatePercent: number
  suppressionBreakdown: Record<string, number>
  errorBreakdown: Record<string, number>
  hasHighErrorRate: boolean
  hasHighComplaintRate: boolean
  hasNegativeMargin: boolean
}
