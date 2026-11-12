import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleModelEvaluationHttp,
  ownsModelEvaluationNamespace,
  type ModelEvaluationHttpDependencies
} from '../../workers/analytics/model-evaluation-http'
import {
  ADMIN_IDENTITY,
  NOW,
  OTHER_IDENTITY,
  PROD_DEGREASER,
  createPredictivePersonalizationWorld,
  type PredictivePersonalizationWorld
} from './predictive-personalization-fixture'

let world: PredictivePersonalizationWorld
const adminSession = '41000000-0000-4000-8000-000000000021'
const otherSession = '41000000-0000-4000-8000-000000000022'

beforeEach(async () => {
  world = await createPredictivePersonalizationWorld()
  const session = world.sqlite.prepare(
    'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
  )
  session.run(adminSession, ADMIN_IDENTITY, NOW, '2099-01-01T00:00:00Z')
  session.run(otherSession, OTHER_IDENTITY, NOW, '2099-01-01T00:00:00Z')
})

afterEach(() => {
  world.close()
})

function createDeps(claimsIdentityId: string | null = ADMIN_IDENTITY): ModelEvaluationHttpDependencies {
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
            sessionId: claimsIdentityId === ADMIN_IDENTITY ? adminSession : otherSession,
            sessionVersion: 1,
            roles: claimsIdentityId === ADMIN_IDENTITY ? ['admin'] : ['customer'],
            permissions: claimsIdentityId === ADMIN_IDENTITY ? ['administration.manage'] : [],
            mfaVerified: true
          }
        : null
  }
}

describe('Model Evaluation & AI Quality Gate HTTP Router', () => {
  it.each([
    ['/api/admin/ai/models', 'GET'],
    ['/api/admin/ai/evaluations/summary?modelId=missing', 'GET'],
    ['/api/admin/ai/evaluations/gate', 'POST'],
    ['/api/admin/ai/evaluations/explainability', 'POST'],
    ['/api/admin/ai/evaluations/offline', 'POST'],
    ['/api/admin/ai/evaluations/online', 'POST'],
    ['/api/admin/ai/evaluations/golden-set/run', 'POST']
  ])('denies a non-admin before model route %s', async (path, method) => {
    const request = new Request('https://neteco.test' + path, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify({}) } : {})
    })
    expect((await handleModelEvaluationHttp(request, createDeps(OTHER_IDENTITY)))?.status).toBe(403)
  })

  it('requires an active admin session and MFA for model data', async () => {
    const request = () => new Request('https://neteco.test/api/admin/ai/models')
    world.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(adminSession)
    expect((await handleModelEvaluationHttp(request(), createDeps()))?.status).toBe(403)
    world.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=? WHERE id=?').run(NOW, adminSession)
    expect((await handleModelEvaluationHttp(request(), createDeps()))?.status).toBe(401)
  })

  it('owns only /api/admin/ai/ models, evaluations and gate namespaces', () => {
    expect(ownsModelEvaluationNamespace('/api/admin/ai/models')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/offline')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/online')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/summary')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/explainability')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/golden-set/run')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/ai/evaluations/gate')).toBe(true)
    expect(ownsModelEvaluationNamespace('/api/admin/customers')).toBe(false)
  })

  it('authenticates via session cookie without claimsResolver (no invalid_permission 500)', async () => {
    const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
    const sessionConfig = {
      password: 'synthetic-super-secret-password-32-chars-long',
      maxAgeSeconds: 3600
    }
    const sessionId = '99999999-0000-4000-8000-000000000002'
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
         VALUES (?, ?, 1, 1, ?, '2099-01-01T00:00:00Z')`
      )
      .run(sessionId, ADMIN_IDENTITY, NOW)
    const cookieHeader = await issueD1SessionCookie(
      world.db,
      { identityId: ADMIN_IDENTITY, sessionId, sessionVersion: 1 },
      sessionConfig
    )
    const res = await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/models', {
        headers: { cookie: cookieHeader!.split(';')[0]! }
      }),
      {
        database: world.db,
        sessionCookieConfiguration: sessionConfig,
        origin: 'https://neteco.beply.es',
        now: () => NOW
      }
    )
    expect(res?.status).toBe(200)
  })

  it('allows admin to register ML model and rejects non-admin with 403', async () => {
    const nonAdminDeps = createDeps(OTHER_IDENTITY)
    const adminDeps = createDeps(ADMIN_IDENTITY)

    const modelPayload = {
      id: 'mod-http-margin-v1',
      modelName: 'HTTP Margin Retention Model',
      modelVersion: '1.0.0',
      modelType: 'margin_recommendation',
      objective: 'margin_retention',
      weights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
      fallbackStrategy: 'static_bestsellers'
    }

    // Non-admin request
    const forbidRes = await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(modelPayload)
      }),
      nonAdminDeps
    )
    expect(forbidRes?.status).toBe(403)

    // Admin request
    const successRes = await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(modelPayload)
      }),
      adminDeps
    )
    expect(successRes?.status).toBe(201)
    const body = (await successRes?.json()) as { model: { id: string } }
    expect(body.model.id).toBe('mod-http-margin-v1')
  })

  it('runs golden set evaluation and returns gate verdict over HTTP', async () => {
    const adminDeps = createDeps(ADMIN_IDENTITY)

    // Register candidate model
    await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'mod-gate-http-v1',
          modelName: 'Gate Evaluation HTTP Candidate',
          modelVersion: '1.0.0',
          modelType: 'catalog_copilot_assistant',
          objective: 'factuality_safety',
          weights: { margin: 0.4, retention: 0.3, clicks: 0.3 },
          fallbackStrategy: 'rules_safety_default'
        })
      }),
      adminDeps
    )

    // Run golden set evaluation
    const evalRes = await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/evaluations/golden-set/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelId: 'mod-gate-http-v1',
          suiteName: 'neteco_chemical_golden_suite_v1'
        })
      }),
      adminDeps
    )

    expect(evalRes?.status).toBe(200)
    const evalBody = (await evalRes?.json()) as { run: { gateVerdict: string; safetyScore: number } }
    expect(evalBody.run.gateVerdict).toBe('passed')
    expect(evalBody.run.safetyScore).toBe(1.0)
  })

  it('returns explainability report breakdown over HTTP', async () => {
    const adminDeps = createDeps(ADMIN_IDENTITY)

    const expRes = await handleModelEvaluationHttp(
      new Request('https://neteco.beply.es/api/admin/ai/evaluations/explainability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: 'cust-123',
          productId: PROD_DEGREASER,
          modelWeights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
          features: {
            daysSinceLastOrder: 25,
            expectedReplenishmentCycleDays: 30,
            historicalSectorMarginPercent: 35,
            catalogPopularityScore: 0.8
          }
        })
      }),
      adminDeps
    )

    expect(expRes?.status).toBe(200)
    const expBody = (await expRes?.json()) as {
      report: { topContributingFactors: Array<{ factor: string }> }
    }
    expect(expBody.report.topContributingFactors.length).toBeGreaterThan(0)
  })
})
