import { z } from 'zod'
import { twoProportionTest } from './performance-insights-stats'

/** PER-022: decide by value, not by habit. Control = script not loaded; treatment = script loaded. */
export const THIRD_PARTY_KINDS = ['pixel', 'widget', 'analytics', 'chat', 'ab_testing', 'other'] as const
export type ThirdPartyKind = (typeof THIRD_PARTY_KINDS)[number]

export const THIRD_PARTY_MIN_VISITORS_PER_ARM = 1000
export const THIRD_PARTY_ALPHA = 0.05
export const THIRD_PARTY_LCP_BUDGET_MS = 200

export interface ThirdPartyArm {
  visitors: number
  conversions: number
  revenueCents: number
  lcpMsP75: number
}

export interface ThirdPartyExperimentInput {
  periodDays: number
  marginBps: number
  monthlyCostCents: number
  control: ThirdPartyArm
  treatment: ThirdPartyArm
}

export type ThirdPartyVerdict = 'keep' | 'remove' | 'inconclusive'

export interface ThirdPartyEvaluation {
  verdict: ThirdPartyVerdict
  reasons: string[]
  significant: boolean
  pValue: number
  conversionLiftBps: number
  incrementalRevenueMonthlyCents: number
  incrementalProfitMonthlyCents: number
  lcpDeltaMs: number
}

function validArm(arm: ThirdPartyArm): boolean {
  return (
    [arm.visitors, arm.conversions, arm.revenueCents, arm.lcpMsP75].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    arm.conversions <= arm.visitors
  )
}

export function evaluateThirdPartyExperiment(input: ThirdPartyExperimentInput): ThirdPartyEvaluation {
  if (
    !Number.isInteger(input.periodDays) ||
    input.periodDays < 1 ||
    input.periodDays > 90 ||
    !Number.isInteger(input.marginBps) ||
    input.marginBps < 0 ||
    input.marginBps > 10000 ||
    !Number.isSafeInteger(input.monthlyCostCents) ||
    input.monthlyCostCents < 0 ||
    !validArm(input.control) ||
    !validArm(input.treatment)
  )
    throw new Error('invalid_experiment_input')
  const { control, treatment } = input
  const { pValue } = twoProportionTest(control, treatment)
  const significant = pValue < THIRD_PARTY_ALPHA
  const crControl = control.visitors ? control.conversions / control.visitors : 0
  const crTreatment = treatment.visitors ? treatment.conversions / treatment.visitors : 0
  const conversionLiftBps = crControl > 0 ? Math.round(((crTreatment - crControl) / crControl) * 10000) : 0
  const rpvControl = control.visitors ? control.revenueCents / control.visitors : 0
  const rpvTreatment = treatment.visitors ? treatment.revenueCents / treatment.visitors : 0
  const monthlyVisitors = ((control.visitors + treatment.visitors) / input.periodDays) * 30
  const incrementalRevenue = Math.round((rpvTreatment - rpvControl) * monthlyVisitors)
  const incrementalProfit = Math.round((incrementalRevenue * input.marginBps) / 10000) - input.monthlyCostCents
  const lcpDeltaMs = treatment.lcpMsP75 - control.lcpMsP75
  const base = {
    significant,
    pValue,
    conversionLiftBps,
    incrementalRevenueMonthlyCents: incrementalRevenue,
    incrementalProfitMonthlyCents: incrementalProfit,
    lcpDeltaMs
  }
  if (Math.min(control.visitors, treatment.visitors) < THIRD_PARTY_MIN_VISITORS_PER_ARM)
    return { ...base, verdict: 'inconclusive', reasons: ['insufficient_sample'] }
  if (incrementalProfit <= 0) return { ...base, verdict: 'remove', reasons: ['negative_roi'] }
  if (!significant) {
    if (lcpDeltaMs > THIRD_PARTY_LCP_BUDGET_MS)
      return { ...base, verdict: 'remove', reasons: ['lcp_regression_without_proven_return'] }
    return { ...base, verdict: 'inconclusive', reasons: ['not_significant'] }
  }
  return {
    ...base,
    verdict: 'keep',
    reasons: lcpDeltaMs > THIRD_PARTY_LCP_BUDGET_MS ? ['keep_with_performance_cost'] : []
  }
}

const command = { commandId: z.string().uuid(), idempotencyKey: z.string().min(1).max(128) }
const count = z.number().int().min(0).max(1_000_000_000)

export const registerScriptSchema = z
  .object({
    ...command,
    vendor: z.string().trim().min(2).max(80),
    name: z.string().trim().min(2).max(80),
    kind: z.enum(THIRD_PARTY_KINDS),
    monthlyCostCents: z.number().int().min(0).max(100_000_000),
    loadMsP75: z.number().int().min(0).max(60_000)
  })
  .strict()
export type RegisterScriptInput = z.infer<typeof registerScriptSchema>

const armSchema = z
  .object({
    visitors: count,
    conversions: count,
    revenueCents: z.number().int().min(0).max(1e12),
    lcpMsP75: z.number().int().min(0).max(60_000)
  })
  .strict()

export const recordExperimentSchema = z
  .object({
    ...command,
    scriptId: z.string().uuid(),
    periodDays: z.number().int().min(1).max(90),
    marginBps: z.number().int().min(0).max(10000),
    control: armSchema,
    treatment: armSchema
  })
  .strict()
export type RecordExperimentInput = z.infer<typeof recordExperimentSchema>

export const removeScriptSchema = z
  .object({
    ...command,
    scriptId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    reason: z.string().trim().min(10).max(500)
  })
  .strict()
export type RemoveScriptInput = z.infer<typeof removeScriptSchema>

export interface ThirdPartyScript {
  id: string
  vendor: string
  name: string
  kind: ThirdPartyKind
  monthlyCostCents: number
  loadMsP75: number
  status: 'active' | 'removed'
  removalReason: string | null
  version: number
  createdAt: string
  updatedAt: string
  latestVerdict: ThirdPartyVerdict | null
}
