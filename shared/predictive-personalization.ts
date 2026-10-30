import { z } from 'zod'

export const PROHIBITED_KEYS = [
  'sede',
  'sedeid',
  'sede_id',
  'branch',
  'branchid',
  'branch_id',
  'site',
  'siteid',
  'site_id',
  'store',
  'storeid',
  'store_id',
  'hierarchy',
  'buyerhierarchy',
  'buyer_hierarchy',
  'delegatedbuyer',
  'delegated_buyer',
  'departmenthead',
  'department_head'
]

export function validateStrictNoSedeNoHierarchy(payload: Record<string, unknown>): {
  valid: boolean
  reason?: string
} {
  const keys = Object.keys(payload).map((k) => k.toLowerCase().replace(/[-_]/g, ''))
  for (const forbidden of PROHIBITED_KEYS) {
    const normalizedForbidden = forbidden.replace(/[-_]/g, '')
    if (keys.some((k) => k.includes(normalizedForbidden))) {
      return {
        valid: false,
        reason: 'Targeting o segmentación por sede o jerarquía prohibido en NETECO (almacén único).'
      }
    }
  }
  return { valid: true }
}

export const SENSITIVE_CATEGORIES = [
  'health',
  'medical',
  'biometrics',
  'religion',
  'political',
  'racial',
  'race',
  'sexual_orientation',
  'disability',
  'judicial',
  'confidential'
]

export function containsSensitiveCategory(categories: string[]): boolean {
  for (const cat of categories) {
    const normalized = cat.toLowerCase().trim()
    if (SENSITIVE_CATEGORIES.some((s) => normalized.includes(s))) {
      return true
    }
  }
  return false
}

export const personalizationPreferencesSchema = z.object({
  optIn: z.boolean().default(true),
  allowPredictiveRecommendations: z.boolean().default(true),
  allowOrderTimingPredictions: z.boolean().default(true),
  excludedCategories: z.array(z.string().min(1).max(50)).default([]),
  version: z.number().int().min(1).optional()
})

export type PersonalizationPreferencesInput = z.infer<typeof personalizationPreferencesSchema>

