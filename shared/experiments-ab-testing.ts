import { z } from 'zod'

export const EXPERIMENT_TYPES = ['ab_test', 'message_offer', 'feature_gate'] as const
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number]

export const EXPERIMENT_STATUSES = ['draft', 'running', 'paused', 'concluded', 'archived'] as const
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number]

export const TARGET_SURFACES = [
  'homepage_hero',
  'product_detail',
  'cart_offer',
  'checkout_incentive',
  'category_banner',
  'global'
] as const
export type TargetSurface = (typeof TARGET_SURFACES)[number]

export const TARGET_SEGMENTS = ['all', 'b2b_only', 'b2c_only', 'new_visitors', 'repeat_customers'] as const
export type TargetSegment = (typeof TARGET_SEGMENTS)[number]

export const PRIMARY_METRICS = [
  'conversion_rate',
  'revenue_per_visitor',
  'click_through_rate',
  'average_order_value',
  'retention_rate'
] as const
export type PrimaryMetric = (typeof PRIMARY_METRICS)[number]

export const DECISION_TYPES = [
  'variant_a_winner',
  'variant_b_winner',
  'custom_variant_winner',
  'no_winner_inconclusive',
  'stopped_guardrail_breach',
  'rolled_back'
] as const
export type DecisionType = (typeof DECISION_TYPES)[number]

export const UNIT_TYPES = ['visitor_id', 'customer_id', 'session_id'] as const
export type UnitType = (typeof UNIT_TYPES)[number]

export const EVENT_TYPES = [
  'exposure',
  'conversion',
  'order_placed',
  'click',
  'unsubscribe',
  'complaint',
  'web_vital_lcp',
  'web_vital_cls',
  'web_vital_inp'
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const ExperimentGuardrailsSchema = z.object({
  marginFloorBasisPoints: z.number().int().min(0).max(10000).optional(),
  maxUnsubscribeRateBasisPoints: z.number().int().min(0).max(10000).optional(),
  maxComplaintRateBasisPoints: z.number().int().min(0).max(10000).optional(),
  cwvLcpMaxMs: z.number().int().min(100).max(10000).optional(),
  cwvClsMax: z.number().min(0).max(1).optional(),
  cwvInpMaxMs: z.number().int().min(10).max(5000).optional(),
  maxErrorRateBasisPoints: z.number().int().min(0).max(10000).optional()
})
export type ExperimentGuardrails = z.infer<typeof ExperimentGuardrailsSchema>

export const ExperimentVariantSchema = z.object({
  id: z.string().uuid().optional(),
  variantKey: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().trim().min(1).max(100),
  isControl: z.boolean().default(false),
  isHoldout: z.boolean().default(false),
  weight: z.number().int().min(1).max(1000).default(50),
  payload: z.record(z.unknown()).default({})
})
export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>

export const CreateExperimentInputSchema = z.object({
  key: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9_-]+$/),
  name: z.string().trim().min(3).max(200),
  hypothesis: z.string().trim().min(10).max(2000),
  experimentType: z.enum(EXPERIMENT_TYPES),
  ownerEmail: z.string().email().min(5).max(254),
  targetSurface: z.enum(TARGET_SURFACES),
  targetSegment: z.enum(TARGET_SEGMENTS),
  exclusiveGroup: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_-]+$/)
    .optional()
    .nullable(),
  primaryMetric: z.enum(PRIMARY_METRICS),
  guardrails: ExperimentGuardrailsSchema.default({}),
  trafficAllocationPercent: z.number().int().min(1).max(100).default(100),
  minSampleSize: z.number().int().min(20).default(100),
  minDurationDays: z.number().int().min(1).max(180).default(7),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  holdoutPercent: z.number().int().min(0).max(50).default(0),
  changesDescription: z.string().default(''),
  variants: z.array(ExperimentVariantSchema).min(2).max(10)
})
export type CreateExperimentInput = z.infer<typeof CreateExperimentInputSchema>

