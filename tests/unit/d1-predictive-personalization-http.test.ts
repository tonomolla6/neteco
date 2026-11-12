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
const adminSession = '41000000-0000-4000-8000-000000000011'
const customerSession = '41000000-0000-4000-8000-000000000012'

beforeEach(async () => {
  world = await createPredictivePersonalizationWorld()
  const session = world.sqlite.prepare(
    'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
  )
  session.run(adminSession, ADMIN_IDENTITY, NOW, '2099-01-01T00:00:00Z')
  session.run(customerSession, CUSTOMER_ID_1, NOW, '2099-01-01T00:00:00Z')
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
            sessionId: claimsIdentityId === ADMIN_IDENTITY ? adminSession : customerSession,
            sessionVersion: 1,
            roles: claimsIdentityId === ADMIN_IDENTITY ? ['admin'] : ['customer'],
            permissions: claimsIdentityId === ADMIN_IDENTITY ? ['administration.manage'] : [],
            mfaVerified: true
          }
        : null
  }
}

describe('Predictive Personalization HTTP Router & Endpoints', () => {
  it.each([
    ['/api/admin/marketing/predictive-campaigns/rules', 'POST'],
    ['/api/admin/marketing/predictive-campaigns/decisions', 'POST'],
    ['/api/admin/marketing/predictive-campaigns/review', 'POST'],
    ['/api/admin/marketing/predictive-campaigns/kill-switch', 'POST'],
    ['/api/admin/marketing/predictive-campaigns/metrics', 'GET']
  ])('denies a customer before predictive admin route %s', async (path, method) => {
    const req = new Request('https://neteco.test' + path, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify({ ruleId: 'missing', decisionType: 'emergency_kill' }) } : {})
    })
    const res = await handlePredictivePersonalizationHttp(req, createDeps(CUSTOMER_ID_1))
    expect(res?.status).toBe(403)
  })

  it('requires an active admin session and MFA for predictive decisions', async () => {
    const req = () =>
      new Request('https://neteco.test/api/admin/marketing/predictive-campaigns/decisions', {
        method: 'POST',
        body: JSON.stringify({ ruleId: 'missing', decisionType: 'emergency_kill' })
      })
    world.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(adminSession)
    expect((await handlePredictivePersonalizationHttp(req(), createDeps()))?.status).toBe(403)
    world.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=? WHERE id=?').run(NOW, adminSession)
    expect((await handlePredictivePersonalizationHttp(req(), createDeps()))?.status).toBe(401)
  })

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