export interface PersonalizationPreferences {
  customerId: string
  optIn: boolean
  allowPredictiveRecommendations: boolean
  allowOrderTimingPredictions: boolean
  excludedCategories: string[]
  historyPurgedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface IncrementalEventInput {
  id: string
  customerId: string
  sessionId: string
  variant: 'test' | 'holdout'
  eventType: 'impression' | 'click' | 'conversion'
  productId?: string | null
  marginCents: number
  revenueCents: number
  contextSurface: 'home' | 'cart' | 'reorder_widget' | 'catalog' | 'email'
  now: string
}

export interface CampaignOptimizationMetrics {
  holdoutImpressions: number
  holdoutClicks: number
  holdoutConversions: number
  holdoutMarginCents: number
  holdoutRevenueCents: number
  testImpressions: number
  testClicks: number
  testConversions: number
  testMarginCents: number
  testRevenueCents: number
  incrementalMarginLiftCents: number
  conversionLiftPercent: number
  ctrLiftPercent: number
}

export interface CampaignOptimizationRuleInput {
  id: string
  campaignId: string
  name: string
  maxDiscountPercent: number
  frequencyCapDays: number
  budgetCapCents: number
  autoApprovalMaxDiscount: number
}

export interface CampaignOptimizationRule {
  id: string
  campaignId: string
  name: string
  maxDiscountPercent: number
  frequencyCapDays: number
  budgetCapCents: number
  currentSpendCents: number
  autoApprovalMaxDiscount: number
  killSwitchActive: boolean
  status: 'active' | 'paused' | 'killed' | 'archived'
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProposedOptimizationParams {
  discountPercent?: number
  budgetCents?: number
  frequencyCapDays?: number
}

export interface CampaignOptimizationDecision {
  id: string
  ruleId: string
  campaignId: string
  decisionType: 'discount_tune' | 'budget_reallocate' | 'frequency_throttle' | 'emergency_kill'
  previousParams: Record<string, unknown>
  proposedParams: ProposedOptimizationParams
  appliedParams: ProposedOptimizationParams | null
  guardrailEvaluation: {
    passed: boolean
    autoApproved: boolean
    reasons: string[]
  }
  approvalStatus: 'auto_applied' | 'pending_approval' | 'approved' | 'rejected' | 'killed'
  reviewedBy: string | null
  reviewNotes: string | null
  hash: string
  createdAt: string
  updatedAt: string
}

export interface MlModelRegistryItem {
  id: string
  modelName: string
  modelVersion: string
  modelType: 'repurchase_propensity' | 'margin_recommendation' | 'catalog_copilot_assistant' | 'churn_propensity'
  status: 'candidate' | 'gate_passed' | 'active' | 'deprecated' | 'rejected'
  objective: 'margin_retention' | 'conversion_margin' | 'factuality_safety'
  weights: {
    margin: number
    retention: number
    clicks: number
  }
  fallbackStrategy: 'static_bestsellers' | 'category_margin_top' | 'rules_safety_default'
  version: number
  createdAt: string
  updatedAt: string
}

export interface ModelOfflineEvaluationInput {
  actorId: string
  modelId: string
  metrics: {
    rocAuc: number
    precisionAtK: number
    recallAtK: number
    simulatedMarginLiftPercent: number
  }
  driftPsi: number
  biasDisparateImpact: number
  sampleSize: number
  now: string
}

export interface ModelOnlineEvaluationInput {
  actorId: string
  modelId: string
  metrics: {
    ctr: number
    conversionRate: number
    retentionLiftPercent?: number
    marginLiftPercent?: number
  }
  driftPsi: number
  biasDisparateImpact: number
  sampleSize: number
  now: string
}

export interface ModelEvaluationRecord {
  id: string
  modelId: string
  evalType: 'offline' | 'online'
  metrics: Record<string, unknown>
  driftPsi: number
  biasDisparateImpact: number
  marginLiftPercent: number
  retentionLiftPercent: number
  status: 'healthy' | 'drift_detected' | 'bias_detected' | 'degraded'
  sampleSize: number
  createdAt: string
}

export interface ExplainabilityReport {
  customerId: string
  productId: string
  topContributingFactors: Array<{ factor: string; impactScore: number }>
  objectiveBreakdown: {
    marginContribution: number
    retentionContribution: number
    clicksContribution: number
  }
  recommendedAction: string
}

export interface GoldenSetTestCase {
  id: string
  suiteName: string
  testCaseId: string
  category: 'chemical_safety' | 'factuality_dosages' | 'bias_parity' | 'performance_latency' | 'fallback_recovery'
  inputPayload: Record<string, unknown>
  expectedConstraints: Record<string, unknown>
  severity: 'critical' | 'high' | 'medium'
}

export interface AiEvaluationRun {
  id: string
  modelId: string
  suiteName: string
  factualityScore: number
  safetyScore: number
  safetyViolationsCount: number
  biasDisparateImpact: number
  driftPsi: number
  latencyP50Ms: number
  latencyP95Ms: number
  costEstimateEur: number
  fallbackTested: number
  fallbackPassed: number
  gateVerdict: 'passed' | 'rejected'
  gateReasons: string[]
  createdAt: string
}

export interface ModelGateEvaluationInput {
  factualityScore: number
  safetyScore: number
  safetyViolationsCount: number
  biasDisparateImpact: number
  driftPsi: number
  latencyP95Ms: number
  costEstimateEur: number
  fallbackTested: boolean
  fallbackPassed: boolean
}

export interface ModelGateResult {
  passed: boolean
  reasons: string[]
}

/**
 * Validates model performance against strict production quality gates
 */
export function evaluateModelGate(input: ModelGateEvaluationInput): ModelGateResult {
  const reasons: string[] = []

  if (input.safetyViolationsCount > 0 || input.safetyScore < 1.0) {
    reasons.push('safety_violations_detected')
  }

  if (input.factualityScore < 0.95) {
    reasons.push('factuality_below_threshold')
  }

  if (input.biasDisparateImpact < 0.8 || input.biasDisparateImpact > 1.25) {
    reasons.push('bias_disparate_impact_violation')
  }

  if (input.driftPsi > 0.2) {
    reasons.push('drift_threshold_exceeded')
  }

  if (input.latencyP95Ms > 150) {
    reasons.push('latency_sla_exceeded')
  }

  if (!input.fallbackTested || !input.fallbackPassed) {
    reasons.push('fallback_verification_failed')
  }

  return {
    passed: reasons.length === 0,
    reasons
  }
}

/**
 * Evaluates chemical compatibility safety rules
 */
export function evaluateChemicalCompatibility(productNames: string[]): {
  safe: boolean
  incompatiblePair?: [string, string]
  hazardDescription?: string
} {
  const normalized = productNames.map((p) => p.toLowerCase())

  const isBleach = (s: string) => s.includes('lejia') || s.includes('hipoclorito') || s.includes('clorado')
  const isAcid = (s: string) => s.includes('acido') || s.includes('desincrustante') || s.includes('clorhidrico')
  const isAmmonia = (s: string) => s.includes('amoniaco') || s.includes('amoniacal')

  const hasBleach = normalized.some(isBleach)
  const hasAcid = normalized.some(isAcid)
  const hasAmmonia = normalized.some(isAmmonia)

  if (hasBleach && hasAcid) {
    return {
      safe: false,
      hazardDescription: 'Incompatibilidad química severa: Mezcla de hipoclorito y ácido genera gas cloro tóxico.'
    }
  }

  if (hasBleach && hasAmmonia) {
    return {
      safe: false,
      hazardDescription: 'Incompatibilidad química severa: Mezcla de hipoclorito y amoníaco genera cloraminas tóxicas.'
    }
  }

  return { safe: true }
}

/**
 * Computes deterministic SHA-256 hex string using Web Crypto
 */
export async function sha256Hex(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
