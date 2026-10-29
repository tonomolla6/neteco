import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCmsDraftHttp, ownsCmsNamespace, type CmsDraftHttpEnvironment } from '../../workers/cms/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  cmsCommandReceiptSchema,
  cmsPageListSchema,
  cmsPageDetailSchema,
  CMS_BODY_BYTES
} from '../../shared/cms-commands'
import { cmsFixture, cmsDocument, CMS_CLAIMS, CMS_SESSION, CMS_IDENTITY, cmsUtc } from './d1-cms-fixture'
const ORIGIN = 'https://cms.neteco.invalid',
  PASSWORD = 'synthetic-cms-cookie-password-32-characters',
  ROOT = '/api/admin/content/pages'
describe('D1 CMS HTTP owns the Node namespace without enabling publication fallback', () => {
  let sqlite: DatabaseSync, database: D1Database, env: CmsDraftHttpEnvironment, cookie: string
  beforeEach(async () => {
    ;({ sqlite, database } = await cmsFixture())
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, NUXT_SESSION_PASSWORD: PASSWORD }
    cookie = (await issueD1SessionCookie(database, CMS_CLAIMS, { password: PASSWORD, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function request(
    path = ROOT,
    method = 'POST',
    payload: BodyInit | null = method === 'GET' ? null : JSON.stringify({ ...cmsDocument(), expectedVersion: 0 }),
    headers: Record<string, string> = {}
  ) {
    const init: RequestInit = {
      method,
      body: payload,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'cms-http-create',
        ...headers
      }
    }
    if (payload instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(ORIGIN + path, init)
  }
  async function handle(candidate: Request, overrides: Partial<CmsDraftHttpEnvironment> = {}) {
    const response = await handleCmsDraftHttp(candidate, { ...env, ...overrides })
    expect(response).not.toBeNull()
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
    return response!
  }
  it('creates201, returns list/detail, updates and restores new versions, then archives200', async () => {
    const response = await handle(request()),
      first = cmsCommandReceiptSchema.parse(await response.json())
    expect(response.status).toBe(201)
    expect(cmsCommandReceiptSchema.parse(await (await handle(request())).json())).toEqual(first)
    const list = cmsPageListSchema.parse(await (await handle(request(ROOT, 'GET'))).json())
    expect(list.pages.map((page) => page.id)).toEqual([first.pageId])
    const path = `${ROOT}/${first.pageId}`
    expect(cmsPageDetailSchema.parse(await (await handle(request(path, 'GET'))).json()).draft.id).toBe(first.versionId)
    const updated = await handle(
      request(path, 'PUT', JSON.stringify({ ...cmsDocument({ title: 'Guía actualizada' }), expectedVersion: 1 }), {
        'idempotency-key': 'cms-http-update'
      })
    )
    expect(updated.status).toBe(200)
    expect(cmsCommandReceiptSchema.parse(await updated.json()).draftVersion).toBe(2)
    const restored = await handle(
      request(
        path + '/rollback',
        'POST',
        JSON.stringify({ expectedVersion: 2, versionId: first.versionId, reason: 'Restauración editorial contextual' }),
        { 'idempotency-key': 'cms-http-restore' }
      )
    )
    expect(restored.status).toBe(200)
    const archived = await handle(
      request(path, 'DELETE', JSON.stringify({ expectedVersion: 3, reason: 'Archivo editorial contextual' }), {
        'idempotency-key': 'cms-http-archive'
      })
    )
    expect(archived.status).toBe(200)
    expect(cmsCommandReceiptSchema.parse(await archived.json())).toMatchObject({
      status: 'hidden',
      pageVersion: 4,
      draftVersion: 3
    })
  })
  it.each(['publish', 'preview', 'schedule'])(
    'owns unported %s and returns explicit501 without reading body or writing',
    async (suffix) => {
      const first = cmsCommandReceiptSchema.parse(await (await handle(request())).json()),
        candidate = request(`${ROOT}/${first.pageId}/${suffix}`),
        read = vi.spyOn(candidate.body!, 'getReader'),
        before = sqlite.prepare('SELECT count(*) AS total FROM content_draft_commands').get()
      const response = await handle(candidate)
      expect(response.status).toBe(501)
      expect(await response.json()).toEqual({ error: { code: 'feature_unavailable' } })
      expect(read).not.toHaveBeenCalled()
      expect(sqlite.prepare('SELECT count(*) AS total FROM content_draft_commands').get()).toEqual(before)
    }
  )
  it.each([
    '/api/admin/content',
    '/api/admin/content/',
    '/api/admin/content/pages/',
    '/api/admin/content/pages/not-uuid',
    '/api/admin/content/pages/20000000-0000-4000-8000-000000000044/extra',
    '/api/admin/c%6fntent/pages',
    '/api/admin/%2563ontent/pages',
    '/api/admin/content/pages/%32%30%30'
  ])('owns malformed namespace %s without touching SQL', async (path) => {
    expect(ownsCmsNamespace(new URL(ORIGIN + path).pathname)).toBe(true)
    const prepare = vi.spyOn(database, 'prepare'),
      response = await handle(request(path))
    expect(response.status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['/api/admin/content-extra', '/api/content/guia', '/api/admin/products'])(
    'leaves unrelated namespace %s alone',
    async (path) => {
      expect(await handleCmsDraftHttp(request(path, 'GET'), env)).toBeNull()
    }
  )
  it.each(['PUT', 'DELETE', 'PATCH', 'OPTIONS'])('rejects unsupported collection method %s', async (method) => {
    const response = await handle(request(ROOT, method))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })
  it.each(['?now=2099-01-01', '?page=01', '?page=0', '?perPage=101', '?page=1&page=2', '?unknown=1'])(
    'rejects invalid read query %s',
    async (query) => {
      const prepare = vi.spyOn(database, 'prepare'),
        response = await handle(request(ROOT + query, 'GET'))
      expect(response.status).toBe(400)
      expect(prepare).not.toHaveBeenCalled()
    }
  )
  it('rejects any write query before SQL or body processing', async () => {
    const candidate = request(ROOT + '?expectedVersion=0'),
      prepare = vi.spyOn(database, 'prepare'),
      read = vi.spyOn(candidate.body!, 'getReader')
    expect((await handle(candidate)).status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['foreign-origin', 'missing-origin', 'cross-site'])(
    'rejects %s writes before SQL or body processing',
    async (shape) => {
      const candidate = request(),
        headers = candidate.headers
      if (shape === 'foreign-origin') headers.set('origin', 'https://hostile.invalid')
      if (shape === 'missing-origin') headers.delete('origin')
      if (shape === 'cross-site') headers.set('sec-fetch-site', 'cross-site')
      const prepare = vi.spyOn(database, 'prepare'),
        read = vi.spyOn(candidate.body!, 'getReader')
      expect((await handle(candidate)).status).toBe(403)
      expect(prepare).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    }
  )
  it.each(['cookie', 'revoke', 'email', 'mfa', 'grant'])(
    'denies current %s authority before reading a mutation body',
    async (shape) => {
      const candidate = request()
      if (shape === 'cookie') candidate.headers.delete('cookie')
      if (shape === 'revoke')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(cmsUtc(), CMS_SESSION)
      if (shape === 'email') sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CMS_IDENTITY)
      if (shape === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CMS_SESSION)
      if (shape === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
      const read = vi.spyOn(candidate.body!, 'getReader'),
        response = await handle(candidate)
      expect(response.status).toBe(shape === 'cookie' || shape === 'revoke' ? 401 : 403)
      expect(read).not.toHaveBeenCalled()
    }
  )
  it.each(['', 'key with spaces', 'a'.repeat(201)])('rejects invalid idempotency key %j', async (key) => {
    const candidate = request()
    candidate.headers.set('idempotency-key', key)
    const read = vi.spyOn(candidate.body!, 'getReader')
    expect((await handle(candidate)).status).toBe(400)
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['wrong-type', 'invalid-json', 'missing-body', 'declared-limit', 'stream-limit', 'invalid-utf8'])(
    'bounds body %s',
    async (shape) => {
      let payload: BodyInit | null = JSON.stringify({ ...cmsDocument(), expectedVersion: 0 }),
        headers: Record<string, string> = {}
      if (shape === 'wrong-type') headers = { 'content-type': 'text/plain' }
      if (shape === 'invalid-json') payload = '{broken'
      if (shape === 'missing-body') payload = null
      if (shape === 'declared-limit') headers = { 'content-length': String(CMS_BODY_BYTES + 1) }
      if (shape === 'stream-limit')
        payload = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(CMS_BODY_BYTES + 1))
            controller.close()
          }
        })
      if (shape === 'invalid-utf8') payload = new Uint8Array([0xff])
      const response = await handle(request(ROOT, 'POST', payload, headers))
      expect(response.status).toBe(
        shape === 'wrong-type' ? 415 : shape === 'declared-limit' || shape === 'stream-limit' ? 413 : 400
      )
      expect(sqlite.prepare('SELECT count(*) AS total FROM content_pages').get()).toEqual({ total: 0 })
    }
  )
  it('does not confuse failed reads with a confirmed empty list', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw new Error('synthetic-read-failure')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const response = await handle(request(ROOT, 'GET'), { DB: db })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
