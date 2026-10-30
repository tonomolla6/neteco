import { z } from 'zod'
import { quoteLine, roundRatio, type QuoteLine } from '../server/domain/money'
import { catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

/**
 * PRI-014 automatic discounts. Pure, deterministic and integer-cent only.
 * Rounding: every percentage is rounded half-up once (roundRatio); fixed and basket
 * amounts are allocated across lines by largest remainder, ties by lineIndex.
 * Priority: lower number first, ties by code. An exclusive rule only touches lines
 * that still carry no discount and locks them; stackable rules compound on the
 * remaining gross. A discount never takes a line below its margin floor; when the
 * cost is unknown the line is not discounted at all (fail closed).
 */
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const AUTO_DISCOUNT_KINDS = ['product', 'category', 'basket', 'volume'] as const
export const AUTO_DISCOUNT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type AutoDiscountStatus = (typeof AUTO_DISCOUNT_STATUSES)[number]

const tierSchema = z
  .object({ minQuantity: z.number().int().min(2).max(100000), basisPoints: z.number().int().min(1).max(10000) })
  .strict()
export const autoDiscountBenefitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), basisPoints: z.number().int().min(1).max(10000) }).strict(),
  z.object({ kind: z.literal('fixed'), grossCents: cents.min(1) }).strict(),
  z.object({ kind: z.literal('tiers'), tiers: z.array(tierSchema).min(1).max(10) }).strict()
])

export const autoDiscountRuleInputSchema = z
  .object({
    code: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/)),
    name: z.string().trim().min(3).max(120),
    kind: z.enum(AUTO_DISCOUNT_KINDS),
    /** product ids, category ids, or (basket/volume) an optional category restriction. */
    scopeIds: z.array(identity).max(100),
    benefit: autoDiscountBenefitSchema,
    minBasketGrossCents: cents,
    priority: z.number().int().min(1).max(1000),
    stacking: z.enum(['exclusive', 'stackable']),
    segment: z.enum(['all', 'registered', 'approved_company']),
    marginFloorBasisPoints: z.number().int().min(0).max(9000),
    customerMessage: z.string().trim().min(3).max(160),
    startsAt: instant,
    endsAt: instant.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: 'custom', message, path })
    if (new Set(value.scopeIds).size !== value.scopeIds.length) issue('Duplicate scope identity', ['scopeIds'])
    if ((value.kind === 'product' || value.kind === 'category') && value.scopeIds.length === 0)
      issue('Scope required', ['scopeIds'])
    if ((value.kind === 'volume') !== (value.benefit.kind === 'tiers'))
      issue('Tiers belong to volume rules only', ['benefit'])
    if (value.kind !== 'basket' && value.minBasketGrossCents !== 0)
      issue('Basket minimum belongs to basket rules', ['minBasketGrossCents'])
    if (value.endsAt !== null && Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      issue('End must follow start', ['endsAt'])
    if (value.benefit.kind === 'tiers') {
      const tiers = value.benefit.tiers
      for (let i = 1; i < tiers.length; i++)
        if (tiers[i]!.minQuantity <= tiers[i - 1]!.minQuantity || tiers[i]!.basisPoints < tiers[i - 1]!.basisPoints)
          issue('Tiers must grow in quantity and not shrink in discount', ['benefit', 'tiers'])
    }
  })
export type AutoDiscountRuleInput = z.infer<typeof autoDiscountRuleInputSchema>
export type AutoDiscountRule = AutoDiscountRuleInput & { id: string; version: number; status: AutoDiscountStatus }

