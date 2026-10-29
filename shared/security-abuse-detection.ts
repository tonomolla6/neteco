import { z } from 'zod'

/**
 * SEC-040: explainable abuse heuristics. Every rule maps one numeric aggregate (never raw personal data)
 * to a bounded contribution: weight * min(1, value / cap). The score is the weighted share, 0..100.
 */
export interface AbuseRule {
  code: string
  feature: string
  cap: number
  defaultWeight: number
  reason: string
}

export const ABUSE_RULES: readonly AbuseRule[] = [
  {
    code: 'R01_LOGIN_FAILURES',
    feature: 'failed_logins_1h',
    cap: 10,
    defaultWeight: 0.2,
    reason: 'Muchos intentos de acceso fallidos en 1 hora'
  },
  {
    code: 'R02_ORDER_VELOCITY',
    feature: 'orders_1h',
    cap: 6,
    defaultWeight: 0.12,
    reason: 'Ritmo de pedidos inusual en 1 hora'
  },
  {
    code: 'R03_COUPON_GUESSING',
    feature: 'coupon_attempts_1h',
    cap: 8,
    defaultWeight: 0.14,
    reason: 'Intentos repetidos de cupones en 1 hora'
  },
  {
    code: 'R04_CARD_TESTING',
    feature: 'distinct_cards_24h',
    cap: 5,
    defaultWeight: 0.18,
    reason: 'Varias tarjetas distintas en 24 horas'
  },
  {
    code: 'R05_NEW_ACCOUNT',
    feature: 'new_account_flag',
    cap: 1,
    defaultWeight: 0.08,
    reason: 'Cuenta creada hace menos de 24 horas'
  },
  {
    code: 'R06_ADDRESS_MISMATCH',
    feature: 'address_mismatch_flag',
    cap: 1,
    defaultWeight: 0.08,
    reason: 'Dirección de envío y facturación incoherentes'
  },
  {
    code: 'R07_HIGH_FIRST_ORDER',
    feature: 'first_order_value_eur',
    cap: 2000,
    defaultWeight: 0.1,
    reason: 'Primer pedido de importe elevado'
  },
  {
    code: 'R08_REFUND_PATTERN',
    feature: 'refund_requests_30d',
    cap: 4,
    defaultWeight: 0.1,
    reason: 'Devoluciones frecuentes en 30 días'
  }
]
const RULE_BY_FEATURE = new Map(ABUSE_RULES.map((rule) => [rule.feature, rule]))

export type AbuseDecision = 'allow' | 'review' | 'hold'

export interface AbuseModel {
  weights: Record<string, number>
  reviewThreshold: number
  holdThreshold: number
}

export interface AbuseContribution {
  ruleCode: string
  feature: string
  value: number
  cap: number
  weight: number
  points: number
  reason: string
}

export interface AbuseScore {
  score: number
  decision: AbuseDecision
  contributions: AbuseContribution[]
}

export function assertValidFeatures(features: Record<string, unknown>): asserts features is Record<string, number> {
  for (const [feature, value] of Object.entries(features)) {
    if (!RULE_BY_FEATURE.has(feature)) throw new Error(`unknown_feature:${feature}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid_feature_value:${feature}`)
    }
  }
}

/** Pure and deterministic. A hold is a request for human review, never an automatic block. */
export function scoreAbuse(features: Record<string, number>, model: AbuseModel): AbuseScore {
  assertValidFeatures(features)
  const totalWeight = Object.values(model.weights).reduce((sum, weight) => sum + weight, 0)
  if (!(totalWeight > 0)) throw new Error('invalid_model_weights')
  const contributions: AbuseContribution[] = []
  for (const [feature, rawValue] of Object.entries(features)) {
    const rule = RULE_BY_FEATURE.get(feature)!
    const weight = model.weights[feature]
    if (!weight || rawValue === 0) continue
    const ratio = Math.min(1, rawValue / rule.cap)
    contributions.push({
      ruleCode: rule.code,
      feature,
      value: rawValue,
      cap: rule.cap,
      weight,
      points: (100 * weight * ratio) / totalWeight,
      reason: rule.reason
    })
  }
  contributions.sort((a, b) => b.points - a.points || a.feature.localeCompare(b.feature))
  const score = Math.round(contributions.reduce((sum, item) => sum + item.points, 0))
  const decision: AbuseDecision =
    score >= model.holdThreshold ? 'hold' : score >= model.reviewThreshold ? 'review' : 'allow'
  return { score, decision, contributions }
}

export const BIN_COUNT = 5
export const DRIFT_MIN_SAMPLES = 30

