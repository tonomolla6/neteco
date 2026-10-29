import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminReturnsHttp, ownsAdminReturnsNamespace } from '../../workers/returns/admin-http'
import { handleCustomerReturnsHttp, ownsCustomerReturnsNamespace } from '../../workers/returns/customer-http'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, BUYER_SESSION, REQUEST, ADMISSION } from './d1-returns-fixture'

const origin = 'https://returns-fixture.neteco.test',
  password = 'synthetic-custody-returns-cookie-over-32-characters'
describe('native RMA HTTP routes, private ownership and fail-closed boundaries', () => {
  let sqlite: DatabaseSync, database: D1Database, id: string, adminCookie: string, buyerCookie: string
  beforeEach(async () => {
    const fixture = await returnsFixture()
    sqlite = fixture.sqlite
    database = fixture.database
    id = await fixture.order()
    adminCookie = (await issueD1SessionCookie(database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    buyerCookie = (await issueD1SessionCookie(database, BUYER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function env(db = database) {
    return { DB: db, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
  }
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = buyerCookie,
    headers: Record<string, string> = {}
  ) {
    return new Request(origin + path, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'rma-customer-request',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  async function create() {
    const response = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`, 'POST', REQUEST), env())
    expect(response?.status).toBe(201)
    return (await response!.json()) as { publicRef: string }
  }
  function privateHeaders(response: Response | null) {
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(response?.headers.get('vary')).toBe('Cookie')
    expect(response?.headers.get('x-robots-tag')).toContain('noindex')
  }
  it('reads actual budget and executes privately with exact request replay', async () => {
    const read = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`), env())
    expect(read?.status).toBe(200)
    privateHeaders(read)
    const first = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`, 'POST', REQUEST), env()),
      replay = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`, 'POST', REQUEST), env())
    expect(first?.status).toBe(201)
    expect(await replay?.text()).toBe(await first?.text())
    privateHeaders(first)
  })
  it('lists/detail/PUT use administration.manage and documented admission, never money', async () => {
    const receipt = await create(),
      path = `/api/admin/returns/${receipt.publicRef}`
    const list = await handleAdminReturnsHttp(request('/api/admin/returns', 'GET', undefined, adminCookie), env()),
      detail = await handleAdminReturnsHttp(request(path, 'GET', undefined, adminCookie), env())
    expect(list?.status).toBe(200)
    expect(detail?.status).toBe(200)
    privateHeaders(list)
    privateHeaders(detail)
    const changed = await handleAdminReturnsHttp(
      request(path, 'PUT', ADMISSION, adminCookie, { 'idempotency-key': 'admission' }),
      env()
    )
    expect(changed?.status).toBe(200)
    privateHeaders(changed)
    const money = await handleAdminReturnsHttp(
      request(path, 'PUT', { ...ADMISSION, refundAmountCents: 500 }, adminCookie, {
        'idempotency-key': 'money-not-authorized'
      }),
      env()
    )
    expect(money?.status).toBe(422)
  })
  it('blocks guest verification explicitly without revealing any order or RMA facts', async () => {
    for (const method of ['GET', 'POST']) {
      const response = await handleCustomerReturnsHttp(
        request(
          `/api/orders/${id}/returns`,
          method,
          method === 'POST' ? REQUEST : undefined,
          `neteco-order-access-v2=v1.${id}.${'a'.repeat(64)}`
        ),
        env()
      )
      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual({ error: { code: 'guest_verification_required' } })
      privateHeaders(response)
    }
  })
  it('invalid/missing sessions and blocked owners do not produce writable empty state', async () => {
    const none = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`, 'GET', undefined, ''), env())
    expect(none?.status).toBe(401)
    sqlite.exec(`UPDATE auth_sessions SET revoked_at=created_at WHERE id='${BUYER_SESSION}'`)
    expect((await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`), env()))?.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_returns').get()?.n).toBe(0)
  })
  it('does not give customers private administrative data', async () => {
    await create()
    const response = await handleAdminReturnsHttp(request('/api/admin/returns'), env())
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('publicRef')
  })
  it('rejects CSRF before accessing D1 or parsing caller cookies/body', async () => {
    let calls = 0
    const db = new Proxy(database, {
      get() {
        calls++
        throw new Error('must_not_touch')
      }
    })
    for (const [handler, path] of [
      [handleCustomerReturnsHttp, `/api/orders/${id}/returns`],
      [handleAdminReturnsHttp, '/api/admin/returns']
    ] as const) {
      const response = await handler(request(path, 'POST', {}, 'garbage', { origin: 'https://hostile.test' }), env(db))
      expect(response?.status).toBe(403)
    }
    expect(calls).toBe(0)
  })
  it.each(['?now=2099-01-01', '?token=private', '?page=01', '?perPage=51', '?page=1&page=1'])(
    'rejects unsafe query %s',
    async (query) => {
      expect((await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns${query}`), env()))?.status).toBe(400)
      expect(
        (await handleAdminReturnsHttp(request(`/api/admin/returns${query}`, 'GET', undefined, adminCookie), env()))
          ?.status
      ).toBe(400)
    }
  )
  it.each(['returns%2Fextra', '%72eturns', 'returns%5Cextra'])(
    'owns malformed aliases without accepting them %s',
    async (tail) => {
      const admin = `/api/admin/${tail}`,
        customer = `/api/orders/${id}/${tail}`
      expect(ownsAdminReturnsNamespace(admin)).toBe(true)
      expect(ownsCustomerReturnsNamespace(customer)).toBe(true)
      expect(await handleAdminReturnsHttp(request(admin), env())).not.toBeNull()
      expect(await handleCustomerReturnsHttp(request(customer), env())).not.toBeNull()
    }
  )
  it('does not claim unrelated resources, rejects unsupported methods without fallback', async () => {
    expect(await handleAdminReturnsHttp(request('/api/admin/orders'), env())).toBeNull()
    expect(await handleCustomerReturnsHttp(request(`/api/orders/${id}/lines`), env())).toBeNull()
    expect((await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`, 'DELETE'), env()))?.status).toBe(405)
    expect((await handleAdminReturnsHttp(request('/api/admin/returns', 'POST', {}, adminCookie), env()))?.status).toBe(
      405
    )
  })
  it('enforces bounded streamed bodies independent of declared length', async () => {
    const response = await handleCustomerReturnsHttp(
      request(`/api/orders/${id}/returns`, 'POST', { ...REQUEST, reason: 'x'.repeat(20000) }),
      env()
    )
    expect(response?.status).toBe(413)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_returns').get()?.n).toBe(0)
  })
  it('reports lost infrastructure as unavailable, never not_found or empty', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw new Error('private-provider-text-must-not-escape')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const response = await handleCustomerReturnsHttp(request(`/api/orders/${id}/returns`), env(db))
    expect(response?.status).toBe(503)
    expect(await response?.text()).not.toContain('private-provider')
  })
})
