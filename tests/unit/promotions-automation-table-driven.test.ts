import { describe, expect, it } from 'vitest'
import {
  generatePromotionMatrixCases,
  evaluatePromotionMatrixCase,
  evaluateBasketMargin,
  checkAutomationFrequencyAndCooldown,
  checkMarketingConsentEligibility,
  calculatePromotionRefundReversal,
  runTableDrivenPromotionMatrix,
  type PromotionMatrixCase,
  type MarginEvaluationInput,
  type FrequencyCooldownCheckInput,
  type MarketingConsentCheckInput,
  type PromotionRefundCalculationInput
} from '../../workers/marketing/promotions-automation-matrix'

describe('TST-041: Table-driven promotions and automations test suite', () => {
  describe('1. Combinaciones (Combinations Matrix)', () => {
    const generatedCases = generatePromotionMatrixCases()

    it('generates a comprehensive matrix of valid combinations across rules, volume modes, scopes and segments', () => {
      expect(generatedCases.length).toBeGreaterThanOrEqual(18)
      // Check variety of benefit kinds
      expect(generatedCases.some((c) => c.rule.benefit.kind === 'fixed')).toBe(true)
      expect(generatedCases.some((c) => c.rule.benefit.kind === 'percent')).toBe(true)
      // Check volume modes
      expect(generatedCases.some((c) => c.rule.volumeMode === 'stack_volume')).toBe(true)
      expect(generatedCases.some((c) => c.rule.volumeMode === 'best_of_volume')).toBe(true)
      expect(generatedCases.some((c) => c.rule.volumeMode === 'exclude_volume')).toBe(true)
      // Check scopes
      expect(generatedCases.some((c) => c.rule.scope.kind === 'all')).toBe(true)
      expect(generatedCases.some((c) => c.rule.scope.kind === 'product')).toBe(true)
      expect(generatedCases.some((c) => c.rule.scope.kind === 'category')).toBe(true)
      // Check customer segments
      expect(generatedCases.some((c) => c.rule.segment === 'all')).toBe(true)
      expect(generatedCases.some((c) => c.rule.segment === 'registered')).toBe(true)
      expect(generatedCases.some((c) => c.rule.segment === 'approved_company')).toBe(true)
    })

    it.each(generatedCases)(
      'evaluates matrix case [$id]: benefit=$rule.benefit.kind, volume=$rule.volumeMode, scope=$rule.scope.kind, segment=$rule.segment',
      (testCase: PromotionMatrixCase) => {
        const result = evaluatePromotionMatrixCase(testCase)
        expect(result.caseId).toBe(testCase.id)
        expect(typeof result.eligible).toBe('boolean')
        if (result.eligible) {
          expect(result.discountGrossCents).toBeGreaterThan(0)
          expect(result.netCents).toBeGreaterThan(0)
          expect(result.grossCents).toBe(result.netCents + result.taxCents)
        } else {
          expect(result.reason).not.toBeNull()
        }
      }
    )

    it('batch runs all generated matrix cases and reports summary stats', () => {
      const summary = runTableDrivenPromotionMatrix(generatedCases)
      expect(summary.totalCases).toBe(generatedCases.length)
      expect(summary.passedCases).toBe(generatedCases.length)
      expect(summary.failedCases).toBe(0)
    })
  })

  describe('2. Margen (Basket Margin & Floor Enforcement)', () => {
    it.each([
      {
        name: 'healthy margin above floor',
        lines: [{ grossCents: 10000, netCents: 8264, costNetCents: 4000, discountGrossCents: 1000 }],
        floorBps: 2000,
        expectedAllowed: true,
        expectedMarginBps: 5160
      },
      {
        name: 'margin below floor but positive',
        lines: [{ grossCents: 10000, netCents: 8264, costNetCents: 7500, discountGrossCents: 1500 }],
        floorBps: 2000,
        expectedAllowed: false,
        expectedMarginBps: 924
      },
      {
        name: 'merchant loss (negative margin)',
        lines: [{ grossCents: 10000, netCents: 8264, costNetCents: 9000, discountGrossCents: 2000 }],
        floorBps: 1500,
        expectedAllowed: false,
        expectedMarginBps: -891
      },
      {
        name: 'unknown cost preserves margin neutrality',
        lines: [{ grossCents: 10000, netCents: 8264, costNetCents: null, discountGrossCents: 1000 }],
        floorBps: 2000,
        expectedAllowed: true,
        expectedMarginBps: null
      }
    ])('evaluates margin scenario: $name', ({ lines, floorBps, expectedAllowed, expectedMarginBps }) => {
      const input: MarginEvaluationInput = {
        lines,
        marginFloorBps: floorBps
      }
      const evaluated = evaluateBasketMargin(input)
      expect(evaluated.allowed).toBe(expectedAllowed)
      if (expectedMarginBps !== null) {
        expect(Math.round(evaluated.marginBasisPoints!)).toBe(expectedMarginBps)
      } else {
        expect(evaluated.marginBasisPoints).toBeNull()
      }
    })
  })

  describe('3. Elegibilidad (Eligibility Boundaries)', () => {
    const baseRule = {
      id: '00000000-0000-4000-8000-000000000001',
      version: 1,
      code: 'PROMO2026',
      status: 'active' as const,
      channel: 'online' as const,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-12-31T23:59:59Z',
      benefit: { kind: 'fixed' as const, grossCents: 500 },
      scope: { kind: 'all' as const },
      segment: 'all' as const,
      totalLimit: 100,
      perCustomerLimit: 2,
      volumeMode: 'stack_volume' as const
    }

    const baseContext = {
      now: '2026-06-01T12:00:00Z',
      channel: 'online' as const,
      customerId: '00000000-0000-4000-8000-000000000010',
      companyApproved: false,
      redemptions: { total: 10, customer: 0 },
      lines: [
        {
          lineIndex: 0,
          variantId: 'v-1',
          productId: 'p-1',
          categoryId: 'c-1',
          sku: 'SKU-1',
          quantity: 2,
          baseUnitGrossCents: 2000,
          volumeUnitGrossCents: 2000,
          taxRateBasisPoints: 2100
        }
      ]
    }

    it.each([
      { desc: 'paused status', rulePatch: { status: 'paused' as const }, expectedReason: 'unavailable' },
      { desc: 'future start date', rulePatch: { startsAt: '2026-08-01T00:00:00Z' }, expectedReason: 'not_started' },
      { desc: 'past end date', rulePatch: { endsAt: '2026-05-01T00:00:00Z' }, expectedReason: 'expired' },
      {
        desc: 'registered segment without customer',
        rulePatch: { segment: 'registered' as const },
        contextPatch: { customerId: null },
        expectedReason: 'segment_not_eligible'
      },
      {
        desc: 'approved company segment without company approval',
        rulePatch: { segment: 'approved_company' as const },
        contextPatch: { companyApproved: false },
        expectedReason: 'segment_not_eligible'
      },
      {
        desc: 'product scope mismatch',
        rulePatch: { scope: { kind: 'product' as const, ids: ['00000000-0000-4000-8000-000000000099'] } },
        expectedReason: 'no_eligible_lines'
      }
    ])('rejects ineligible promotion: $desc', ({ rulePatch, contextPatch, expectedReason }) => {
      const testCase: PromotionMatrixCase = {
        id: 'eligibility-check',
        rule: { ...baseRule, ...rulePatch },
        context: { ...baseContext, ...(contextPatch || {}) }
      }
      const result = evaluatePromotionMatrixCase(testCase)
      expect(result.eligible).toBe(false)
      expect(result.reason).toBe(expectedReason)
    })
  })

  describe('4. Frecuencia y Límites (Usage Limits & Automation Cooldown)', () => {
    it.each([
      {
        type: 'global_limit_reached',
        input: { totalRedemptions: 100, totalLimit: 100, customerRedemptions: 0, perCustomerLimit: 2 },
        expectedAllowed: false,
        expectedReason: 'usage_limit'
      },
      {
        type: 'per_customer_limit_reached',
        input: { totalRedemptions: 50, totalLimit: 100, customerRedemptions: 2, perCustomerLimit: 2 },
        expectedAllowed: false,
        expectedReason: 'usage_limit'
      },
      {
        type: 'winback_cooldown_active',
        input: {
          automationKind: 'winback' as const,
          lastDispatchedAt: '2026-10-15T00:00:00Z',
          now: '2026-10-31T00:00:00Z',
          cooldownDays: 90
        },
        expectedAllowed: false,
        expectedReason: 'cooldown_active'
      },
      {
        type: 'winback_cooldown_elapsed',
        input: {
          automationKind: 'winback' as const,
          lastDispatchedAt: '2026-06-01T00:00:00Z',
          now: '2026-10-31T00:00:00Z',
          cooldownDays: 90
        },
        expectedAllowed: true,
        expectedReason: null
      },
      {
        type: 'welcome_series_already_claimed',
        input: {
          automationKind: 'welcome_discount' as const,
          lastDispatchedAt: '2026-01-01T00:00:00Z',
          now: '2026-10-31T00:00:00Z',
          cooldownDays: 9999
        },
        expectedAllowed: false,
        expectedReason: 'already_claimed'
      }
    ])('evaluates frequency / cooldown check: $type', ({ input, expectedAllowed, expectedReason }) => {
      const result = checkAutomationFrequencyAndCooldown(input as FrequencyCooldownCheckInput)
      expect(result.allowed).toBe(expectedAllowed)
      expect(result.reason).toBe(expectedReason)
    })
  })

  describe('5. Consentimientos (Marketing Consent vs Transactional)', () => {
    it.each([
      {
        channel: 'email',
        stream: 'transactional_safety_usage',
        marketingConsent: false,
        expectedAllowed: true,
        expectedStatus: 'delivered'
      },
      {
        channel: 'email',
        stream: 'commercial_replenishment',
        marketingConsent: true,
        expectedAllowed: true,
        expectedStatus: 'delivered'
      },
      {
        channel: 'email',
        stream: 'commercial_replenishment',
        marketingConsent: false,
        expectedAllowed: false,
        expectedStatus: 'skipped_no_consent'
      },
      {
        channel: 'sms',
        stream: 'winback_promotional',
        marketingConsent: false,
        expectedAllowed: false,
        expectedStatus: 'skipped_no_consent'
      },
      {
        channel: 'sms',
        stream: 'winback_promotional',
        marketingConsent: true,
        expectedAllowed: true,
        expectedStatus: 'delivered'
      }
    ])(
      'evaluates consent for stream $stream (consent: $marketingConsent) -> $expectedStatus',
      ({ channel, stream, marketingConsent, expectedAllowed, expectedStatus }) => {
        const input: MarketingConsentCheckInput = {
          channel: channel as 'email' | 'sms',
          stream: stream as MarketingConsentCheckInput['stream'],
          marketingConsent,
          customerSuppressed: false
        }
        const result = checkMarketingConsentEligibility(input)
        expect(result.allowed).toBe(expectedAllowed)
        expect(result.status).toBe(expectedStatus)
      }
    )

    it('suppressed customer is excluded even with marketing consent', () => {
      const input: MarketingConsentCheckInput = {
        channel: 'email',
        stream: 'commercial_replenishment',
        marketingConsent: true,
        customerSuppressed: true
      }
      const result = checkMarketingConsentEligibility(input)
      expect(result.allowed).toBe(false)
      expect(result.status).toBe('suppressed')
    })
  })

  describe('6. Reembolso (Refund Calculation & Proportional Promo Reversal)', () => {
    const originalOrderLines = [
      {
        lineIndex: 0,
        variantId: 'v-1',
        quantity: 2,
        unitGrossCents: 5000,
        taxRateBasisPoints: 2100,
        costUnitNetCents: 2000,
        originalGrossCents: 10000,
        originalDiscountGrossCents: 1000, // 500 per unit discount allocated
        netCents: 7438,
        taxCents: 1562
      },
      {
        lineIndex: 1,
        variantId: 'v-2',
        quantity: 1,
        unitGrossCents: 10000,
        taxRateBasisPoints: 2100,
        costUnitNetCents: 4000,
        originalGrossCents: 10000,
        originalDiscountGrossCents: 1000, // 1000 discount allocated
        netCents: 7438,
        taxCents: 1562
      }
    ]

    it('calculates partial line refund proportionally clawing back allocated discount', () => {
      // Returning 1 unit of line 0 (original price 5000, had 500 discount allocated)
      const input: PromotionRefundCalculationInput = {
        orderId: '00000000-0000-4000-8000-000000000001',
        lines: originalOrderLines,
        returnLines: [{ lineIndex: 0, returnQuantity: 1 }]
      }
      const result = calculatePromotionRefundReversal(input)
      expect(result.totalRefundGrossCents).toBe(4500) // 5000 - 500 discount
      expect(result.discountClawedBackGrossCents).toBe(500)
      expect(result.remainingPaidGrossCents).toBe(13500)
      expect(result.remainingOrderMarginNetCents).toBeGreaterThan(0)
    })

    it('calculates full order refund reversing all discounts and returning total paid', () => {
      const input: PromotionRefundCalculationInput = {
        orderId: '00000000-0000-4000-8000-000000000001',
        lines: originalOrderLines,
        returnLines: [
          { lineIndex: 0, returnQuantity: 2 },
          { lineIndex: 1, returnQuantity: 1 }
        ]
      }
      const result = calculatePromotionRefundReversal(input)
      expect(result.totalRefundGrossCents).toBe(18000) // (10000 - 1000) + (10000 - 1000)
      expect(result.discountClawedBackGrossCents).toBe(2000)
      expect(result.remainingPaidGrossCents).toBe(0)
      expect(result.remainingOrderMarginNetCents).toBe(0)
    })

    it('rejects refund request if return quantity exceeds purchased quantity', () => {
      const input: PromotionRefundCalculationInput = {
        orderId: '00000000-0000-4000-8000-000000000001',
        lines: originalOrderLines,
        returnLines: [{ lineIndex: 0, returnQuantity: 3 }]
      }
      expect(() => calculatePromotionRefundReversal(input)).toThrow('invalid_return_quantity')
    })
  })
})