export const UpdateExperimentInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(3).max(200).optional(),
  hypothesis: z.string().trim().min(10).max(2000).optional(),
  targetSurface: z.enum(TARGET_SURFACES).optional(),
  targetSegment: z.enum(TARGET_SEGMENTS).optional(),
  exclusiveGroup: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_-]+$/)
    .optional()
    .nullable(),
  primaryMetric: z.enum(PRIMARY_METRICS).optional(),
  guardrails: ExperimentGuardrailsSchema.optional(),
  trafficAllocationPercent: z.number().int().min(1).max(100).optional(),
  minSampleSize: z.number().int().min(20).optional(),
  minDurationDays: z.number().int().min(1).max(180).optional(),
  holdoutPercent: z.number().int().min(0).max(50).optional(),
  changesDescription: z.string().optional()
})
export type UpdateExperimentInput = z.infer<typeof UpdateExperimentInputSchema>

export const RecordDecisionInputSchema = z.object({
  expectedVersion: z.number().int().min(1),
  decision: z.enum(DECISION_TYPES),
  decisionRationale: z.string().trim().min(5).max(2000)
})
export type RecordDecisionInput = z.infer<typeof RecordDecisionInputSchema>

export const AssignVariantInputSchema = z.object({
  experimentKey: z.string().min(3).max(80),
  unitType: z.enum(UNIT_TYPES),
  unitId: z.string().min(8).max(128),
  context: z
    .object({
      segment: z.string().optional(),
      surface: z.string().optional()
    })
    .optional()
})
export type AssignVariantInput = z.infer<typeof AssignVariantInputSchema>

export const TrackEventInputSchema = z.object({
  experimentKey: z.string().min(3).max(80),
  variantKey: z.string().min(1).max(50),
  unitType: z.enum(UNIT_TYPES),
  unitId: z.string().min(8).max(128),
  eventType: z.enum(EVENT_TYPES),
  eventValue: z.number().default(0),
  marginBasisPoints: z.number().int().min(-10000).max(10000).optional(),
  metadata: z.record(z.unknown()).optional()
})
export type TrackEventInput = z.infer<typeof TrackEventInputSchema>

export interface SrmResult {
  status: 'pass' | 'warning' | 'mismatch_detected' | 'insufficient_data'
  chiSquare: number
  pValue: number
  degreesOfFreedom: number
  expectedCounts: Record<string, number>
  observedCounts: Record<string, number>
}

export interface VariantMetrics {
  variantKey: string
  exposures: number
  conversions: number
  clicks: number
  ordersPlaced: number
  conversionRate: number
  totalRevenueCents: number
  averageOrderValueCents: number
  unsubscribes: number
  complaints: number
  averageMarginBasisPoints?: number
  p75LcpMs?: number
  p75Cls?: number
  p75InpMs?: number
}

export interface GuardrailBreach {
  guardrail: string
  threshold: number
  observed: number
  message: string
}

export interface GuardrailEvaluationResult {
  status: 'healthy' | 'warning' | 'breached'
  breaches: GuardrailBreach[]
}

export interface ExperimentSummaryReport {
  experimentId: string
  key: string
  name: string
  hypothesis: string
  status: ExperimentStatus
  primaryMetric: PrimaryMetric
  minSampleSize: number
  minDurationDays: number
  daysRunning: number
  hasMetMinDuration: boolean
  hasMetMinSampleSize: boolean
  srm: SrmResult
  guardrailsStatus: GuardrailEvaluationResult
  variantsMetrics: VariantMetrics[]
  liftVsControlPercent?: number
  decision?: DecisionType | null
  decisionRationale?: string | null
  decidedAt?: string | null
  archivedAt?: string | null
}

