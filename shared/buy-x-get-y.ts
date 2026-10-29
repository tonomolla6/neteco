import { z } from 'zod'
import { catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

/**
 * PRI-015 "Compra X y obtén Y/regalo".
 *
 * Pure, deterministic domain: eligibility, stock cap, margin floor, fiscal allocation
 * and incremental returns. Prices, VAT rates, costs and stock are supplied by the
 * server-side resolver (never by the browser). Gift units are ADDED to the order; they
 * are never taken from backorder. Tax is never waived: the amount paid for the trigger
 * units is the consideration for trigger + gift, apportioned pro rata of list value, and
 * each line is taxed at its own rate (the gift line keeps its VAT).
 */

const MAX_CENTS = Number.MAX_SAFE_INTEGER
const variantId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const BXGY_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type BxgyStatus = (typeof BXGY_STATUSES)[number]

export const bxgyRuleInputSchema = z
  .object({
    code: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
    name: z.string().trim().min(3).max(120),
    triggerVariantId: variantId,
    buyQuantity: z.number().int().min(1).max(999),
    giftVariantId: variantId,
    giftQuantity: z.number().int().min(1).max(99),
    maxApplicationsPerOrder: z.number().int().min(1).max(50),
    totalLimit: z.number().int().min(1).nullable(),
    perCustomerLimit: z.number().int().min(1).nullable(),
    marginFloorBasisPoints: z.number().int().min(0).max(9000),
    startsAt: instant,
    endsAt: instant.nullable()
  })
  .strict()
  .refine((value) => value.endsAt === null || value.endsAt > value.startsAt, {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt'
  })
export type BxgyRuleInput = z.infer<typeof bxgyRuleInputSchema>

export interface BxgyRule {
  id: string
  version: number
  status: BxgyStatus
  triggerVariantId: string
  buyQuantity: number
  giftVariantId: string
  giftQuantity: number
  maxApplicationsPerOrder: number
  totalLimit: number | null
  perCustomerLimit: number | null
  marginFloorBasisPoints: number
  startsAt: string
  endsAt: string | null
}

export interface BxgyCartLine {
  variantId: string
  quantity: number
  unitGrossCents: number
  taxRateBasisPoints: number
  costUnitNetCents: number | null
}

export interface BxgyGiftProduct {
  unitGrossCents: number
  taxRateBasisPoints: number
  /** Sellable stock (physical - blocked - safety - reserved) for the gift variant. */
  availableQuantity: number
  costUnitNetCents: number | null
}

export interface BxgyContext {
  now: string
  customerId: string | null
  lines: BxgyCartLine[]
  gift: BxgyGiftProduct
  redemptions: { total: number; customer: number }
}

export type BxgyReason =
  | 'rule_inactive'
  | 'not_started'
  | 'expired'
  | 'trigger_missing'
  | 'quantity_not_met'
  | 'customer_required'
  | 'limit_reached'
  | 'customer_limit_reached'
  | 'gift_out_of_stock'
  | 'margin_unknown'
  | 'margin_floor'

export interface BxgyAllocatedLine {
  kind: 'paid' | 'gift'
  variantId: string
  quantity: number
  listGrossCents: number
  allocatedGrossCents: number
  netCents: number
  taxCents: number
  taxRateBasisPoints: number
}

export interface BxgySnapshot {
  applications: number
  buyQuantity: number
  giftQuantity: number
  triggerVariantId: string
  giftVariantId: string
  lines: Array<{
    kind: 'paid' | 'gift'
    variantId: string
    quantity: number
    listGrossCents: number
    allocatedGrossCents: number
    taxRateBasisPoints: number
  }>
}

export interface BxgyEvaluation {
  eligible: boolean
  reason: BxgyReason | null
  applications: number
  lines: BxgyAllocatedLine[]
  totals: {
    listGrossCents: number
    payableGrossCents: number
    discountGrossCents: number
    netCents: number
    taxCents: number
  }
  marginNetCents: number | null
  snapshot: BxgySnapshot
}

/** Exact round-half-up of a*b/c with BigInt, so large cents never lose precision. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c) || c <= 0 || a < 0 || b < 0)
    throw new Error('invalid_money_operands')
  const result = (BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (BigInt(c) * 2n)
  if (result > BigInt(MAX_CENTS)) throw new Error('money_overflow')
  return Number(result)
}

function split(gross: number, rate: number): { netCents: number; taxCents: number } {
  const netCents = mulDivRound(gross, 10000, 10000 + rate)
  return { netCents, taxCents: gross - netCents }
}

function line(
  kind: 'paid' | 'gift',
  id: string,
  quantity: number,
  unit: number,
  allocated: number,
  rate: number
): BxgyAllocatedLine {
  return {
    kind,
    variantId: id,
    quantity,
    listGrossCents: unit * quantity,
    allocatedGrossCents: allocated,
    ...split(allocated, rate),
    taxRateBasisPoints: rate
  }
}

function totalsOf(lines: BxgyAllocatedLine[]): BxgyEvaluation['totals'] {
  const sum = (pick: (l: BxgyAllocatedLine) => number) => lines.reduce((s, l) => s + pick(l), 0)
  const listGrossCents = sum((l) => l.listGrossCents)
  const payableGrossCents = sum((l) => l.allocatedGrossCents)
  return {
    listGrossCents,
    payableGrossCents,
    discountGrossCents: listGrossCents - payableGrossCents,
    netCents: sum((l) => l.netCents),
    taxCents: sum((l) => l.taxCents)
  }
}

function toSnapshot(rule: BxgyRule, applications: number, lines: BxgyAllocatedLine[]): BxgySnapshot {
  return {
    applications,
    buyQuantity: rule.buyQuantity,
    giftQuantity: rule.giftQuantity,
    triggerVariantId: rule.triggerVariantId,
    giftVariantId: rule.giftVariantId,
    lines: lines.map((l) => ({
      kind: l.kind,
      variantId: l.variantId,
      quantity: l.quantity,
      listGrossCents: l.listGrossCents,
      allocatedGrossCents: l.allocatedGrossCents,
      taxRateBasisPoints: l.taxRateBasisPoints
    }))
  }
}

function sanePositive(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function evaluateBuyXGetY(rule: BxgyRule, context: BxgyContext): BxgyEvaluation {
  const ids = context.lines.map((l) => l.variantId)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_cart_line')
  const listLines = context.lines.map((l) =>
    line('paid', l.variantId, l.quantity, l.unitGrossCents, l.unitGrossCents * l.quantity, l.taxRateBasisPoints)
  )
  const reject = (reason: BxgyReason): BxgyEvaluation => ({
    eligible: false,
    reason,
    applications: 0,
    lines: listLines,
    totals: totalsOf(listLines),
    marginNetCents: null,
    snapshot: toSnapshot(rule, 0, listLines)
  })

  if (rule.status !== 'active') return reject('rule_inactive')
  if (context.now < rule.startsAt) return reject('not_started')
  if (rule.endsAt !== null && context.now >= rule.endsAt) return reject('expired')
  const trigger = context.lines.find((l) => l.variantId === rule.triggerVariantId)
  if (!trigger || trigger.quantity < 1) return reject('trigger_missing')
  let applications = Math.min(Math.floor(trigger.quantity / rule.buyQuantity), rule.maxApplicationsPerOrder)
  if (applications < 1) return reject('quantity_not_met')
  if (rule.perCustomerLimit !== null && context.customerId === null) return reject('customer_required')
  if (rule.totalLimit !== null) {
    const left = rule.totalLimit - context.redemptions.total
    if (left < 1) return reject('limit_reached')
    applications = Math.min(applications, left)
  }
  if (rule.perCustomerLimit !== null) {
    const left = rule.perCustomerLimit - context.redemptions.customer
    if (left < 1) return reject('customer_limit_reached')
    applications = Math.min(applications, left)
  }
  const inCartGift = context.lines.find((l) => l.variantId === rule.giftVariantId)?.quantity ?? 0
  const giftSellable = sanePositive(context.gift.availableQuantity) - inCartGift
  applications = Math.min(applications, Math.floor(Math.max(0, giftSellable) / rule.giftQuantity))
  if (applications < 1) return reject('gift_out_of_stock')

  const bundleTrigger = applications * rule.buyQuantity
  const giftUnits = applications * rule.giftQuantity
  const triggerList = bundleTrigger * trigger.unitGrossCents
  const giftList = giftUnits * context.gift.unitGrossCents
  const paid = triggerList
  const allocTrigger = triggerList + giftList === 0 ? 0 : mulDivRound(paid, triggerList, triggerList + giftList)
  const allocGift = paid - allocTrigger

  const lines: BxgyAllocatedLine[] = []
  for (const l of context.lines) {
    if (l.variantId === rule.triggerVariantId) {
      const leftover = (l.quantity - bundleTrigger) * l.unitGrossCents
      lines.push(line('paid', l.variantId, l.quantity, l.unitGrossCents, allocTrigger + leftover, l.taxRateBasisPoints))
    } else {
      lines.push(
        line('paid', l.variantId, l.quantity, l.unitGrossCents, l.unitGrossCents * l.quantity, l.taxRateBasisPoints)
      )
    }
  }
  const giftLine = line(
    'gift',
    rule.giftVariantId,
    giftUnits,
    context.gift.unitGrossCents,
    allocGift,
    context.gift.taxRateBasisPoints
  )
  lines.push(giftLine)

  // Margin: the bundle (trigger units + gift) must keep the configured floor.
  const bundleNet = split(allocTrigger, trigger.taxRateBasisPoints).netCents + giftLine.netCents
  const bundleCost =
    trigger.costUnitNetCents === null || context.gift.costUnitNetCents === null
      ? null
      : bundleTrigger * trigger.costUnitNetCents + giftUnits * context.gift.costUnitNetCents
  if (rule.marginFloorBasisPoints > 0) {
    if (bundleCost === null) return reject('margin_unknown')
    const margin = bundleNet - bundleCost
    if (margin * 10000 < rule.marginFloorBasisPoints * bundleNet) return reject('margin_floor')
  }
  let cost: number | null = context.gift.costUnitNetCents === null ? null : giftUnits * context.gift.costUnitNetCents
  for (const l of context.lines) {
    if (cost === null) break
    cost = l.costUnitNetCents === null ? null : cost + l.costUnitNetCents * l.quantity
  }
  const totals = totalsOf(lines)
  return {
    eligible: true,
    reason: null,
    applications,
    lines,
    totals,
    marginNetCents: cost === null ? null : totals.netCents - cost,
    snapshot: toSnapshot(rule, applications, lines)
  }
}

export interface BxgyReturnLine {
  kind: 'paid' | 'gift'
  variantId: string
  quantity: number
}

export interface BxgyReturnQuote {
  refundGrossCents: number
  clawbackGrossCents: number
  netRefundGrossCents: number
  refundNetCents: number
  refundTaxCents: number
}

function cumulative(snapshot: BxgySnapshot, returned: BxgyReturnLine[]): BxgyReturnQuote {
  const totals = new Map<string, number>()
  for (const r of returned) {
    const key = `${r.kind}:${r.variantId}`
    const sold = snapshot.lines.find((l) => l.kind === r.kind && l.variantId === r.variantId)
    if (!sold) throw new Error('return_line_unknown')
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 0) throw new Error('return_quantity_invalid')
    const next = (totals.get(key) ?? 0) + r.quantity
    if (next > sold.quantity) throw new Error('return_exceeds_sold')
    totals.set(key, next)
  }
  let refund = 0
  let taxWeighted = 0
  for (const sold of snapshot.lines) {
    const k = totals.get(`${sold.kind}:${sold.variantId}`) ?? 0
    if (k === 0) continue
    const gross = mulDivRound(sold.allocatedGrossCents, k, sold.quantity)
    refund += gross
    taxWeighted += split(gross, sold.taxRateBasisPoints).taxCents
  }
  const trigger = snapshot.lines.find((l) => l.kind === 'paid' && l.variantId === snapshot.triggerVariantId)
  const gift = snapshot.lines.find((l) => l.kind === 'gift')
  let clawback = 0
  if (trigger && gift) {
    const remaining = trigger.quantity - (totals.get(`paid:${trigger.variantId}`) ?? 0)
    const remainingApplications = Math.min(snapshot.applications, Math.floor(remaining / snapshot.buyQuantity))
    const mustReturn = (snapshot.applications - remainingApplications) * snapshot.giftQuantity
    const missing = Math.max(0, mustReturn - (totals.get(`gift:${gift.variantId}`) ?? 0))
    const perUnitList = mulDivRound(gift.listGrossCents, 1, gift.quantity)
    const perUnitPaid = mulDivRound(gift.allocatedGrossCents, 1, gift.quantity)
    clawback = missing * Math.max(0, perUnitList - perUnitPaid)
  }
  const claw = Math.min(clawback, refund)
  const net = refund - claw
  const refundTaxCents = refund === 0 ? 0 : mulDivRound(taxWeighted, net, refund)
  return {
    refundGrossCents: refund,
    clawbackGrossCents: claw,
    netRefundGrossCents: net,
    refundNetCents: net - refundTaxCents,
    refundTaxCents
  }
}

/**
 * Incremental return quote. `previous` is everything already returned for this order;
 * `current` is the new return request. The result is the delta so repeated or
 * partial returns never refund the same unit twice and the cumulative refund is
 * independent of how the returns were split.
 */
export function quoteBxgyReturn(
  snapshot: BxgySnapshot,
  previous: BxgyReturnLine[],
  current: BxgyReturnLine[]
): BxgyReturnQuote {
  const before = cumulative(snapshot, previous)
  const after = cumulative(snapshot, [...previous, ...current])
  const delta = (pick: (q: BxgyReturnQuote) => number) => Math.max(0, pick(after) - pick(before))
  const refundGrossCents = delta((q) => q.refundGrossCents)
  const clawbackGrossCents = delta((q) => q.clawbackGrossCents)
  const netRefundGrossCents = Math.max(0, after.netRefundGrossCents - before.netRefundGrossCents)
  const refundTaxCents = Math.max(0, after.refundTaxCents - before.refundTaxCents)
  return {
    refundGrossCents,
    clawbackGrossCents,
    netRefundGrossCents,
    refundNetCents: netRefundGrossCents - Math.min(refundTaxCents, netRefundGrossCents),
    refundTaxCents: Math.min(refundTaxCents, netRefundGrossCents)
  }
}

/** Unchanged cart: used when no rule applies. */
export function passThroughEvaluation(lines: BxgyCartLine[]): BxgyEvaluation {
  const placeholder: BxgyRule = {
    id: '00000000-0000-4000-8000-000000000000',
    version: 1,
    status: 'archived',
    triggerVariantId: '-',
    buyQuantity: 1,
    giftVariantId: '-',
    giftQuantity: 1,
    maxApplicationsPerOrder: 1,
    totalLimit: null,
    perCustomerLimit: null,
    marginFloorBasisPoints: 0,
    startsAt: '1970-01-01T00:00:00Z',
    endsAt: null
  }
  return evaluateBuyXGetY(placeholder, {
    now: placeholder.startsAt,
    customerId: null,
    lines,
    gift: { unitGrossCents: 0, taxRateBasisPoints: 0, availableQuantity: 0, costUnitNetCents: null },
    redemptions: { total: 0, customer: 0 }
  })
}

export const bxgySnapshotSchema = z
  .object({
    applications: z.number().int().min(1).max(50),
    buyQuantity: z.number().int().min(1).max(999),
    giftQuantity: z.number().int().min(1).max(99),
    triggerVariantId: variantId,
    giftVariantId: variantId,
    lines: z
      .array(
        z
          .object({
            kind: z.enum(['paid', 'gift']),
            variantId,
            quantity: z.number().int().min(1).max(100000),
            listGrossCents: z.number().int().min(0).max(MAX_CENTS),
            allocatedGrossCents: z.number().int().min(0).max(MAX_CENTS),
            taxRateBasisPoints: z.number().int().min(0).max(10000)
          })
          .strict()
      )
      .min(2)
      .max(101)
  })
  .strict()

export const bxgyReturnLinesSchema = z
  .array(
    z.object({ kind: z.enum(['paid', 'gift']), variantId, quantity: z.number().int().min(0).max(100000) }).strict()
  )
  .min(1)
  .max(100)
