import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

export const SENSITIVE_BROWSE_TERMS = [
  'medical',
  'medico',
  'medica',
  'sanitary',
  'sanitario',
  'sanitaria',
  'biocide',
  'biocida',
  'hazardous',
  'peligroso',
  'peligrosa',
  'disinfectant',
  'desinfectante',
  'personal',
  'health',
  'salud',
  'confidential',
  'confidencial',
  'toxic',
  'toxico',
  'toxica',
  'poison',
  'veneno',
  'corrosive',
  'corrosivo',
  'narcotic',
  'estupefaciente'
] as const

export function isSensitiveCategoryOrProduct(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  return SENSITIVE_BROWSE_TERMS.some((term) => normalized.includes(term))
}

export const browseRecoveryPolicySchema = z
  .object({
    id: z.literal('global'),
    version: z.number().int().min(1),
    enabled: z.boolean(),
    abandonmentWindowMinutes: z.number().int().min(15).max(1440),
    cooldownHours: z.number().int().min(1).max(720),
    holdoutPercent: z.number().int().min(0).max(50),
    attributionWindowDays: z.number().int().min(1).max(30),
    updatedAt: instant,
    updatedBy: uuid
  })
  .strict()

export const browseRecoveryPolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    enabled: z.boolean(),
    abandonmentWindowMinutes: z.number().int().min(15).max(1440).default(120),
    cooldownHours: z.number().int().min(1).max(720).default(72),
    holdoutPercent: z.number().int().min(0).max(50).default(20),
    attributionWindowDays: z.number().int().min(1).max(30).default(7)
  })
  .strict()

export const browsePreferencesSchema = z
  .object({
    customerId: uuid,
    browseRecoveryOptIn: z.boolean(),
    version: z.number().int().min(1),
    updatedAt: instant
  })
  .strict()

export const browsePreferencesInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    browseRecoveryOptIn: z.boolean()
  })
  .strict()

export const recordBrowseEventInputSchema = z
  .object({
    productId: z.string().min(1).max(100),
    categoryId: z.string().min(1).max(100),
    viewDurationSeconds: z.number().int().min(0).max(86400).default(30)
  })
  .strict()

export const browseDispatchGroupSchema = z.enum(['treatment', 'control'])

export const browseDispatchStatusSchema = z.enum([
  'delivered',
  'control_holdout',
  'suppressed_sensitive',
  'suppressed_cooldown',
  'suppressed_active_cart',
  'suppressed_recent_purchase',
  'suppressed_opt_out',
  'suppressed_inactive'
])

export const browseDispatchSchema = z
  .object({
    id: uuid,
    customerId: uuid,
    productId: z.string().min(1).max(100),
    groupType: browseDispatchGroupSchema,
    status: browseDispatchStatusSchema,
    recipientEmailHash: z.string().regex(/^[0-9a-f]{64}$/),
    attributionExpiresAt: instant,
    dispatchedAt: instant,
    createdAt: instant
  })
  .strict()

export const browseIncrementalityMetricsSchema = z
  .object({
    source: z.literal('cloudflare'),
    evaluatedAt: instant,
    treatment: z
      .object({
        exposures: z.number().int().nonnegative(),
        conversions: z.number().int().nonnegative(),
        conversionRate: z.number().nonnegative(),
        revenueGrossCents: z.number().int().nonnegative(),
        arpuCents: z.number().nonnegative()
      })
      .strict(),
    control: z
      .object({
        exposures: z.number().int().nonnegative(),
        conversions: z.number().int().nonnegative(),
        conversionRate: z.number().nonnegative(),
        revenueGrossCents: z.number().int().nonnegative(),
        arpuCents: z.number().nonnegative()
      })
      .strict(),
    lift: z
      .object({
        incrementalConversionRate: z.number(),
        relativeLiftPercent: z.number(),
        incrementalRevenueGrossCents: z.number().int(),
        statisticallySignificant: z.boolean()
      })
      .strict()
  })
  .strict()

export type BrowseRecoveryPolicy = z.infer<typeof browseRecoveryPolicySchema>
export type BrowseRecoveryPolicyInput = z.infer<typeof browseRecoveryPolicyInputSchema>
export type BrowsePreferences = z.infer<typeof browsePreferencesSchema>
export type BrowsePreferencesInput = z.infer<typeof browsePreferencesInputSchema>
export type RecordBrowseEventInput = z.infer<typeof recordBrowseEventInputSchema>
export type BrowseDispatch = z.infer<typeof browseDispatchSchema>
export type BrowseIncrementalityMetrics = z.infer<typeof browseIncrementalityMetricsSchema>

/**
 * Assigns customer to treatment or control holdout group deterministically.
 */
export function assignBrowseExperimentGroup(
  customerId: string,
  holdoutPercent: number,
  salt = 'neteco-browse-experiment-salt'
): 'treatment' | 'control' {
  if (holdoutPercent <= 0) return 'treatment'
  if (holdoutPercent >= 100) return 'control'
  let hash = 0
  const combined = customerId + ':' + salt
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31 + combined.charCodeAt(i)) >>> 0
  }
  const bucket = hash % 100
  return bucket < holdoutPercent ? 'control' : 'treatment'
}

/**
 * Calculates incrementality metrics between treatment and holdout control.
 */
export function calculateBrowseIncrementality(
  treatmentExposures: number,
  treatmentConversions: number,
  treatmentRevenueGrossCents: number,
  controlExposures: number,
  controlConversions: number,
  controlRevenueGrossCents: number,
  evaluatedAt: string
): BrowseIncrementalityMetrics {
  const treatmentCvr = treatmentExposures > 0 ? treatmentConversions / treatmentExposures : 0
  const controlCvr = controlExposures > 0 ? controlConversions / controlExposures : 0
  const treatmentArpu = treatmentExposures > 0 ? treatmentRevenueGrossCents / treatmentExposures : 0
  const controlArpu = controlExposures > 0 ? controlRevenueGrossCents / controlExposures : 0

  const incrementalCvr = treatmentCvr - controlCvr
  const relativeLiftPercent = controlCvr > 0 ? (incrementalCvr / controlCvr) * 100 : treatmentCvr > 0 ? 100 : 0

  // Expected control revenue if scaled to treatment exposure count
  const expectedControlRevenue =
    controlExposures > 0 ? (controlRevenueGrossCents * treatmentExposures) / controlExposures : 0
  const incrementalRevenueGrossCents = Math.round(treatmentRevenueGrossCents - expectedControlRevenue)

  // Basic statistical significance check (min sample size and positive delta)
  const statisticallySignificant = treatmentExposures >= 20 && controlExposures >= 10 && incrementalCvr > 0.01

  return {
    source: 'cloudflare',
    evaluatedAt,
    treatment: {
      exposures: treatmentExposures,
      conversions: treatmentConversions,
      conversionRate: Math.round(treatmentCvr * 10000) / 10000,
      revenueGrossCents: treatmentRevenueGrossCents,
      arpuCents: Math.round(treatmentArpu)
    },
    control: {
      exposures: controlExposures,
      conversions: controlConversions,
      conversionRate: Math.round(controlCvr * 10000) / 10000,
      revenueGrossCents: controlRevenueGrossCents,
      arpuCents: Math.round(controlArpu)
    },
    lift: {
      incrementalConversionRate: Math.round(incrementalCvr * 10000) / 10000,
      relativeLiftPercent: Math.round(relativeLiftPercent * 100) / 100,
      incrementalRevenueGrossCents,
      statisticallySignificant
    }
  }
}