export class ExperimentsError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'overlapping_experiment_conflict'
      | 'experiment_not_running'
      | 'experiment_already_running'
      | 'experiment_already_concluded'
      | 'sample_size_not_met'
      | 'duration_not_met'
      | 'guardrail_breached'
      | 'service_unavailable',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'ExperimentsError'
  }
}

/** Deterministic FNV-1a 32-bit hash implementation */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Stable server-side deterministic assignment */
export function stableAssignVariant(params: {
  experimentKey: string
  unitId: string
  trafficAllocationPercent: number
  holdoutPercent: number
  variants: { variantKey: string; weight: number; isHoldout?: boolean; isControl?: boolean }[]
}): { variantKey: string | null; isHoldout: boolean; isAssigned: boolean } {
  if (params.variants.length === 0) {
    return { variantKey: null, isHoldout: false, isAssigned: false }
  }

  // 1. Hash experimentKey + unitId
  const hash = fnv1a32(`${params.experimentKey}:${params.unitId}`)
  const bucket = hash % 10000 // 0 .. 9999

  // 2. Traffic gating
  const trafficThreshold = params.trafficAllocationPercent * 100
  if (bucket >= trafficThreshold) {
    return { variantKey: null, isHoldout: false, isAssigned: false }
  }

  // 3. Holdout gating
  const holdoutThreshold = params.holdoutPercent * 100
  if (params.holdoutPercent > 0 && bucket < holdoutThreshold) {
    const holdoutVar = params.variants.find((v) => v.isHoldout || v.variantKey === 'holdout')
    if (holdoutVar) {
      return { variantKey: holdoutVar.variantKey, isHoldout: true, isAssigned: true }
    }
  }

  // 4. Variant allocation from remaining space
  const nonHoldoutVariants = params.variants.filter((v) => !v.isHoldout && v.variantKey !== 'holdout')
  const pool = nonHoldoutVariants.length > 0 ? nonHoldoutVariants : params.variants

  const totalWeight = pool.reduce((acc, v) => acc + v.weight, 0)
  if (totalWeight <= 0) {
    return { variantKey: pool[0]!.variantKey, isHoldout: false, isAssigned: true }
  }

  // Map bucket within [holdoutThreshold, trafficThreshold) to [0, totalWeight)
  const range = trafficThreshold - holdoutThreshold
  if (range <= 0) {
    return { variantKey: null, isHoldout: false, isAssigned: false }
  }

  const offset = bucket - holdoutThreshold
  const scaled = (offset / range) * totalWeight

  let cumulative = 0
  for (const variant of pool) {
    cumulative += variant.weight
    if (scaled < cumulative) {
      return { variantKey: variant.variantKey, isHoldout: false, isAssigned: true }
    }
  }

  return { variantKey: pool[pool.length - 1]!.variantKey, isHoldout: false, isAssigned: true }
}

function regularizedGammaQ(a: number, x: number): number {
  if (x <= 0) return 1
  if (a <= 0) return 0

  // Continued fraction (Lentz's method)
  const lnGammaA = logGamma(a)
  const factor = Math.exp(-x + a * Math.log(x) - lnGammaA)

  let b = x + 1 - a
  let c = 1 / 1e-30
  let d = 1 / b
  let h = d

  for (let i = 1; i <= 100; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = b + an / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-12) break
  }
  return factor * h
}

function logGamma(x: number): number {
  const coefficients = [
    76.1800917294715, -86.5053203294168, 24.0140982408309, -1.23173957245015, 0.001208650973866, -5.395239384953e-6
  ]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.00000000019
  for (let j = 0; j <= 5; j++) {
    ser += coefficients[j]! / ++y
  }
  return -tmp + Math.log((2.506628274631 * ser) / x)
}

export function chiSquareSurvival(chiSquare: number, degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0 || chiSquare < 0) return 1
  if (chiSquare === 0) return 1
  return regularizedGammaQ(degreesOfFreedom / 2, chiSquare / 2)
}

