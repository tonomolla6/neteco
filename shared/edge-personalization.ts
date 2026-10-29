import { z } from 'zod'
import { twoProportionTest } from './performance-insights-stats'

/**
 * PER-025: edge personalisation only when data proves value. It keeps the cache usable
 * (a handful of coarse segments => bounded variants), requires consent (no PII, no
 * identifiers: segment is derived from two booleans) and always has a deterministic fallback.
 */
export const EDGE_SEGMENTS = ['b2c_new', 'b2c_returning', 'b2b'] as const
export type EdgeSegment = (typeof EDGE_SEGMENTS)[number]
export const EDGE_DEFAULT_VARIANT = 'default'

export const EDGE_MIN_VISITORS_PER_ARM = 2000
export const EDGE_ALPHA = 0.05
export const EDGE_MIN_RELATIVE_LIFT_BPS = 500
export const EDGE_MAX_LCP_REGRESSION_MS = 50
export const EDGE_MAX_CACHE_HIT_DROP_BPS = 300

export interface EdgeEvidenceInput {
  controlVisitors: number
  controlConversions: number
  treatmentVisitors: number
  treatmentConversions: number
  lcpDeltaMs: number
  cacheHitRateBps: number
  baselineCacheHitRateBps: number
}

export interface EdgeEvidenceEvaluation {
  eligible: boolean
  reasons: string[]
  liftBps: number
  pValue: number
}

export function evaluatePersonalizationEvidence(e: EdgeEvidenceInput): EdgeEvidenceEvaluation {
  const ints = [e.controlVisitors, e.controlConversions, e.treatmentVisitors, e.treatmentConversions]
  if (
    !ints.every((n) => Number.isSafeInteger(n) && n >= 0) ||
    e.controlConversions > e.controlVisitors ||
    e.treatmentConversions > e.treatmentVisitors ||
    !Number.isFinite(e.lcpDeltaMs) ||
    ![e.cacheHitRateBps, e.baselineCacheHitRateBps].every((n) => Number.isFinite(n) && n >= 0 && n <= 10000)
  )
    throw new Error('invalid_evidence')
  const { pValue } = twoProportionTest(
    { visitors: e.controlVisitors, conversions: e.controlConversions },
    { visitors: e.treatmentVisitors, conversions: e.treatmentConversions }
  )
  const cr = e.controlVisitors ? e.controlConversions / e.controlVisitors : 0
  const ct = e.treatmentVisitors ? e.treatmentConversions / e.treatmentVisitors : 0
  const liftBps = cr > 0 ? Math.round(((ct - cr) / cr) * 10000) : 0
  const reasons: string[] = []
  if (Math.min(e.controlVisitors, e.treatmentVisitors) < EDGE_MIN_VISITORS_PER_ARM) reasons.push('insufficient_sample')
  if (pValue >= EDGE_ALPHA || ct <= cr) reasons.push('not_significant')
  if (liftBps < EDGE_MIN_RELATIVE_LIFT_BPS && ct > cr) reasons.push('lift_below_minimum')
  if (e.lcpDeltaMs > EDGE_MAX_LCP_REGRESSION_MS) reasons.push('lcp_regression')
  if (e.baselineCacheHitRateBps - e.cacheHitRateBps > EDGE_MAX_CACHE_HIT_DROP_BPS) reasons.push('cache_hit_rate_drop')
  return { eligible: reasons.length === 0, reasons, liftBps, pValue }
}

export function deriveEdgeSegment(input: { isB2b: boolean; returning: boolean }): EdgeSegment {
  if (input.isB2b) return 'b2b'
  return input.returning ? 'b2c_returning' : 'b2c_new'
}

export interface EdgeRule {
  slot: string
  segment: EdgeSegment
  variantKey: string
  status: 'draft' | 'enabled' | 'disabled'
}

export interface EdgeResolution {
  variant: string
  personalized: boolean
  /** Value to append to the cache key / Vary: bounded to EDGE_SEGMENTS.length + 1 values. */
  cacheVariant: EdgeSegment | 'default'
  reason: 'rule_match' | 'no_consent' | 'no_rule' | 'kill_switch' | 'error_fallback'
}

export interface EdgeResolutionInput {
  slot: string
  segment: EdgeSegment
  consent: boolean
  rules: readonly EdgeRule[]
  killSwitch?: boolean
  defaultVariant?: string
}

function fallback(reason: EdgeResolution['reason'], defaultVariant: string): EdgeResolution {
  return { variant: defaultVariant, personalized: false, cacheVariant: 'default', reason }
}

export function resolveEdgePersonalization(input: EdgeResolutionInput): EdgeResolution {
  const defaultVariant = input.defaultVariant ?? EDGE_DEFAULT_VARIANT
  if (input.killSwitch) return fallback('kill_switch', defaultVariant)
  if (!input.consent) return fallback('no_consent', defaultVariant)
  const match = input.rules.find((r) => r.status === 'enabled' && r.slot === input.slot && r.segment === input.segment)
  if (!match) return fallback('no_rule', defaultVariant)
  return { variant: match.variantKey, personalized: true, cacheVariant: match.segment, reason: 'rule_match' }
}

/** Never throws: any failure degrades to the deterministic default. */
export function safeResolveEdgePersonalization(input: EdgeResolutionInput): EdgeResolution {
  try {
    return resolveEdgePersonalization(input)
  } catch {
    return fallback('error_fallback', input.defaultVariant ?? EDGE_DEFAULT_VARIANT)
  }
}

const command = { commandId: z.string().uuid(), idempotencyKey: z.string().min(1).max(128) }
const identifier = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)

export const createRuleSchema = z
  .object({
    ...command,
    slot: identifier,
    segment: z.enum(EDGE_SEGMENTS),
    variantKey: identifier.refine((v) => v !== EDGE_DEFAULT_VARIANT, 'variant_key_reserved')
  })
  .strict()
export type CreateRuleInput = z.infer<typeof createRuleSchema>

const count = z.number().int().min(0).max(1_000_000_000)
const bps = z.number().int().min(0).max(10000)
export const recordEvidenceSchema = z
  .object({
    ...command,
    ruleId: z.string().uuid(),
    controlVisitors: count,
    controlConversions: count,
    treatmentVisitors: count,
    treatmentConversions: count,
    lcpDeltaMs: z.number().int().min(-60_000).max(60_000),
    cacheHitRateBps: bps,
    baselineCacheHitRateBps: bps
  })
  .strict()
export type RecordEvidenceInput = z.infer<typeof recordEvidenceSchema>

export const ruleTransitionSchema = z
  .object({
    ...command,
    ruleId: z.string().uuid(),
    expectedVersion: z.number().int().min(1)
  })
  .strict()
export type RuleTransitionInput = z.infer<typeof ruleTransitionSchema>

export const previewSchema = z
  .object({
    slot: identifier,
    isB2b: z.boolean(),
    returning: z.boolean(),
    consent: z.boolean()
  })
  .strict()
export type PreviewInput = z.infer<typeof previewSchema>

export interface EdgeRuleRecord extends EdgeRule {
  id: string
  evidenceId: string | null
  version: number
  createdAt: string
  updatedAt: string
}
