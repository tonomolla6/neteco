import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import {
  MER_CLAIMS,
  MER_ROOT,
  merProduct,
  merUtc as at,
  merchandisingWorld
} from '../support/category-merchandising-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCategoryMerchandisingHttp,
  ownsCategoryMerchandisingNamespace
} from '../../workers/catalog/category-merchandising-http'
import { testUuid } from '../support/deterministic'

const DAY = 86_400_000
const origin = 'https://catmerch.neteco.invalid'
const password = 'synthetic-only-cookie-password-32-characters'
const BASE = '/api/admin/category-merchandising'

describe('SEA-015 category merchandising private HTTP contract', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  beforeEach(async () => {
    const world = await merchandisingWorld()
    ;({ sqlite, database } = world)
    world.addProduct({ n: 1, stock: 50, cost: 600 })
    world.addProduct({ n: 2, stock: 0, cost: 200 })
    cookie = (await issueD1SessionCookie(database, MER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => sqlite.close())

  const body = (extra: Record<string, unknown> = {}) => ({
    action: 'save',
    id: null,
    expectedVersion: 0,
    categoryId: MER_ROOT,
    weights: { stock: 0, margin: 5, popularity: 0, contract: 0, campaign: 0 },
    guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 5 },
    campaign: { campaignId: null, productIds: [] },
    reason: 'Priorizar rentabilidad revisada',
    validFrom: at(-3_600_000),
    validUntil: at(30 * DAY),
    ...extra
  })
  const request = (path = '', method = 'GET', payload?: unknown, headers: Record<string, string | null> = {}) => {
    const merged: Record<string, string | null> = {
      cookie,
      origin,
      'content-type': 'application/json',
      'idempotency-key': 'http-command',
      'cf-connecting-ip': '192.0.2.182',
      ...headers
    }
    return new Request(origin + BASE + path, {
      method,
      headers: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null) as [string, string][]),
      ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) })
    })
  }
  const env = () => ({ DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password })
  const handle = (req: Request) => handleCategoryMerchandisingHttp(req, env())
  const rows = () => (sqlite.prepare('SELECT count(*) n FROM category_merchandising_commands').get() as { n: number }).n

  it('owns its namespace, also when encoded, and ignores others', async () => {
    for (const path of [
      BASE,
      BASE + '/x',
      '/api/admin/category%2Dmerchandising',
      '/api/admin/category-merchandising%2Fx'
    ])
      expect(ownsCategoryMerchandisingNamespace(path), path).toBe(true)
    expect(ownsCategoryMerchandisingNamespace('/api/admin/search-merchandising')).toBe(false)
    expect(await handleCategoryMerchandisingHttp(new Request(origin + '/api/other'), env())).toBeNull()
  })
  it('lists, creates, GET-recovers, reads, edits, reads history and retires with private no-store responses', async () => {
    const list = (await handle(request()))!
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('private, no-store')
    expect(await list.json()).toMatchObject({ items: [], total: 0 })
    const created = (await handle(request('', 'POST', body())))!
    expect(created.status).toBe(201)
    const receipt = (await created.json()) as { item: { id: string; version: number } }
    expect(receipt.item.version).toBe(1)
    expect(rows()).toBe(1)
    const replay = (await handle(request('', 'POST', body())))!
    expect(await replay.json()).toEqual(receipt)
    expect(rows()).toBe(1)
    const recovered = (await handle(request('/commands/http-command')))!
    expect(await recovered.json()).toEqual(receipt)
    expect((await handle(request('/commands/missing')))!.status).toBe(404)
    const id = receipt.item.id
    expect(await (await handle(request('/' + id)))!.json()).toMatchObject({ item: { id, state: 'live' } })
    const edited = (await handle(
      request('/' + id, 'PUT', body({ id, expectedVersion: 1, reason: 'Ajuste de prioridad' }), {
        'idempotency-key': 'edit'
      })
    ))!
    expect(edited.status).toBe(200)
    expect((await (await handle(request('/' + id + '/history')))!.json()) as { items: unknown[] }).toMatchObject({
      items: [{ version: 1 }, { version: 2 }]
    })
    const retired = (await handle(
      request(
        '/' + id,
        'DELETE',
        { action: 'retire', id, expectedVersion: 2, reason: 'Fin de campaña' },
        { 'idempotency-key': 'retire' }
      )
    ))!
    expect(retired.status).toBe(200)
    expect(await retired.json()).toMatchObject({ action: 'retire', item: { status: 'retired', version: 3 } })
  })
  it('lists the merchandisable categories before the id routes can shadow the path', async () => {
    const res = (await handle(request('/categories')))!
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: Array<{ slug: string }> }).items.map((c) => c.slug)).toEqual([
      'lejias',
      'limpieza'
    ])
    expect((await handle(request('/categories', 'POST', {})))!.status).toBe(405)
    expect((await handle(request('/categories?x=1')))!.status).toBe(400)
  })
  it('previews a draft or a stored rule', async () => {
    const draft = {
      categoryId: MER_ROOT,
      ruleId: null,
      companyId: null,
      draft: {
        weights: { stock: 0, margin: 5, popularity: 0, contract: 0, campaign: 0 },
        guardrails: { minStock: 0, minMarginBps: null, maxBoosted: 5 },
        campaign: { campaignId: null, productIds: [] }
      }
    }
    const preview = (await handle(request('/preview', 'POST', draft, { 'idempotency-key': null })))!
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as { items: Array<{ productId: string }> }).items.map((i) => i.productId)).toEqual([
      merProduct(1),
      merProduct(2)
    ])
    expect(rows()).toBe(0)
    expect(
      (await handle(request('/preview', 'POST', { ...draft, ruleId: testUuid() }, { 'idempotency-key': null })))!.status
    ).toBe(422)
    expect(
      (await handle(request('/preview', 'POST', { ...draft, categoryId: testUuid() }, { 'idempotency-key': null })))!
        .status
    ).toBe(409)
    expect((await handle(request('/preview', 'GET')))!.status).toBe(405)
  })
  it('rejects foreign or missing Origin and cross-site fetches on writes, and a foreign Origin on reads', async () => {
    for (const headers of [{ origin: null }, { origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      const res = (await handle(request('', 'POST', body(), headers)))!
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: { code: 'csrf_rejected' } })
    }
    expect((await handle(request('', 'GET', undefined, { origin: 'https://evil.invalid' })))!.status).toBe(403)
    expect(rows()).toBe(0)
  })
  it('requires a valid session and permission', async () => {
    expect((await handle(request('', 'GET', undefined, { cookie: null })))!.status).toBe(401)
    expect((await handle(request('', 'GET', undefined, { cookie: 'neteco-session=garbage' })))!.status).toBe(401)
    sqlite.prepare('DELETE FROM identity_roles').run()
    const denied = (await handle(request()))!
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { code: 'forbidden' } })
    expect((await handleCategoryMerchandisingHttp(request(), { ...env(), AUTH_ENABLED: 'false' }))!.status).toBe(503)
  })
  it('validates methods, ids, queries, idempotency key, content type and body size', async () => {
    expect((await handle(request('', 'DELETE')))!.status).toBe(405)
    expect((await handle(request('/not-a-uuid')))!.status).toBe(400)
    expect((await handle(request('?bad=1')))!.status).toBe(400)
    expect((await handle(request('?perPage=500')))!.status).toBe(400)
    expect((await handle(request('', 'POST', body(), { 'idempotency-key': null })))!.status).toBe(400)
    expect((await handle(request('', 'POST', body(), { 'content-type': 'text/plain' })))!.status).toBe(415)
    expect((await handle(request('', 'POST', '{bad')))!.status).toBe(400)
    expect((await handle(request('', 'POST', body({ reason: 'x'.repeat(40_000) }))))!.status).toBe(413)
    expect((await handle(request('', 'POST', body({ extra: 1 }))))!.status).toBe(422)
    expect(rows()).toBe(0)
  })
  it('maps domain errors to stable codes', async () => {
    const id = testUuid()
    const conflict = (await handle(request('/' + id, 'PUT', body({ id, expectedVersion: 1 }))))!
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'version_conflict' } })
    const missing = (await handle(request('', 'POST', body({ categoryId: testUuid() }))))!
    expect(await missing.json()).toEqual({ error: { code: 'category_unavailable' } })
    await handle(request('', 'POST', body()))
    const overlap = (await handle(request('', 'POST', body(), { 'idempotency-key': 'second' })))!
    expect(await overlap.json()).toEqual({ error: { code: 'rule_conflict' } })
  })
  it('rate limits writes per identity', async () => {
    let last: Response | undefined
    for (let i = 0; i < 61; i++)
      last = (await handle(request('', 'POST', { action: 'save' }, { 'idempotency-key': `k${i}` })))!
    expect(last!.status).toBe(429)
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/)
  })
  it('is reachable through the real Worker and not shadowed by earlier routers', async () => {
    const full = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-rate-limit-pepper-over-32',
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      DB: database
    } as unknown as CloudflareEnv
    const ok = await worker.fetch(request(), full)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ source: 'cloudflare', items: [] })
    expect((await worker.fetch(request('', 'GET', undefined, { cookie: null }), full)).status).toBe(401)
    expect((await worker.fetch(request('', 'POST', body(), { origin: 'https://evil.invalid' }), full)).status).toBe(403)
    expect((await worker.fetch(request(), { ...full, AUTH_ENABLED: 'false' } as CloudflareEnv)).status).toBe(503)
  })
})
