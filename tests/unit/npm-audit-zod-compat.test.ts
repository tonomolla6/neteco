import { describe, expect, it } from 'vitest'
import { automationsOverviewSchema } from '../../shared/marketing-automations'
import { commercialPipelineSummarySchema } from '../../shared/commercial-quotes-accounts'
import { createIncentiveAgreementSchema, updateIncentiveAgreementSchema } from '../../shared/recurring-incentives'
import { createCourseSchema, updateCourseSchema } from '../../shared/learning-centre'
import { targetedCampaignBaseSchema, updateTargetedCampaignSchema } from '../../shared/targeted-campaigns'

describe('Zod migration preserves partial updates', () => {
  it('does not add campaign defaults to omitted update fields', () => {
    expect(updateTargetedCampaignSchema.parse({ version: 1 })).toEqual({ version: 1 })
    expect(updateTargetedCampaignSchema.parse({ version: 1, minOrderNetCents: 100 })).toEqual({
      version: 1,
      minOrderNetCents: 100
    })
    expect(updateTargetedCampaignSchema.safeParse({ version: 1, minOrderNetCents: -1 }).success).toBe(false)
    expect(targetedCampaignBaseSchema.shape.minOrderNetCents.parse(undefined)).toBe(0)
  })

  it('does not add incentive defaults to omitted update fields', () => {
    expect(updateIncentiveAgreementSchema.parse({ version: 1 })).toEqual({ version: 1 })
    expect(updateIncentiveAgreementSchema.parse({ version: 1, minGrossMarginBasisPoints: 1000 })).toEqual({
      version: 1,
      minGrossMarginBasisPoints: 1000
    })
    expect(updateIncentiveAgreementSchema.safeParse({ version: 1, minGrossMarginBasisPoints: 1 }).success).toBe(false)
    expect(createIncentiveAgreementSchema.shape.slaPunctualPaymentRequired.parse(undefined)).toBe(true)
  })

  it('does not add course defaults to omitted update fields', () => {
    expect(updateCourseSchema.parse({ version: 1 })).toEqual({ version: 1 })
    expect(updateCourseSchema.parse({ version: 1, passingScorePercent: 90 })).toEqual({
      version: 1,
      passingScorePercent: 90
    })
    expect(updateCourseSchema.safeParse({ version: 1, passingScorePercent: 20 }).success).toBe(false)
    expect(createCourseSchema.shape.passingScorePercent.parse(undefined)).toBe(80)
  })
})

describe('Zod migration preserves partial automation counts', () => {
  const counts = automationsOverviewSchema.shape.counts

  it('accepts absent or partial enum-keyed counts', () => {
    expect(
      counts.safeParse({
        welcomeDispatches: { professional_value: 1 },
        winbackEvaluations: {},
        postpurchaseDispatches: {}
      }).success
    ).toBe(true)
  })

  it('rejects unknown keys and invalid counts', () => {
    expect(
      counts.safeParse({ welcomeDispatches: { unknown: 1 }, winbackEvaluations: {}, postpurchaseDispatches: {} })
        .success
    ).toBe(false)
    expect(
      counts.safeParse({
        welcomeDispatches: { professional_value: -1 },
        winbackEvaluations: {},
        postpurchaseDispatches: {}
      }).success
    ).toBe(false)
  })
})

describe('Zod migration preserves partial commercial pipeline stages', () => {
  const stages = commercialPipelineSummarySchema.shape.stages

  it('accepts absent and partial stages', () => {
    expect(stages.safeParse({}).success).toBe(true)
    expect(stages.safeParse({ lead: { count: 1, totalGrossCents: 100, weightedValueCents: 50 } }).success).toBe(true)
  })

  it('rejects unknown stages and negative counts', () => {
    expect(stages.safeParse({ unknown: { count: 1, totalGrossCents: 100, weightedValueCents: 50 } }).success).toBe(
      false
    )
    expect(stages.safeParse({ lead: { count: -1, totalGrossCents: 100, weightedValueCents: 50 } }).success).toBe(false)
  })
})
