import {
  containsSensitiveCategory,
  personalizationPreferencesSchema,
  sha256Hex,
  validateStrictNoSedeNoHierarchy,
  type CampaignOptimizationDecision,
  type CampaignOptimizationMetrics,
  type CampaignOptimizationRule,
  type CampaignOptimizationRuleInput,
  type IncrementalEventInput,
  type PersonalizationPreferences,
  type PersonalizationPreferencesInput,
  type ProposedOptimizationParams
} from '../../shared/predictive-personalization'

export class PredictivePersonalizationError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'unauthorized'
      | 'not_found'
      | 'sensitive_category_forbidden'
      | 'guardrail_max_discount_exceeded'
      | 'guardrail_budget_exceeded'
      | 'guardrail_frequency_cap_exceeded'
      | 'kill_switch_active'
      | 'decision_already_reviewed'
      | 'cas_conflict'
      | 'invalid_input'
  ) {
    super(code)
    this.name = 'PredictivePersonalizationError'
  }
}

export async function requireAdmin(db: D1Database, actorId: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT 1 as ok FROM identities i
       JOIN identity_roles ir ON ir.identity_id = i.id
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE i.id = ?1 AND i.status = 'active' AND rp.permission_code = 'administration.manage'
         AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    )
    .bind(actorId)
    .first<{ ok: number }>()

  if (!row?.ok) throw new PredictivePersonalizationError('forbidden')
}

