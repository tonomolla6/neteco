import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handlePredictivePersonalizationHttp,
  type PredictivePersonalizationHttpDependencies
} from '../../workers/marketing/predictive-personalization-http'
import {
  CUSTOMER_ID_1,
  NOW,
  createPredictivePersonalizationWorld,
  type PredictivePersonalizationWorld
} from './predictive-personalization-fixture'

let world: PredictivePersonalizationWorld
beforeEach(async () => {
  world = await createPredictivePersonalizationWorld()
})
afterEach(() => world.close())

function deps(identityId: string | null): PredictivePersonalizationHttpDependencies {
  return {
    database: world.db,
    sessionCookieConfiguration: { password: 'x'.repeat(40), maxAgeSeconds: 3600 },
    origin: 'https://neteco.beply.es',
    now: () => NOW,
    claimsResolver: async () =>
      identityId
        ? { identityId, sessionId: 's', sessionVersion: 1, roles: ['customer'], permissions: [], mfaVerified: false }
        : null
  }
}
const event = {
  id: 'evt-1',
  sessionId: 'sess-1',
  variant: 'test',
  eventType: 'click',
  marginCents: 100,
  revenueCents: 500,
  contextSurface: 'home'
}
const send = (body: unknown, identityId: string | null) =>
  handlePredictivePersonalizationHttp(
    new Request('https://neteco.beply.es/api/analytics/personalization/events', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    deps(identityId)
  )
const count = async () =>
  (await world.db.prepare('SELECT COUNT(*) AS n FROM personalization_incremental_events').first<{ n: number }>())!.n

describe('INT-7 predictive personalization HTTP hardening', () => {
  it('rejects anonymous incrementality events without writing', async () => {
    expect((await send(event, null))?.status).toBe(401)
    expect(await count()).toBe(0)
  })

  it('binds the event to the session identity and server time, ignoring body-supplied ones', async () => {
    const res = await send({ ...event, customerId: 'victim', now: '1999-01-01T00:00:00Z' }, CUSTOMER_ID_1)
    expect(res?.status).toBe(400) // unknown keys are refused (strict schema)
    const ok = await send(event, CUSTOMER_ID_1)
    expect(ok?.status).toBe(201)
    const row = await world.db
      .prepare('SELECT customer_id, created_at FROM personalization_incremental_events WHERE id = ?1')
      .bind('evt-1')
      .first<{ customer_id: string; created_at: string }>()
    expect(row).toEqual({ customer_id: CUSTOMER_ID_1, created_at: NOW })
  })

  it('validates enums and bounds', async () => {
    for (const bad of [
      { ...event, variant: 'other' },
      { ...event, revenueCents: -1 },
      { ...event, marginCents: 1.5 },
      { ...event, id: 'x'.repeat(65) }
    ]) {
      expect((await send(bad, CUSTOMER_ID_1))?.status).toBe(400)
    }
    expect(await count()).toBe(0)
  })

  it('does not disclose another customer consent state through ?customerId=', async () => {
    const put = await handlePredictivePersonalizationHttp(
      new Request('https://neteco.beply.es/api/customer/personalization/preferences', {
        method: 'PUT',
        body: JSON.stringify({ optIn: true, allowPredictiveRecommendations: true, expectedVersion: 0 })
      }),
      deps(CUSTOMER_ID_1)
    )
    expect(put?.status).toBe(200)
    const own = await handlePredictivePersonalizationHttp(
      new Request('https://neteco.beply.es/api/customer/personalization/recommendations'),
      deps(CUSTOMER_ID_1)
    )
    expect(((await own?.json()) as { variant: string }).variant).toBe('predictive')
    const res = await handlePredictivePersonalizationHttp(
      new Request(`https://neteco.beply.es/api/customer/personalization/recommendations?customerId=${CUSTOMER_ID_1}`),
      deps(null)
    )
    const body = (await res?.json()) as { variant: string }
    expect(body.variant).toBe('fallback_static')
  })

  it('authenticates via session cookie when claimsResolver is omitted', async () => {
    const { issueD1SessionCookie } = await import('../../workers/auth/session-cookie')
    const sessionConfig = { password: 'x'.repeat(40), maxAgeSeconds: 3600 }
    const sessionId = '99999999-0000-4000-8000-000000000003'
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
         VALUES (?, ?, 1, 1, ?, '2099-01-01T00:00:00Z')`
      )
      .run(sessionId, CUSTOMER_ID_1, NOW)
    const cookieHeader = await issueD1SessionCookie(
      world.db,
      { identityId: CUSTOMER_ID_1, sessionId, sessionVersion: 1 },
      sessionConfig
    )
    const res = await handlePredictivePersonalizationHttp(
      new Request('https://neteco.beply.es/api/customer/personalization/preferences', {
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
})