/** Sample Ratio Mismatch (SRM) calculation */
export function calculateSampleRatioMismatch(
  variants: { variantKey: string; weight: number }[],
  observedCounts: Record<string, number>
): SrmResult {
  const degreesOfFreedom = Math.max(1, variants.length - 1)
  const totalObserved = variants.reduce((sum, v) => sum + (observedCounts[v.variantKey] ?? 0), 0)
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0)

  const expectedCounts: Record<string, number> = {}
  for (const v of variants) {
    const ratio = totalWeight > 0 ? v.weight / totalWeight : 1 / variants.length
    expectedCounts[v.variantKey] = Math.round(totalObserved * ratio * 100) / 100
  }

  if (totalObserved < 20) {
    return {
      status: 'insufficient_data',
      chiSquare: 0,
      pValue: 1,
      degreesOfFreedom,
      expectedCounts,
      observedCounts
    }
  }

  let chiSquare = 0
  for (const v of variants) {
    const observed = observedCounts[v.variantKey] ?? 0
    const expected = expectedCounts[v.variantKey] ?? 1
    if (expected > 0) {
      chiSquare += Math.pow(observed - expected, 2) / expected
    }
  }

  const pValue = chiSquareSurvival(chiSquare, degreesOfFreedom)

  let status: SrmResult['status'] = 'pass'
  if (pValue < 0.001) {
    status = 'mismatch_detected'
  } else if (pValue < 0.01) {
    status = 'warning'
  }

  return {
    status,
    chiSquare: Math.round(chiSquare * 10000) / 10000,
    pValue: Math.round(pValue * 1000000) / 1000000,
    degreesOfFreedom,
    expectedCounts,
    observedCounts
  }
}

/** Conflict and overlap detection between experiments (DAT-018) */
export function checkExperimentOverlap(
  candidate: {
    id?: string
    targetSurface: TargetSurface
    targetSegment: TargetSegment
    exclusiveGroup?: string | null
  },
  existingActive: Array<{
    id: string
    name: string
    key: string
    targetSurface: TargetSurface
    targetSegment: TargetSegment
    exclusiveGroup?: string | null
  }>
): { hasConflict: boolean; conflictingExperimentKey?: string; reason?: string } {
  for (const existing of existingActive) {
    if (candidate.id && existing.id === candidate.id) continue

    // 1. Explicit exclusive group conflict
    if (candidate.exclusiveGroup && existing.exclusiveGroup && candidate.exclusiveGroup === existing.exclusiveGroup) {
      return {
        hasConflict: true,
        conflictingExperimentKey: existing.key,
        reason: `Solapamiento detectado en el grupo exclusivo "${candidate.exclusiveGroup}" con el experimento activo "${existing.name}"`
      }
    }

    // 2. Surface overlap
    const surfaceCollides =
      candidate.targetSurface === 'global' ||
      existing.targetSurface === 'global' ||
      candidate.targetSurface === existing.targetSurface

    // 3. Segment overlap
    const segmentCollides =
      candidate.targetSegment === 'all' ||
      existing.targetSegment === 'all' ||
      candidate.targetSegment === existing.targetSegment

    if (surfaceCollides && segmentCollides) {
      return {
        hasConflict: true,
        conflictingExperimentKey: existing.key,
        reason: `Solapamiento de experimentos: "${existing.name}" ya está activo en la superficie "${candidate.targetSurface}" y segmento "${candidate.targetSegment}"`
      }
    }
  }

  return { hasConflict: false }
}

