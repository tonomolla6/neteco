import { readFile } from 'node:fs/promises'
import { pricingFixture, BUYER_CLAIMS, CLAIMS, CUSTOMER, utc } from './d1-pricing-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions, type PlaceOrderInput } from '../../workers/catalog/checkout'
import { issueStoreCredit } from '../../workers/pricing/store-credit'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite } from '../support/d1-sqlite'

export { BUYER_CLAIMS, CLAIMS, CUSTOMER, utc }

/** 0146 pricing fixture + 0152 wiring evidence + a parcel zone (peninsular) and priced costs. */
export async function wireFixture() {
  const f = await pricingFixture()
  if (!f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='promotion_rules'").get()) {
    const adapter = d1OverSqlite(f.sqlite)
    const coupons = await readFile(new URL('../../db/d1/migrations/0072_promotions.sql', import.meta.url), 'utf8')
    await adapter.batch(splitDemoSql(coupons).map((statement) => adapter.prepare(statement)))
  }
  f.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0152_checkout_pricing_wire.sql', import.meta.url), 'utf8')
  )
  const now = utc(-60000)
  f.sqlite
    .exec(`INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('parcel-zone','parcel','Parcel','parcel_peninsular','["peninsular"]',1,'${now}');
    INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('parcel-rate','parcel-zone','parcel','parcel',600,2100,1,2,1,1,'${now}')`)
  f.sqlite.exec('UPDATE variants SET cost_net_cents = 200')
  return f
}
export type WireFixture = Awaited<ReturnType<typeof wireFixture>>

let ruleSeq = 0
export function insertAutoRule(f: WireFixture, changes: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    code: `AUTO${++ruleSeq}`,
    name: 'Automatic test discount',
    status: 'active',
    version: 1,
    kind: 'product',
    scope_ids_json: '["p-1"]',
    benefit_kind: 'percent',
    basis_points: 1000,
    fixed_gross_cents: null,
    tiers_json: '[]',
    min_basket_gross_cents: 0,
    priority: 10,
    stacking: 'exclusive',
    segment: 'all',
    margin_floor_basis_points: 1000,
    customer_message: 'Descuento automatico',
    starts_at: utc(-3600000),
    ends_at: null,
    created_at: utc(-3600000),
    updated_at: utc(-3600000),
    updated_by: CLAIMS.identityId,
    ...changes
  }
  const keys = Object.keys(row)
  f.sqlite
    .prepare(`INSERT INTO auto_discount_rules(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as Array<string | number | null>))
  return row
}
export function updateAutoRule(f: WireFixture, id: string, changes: Record<string, string | number | null>) {
  const keys = Object.keys(changes)
  f.sqlite
    .prepare(
      `UPDATE auto_discount_rules SET ${keys.map((k) => `${k} = ?`).join(',')}, version = version + 1, updated_at = ? WHERE id = ?`
    )
    .run(...Object.values(changes), utc(), id)
}

let shippingSeq = 0
export function insertFreeShippingRule(f: WireFixture, changes: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    code: `FREE${++shippingSeq}`,
    status: 'active',
    version: 1,
    profile: 'parcel',
    zone: 'peninsular',
    customer_profile: 'any',
    threshold_gross_cents: 1000,
    min_margin_basis_points: 1000,
    conscious_subsidy: 0,
    subsidy_cap_net_cents: null,
    subsidy_reason: null,
    created_at: utc(-3600000),
    updated_at: utc(-3600000),
    updated_by: CLAIMS.identityId,
    ...changes
  }
  const keys = Object.keys(row)
  f.sqlite
    .prepare(`INSERT INTO free_shipping_rules(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as Array<string | number | null>))
  return row
}
export function updateFreeShippingRule(f: WireFixture, id: string, changes: Record<string, string | number | null>) {
  const keys = Object.keys(changes)
  f.sqlite
    .prepare(
      `UPDATE free_shipping_rules SET ${keys.map((k) => `${k} = ?`).join(',')}, version = version + 1, updated_at = ? WHERE id = ?`
    )
    .run(...Object.values(changes), utc(), id)
}

let creditSeq = 0
/** Real admin issuance path (command row, ledger, audit). */
export async function grantCredit(f: WireFixture, amountCents: number, expiresInDays = 60) {
  const receipt = await issueStoreCredit(
    f.database,
    CLAIMS,
    {
      customerId: CUSTOMER,
      kind: 'compensation_coupon',
      sourceRef: `wire-credit-${++creditSeq}-${crypto.randomUUID().slice(0, 8)}`,
      amountCents,
      expiresInDays,
      reason: 'Compensacion de prueba para el checkout'
    },
    crypto.randomUUID(),
    utc()
  )
  return (receipt.result as { grantId: string }).grantId
}

