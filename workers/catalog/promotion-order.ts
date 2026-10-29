import { promotionRuleSchema, type PromotionRule } from '../../shared/promotions'
import { promotionRuleHash } from './promotions'
import { readPromotion } from './promotion-lookup'

export interface AppliedOrderPromotion {
  rule: PromotionRule
  ruleHash: string
  customerId: string | null
  discountGrossCents: number
}

/** Historical evidence is immutable; it is never a fresh authorization to use a rule. */
export async function readAppliedOrderPromotion(database: D1Database, quoteId: string): Promise<AppliedOrderPromotion> {
  const row = await database
    .prepare(
      `SELECT q.rule_id,q.rule_version,q.rule_json,q.rule_hash,q.customer_id,
    q.discount_gross_cents,v.rule_hash AS version_hash,
    (SELECT sum(discount_gross_cents) FROM checkout_quote_lines WHERE quote_id=q.quote_id) AS line_discount
    FROM checkout_quote_promotions q JOIN promotion_rule_versions v ON v.rule_id=q.rule_id AND v.version=q.rule_version
    WHERE q.quote_id=?1`
    )
    .bind(quoteId)
    .first<Record<string, unknown>>()
  if (!row || typeof row.rule_json !== 'string') throw new Error('unconfirmed_quote_promotion')
  const rule = promotionRuleSchema.parse(JSON.parse(row.rule_json))
  const ruleHash = await promotionRuleHash(rule)
  if (
    rule.id !== row.rule_id ||
    rule.version !== row.rule_version ||
    ruleHash !== row.rule_hash ||
    ruleHash !== row.version_hash ||
    typeof row.discount_gross_cents !== 'number' ||
    !Number.isSafeInteger(row.discount_gross_cents) ||
    row.discount_gross_cents <= 0 ||
    row.discount_gross_cents !== row.line_discount ||
    (row.customer_id !== null && typeof row.customer_id !== 'string')
  )
    throw new Error('unconfirmed_quote_promotion')
  return { rule, ruleHash, customerId: row.customer_id, discountGrossCents: row.discount_gross_cents }
}

export async function promotionAvailableForOrder(
  database: D1Database,
  promotion: AppliedOrderPromotion,
  customerId: string | null,
  now: string
) {
  if (promotion.customerId !== customerId) return false
  const current = await readPromotion(database, promotion.rule.code, customerId, now)
  if (
    !current ||
    current.ruleHash !== promotion.ruleHash ||
    current.rule.status !== 'active' ||
    current.rule.startsAt > now ||
    (current.rule.endsAt !== null && current.rule.endsAt <= now)
  )
    return false
  if (
    (current.rule.totalLimit !== null && current.redemptions.total >= current.rule.totalLimit) ||
    (current.rule.perCustomerLimit !== null &&
      (!customerId || current.redemptions.customer >= current.rule.perCustomerLimit))
  )
    return false
  if (current.rule.segment !== 'all' && !customerId) return false
  if (
    current.rule.segment === 'approved_company' &&
    !(await database
      .prepare("SELECT 1 FROM companies WHERE customer_id=?1 AND status='approved'")
      .bind(customerId)
      .first())
  )
    return false
  return true
}

/** These statements MUST be inside the order/lines/converted-cart transaction.
 * Counts are checked AFTER inserting our one durable use, under D1's writer lock.
 * A failed guard rolls back the redemption AND the entire order, not just a counter.
 */
export function promotionOrderStatements(
  database: D1Database,
  input: { orderId: string; quoteId: string; now: string }
) {
  const id = `order-promotion:${input.orderId}`
  return [
    database
      .prepare(
        `INSERT INTO promotion_redemptions(rule_id,order_id,customer_id,rule_version,discount_gross_cents,created_at)
      SELECT rule_id,?2,customer_id,rule_version,discount_gross_cents,?3 FROM checkout_quote_promotions WHERE quote_id=?1`
      )
      .bind(input.quoteId, input.orderId, input.now),
    database
      .prepare(
        `INSERT INTO promotion_guards(id,valid)
      SELECT ?1,CASE WHEN EXISTS(
        SELECT 1 FROM orders o JOIN checkout_quote_promotions q ON q.quote_id=o.quote_id
        JOIN promotion_redemptions used ON used.order_id=o.id AND used.rule_id=q.rule_id
        JOIN promotion_rules h ON h.id=q.rule_id AND h.current_version=q.rule_version
        JOIN promotion_rule_versions v ON v.rule_id=h.id AND v.version=h.current_version
        WHERE o.id=?2 AND o.quote_id=?3 AND o.customer_id IS q.customer_id
          AND used.customer_id IS q.customer_id AND used.rule_version=q.rule_version
          AND used.discount_gross_cents=q.discount_gross_cents AND v.rule_hash=q.rule_hash
          AND q.discount_gross_cents=(SELECT sum(discount_gross_cents) FROM order_lines WHERE order_id=o.id)
          AND json_extract(v.rule_json,'$.status')='active'
          AND json_extract(v.rule_json,'$.startsAt')<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
          AND (json_extract(v.rule_json,'$.endsAt') IS NULL OR json_extract(v.rule_json,'$.endsAt')>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
          AND (json_extract(v.rule_json,'$.totalLimit') IS NULL OR
            (SELECT count(*) FROM promotion_redemptions r WHERE r.rule_id=h.id)<=json_extract(v.rule_json,'$.totalLimit'))
          AND (json_extract(v.rule_json,'$.perCustomerLimit') IS NULL OR (q.customer_id IS NOT NULL AND
            (SELECT count(*) FROM promotion_redemptions r WHERE r.rule_id=h.id AND r.customer_id=q.customer_id)<=json_extract(v.rule_json,'$.perCustomerLimit')))
          AND (json_extract(v.rule_json,'$.segment')='all' OR q.customer_id IS NOT NULL)
          AND (json_extract(v.rule_json,'$.segment')<>'approved_company' OR
            EXISTS(SELECT 1 FROM companies c WHERE c.customer_id=q.customer_id AND c.status='approved'))
      ) THEN 1 ELSE 0 END`
      )
      .bind(id, input.orderId, input.quoteId),
    database.prepare('DELETE FROM promotion_guards WHERE id=?1').bind(id)
  ]
}
