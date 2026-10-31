import { evaluateAutoDiscounts, type AutoDiscountRule } from '../../shared/auto-discounts'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { loadActiveAutoDiscountRules } from './rules-read'

/**
 * PRI-014 wiring for the checkout quote. Pure server facts in, deterministic evidence out.
 *
 * Precedence (documented once, enforced here, in cart.ts and by 0155 triggers):
 *   1. base price (public version) -> 2. governed volume tiers / B2B price list (already inside unitGrossCents)
 *   3. ONE discount source: an eligible coupon wins; otherwise the automatic rules; they never stack
 *   4. negotiated B2B contract lines (price version "b2b:...") are never discounted automatically
 */
export interface QuoteAutoDiscountLine {
  variantId: string
  productId: string
  categoryId: string
  sku: string
  quantity: number
  /** Effective unit price after volume tier or contract price. */
  unitGrossCents: number
  costUnitNetCents: number | null
  taxRateBasisPoints: number
  priceVersionId: string
}

export interface QuoteAutoDiscountEvidence {
  schema: 'checkout-auto-discounts/v1'
  evaluatedAt: string
  customer: { signedIn: boolean; companyApproved: boolean }
  excludedContractVariants: string[]
  rules: Array<{
    ruleId: string
    code: string
    version: number
    kind: string
    priority: number
    stacking: string
    discountGrossCents: number
    lines: Array<{ lineIndex: number; discountGrossCents: number }>
  }>
  skipped: Array<{ ruleId: string; version: number; reason: string }>
  totalDiscountGrossCents: number
}

export interface QuoteAutoDiscounts {
  /** Discount in gross cents per quote line index (only lines that receive one). */
  discountByIndex: Map<number, number>
  totalDiscountGrossCents: number
  /** Customer-safe: message and amount only. */
  explanations: Array<{ message: string; discountGrossCents: number }>
  evidence: QuoteAutoDiscountEvidence
  evidenceJson: string
  evidenceHash: string
}

export const isContractPriceVersion = (priceVersionId: string) => priceVersionId.startsWith('b2b:')

/** Returns null when nothing applies, which is exactly the legacy behaviour. */
export async function evaluateQuoteAutoDiscounts(
  db: D1Database,
  input: { now: string; customerId: string | null; companyApproved: boolean; lines: QuoteAutoDiscountLine[] },
  rulesOverride?: AutoDiscountRule[]
): Promise<QuoteAutoDiscounts | null> {
  const rules = rulesOverride ?? (await loadActiveAutoDiscountRules(db, input.now))
  if (rules.length === 0) return null
  const eligible = input.lines.flatMap((line, lineIndex) =>
    isContractPriceVersion(line.priceVersionId) ? [] : [{ line, lineIndex }]
  )
  if (eligible.length === 0) return null
  const result = evaluateAutoDiscounts(rules, {
    now: input.now,
    customerId: input.customerId,
    companyApproved: input.companyApproved,
    lines: eligible.map(({ line, lineIndex }) => ({
      lineIndex,
      variantId: line.variantId,
      productId: line.productId,
      categoryId: line.categoryId,
      sku: line.sku,
      quantity: line.quantity,
      unitGrossCents: line.unitGrossCents,
      costUnitNetCents: line.costUnitNetCents,
      taxRateBasisPoints: line.taxRateBasisPoints
    }))
  })
  if (result.applied.length === 0 || result.totals.discountGrossCents <= 0) return null
  const versionOf = new Map(rules.map((rule) => [rule.id, rule.version]))
  const discountByIndex = new Map<number, number>()
  for (const line of result.lines)
    if (line.discountGrossCents > 0) discountByIndex.set(line.lineIndex, line.discountGrossCents)
  const evidence: QuoteAutoDiscountEvidence = {
    schema: 'checkout-auto-discounts/v1',
    evaluatedAt: input.now,
    customer: { signedIn: input.customerId !== null, companyApproved: input.companyApproved },
    excludedContractVariants: input.lines
      .filter((l) => isContractPriceVersion(l.priceVersionId))
      .map((l) => l.variantId),
    rules: result.applied.map((applied) => ({
      ruleId: applied.ruleId,
      code: applied.code,
      version: versionOf.get(applied.ruleId)!,
      kind: applied.kind,
      priority: applied.priority,
      stacking: rules.find((rule) => rule.id === applied.ruleId)!.stacking,
      discountGrossCents: applied.discountGrossCents,
      lines: applied.lines
    })),
    skipped: result.skipped.map((s) => ({ ruleId: s.ruleId, version: versionOf.get(s.ruleId)!, reason: s.reason })),
    totalDiscountGrossCents: result.totals.discountGrossCents
  }
  const evidenceJson = canonicalJson(evidence)
  return {
    discountByIndex,
    totalDiscountGrossCents: result.totals.discountGrossCents,
    explanations: result.explanations,
    evidence,
    evidenceJson,
    evidenceHash: await sha256Hex(evidenceJson)
  }
}

/**
 * Statements for the quote batch: immutable evidence + a guard that rolls the whole quote back when any
 * applied rule changed version or left 'active' between evaluation and commit (same pattern as coupons).
 */
export function autoDiscountStatements(
  db: D1Database,
  quoteId: string,
  commandKey: string,
  correlationId: string,
  discounts: QuoteAutoDiscounts,
  now: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO checkout_quote_auto_discounts(quote_id, discount_gross_cents, evidence_json, evidence_hash, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)`
      )
      .bind(quoteId, discounts.totalDiscountGrossCents, discounts.evidenceJson, discounts.evidenceHash, now),
    db
      .prepare(
        `INSERT INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
         SELECT 'auto-guard:' || ?1, '0000000000000000000000000000000000000000000000000000000000000000',
                'guard-impossible', 1, '2026-01-01T00:00:00Z', ?2, ?3, ?3
         WHERE EXISTS (
           SELECT 1 FROM json_each(?4) applied
           WHERE NOT EXISTS (
             SELECT 1 FROM auto_discount_rules rule
             WHERE rule.id = json_extract(applied.value, '$.ruleId')
               AND rule.version = json_extract(applied.value, '$.version') AND rule.status = 'active'
           )
         )`
      )
      .bind(
        `${commandKey}:${quoteId}`,
        correlationId,
        now,
        JSON.stringify(discounts.evidence.rules.map((r) => ({ ruleId: r.ruleId, version: r.version })))
      )
  ]
}
