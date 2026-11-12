import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS, CATEGORY_IDENTITY } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSearchSynonymsHttp } from '../../workers/catalog/search-synonyms-http'
import { testNow } from '../support/deterministic'

describe('synonym private HTTP contract', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  const origin = 'https://synonyms.neteco.invalid',
    password = 'synthetic-only-cookie-password-32-characters'
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow() + 1000)
    ;({ sqlite, database } = await categoryCommandFixture())
    sqlite.function('synthetic_synonym_clock', () =>
      vi
        .getMockedSystemTime()!
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
    )
    const exec = sqlite.exec.bind(sqlite),
      prepare = database.prepare.bind(database)
    sqlite.exec = (sql: string) => exec(sql.replaceAll("'now'", 'synthetic_synonym_clock()'))
    database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'synthetic_synonym_clock()'))
    const triggers = sqlite
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'search_synonym_%' AND sql LIKE '%strftime%'"
      )
      .all() as Array<{ name: string; sql: string }>
    for (const trigger of triggers) {
      sqlite.exec(`DROP TRIGGER "${trigger.name}"`)
      sqlite.exec(trigger.sql)
    }
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_synonym_commands'").get())
      sqlite.exec(await readFile(new URL('../../db/d1/migrations/0061_search_synonyms.sql', import.meta.url), 'utf8'))
    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })
  const draft = {
    id: null,
    expectedVersion: 0,
    sourceTerm: 'lejía',
    replacements: ['hipoclorito'],
    active: true,
    reason: 'Vocabulario comercial revisado',
    action: 'save'
  }
  const request = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + '/api/admin/search-synonyms' + path, {
      method,
      headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'http-command', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const handle = (req: Request) =>
    handleSearchSynonymsHttp(req, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
  it('lists, previews, creates and GET-recovers the private command', async () => {
    const read = (await handle(request()))!
    expect(read.status).toBe(200)
    expect(read.headers.get('cache-control')).toBe('private, no-store')
    expect(await read.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0, page: 1, perPage: 25 })
    const p = (await (await handle(request('/preview', 'POST', { draft, query: 'lejía' })))!.json()) as {
      previewId: string
      previewHash: string
    }
    const response = (await handle(request('', 'POST', { previewId: p.previewId, previewHash: p.previewHash })))!
    expect(response.status).toBe(201)
    const receipt = await response.json()
    expect(await (await handle(request('/commands/http-command')))!.json()).toEqual(receipt)
    expect((await handle(request('/commands/unknown')))!.status).toBe(404)
  })
  it.each(['/%31', '/', '/extra/nested', '/%252e%252e', '?unknown=x', '?page=0', '?perPage=101', '?page=1&page=2'])(
    'rejects malformed paths/query %s without legacy fallthrough',
    async (path) => expect((await handle(request(path)))!.status).toBe(400)
  )
  it('rejects missing cookie, cross-site mutations, body shape and content budgets', async () => {
    expect((await handle(request('', 'GET', undefined, { cookie: '' })))!.status).toBe(401)
    expect(
      (await handle(request('/preview', 'POST', { draft, query: 'lejía' }, { origin: 'https://attacker.invalid' })))!
        .status
    ).toBe(403)
    expect(
      (await handle(request('/preview', 'POST', { draft, query: 'lejía' }, { 'sec-fetch-site': 'cross-site' })))!.status
    ).toBe(403)
    expect(
      (await handle(request('/preview', 'POST', { draft, query: 'lejía' }, { 'content-type': 'text/plain' })))!.status
    ).toBe(415)
    expect(
      (await handle(request('/preview', 'POST', { draft, query: 'lejía' }, { 'content-length': '100000' })))!.status
    ).toBe(413)
    expect((await handle(request('', 'POST', { unexpected: true })))!.status).toBe(422)
    expect((await handle(request('', 'POST', {}, { 'idempotency-key': '' })))!.status).toBe(400)
  })
  it('never intercepts another namespace', async () =>
    expect(await handle(new Request(origin + '/api/admin/search-synonyms-extra'))).toBeNull())
  it('enforces the shared command/preview quota and keeps read-only receipt recovery available', async () => {
    const instant = Math.floor(testNow() / 1000)
    sqlite
      .prepare(
        'INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at) VALUES (?, ?, 60, ?, ?)'
      )
      .run(CATEGORY_IDENTITY, 'search-synonym-commands', instant, instant + 3600)
    const limited = (await handle(request('/preview', 'POST', { draft, query: 'lejía' })))!
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await handle(request('/commands/unknown')))!.status).toBe(404)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_previews').get()).toEqual({ n: 0 })
  })
  it('refuses a create preview through another target or a retirement method', async () => {
    const p = (await (await handle(request('/preview', 'POST', { draft, query: 'lejía' })))!.json()) as {
      previewId: string
      previewHash: string
    }
    const body = { previewId: p.previewId, previewHash: p.previewHash }
    expect((await handle(request('/10000000-0000-4000-8000-000000000099', 'PUT', body)))!.status).toBe(422)
    expect((await handle(request('/10000000-0000-4000-8000-000000000099', 'DELETE', body)))!.status).toBe(422)
    expect(sqlite.prepare('SELECT count(*) n FROM search_synonym_commands').get()).toEqual({ n: 0 })
  })
})