/** Guardrails evaluation (MKT-011 + DAT-017) */
export function evaluateGuardrails(
  guardrails: ExperimentGuardrails,
  metrics: VariantMetrics
): GuardrailEvaluationResult {
  const breaches: GuardrailBreach[] = []

  // 1. Margin floor guardrail (MKT-011)
  if (guardrails.marginFloorBasisPoints !== undefined && metrics.averageMarginBasisPoints !== undefined) {
    if (metrics.averageMarginBasisPoints < guardrails.marginFloorBasisPoints) {
      breaches.push({
        guardrail: 'margin_floor',
        threshold: guardrails.marginFloorBasisPoints,
        observed: metrics.averageMarginBasisPoints,
        message: `Margen medio (${(metrics.averageMarginBasisPoints / 100).toFixed(2)}%) por debajo del umbral mínimo (${(guardrails.marginFloorBasisPoints / 100).toFixed(2)}%)`
      })
    }
  }

  // 2. Unsubscribe rate guardrail (MKT-011 bajas)
  if (guardrails.maxUnsubscribeRateBasisPoints !== undefined && metrics.exposures > 0) {
    const unsubRateBps = Math.round((metrics.unsubscribes / metrics.exposures) * 10000)
    if (unsubRateBps > guardrails.maxUnsubscribeRateBasisPoints) {
      breaches.push({
        guardrail: 'max_unsubscribe_rate',
        threshold: guardrails.maxUnsubscribeRateBasisPoints,
        observed: unsubRateBps,
        message: `Tasa de bajas (${(unsubRateBps / 100).toFixed(2)}%) excede el límite permitido (${(guardrails.maxUnsubscribeRateBasisPoints / 100).toFixed(2)}%)`
      })
    }
  }

  // 3. Complaint rate guardrail (MKT-011 quejas)
  if (guardrails.maxComplaintRateBasisPoints !== undefined && metrics.exposures > 0) {
    const complaintRateBps = Math.round((metrics.complaints / metrics.exposures) * 10000)
    if (complaintRateBps > guardrails.maxComplaintRateBasisPoints) {
      breaches.push({
        guardrail: 'max_complaint_rate',
        threshold: guardrails.maxComplaintRateBasisPoints,
        observed: complaintRateBps,
        message: `Tasa de quejas (${(complaintRateBps / 100).toFixed(2)}%) excede el límite permitido (${(guardrails.maxComplaintRateBasisPoints / 100).toFixed(2)}%)`
      })
    }
  }

  // 4. Core Web Vitals guardrails (MKT-011)
  if (guardrails.cwvLcpMaxMs !== undefined && metrics.p75LcpMs !== undefined) {
    if (metrics.p75LcpMs > guardrails.cwvLcpMaxMs) {
      breaches.push({
        guardrail: 'cwv_lcp',
        threshold: guardrails.cwvLcpMaxMs,
        observed: metrics.p75LcpMs,
        message: `Core Web Vital LCP (${metrics.p75LcpMs}ms) supera el umbral límite (${guardrails.cwvLcpMaxMs}ms)`
      })
    }
  }

  if (guardrails.cwvClsMax !== undefined && metrics.p75Cls !== undefined) {
    if (metrics.p75Cls > guardrails.cwvClsMax) {
      breaches.push({
        guardrail: 'cwv_cls',
        threshold: guardrails.cwvClsMax,
        observed: metrics.p75Cls,
        message: `Core Web Vital CLS (${metrics.p75Cls}) supera el umbral límite (${guardrails.cwvClsMax})`
      })
    }
  }

  if (guardrails.cwvInpMaxMs !== undefined && metrics.p75InpMs !== undefined) {
    if (metrics.p75InpMs > guardrails.cwvInpMaxMs) {
      breaches.push({
        guardrail: 'cwv_inp',
        threshold: guardrails.cwvInpMaxMs,
        observed: metrics.p75InpMs,
        message: `Core Web Vital INP (${metrics.p75InpMs}ms) supera el umbral límite (${guardrails.cwvInpMaxMs}ms)`
      })
    }
  }

  return {
    status: breaches.length > 0 ? 'breached' : 'healthy',
    breaches
  }
}

/** Compute sha256 hash for audit journal payloads */
export async function experimentPayloadHash(action: string, input: unknown): Promise<string> {
  const json = JSON.stringify({ action, input })
  const buffer = new TextEncoder().encode(json)
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
