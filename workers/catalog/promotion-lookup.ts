import { normalizePromotionCode, promotionRuleSchema, type PromotionRule } from '../../shared/promotions'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { promotionRuleHash } from './promotions'

export interface PromotionLookup {
  rule: PromotionRule
  ruleHash: string
  redemptions: { total: number; customer: number }
}
export class PromotionLookupError extends Error {
  constructor(readonly code: 'history_unconfirmed' | 'invalid_input') {
    super(code)
    this.name = 'PromotionLookupError'
  }
}

/** Caller resolves current customer/session authority; this lookup never authorizes claims.
 * Rule head, immutable revision and counters come from one coherent read. Checkout
 * must still compare this version and enforce the counters inside its own batch. */
export async function readPromotion(
  database: D1Database,
  rawCode: string,
  customerId: string | null,
  now: string
): Promise<PromotionLookup | null> {
  let code: string
  try {
    code = normalizePromotionCode(rawCode)
  } catch {
    throw new PromotionLookupError('invalid_input')
  }
  if (
    !catalogPolicyInstantSchema.safeParse(now).success ||
    (customerId !== null && !catalogPolicyUuidSchema.safeParse(customerId).success)
  )
    throw new PromotionLookupError('invalid_input')
  // Do not turn prepare/read failures into business-level coupon unavailability.
  const row = await database
    .prepare(
      `
    SELECT h.id AS headId,h.code AS headCode,h.current_version AS headVersion,
      h.created_at AS headCreatedAt,h.updated_at AS headUpdatedAt,
      v.rule_json AS ruleJson,v.rule_hash AS ruleHash,v.created_at AS versionCreatedAt,
      (SELECT count(*) FROM promotion_redemptions r WHERE r.rule_id=h.id) AS totalUses,
      (SELECT count(*) FROM promotion_redemptions r WHERE r.rule_id=h.id AND r.customer_id=?2) AS customerUses
    FROM promotion_rules h
    LEFT JOIN promotion_rule_versions v ON v.rule_id=h.id AND v.version=h.current_version
    WHERE h.code=?1
  `
    )
    .bind(code, customerId)
    .first<Record<string, unknown>>()
  if (!row) return null
  const corrupt = () => {
    throw new PromotionLookupError('history_unconfirmed')
  }
  let raw: unknown
  try {
    raw = typeof row.ruleJson === 'string' ? JSON.parse(row.ruleJson) : null
  } catch {
    return corrupt()
  }
  const parsed = promotionRuleSchema.safeParse(raw)
  if (!parsed.success) return corrupt()
  const rule = parsed.data
  if (rule.id !== row.headId || rule.version !== row.headVersion || rule.code !== row.headCode || rule.code !== code)
    return corrupt()
  for (const field of ['headCreatedAt', 'headUpdatedAt', 'versionCreatedAt'] as const) {
    const value = row[field]
    if (
      typeof value !== 'string' ||
      !catalogPolicyInstantSchema.safeParse(value).success ||
      Date.parse(value) > Date.parse(now)
    )
      return corrupt()
  }
  if (
    Date.parse(String(row.headCreatedAt)) > Date.parse(String(row.headUpdatedAt)) ||
    Date.parse(String(row.versionCreatedAt)) > Date.parse(String(row.headUpdatedAt))
  )
    return corrupt()
  const ruleHash = await promotionRuleHash(rule)
  if (ruleHash !== row.ruleHash) return corrupt()
  if (
    typeof row.totalUses !== 'number' ||
    !Number.isSafeInteger(row.totalUses) ||
    row.totalUses < 0 ||
    typeof row.customerUses !== 'number' ||
    !Number.isSafeInteger(row.customerUses) ||
    row.customerUses < 0 ||
    row.customerUses > row.totalUses
  )
    return corrupt()
  return { rule, ruleHash, redemptions: { total: row.totalUses, customer: row.customerUses } }
}