export async function requireCustomerOrAdmin(db: D1Database, customerId: string, actorId: string): Promise<void> {
  if (actorId === customerId) return

  // Check if actor has admin rights
  const adminRow = await db
    .prepare(
      `SELECT 1 as ok FROM identities i
       JOIN identity_roles ir ON ir.identity_id = i.id
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE i.id = ?1 AND i.status = 'active' AND rp.permission_code = 'administration.manage'
         AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    )
    .bind(actorId)
    .first<{ ok: number }>()

  if (adminRow?.ok) return

  // Check if identity is linked to customer
  const linkedRow = await db
    .prepare(`SELECT 1 as ok FROM identities WHERE id = ?1 AND customer_id = ?2 AND status = 'active'`)
    .bind(actorId, customerId)
    .first<{ ok: number }>()

  if (!linkedRow?.ok) throw new PredictivePersonalizationError('forbidden')
}

interface RawPreferencesRow {
  customer_id: string
  opt_in: number
  allow_predictive_recommendations: number
  allow_order_timing_predictions: number
  excluded_categories_json: string
  history_purged_at: string | null
  version: number
  created_at: string
  updated_at: string
}

function mapPreferences(row: RawPreferencesRow): PersonalizationPreferences {
  return {
    customerId: row.customer_id,
    optIn: row.opt_in === 1,
    allowPredictiveRecommendations: row.allow_predictive_recommendations === 1,
    allowOrderTimingPredictions: row.allow_order_timing_predictions === 1,
    excludedCategories: JSON.parse(row.excluded_categories_json || '[]'),
    historyPurgedAt: row.history_purged_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function getPersonalizationPreferences(
  db: D1Database,
  args: { customerId: string; actorId: string; now?: string }
): Promise<PersonalizationPreferences> {
  await requireCustomerOrAdmin(db, args.customerId, args.actorId)

  const row = await db
    .prepare(
      `SELECT customer_id, opt_in, allow_predictive_recommendations, allow_order_timing_predictions,
              excluded_categories_json, history_purged_at, version, created_at, updated_at
       FROM personalization_preferences WHERE customer_id = ?1`
    )
    .bind(args.customerId)
    .first<RawPreferencesRow>()

  if (!row) {
    // Persist default state if not yet explicitly persisted
    const now = args.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    await db
      .prepare(
        `INSERT OR IGNORE INTO personalization_preferences(
           customer_id, opt_in, allow_predictive_recommendations, allow_order_timing_predictions,
           excluded_categories_json, history_purged_at, version, created_at, updated_at
         ) VALUES (?1, 1, 1, 1, '[]', NULL, 1, ?2, ?2)`
      )
      .bind(args.customerId, now)
      .run()

    return {
      customerId: args.customerId,
      optIn: true,
      allowPredictiveRecommendations: true,
      allowOrderTimingPredictions: true,
      excludedCategories: [],
      historyPurgedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  }

  return mapPreferences(row)
}

export async function updatePersonalizationPreferences(
  db: D1Database,
  args: {
    customerId: string
    actorId: string
    now: string
    input: PersonalizationPreferencesInput
  }
): Promise<PersonalizationPreferences> {
  await requireCustomerOrAdmin(db, args.customerId, args.actorId)

  const parsed = personalizationPreferencesSchema.parse(args.input)

  if (containsSensitiveCategory(parsed.excludedCategories)) {
    throw new PredictivePersonalizationError('sensitive_category_forbidden')
  }

  // Check existing preferences for CAS
  const existing = await db
    .prepare(`SELECT version, created_at FROM personalization_preferences WHERE customer_id = ?1`)
    .bind(args.customerId)
    .first<{ version: number; created_at: string }>()

  if (existing) {
    if (parsed.version !== undefined && parsed.version !== existing.version) {
      throw new PredictivePersonalizationError('cas_conflict')
    }

    const nextVersion = existing.version + 1
    const updatedAt = args.now >= existing.created_at ? args.now : existing.created_at

    await db
      .prepare(
        `UPDATE personalization_preferences
         SET opt_in = ?1,
             allow_predictive_recommendations = ?2,
             allow_order_timing_predictions = ?3,
             excluded_categories_json = ?4,
             version = ?5,
             updated_at = ?6
         WHERE customer_id = ?7 AND version = ?8`
      )
      .bind(
        parsed.optIn ? 1 : 0,
        parsed.allowPredictiveRecommendations ? 1 : 0,
        parsed.allowOrderTimingPredictions ? 1 : 0,
        JSON.stringify(parsed.excludedCategories),
        nextVersion,
        updatedAt,
        args.customerId,
        existing.version
      )
      .run()

    return {
      customerId: args.customerId,
      optIn: parsed.optIn,
      allowPredictiveRecommendations: parsed.allowPredictiveRecommendations,
      allowOrderTimingPredictions: parsed.allowOrderTimingPredictions,
      excludedCategories: parsed.excludedCategories,
      historyPurgedAt: null,
      version: nextVersion,
      createdAt: existing.created_at,
      updatedAt
    }
  }

  // Insert initial preference row
  await db
    .prepare(
      `INSERT INTO personalization_preferences(
         customer_id, opt_in, allow_predictive_recommendations, allow_order_timing_predictions,
         excluded_categories_json, history_purged_at, version, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, ?6, ?6)`
    )
    .bind(
      args.customerId,
      parsed.optIn ? 1 : 0,
      parsed.allowPredictiveRecommendations ? 1 : 0,
      parsed.allowOrderTimingPredictions ? 1 : 0,
      JSON.stringify(parsed.excludedCategories),
      args.now
    )
    .run()

  return {
    customerId: args.customerId,
    optIn: parsed.optIn,
    allowPredictiveRecommendations: parsed.allowPredictiveRecommendations,
    allowOrderTimingPredictions: parsed.allowOrderTimingPredictions,
    excludedCategories: parsed.excludedCategories,
    historyPurgedAt: null,
    version: 1,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function purgePersonalizationHistory(
  db: D1Database,
  args: { customerId: string; actorId: string; now: string }
): Promise<PersonalizationPreferences> {
  await requireCustomerOrAdmin(db, args.customerId, args.actorId)

  // Disassociate customer events
  await db
    .prepare(
      `UPDATE personalization_incremental_events
       SET customer_id = 'anonymized-' || substr(customer_id, 1, 8)
       WHERE customer_id = ?1`
    )
    .bind(args.customerId)
    .run()

  // Update or insert preference with history_purged_at timestamp
  const existing = await db
    .prepare(`SELECT version FROM personalization_preferences WHERE customer_id = ?1`)
    .bind(args.customerId)
    .first<{ version: number }>()

  if (existing) {
    const nextVersion = existing.version + 1
    await db
      .prepare(
        `UPDATE personalization_preferences
         SET history_purged_at = ?1,
             version = ?2,
             updated_at = ?1
         WHERE customer_id = ?3`
      )
      .bind(args.now, nextVersion, args.customerId)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO personalization_preferences(
           customer_id, opt_in, allow_predictive_recommendations, allow_order_timing_predictions,
           excluded_categories_json, history_purged_at, version, created_at, updated_at
         ) VALUES (?1, 1, 1, 1, '[]', ?2, 1, ?2, ?2)`
      )
      .bind(args.customerId, args.now)
      .run()
  }

  return getPersonalizationPreferences(db, { customerId: args.customerId, actorId: args.actorId })
}

