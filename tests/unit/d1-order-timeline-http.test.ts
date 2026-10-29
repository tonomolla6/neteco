import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleOrderTimelineHttp } from '../../workers/catalog/order-timeline-http'
import { deterministicTestData } from '../fixtures/deterministic'
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, customerCookie: string, adminCookie: string
const origin = 'https://neteco.invalid',
  configuration = { password: 'synthetic-order-timeline-cookie-password-32', maxAgeSeconds: 3600 }
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(deterministicTestData('timeline-http', '2026-10-08T12:00:00Z').date())
  f = await returnsFixture()
  orderId = await f.order({ paid: false, delivered: false })
  customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
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
  rateLimitPepper: 'synthetic-timeline-pepper-over-32',
  appEnvironment: 'local' as const,
  now: () => utc()
})
const request = (
  audience: 'customer' | 'admin' = 'customer',
  query = '',
  cookie = audience === 'admin' ? adminCookie : customerCookie
) =>
  new Request(origin + `/api/${audience === 'admin' ? 'admin/' : ''}orders/${orderId}/timeline` + query, {
    headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.99' }
  })
describe('private order timeline HTTP', () => {
  it.each(['customer', 'admin'] as const)('serves actual %s checkout without writes or cookies', async (audience) => {
    const before = f.sqlite.prepare('SELECT total_changes() n').get(),
      response = await handleOrderTimelineHttp(request(audience, '?limit=5'), deps())
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({
      source: 'cloudflare',
      orderId,
      audience,
      items: [{ kind: 'checkout', state: 'created' }]
    })
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('set-cookie')).toBeNull()
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it.each([
    '?limit=0',
    '?limit=21',
    '?limit=01',
    '?limit=2&limit=2',
    '?cursor=bad',
    '?cursor=',
    '?cursor=a&cursor=b',
    '?now=2099',
    '?asOf=2099'
  ])('rejects invalid query %s', async (query) => {
    expect((await handleOrderTimelineHttp(request('customer', query), deps()))?.status).toBe(400)
  })
  it('rejects missing cookie, foreign active owner and revoked session uniformly', async () => {
    expect((await handleOrderTimelineHttp(request('customer', '', ''), deps()))?.status).toBe(401)
    const foreign = await f.order({ owned: false, paid: false, delivered: false })
    const response = await handleOrderTimelineHttp(
      new Request(origin + `/api/orders/${foreign}/timeline`, {
        headers: { Cookie: customerCookie, 'CF-Connecting-IP': '192.0.2.99' }
      }),
      deps()
    )
    expect(response?.status).toBe(404)
    expect(await response!.json()).toEqual({ error: { code: 'not_found' } })
    f.sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'")
    expect((await handleOrderTimelineHttp(request(), deps()))?.status).toBe(401)
  })
  it('requires admin current grant and MFA; does not require customer MFA', async () => {
    expect((await handleOrderTimelineHttp(request('admin', '', customerCookie), deps()))?.status).toBe(403)
    expect((await handleOrderTimelineHttp(request(), deps()))?.status).toBe(200)
    f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    expect((await handleOrderTimelineHttp(request('admin'), deps()))?.status).toBe(403)
  })
  it('rejects cross-site contexts and fails closed on unavailable edge/SQL', async () => {
    const cross = request()
    cross.headers.set('Origin', 'https://evil.invalid')
    expect((await handleOrderTimelineHttp(cross, deps()))?.status).toBe(403)
    expect(
      (
        await handleOrderTimelineHttp(request(), {
          ...deps(),
          edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
        })
      )?.status
    ).toBe(429)
    const unavailable = await handleOrderTimelineHttp(request(), {
      ...deps(),
      edgeLimiter: {
        limit: async () => {
          throw new Error('private')
        }
      } as unknown as RateLimit
    })
    expect(unavailable?.status).toBe(503)
    expect(await unavailable!.json()).toEqual({ error: { code: 'unavailable' } })
    vi.spyOn(f.database, 'prepare').mockImplementation(() => {
      throw new Error('private SQL payload')
    })
    expect(await (await handleOrderTimelineHttp(request(), deps()))!.json()).toEqual({ error: { code: 'unavailable' } })
  })
  it.each(['customer', 'admin'] as const)(
    'owns exact GET %s only and rejects POST before DB/auth',
    async (audience) => {
      const prepare = vi.spyOn(f.database, 'prepare'),
        url = request(audience).url
      const response = await handleOrderTimelineHttp(new Request(url, { method: 'POST' }), deps())
      expect(response?.status).toBe(405)
      expect(response!.headers.get('allow')).toBe('GET')
      expect(prepare).not.toHaveBeenCalled()
      expect(await handleOrderTimelineHttp(new Request(url + '/extra'), deps())).toBeNull()
    }
  )
})
