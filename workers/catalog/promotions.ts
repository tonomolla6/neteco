import { quoteLine, roundRatio } from '../../server/domain/money'
import {
  promotionContextSchema,
  promotionRuleSchema,
  type PromotionContext,
  type PromotionReason,
  type PromotionRule
} from '../../shared/promotions'
import { canonicalJson, sha256Hex } from './inventory'
export type { PromotionContext } from '../../shared/promotions'

export interface PromotionEvaluation {
  eligible: boolean
  reason: PromotionReason | null
  ruleSnapshot: { id: string; version: number }
  lines: Array<ReturnType<typeof quoteLine> & { lineIndex: number }>
  totals: { discountGrossCents: number; netCents: number; taxCents: number; grossCents: number }
}

export function promotionRuleHash(raw: PromotionRule): Promise<string> {
  return sha256Hex(canonicalJson(promotionRuleSchema.parse(raw)))
}

type ContextLine = PromotionContext['lines'][number]

function inScope(rule: PromotionRule, line: ContextLine): boolean {
  return (
    rule.scope.kind === 'all' ||
    rule.scope.ids.includes(rule.scope.kind === 'product' ? line.productId : line.categoryId)
  )
}

function couponLine(rule: PromotionRule, line: ContextLine): boolean {
  return (
    inScope(rule, line) &&
    (rule.volumeMode !== 'exclude_volume' || line.volumeUnitGrossCents === line.baseUnitGrossCents)
  )
}

function evaluation(
  rule: PromotionRule,
  lines: PromotionEvaluation['lines'],
  reason: PromotionReason | null
): PromotionEvaluation {
  return {
    eligible: reason === null,
    reason,
    ruleSnapshot: { id: rule.id, version: rule.version },
    lines,
    totals: {
      discountGrossCents: lines.reduce((n, line) => n + line.discountGrossCents, 0),
      netCents: lines.reduce((n, line) => n + line.netCents, 0),
      taxCents: lines.reduce((n, line) => n + line.taxCents, 0),
      grossCents: lines.reduce((n, line) => n + line.grossCents, 0)
    }
  }
}

/** Largest remainder allocation conserves every cent; ties use contractual lineIndex. */
function allocateDiscount(
  entries: Array<{ lineIndex: number; gross: number }>,
  discount: number,
  gross: number
): Map<number, number> {
  const denominator = BigInt(gross)
  const shares = entries.map((entry) => {
    const numerator = BigInt(entry.gross) * BigInt(discount)
    return { lineIndex: entry.lineIndex, amount: Number(numerator / denominator), remainder: numerator % denominator }
  })
  let remaining = discount - shares.reduce((sum, share) => sum + share.amount, 0)
  shares.sort((a, b) => (a.remainder === b.remainder ? a.lineIndex - b.lineIndex : a.remainder > b.remainder ? -1 : 1))
  for (const share of shares) {
    if (remaining === 0) break
    share.amount += 1
    remaining -= 1
  }
  if (remaining !== 0) throw new Error('invalid_promotion_allocation')
  return new Map(shares.map((share) => [share.lineIndex, share.amount]))
}

/** All authority, price and usage facts must be supplied by the server caller.
 * This pure evaluator does not reserve uses or replace checkout's atomic guard. */
export function evaluatePromotion(rawRule: PromotionRule, rawContext: PromotionContext): PromotionEvaluation {
  const rule = promotionRuleSchema.parse(rawRule)
  const context = promotionContextSchema.parse(rawContext)
  const sorted = [...context.lines].sort((a, b) => a.lineIndex - b.lineIndex)
  const baseline = sorted.map((line) => ({
    ...quoteLine({ ...line, unitGrossCents: line.volumeUnitGrossCents }),
    lineIndex: line.lineIndex
  }))
  const rejected = (reason: PromotionReason) => evaluation(rule, baseline, reason)
  if (rule.status !== 'active' || rule.channel !== context.channel) return rejected('unavailable')
  if (Date.parse(context.now) < Date.parse(rule.startsAt)) return rejected('not_started')
  if (rule.endsAt !== null && Date.parse(context.now) >= Date.parse(rule.endsAt)) return rejected('expired')
  if (
    rule.segment !== 'all' &&
    (!context.customerId || (rule.segment === 'approved_company' && !context.companyApproved))
  )
    return rejected('segment_not_eligible')
  if (rule.perCustomerLimit !== null && !context.customerId) return rejected('customer_required')
  if (
    (rule.totalLimit !== null && context.redemptions.total >= rule.totalLimit) ||
    (rule.perCustomerLimit !== null && context.redemptions.customer >= rule.perCustomerLimit)
  )
    return rejected('usage_limit')

  const entries = sorted
    .filter((line) => couponLine(rule, line))
    .map((line) => ({
      lineIndex: line.lineIndex,
      gross:
        line.quantity * (rule.volumeMode === 'best_of_volume' ? line.baseUnitGrossCents : line.volumeUnitGrossCents)
    }))
  const eligibleGross = entries.reduce((sum, line) => sum + line.gross, 0)
  if (eligibleGross === 0) return rejected('no_eligible_lines')
  const discount =
    rule.benefit.kind === 'fixed'
      ? Math.min(rule.benefit.grossCents, eligibleGross)
      : roundRatio(BigInt(eligibleGross) * BigInt(rule.benefit.basisPoints), 10000n)
  if (discount === 0) return rejected('no_benefit')
  const allocated = allocateDiscount(entries, discount, eligibleGross)
  const candidate = evaluation(
    rule,
    sorted.map((line) => ({
      ...quoteLine({
        ...line,
        unitGrossCents:
          rule.volumeMode === 'best_of_volume' && couponLine(rule, line)
            ? line.baseUnitGrossCents
            : line.volumeUnitGrossCents,
        discountGrossCents: allocated.get(line.lineIndex) ?? 0
      }),
      lineIndex: line.lineIndex
    })),
    null
  )
  // A tie must retain the existing volume basket and must not consume a code.
  if (
    rule.volumeMode === 'best_of_volume' &&
    candidate.totals.grossCents >= baseline.reduce((sum, line) => sum + line.grossCents, 0)
  )
    return rejected('no_benefit')
  return candidate
}

/** Admin-only simulation detail. Never expose usage counters through customer feedback. */
export function explainPromotionEvaluation(rawRule: PromotionRule, rawContext: PromotionContext) {
  const rule = promotionRuleSchema.parse(rawRule)
  const context = promotionContextSchema.parse(rawContext)
  return {
    evaluation: evaluatePromotion(rule, context),
    usage: context.redemptions,
    lines: [...context.lines]
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((line) => ({
        lineIndex: line.lineIndex,
        inScope: inScope(rule, line),
        volumeApplied: line.volumeUnitGrossCents < line.baseUnitGrossCents,
        excludedByVolume: inScope(rule, line) && !couponLine(rule, line),
        baseGrossCents: line.baseUnitGrossCents * line.quantity,
        volumeGrossCents: line.volumeUnitGrossCents * line.quantity
      }))
  }
}
