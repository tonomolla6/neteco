import type { AutoDiscountRule, AutoDiscountStatus } from '../../shared/auto-discounts'
import type { FreeShippingRule } from '../../shared/free-shipping-policy'

/**
 * Leaf module (shared types only) that reads PRI-014 / PRI-017 rules from D1. The checkout and the
 * cart both import it, so it must not import workers/catalog/*.
 */

export interface AutoDiscountRuleRow {
  id: string
  code: string
  name: string
  status: AutoDiscountStatus
  version: number
  kind: AutoDiscountRule['kind']
  scope_ids_json: string
  benefit_kind: 'percent' | 'fixed' | 'tiers'
  basis_points: number | null
  fixed_gross_cents: number | null
  tiers_json: string
  min_basket_gross_cents: number
  priority: number
  stacking: AutoDiscountRule['stacking']
  segment: AutoDiscountRule['segment']
  margin_floor_basis_points: number
  customer_message: string
  starts_at: string
  ends_at: string | null
}
export const AUTO_DISCOUNT_COLUMNS = `id, code, name, status, version, kind, scope_ids_json, benefit_kind, basis_points, fixed_gross_cents,
  tiers_json, min_basket_gross_cents, priority, stacking, segment, margin_floor_basis_points, customer_message,
  starts_at, ends_at`

export function autoDiscountRuleFromRow(row: AutoDiscountRuleRow): AutoDiscountRule {
  const benefit =
    row.benefit_kind === 'percent'
      ? { kind: 'percent' as const, basisPoints: row.basis_points! }
      : row.benefit_kind === 'fixed'
        ? { kind: 'fixed' as const, grossCents: row.fixed_gross_cents! }
        : {
            kind: 'tiers' as const,
            tiers: JSON.parse(row.tiers_json) as Array<{ minQuantity: number; basisPoints: number }>
          }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    kind: row.kind,
    scopeIds: JSON.parse(row.scope_ids_json) as string[],
    benefit,
    minBasketGrossCents: row.min_basket_gross_cents,
    priority: row.priority,
    stacking: row.stacking,
    segment: row.segment,
    marginFloorBasisPoints: row.margin_floor_basis_points,
    customerMessage: row.customer_message,
    startsAt: row.starts_at,
    endsAt: row.ends_at
  }
}

export interface FreeShippingRuleRow {
  id: string
  code: string
  status: FreeShippingRule['status']
  version: number
  profile: FreeShippingRule['profile']
  zone: FreeShippingRule['zone']
  customer_profile: FreeShippingRule['customerProfile']
  threshold_gross_cents: number
  min_margin_basis_points: number
  conscious_subsidy: number
  subsidy_cap_net_cents: number | null
  subsidy_reason: string | null
}
export const FREE_SHIPPING_COLUMNS = `id, code, status, version, profile, zone, customer_profile, threshold_gross_cents,
  min_margin_basis_points, conscious_subsidy, subsidy_cap_net_cents, subsidy_reason`

export const freeShippingRuleFromRow = (row: FreeShippingRuleRow): FreeShippingRule => ({
  id: row.id,
  code: row.code,
  status: row.status,
  version: row.version,
  profile: row.profile,
  zone: row.zone,
  customerProfile: row.customer_profile,
  thresholdGrossCents: row.threshold_gross_cents,
  minMarginBasisPoints: row.min_margin_basis_points,
  consciousSubsidy: row.conscious_subsidy === 1,
  subsidyCapNetCents: row.subsidy_cap_net_cents,
  subsidyReason: row.subsidy_reason
})

/**
 * Deployments (and historical test fixtures) that predate the pricing migrations have no rule tables.
 * Only that exact condition degrades to "no rules"; every other D1 error propagates (fail closed).
 */
export async function ifPricingTable<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (
      error instanceof Error &&
      /no such table:?\s*(main\.)?(auto_discount_rules|free_shipping_rules|checkout_quote_auto_discounts|shipping_quote_free_shipping|order_pricing_snapshots|store_credit_[a-z_]+)/.test(
        error.message
      )
    )
      return fallback
    throw error
  }
}

export async function loadActiveAutoDiscountRules(db: D1Database, now: string): Promise<AutoDiscountRule[]> {
  return ifPricingTable(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${AUTO_DISCOUNT_COLUMNS} FROM auto_discount_rules WHERE status = 'active' AND starts_at <= ?1
           AND (ends_at IS NULL OR ends_at > ?1) ORDER BY priority, code LIMIT 200`
      )
      .bind(now)
      .all<AutoDiscountRuleRow>()
    return results.map(autoDiscountRuleFromRow)
  }, [])
}

export async function loadActiveParcelFreeShippingRules(db: D1Database): Promise<FreeShippingRule[]> {
  return ifPricingTable(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${FREE_SHIPPING_COLUMNS} FROM free_shipping_rules WHERE status = 'active' AND profile = 'parcel' LIMIT 20`
      )
      .all<FreeShippingRuleRow>()
    return results.map(freeShippingRuleFromRow)
  }, [])
}
