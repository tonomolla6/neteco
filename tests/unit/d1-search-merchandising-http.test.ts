import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  CATEGORY_SESSION,
  ROOT_CATEGORY
} from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleSearchMerchandisingHttp,
  ownsSearchMerchandisingNamespace
} from '../../workers/catalog/search-merchandising-http'

const PRODUCT = '10000000-0000-4000-8000-000000000b01'
const OTHER = '10000000-0000-4000-8000-000000000b02'
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
const DAY = 86_400_000

describe('search merchandising private HTTP contract', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  const origin = 'https://merchandising.neteco.invalid',
    password = 'synthetic-only-cookie-password-32-characters'
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_merchandising_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0091_search_merchandising_rules.sql', import.meta.url), 'utf8')
      )
    sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('h-brand','NETECO','h-brand','published');`)
    sqlite
      .prepare(
        `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,301,'Lejía HTTP','lejia-http',?,'h-brand','published')`
      )
      .run(PRODUCT, ROOT_CATEGORY)
    sqlite
      .prepare(
        `INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES (?,302,'Borrador HTTP','borrador-http',?,'h-brand','draft')`
      )
      .run(OTHER, ROOT_CATEGORY)
    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => sqlite.close())

  const draft = (extra: Record<string, unknown> = {}) => ({
    action: 'save',
    id: null,
    expectedVersion: 0,
    term: 'lejía',
    kind: 'boost',
    productId: PRODUCT,
    weight: 4,
    redirectPath: null,
    reason: 'Campaña comercial revisada',
    validFrom: at(-3_600_000),
    validUntil: at(30 * DAY),
    ...extra
  })
  const request = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + '/api/admin/search-merchandising' + path, {
      method,
      headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'http-command', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const handle = (req: Request) =>
    handleSearchMerchandisingHttp(req, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
  const rows = () => (sqlite.prepare('SELECT count(*) n FROM search_merchandising_commands').get() as { n: number }).n

  it('lists, creates, GET-recovers, reads, edits, reads history and retires with private no-store responses', async () => {
    const read = (await handle(request()))!
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('private, no-store')
    expect(await read.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0, page: 1, perPage: 25 })
    const created = (await handle(request('', 'POST', draft())))!
    expect(created.status).toBe(201)
    const receipt = (await created.json()) as { item: { id: string; version: number; authorId: string } }
    expect(receipt.item).toMatchObject({ version: 1, authorId: CATEGORY_IDENTITY })
    expect(await (await handle(request('/commands/http-command')))!.json()).toEqual(receipt)
    expect((await handle(request('/commands/unknown')))!.status).toBe(404)
    const id = receipt.item.id
    expect(await (await handle(request(`/${id}`)))!.json()).toMatchObject({ item: { id, state: 'live' } })
    const updated = (await handle(
      request(`/${id}`, 'PUT', draft({ id, expectedVersion: 1, weight: 7 }), { 'idempotency-key': 'http-edit' })
    ))!
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ item: { version: 2, weight: 7 } })
    const retired = (await handle(
      request(
        `/${id}`,
        'DELETE',
        { action: 'retire', id, expectedVersion: 2, reason: 'Campaña finalizada' },
        { 'idempotency-key': 'http-retire' }
      )
    ))!
    expect(retired.status).toBe(200)
    expect(await retired.json()).toMatchObject({ action: 'retire', item: { version: 3, status: 'retired' } })
    const history = (await (await handle(request(`/${id}/history`)))!.json()) as { items: Array<{ version: number }> }
    expect(history.items.map((item) => item.version)).toEqual([1, 2, 3])
    expect(await (await handle(request('?status=retired')))!.json()).toMatchObject({ total: 1 })
    expect(await (await handle(request()))!.json()).toMatchObject({ total: 0 })
  })

  it('replays an identical command and rejects a different payload under the same key', async () => {
    const first = await (await handle(request('', 'POST', draft())))!.json()
    const replay = (await handle(request('', 'POST', draft())))!
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(first)
    const conflict = (await handle(request('', 'POST', draft({ weight: 9 }))))!
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    expect(rows()).toBe(1)
  })

  it.each([
    '/%31',
    '/',
    '/extra/nested',
    '/%252e%252e',
    '/not-a-uuid',
    `/${PRODUCT}/other`,
    '?unknown=x',
    '?page=0',
    '?perPage=101',
    '?page=1&page=2',
    '?status=bogus',
    '?status=open&status=all'
  ])('rejects malformed paths/query %s without legacy fallthrough', async (path) =>
    expect((await handle(request(path)))!.status).toBe(400)
  )

  it('rejects missing cookie, cross-site mutations, body shape and content budgets', async () => {
    expect((await handle(request('', 'GET', undefined, { cookie: '' })))!.status).toBe(401)
    expect((await handle(request('', 'POST', draft(), { origin: 'https://attacker.invalid' })))!.status).toBe(403)
    expect((await handle(request('', 'POST', draft(), { 'sec-fetch-site': 'cross-site' })))!.status).toBe(403)
    expect((await handle(request('', 'POST', draft(), { 'content-type': 'text/plain' })))!.status).toBe(415)
    expect((await handle(request('', 'POST', draft(), { 'content-length': '100000' })))!.status).toBe(413)
    expect((await handle(request('', 'POST', { unexpected: true })))!.status).toBe(422)
    expect((await handle(request('', 'POST', draft(), { 'idempotency-key': '' })))!.status).toBe(400)
    expect((await handle(request('', 'POST', draft(), { 'idempotency-key': 'bad key!' })))!.status).toBe(400)
    expect(
      (await handle(
        new Request(origin + '/api/admin/search-merchandising', {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'k' },
          body: '{'
        })
      ))!.status
    ).toBe(400)
    expect(rows()).toBe(0)
  })

  it('answers unsupported methods with Allow and refuses an external redirect before any write', async () => {
    const response = (await handle(request('', 'PATCH', draft())))!
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
    expect((await handle(request('/commands/key', 'POST', draft())))!.status).toBe(405)
    expect((await handle(request(`/${PRODUCT}/history`, 'PUT', draft())))!.status).toBe(405)
    const external = (await handle(
      request(
        '',
        'POST',
        draft({ kind: 'redirect', productId: null, weight: null, redirectPath: 'https://evil.example' })
      )
    ))!
    expect(external.status).toBe(422)
    expect(await external.json()).toEqual({ error: { code: 'invalid_input' } })
    expect(rows()).toBe(0)
  })

  it('maps domain conflicts to stable 409 codes and invalid payloads to 422', async () => {
    const created = (await (await handle(request('', 'POST', draft())))!.json()) as { item: { id: string } }
    const id = created.item.id
    const codes = async (response: Response | null) =>
      ((await response!.json()) as { error: { code: string } }).error.code
    expect(await codes(await handle(request('', 'POST', draft(), { 'idempotency-key': 'dup' })))).toBe('rule_conflict')
    expect(
      await codes(
        await handle(
          request('', 'POST', draft({ productId: OTHER, term: 'otro' }), { 'idempotency-key': 'draft-product' })
        )
      )
    ).toBe('product_unavailable')
    expect(
      await codes(
        await handle(request(`/${id}`, 'PUT', draft({ id, expectedVersion: 5 }), { 'idempotency-key': 'stale' }))
      )
    ).toBe('version_conflict')
    expect(
      await codes(
        await handle(
          request('', 'POST', draft({ term: 'tarde', validFrom: at(-2 * DAY), validUntil: at(-3_600_000) }), {
            'idempotency-key': 'expired'
          })
        )
      )
    ).toBe('expiry_invalid')
    expect(
      await codes(
        await handle(request('', 'POST', draft({ term: 'sin motivo', reason: 'x' }), { 'idempotency-key': 'reason' }))
      )
    ).toBe('invalid_input')
    expect(rows()).toBe(1)
  })

  it('refuses a body whose target or action does not match the route', async () => {
    const created = (await (await handle(request('', 'POST', draft())))!.json()) as { item: { id: string } }
    const id = created.item.id
    const mismatched = '10000000-0000-4000-8000-000000000099'
    expect(
      (await handle(request('', 'POST', draft({ id, expectedVersion: 1 }), { 'idempotency-key': 'a' })))!.status
    ).toBe(422)
    expect(
      (await handle(request(`/${mismatched}`, 'PUT', draft({ id, expectedVersion: 1 }), { 'idempotency-key': 'b' })))!
        .status
    ).toBe(422)
    expect(
      (await handle(request(`/${id}`, 'DELETE', draft({ id, expectedVersion: 1 }), { 'idempotency-key': 'c' })))!.status
    ).toBe(422)
    expect(
      (await handle(
        request(
          `/${id}`,
          'PUT',
          { action: 'retire', id, expectedVersion: 1, reason: 'Retirada' },
          { 'idempotency-key': 'd' }
        )
      ))!.status
    ).toBe(422)
    expect(rows()).toBe(1)
  })

  it('requires the same catalog.write authority as synonyms, including MFA', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    expect((await handle(request()))!.status).toBe(403)
    expect((await handle(request('', 'POST', draft())))!.status).toBe(403)
    expect((await handle(request('/commands/http-command')))!.status).toBe(403)
    expect(rows()).toBe(0)
  })
  it('rejects a session without MFA (403) and a revoked session (401)', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
    const mfa = (await handle(request()))!
    expect(mfa.status).toBe(403)
    expect(await mfa.json()).toEqual({ error: { code: 'mfa_required' } })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=created_at WHERE id=?').run(CATEGORY_SESSION)
    expect((await handle(request()))!.status).toBe(401)
  })
  it('answers 503 when authentication is disabled and rejects a malformed origin configuration', async () => {
    const disabled = await handleSearchMerchandisingHttp(request(), {
      DB: database,
      AUTH_ENABLED: 'false',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
    expect(disabled!.status).toBe(503)
    const insecure = await handleSearchMerchandisingHttp(request(), {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'http://insecure.invalid',
      NUXT_SESSION_PASSWORD: password
    })
    expect(insecure!.status).toBe(503)
  })

  it('never intercepts another namespace but owns encoded spellings of its own', async () => {
    expect(await handle(new Request(origin + '/api/admin/search-merchandising-extra'))).toBeNull()
    expect(await handle(new Request(origin + '/api/admin/search-synonyms'))).toBeNull()
    expect(ownsSearchMerchandisingNamespace('/api/admin/search-merchandising')).toBe(true)
    expect(ownsSearchMerchandisingNamespace('/api/admin/search-merchandising/commands/x')).toBe(true)
    expect(ownsSearchMerchandisingNamespace('/api/admin/search-merchandising%2Fx')).toBe(true)
    expect(ownsSearchMerchandisingNamespace('/api/admin/search%2Dmerchandising/x')).toBe(true)
    expect(ownsSearchMerchandisingNamespace('/api/admin/search-merchandising-extra')).toBe(false)
    expect(ownsSearchMerchandisingNamespace('/api/search')).toBe(false)
  })

  it('enforces the command quota while keeping read-only receipt recovery available', async () => {
    const instant = Math.floor(Date.now() / 1000)
    sqlite
      .prepare(
        'INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at) VALUES (?, ?, 60, ?, ?)'
      )
      .run(CATEGORY_IDENTITY, 'search-merchandising-commands', instant, instant + 3600)
    const limited = (await handle(request('', 'POST', draft())))!
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await handle(request('/commands/unknown')))!.status).toBe(404)
    expect(rows()).toBe(0)
  })

  it('answers 503 with a stable code when the database fails', async () => {
    const broken = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.includes('search_merchandising_current')) throw new Error('synthetic outage')
            return database.prepare(sql)
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const response = await handleSearchMerchandisingHttp(request(), {
      DB: broken,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
    expect(response!.status).toBe(503)
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
  })

  describe('actual Worker dispatcher', () => {
    it.each([
      ['GET', '/api/admin/search-merchandising'],
      ['POST', '/api/admin/search-merchandising'],
      ['GET', '/api/admin/search-merchandising/commands/recovery-key'],
      ['PUT', '/api/admin/search-merchandising/10000000-0000-4000-8000-000000000001'],
      ['GET', '/api/admin/search-merchandising/10000000-0000-4000-8000-000000000001/history']
    ])('owns %s %s without falling through to an absent legacy route', async (method, path) => {
      const prepare = vi.fn(() => {
        throw new Error('Disabled administration must not read private data')
      })
      const response = await worker.fetch(new Request(`https://neteco.invalid${path}`, { method }), {
        APP_ENV: 'local',
        AUTH_ENABLED: 'false',
        DB: { prepare }
      } as unknown as CloudflareEnv)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(prepare).not.toHaveBeenCalled()
    })

    it('dispatches a recoverable command through the edge limiter and rejects the revoked session', async () => {
      const env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-dispatch-edge-pepper-over-32',
        NUXT_SESSION_PASSWORD: password,
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        DB: database
      } as unknown as CloudflareEnv
      const dispatch = (path: string, method = 'GET', payload?: unknown) =>
        worker.fetch(
          new Request(origin + path, {
            method,
            headers: {
              Cookie: cookie,
              Origin: origin,
              'CF-Connecting-IP': '192.0.2.182',
              'Content-Type': 'application/json',
              'Idempotency-Key': 'dispatch-merchandising'
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
          }),
          env
        )
      const committed = await dispatch('/api/admin/search-merchandising', 'POST', draft())
      expect(committed.status).toBe(201)
      const receipt = await committed.text()
      const recovered = await dispatch('/api/admin/search-merchandising/commands/dispatch-merchandising')
      expect(recovered.status).toBe(200)
      expect(await recovered.text()).toBe(receipt)
      expect(await (await dispatch('/api/admin/search-merchandising')).json()).toMatchObject({ total: 1 })
      sqlite
        .prepare("UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
        .run(CATEGORY_SESSION)
      expect((await dispatch('/api/admin/search-merchandising/commands/dispatch-merchandising')).status).toBe(401)
    })

    it('applies the shared administrative edge limiter before touching the database', async () => {
      const prepare = vi.fn(() => {
        throw new Error('Limited requests must not read the database')
      })
      const response = await worker.fetch(
        new Request(origin + '/api/admin/search-merchandising', { headers: { 'CF-Connecting-IP': '192.0.2.183' } }),
        {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          AUTH_ORIGIN: origin,
          AUTH_RATE_LIMIT_PEPPER: 'synthetic-dispatch-edge-pepper-over-32',
          ADMIN_EDGE_LIMIT: { limit: async () => ({ success: false }) },
          DB: { prepare }
        } as unknown as CloudflareEnv
      )
      expect(response.status).toBe(429)
      expect(prepare).not.toHaveBeenCalled()
    })
  })
})
