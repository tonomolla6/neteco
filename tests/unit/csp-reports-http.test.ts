import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { d1OverSqlite } from '../support/d1-sqlite'
import {
  handleCspReportHttp,
  ownsCspReportNamespace,
  sanitizeReportPath,
  sanitizeBlockedUri,
  parseCspReportPayload,
  resetCspRateLimiterForTest
} from '../../workers/security/csp-report-http'

describe('SEC-034: CSP Violation Reporting Endpoint & Aggregation', () => {
  let sqliteDb: DatabaseSync
  let d1Db: D1Database
  let env: CloudflareEnv

  beforeEach(async () => {
    resetCspRateLimiterForTest()
    sqliteDb = new DatabaseSync(':memory:')
    sqliteDb.exec('PRAGMA foreign_keys = ON')

    const migrationPath = fileURLToPath(
      new URL('../../db/d1/migrations/0100_csp_violation_reports.sql', import.meta.url)
    )
    const sql = await readFile(migrationPath, 'utf8')
    sqliteDb.exec(sql)

    d1Db = d1OverSqlite(sqliteDb)
    env = {
      APP_ENV: 'test',
      DB: d1Db,
      AUTH_RATE_LIMIT_PEPPER: 'test-pepper-minimum-32-chars-long-for-rate-limiting'
    } as unknown as CloudflareEnv
  })

  describe('Namespace routing', () => {
    it.each([
      ['/api/security/csp-reports', true],
      ['/api/csp-report', true],
      ['/api/security/csp-reports/', true],
      ['/api/csp-report/', true],
      ['/%61pi/security/csp-reports', true],
      ['/api/security/other', false],
      ['/api/orders', false],
      ['/contacto', false]
    ])('classifies %s as %s', (path, expected) => {
      expect(ownsCspReportNamespace(path)).toBe(expected)
    })
  })

  describe('PII Sanitization helpers', () => {
    it('strips query parameters, credentials, and fragments from document URIs', () => {
      expect(sanitizeReportPath('https://neteco.es/pedido/12345?token=secret123#step2')).toBe('/pedido/12345')
      expect(sanitizeReportPath('https://user:pass@neteco.es/checkout?email=test@example.com')).toBe('/checkout')
      expect(sanitizeReportPath('/cuenta/seguridad?resetToken=abc')).toBe('/cuenta/seguridad')
      expect(sanitizeReportPath('invalid-uri')).toBe('/invalid-uri')
    })

    it('strips query strings and fragments from blocked URIs', () => {
      expect(sanitizeBlockedUri('https://evil.com/tracker.js?uid=12345&session=abc#fragment')).toBe(
        'https://evil.com/tracker.js'
      )
      expect(sanitizeBlockedUri('http://tracker.net/pixel.gif?track=1')).toBe('http://tracker.net/pixel.gif')
    })

    it('sanitizes data: and blob: URIs without payload', () => {
      expect(sanitizeBlockedUri('data:application/javascript;base64,YWxlcnQoMSk=')).toBe('data:')
      expect(sanitizeBlockedUri('blob:https://neteco.es/1234-5678-abcd')).toBe('blob:')
    })

    it('preserves eval and inline designations', () => {
      expect(sanitizeBlockedUri('eval')).toBe('eval')
      expect(sanitizeBlockedUri('inline')).toBe('inline')
    })
  })

  describe('Report payload parsing', () => {
    it('parses legacy csp-report wrapper', () => {
      const payload = {
        'csp-report': {
          'document-uri': 'https://neteco.es/producto/limpiador?token=abc',
          'blocked-uri': 'https://bad.cdn.com/evil.js?v=1',
          'violated-directive': 'script-src-elem',
          'effective-directive': 'script-src',
          disposition: 'report'
        }
      }
      const parsed = parseCspReportPayload(payload)
      expect(parsed).toEqual([
        {
          directive: 'script-src',
          blockedUri: 'https://bad.cdn.com/evil.js',
          route: '/producto/limpiador',
          disposition: 'report',
          sampleOriginalPolicy: null
        }
      ])
    })

    it('parses modern W3C Reporting API list', () => {
      const payload = [
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://neteco.es/catalogo?page=2#top',
            blockedURL: 'https://analytics.thirdparty.com/track.js',
            effectiveDirective: 'script-src',
            disposition: 'enforce'
          }
        }
      ]
      const parsed = parseCspReportPayload(payload)
      expect(parsed).toEqual([
        {
          directive: 'script-src',
          blockedUri: 'https://analytics.thirdparty.com/track.js',
          route: '/catalogo',
          disposition: 'enforce',
          sampleOriginalPolicy: null
        }
      ])
    })
  })

  describe('POST Ingestion & Aggregation in D1', () => {
    it('records a new violation with count 1, returning 204 No Content', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: {
          'content-type': 'application/csp-report',
          'cf-connecting-ip': '192.0.2.1'
        },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://neteco.es/catalogo?query=detergente',
            'blocked-uri': 'https://untrusted.cdn.com/script.js?v=2',
            'effective-directive': 'script-src',
            disposition: 'report'
          }
        })
      })

      const response = await handleCspReportHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(204)
      expect(response!.headers.get('cache-control')).toBe('no-store')

      // Verify aggregation in D1
      const rows = sqliteDb.prepare('SELECT * FROM csp_violation_aggregates').all() as Array<{
        directive: string
        blocked_uri: string
        route: string
        disposition: string
        count: number
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.directive).toBe('script-src')
      expect(rows[0]!.blocked_uri).toBe('https://untrusted.cdn.com/script.js')
      expect(rows[0]!.route).toBe('/catalogo')
      expect(rows[0]!.disposition).toBe('report')
      expect(rows[0]!.count).toBe(1)
    })

    it('aggregates repeated violations: increments count and updates last_seen_at without duplicating rows', async () => {
      const sendReport = async () => {
        const req = new Request('https://neteco.es/api/security/csp-reports', {
          method: 'POST',
          headers: {
            'content-type': 'application/reports+json',
            'cf-connecting-ip': '192.0.2.1'
          },
          body: JSON.stringify([
            {
              type: 'csp-violation',
              body: {
                documentURL: 'https://neteco.es/producto/desengrasante?utm_source=ad',
                blockedURL: 'https://ad-tracker.example/pixel.js?id=999',
                effectiveDirective: 'script-src',
                disposition: 'report'
              }
            }
          ])
        })
        return handleCspReportHttp(req, env)
      }

      await sendReport()
      await sendReport()
      await sendReport()

      const rows = sqliteDb.prepare('SELECT * FROM csp_violation_aggregates').all() as Array<{
        count: number
        route: string
        directive: string
        first_seen_at: string
        last_seen_at: string
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.count).toBe(3)
      expect(rows[0]!.route).toBe('/producto/desengrasante')
      expect(rows[0]!.directive).toBe('script-src')
      expect(rows[0]!.first_seen_at).toBeDefined()
      expect(rows[0]!.last_seen_at).toBeDefined()
    })

    it('creates distinct aggregate rows for different routes or directives', async () => {
      const reportA = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.2' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://neteco.es/catalogo',
            'blocked-uri': 'https://cdn.example/font.woff2',
            'effective-directive': 'font-src',
            disposition: 'report'
          }
        })
      })
      const reportB = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.2' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://neteco.es/carrito',
            'blocked-uri': 'https://cdn.example/font.woff2',
            'effective-directive': 'font-src',
            disposition: 'report'
          }
        })
      })

      await handleCspReportHttp(reportA, env)
      await handleCspReportHttp(reportB, env)

      const rows = sqliteDb.prepare('SELECT * FROM csp_violation_aggregates').all()
      expect(rows).toHaveLength(2)
    })
  })

  describe('Bounded size and validation constraints', () => {
    it('rejects payloads larger than 16 KB with 413 Payload Too Large', async () => {
      const hugeData = 'x'.repeat(17000)
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '17500',
          'cf-connecting-ip': '192.0.2.3'
        },
        body: JSON.stringify({ data: hugeData })
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(413)
      const body = (await response!.json()) as { error: { code: string } }
      expect(body.error.code).toBe('payload_too_large')
    })

    it('rejects unsupported content types with 415', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'cf-connecting-ip': '192.0.2.3'
        },
        body: 'invalid body'
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(415)
    })

    it('rejects malformed JSON with 400 Bad Request', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.3'
        },
        body: '{ not valid json '
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(400)
      const body = (await response!.json()) as { error: { code: string } }
      expect(body.error.code).toBe('invalid_json')
    })
  })

  describe('Rate Limiting', () => {
    it('returns 429 Too Many Requests when IP rate limit is exceeded', async () => {
      const clientIp = '198.51.100.99'
      let lastResponse: Response | null = null

      for (let i = 0; i < 65; i++) {
        const req = new Request('https://neteco.es/api/security/csp-reports', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': clientIp
          },
          body: JSON.stringify({
            'csp-report': {
              'document-uri': 'https://neteco.es/',
              'blocked-uri': 'https://bad.com/js.js',
              'effective-directive': 'script-src',
              disposition: 'report'
            }
          })
        })
        lastResponse = await handleCspReportHttp(req, env)
      }

      expect(lastResponse!.status).toBe(429)
      expect(lastResponse!.headers.get('retry-after')).toBe('60')
      const body = (await lastResponse!.json()) as { error: { code: string } }
      expect(body.error.code).toBe('rate_limited')
    })
  })

  describe('GET Aggregated Violations Listing', () => {
    beforeEach(async () => {
      // Pre-seed some aggregates
      sqliteDb.exec(`
        INSERT INTO csp_violation_aggregates (directive, blocked_uri, route, disposition, count, first_seen_at, last_seen_at)
        VALUES 
          ('script-src', 'https://bad.cdn/1.js', '/catalogo', 'report', 15, '2026-10-29T10:00:00Z', '2026-10-29T10:30:00Z'),
          ('img-src', 'https://bad.cdn/img.png', '/producto/1', 'report', 4, '2026-10-29T09:00:00Z', '2026-10-29T09:15:00Z'),
          ('frame-src', 'https://evil.iframe/x', '/checkout', 'enforce', 2, '2026-10-29T08:00:00Z', '2026-10-29T08:05:00Z');
      `)
    })

    it('lists all aggregates sorted by last_seen_at desc', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'GET'
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(200)
      const data = (await response!.json()) as { items: Array<{ directive: string; count: number }>; total: number }
      expect(data.total).toBe(3)
      expect(data.items[0]!.directive).toBe('script-src')
      expect(data.items[0]!.count).toBe(15)
    })

    it('filters aggregates by directive or route', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports?directive=img-src', {
        method: 'GET'
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(200)
      const data = (await response!.json()) as { items: Array<{ directive: string }>; total: number }
      expect(data.total).toBe(1)
      expect(data.items[0]!.directive).toBe('img-src')
    })

    it('rejects unsupported methods with 405 Method Not Allowed', async () => {
      const request = new Request('https://neteco.es/api/security/csp-reports', {
        method: 'DELETE'
      })

      const response = await handleCspReportHttp(request, env)
      expect(response!.status).toBe(405)
      expect(response!.headers.get('allow')).toBe('GET, POST')
    })
  })
})
