import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, ANALYTICS_CONSENT, CLAIMS } from './d1-analytics-fixture'
import {
  wilsonScoreInterval,
  groupReferrerAndUtm,
  recordFunnelEvent,
  readFunnelAnalyticsDashboard,
  type FunnelAnalyticsDashboardQuery
} from '../../workers/analytics/funnel'
import { handleFunnelAnalyticsHttp } from '../../workers/analytics/funnel-http'
import type { AnalyticsHttpDependencies } from '../../workers/analytics/http'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

async function setupFunnelFixture(options: { now?: string } = {}) {
  const world = await analyticsFixture()
  connections.push(world.sqlite)

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0099_analytics_cohorts.sql', import.meta.url),
    'utf8'
  )
  world.sqlite.exec(migrationSql)

  if (options.now) {
    world.setNow(options.now)
    // Keep auth session and identity valid for the test's now
    const past = new Date(Date.parse(options.now) - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const future = new Date(Date.parse(options.now) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    world.sqlite.prepare(`UPDATE auth_sessions SET created_at = ?, expires_at = ?`).run(past, future)
    world.sqlite
      .prepare(`UPDATE identities SET created_at = ?, updated_at = ?, email_verified_at = ?`)
      .run(past, past, past)
    world.sqlite.prepare(`UPDATE identity_roles SET granted_at = ?`).run(past)
    if (world.deps.policy) {
      world.deps.policy = {
        ...world.deps.policy,
        approvedAt: past
      }
    }
  }

  return world
}

describe('DAT-015 Conversion Funnel and Wilson Score Confidence Intervals', () => {
  describe('Wilson score confidence interval and sample threshold', () => {
    it('handles n = 0 safely with rate null and [0, 0] interval', () => {
      const res = wilsonScoreInterval(0, 0)
      expect(res.rate).toBeNull()
      expect(res.lower).toBe(0)
      expect(res.upper).toBe(0)
      expect(res.hasSufficientSample).toBe(false)
    })

    it('handles 0 successes with positive sample (k = 0, n = 25)', () => {
      const res = wilsonScoreInterval(0, 25)
      expect(res.rate).toBe(0)
      expect(res.lower).toBe(0)
      expect(res.upper).toBeGreaterThan(0)
      expect(res.upper).toBeLessThan(0.2)
      expect(res.hasSufficientSample).toBe(false) // n < 30
    })

    it('handles 100% successes (k = 25, n = 25)', () => {
      const res = wilsonScoreInterval(25, 25)
      expect(res.rate).toBe(1)
      expect(res.lower).toBeGreaterThan(0.8)
      expect(res.upper).toBe(1)
      expect(res.hasSufficientSample).toBe(false) // n < 30
    })

    it('computes accurate 95% Wilson confidence interval for sufficient sample (k = 40, n = 100)', () => {
      const res = wilsonScoreInterval(40, 100)
      expect(res.rate).toBe(0.4)
      // Wilson 95% CI for 40/100 is approximately [0.3094, 0.4979]
      expect(res.lower).toBeGreaterThanOrEqual(0.3)
      expect(res.lower).toBeLessThan(0.4)
      expect(res.upper).toBeGreaterThan(0.4)
      expect(res.upper).toBeLessThanOrEqual(0.51)
      expect(res.hasSufficientSample).toBe(true) // n >= 30
    })

    it('ensures bounds are strictly clamped within [0, 1]', () => {
      const edgeLow = wilsonScoreInterval(1, 1000)
      expect(edgeLow.lower).toBeGreaterThanOrEqual(0)
      expect(edgeLow.upper).toBeLessThanOrEqual(1)

      const edgeHigh = wilsonScoreInterval(999, 1000)
      expect(edgeHigh.lower).toBeGreaterThanOrEqual(0)
      expect(edgeHigh.upper).toBeLessThanOrEqual(1)
    })
  })

  describe('UTM and Referrer grouping (PII-free attribution)', () => {
    it('classifies direct traffic when no referrer and no utm parameters', () => {
      expect(groupReferrerAndUtm()).toBe('direct')
      expect(groupReferrerAndUtm('', '', '')).toBe('direct')
    })

    it('classifies organic search engines', () => {
      expect(groupReferrerAndUtm('https://www.google.es/search?q=algo')).toBe('organic')
      expect(groupReferrerAndUtm('https://duckduckgo.com/')).toBe('organic')
      expect(groupReferrerAndUtm('https://www.bing.com/')).toBe('organic')
    })

    it('classifies paid CPC campaigns via utm_medium or utm_source', () => {
      expect(groupReferrerAndUtm(undefined, 'google', 'cpc')).toBe('cpc')
      expect(groupReferrerAndUtm(undefined, 'adwords', 'banner')).toBe('cpc')
      expect(groupReferrerAndUtm(undefined, 'bing', 'paid')).toBe('cpc')
    })

    it('classifies social networks from referrer or utm', () => {
      expect(groupReferrerAndUtm('https://l.instagram.com/')).toBe('social')
      expect(groupReferrerAndUtm(undefined, 'facebook', 'post')).toBe('social')
      expect(groupReferrerAndUtm('https://t.co/xyz')).toBe('social')
    })

    it('classifies email marketing', () => {
      expect(groupReferrerAndUtm(undefined, 'boletin', 'email')).toBe('email')
      expect(groupReferrerAndUtm(undefined, 'newsletter_octubre', 'mail')).toBe('email')
    })

    it('classifies external referrers as referral', () => {
      expect(groupReferrerAndUtm('https://foro-limpieza.com/hilos/123')).toBe('referral')
    })
  })

  describe('Funnel event recording and consent enforcement', () => {
    it('rejects event without analytics consent cookie', async () => {
      const fixture = await setupFunnelFixture()
      const { deps } = fixture

      const res = await recordFunnelEvent(deps, {
        event: {
          name: 'visit',
          occurredAt: '2026-10-29T10:00:00Z',
          device: 'desktop',
          source: 'direct',
          segment: 'anonymous'
        },
        consentCookie: undefined
      })
      expect(res.accepted).toBe(false)
      expect(res.reason).toBe('consent_required')
    })

    it('excludes bots based on user-agent', async () => {
      const fixture = await setupFunnelFixture()
      const { deps } = fixture

      const res = await recordFunnelEvent(deps, {
        event: {
          name: 'visit',
          occurredAt: '2026-10-29T10:00:00Z',
          device: 'desktop',
          source: 'direct',
          segment: 'anonymous'
        },
        consentCookie: ANALYTICS_CONSENT,
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
      })
      expect(res.accepted).toBe(false)
      expect(res.reason).toBe('bot_excluded')
    })

    it('accepts valid funnel event and provides anonymous cookie if absent', async () => {
      const fixture = await setupFunnelFixture({ now: '2026-10-29T12:00:00Z' })
      const { deps } = fixture

      const res = await recordFunnelEvent(deps, {
        event: {
          name: 'visit',
          occurredAt: '2026-10-29T12:00:00Z',
          device: 'mobile',
          source: 'organic',
          segment: 'anonymous'
        },
        consentCookie: ANALYTICS_CONSENT,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
      })
      expect(res.accepted).toBe(true)
      expect(res.cookie).not.toBeNull()
      expect(res.cookie?.name).toBe('neteco-analytics-id')
    })

    it('handles idempotent duplicate event insertion gracefully', async () => {
      const fixture = await setupFunnelFixture({ now: '2026-10-29T12:00:00Z' })
      const { deps } = fixture

      const eventPayload = {
        eventId: '00000000-0000-4000-8000-000000000101',
        name: 'product_view' as const,
        occurredAt: '2026-10-29T12:00:00Z',
        device: 'desktop' as const,
        source: 'direct' as const,
        segment: 'customer' as const,
        targetId: 'prod-lejiapro'
      }

      const res1 = await recordFunnelEvent(deps, {
        event: eventPayload,
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: '11111111-1111-4111-8111-111111111111'
      })
      expect(res1.accepted).toBe(true)

      const res2 = await recordFunnelEvent(deps, {
        event: eventPayload,
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: '11111111-1111-4111-8111-111111111111'
      })
      expect(res2.accepted).toBe(true)
    })
  })

  describe('Funnel dashboard calculation and step conversion', () => {
    it('aggregates sessions through all 5 steps and computes Wilson interval and sample warning', async () => {
      const fixture = await setupFunnelFixture({ now: '2026-10-29T12:00:00Z' })
      const { deps } = fixture

      // Simulate a multi-step session funnel with 40 visitors
      // 40 visit -> 20 view product -> 10 add to cart -> 6 start checkout -> 4 purchase
      for (let i = 1; i <= 40; i++) {
        const anonId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

        // Step 1: visit (all 40)
        await recordFunnelEvent(deps, {
          event: {
            name: 'visit',
            occurredAt: '2026-10-29T10:00:00Z',
            device: 'desktop',
            source: 'organic',
            segment: 'anonymous'
          },
          consentCookie: ANALYTICS_CONSENT,
          anonymousCookie: anonId
        })

        // Step 2: product_view (20)
        if (i <= 20) {
          await recordFunnelEvent(deps, {
            event: {
              name: 'product_view',
              occurredAt: '2026-10-29T10:05:00Z',
              device: 'desktop',
              source: 'organic',
              segment: 'anonymous',
              targetId: 'prod-1'
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: anonId
          })
        }

        // Step 3: cart_add (10)
        if (i <= 10) {
          await recordFunnelEvent(deps, {
            event: {
              name: 'cart_add',
              occurredAt: '2026-10-29T10:10:00Z',
              device: 'desktop',
              source: 'organic',
              segment: 'anonymous',
              targetId: 'prod-1'
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: anonId
          })
        }

        // Step 4: checkout_start (6)
        if (i <= 6) {
          await recordFunnelEvent(deps, {
            event: {
              name: 'checkout_start',
              occurredAt: '2026-10-29T10:15:00Z',
              device: 'desktop',
              source: 'organic',
              segment: 'anonymous'
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: anonId
          })
        }

        // Step 5: purchase (4)
        if (i <= 4) {
          await recordFunnelEvent(deps, {
            event: {
              name: 'purchase',
              occurredAt: '2026-10-29T10:20:00Z',
              device: 'desktop',
              source: 'organic',
              segment: 'anonymous',
              targetId: 'ord-1'
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: anonId
          })
        }
      }

      const query: FunnelAnalyticsDashboardQuery = {
        from: '2026-10-29T00:00:00Z',
        to: '2026-10-29T23:59:59Z',
        device: 'all',
        source: 'all',
        segment: 'all'
      }

      const dashboard = await readFunnelAnalyticsDashboard(deps, CLAIMS, query)

      expect(dashboard.steps).toHaveLength(5)
      const [visit, view, cart, checkout, purchase] = dashboard.steps

      expect(visit.step).toBe('visit')
      expect(visit.sessions).toBe(40)
      expect(visit.hasSufficientSample).toBe(true) // 40 >= 30

      expect(view.step).toBe('product_view')
      expect(view.sessions).toBe(20)
      expect(view.conversionFromPrevious.rate).toBeCloseTo(0.5, 2)
      // Wilson CI is present and valid
      expect(view.conversionFromPrevious.lower).toBeGreaterThan(0.3)
      expect(view.conversionFromPrevious.upper).toBeLessThan(0.7)
      // View sessions = 20 (< 30) -> sample warning
      expect(view.hasSufficientSample).toBe(false)
      expect(view.isSmallSampleWarning).toBe(true)

      expect(cart.step).toBe('cart_add')
      expect(cart.sessions).toBe(10)
      expect(cart.conversionFromPrevious.rate).toBeCloseTo(0.5, 2)

      expect(checkout.step).toBe('checkout_start')
      expect(checkout.sessions).toBe(6)
      expect(checkout.conversionFromPrevious.rate).toBeCloseTo(0.6, 2)

      expect(purchase.step).toBe('purchase')
      expect(purchase.sessions).toBe(4)
      expect(purchase.conversionFromPrevious.rate).toBeCloseTo(4 / 6, 2)

      // Overall conversion (visit -> purchase): 4 / 40 = 10%
      expect(dashboard.overallConversion.rate).toBeCloseTo(0.1, 2)
      expect(dashboard.overallConversion.lower).toBeGreaterThan(0.02)
      expect(dashboard.overallConversion.upper).toBeLessThan(0.25)
    })

    it('filters funnel by device, source and segment', async () => {
      const fixture = await setupFunnelFixture({ now: '2026-10-29T12:00:00Z' })
      const { deps } = fixture

      // Desktop / Organic / Professional
      await recordFunnelEvent(deps, {
        event: {
          name: 'visit',
          occurredAt: '2026-10-29T11:00:00Z',
          device: 'desktop',
          source: 'organic',
          segment: 'professional'
        },
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: '20000000-0000-4000-8000-000000000001'
      })

      // Mobile / CPC / Customer
      await recordFunnelEvent(deps, {
        event: {
          name: 'visit',
          occurredAt: '2026-10-29T11:00:00Z',
          device: 'mobile',
          source: 'cpc',
          segment: 'customer'
        },
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: '20000000-0000-4000-8000-000000000002'
      })

      // Filter by mobile
      const mobileRes = await readFunnelAnalyticsDashboard(deps, CLAIMS, {
        from: '2026-10-29T00:00:00Z',
        to: '2026-10-29T23:59:59Z',
        device: 'mobile'
      })
      expect(mobileRes.steps[0].sessions).toBe(1)

      // Filter by desktop
      const desktopRes = await readFunnelAnalyticsDashboard(deps, CLAIMS, {
        from: '2026-10-29T00:00:00Z',
        to: '2026-10-29T23:59:59Z',
        device: 'desktop'
      })
      expect(desktopRes.steps[0].sessions).toBe(1)

      // Filter by tablet -> 0
      const tabletRes = await readFunnelAnalyticsDashboard(deps, CLAIMS, {
        from: '2026-10-29T00:00:00Z',
        to: '2026-10-29T23:59:59Z',
        device: 'tablet'
      })
      expect(tabletRes.steps[0].sessions).toBe(0)
    })
  })

  describe('HTTP endpoint authorization and CSRF', () => {
    it('handles unauthorized and CSRF rejections', async () => {
      const fixture = await setupFunnelFixture()
      const { deps } = fixture

      const httpDeps: AnalyticsHttpDependencies = {
        ...deps,
        sessionCookieConfiguration: { password: 'session-secret-password-32-chars-long!', maxAgeSeconds: 3600 }
      }

      // Unauthenticated admin GET
      const unauthReq = new Request('https://analytics-fixture.neteco.test/api/admin/analytics/funnel', {
        method: 'GET',
        headers: { Origin: 'https://analytics-fixture.neteco.test' }
      })
      const unauthRes = await handleFunnelAnalyticsHttp(unauthReq, httpDeps)
      expect(unauthRes?.status).toBe(401)

      // Cross-origin CSRF rejected
      const csrfReq = new Request('https://analytics-fixture.neteco.test/api/admin/analytics/funnel', {
        method: 'GET',
        headers: { 'Sec-Fetch-Site': 'cross-site' }
      })
      const csrfRes = await handleFunnelAnalyticsHttp(csrfReq, httpDeps)
      expect(csrfRes?.status).toBe(403)
    })
  })
})