/** Five bins at 25/50/75/100% of the rule cap plus an overflow bin; upper bounds inclusive. */
export function binIndex(value: number, cap: number): number {
  const edges = [0.25, 0.5, 0.75, 1]
  for (const [index, edge] of edges.entries()) if (value <= cap * edge) return index
  return BIN_COUNT - 1
}

export function proportionsFromSamples(samples: readonly number[], cap: number): number[] {
  const counts = new Array<number>(BIN_COUNT).fill(0)
  for (const sample of samples) counts[binIndex(sample, cap)]! += 1
  return counts.map((count) => (samples.length === 0 ? 0 : count / samples.length))
}

/** Population Stability Index with epsilon smoothing so empty bins stay finite. */
export function computePsi(baseline: readonly number[], current: readonly number[]): number {
  if (baseline.length !== current.length || baseline.length === 0) throw new Error('psi_size_mismatch')
  const epsilon = 1e-4
  let psi = 0
  for (const [index, expected] of baseline.entries()) {
    const e = Math.max(expected, epsilon)
    const a = Math.max(current[index]!, epsilon)
    psi += (a - e) * Math.log(a / e)
  }
  return psi
}

export type DriftStatus = 'ok' | 'warn' | 'alert' | 'insufficient_data'
export function driftStatus(psi: number): Exclude<DriftStatus, 'insufficient_data'> {
  return psi < 0.1 ? 'ok' : psi < 0.25 ? 'warn' : 'alert'
}

export interface ReviewCounts {
  confirmed: number
  falsePositive: number
  pending: number
  flagged: number
}

/** False-positive rate here is the share of reviewed flags that were wrong; allowed traffic is not labelled. */
export function summarizeReviewMetrics(counts: ReviewCounts) {
  const reviewed = counts.confirmed + counts.falsePositive
  return {
    flagged: counts.flagged,
    reviewed,
    confirmed: counts.confirmed,
    falsePositive: counts.falsePositive,
    pending: counts.pending,
    precision: reviewed === 0 ? null : counts.confirmed / reviewed,
    falsePositiveRate: reviewed === 0 ? null : counts.falsePositive / reviewed,
    reviewCoverage: counts.flagged === 0 ? 0 : reviewed / counts.flagged
  }
}

export async function pseudonymizeSubject(kind: string, id: string, pepper: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${kind}:${id}`))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const commandId = z.string().uuid()
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

export const assessAbuseInputSchema = z
  .object({
    commandId,
    subjectKind: z.enum(['identity', 'ip', 'payment', 'session', 'api_key']),
    subjectId: z.string().min(1).max(200),
    context: z.enum(['login', 'checkout', 'coupon', 'b2b_api', 'account_creation']),
    features: z
      .record(z.string(), z.number().finite().min(0).max(1_000_000_000))
      .refine((features) => Object.keys(features).every((feature) => RULE_BY_FEATURE.has(feature)), 'unknown_feature')
  })
  .strict()

export const reviewAbuseInputSchema = z
  .object({
    assessmentId: z.string().uuid(),
    outcome: z.enum(['confirmed_abuse', 'false_positive']),
    note: z.string().trim().min(1).max(500)
  })
  .strict()

export const modelWeightsSchema = z
  .record(z.string(), z.number().positive().max(10))
  .refine(
    (weights) => Object.keys(weights).length >= 1 && Object.keys(weights).every((f) => RULE_BY_FEATURE.has(f)),
    'invalid_weights'
  )

export const createModelInputSchema = z
  .object({
    weights: modelWeightsSchema,
    reviewThreshold: z.number().int().min(1).max(99),
    holdThreshold: z.number().int().min(2).max(100)
  })
  .strict()
  .refine((model) => model.holdThreshold > model.reviewThreshold, 'thresholds_not_ordered')

export const baselineInputSchema = z
  .object({
    modelVersionId: z.string().uuid(),
    samples: z
      .record(z.string(), z.array(z.number().finite().min(0).max(1_000_000_000)).min(DRIFT_MIN_SAMPLES).max(20_000))
      .refine(
        (samples) => Object.keys(samples).length >= 1 && Object.keys(samples).every((f) => RULE_BY_FEATURE.has(f)),
        'unknown_feature'
      )
  })
  .strict()

export const driftInputSchema = z
  .object({ modelVersionId: z.string().uuid(), from: timestamp, to: timestamp })
  .strict()
  .refine((value) => value.from < value.to, 'invalid_window')

export const metricsWindowSchema = z
  .object({ from: timestamp, to: timestamp, modelVersionId: z.string().uuid().optional() })
  .strict()
  .refine((value) => value.from < value.to, 'invalid_window')

export const ABUSE_RETENTION_DAYS = 90
export { RULE_BY_FEATURE }
