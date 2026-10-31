import { evaluatePromotion } from '../catalog/promotions'
import type {
  PromotionMatrixCase,
  PromotionMatrixEvaluationResult,
  MarginEvaluationInput,
  MarginEvaluationResult,
  FrequencyCooldownCheckInput,
  FrequencyCooldownCheckResult,
  MarketingConsentCheckInput,
  MarketingConsentCheckResult,
  PromotionRefundCalculationInput,
  PromotionRefundCalculationResult
} from '../../shared/promotions-automation-matrix'

export type {
  PromotionMatrixCase,
  PromotionMatrixEvaluationResult,
  MarginEvaluationInput,
  MarginEvaluationResult,
  FrequencyCooldownCheckInput,
  FrequencyCooldownCheckResult,
  MarketingConsentCheckInput,
  MarketingConsentCheckResult,
  PromotionRefundCalculationInput,
  PromotionRefundCalculationResult
}

export function generatePromotionMatrixCases(): PromotionMatrixCase[] {
  const benefits = [
    { kind: 'fixed' as const, grossCents: 500 },
    { kind: 'percent' as const, basisPoints: 1000 }
  ]
  const volumeModes = ['stack_volume', 'best_of_volume', 'exclude_volume'] as const
  const scopes = [
    { kind: 'all' as const },
    { kind: 'product' as const, ids: ['00000000-0000-4000-8000-000000000010'] },
    { kind: 'category' as const, ids: ['00000000-0000-4000-8000-000000000020'] }
  ]
  const segments = ['all', 'registered', 'approved_company'] as const

  const cases: PromotionMatrixCase[] = []
  let counter = 1

  for (const benefit of benefits) {
    for (const volumeMode of volumeModes) {
      for (const scope of scopes) {
        for (const segment of segments) {
          const id = `matrix-case-${String(counter++).padStart(3, '0')}`
          const isCompany = segment === 'approved_company'
          const customerId = segment === 'all' ? null : '00000000-0000-4000-8000-000000000100'

          cases.push({
            id,
            rule: {
              id: '00000000-0000-4000-8000-000000000001',
              version: 1,
              code: `CASE${counter}`,
              status: 'active',
              channel: 'online',
              startsAt: '2026-01-01T00:00:00Z',
              endsAt: '2026-12-31T23:59:59Z',
              benefit,
              scope,
              segment,
              totalLimit: null,
              perCustomerLimit: null,
              volumeMode
            },
            context: {
              now: '2026-06-01T12:00:00Z',
              channel: 'online',
              customerId,
              companyApproved: isCompany,
              redemptions: { total: 0, customer: 0 },
              lines: [
                {
                  lineIndex: 0,
                  variantId: 'v-00000000-0000-4000-8000-000000000010',
                  productId: '00000000-0000-4000-8000-000000000010',
                  categoryId: '00000000-0000-4000-8000-000000000020',
                  sku: 'PROD-10',
                  quantity: 2,
                  baseUnitGrossCents: 3000,
                  volumeUnitGrossCents: 2800,
                  taxRateBasisPoints: 2100
                }
              ]
            }
          })
        }
      }
    }
  }

  return cases
}

export function evaluatePromotionMatrixCase(testCase: PromotionMatrixCase): PromotionMatrixEvaluationResult {
  const result = evaluatePromotion(testCase.rule, testCase.context)
  return {
    caseId: testCase.id,
    eligible: result.eligible,
    reason: result.reason,
    discountGrossCents: result.totals.discountGrossCents,
    netCents: result.totals.netCents,
    taxCents: result.totals.taxCents,
    grossCents: result.totals.grossCents
  }
}

export function evaluateBasketMargin(input: MarginEvaluationInput): MarginEvaluationResult {
  const totalNetCents = input.lines.reduce((acc, l) => acc + l.netCents, 0)
  const hasUnknownCost = input.lines.some((l) => l.costNetCents === null)

  if (hasUnknownCost) {
    return {
      allowed: true,
      totalNetCents,
      totalCostNetCents: null,
      marginNetCents: null,
      marginBasisPoints: null,
      loss: null
    }
  }

  const totalCostNetCents = input.lines.reduce((acc, l) => acc + (l.costNetCents ?? 0), 0)
  const marginNetCents = totalNetCents - totalCostNetCents
  const loss = totalNetCents < totalCostNetCents
  const marginBasisPoints = totalNetCents === 0 ? 0 : Math.round((marginNetCents / totalNetCents) * 10000)

  const allowed = !loss && marginBasisPoints >= input.marginFloorBps

  return {
    allowed,
    totalNetCents,
    totalCostNetCents,
    marginNetCents,
    marginBasisPoints,
    loss
  }
}

