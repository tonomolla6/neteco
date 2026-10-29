import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orderViewsFixture, ADMIN, OTHER, ORIGIN } from './d1-admin-order-views-fixture'
import { handleAdminOrderViewsHttp } from '../../workers/catalog/admin-order-views-http'
import { adminOrderViewIntentHash } from '../../shared/admin-order-views'

describe('private saved order views real D1 HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof orderViewsFixture>>
  beforeEach(async () => {
    f = await orderViewsFixture()
  })
  afterEach(() => f.sqlite.close())
  async function request(
    path = '/api/admin/order-views',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    claims = ADMIN
  ) {
    return (await handleAdminOrderViewsHttp(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: await f.cookie(claims),
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      f.deps
    ))!
  }
  it('reads private metadata without inventing an empty result during errors', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ source: 'cloudflare', items: [] })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('creates, updates and archives with exact detail and actor-bound manual recovery', async () => {
    const key = crypto.randomUUID()
    const response = await request(undefined, 'POST', f.input, { 'idempotency-key': key })
    expect(response.status).toBe(201)
    const receipt = (await response.json()) as { viewId: string }
    const hash = await adminOrderViewIntentHash('create', null, f.input)
    expect(await (await request('/api/admin/order-views/commands/' + key + '?payloadHash=' + hash)).json()).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect((await request('/api/admin/order-views/' + receipt.viewId)).status).toBe(200)
    expect(
      (await request('/api/admin/order-views/' + receipt.viewId, 'PUT', { ...f.input, expectedVersion: 1 })).status
    ).toBe(200)
    expect(
      (await request('/api/admin/order-views/' + receipt.viewId + '/archive', 'POST', { expectedVersion: 2 })).status
    ).toBe(200)
    expect(await (await request()).json()).toEqual({ source: 'cloudflare', items: [] })
    expect(await (await request('/api/admin/order-views/' + receipt.viewId)).json()).toMatchObject({
      view: { archived: true, version: 3 }
    })
    expect((await request('/api/admin/order-views/' + receipt.viewId, 'GET', undefined, {}, OTHER)).status).toBe(404)
  })
  it('rejects anonymous and revoked MFA access with unchanged cookies', async () => {
    expect((await request(undefined, 'GET', undefined, { cookie: '' })).status).toBe(401)
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
    expect((await request()).status).toBe(403)
  })
  it('rejects CSRF, private query fields, malformed keys and unexpected input', async () => {
    expect((await request(undefined, 'POST', f.input, { origin: 'https://foreign.invalid' })).status).toBe(403)
    expect((await request('/api/admin/order-views?q=private')).status).toBe(422)
    expect((await request(undefined, 'POST', f.input, { 'idempotency-key': 'invalid' })).status).toBe(422)
    expect(
      (
        await request(undefined, 'POST', {
          ...f.input,
          definition: { ...f.input.definition, q: 'private@example.test' }
        })
      ).status
    ).toBe(422)
  })
  it('bounds bodies and methods and retains aliases without falling through', async () => {
    expect((await request(undefined, 'POST', { name: 'x'.repeat(17000) })).status).toBe(413)
    expect((await request(undefined, 'DELETE')).status).toBe(405)
    for (const path of [
      '/API/admin/order-views',
      '/api/admin/%6frder-views',
      '/api/admin/order-views/',
      '/api/admin/order-views/not-a-uuid'
    ])
      expect((await request(path)).status).toBe(404)
  })
  it('runs the edge gate before cookies or D1 and fails closed on outages', async () => {
    const database = {
      prepare: () => {
        throw new Error('D1 must not run before edge')
      }
    } as unknown as D1Database
    const req = new Request(ORIGIN + '/api/admin/order-views')
    expect(
      (await handleAdminOrderViewsHttp(req, { ...f.deps, database, edgeGate: async () => 'denied' }))?.status
    ).toBe(429)
    expect(
      (await handleAdminOrderViewsHttp(req, { ...f.deps, database, edgeGate: async () => 'unavailable' }))?.status
    ).toBe(503)
    const signed = new Request(ORIGIN + '/api/admin/order-views', { headers: { cookie: await f.cookie() } })
    expect((await handleAdminOrderViewsHttp(signed, { ...f.deps, database }))?.status).toBe(503)
  })
})
