import { z } from 'zod'

/**
 * PRI-017 free shipping conditioned by zone, margin and profile.
 * Pure and integer-cent. Pallet, ADR and remote destinations are never subsidised
 * unless a rule is explicitly marked as a conscious subsidy with a cap and a reason.
 * Margin test: (goodsNet - goodsCost - shippingNet) * 10000 >= goodsNet * minMarginBp
 * and never negative. The shipping net used is the rate the customer would have paid
 * (operating carrier cost is not modelled; this is the conservative proxy).
 */
export const SHIPPING_PROFILES = ['parcel', 'pallet', 'adr'] as const
export const SHIPPING_ZONES = ['local', 'peninsular', 'remote'] as const
export type ShippingProfile = (typeof SHIPPING_PROFILES)[number]
export type ShippingZone = (typeof SHIPPING_ZONES)[number]
export const FREE_SHIPPING_STATUSES = ['draft', 'active', 'paused', 'archived'] as const

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const freeShippingRuleInputSchema = z
  .object({
    code: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/)),
    profile: z.enum(SHIPPING_PROFILES),
    zone: z.enum(SHIPPING_ZONES),
    customerProfile: z.enum(['any', 'consumer', 'company']),
    thresholdGrossCents: cents,
    minMarginBasisPoints: z.number().int().min(0).max(9000),
    consciousSubsidy: z.boolean(),
    subsidyCapNetCents: cents.min(1).nullable(),
    subsidyReason: z.string().trim().min(20).max(500).nullable()
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] })
    const special = v.profile !== 'parcel' || v.zone === 'remote'
    if (special && !v.consciousSubsidy)
      issue('Pallet, ADR and remote need a conscious subsidy rule', 'consciousSubsidy')
    if (v.consciousSubsidy && (v.subsidyCapNetCents === null || v.subsidyReason === null))
      issue('A conscious subsidy needs a cap and a reason', 'subsidyReason')
    if (!v.consciousSubsidy && (v.subsidyCapNetCents !== null || v.subsidyReason !== null))
      issue('Cap and reason belong to conscious subsidies only', 'subsidyReason')
  })
export type FreeShippingRuleInput = z.infer<typeof freeShippingRuleInputSchema>
export type FreeShippingRule = FreeShippingRuleInput & {
  id: string
  version: number
  status: (typeof FREE_SHIPPING_STATUSES)[number]
}

export interface FreeShippingContext {
  profile: ShippingProfile
  zone: ShippingZone
  customerProfile: 'consumer' | 'company'
  goodsGrossCents: number
  goodsNetCents: number
  goodsCostNetCents: number | null
  shippingNetCents: number
}
export type FreeShippingReason =
  | 'granted'
  | 'no_rule'
  | 'inactive'
  | 'rule_mismatch'
  | 'not_subsidised'
  | 'below_threshold'
  | 'cost_unknown'
  | 'subsidy_cap'
  | 'margin_floor'
export interface FreeShippingDecision {
  free: boolean
  reason: FreeShippingReason
  subsidyNetCents: number
}

export function classifyShippingZone(postalCode: string, ownDeliveryPrefixes: readonly string[]): ShippingZone {
  if (!/^\d{5}$/.test(postalCode)) return 'remote'
  if (ownDeliveryPrefixes.some((prefix) => prefix.length > 0 && postalCode.startsWith(prefix))) return 'local'
  const province = Number(postalCode.slice(0, 2))
  if (province < 1 || province > 52 || [7, 35, 38, 51, 52].includes(province)) return 'remote'
  return 'peninsular'
}

export function decideFreeShipping(rule: FreeShippingRule | null, ctx: FreeShippingContext): FreeShippingDecision {
  const no = (reason: FreeShippingReason): FreeShippingDecision => ({ free: false, reason, subsidyNetCents: 0 })
  for (const n of [ctx.goodsGrossCents, ctx.goodsNetCents, ctx.shippingNetCents, ctx.goodsCostNetCents ?? 0])
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('amounts must be non-negative integer cents')
  if (!rule) return no('no_rule')
  if (rule.status !== 'active') return no('inactive')
  if (
    rule.profile !== ctx.profile ||
    rule.zone !== ctx.zone ||
    (rule.customerProfile !== 'any' && rule.customerProfile !== ctx.customerProfile)
  )
    return no('rule_mismatch')
  if ((ctx.profile !== 'parcel' || ctx.zone === 'remote') && !rule.consciousSubsidy) return no('not_subsidised')
  if (ctx.goodsGrossCents < rule.thresholdGrossCents) return no('below_threshold')
  if (ctx.goodsCostNetCents === null) return no('cost_unknown')
  if (rule.consciousSubsidy && ctx.shippingNetCents > (rule.subsidyCapNetCents ?? 0)) return no('subsidy_cap')
  const margin = ctx.goodsNetCents - ctx.goodsCostNetCents - ctx.shippingNetCents
  if (margin < 0 || BigInt(margin) * 10000n < BigInt(ctx.goodsNetCents) * BigInt(rule.minMarginBasisPoints))
    return no('margin_floor')
  return { free: true, reason: 'granted', subsidyNetCents: ctx.shippingNetCents }
}

/**
 * Checkout hook for the standard parcel rate: the threshold alone never frees the
 * shipping; this returns whether the margin/profile rules also allow it.
 * No active rule means "do not subsidise" (fail closed) once a guard is installed.
 */
export function freeShippingGuard(
  rule: FreeShippingRule | null,
  facts: Pick<
    FreeShippingContext,
    'zone' | 'customerProfile' | 'goodsGrossCents' | 'goodsNetCents' | 'goodsCostNetCents'
  >
): (shippingNetCents: number) => boolean {
  return (shippingNetCents) => decideFreeShipping(rule, { ...facts, profile: 'parcel', shippingNetCents }).free
}
