import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, ANALYTICS_CONSENT, CLAIMS, utc } from './d1-analytics-fixture'
import {
  redactSearchPii,
  sanitizeSearchQuery,
  recordSearchEvent,
  readSearchAnalyticsDashboard,
  type SearchEventInput
} from '../../workers/analytics/search-analytics'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

async function searchAnalyticsFixture(options: { now?: string } = {}) {
  const world = await analyticsFixture()
  connections.push(world.sqlite)

  // Apply 0095_search_analytics.sql migration
  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0095_search_analytics.sql', import.meta.url),
    'utf8'
  )
  world.sqlite.exec(migrationSql)

  if (options.now) {
    world.setNow(options.now)
  }

  return world
}

describe('SEA-012 search analytics domain and daily aggregation', () => {
  describe('PII redaction and query normalization', () => {
    it('normalizes spaces and trims query', () => {
      expect(sanitizeSearchQuery('   desengrasante    industrial   ')).toBe('desengrasante industrial')
    })

    it('truncates queries exceeding 160 characters', () => {
      const longQuery = 'detergente '.repeat(25)
      const sanitized = sanitizeSearchQuery(longQuery)
      expect(sanitized.length).toBeLessThanOrEqual(160)
    })

    it('redacts email addresses from search queries', () => {
      const query = 'pedido de cliente@ejemplo.com urgente'
      const redacted = redactSearchPii(query)
      expect(redacted).toBe('pedido de [REDACTADO] urgente')
      expect(sanitizeSearchQuery(query)).toBe('pedido de [REDACTADO] urgente')
    })

    it('redacts Spanish phone numbers with or without prefix and spaces', () => {
      expect(redactSearchPii('contacto 612345678')).toBe('contacto [REDACTADO]')
      expect(redactSearchPii('llamada +34 912 345 678')).toBe('llamada [REDACTADO]')
      expect(redactSearchPii('urgente 712 34 56 78')).toBe('urgente [REDACTADO]')
    })

    it('redacts Spanish NIF / NIE / CIF identifiers', () => {
      expect(redactSearchPii('factura 12345678Z')).toBe('factura [REDACTADO]')
      expect(redactSearchPii('empresa B12345678')).toBe('empresa [REDACTADO]')
      expect(redactSearchPii('residente Y1234567X')).toBe('residente [REDACTADO]')
    })

    it('leaves standard product and chemical names without PII untouched', () => {
      const clean = 'lejía neutra 5L desengrasante ph neutro'
      expect(redactSearchPii(clean)).toBe(clean)
      expect(sanitizeSearchQuery(clean)).toBe(clean)
    })
  })

  describe('consent and event collection', () => {
    it('rejects recording search events when analytics consent is absent', async () => {
      const world = await searchAnalyticsFixture()
      const event: SearchEventInput = {
        name: 'search_performed',
        query: 'desengrasante',
        resultCount: 5,
        device: 'desktop',
        segment: 'customer',
        occurredAt: utc()
      }

      const result = await recordSearchEvent(world.deps, {
        event,
        consentCookie: JSON.stringify({ version: 'v1', analytics: false })
      })

      expect(result).toMatchObject({ accepted: false, reason: 'consent_required' })
      const count = world.sqlite.prepare('SELECT count(*) as cnt FROM analytics_search_events').get() as { cnt: number }
      expect(count.cnt).toBe(0)
    })

    it('records search_performed event and derives anonymous session hash', async () => {
      const world = await searchAnalyticsFixture()
      const event: SearchEventInput = {
        name: 'search_performed',
        query: 'lejía desinfectante',
        resultCount: 8,
        device: 'desktop',
        segment: 'anonymous',
        occurredAt: utc()
      }

      const result = await recordSearchEvent(world.deps, {
        event,
        consentCookie: ANALYTICS_CONSENT
      })

      expect(result).toMatchObject({ accepted: true, reason: 'accepted' })
      expect(result.cookie).not.toBeNull()

      const row = world.sqlite
        .prepare('SELECT name, term_normalized, result_count, device, segment FROM analytics_search_events')
        .get() as Record<string, unknown>

      expect(row).toMatchObject({
        name: 'search_performed',
        term_normalized: 'lejía desinfectante',
        result_count: 8,
        device: 'desktop',
        segment: 'anonymous'
      })
    })

    it('enforces immutability on analytics_search_events', async () => {
      const world = await searchAnalyticsFixture()
      const event: SearchEventInput = {
        name: 'search_performed',
        query: 'desengrasante',
        resultCount: 3,
        device: 'desktop',
        segment: 'customer',
        occurredAt: utc()
      }

      await recordSearchEvent(world.deps, { event, consentCookie: ANALYTICS_CONSENT })

      expect(() => {
        world.sqlite.exec("UPDATE analytics_search_events SET term_normalized = 'hacked'")
      }).toThrow(/analytics_event_immutable/)

      expect(() => {
        world.sqlite.exec('DELETE FROM analytics_search_events')
      }).toThrow(/analytics_event_immutable/)
    })
  })

  describe('session attribution', () => {
    it('attributes search_result_clicked and add_to_cart to the same analytics session', async () => {
      const world = await searchAnalyticsFixture()
      const searchAt = utc(-60000)
      const clickAt = utc(-30000)
      const cartAt = utc(-10000)

      // 1. Visitor searches for 'fregasuelos'
      const searchRes = await recordSearchEvent(world.deps, {
        event: {
          name: 'search_performed',
          query: 'fregasuelos aroma pino',
          resultCount: 4,
          device: 'mobile',
          segment: 'customer',
          occurredAt: searchAt
        },
        consentCookie: ANALYTICS_CONSENT
      })

      const sessionId = searchRes.cookie!.value

      // 2. Visitor clicks a result in the same session
      const clickRes = await recordSearchEvent(world.deps, {
        event: {
          name: 'search_result_clicked',
          targetId: 'prod-fregasuelos-1',
          rank: 1,
          device: 'mobile',
          segment: 'customer',
          occurredAt: clickAt
        },
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: sessionId
      })
      expect(clickRes.accepted).toBe(true)

      // 3. Visitor adds the product to cart in the same session
      const cartRes = await recordSearchEvent(world.deps, {
        event: {
          name: 'add_to_cart',
          targetId: 'prod-fregasuelos-1',
          quantity: 2,
          device: 'mobile',
          segment: 'customer',
          occurredAt: cartAt
        },
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: sessionId
      })
      expect(cartRes.accepted).toBe(true)

      // Check all three events recorded with same attributed term
      const rows = world.sqlite
        .prepare('SELECT name, term_normalized, rank, quantity FROM analytics_search_events ORDER BY occurred_at ASC')
        .all() as Array<{ name: string; term_normalized: string; rank: number | null; quantity: number | null }>

      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatchObject({ name: 'search_performed', term_normalized: 'fregasuelos aroma pino' })
      expect(rows[1]).toMatchObject({
        name: 'search_result_clicked',
        term_normalized: 'fregasuelos aroma pino',
        rank: 1
      })
      expect(rows[2]).toMatchObject({ name: 'add_to_cart', term_normalized: 'fregasuelos aroma pino', quantity: 2 })
    })
  })

  describe('D1 daily aggregation and minimum sample threshold', () => {
    it('aggregates daily searches, zero results, clicks, and add_to_cart via triggers', async () => {
      const world = await searchAnalyticsFixture()
      const today = utc().slice(0, 10)

      // Seed 25 searches for "desengrasante" (sufficient sample >= 20)
      for (let i = 0; i < 25; i++) {
        const searchRes = await recordSearchEvent(world.deps, {
          event: {
            name: 'search_performed',
            query: 'desengrasante',
            resultCount: 5,
            device: 'desktop',
            segment: 'customer',
            occurredAt: utc(i * 100)
          },
          consentCookie: ANALYTICS_CONSENT
        })

        // 10 clicks
        if (i < 10) {
          await recordSearchEvent(world.deps, {
            event: {
              name: 'search_result_clicked',
              targetId: 'prod-des-1',
              rank: 1,
              device: 'desktop',
              segment: 'customer',
              occurredAt: utc(i * 100 + 10)
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: searchRes.cookie?.value
          })
        }

        // 5 add to cart
        if (i < 5) {
          await recordSearchEvent(world.deps, {
            event: {
              name: 'add_to_cart',
              targetId: 'prod-des-1',
              quantity: 1,
              device: 'desktop',
              segment: 'customer',
              occurredAt: utc(i * 100 + 20)
            },
            consentCookie: ANALYTICS_CONSENT,
            anonymousCookie: searchRes.cookie?.value
          })
        }
      }

      // Seed 5 searches for "quimico desconocido" with 0 results (< 20 threshold)
      for (let i = 0; i < 5; i++) {
        await recordSearchEvent(world.deps, {
          event: {
            name: 'search_performed',
            query: 'quimico desconocido',
            resultCount: 0,
            device: 'desktop',
            segment: 'customer',
            occurredAt: utc(i * 100)
          },
          consentCookie: ANALYTICS_CONSENT
        })
      }

      // Check daily aggregates table
      const dailyRows = world.sqlite
        .prepare(
          'SELECT term_normalized, searches_count, zero_results_count, clicks_count, add_to_cart_count FROM search_analytics_daily'
        )
        .all() as Array<{
        term_normalized: string
        searches_count: number
        zero_results_count: number
        clicks_count: number
        add_to_cart_count: number
      }>

      expect(dailyRows).toContainEqual({
        term_normalized: 'desengrasante',
        searches_count: 25,
        zero_results_count: 0,
        clicks_count: 10,
        add_to_cart_count: 5
      })

      expect(dailyRows).toContainEqual({
        term_normalized: 'quimico desconocido',
        searches_count: 5,
        zero_results_count: 5,
        clicks_count: 0,
        add_to_cart_count: 0
      })

      // Query dashboard
      const dashboard = await readSearchAnalyticsDashboard(world.deps, CLAIMS, {
        from: `${today}T00:00:00Z`,
        to: `${today}T23:59:59Z`,
        device: 'all',
        segment: 'all'
      })

      expect(dashboard.summary.totalSearches).toBe(30)
      expect(dashboard.summary.totalZeroResults).toBe(5)
      expect(dashboard.summary.totalClicks).toBe(10)
      expect(dashboard.summary.totalAddToCart).toBe(5)
      expect(dashboard.summary.globalCtr).toBeCloseTo(10 / 30, 2)
      expect(dashboard.summary.globalAddToCartRate).toBeCloseTo(5 / 30, 2)

      // Check "desengrasante" (searches >= 20 -> sample sufficient, rates shown)
      const desItem = dashboard.topQueries.find((q) => q.term === 'desengrasante')
      expect(desItem).toBeDefined()
      expect(desItem!.hasSufficientSample).toBe(true)
      expect(desItem!.ctr).toBeCloseTo(10 / 25, 2)
      expect(desItem!.addToCartRate).toBeCloseTo(5 / 25, 2)

      // Check "quimico desconocido" (searches = 5 < 20 -> rates suppressed)
      const zeroItem = dashboard.topQueries.find((q) => q.term === 'quimico desconocido')
      expect(zeroItem).toBeDefined()
      expect(zeroItem!.hasSufficientSample).toBe(false)
      expect(zeroItem!.ctr).toBeNull()
      expect(zeroItem!.addToCartRate).toBeNull()

      // Check zero results list includes links
      const zeroQuery = dashboard.zeroResultQueries.find((q) => q.term === 'quimico desconocido')
      expect(zeroQuery).toBeDefined()
      expect(zeroQuery!.synonymUrl).toContain('/admin/busqueda')
      expect(zeroQuery!.merchandisingUrl).toContain('/admin/busqueda')
    })

    it('filters metrics by device and customer segment', async () => {
      const world = await searchAnalyticsFixture()
      const today = utc().slice(0, 10)

      // Insert 22 searches on mobile / professional
      for (let i = 0; i < 22; i++) {
        await recordSearchEvent(world.deps, {
          event: {
            name: 'search_performed',
            query: 'hipoclorito 25l',
            resultCount: 2,
            device: 'mobile',
            segment: 'professional',
            occurredAt: utc(i * 10)
          },
          consentCookie: ANALYTICS_CONSENT
        })
      }

      // Filter by desktop (should be 0)
      const desktopDashboard = await readSearchAnalyticsDashboard(world.deps, CLAIMS, {
        from: `${today}T00:00:00Z`,
        to: `${today}T23:59:59Z`,
        device: 'desktop',
        segment: 'all'
      })
      expect(desktopDashboard.summary.totalSearches).toBe(0)

      // Filter by mobile + professional
      const mobileProDashboard = await readSearchAnalyticsDashboard(world.deps, CLAIMS, {
        from: `${today}T00:00:00Z`,
        to: `${today}T23:59:59Z`,
        device: 'mobile',
        segment: 'professional'
      })
      expect(mobileProDashboard.summary.totalSearches).toBe(22)
      expect(mobileProDashboard.topQueries[0]!.term).toBe('hipoclorito 25l')
      expect(mobileProDashboard.topQueries[0]!.hasSufficientSample).toBe(true)
    })
  })
})
