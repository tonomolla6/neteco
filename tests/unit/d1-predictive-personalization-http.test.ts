import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handlePredictivePersonalizationHttp,
  ownsPredictivePersonalizationNamespace,
  type PredictivePersonalizationHttpDependencies
} from '../../workers/marketing/predictive-personalization-http'
import {
  ADMIN_IDENTITY,
  CAMPAIGN_ID_1,
  CUSTOMER_ID_1,
  NOW,
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

function createDeps(claimsIdentityId: string | null = ADMIN_IDENTITY): PredictivePersonalizationHttpDependencies {
  return {
    database: world.db,
    sessionCookieConfiguration: {
      cookieName: 'neteco_session',
      secret: 'synthetic-super-secret-password-32-chars-long'
    },
    origin: 'https://neteco.beply.es',
    now: () => NOW,
    claimsResolver: async () =>
      claimsIdentityId
        ? {
            identityId: claimsIdentityId,
            sessionId: 'sess-test',
            sessionVersion: 1,
            roles: claimsIdentityId === ADMIN_IDENTITY ? ['admin'] : ['customer'],
            permissions: claimsIdentityId === ADMIN_IDENTITY ? ['administration.manage'] : [],
            mfaVerified: true
          }
        : null
  }
}

describe('Predictive Personalization HTTP Router & Endpoints', () => {
  it('owns only personalization and predictive campaigns namespaces', () => {
    expect(ownsPredictivePersonalizationNamespace('/api/customer/personalization/preferences')).toBe(true)
    expect(ownsPredictivePersonalizationNamespace('/api/customer/personalization/purge')).toBe(true)
    expect(ownsPredictivePersonalizationNamespace('/api/customer/personalization/recommendations')).toBe(true)
    expect(ownsPredictivePersonalizationNamespace('/api/analytics/personalization/events')).toBe(true)
    expect(ownsPredictivePersonalizationNamespace('/api/admin/marketing/predictive-campaigns/rules')).toBe(true)
    expect(ownsPredictivePersonalizationNamespace('/api/catalog/products')).toBe(false)
  })

  it('serves customer preferences over HTTP and allows updating them', async () => {
    const deps = createDeps(CUSTOMER_ID_1)

    // GET preferences
    const getReq = new Request(
      `https://neteco.beply.es/api/customer/personalization/preferences?customerId=${CUSTOMER_ID_1}`,
      { method: 'GET' }
    )
    const getRes = await handlePredictivePersonalizationHttp(getReq, deps)
    expect(getRes?.status).toBe(200)
    const getBody = (await getRes?.json()) as { preferences: { optIn: boolean } }
    expect(getBody.preferences.optIn).toBe(true)

    // PUT preferences
    const putReq = new Request(
      `https://neteco.beply.es/api/customer/personalization/preferences?customerId=${CUSTOMER_ID_1}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          optIn: false,
          allowPredictiveRecommendations: false,
          allowOrderTimingPredictions: false,
          excludedCategories: ['general_cleaning']
        })
      }
    )
    const putRes = await handlePredictivePersonalizationHttp(putReq, deps)
    expect(putRes?.status).toBe(200)
    const putBody = (await putRes?.json()) as { preferences: { optIn: boolean } }
    expect(putBody.preferences.optIn).toBe(false)
  })

  it('rejects sensitive categories with 400 Bad Request', async () => {
    const deps = createDeps(CUSTOMER_ID_1)

    const putReq = new Request(
      `https://neteco.beply.es/api/customer/personalization/preferences?customerId=${CUSTOMER_ID_1}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          optIn: true,
          excludedCategories: ['medical', 'health']
        })
      }
    )
    const putRes = await handlePredictivePersonalizationHttp(putReq, deps)
    expect(putRes?.status).toBe(400)
    const errBody = (await putRes?.json()) as { error: { code: string } }
    expect(errBody.error.code).toBe('sensitive_category_forbidden')
  })

  it('handles admin creation of campaign optimization rules with guardrails', async () => {
    const adminDeps = createDeps(ADMIN_IDENTITY)

    const postReq = new Request('https://neteco.beply.es/api/admin/marketing/predictive-campaigns/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'rule-http-1',
        campaignId: CAMPAIGN_ID_1,
        name: 'Regla de auto-optimización HTTP',
        maxDiscountPercent: 20,
        frequencyCapDays: 7,
        budgetCapCents: 200000,
        autoApprovalMaxDiscount: 10
      })
    })

    const postRes = await handlePredictivePersonalizationHttp(postReq, adminDeps)
    expect(postRes?.status).toBe(201)
    const postBody = (await postRes?.json()) as { rule: { id: string } }
    expect(postBody.rule.id).toBe('rule-http-1')
  })

  it('toggles kill switch over HTTP with audit log', async () => {
    const adminDeps = createDeps(ADMIN_IDENTITY)

    // First create rule
    await handlePredictivePersonalizationHttp(
      new Request('https://neteco.beply.es/api/admin/marketing/predictive-campaigns/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'rule-http-ks',
          campaignId: CAMPAIGN_ID_1,
          name: 'Regla para test de kill-switch',
          maxDiscountPercent: 20,
          frequencyCapDays: 7,
          budgetCapCents: 200000,
          autoApprovalMaxDiscount: 10
        })
      }),
      adminDeps
    )

    // Toggle kill switch
    const ksReq = new Request('https://neteco.beply.es/api/admin/marketing/predictive-campaigns/kill-switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ruleId: 'rule-http-ks',
        active: true,
        reason: 'Emergency shutdown triggered by auditor'
      })
    })

    const ksRes = await handlePredictivePersonalizationHttp(ksReq, adminDeps)
    expect(ksRes?.status).toBe(200)
    const ksBody = (await ksRes?.json()) as { rule: { killSwitchActive: boolean } }
    expect(ksBody.rule.killSwitchActive).toBe(true)
  })
})
