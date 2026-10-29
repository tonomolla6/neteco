import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminFulfillmentHttp, ownsAdminFulfillmentNamespace } from '../../workers/fulfillment/admin-http'
import { ACTOR, CLAIMS, REASON, fulfillmentFixture } from './d1-fulfillment-fixture'

const origin = 'https://neteco.invalid',
  password = 'synthetic-fulfillment-cookie-with-more-than-32-characters'
describe('private admin fulfillment HTTP ownership and authority', () => {
  let sqlite: DatabaseSync, database: D1Database, id: string, cookie: string
  beforeEach(async () => {
    const fixture = await fulfillmentFixture()
    sqlite = fixture.sqlite
    database = fixture.database
    id = await fixture.order()
    cookie = (await issueD1SessionCookie(database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function request(
    path = `/api/admin/orders/${id}/fulfillment/transitions`,
    options: { method?: string; body?: unknown; headers?: Record<string, string>; db?: D1Database } = {}
  ) {
    const method = options.method ?? 'POST'
    return handleAdminFulfillmentHttp(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'picking',
          ...options.headers
        },
        ...(method === 'GET'
          ? {}
          : { body: JSON.stringify(options.body ?? { action: 'picking', expectedVersion: 0, reason: REASON }) })
      }),
      { DB: options.db ?? database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    )
  }
  function privateHeaders(response: Response | null) {
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(response?.headers.get('vary')).toBe('Cookie')
    expect(response?.headers.get('x-robots-tag')).toContain('noindex')
  }
  it('reads and executes privately with the existing admin grant and exact historical retry', async () => {
    const read = await request(`/api/admin/orders/${id}/fulfillment`, { method: 'GET' })
    expect(read?.status).toBe(200)
    privateHeaders(read)
    const first = await request(),
      replay = await request()
    expect(first?.status).toBe(200)
    expect(await replay?.text()).toBe(await first?.text())
    privateHeaders(first)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_audit').get()?.n).toBe(1)
  })
  it('checks configured origin before cookie, body or D1; does not trust Host or forwarded headers', async () => {
    let touched = 0
    const db = new Proxy(database, {
      get() {
        touched++
        throw new Error('must_not_touch')
      }
    })
    const response = await request(undefined, {
      db,
      headers: {
        origin: 'https://hostile.invalid',
        cookie: 'garbage',
        host: 'neteco.invalid',
        'x-forwarded-host': 'neteco.invalid'
      }
    })
    expect(response?.status).toBe(403)
    expect(touched).toBe(0)
    privateHeaders(response)
  })
  it.each(['unauthenticated', 'email_unverified', 'mfa_required', 'forbidden'])(
    'requires current %s before reads, writes and replay',
    async (code) => {
      await request()
      if (code === 'unauthenticated') sqlite.exec('UPDATE auth_sessions SET revoked_at=created_at')
      if (code === 'email_unverified') sqlite.exec(`UPDATE identities SET email_verified_at=NULL WHERE id='${ACTOR}'`)
      if (code === 'mfa_required') sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      if (code === 'forbidden') sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`)
      for (const response of [
        await request(),
        await request(`/api/admin/orders/${id}/fulfillment`, { method: 'GET' })
      ]) {
        expect(response?.status).toBe(code === 'unauthenticated' ? 401 : 403)
        expect(await response?.text()).not.toMatch(/warehouseId|allowedActions/)
      }
    }
  )
  it.each(['?now=2099-01-01', '?page=01', '?perPage=51', '?page=1&page=1', '?q=customer'])(
    'rejects unsafe read selectors %s',
    async (query) => {
      expect((await request(`/api/admin/orders/${id}/fulfillment${query}`, { method: 'GET' }))?.status).toBe(400)
    }
  )
  it.each(['', '?now=2099', '/unknown'])(
    'never falls through unsupported methods/path under owned fulfillment %s',
    async (suffix) => {
      const path = `/api/admin/orders/${id}/fulfillment${suffix}`
      expect(ownsAdminFulfillmentNamespace(path.split('?')[0]!)).toBe(true)
      const response = await request(path, { method: 'DELETE' })
      expect(response).not.toBeNull()
      expect([400, 405]).toContain(response?.status)
    }
  )
  it.each(['%66ulfillment', 'fulfillment%2Ftransitions', 'fulfillment%5Ctransitions'])(
    'owns but rejects encoded/malformed alias %s',
    async (tail) => {
      const path = `/api/admin/orders/${id}/${tail}`
      expect(ownsAdminFulfillmentNamespace(path)).toBe(true)
      expect((await request(path))?.status).toBe(400)
    }
  )
  it('belongs only to its exact private namespace', async () => {
    expect(await request('/api/admin/orders')).toBeNull()
    expect(await request(`/api/admin/orders/${id}/detail`)).toBeNull()
    expect(await request('/api/orders/anything/fulfillment')).toBeNull()
  })
  it.each([
    { action: 'delivered', expectedVersion: 0, reason: REASON },
    { action: 'picking', expectedVersion: 0, reason: REASON, actorId: ACTOR },
    {}
  ])('rejects malformed command with no persisted effects %#', async (body) => {
    const response = await request(undefined, { body })
    expect(response?.status).toBe(422)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('rejects noncanonical order identifier and missing idempotency key without fallback', async () => {
    expect((await request('/api/admin/orders/not-a-uuid/fulfillment'))?.status).toBe(400)
    expect((await request(undefined, { headers: { 'idempotency-key': '' } }))?.status).toBe(400)
  })
  it('limits streamed bytes independently of the declared content length', async () => {
    const response = await handleAdminFulfillmentHttp(
      new Request(`${origin}/api/admin/orders/${id}/fulfillment/transitions`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': 'overflow' },
        body: ' '.repeat(9000)
      }),
      { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    )
    expect(response?.status).toBe(413)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('revocation while body arrives blocks dispatch and never reveals the order', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ action: 'picking', expectedVersion: 0, reason: REASON }))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${ACTOR}'`)
        controller.enqueue(bytes)
        controller.close()
      }
    })
    const req = new Request(`${origin}/api/admin/orders/${id}/fulfillment/transitions`, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': 'stream' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    const response = await handleAdminFulfillmentHttp(req, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
    expect(response?.status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
  })
  it('separates definite version conflicts from unconfirmed infrastructure outcome without SQL/PII leakage', async () => {
    await request()
    const conflict = await request(undefined, { headers: { 'idempotency-key': 'different' } })
    expect(conflict?.status).toBe(409)
    expect(await conflict?.text()).toContain('version_conflict')
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw new Error('SQL private buyer@example.invalid secret')
          }
        const value: unknown = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const failure = await request(undefined, { db })
    expect(failure?.status).toBe(503)
    expect(await failure?.text()).not.toMatch(/SQL|buyer@example|secret/)
    privateHeaders(failure)
  })
})