export async function getPredictiveRecommendations(
  db: D1Database,
  args: { customerId?: string; surface: string; now: string }
): Promise<{
  variant: 'predictive' | 'fallback_static'
  isFallback: boolean
  products: Array<{ id: string; name: string; score: number }>
}> {
  let canPredict = false

  if (args.customerId) {
    const prefs = await db
      .prepare(
        `SELECT opt_in, allow_predictive_recommendations
         FROM personalization_preferences WHERE customer_id = ?1`
      )
      .bind(args.customerId)
      .first<{ opt_in: number; allow_predictive_recommendations: number }>()

    if (prefs && prefs.opt_in === 1 && prefs.allow_predictive_recommendations === 1) {
      canPredict = true
    }
  }

  // Fallback to static catalog bestsellers
  const rows = await db.prepare(`SELECT id, name FROM products LIMIT 5`).all<{ id: string; name: string }>()

  const products = (rows.results || []).map((p, index) => ({
    id: p.id,
    name: p.name,
    score: canPredict ? 0.95 - index * 0.1 : 0.5 - index * 0.05
  }))

  return {
    variant: canPredict ? 'predictive' : 'fallback_static',
    isFallback: !canPredict,
    products
  }
}

export async function recordIncrementalEvent(db: D1Database, args: IncrementalEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO personalization_incremental_events(
         id, customer_id, session_id, variant, event_type, product_id,
         margin_cents, revenue_cents, context_surface, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      args.id,
      args.customerId,
      args.sessionId,
      args.variant,
      args.eventType,
      args.productId ?? null,
      args.marginCents,
      args.revenueCents,
      args.contextSurface,
      args.now
    )
    .run()
}

