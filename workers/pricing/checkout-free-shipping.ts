import { quoteLine } from '../../server/domain/money'
import {
  classifyShippingZone,
  decideFreeShipping,
  type FreeShippingDecision,
  type FreeShippingRule,
  type ShippingZone
} from '../../shared/free-shipping-policy'
import { CartError, mapQuoteLines, prepareQuoteLinesStatement, type RawResolvedLine } from '../catalog/cart'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { evaluateQuoteAutoDiscounts } from './auto-discount-quote'
import { loadActiveParcelFreeShippingRules } from './rules-read'

/**
 * PRI-017 wiring for shipping options. Only the standard parcel rate can be freed (that is what the
 * `allowFree` hook of mapShippingOptions supports); pallet/ADR subsidies stay a separate, explicit rule.
 *
 * Rules govern as soon as an active PARCEL rule exists: the matching (zone, customer profile) rule
 * replaces the legacy threshold, and a context without a matching rule is never freed (fail closed).
 * With no active parcel rule the legacy threshold behaviour is untouched.
 */
export interface FreeShippingPolicy {
  /** Effective threshold for resolveShippingOptions (rule threshold, else the legacy value). */
  thresholdGrossCents: number | null
  allowFree: (shippingNetCents: number) => boolean
  /** Null when no rule matched this context. */
  evidence: () => Promise<FreeShippingEvidence | null>
}

export interface FreeShippingEvidence {
  json: string
  hash: string
  ruleId: string
  ruleVersion: number
  free: boolean
}

export async function resolveFreeShippingPolicy(
  db: D1Database,
  input: {
    cartId: string
    postalCode: string
    now: string
    legacyThresholdCents: number | null
    ownerSession?: VerifiedSessionClaims | null
    hasSalesQuote: boolean
  }
): Promise<FreeShippingPolicy | null> {
  // An approved sales quote fixes goods and shipping contractually: rules do not rewrite it.
  if (input.hasSalesQuote) return null
  const rules = await loadActiveParcelFreeShippingRules(db)
  if (rules.length === 0) return null

  const customerId = input.ownerSession ? await activeOrderCustomerId(db, input.ownerSession, input.now) : null
  if (input.ownerSession && !customerId) throw new CartError('unauthorized', 'Customer session is no longer active')
  const company = customerId
    ? await db
        .prepare("SELECT 1 AS approved FROM companies WHERE customer_id = ?1 AND status = 'approved'")
        .bind(customerId)
        .first()
    : null
  const [quoted, zones] = await db.batch([
    prepareQuoteLinesStatement(db, {
      cartId: input.cartId,
      instant: input.now,
      ...(customerId && company ? { customerId } : {})
    }),
    db.prepare("SELECT postal_prefixes FROM shipping_zones WHERE kind = 'own_delivery' AND active = 1 LIMIT 20")
  ])
  const lines = mapQuoteLines(quoted!.results as unknown as RawResolvedLine[])
  if (lines.length === 0) throw new CartError('empty_cart', 'Cannot price shipping for an empty cart')
  const ownPrefixes = (zones!.results as Array<{ postal_prefixes: string }>).flatMap((row) => {
    try {
      const parsed: unknown = JSON.parse(row.postal_prefixes)
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
    } catch {
      return []
    }
  })
  const zone: ShippingZone = classifyShippingZone(input.postalCode, ownPrefixes)
  const customerProfile = company ? ('company' as const) : ('consumer' as const)
  const rule: FreeShippingRule | undefined = rules
    .filter((r) => r.zone === zone && (r.customerProfile === 'any' || r.customerProfile === customerProfile))
    .sort((a, b) => Number(a.customerProfile === 'any') - Number(b.customerProfile === 'any'))[0]
  if (!rule)
    return { thresholdGrossCents: input.legacyThresholdCents, allowFree: () => false, evidence: async () => null }

  const goodsGross = lines.reduce((sum, line) => sum + line.unitGrossCents * line.quantity, 0)
  const auto = await evaluateQuoteAutoDiscounts(db, {
    now: input.now,
    customerId,
    companyApproved: Boolean(company),
    lines: lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      categoryId: line.categoryId,
      sku: line.sku,
      quantity: line.quantity,
      unitGrossCents: line.unitGrossCents,
      costUnitNetCents: line.costUnitNetCents,
      taxRateBasisPoints: line.taxRateBasisPoints,
      priceVersionId: line.priceVersionId
    }))
  })
  const goodsNet = lines.reduce(
    (sum, line, index) =>
      sum + quoteLine({ ...line, discountGrossCents: auto?.discountByIndex.get(index) ?? 0 }).netCents,
    0
  )
  const cost = lines.some((line) => line.costUnitNetCents === null)
    ? null
    : lines.reduce((sum, line) => sum + line.costUnitNetCents! * line.quantity, 0)
  const facts = { goodsGrossCents: goodsGross, goodsNetCents: goodsNet, goodsCostNetCents: cost }
  const decisions: Array<FreeShippingDecision & { shippingNetCents: number }> = []
  return {
    thresholdGrossCents: rule.thresholdGrossCents,
    allowFree: (shippingNetCents) => {
      const decision = decideFreeShipping(rule, {
        profile: 'parcel',
        zone,
        customerProfile,
        ...facts,
        shippingNetCents
      })
      decisions.push({ shippingNetCents, ...decision })
      return decision.free
    },
    evidence: async () => {
      const evidence = {
        schema: 'shipping-free/v1',
        ruleId: rule.id,
        code: rule.code,
        version: rule.version,
        zone,
        customerProfile,
        thresholdGrossCents: rule.thresholdGrossCents,
        minMarginBasisPoints: rule.minMarginBasisPoints,
        consciousSubsidy: rule.consciousSubsidy,
        facts,
        decisions: decisions.map((d) => ({
          shippingNetCents: d.shippingNetCents,
          free: d.free,
          reason: d.reason,
          subsidyNetCents: d.subsidyNetCents
        }))
      }
      const json = canonicalJson(evidence)
      return {
        json,
        hash: await sha256Hex(json),
        ruleId: rule.id,
        ruleVersion: rule.version,
        free: decisions.some((d) => d.free)
      }
    }
  }
}

export function freeShippingEvidenceStatement(
  db: D1Database,
  shippingQuoteId: string,
  evidence: FreeShippingEvidence,
  now: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO shipping_quote_free_shipping(shipping_quote_id, rule_id, rule_version, free, evidence_json, evidence_hash, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(
      shippingQuoteId,
      evidence.ruleId,
      evidence.ruleVersion,
      evidence.free ? 1 : 0,
      evidence.json,
      evidence.hash,
      now
    )
}
