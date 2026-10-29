import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { customer360Fixture } from './customer-360-fixture'
import { handleCustomer360Http, ownsCustomer360Namespace } from '../../workers/support/customer-360-http'
describe('CUS017 readonly HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof customer360Fixture>>
  beforeEach(async () => {
    f = await customer360Fixture()
  })
  afterEach(() => f.sqlite.close())
  async function call(
    path: string,
    overrides: Partial<Parameters<typeof handleCustomer360Http>[1]> = {},
    headers: Record<string, string> = {},
    method = 'GET'
  ) {
    return (await handleCustomer360Http(
      new Request(f.deps.origin + path, {
        method,
        headers: { cookie: f.adminCookie, origin: f.deps.origin, ...headers }
      }),
      {
        database: f.database,
        origin: f.deps.origin,
        sessionCookieConfiguration: f.deps.sessionCookieConfiguration,
        rateLimitPepper: f.deps.contactPepper,
        edgeGate: async () => 'allowed',
        ...overrides
      }
    ))!
  }
  it('reads actual scoped customer context and minimized picker without mutations', async () => {
    const before = f.economic()
    const response = await call(`/api/admin/customer-context/${f.customerId}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'cloudflare', customer: { id: f.customerId } })
    const list = await call('/api/admin/customer-context?page=1&perPage=25')
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(f.economic()).toEqual(before)
  })
  it('enforces edge quota before cookies or database reads', async () => {
    let reads = 0
    const db = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare')
          return () => {
            reads++
            throw new Error('must-not-read')
          }
        return Reflect.get(target, key)
      }
    })
    const response = await call(
      `/api/admin/customer-context/${f.customerId}`,
      { database: db, edgeGate: async () => 'limited' },
      { cookie: 'invalid' }
    )
    expect(response.status).toBe(429)
    expect(reads).toBe(0)
  })
  it('rejects cross-site and unauthenticated access without exposing customer existence', async () => {
    expect(
      (await call(`/api/admin/customer-context/${f.customerId}`, {}, { origin: 'https://evil.invalid' })).status
    ).toBe(403)
    expect((await call(`/api/admin/customer-context/${f.customerId}`, {}, { cookie: '' })).status).toBe(401)
  })
  it('consumes encoded/case aliases failclosed and rejects methods and duplicate query fields', async () => {
    for (const path of ['/API/admin/customer-context', '/api/admin/%63ustomer-context']) {
      expect(ownsCustomer360Namespace(path)).toBe(true)
      expect((await call(path)).status).toBe(404)
    }
    expect((await call('/api/admin/customer-context', {}, {}, 'POST')).status).toBe(405)
    expect((await call('/api/admin/customer-context?page=1&page=2')).status).toBe(422)
  })
  it('returns opaque 503 for database outages rather than a successful empty snapshot', async () => {
    const db = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare')
          return () => {
            throw new Error('private-database-detail')
          }
        return Reflect.get(target, key)
      }
    })
    const response = await call(`/api/admin/customer-context/${f.customerId}`, { database: db })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-database-detail')
  })
})
