import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyCampaignOptimizationDecision,
  createCampaignOptimizationRule,
  getCampaignOptimizationReporting,
  getPersonalizationPreferences,
  getPredictiveRecommendations,
  recordIncrementalEvent,
  reviewOptimizationDecision,
  toggleKillSwitch,
  updatePersonalizationPreferences,
  purgePersonalizationHistory,
  PredictivePersonalizationError
} from '../../workers/marketing/predictive-personalization'
import {
  ADMIN_IDENTITY,
  CAMPAIGN_ID_1,
  CUSTOMER_ID_1,
  CUSTOMER_ID_2,
  NOW,
  OTHER_IDENTITY,
  PROD_DEGREASER,
  PROD_DETERGENT,
  createPredictivePersonalizationWorld,
  type PredictivePersonalizationWorld
} from './predictive-personalization-fixture'

let world: PredictivePersonalizationWorld

beforeEach(async () => {
  world = await createPredictivePersonalizationWorld()
})

afterEach(() => {
  world.close()
})

const code = (e: unknown) => (e instanceof PredictivePersonalizationError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

describe('MKT-037: Predictive Personalization with User Control & Incremental Lift', () => {
  it('allows customer to get default preferences and update them (opt-in / opt-out control)', async () => {
    // Get default preferences (defaults to opt_in: true)
    const prefs = await getPersonalizationPreferences(world.db, {
      customerId: CUSTOMER_ID_1,
      actorId: CUSTOMER_ID_1
    })
    expect(prefs.optIn).toBe(true)
    expect(prefs.allowPredictiveRecommendations).toBe(true)

    // Update preferences to opt out of predictive recommendations
    const updated = await updatePersonalizationPreferences(world.db, {
      customerId: CUSTOMER_ID_1,
      actorId: CUSTOMER_ID_1,
      now: NOW,
      input: {
        optIn: false,
        allowPredictiveRecommendations: false,
        allowOrderTimingPredictions: false,
        excludedCategories: ['general_cleaning'],
        version: prefs.version
      }
    })

    expect(updated.optIn).toBe(false)
    expect(updated.allowPredictiveRecommendations).toBe(false)
    expect(updated.version).toBe(2)

    // Forbids another non-admin identity from tampering with customer preferences
    expect(
      await fails(
        updatePersonalizationPreferences(world.db, {
          customerId: CUSTOMER_ID_1,
          actorId: OTHER_IDENTITY,
          now: NOW,
          input: {
            optIn: true,
            version: updated.version
          }
        })
      )
    ).toBe('forbidden')
  })

  it('strictly rejects sensitive categories in excluded or preferred targeting', async () => {
    const prefs = await getPersonalizationPreferences(world.db, {
      customerId: CUSTOMER_ID_1,
      actorId: CUSTOMER_ID_1
    })

    // Attempting to submit sensitive categories (e.g. medical, political, religion) is blocked
    expect(
      await fails(
        updatePersonalizationPreferences(world.db, {
          customerId: CUSTOMER_ID_1,
          actorId: CUSTOMER_ID_1,
          now: NOW,
          input: {
            optIn: true,
            excludedCategories: ['medical', 'religion'],
            version: prefs.version
          }
        })
      )
    ).toBe('sensitive_category_forbidden')
  })

  it('allows customer to purge history and resets personalization state', async () => {
    const purged = await purgePersonalizationHistory(world.db, {
      customerId: CUSTOMER_ID_1,
      actorId: CUSTOMER_ID_1,
      now: NOW
    })
    expect(purged.historyPurgedAt).toBe(NOW)

    const prefs = await getPersonalizationPreferences(world.db, {
      customerId: CUSTOMER_ID_1,
      actorId: CUSTOMER_ID_1
    })
    expect(prefs.historyPurgedAt).toBe(NOW)
  })

  it('returns fast fallback when user is opted-out or cold-start', async () => {
    // Customer 2 has no history and opt-in is false
    await updatePersonalizationPreferences(world.db, {
      customerId: CUSTOMER_ID_2,
      actorId: CUSTOMER_ID_2,
      now: NOW,
      input: {
        optIn: false,
        version: 1
      }
    })

    const recs = await getPredictiveRecommendations(world.db, {
      customerId: CUSTOMER_ID_2,
      surface: 'home',
      now: NOW
    })

    expect(recs.variant).toBe('fallback_static')
    expect(recs.products.length).toBeGreaterThan(0)
    expect(recs.isFallback).toBe(true)
  })

  it('records incremental events and measures A/B lift between test and holdout groups', async () => {
    // Record holdout impressions and conversions
    await recordIncrementalEvent(world.db, {
      id: 'inc-evt-1',
      customerId: CUSTOMER_ID_1,
      sessionId: 'sess-holdout-1',
      variant: 'holdout',
      eventType: 'impression',
      contextSurface: 'home',
      productId: PROD_DETERGENT,
      marginCents: 0,
      revenueCents: 0,
      now: NOW
    })
    await recordIncrementalEvent(world.db, {
      id: 'inc-evt-2',
      customerId: CUSTOMER_ID_1,
      sessionId: 'sess-holdout-1',
      variant: 'holdout',
      eventType: 'conversion',
      contextSurface: 'home',
      productId: PROD_DETERGENT,
      marginCents: 500,
      revenueCents: 2000,
      now: NOW
    })

    // Record test (predictive) impressions and higher conversions
    await recordIncrementalEvent(world.db, {
      id: 'inc-evt-3',
      customerId: CUSTOMER_ID_2,
      sessionId: 'sess-test-1',
      variant: 'test',
      eventType: 'impression',
      contextSurface: 'home',
      productId: PROD_DEGREASER,
      marginCents: 0,
      revenueCents: 0,
      now: NOW
    })
    await recordIncrementalEvent(world.db, {
      id: 'inc-evt-4',
      customerId: CUSTOMER_ID_2,
      sessionId: 'sess-test-1',
      variant: 'test',
      eventType: 'conversion',
      contextSurface: 'home',
      productId: PROD_DEGREASER,
      marginCents: 1200,
      revenueCents: 3500,
      now: NOW
    })

    // Check reporting
    const metrics = await getCampaignOptimizationReporting(world.db, {
      actorId: ADMIN_IDENTITY
    })

    expect(metrics.holdoutImpressions).toBe(1)
    expect(metrics.holdoutConversions).toBe(1)
    expect(metrics.holdoutMarginCents).toBe(500)

    expect(metrics.testImpressions).toBe(1)
    expect(metrics.testConversions).toBe(1)
    expect(metrics.testMarginCents).toBe(1200)

    // Incremental margin lift: test margin (1200) vs holdout margin (500)
    expect(metrics.incrementalMarginLiftCents).toBe(700)
  })
})

describe('MKT-038: Automated Campaign Optimization with Guardrails, Approval & Kill Switch', () => {
  it('creates optimization rules with guardrails and enforces admin authorization', async () => {
    // Non-admin cannot create rules
    expect(
      await fails(
        createCampaignOptimizationRule(world.db, {
          actorId: OTHER_IDENTITY,
          now: NOW,
          input: {
            id: 'rule-turia-opt',
            campaignId: CAMPAIGN_ID_1,
            name: 'Auto-tuner Lavanderías Q4',
            maxDiscountPercent: 20,
            frequencyCapDays: 7,
            budgetCapCents: 500000,
            autoApprovalMaxDiscount: 10
          }
        })
      )
    ).toBe('forbidden')

    // Admin creates valid rule
    const rule = await createCampaignOptimizationRule(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'rule-turia-opt',
        campaignId: CAMPAIGN_ID_1,
        name: 'Auto-tuner Lavanderías Q4',
        maxDiscountPercent: 20,
        frequencyCapDays: 7,
        budgetCapCents: 500000,
        autoApprovalMaxDiscount: 10
      }
    })

    expect(rule.id).toBe('rule-turia-opt')
    expect(rule.maxDiscountPercent).toBe(20)
    expect(rule.killSwitchActive).toBe(false)
  })

  it('rejects rule creation if proposed discount violates guardrail limits', async () => {
    expect(
      await fails(
        createCampaignOptimizationRule(world.db, {
          actorId: ADMIN_IDENTITY,
          now: NOW,
          input: {
            id: 'rule-invalid-discount',
            campaignId: CAMPAIGN_ID_1,
            name: 'Rule with extreme discount',
            maxDiscountPercent: 60, // Above allowed maximum 50%
            frequencyCapDays: 7,
            budgetCapCents: 100000,
            autoApprovalMaxDiscount: 15
          }
        })
      )
    ).toBe('guardrail_max_discount_exceeded')
  })

  it('auto-applies decision if proposed discount is within auto-approval threshold', async () => {
    await createCampaignOptimizationRule(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'rule-auto-app',
        campaignId: CAMPAIGN_ID_1,
        name: 'Auto Approval Rule',
        maxDiscountPercent: 25,
        frequencyCapDays: 7,
        budgetCapCents: 300000,
        autoApprovalMaxDiscount: 10
      }
    })

    const decision = await applyCampaignOptimizationDecision(world.db, {
      ruleId: 'rule-auto-app',
      decisionType: 'discount_tune',
      proposedParams: { discountPercent: 8, budgetCents: 50000 },
      now: NOW
    })

    expect(decision.approvalStatus).toBe('auto_applied')
    expect(decision.hash).toHaveLength(64)
  })

  it('sets decision to pending_approval if proposed discount exceeds auto-approval threshold but <= max discount', async () => {
    await createCampaignOptimizationRule(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'rule-pending',
        campaignId: CAMPAIGN_ID_1,
        name: 'Rule Requiring Approval',
        maxDiscountPercent: 25,
        frequencyCapDays: 7,
        budgetCapCents: 300000,
        autoApprovalMaxDiscount: 10
      }
    })

    const decision = await applyCampaignOptimizationDecision(world.db, {
      ruleId: 'rule-pending',
      decisionType: 'discount_tune',
      proposedParams: { discountPercent: 18, budgetCents: 150000 },
      now: NOW
    })

    expect(decision.approvalStatus).toBe('pending_approval')
    expect(decision.appliedParams).toBeNull()

    // Admin can review and approve it
    const reviewed = await reviewOptimizationDecision(world.db, {
      decisionId: decision.id,
      actorId: ADMIN_IDENTITY,
      verdict: 'approved',
      notes: 'Descuento del 18% validado con responsable de margen.',
      now: NOW
    })

    expect(reviewed.approvalStatus).toBe('approved')
    expect(reviewed.appliedParams).toEqual(decision.proposedParams)
    expect(reviewed.reviewedBy).toBe(ADMIN_IDENTITY)
  })

  it('blocks decision immediately if discount exceeds maximum guardrail', async () => {
    await createCampaignOptimizationRule(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'rule-strict',
        campaignId: CAMPAIGN_ID_1,
        name: 'Strict Rule',
        maxDiscountPercent: 15,
        frequencyCapDays: 7,
        budgetCapCents: 200000,
        autoApprovalMaxDiscount: 10
      }
    })

    expect(
      await fails(
        applyCampaignOptimizationDecision(world.db, {
          ruleId: 'rule-strict',
          decisionType: 'discount_tune',
          proposedParams: { discountPercent: 22, budgetCents: 50000 },
          now: NOW
        })
      )
    ).toBe('guardrail_max_discount_exceeded')
  })

  it('emergency kill switch halts optimization decisions immediately', async () => {
    await createCampaignOptimizationRule(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'rule-killable',
        campaignId: CAMPAIGN_ID_1,
        name: 'Killable Rule',
        maxDiscountPercent: 20,
        frequencyCapDays: 7,
        budgetCapCents: 100000,
        autoApprovalMaxDiscount: 10
      }
    })

    // Activate kill switch
    await toggleKillSwitch(world.db, {
      ruleId: 'rule-killable',
      actorId: ADMIN_IDENTITY,
      active: true,
      reason: 'Detección de anomalía en margen comercial',
      now: NOW
    })

    // Optimization decision is blocked by kill switch
    expect(
      await fails(
        applyCampaignOptimizationDecision(world.db, {
          ruleId: 'rule-killable',
          decisionType: 'discount_tune',
          proposedParams: { discountPercent: 5, budgetCents: 10000 },
          now: NOW
        })
      )
    ).toBe('kill_switch_active')
  })
})
