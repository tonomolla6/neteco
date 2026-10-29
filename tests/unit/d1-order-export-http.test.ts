import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleOrderExportHttp } from '../../workers/catalog/order-export-http'
import {
  ORDER_EXPORT_COLUMNS,
  ORDER_EXPORT_CONTENT_TYPE,
  ORDER_EXPORT_FILENAME,
  verifyOrderExportCsv
} from '../../shared/order-export'
const data = deterministicTestData('order-export-http', '2026-10-08T12:00:00Z')
const origin = 'https://export.neteco.test',
  configuration = { password: 'synthetic-order-export-cookie-password-32', maxAgeSeconds: 3600 }
let f: Awaited<ReturnType<typeof returnsFixture>>, cookie: string, customerCookie: string
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  f = await returnsFixture()
  f.sqlite.function('export_test_clock', () => utc())
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'export_test_clock()'))
  await f.order({ paid: false, delivered: false })
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
  customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: configuration,
  origin,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-order-export-pepper-over-32',
  now: () => utc()
})
const request = (query = '', method = 'GET') =>
  new Request(origin + '/api/admin/orders/export.csv' + query, {
    method,
    headers: { cookie, origin, 'cf-connecting-ip': '192.0.2.99' }
  })
describe('bounded private order export HTTP', () => {
  it('downloads a complete real filtered CSV with strict metadata and no cookie or writes', async () => {
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const response = await handleOrderExportHttp(request('?sortKey=id&sortDir=asc'), deps())
    expect(response?.status).toBe(200)
    expect(response!.headers.get('content-type')).toBe(ORDER_EXPORT_CONTENT_TYPE)
    expect(response!.headers.get('content-disposition')).toBe(`attachment; filename="${ORDER_EXPORT_FILENAME}"`)
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('set-cookie')).toBeNull()
    const bytes = new Uint8Array(await response!.arrayBuffer())
    verifyOrderExportCsv(bytes, {
      source: 'cloudflare',
      rows: Number(response!.headers.get('X-Neteco-Export-Rows')),
      bytes: Number(response!.headers.get('X-Neteco-Export-Bytes'))
    })
    expect(response!.headers.get('X-Neteco-Export-Source')).toBe('cloudflare')
    expect(new TextDecoder().decode(bytes)).toContain(ORDER_EXPORT_COLUMNS.map((column) => `"${column}"`).join(','))
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('rejects non-GET before any database reads and ignores unrelated paths', async () => {
    const prepare = vi.spyOn(f.database, 'prepare')
    const denied = await handleOrderExportHttp(request('', 'POST'), deps())
    expect(denied?.status).toBe(405)
    expect(denied!.headers.get('allow')).toBe('GET')
    expect(prepare).not.toHaveBeenCalled()
    expect(await handleOrderExportHttp(new Request(origin + '/api/products'), deps())).toBeNull()
  })
  it.each(['?page=1', '?perPage=100', '?q=x&q=x', '?carrier=unknown', '?sortDir=DROP', '?from=2026-02-31'])(
    'rejects invalid or unsupported query %s without CSV',
    async (query) => {
      const response = await handleOrderExportHttp(request(query), deps())
      expect(response?.status).toBe(400)
      expect(await response!.json()).toEqual({ error: { code: 'invalid_input' } })
      expect(response!.headers.get('content-disposition')).toBeNull()
    }
  )
  it('requires sealed current admin cookie, verified email, MFA and grant', async () => {
    const missing = request()
    missing.headers.delete('cookie')
    expect((await handleOrderExportHttp(missing, deps()))?.status).toBe(401)
    const customer = request()
    customer.headers.set('cookie', customerCookie)
    expect((await handleOrderExportHttp(customer, deps()))?.status).toBe(403)
    f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
    expect((await handleOrderExportHttp(request(), deps()))?.status).toBe(403)
  })
  it('rejects explicit foreign Origin/cross-site before auth or D1 and accepts same-origin GET without Origin', async () => {
    for (const header of ['origin', 'sec-fetch-site']) {
      const req = request()
      req.headers.set(header, header === 'origin' ? 'https://foreign.invalid' : 'cross-site')
      const prepare = vi.spyOn(f.database, 'prepare')
      expect((await handleOrderExportHttp(req, deps()))?.status).toBe(403)
      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
    }
    const same = request()
    same.headers.delete('origin')
    expect((await handleOrderExportHttp(same, deps()))?.status).toBe(200)
  })
  it('fails closed for edge denial or infrastructure errors without leaking private data', async () => {
    expect(
      (
        await handleOrderExportHttp(request(), {
          ...deps(),
          edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
        })
      )?.status
    ).toBe(429)
    vi.spyOn(f.database, 'prepare').mockImplementation(() => {
      throw new Error('private SQL token')
    })
    const failed = await handleOrderExportHttp(request(), deps())
    expect(failed?.status).toBe(503)
    expect(await failed!.json()).toEqual({ error: { code: 'unavailable' } })
    expect(failed!.headers.get('cache-control')).toBe('private, no-store')
  })
})
