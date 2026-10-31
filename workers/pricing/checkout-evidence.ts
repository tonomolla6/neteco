import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { ifPricingTable } from './rules-read'
import type { QuoteAutoDiscountEvidence } from './auto-discount-quote'

/**
 * Evidence readers and the order pricing snapshot of the checkout (PRI-014/017/018 wiring).
 *
 * Order of operations (the only one; documented in the BR-WIRE report):
 *   1 base price -> 2 B2B price list OR governed volume tiers (inside the quote unit price)
 *   3 ONE discount source: eligible coupon, else automatic rules (never both; B2B contract lines excluded)
 *   4 shipping: rate, then free-shipping rule (zone/profile/margin); sales-quote orders keep the approved shipping
 *   5 order total = goods + shipping (immutable, drives fiscal and refunds)
 *   6 store credit: deducted from the amount to CHARGE, never from the order total
 * Payment on credit terms (CUS-023) replaces card payment and is mutually exclusive with store credit.
 */
export const PRICING_PRECEDENCE = [
  'base_price',
  'b2b_price_list_or_volume_tiers',
  'coupon_or_auto_discount',
  'free_shipping',
  'store_credit'
] as const

export interface StoredAutoDiscountEvidence {
  discountGrossCents: number
  evidence: QuoteAutoDiscountEvidence
  evidenceHash: string
}

export async function readQuoteAutoDiscountEvidence(
  db: D1Database,
  quoteId: string
): Promise<StoredAutoDiscountEvidence | null> {
  const row = await ifPricingTable(
    () =>
      db
        .prepare(
          'SELECT discount_gross_cents, evidence_json, evidence_hash FROM checkout_quote_auto_discounts WHERE quote_id = ?1'
        )
        .bind(quoteId)
        .first<{ discount_gross_cents: number; evidence_json: string; evidence_hash: string }>(),
    null
  )
  if (!row) return null
  if ((await sha256Hex(row.evidence_json)) !== row.evidence_hash) throw new Error('unconfirmed_quote_auto_discounts')
  return {
    discountGrossCents: row.discount_gross_cents,
    evidence: JSON.parse(row.evidence_json) as QuoteAutoDiscountEvidence,
    evidenceHash: row.evidence_hash
  }
}

export interface StoredFreeShippingEvidence {
  ruleId: string
  ruleVersion: number
  free: boolean
  evidenceHash: string
  evidence: Record<string, unknown>
}

export async function readShippingFreeEvidence(
  db: D1Database,
  shippingQuoteId: string
): Promise<StoredFreeShippingEvidence | null> {
  const row = await ifPricingTable(
    () =>
      db
        .prepare(
          'SELECT rule_id, rule_version, free, evidence_json, evidence_hash FROM shipping_quote_free_shipping WHERE shipping_quote_id = ?1'
        )
        .bind(shippingQuoteId)
        .first<{ rule_id: string; rule_version: number; free: number; evidence_json: string; evidence_hash: string }>(),
    null
  )
  if (!row) return null
  if ((await sha256Hex(row.evidence_json)) !== row.evidence_hash) throw new Error('unconfirmed_shipping_free_evidence')
  return {
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    free: row.free === 1,
    evidenceHash: row.evidence_hash,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>
  }
}

export interface OrderPricingFacts {
  now: string
  quoteId: string
  shippingQuoteId: string
  coupon: { ruleId: string; version: number; code: string; ruleHash: string; discountGrossCents: number } | null
  b2bContractLines: Array<{ variantId: string; priceVersionId: string }>
  creditTerms: { companyId: string; paymentDays: number; termsVersion: number } | null
  autoDiscounts: StoredAutoDiscountEvidence | null
  freeShipping: StoredFreeShippingEvidence | null
  shipping: { methodCode: string; rateVersion: number; netCents: number; grossCents: number; optionHash: string }
  storeCredit: {
    totalCents: number
    commandKey: string
    allocations: Array<{ grantId: string; cents: number }>
    accountVersionBefore: number
  } | null
  goodsGrossCents: number
  goodsDiscountGrossCents: number
  orderTotalGrossCents: number
}

/** A snapshot exists only when one of the BR rules took part, so legacy orders stay byte-identical. */
export const snapshotRequired = (facts: Pick<OrderPricingFacts, 'autoDiscounts' | 'freeShipping' | 'storeCredit'>) =>
  facts.autoDiscounts !== null || facts.freeShipping?.free === true || facts.storeCredit !== null

export async function buildOrderPricingSnapshot(facts: OrderPricingFacts) {
  const storeCreditCents = facts.storeCredit?.totalCents ?? 0
  const snapshot = {
    schema: 'order-pricing/v1',
    appliedAt: facts.now,
    precedence: [...PRICING_PRECEDENCE],
    quoteId: facts.quoteId,
    shippingQuoteId: facts.shippingQuoteId,
    coupon: facts.coupon,
    b2bContractLines: facts.b2bContractLines,
    creditTerms: facts.creditTerms,
    autoDiscounts: facts.autoDiscounts
      ? { evidenceHash: facts.autoDiscounts.evidenceHash, ...facts.autoDiscounts.evidence }
      : null,
    freeShipping: facts.freeShipping,
    shipping: facts.shipping,
    storeCredit: facts.storeCredit,
    totals: {
      goodsGrossCents: facts.goodsGrossCents,
      goodsDiscountGrossCents: facts.goodsDiscountGrossCents,
      shippingGrossCents: facts.shipping.grossCents,
      orderTotalGrossCents: facts.orderTotalGrossCents,
      storeCreditCents,
      amountDueCents: facts.orderTotalGrossCents - storeCreditCents
    }
  }
  const json = canonicalJson(snapshot)
  return { json, hash: await sha256Hex(json) }
}

export function orderPricingSnapshotStatement(
  db: D1Database,
  orderId: string,
  snapshot: { json: string; hash: string },
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO order_pricing_snapshots(order_id, snapshot_json, snapshot_hash, created_at) VALUES(?1, ?2, ?3, ?4)'
    )
    .bind(orderId, snapshot.json, snapshot.hash, now)
}
