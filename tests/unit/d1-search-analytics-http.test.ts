import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, ANALYTICS_CONSENT, CLAIMS, utc } from './d1-analytics-fixture'
import { handleSearchAnalyticsHttp } from '../../workers/analytics/search-analytics-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

const PASSWORD = 'fixture-session-password-must-be-32-chars-long!!'
const COOKIE_CONFIG = { password: PASSWORD, maxAgeSeconds: 3600 }

async function httpFixture() {
  const world = await analyticsFixture()
  connections.push(world.sqlite)

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0095_search_analytics.sql', import.meta.url),
    'utf8'
  )
  world.sqlite.exec(migrationSql)

  const cookieHeader = async (claims = CLAIMS) => {
    const cookie = await issueD1SessionCookie(world.deps.database, claims, COOKIE_CONFIG)
    return cookie ? cookie.split(';')[0] : ''
  }

  const deps = {
    ...world.deps,
    sessionCookieConfiguration: COOKIE_CONFIG,
    edgeGate: async () => 'allowed' as const
  }

  return { ...world, deps, cookieHeader }
}

describe('SEA-012 search analytics HTTP endpoints', () => {
  describe('event collection endpoint (POST /api/analytics/events)', () => {
    it('returns 403 consent_required when consent cookie is missing', async () => {
      const { deps } = await httpFixture()
      const req = new Request('https://analytics-fixture.neteco.test/api/analytics/events', {
        method: 'POST',
        headers: {
          origin: deps.origin,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'search_performed',
          query: 'desengrasante',
          resultCount: 5,
          device: 'desktop',
          segment: 'anonymous',
          occurredAt: utc()
        })
      })

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(403)
      const data = (await res!.json()) as { error: { code: string } }
      expect(data.error.code).toBe('consent_required')
    })

    it('returns 202 accepted with cookie instruction on valid search_performed event', async () => {
      const { deps } = await httpFixture()
      const req = new Request('https://analytics-fixture.neteco.test/api/analytics/events', {
        method: 'POST',
        headers: {
          origin: deps.origin,
          cookie: `neteco-consent-v1=${encodeURIComponent(ANALYTICS_CONSENT)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'search_performed',
          query: 'lejía neutra 5l',
          resultCount: 3,
          device: 'desktop',
          segment: 'customer',
          occurredAt: utc()
        })
      })

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(202)
      const body = (await res!.json()) as { accepted: boolean }
      expect(body.accepted).toBe(true)
      expect(res!.headers.get('set-cookie')).toContain('neteco-analytics-id=')
    })

    it('rejects cross-site CSRF requests with 403 csrf_rejected', async () => {
      const { deps } = await httpFixture()
      const req = new Request('https://analytics-fixture.neteco.test/api/analytics/events', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.invalid',
          cookie: `neteco-consent-v1=${encodeURIComponent(ANALYTICS_CONSENT)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'search_performed',
          query: 'test',
          resultCount: 1,
          occurredAt: utc()
        })
      })

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(403)
    })
  })

  describe('admin dashboard endpoint (GET /api/admin/analytics/search)', () => {
    it('returns 401 unauthenticated when session cookie is missing', async () => {
      const { deps } = await httpFixture()
      const req = new Request(
        'https://analytics-fixture.neteco.test/api/admin/analytics/search?from=2026-10-01T00:00:00Z&to=2026-10-29T23:59:59Z',
        {
          method: 'GET',
          headers: { origin: deps.origin }
        }
      )

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(401)
    })

    it('returns 200 with search metrics dashboard for authorized admin', async () => {
      const { deps, cookieHeader } = await httpFixture()
      const cookie = await cookieHeader(CLAIMS)
      const from = '2026-10-01T00:00:00Z'
      const to = '2026-10-29T23:59:59Z'

      const req = new Request(
        `https://analytics-fixture.neteco.test/api/admin/analytics/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&device=all&segment=all`,
        {
          method: 'GET',
          headers: {
            origin: deps.origin,
            cookie
          }
        }
      )

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)

      const body = (await res!.json()) as {
        summary: { totalSearches: number; totalZeroResults: number }
        minSampleThreshold: number
        topQueries: unknown[]
        zeroResultQueries: unknown[]
      }

      expect(body).toHaveProperty('summary')
      expect(body).toHaveProperty('topQueries')
      expect(body).toHaveProperty('zeroResultQueries')
      expect(body.minSampleThreshold).toBe(20)
    })

    it('returns 405 Method Not Allowed for non-GET methods on admin endpoint', async () => {
      const { deps, cookieHeader } = await httpFixture()
      const cookie = await cookieHeader(CLAIMS)

      const req = new Request('https://analytics-fixture.neteco.test/api/admin/analytics/search', {
        method: 'POST',
        headers: { origin: deps.origin, cookie }
      })

      const res = await handleSearchAnalyticsHttp(req, deps)
      expect(res).not.toBeNull()
      expect(res!.status).toBe(405)
      expect(res!.headers.get('allow')).toBe('GET')
    })
  })
})
