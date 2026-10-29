import { describe, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import { normalizePromotionCode, promotionRuleSchema, type PromotionRule } from '../../shared/promotions'
import { evaluatePromotion, promotionRuleHash, type PromotionContext } from '../../workers/catalog/promotions'

const id = (name: string) => deterministicUuid(`promotion:${name}`)
const NOW = '2030-01-02T12:00:00Z'
const rule: PromotionRule = {
  id: id('rule'),
  version: 1,
  code: 'SAVE',
  status: 'active',
  channel: 'online',
  startsAt: NOW,
  endsAt: '2030-01-03T12:00:00Z',
  benefit: { kind: 'fixed', grossCents: 101 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'stack_volume'
}
const context: PromotionContext = {
  now: NOW,
  channel: 'online',
  customerId: null,
  companyApproved: false,
  redemptions: { total: 0, customer: 0 },
  lines: [
    {
      lineIndex: 0,
      variantId: id('v0'),
      productId: id('p0'),
      categoryId: id('category'),
      sku: 'FIRST',
      quantity: 1,
      baseUnitGrossCents: 1000,
      volumeUnitGrossCents: 1000,
      taxRateBasisPoints: 2100
    },
    {
      lineIndex: 1,
      variantId: id('v1'),
      productId: id('p1'),
      categoryId: id('category'),
      sku: 'SECOND',
      quantity: 1,
      baseUnitGrossCents: 1000,
      volumeUnitGrossCents: 1000,
      taxRateBasisPoints: 1000
    }
  ]
}
const evaluate = (change: Partial<PromotionRule> = {}, data: Partial<PromotionContext> = {}) =>
  evaluatePromotion({ ...rule, ...change }, { ...context, ...data })

describe('configured promotion evaluation, with existing money rounding', () => {
  it('normalizes ASCII codes but never folds unrelated Unicode into a valid code', () => {
    expect(normalizePromotionCode(' save-10 ')).toBe('SAVE-10')
    expect(() => normalizePromotionCode('SÁVE')).toThrow()
    expect(() => normalizePromotionCode('ＳＡＶＥ')).toThrow()
    expect(() => normalizePromotionCode('SAVE CODE')).toThrow()
  })
  it('preserves the 64-character ASCII limit after ordinary whitespace normalization', () => {
    for (const length of [63, 64])
      expect(normalizePromotionCode(' ' + 'a'.repeat(length) + ' ')).toBe('A'.repeat(length))
    expect(() => normalizePromotionCode('A'.repeat(65))).toThrow('invalid_promotion_code')
    expect(normalizePromotionCode('\t save \r\n')).toBe('SAVE')
    expect(() => normalizePromotionCode('SA\u0000VE')).toThrow('invalid_promotion_code')
  })
  it('checks original ASCII before trim or uppercase can erase or expand Unicode input', () => {
    for (const value of ['\u00a0SAVE', 'SAVE\u00a0', 'ſave', 'ßAVE', 'SAVE\u007f', 'SAVE\u0080'])
      expect(() => normalizePromotionCode(value)).toThrow('invalid_promotion_code')
  })
  it('requires explicit administration parameters and a strictly increasing calendar', () => {
    expect(promotionRuleSchema.safeParse(rule).success).toBe(true)
    expect(promotionRuleSchema.safeParse({ ...rule, volumeMode: undefined }).success).toBe(false)
    expect(promotionRuleSchema.safeParse({ ...rule, endsAt: NOW }).success).toBe(false)
    expect(promotionRuleSchema.safeParse({ ...rule, benefit: { kind: 'percent', basisPoints: 10001 } }).success).toBe(
      false
    )
  })
  it('allocates a fixed odd cent deterministically and recalculates each VAT class', () => {
    const result = evaluate()
    expect(result.eligible).toBe(true)
    expect(result.lines.map((line) => line.discountGrossCents)).toEqual([51, 50])
    expect(result.lines.map((line) => [line.netCents, line.taxCents, line.grossCents])).toEqual([
      [784, 165, 949],
      [864, 86, 950]
    ])
    expect(result.totals).toEqual({ discountGrossCents: 101, netCents: 1648, taxCents: 251, grossCents: 1899 })
    expect(
      evaluate({}, { lines: [...context.lines].reverse() }).lines.map((line) => [
        line.lineIndex,
        line.discountGrossCents
      ])
    ).toEqual([
      [0, 51],
      [1, 50]
    ])
  })
  it('caps a fixed discount at eligible goods without negative totals', () => {
    expect(evaluate({ benefit: { kind: 'fixed', grossCents: 5000 } }).totals.grossCents).toBe(0)
    expect(evaluate({ benefit: { kind: 'fixed', grossCents: 5000 } }).totals.discountGrossCents).toBe(2000)
  })
  it('uses half-up money rounding for percentage on the whole eligible amount', () => {
    const result = evaluate(
      { benefit: { kind: 'percent', basisPoints: 5000 } },
      { lines: [{ ...context.lines[0]!, baseUnitGrossCents: 1, volumeUnitGrossCents: 1 }] }
    )
    expect(result.totals.discountGrossCents).toBe(1)
  })
  it.each([
    ['paused', { status: 'paused' }, {}, 'unavailable'],
    ['not started', {}, { now: '2030-01-02T11:59:59Z' }, 'not_started'],
    ['exclusive end', {}, { now: rule.endsAt }, 'expired'],
    ['registered segment', { segment: 'registered' }, {}, 'segment_not_eligible'],
    [
      'approved company segment',
      { segment: 'approved_company' },
      { customerId: id('customer') },
      'segment_not_eligible'
    ],
    ['per customer requires authority', { perCustomerLimit: 1 }, {}, 'customer_required'],
    ['global cap', { totalLimit: 1 }, { redemptions: { total: 1, customer: 0 } }, 'usage_limit'],
    [
      'customer cap',
      { perCustomerLimit: 1 },
      { customerId: id('customer'), redemptions: { total: 1, customer: 1 } },
      'usage_limit'
    ]
  ] as const)('rejects %s without leaking detailed campaign limits', (_name, change, data, reason) => {
    const result = evaluate(change as Partial<PromotionRule>, data as Partial<PromotionContext>)
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe(reason)
    expect(result.totals.discountGrossCents).toBe(0)
  })
  it('restricts product/category scopes to authoritative matching lines', () => {
    expect(
      evaluate({ scope: { kind: 'product', ids: [context.lines[1]!.productId] } }).lines.map(
        (line) => line.discountGrossCents
      )
    ).toEqual([0, 101])
    expect(evaluate({ scope: { kind: 'category', ids: [id('foreign')] } }).reason).toBe('no_eligible_lines')
  })
  it('requires live registered ownership plus approved-company authority for its segment', () => {
    expect(evaluate({ segment: 'approved_company' }, { companyApproved: true }).eligible).toBe(false)
    expect(
      evaluate({ segment: 'approved_company' }, { customerId: id('customer'), companyApproved: true }).eligible
    ).toBe(true)
  })
  it('excludes actual volume lines, or explicitly stacks on their lower price', () => {
    const lines = [{ ...context.lines[0]!, volumeUnitGrossCents: 800 }]
    expect(evaluate({ volumeMode: 'exclude_volume' }, { lines }).reason).toBe('no_eligible_lines')
    expect(evaluate({ volumeMode: 'stack_volume' }, { lines }).totals.grossCents).toBe(699)
  })
  it('chooses the better complete basket, and keeps volume on ties without consuming a coupon', () => {
    const lines = [{ ...context.lines[0]!, volumeUnitGrossCents: 800 }]
    expect(evaluate({ volumeMode: 'best_of_volume' }, { lines }).reason).toBe('no_benefit')
    expect(
      evaluate({ volumeMode: 'best_of_volume', benefit: { kind: 'fixed', grossCents: 200 } }, { lines }).reason
    ).toBe('no_benefit')
    expect(
      evaluate({ volumeMode: 'best_of_volume', benefit: { kind: 'fixed', grossCents: 201 } }, { lines }).totals
        .grossCents
    ).toBe(799)
  })
  it('bounds line count, rejects duplicate identities and unsafe gross multiplication', () => {
    expect(() =>
      evaluate(
        {},
        {
          lines: Array.from({ length: 101 }, (_, lineIndex) => ({
            ...context.lines[0]!,
            lineIndex,
            variantId: id(`many${lineIndex}`)
          }))
        }
      )
    ).toThrow()
    expect(() => evaluate({}, { lines: [context.lines[0]!, context.lines[0]!] })).toThrow()
    expect(() =>
      evaluate(
        {},
        {
          lines: [
            {
              ...context.lines[0]!,
              quantity: 2,
              baseUnitGrossCents: Number.MAX_SAFE_INTEGER,
              volumeUnitGrossCents: Number.MAX_SAFE_INTEGER
            }
          ]
        }
      )
    ).toThrow()
  })
  it('accepts existing bounded internal catalog IDs without inventing UUID replacements', () => {
    const result = evaluate(
      {},
      { lines: [{ ...context.lines[0]!, variantId: 'v-1-1', productId: 'p1', categoryId: 'c1' }] }
    )
    expect(result.eligible).toBe(true)
    expect(result.lines[0]?.variantId).toBe('v-1-1')
  })
  it('fingerprints normalized full rule content and changes hash for any governed revision', async () => {
    expect(await promotionRuleHash(rule)).toMatch(/^[0-9a-f]{64}$/)
    expect(await promotionRuleHash({ ...rule, code: ' save ' })).toBe(await promotionRuleHash(rule))
    expect(await promotionRuleHash({ ...rule, version: 2 })).not.toBe(await promotionRuleHash(rule))
    expect(await promotionRuleHash({ ...rule, benefit: { kind: 'fixed', grossCents: 102 } })).not.toBe(
      await promotionRuleHash(rule)
    )
  })
})