export interface AutoDiscountLine {
  lineIndex: number
  variantId: string
  productId: string
  categoryId: string
  sku: string
  quantity: number
  /** Effective unit price after the governed volume tier, supplied by the server. */
  unitGrossCents: number
  costUnitNetCents: number | null
  taxRateBasisPoints: number
}
export interface AutoDiscountContext {
  now: string
  customerId: string | null
  companyApproved: boolean
  lines: AutoDiscountLine[]
}
export type AutoDiscountSkipReason = 'cost_unknown' | 'below_basket_minimum' | 'no_eligible_lines' | 'margin_floor'
export interface AutoDiscountResult {
  lines: Array<QuoteLine & { lineIndex: number }>
  totals: { discountGrossCents: number; netCents: number; taxCents: number; grossCents: number }
  /** Customer-facing: message and amount only. No rule codes, costs or margins. */
  explanations: Array<{ message: string; discountGrossCents: number }>
  /** Admin-facing detail. */
  applied: Array<{
    ruleId: string
    code: string
    kind: string
    priority: number
    discountGrossCents: number
    lines: Array<{ lineIndex: number; discountGrossCents: number }>
  }>
  skipped: Array<{ ruleId: string; reason: AutoDiscountSkipReason }>
}

function allocate(entries: Array<{ lineIndex: number; gross: number }>, discount: number): Map<number, number> {
  const total = entries.reduce((n, e) => n + e.gross, 0)
  if (total === 0 || discount === 0) return new Map(entries.map((e) => [e.lineIndex, 0]))
  const shares = entries.map((e) => {
    const numerator = BigInt(e.gross) * BigInt(discount)
    return { lineIndex: e.lineIndex, amount: Number(numerator / BigInt(total)), remainder: numerator % BigInt(total) }
  })
  let left = discount - shares.reduce((n, s) => n + s.amount, 0)
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.lineIndex - b.lineIndex : a.remainder > b.remainder ? -1 : 1
  )
  for (const share of order) {
    if (left === 0) break
    share.amount += 1
    left -= 1
  }
  return new Map(shares.map((s) => [s.lineIndex, s.amount]))
}

/** Largest total discount keeping the line net at or above cost / (1 - floor). */
function maxDiscountForLine(line: AutoDiscountLine, floorBasisPoints: number): number {
  const gross = line.unitGrossCents * line.quantity
  const cost = BigInt(line.costUnitNetCents ?? 0) * BigInt(line.quantity)
  const denominator = BigInt(10000 - floorBasisPoints)
  const minNet = Number((cost * 10000n + denominator - 1n) / denominator)
  const netAt = (discount: number) => quoteLine({ ...line, discountGrossCents: discount }).netCents
  if (netAt(0) < minNet) return 0
  let low = 0
  let high = gross
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (netAt(mid) >= minNet) low = mid
    else high = mid - 1
  }
  return low
}

function inScope(rule: AutoDiscountRule, line: AutoDiscountLine): boolean {
  if (rule.kind === 'product') return rule.scopeIds.includes(line.productId)
  if (rule.kind === 'category') return rule.scopeIds.includes(line.categoryId)
  return rule.scopeIds.length === 0 || rule.scopeIds.includes(line.categoryId)
}

