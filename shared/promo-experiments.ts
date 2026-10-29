import { z } from 'zod'

/**
 * PRI-022 promotion optimisation by incremental margin.
 *
 * The only objective is incremental contribution margin per ASSIGNED subject
 * (non-buyers count as zero) against a mandatory holdout that receives no offer.
 * Gross revenue is stored for information but is not an input of any decision
 * function in this module, so it cannot be optimised by construction.
 */

export const PROMO_EXPERIMENT_STATUSES = ['draft', 'running', 'stopped', 'concluded'] as const
export const PROMO_EXPERIMENT_CONCLUSIONS = ['rollout', 'no_rollout', 'inconclusive'] as const
export const MIN_HOLDOUT_BASIS_POINTS = 500
export const MAX_HOLDOUT_BASIS_POINTS = 5000
/** Two-sided 95 % normal quantile. */
const Z_CONFIDENCE = 1.96
/** Sample-ratio-mismatch alarm threshold in standard deviations. */
const Z_SRM = 4

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const promoExperimentInputSchema = z
  .object({
    code: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    name: z.string().trim().min(3).max(120),
    promotionCode: z.string().trim().min(1).max(64),
    holdoutBasisPoints: z.number().int().min(MIN_HOLDOUT_BASIS_POINTS).max(MAX_HOLDOUT_BASIS_POINTS),
    minSamplePerArm: z.number().int().min(30).max(1_000_000),
    minIncrementalMarginCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type PromoExperimentInput = z.infer<typeof promoExperimentInputSchema>

/** Opaque, non-PII key (customer id, anonymous cohort id). E-mail-like values are refused. */
export const promoSubjectKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/)

export const promoObservationInputSchema = z
  .object({
    subjectKey: promoSubjectKeySchema,
    orderRef: z.string().min(8).max(128),
    revenueGrossCents: cents,
    netRevenueCents: cents,
    cogsCents: cents,
    variableCostCents: cents
  })
  .strict()
  .refine((value) => value.netRevenueCents <= value.revenueGrossCents, {
    path: ['netRevenueCents'],
    message: 'net revenue cannot exceed gross revenue'
  })
export type PromoObservationInput = z.infer<typeof promoObservationInputSchema>

/** Contribution margin: net revenue after discount, minus COGS and variable costs. */
export function marginOf(
  value: Pick<PromoObservationInput, 'netRevenueCents' | 'cogsCents' | 'variableCostCents'>
): number {
  return value.netRevenueCents - value.cogsCents - value.variableCostCents
}

export type PromoArm = 'holdout' | 'treatment'

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function assignArm(
  experimentId: string,
  subjectKey: string,
  holdoutBasisPoints: number
): Promise<{ arm: PromoArm; subjectHash: string }> {
  if (
    !Number.isInteger(holdoutBasisPoints) ||
    holdoutBasisPoints < MIN_HOLDOUT_BASIS_POINTS ||
    holdoutBasisPoints > MAX_HOLDOUT_BASIS_POINTS
  )
    throw new Error('invalid_holdout')
  const subjectHash = await sha256Hex(`neteco:promo-experiment:v1:${experimentId}:${subjectKey}`)
  const bucket = parseInt(subjectHash.slice(0, 8), 16) % 10000
  return { arm: bucket < holdoutBasisPoints ? 'holdout' : 'treatment', subjectHash }
}

export interface ArmStats {
  n: number
  sum: number
  sumSquares: number
}

export function armStats(subjectMargins: number[]): ArmStats {
  let sum = 0
  let sumSquares = 0
  for (const value of subjectMargins) {
    sum += value
    sumSquares += value * value
  }
  return { n: subjectMargins.length, sum, sumSquares }
}

export interface AnalysisParams {
  holdoutBasisPoints: number
  minSamplePerArm: number
  minIncrementalMarginCents: number
}

export type PromoDecision = 'insufficient_sample' | 'sample_ratio_mismatch' | 'promote' | 'reject' | 'continue'

export interface PromoAnalysis {
  objective: 'incremental_margin'
  decision: PromoDecision
  reasons: string[]
  holdoutN: number
  treatmentN: number
  holdoutMeanCents: number
  treatmentMeanCents: number
  incrementalMarginPerSubjectCents: number
  incrementalMarginTotalCents: number
  confidenceLowCents: number
  confidenceHighCents: number
}

function mean(stats: ArmStats): number {
  return stats.n === 0 ? 0 : stats.sum / stats.n
}

function varianceOfMean(stats: ArmStats): number {
  if (stats.n < 2) return 0
  const variance = Math.max(0, (stats.sumSquares - (stats.sum * stats.sum) / stats.n) / (stats.n - 1))
  return variance / stats.n
}

export function analyzeExperiment(
  params: AnalysisParams,
  stats: { holdout: ArmStats; treatment: ArmStats }
): PromoAnalysis {
  const holdoutMean = mean(stats.holdout)
  const treatmentMean = mean(stats.treatment)
  const diff = treatmentMean - holdoutMean
  const se = Math.sqrt(varianceOfMean(stats.holdout) + varianceOfMean(stats.treatment))
  const low = diff - Z_CONFIDENCE * se
  const high = diff + Z_CONFIDENCE * se
  const base = {
    objective: 'incremental_margin' as const,
    holdoutN: stats.holdout.n,
    treatmentN: stats.treatment.n,
    holdoutMeanCents: Math.round(holdoutMean),
    treatmentMeanCents: Math.round(treatmentMean),
    incrementalMarginPerSubjectCents: Math.round(diff),
    incrementalMarginTotalCents: Math.round(diff * stats.treatment.n),
    confidenceLowCents: Math.round(low),
    confidenceHighCents: Math.round(high)
  }
  const reasons: string[] = []
  if (stats.holdout.n === 0) reasons.push('holdout_missing')
  else if (stats.holdout.n < params.minSamplePerArm) reasons.push('holdout_below_minimum')
  if (stats.treatment.n < params.minSamplePerArm) reasons.push('treatment_below_minimum')
  if (reasons.length > 0) return { ...base, decision: 'insufficient_sample', reasons }

  const total = stats.holdout.n + stats.treatment.n
  const p = params.holdoutBasisPoints / 10000
  const srm = Math.abs(stats.holdout.n - total * p) / Math.sqrt(total * p * (1 - p))
  if (srm > Z_SRM) return { ...base, decision: 'sample_ratio_mismatch', reasons: ['sample_ratio_mismatch'] }

  if (low > params.minIncrementalMarginCents) return { ...base, decision: 'promote', reasons: [] }
  if (high < params.minIncrementalMarginCents) return { ...base, decision: 'reject', reasons: ['margin_not_reachable'] }
  return { ...base, decision: 'continue', reasons: ['interval_inconclusive'] }
}

/** Rank promotable candidates by incremental margin only; extra fields (e.g. revenue) are ignored. */
export function rankPromoCandidates<T extends { code: string; analysis: PromoAnalysis }>(candidates: T[]): T[] {
  return candidates
    .filter((c) => c.analysis.decision === 'promote')
    .sort(
      (a, b) =>
        b.analysis.incrementalMarginTotalCents - a.analysis.incrementalMarginTotalCents || a.code.localeCompare(b.code)
    )
}