export function checkAutomationFrequencyAndCooldown(input: FrequencyCooldownCheckInput): FrequencyCooldownCheckResult {
  if (
    input.totalLimit !== undefined &&
    input.totalLimit !== null &&
    (input.totalRedemptions ?? 0) >= input.totalLimit
  ) {
    return { allowed: false, reason: 'usage_limit' }
  }

  if (
    input.perCustomerLimit !== undefined &&
    input.perCustomerLimit !== null &&
    (input.customerRedemptions ?? 0) >= input.perCustomerLimit
  ) {
    return { allowed: false, reason: 'usage_limit' }
  }

  if (input.automationKind === 'welcome_discount' && input.lastDispatchedAt) {
    return { allowed: false, reason: 'already_claimed' }
  }

  if (input.automationKind === 'winback' && input.lastDispatchedAt && input.now && input.cooldownDays !== undefined) {
    const lastDate = new Date(input.lastDispatchedAt).getTime()
    const nowDate = new Date(input.now).getTime()
    const diffDays = (nowDate - lastDate) / (1000 * 60 * 60 * 24)

    if (diffDays < input.cooldownDays) {
      return { allowed: false, reason: 'cooldown_active' }
    }
  }

  return { allowed: true, reason: null }
}

export function checkMarketingConsentEligibility(input: MarketingConsentCheckInput): MarketingConsentCheckResult {
  if (input.customerSuppressed) {
    return { allowed: false, status: 'suppressed' }
  }

  if (input.stream === 'transactional_safety_usage') {
    return { allowed: true, status: 'delivered' }
  }

  if (!input.marketingConsent) {
    return { allowed: false, status: 'skipped_no_consent' }
  }

  return { allowed: true, status: 'delivered' }
}

export function calculatePromotionRefundReversal(
  input: PromotionRefundCalculationInput
): PromotionRefundCalculationResult {
  let totalRefundGrossCents = 0
  let totalRefundNetCents = 0
  let totalRefundTaxCents = 0
  let discountClawedBackGrossCents = 0

  let remainingPaidGrossCents = input.lines.reduce(
    (sum, l) => sum + (l.originalGrossCents - l.originalDiscountGrossCents),
    0
  )
  let remainingCostNetCents = input.lines.reduce(
    (sum, l) => sum + (l.costUnitNetCents ? l.costUnitNetCents * l.quantity : 0),
    0
  )

  for (const ret of input.returnLines) {
    const line = input.lines.find((l) => l.lineIndex === ret.lineIndex)
    if (!line || ret.returnQuantity > line.quantity) {
      throw new Error('invalid_return_quantity')
    }

    const unitOriginalDiscount = Math.round(line.originalDiscountGrossCents / line.quantity)
    const unitPaidGross = line.unitGrossCents - unitOriginalDiscount
    const refundGrossForLine = unitPaidGross * ret.returnQuantity
    const discountForLine = unitOriginalDiscount * ret.returnQuantity

    // Tax proportion
    const netRatio = 10000 / (10000 + line.taxRateBasisPoints)
    const refundNet = Math.round(refundGrossForLine * netRatio)
    const refundTax = refundGrossForLine - refundNet

    totalRefundGrossCents += refundGrossForLine
    totalRefundNetCents += refundNet
    totalRefundTaxCents += refundTax
    discountClawedBackGrossCents += discountForLine

    remainingPaidGrossCents -= refundGrossForLine
    if (line.costUnitNetCents) {
      remainingCostNetCents -= line.costUnitNetCents * ret.returnQuantity
    }
  }

  const remainingOrderMarginNetCents = Math.max(0, remainingPaidGrossCents - remainingCostNetCents)

  return {
    orderId: input.orderId,
    totalRefundGrossCents,
    totalRefundNetCents,
    totalRefundTaxCents,
    discountClawedBackGrossCents,
    remainingPaidGrossCents: Math.max(0, remainingPaidGrossCents),
    remainingOrderMarginNetCents
  }
}

export function runTableDrivenPromotionMatrix(cases: PromotionMatrixCase[]) {
  const results = cases.map(evaluatePromotionMatrixCase)
  const passedCases = results.filter((r) => typeof r.eligible === 'boolean').length

  return {
    totalCases: cases.length,
    passedCases,
    failedCases: cases.length - passedCases,
    executedAt: new Date().toISOString()
  }
}