export const ADDRESS = {
  recipientName: 'Buyer',
  line1: 'Carrer Major 1',
  city: 'Ontinyent',
  province: 'Valencia',
  postalCode: '46870',
  phone: '+34600111222'
}
export const MADRID = { ...ADDRESS, city: 'Madrid', province: 'Madrid', postalCode: '28001' }

export interface Prepared {
  cartId: string
  token: string
  quoteId: string
  shippingQuoteId: string
  options: Array<{ methodCode: string; optionIndex: number; optionHash: string; netCents: number; grossCents: number }>
  base: Omit<PlaceOrderInput, 'selectedOptionIndex' | 'selectedOptionHash'>
}

/** Cart -> quote -> shipping options for the given lines/destination. Returns a ready PlaceOrderInput base. */
export async function prepare(
  f: WireFixture,
  options: {
    lines?: Array<{ variantId: string; quantity: number }>
    address?: typeof ADDRESS
    owner?: boolean
    couponCode?: string
    threshold?: number | null
    tag?: string
    expectedTotalGrossCents?: number
  } = {}
): Promise<Prepared> {
  const tag = options.tag ?? crypto.randomUUID().slice(0, 8)
  const address = options.address ?? ADDRESS
  const owner = options.owner ?? true
  const created = await createCart(f.database, { correlationId: `wire-${tag}`, now: utc() })
  let version = 1
  for (const [index, line] of (options.lines ?? [{ variantId: 'v-1-1', quantity: 2 }]).entries()) {
    const added = await setCartLine(f.database, {
      ...created,
      variantId: line.variantId,
      quantity: line.quantity,
      expectedVersion: version,
      idempotencyKey: `add-${tag}-${index}`,
      correlationId: `wire-${tag}`,
      now: utc()
    })
    if (added.outcome !== 'applied') throw new Error(`add failed: ${added.outcome}`)
    version += 1
  }
  const context = {
    cartId: created.cartId,
    token: created.token,
    expectedVersion: version,
    correlationId: `wire-${tag}`
  }
  const quote = await quoteCart(f.database, {
    ...context,
    idempotencyKey: `quote-${tag}`,
    now: utc(),
    ...(owner ? { ownerSession: BUYER_CLAIMS } : {}),
    ...(options.couponCode ? { couponCode: options.couponCode } : {})
  })
  if (quote.outcome !== 'quoted') throw new Error(`quote failed: ${quote.outcome}`)
  const shipping = await requestShippingOptions(f.database, {
    ...context,
    idempotencyKey: `shipping-${tag}`,
    now: utc(),
    ...(owner ? { ownerSession: BUYER_CLAIMS } : {}),
    freeShippingThresholdCents: options.threshold ?? null,
    destination: { city: address.city, postalCode: address.postalCode }
  })
  if (shipping.outcome !== 'options') throw new Error(`shipping failed: ${shipping.outcome}`)
  return {
    cartId: created.cartId,
    token: created.token,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: String(shipping.body.shippingQuoteId),
    options: shipping.body.options as Prepared['options'],
    base: {
      ...context,
      idempotencyKey: `checkout-${tag}`,
      now: utc(),
      ...(owner ? { ownerSession: BUYER_CLAIMS } : {}),
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      contactEmail: 'buyer@example.invalid',
      shippingAddress: address,
      consentTos: true as const,
      consentPrivacy: true as const,
      ...(options.expectedTotalGrossCents === undefined
        ? {}
        : { expectedTotalGrossCents: options.expectedTotalGrossCents })
    }
  }
}

export async function order(
  f: WireFixture,
  prepared: Prepared,
  method: 'pickup' | 'parcel' | 'own_delivery' = 'pickup',
  extra: Partial<PlaceOrderInput> = {},
  threshold: number | null = null,
  fraudOptions: {
    promoFraudPepper?: string
    storeCreditRedemptionEnabled?: boolean
    STORE_CREDIT_REDEMPTION_ENABLED?: string
  } = { storeCreditRedemptionEnabled: true }
) {
  const option = prepared.options.find((o) => o.methodCode === method)
  if (!option) throw new Error(`no ${method} option`)
  return placeOrder(
    f.database,
    { ...prepared.base, selectedOptionIndex: option.optionIndex, selectedOptionHash: option.optionHash, ...extra },
    undefined,
    threshold,
    fraudOptions
  )
}
