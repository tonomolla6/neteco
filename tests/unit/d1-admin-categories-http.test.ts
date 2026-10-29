import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleCatalogCategoryHttp,
  ownsCatalogCategoryNamespace,
  type CatalogCategoryHttpEnvironment
} from '../../workers/catalog/admin-categories-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { catalogCategoryReceiptSchema } from '../../shared/catalog-category-commands'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_SESSION,
  CATEGORY_IDENTITY,
  categoryUtc
} from '../support/category-command-fixture'

const ORIGIN = 'https://categories.neteco.invalid',
  PASSWORD = 'synthetic-category-cookie-password-32-characters'
describe('category private HTTP preserves the reader and bounds every editorial write', () => {
  let sqlite: DatabaseSync, database: D1Database, env: CatalogCategoryHttpEnvironment, cookie: string
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, NUXT_SESSION_PASSWORD: PASSWORD }
    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, {
      password: PASSWORD,
      maxAgeSeconds: 3600
    }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  const input = () => ({ name: 'Familia HTTP nueva', expectedVersion: 0, reason: 'Alta sintética por HTTP' })
  function request(
    path = '/api/admin/categories',
    method = 'POST',
    body: BodyInit | null = JSON.stringify(input()),
    headers: Record<string, string> = {}
  ) {
    const init: RequestInit = {
      method,
      body,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'category-http-create',
        ...headers
      }
    }
    if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(ORIGIN + path, init)
  }
  async function handle(candidate: Request, overrides: Partial<CatalogCategoryHttpEnvironment> = {}) {
    const result = await handleCatalogCategoryHttp(candidate, { ...env, ...overrides })
    expect(result).not.toBeNull()
    expect(result!.headers.get('cache-control')).toBe('private, no-store')
    expect(result!.headers.get('vary')).toBe('Cookie')
    expect(result!.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(result!.headers.get('referrer-policy')).toBe('no-referrer')
    return result!
  }
  it('creates only draft201, replays exactly, updates200 and tombstones200 with version and reason', async () => {
    const first = await handle(request())
    expect(first.status).toBe(201)
    const receipt = catalogCategoryReceiptSchema.parse(await first.json())
    expect(receipt).toMatchObject({ action: 'create_category', status: 'draft', categoryVersion: 1 })
    expect(catalogCategoryReceiptSchema.parse(await (await handle(request())).json())).toEqual(receipt)
    const path = `/api/admin/categories/${receipt.categoryId}`
    const update = await handle(
      request(
        path,
        'PUT',
        JSON.stringify({ name: 'Familia HTTP renombrada', expectedVersion: 1, reason: 'Renombrado sintético' }),
        { 'idempotency-key': 'rename-http' }
      )
    )
    expect(update.status).toBe(200)
    expect(catalogCategoryReceiptSchema.parse(await update.json())).toMatchObject({
      categoryVersion: 2,
      slug: 'familia-http-renombrada',
      status: 'draft'
    })
    const removal = await handle(
      request(path, 'DELETE', JSON.stringify({ expectedVersion: 2, reason: 'Retirada sintética' }), {
        'idempotency-key': 'delete-http'
      })
    )
    expect(removal.status).toBe(200)
    expect(catalogCategoryReceiptSchema.parse(await removal.json())).toMatchObject({
      categoryVersion: 3,
      status: 'discontinued'
    })
  })
  it('does not intercept the canonical private reader or unrelated namespaces', async () => {
    for (const path of [
      '/api/admin/categories',
      '/api/categories',
      '/api/admin/products',
      '/api/admin/categories-extra'
    ])
      expect(await handleCatalogCategoryHttp(request(path, 'GET', null), env)).toBeNull()
  })
  it.each([
    '/api/admin/categories/',
    '/api/admin/categories/01',
    '/api/admin/categories/0',
    '/api/admin/categories/-1',
    '/api/admin/categories/1.0',
    '/api/admin/categories/9007199254740992',
    '/api/admin/categories/11/extra',
    '/api/admin/categ%6Fries',
    '/api/admin/%2563ategories',
    '/api/admin/categories/%31%31'
  ])('owns malformed or encoded namespace without falling through: %s', async (path) => {
    expect(ownsCatalogCategoryNamespace(new URL(ORIGIN + path).pathname)).toBe(true)
    const prepare = vi.spyOn(database, 'prepare')
    const result = await handle(request(path, path.endsWith('categories/') ? 'POST' : 'PUT'))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['POST', 'PUT', 'DELETE'])('Origin/Sec-Fetch checks happen before SQL/body for %s', async (method) => {
    const path = method === 'POST' ? '/api/admin/categories' : '/api/admin/categories/11'
    const candidate = request(path, method, JSON.stringify(input()), { origin: 'https://hostile.invalid' })
    const prepare = vi.spyOn(database, 'prepare'),
      read = vi.spyOn(candidate.body!, 'getReader')
    const result = await handle(candidate)
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'csrf_rejected' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(
      (await handle(request(path, method, JSON.stringify(input()), { 'sec-fetch-site': 'cross-site' }))).status
    ).toBe(403)
  })
  it.each(['?name=override', '?now=2099-01-01T00%3A00%3A00Z', '?unknown=1'])(
    'rejects write query input %s before reading body or SQL',
    async (query) => {
      const prepare = vi.spyOn(database, 'prepare')
      const result = await handle(request('/api/admin/categories' + query))
      expect(result.status).toBe(400)
      expect(prepare).not.toHaveBeenCalled()
    }
  )
  it.each(['missing', 'revoke', 'mfa', 'email', 'grant'])(
    'rejects current %s authority before reading a body',
    async (cause) => {
      if (cause === 'revoke')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(categoryUtc(), CATEGORY_SESSION)
      if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
      if (cause === 'email')
        sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CATEGORY_IDENTITY)
      if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
      const candidate = request(
        '/api/admin/categories',
        'POST',
        JSON.stringify(input()),
        cause === 'missing' ? { cookie: '' } : {}
      )
      const read = vi.spyOn(candidate.body!, 'getReader'),
        result = await handle(candidate)
      expect(result.status).toBe(['missing', 'revoke'].includes(cause) ? 401 : 403)
      expect(read).not.toHaveBeenCalled()
      expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 0 })
    }
  )
  it.each(['', 'key with spaces', 'non/ascii', 'ñ', 'k'.repeat(201)])(
    'rejects idempotency key %s before a command',
    async (key) => {
      const result = await handle(
        request('/api/admin/categories', 'POST', JSON.stringify(input()), { 'idempotency-key': key })
      )
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({ error: { code: 'invalid_idempotency_key' } })
    }
  )
  it.each([
    { status: 'published' },
    { slug: 'injected' },
    { reason: undefined },
    { now: '2099-01-01T00:00:00Z' },
    { name: 'Bad\n' },
    { parentId: '10' },
    { expectedVersion: 1 }
  ])('strict body rejects unknown/control/coercion input %#', async (extra) => {
    const result = await handle(request('/api/admin/categories', 'POST', JSON.stringify({ ...input(), ...extra })))
    expect(result.status).toBe(422)
    expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
  })
  it('requires a bounded DELETE JSON reason instead of the legacy body-less removal', async () => {
    const result = await handle(request('/api/admin/categories/12', 'DELETE', null))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: { code: 'missing_body' } })
  })
  it.each(['text/plain', 'application/json;charset=latin1'])('rejects unsupported content type %s', async (type) => {
    expect(
      (await handle(request('/api/admin/categories', 'POST', JSON.stringify(input()), { 'content-type': type }))).status
    ).toBe(415)
  })
  it('bounds declared and actual UTF8 bytes and invalid JSON before executing a command', async () => {
    expect(
      (await handle(request('/api/admin/categories', 'POST', JSON.stringify(input()), { 'content-length': '65537' })))
        .status
    ).toBe(413)
    expect((await handle(request('/api/admin/categories', 'POST', '{'))).status).toBe(400)
    expect(
      (await handle(request('/api/admin/categories', 'POST', new TextEncoder().encode('ñ'.repeat(32769))))).status
    ).toBe(413)
    expect((await handle(request('/api/admin/categories', 'POST', new Uint8Array([0xff])))).status).toBe(400)
  })
  it('cancels an overflowing body stream and never inserts a command', async () => {
    const cancel = vi.fn(),
      stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(65536))
          controller.enqueue(new Uint8Array(1))
        },
        cancel
      })
    expect((await handle(request('/api/admin/categories', 'POST', stream))).status).toBe(413)
    expect(cancel).toHaveBeenCalledOnce()
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 0 })
  })
  it('does not classify provider failure containing CHECK as a business conflict or expose private text', async () => {
    const wrapped = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async () => {
            throw new Error('D1_ERROR: provider unavailable; CHECK constraint failed private_owner@example.invalid')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const result = await handle(request(), { DB: wrapped })
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
  it('uses a distinct live quota and returns stable429 without performing a command', async () => {
    await handle(request())
    sqlite.prepare("UPDATE identity_rate_limits SET used=60 WHERE scope='admin-categories'").run()
    const result = await handle(
      request('/api/admin/categories', 'POST', JSON.stringify({ ...input(), name: 'Another' }), {
        'idempotency-key': 'quota-other'
      })
    )
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).not.toBeNull()
    expect(await result.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(sqlite.prepare('SELECT count(*) AS total FROM catalog_category_commands').get()).toEqual({ total: 1 })
  })
})