export function evaluateAutoDiscounts(rules: AutoDiscountRule[], context: AutoDiscountContext): AutoDiscountResult {
  const now = Date.parse(context.now)
  const lines = [...context.lines].sort((a, b) => a.lineIndex - b.lineIndex)
  const discount = new Map(lines.map((l) => [l.lineIndex, 0]))
  const locked = new Set<number>()
  const result: AutoDiscountResult = {
    lines: [],
    totals: { discountGrossCents: 0, netCents: 0, taxCents: 0, grossCents: 0 },
    explanations: [],
    applied: [],
    skipped: []
  }
  const ordered = rules
    .filter(
      (rule) =>
        rule.status === 'active' &&
        now >= Date.parse(rule.startsAt) &&
        (rule.endsAt === null || now < Date.parse(rule.endsAt)) &&
        (rule.segment === 'all' ||
          (context.customerId !== null && (rule.segment === 'registered' || context.companyApproved)))
    )
    .sort((a, b) => a.priority - b.priority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

  for (const rule of ordered) {
    const remaining = (l: AutoDiscountLine) => l.unitGrossCents * l.quantity - discount.get(l.lineIndex)!
    const candidates = lines.filter(
      (l) =>
        inScope(rule, l) &&
        remaining(l) > 0 &&
        !locked.has(l.lineIndex) &&
        (rule.stacking === 'stackable' || discount.get(l.lineIndex) === 0)
    )
    if (candidates.length === 0) {
      if (lines.some((l) => inScope(rule, l))) result.skipped.push({ ruleId: rule.id, reason: 'no_eligible_lines' })
      continue
    }
    const priced = candidates.filter((l) => l.costUnitNetCents !== null)
    if (priced.length === 0) {
      result.skipped.push({ ruleId: rule.id, reason: 'cost_unknown' })
      continue
    }
    const proposal = new Map<number, number>()
    if (rule.benefit.kind === 'tiers') {
      for (const l of priced) {
        const tier = [...rule.benefit.tiers].reverse().find((t) => l.quantity >= t.minQuantity)
        if (tier) proposal.set(l.lineIndex, roundRatio(BigInt(remaining(l)) * BigInt(tier.basisPoints), 10000n))
      }
    } else {
      const subtotal = priced.reduce((n, l) => n + remaining(l), 0)
      if (rule.kind === 'basket' && subtotal < rule.minBasketGrossCents) {
        result.skipped.push({ ruleId: rule.id, reason: 'below_basket_minimum' })
        continue
      }
      if (rule.benefit.kind === 'percent') {
        const total = roundRatio(BigInt(subtotal) * BigInt(rule.benefit.basisPoints), 10000n)
        if (rule.kind === 'basket')
          for (const [i, v] of allocate(
            priced.map((l) => ({ lineIndex: l.lineIndex, gross: remaining(l) })),
            total
          ))
            proposal.set(i, v)
        else
          for (const l of priced)
            proposal.set(l.lineIndex, roundRatio(BigInt(remaining(l)) * BigInt(rule.benefit.basisPoints), 10000n))
      } else {
        const total = Math.min(rule.benefit.grossCents, subtotal)
        for (const [i, v] of allocate(
          priced.map((l) => ({ lineIndex: l.lineIndex, gross: remaining(l) })),
          total
        ))
          proposal.set(i, v)
      }
    }
    const perLine: Array<{ lineIndex: number; discountGrossCents: number }> = []
    let capped = false
    for (const l of priced) {
      const wanted = Math.min(proposal.get(l.lineIndex) ?? 0, remaining(l))
      if (wanted <= 0) continue
      const room = Math.max(0, maxDiscountForLine(l, rule.marginFloorBasisPoints) - discount.get(l.lineIndex)!)
      const granted = Math.min(wanted, room)
      if (granted < wanted) capped = true
      if (granted > 0) perLine.push({ lineIndex: l.lineIndex, discountGrossCents: granted })
    }
    if (perLine.length === 0) {
      result.skipped.push({ ruleId: rule.id, reason: capped ? 'margin_floor' : 'no_eligible_lines' })
      continue
    }
    for (const entry of perLine) {
      discount.set(entry.lineIndex, discount.get(entry.lineIndex)! + entry.discountGrossCents)
      if (rule.stacking === 'exclusive') locked.add(entry.lineIndex)
    }
    const sum = perLine.reduce((n, e) => n + e.discountGrossCents, 0)
    result.applied.push({
      ruleId: rule.id,
      code: rule.code,
      kind: rule.kind,
      priority: rule.priority,
      discountGrossCents: sum,
      lines: perLine
    })
    result.explanations.push({ message: rule.customerMessage, discountGrossCents: sum })
  }

  result.lines = lines.map((l) => ({
    ...quoteLine({ ...l, discountGrossCents: discount.get(l.lineIndex)! }),
    lineIndex: l.lineIndex
  }))
  for (const l of result.lines) {
    result.totals.discountGrossCents += l.discountGrossCents
    result.totals.netCents += l.netCents
    result.totals.taxCents += l.taxCents
    result.totals.grossCents += l.grossCents
  }
  return result
}