export async function getCampaignOptimizationReporting(
  db: D1Database,
  args: { actorId: string }
): Promise<CampaignOptimizationMetrics> {
  await requireAdmin(db, args.actorId)

  const rows = await db
    .prepare(
      `SELECT variant, event_type,
              COUNT(*) as count,
              COALESCE(SUM(margin_cents), 0) as total_margin,
              COALESCE(SUM(revenue_cents), 0) as total_revenue
       FROM personalization_incremental_events
       GROUP BY variant, event_type`
    )
    .all<{
      variant: 'test' | 'holdout'
      event_type: 'impression' | 'click' | 'conversion'
      count: number
      total_margin: number
      total_revenue: number
    }>()

  let holdoutImpressions = 0
  let holdoutClicks = 0
  let holdoutConversions = 0
  let holdoutMarginCents = 0
  let holdoutRevenueCents = 0

  let testImpressions = 0
  let testClicks = 0
  let testConversions = 0
  let testMarginCents = 0
  let testRevenueCents = 0

  for (const r of rows.results || []) {
    if (r.variant === 'holdout') {
      if (r.event_type === 'impression') holdoutImpressions = r.count
      if (r.event_type === 'click') holdoutClicks = r.count
      if (r.event_type === 'conversion') {
        holdoutConversions = r.count
        holdoutMarginCents = r.total_margin
        holdoutRevenueCents = r.total_revenue
      }
    } else if (r.variant === 'test') {
      if (r.event_type === 'impression') testImpressions = r.count
      if (r.event_type === 'click') testClicks = r.count
      if (r.event_type === 'conversion') {
        testConversions = r.count
        testMarginCents = r.total_margin
        testRevenueCents = r.total_revenue
      }
    }
  }

  const incrementalMarginLiftCents = testMarginCents - holdoutMarginCents
  const holdoutCvr = holdoutImpressions > 0 ? holdoutConversions / holdoutImpressions : 0
  const testCvr = testImpressions > 0 ? testConversions / testImpressions : 0
  const conversionLiftPercent = holdoutCvr > 0 ? Math.round(((testCvr - holdoutCvr) / holdoutCvr) * 10000) / 100 : 0

  const holdoutCtr = holdoutImpressions > 0 ? holdoutClicks / holdoutImpressions : 0
  const testCtr = testImpressions > 0 ? testClicks / testImpressions : 0
  const ctrLiftPercent = holdoutCtr > 0 ? Math.round(((testCtr - holdoutCtr) / holdoutCtr) * 10000) / 100 : 0

  return {
    holdoutImpressions,
    holdoutClicks,
    holdoutConversions,
    holdoutMarginCents,
    holdoutRevenueCents,
    testImpressions,
    testClicks,
    testConversions,
    testMarginCents,
    testRevenueCents,
    incrementalMarginLiftCents,
    conversionLiftPercent,
    ctrLiftPercent
  }
}

interface RawRuleRow {
  id: string
  campaign_id: string
  name: string
  max_discount_percent: number
  frequency_cap_days: number
  budget_cap_cents: number
  current_spend_cents: number
  auto_approval_max_discount: number
  kill_switch_active: number
  status: 'active' | 'paused' | 'killed' | 'archived'
  version: number
  created_at: string
  updated_at: string
}

