import { describe, expect, it, vi } from 'vitest'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from '../../workers/runtime/analytics-config'
import { handleConfiguredAnalyticsHttp } from '../../workers/runtime/analytics-http'
import { dispatchConfiguredAnalytics } from '../../workers/runtime/analytics-dispatch'

const NOW = '2026-10-03T12:00:00Z'
const ORIGIN = 'https://shop.example'
const POLICY = {
  reference: 'synthetic-measurement-policy',
  version: 'v1',
  purpose: 'first_party_measurement',
  consentVersion: 'v1',
  retentionDays: 90,
  environment: 'local',
  approvedAt: NOW
}
function env(overrides: Record<string, unknown> = {}) {
  const database = vi.fn(() => {
    throw new Error('Database must not be inspected')
  })
  const value = {
    APP_ENV: 'local',
    AUTH_ORIGIN: ORIGIN,
    AUTH_ENABLED: 'false',
    ANALYTICS_ENABLED: 'false',
    ANALYTICS_PROJECTION_ENABLED: 'false',
    ANALYTICS_RETENTION_ENABLED: 'false',
    ANALYTICS_POLICY: 'null',
    ...overrides
  }
  Object.defineProperty(value, 'DB', { get: database })
  return { value: value as AnalyticsRuntimeEnv, database }
}
describe('analytics runtime configuration and namespace ownership', () => {
  it('constructs disabled authority without inspecting database, policy or pseudonym secrets', () => {
    const fixture = env({ ANALYTICS_POLICY: '{invalid', ANALYTICS_SESSION_PEPPER: 'unapproved' })
    const deps = configuredAnalyticsMeasurement(fixture.value)
    expect(deps.enabled).toBe(false)
    expect(deps.policy).toBeNull()
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('requires explicit approved policy and keeps acquisition and maintenance authority separate', () => {
    const fixture = env({ ANALYTICS_ENABLED: 'true' })
    const deps = configuredAnalyticsMeasurement(fixture.value)
    expect(() => deps.policy).toThrow('analytics_configuration_invalid')
    fixture.value.ANALYTICS_POLICY = JSON.stringify(POLICY)
    expect(deps.policy).toEqual(POLICY)
    fixture.value.ANALYTICS_ENABLED = 'false'
    expect(deps.policy).toBeNull()
    fixture.value.ANALYTICS_RETENTION_ENABLED = 'true'
    expect(deps.policy).toEqual(POLICY)
    expect(deps.enabled).toBe(false)
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('rechecks live policy, environment and administrative AUTH opt-in rather than stale cached flags', () => {
    const fixture = env({ ANALYTICS_ENABLED: 'true', AUTH_ENABLED: 'true', ANALYTICS_POLICY: JSON.stringify(POLICY) })
    const deps = configuredAnalyticsMeasurement(fixture.value, { administrative: true })
    expect(deps.enabled).toBe(true)
    fixture.value.AUTH_ENABLED = 'false'
    expect(deps.enabled).toBe(false)
    fixture.value.AUTH_ENABLED = 'true'
    fixture.value.ANALYTICS_POLICY = '{invalid'
    expect(() => deps.policy).toThrow('analytics_configuration_invalid')
    fixture.value.APP_ENV = 'canary'
    expect(deps.environment).toBe('preview')
    fixture.value.APP_ENV = 'unknown-environment'
    expect(() => deps.environment).toThrow()
  })
  it('uses only a dedicated 32-byte nonzero pseudonym secret, not another system key', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
    const raw = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    const fixture = env({ ANALYTICS_ENABLED: 'true', ANALYTICS_SESSION_PEPPER: raw })
    const deps = configuredAnalyticsMeasurement(fixture.value)
    expect(deps.sessionPepper).toEqual(bytes)
    fixture.value.NEWSLETTER_HMAC_KEY = raw
    expect(deps.sessionPepper).toBeUndefined()
    fixture.value.NEWSLETTER_HMAC_KEY = undefined
    fixture.value.AUTH_TOKEN_PEPPER = raw
    expect(deps.sessionPepper).toBeUndefined()
    fixture.value.AUTH_TOKEN_PEPPER = undefined
    fixture.value.ANALYTICS_SESSION_PEPPER = 'A'.repeat(43)
    expect(deps.sessionPepper).toBeUndefined()
  })
  it.each([
    '/api/analytics/events',
    '/api/admin/analytics',
    '/API/Analytics/events',
    '/api/%61nalytics/events',
    '/api/admin/%61nalytics/reconciliation',
    '/api/analytics%252Fevents'
  ])('claims disabled %s without database, cookie or body inspection', async (path) => {
    const fixture = env()
    const incoming = new Request(ORIGIN + path, { method: 'POST', body: 'secret-invalid-json' })
    const body = vi.spyOn(incoming, 'body', 'get')
    const response = await handleConfiguredAnalyticsHttp(incoming, fixture.value)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response?.headers.get('cache-control')).toContain('no-store')
    expect(body).not.toHaveBeenCalled()
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('withdraws the anonymous cookie while collection/policy/secrets/edge binding are unavailable, without SQL', async () => {
    const fixture = env({ ANALYTICS_POLICY: '{invalid' })
    const response = await handleConfiguredAnalyticsHttp(
      new Request(ORIGIN + '/api/analytics/session', {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: 'neteco-analytics-id=synthetic-prior-session' }
      }),
      fixture.value
    )
    expect(response?.status).toBe(204)
    expect(response?.headers.get('set-cookie')).toContain('neteco-analytics-id=;')
    expect(response?.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('does not clear a cookie for a cross-origin withdrawal and does not expose legacy routes', async () => {
    const fixture = env()
    const response = await handleConfiguredAnalyticsHttp(
      new Request(ORIGIN + '/api/analytics/session', {
        method: 'DELETE',
        headers: { Origin: 'https://other.example' }
      }),
      fixture.value
    )
    expect(response?.status).toBe(403)
    expect(response?.headers.get('set-cookie')).toBeNull()
    expect(await handleConfiguredAnalyticsHttp(new Request(ORIGIN + '/api/products'), fixture.value)).toBeNull()
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('keeps both maintenance opt-ins OFF without SQL, clock, policy or environment work', async () => {
    const fixture = env({ APP_ENV: 'unknown', ANALYTICS_POLICY: '{invalid' })
    const clock = vi.fn(() => NOW)
    expect(await dispatchConfiguredAnalytics(fixture.value, clock)).toEqual({
      projection: { enabled: false },
      retention: { enabled: false }
    })
    expect(clock).not.toHaveBeenCalled()
    expect(fixture.database).not.toHaveBeenCalled()
  })
  it('reports unavailable outcomes honestly and lets independent privacy maintenance try after projection failure', async () => {
    const fixture = env({
      ANALYTICS_ENABLED: 'true',
      ANALYTICS_PROJECTION_ENABLED: 'true',
      ANALYTICS_RETENTION_ENABLED: 'true',
      ANALYTICS_POLICY: '{invalid'
    })
    expect(await dispatchConfiguredAnalytics(fixture.value, () => NOW)).toEqual({
      projection: { enabled: true, status: 'unavailable' },
      retention: { enabled: true, status: 'unavailable' }
    })
    expect(fixture.database).not.toHaveBeenCalled()
  })
})