function mapRule(row: RawRuleRow): CampaignOptimizationRule {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    name: row.name,
    maxDiscountPercent: row.max_discount_percent,
    frequencyCapDays: row.frequency_cap_days,
    budgetCapCents: row.budget_cap_cents,
    currentSpendCents: row.current_spend_cents,
    autoApprovalMaxDiscount: row.auto_approval_max_discount,
    killSwitchActive: row.kill_switch_active === 1,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createCampaignOptimizationRule(
  db: D1Database,
  args: {
    actorId: string
    now: string
    input: CampaignOptimizationRuleInput
  }
): Promise<CampaignOptimizationRule> {
  await requireAdmin(db, args.actorId)

  const check = validateStrictNoSedeNoHierarchy(args.input as unknown as Record<string, unknown>)
  if (!check.valid) {
    throw new PredictivePersonalizationError('invalid_input')
  }

  if (args.input.maxDiscountPercent > 50 || args.input.maxDiscountPercent <= 0) {
    throw new PredictivePersonalizationError('guardrail_max_discount_exceeded')
  }

  await db
    .prepare(
      `INSERT INTO campaign_optimization_rules(
         id, campaign_id, name, max_discount_percent, frequency_cap_days, budget_cap_cents,
         current_spend_cents, auto_approval_max_discount, kill_switch_active, status, version,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 0, 'active', 1, ?8, ?8)`
    )
    .bind(
      args.input.id,
      args.input.campaignId,
      args.input.name,
      args.input.maxDiscountPercent,
      args.input.frequencyCapDays,
      args.input.budgetCapCents,
      args.input.autoApprovalMaxDiscount,
      args.now
    )
    .run()

  const created = await db
    .prepare(`SELECT * FROM campaign_optimization_rules WHERE id = ?1`)
    .bind(args.input.id)
    .first<RawRuleRow>()

  if (!created) throw new PredictivePersonalizationError('not_found')
  return mapRule(created)
}

export async function applyCampaignOptimizationDecision(
  db: D1Database,
  args: {
    ruleId: string
    decisionType: 'discount_tune' | 'budget_reallocate' | 'frequency_throttle' | 'emergency_kill'
    proposedParams: ProposedOptimizationParams
    now: string
  }
): Promise<CampaignOptimizationDecision> {
  const ruleRow = await db
    .prepare(`SELECT * FROM campaign_optimization_rules WHERE id = ?1`)
    .bind(args.ruleId)
    .first<RawRuleRow>()

  if (!ruleRow) throw new PredictivePersonalizationError('not_found')
  const rule = mapRule(ruleRow)

  if (rule.killSwitchActive || rule.status === 'killed') {
    throw new PredictivePersonalizationError('kill_switch_active')
  }

  const reasons: string[] = []
  let autoApproved = true

  // 1. Guardrail: Max Discount Check
  if (args.proposedParams.discountPercent !== undefined) {
    if (args.proposedParams.discountPercent > rule.maxDiscountPercent) {
      throw new PredictivePersonalizationError('guardrail_max_discount_exceeded')
    }
    if (args.proposedParams.discountPercent > rule.autoApprovalMaxDiscount) {
      autoApproved = false
      reasons.push('Descuento propuesto supera umbral de auto-aprobación; requiere revisión manual.')
    }
  }

  // 2. Guardrail: Budget Cap Check
  if (args.proposedParams.budgetCents !== undefined) {
    if (args.proposedParams.budgetCents + rule.currentSpendCents > rule.budgetCapCents) {
      throw new PredictivePersonalizationError('guardrail_budget_exceeded')
    }
  }

  // 3. Guardrail: Frequency Cap Check
  if (args.proposedParams.frequencyCapDays !== undefined) {
    if (args.proposedParams.frequencyCapDays < rule.frequencyCapDays) {
      throw new PredictivePersonalizationError('guardrail_frequency_cap_exceeded')
    }
  }

  const approvalStatus: 'auto_applied' | 'pending_approval' = autoApproved ? 'auto_applied' : 'pending_approval'
  const appliedParams = autoApproved ? args.proposedParams : null

  const guardrailEvaluation = {
    passed: true,
    autoApproved,
    reasons
  }

  const previousParams = {
    maxDiscountPercent: rule.maxDiscountPercent,
    frequencyCapDays: rule.frequencyCapDays,
    budgetCapCents: rule.budgetCapCents,
    currentSpendCents: rule.currentSpendCents
  }

  const decisionId = `dec-${args.ruleId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const hash = await sha256Hex(
    `${decisionId}:${args.ruleId}:${rule.campaignId}:${args.decisionType}:${JSON.stringify(args.proposedParams)}:${approvalStatus}:${args.now}`
  )

  await db
    .prepare(
      `INSERT INTO campaign_optimization_decisions(
         id, rule_id, campaign_id, decision_type, previous_params_json, proposed_params_json,
         applied_params_json, guardrail_evaluation_json, approval_status, reviewed_by,
         review_notes, hash, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?11, ?11)`
    )
    .bind(
      decisionId,
      args.ruleId,
      rule.campaignId,
      args.decisionType,
      JSON.stringify(previousParams),
      JSON.stringify(args.proposedParams),
      appliedParams ? JSON.stringify(appliedParams) : null,
      JSON.stringify(guardrailEvaluation),
      approvalStatus,
      hash,
      args.now
    )
    .run()

  return {
    id: decisionId,
    ruleId: args.ruleId,
    campaignId: rule.campaignId,
    decisionType: args.decisionType,
    previousParams,
    proposedParams: args.proposedParams,
    appliedParams,
    guardrailEvaluation,
    approvalStatus,
    reviewedBy: null,
    reviewNotes: null,
    hash,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function reviewOptimizationDecision(
  db: D1Database,
  args: {
    decisionId: string
    actorId: string
    verdict: 'approved' | 'rejected'
    notes: string
    now: string
  }
): Promise<CampaignOptimizationDecision> {
  await requireAdmin(db, args.actorId)

  const row = await db
    .prepare(`SELECT * FROM campaign_optimization_decisions WHERE id = ?1`)
    .bind(args.decisionId)
    .first<{
      id: string
      rule_id: string
      campaign_id: string
      decision_type: 'discount_tune' | 'budget_reallocate' | 'frequency_throttle' | 'emergency_kill'
      previous_params_json: string
      proposed_params_json: string
      applied_params_json: string | null
      guardrail_evaluation_json: string
      approval_status: 'auto_applied' | 'pending_approval' | 'approved' | 'rejected' | 'killed'
      reviewed_by: string | null
      review_notes: string | null
      hash: string
      created_at: string
      updated_at: string
    }>()

  if (!row) throw new PredictivePersonalizationError('not_found')
  if (row.approval_status !== 'pending_approval') {
    throw new PredictivePersonalizationError('decision_already_reviewed')
  }

  const proposed = JSON.parse(row.proposed_params_json)
  const applied = args.verdict === 'approved' ? proposed : null

  await db
    .prepare(
      `UPDATE campaign_optimization_decisions
       SET approval_status = ?1,
           applied_params_json = ?2,
           reviewed_by = ?3,
           review_notes = ?4,
           updated_at = ?5
       WHERE id = ?6`
    )
    .bind(args.verdict, applied ? JSON.stringify(applied) : null, args.actorId, args.notes, args.now, args.decisionId)
    .run()

  return {
    id: row.id,
    ruleId: row.rule_id,
    campaignId: row.campaign_id,
    decisionType: row.decision_type,
    previousParams: JSON.parse(row.previous_params_json),
    proposedParams: proposed,
    appliedParams: applied,
    guardrailEvaluation: JSON.parse(row.guardrail_evaluation_json),
    approvalStatus: args.verdict,
    reviewedBy: args.actorId,
    reviewNotes: args.notes,
    hash: row.hash,
    createdAt: row.created_at,
    updatedAt: args.now
  }
}

export async function toggleKillSwitch(
  db: D1Database,
  args: {
    ruleId: string
    actorId: string
    active: boolean
    reason: string
    now: string
  }
): Promise<CampaignOptimizationRule> {
  await requireAdmin(db, args.actorId)

  const rule = await db
    .prepare(`SELECT * FROM campaign_optimization_rules WHERE id = ?1`)
    .bind(args.ruleId)
    .first<RawRuleRow>()

  if (!rule) throw new PredictivePersonalizationError('not_found')

  const nextStatus = args.active ? 'killed' : 'active'
  const nextVersion = rule.version + 1

  await db
    .prepare(
      `UPDATE campaign_optimization_rules
       SET kill_switch_active = ?1,
           status = ?2,
           version = ?3,
           updated_at = ?4
       WHERE id = ?5`
    )
    .bind(args.active ? 1 : 0, nextStatus, nextVersion, args.now, args.ruleId)
    .run()

  // Audit kill switch action in decisions table
  const auditId = `dec-kill-${args.ruleId}-${Date.now().toString(36)}`
  const hash = await sha256Hex(`${auditId}:${args.ruleId}:${args.active}:${args.reason}:${args.now}`)
  await db
    .prepare(
      `INSERT INTO campaign_optimization_decisions(
         id, rule_id, campaign_id, decision_type, previous_params_json, proposed_params_json,
         applied_params_json, guardrail_evaluation_json, approval_status, reviewed_by,
         review_notes, hash, created_at, updated_at
       ) VALUES (?1, ?2, ?3, 'emergency_kill', '{}', ?4, NULL, '{"passed":true,"autoApproved":true,"reasons":[]}',
                 'killed', ?5, ?6, ?7, ?8, ?8)`
    )
    .bind(
      auditId,
      args.ruleId,
      rule.campaign_id,
      JSON.stringify({ killSwitchActive: args.active }),
      args.actorId,
      args.reason,
      hash,
      args.now
    )
    .run()

  const updated = await db
    .prepare(`SELECT * FROM campaign_optimization_rules WHERE id = ?1`)
    .bind(args.ruleId)
    .first<RawRuleRow>()

  return mapRule(updated!)
}
