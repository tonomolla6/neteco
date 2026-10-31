import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSearchGapHttp, ownsSearchGapNamespace } from '../../workers/catalog/search-gap-programme-http'

describe('SEO-025 private HTTP contract', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  const origin = 'https://gaps.neteco.invalid',
    password = 'synthetic-only-cookie-password-32-characters'
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    for (const [table, file] of [
      ['search_synonym_commands', '0061_search_synonyms.sql'],
      ['search_merchandising_commands', '0091_search_merchandising_rules.sql'],
      ['search_analytics_daily', '0095_search_analytics.sql'],
      ['search_gap_cases', '0148_search_gap_programme.sql']
    ] as const)
      if (!sqlite.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))
        sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${file}`, import.meta.url), 'utf8'))
    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    const today = new Date()
    for (let d = 1; d <= 10; d++)
      sqlite
        .prepare(
          `INSERT INTO search_analytics_daily(day,term_normalized,device,segment,environment,searches_count,zero_results_count,updated_at)
           VALUES(?,?,'desktop','anonymous','production',5,5,'2026-10-29T00:00:00Z')`
        )
        .run(new Date(today.getTime() - d * 86_400_000).toISOString().slice(0, 10), 'quitasarros')
  })
  afterEach(() => sqlite.close())
  const req = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + '/api/admin/search-gaps' + path, {
      method,
      headers: { cookie, origin, 'content-type': 'application/json', 'idempotency-key': 'http-1', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const handle = (r: Request) =>
    handleSearchGapHttp(r, { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password })

  it('owns only its namespace, including encoded variants', () => {
    expect(ownsSearchGapNamespace('/api/admin/search-gaps')).toBe(true)
    expect(ownsSearchGapNamespace('/api/admin/search-gaps/backlog')).toBe(true)
    expect(ownsSearchGapNamespace('/api/admin/search%2Dgaps')).toBe(true)
    expect(ownsSearchGapNamespace('/api/admin/search-synonyms')).toBe(false)
  })
  it('serves backlog, opens a case idempotently and reads its measurement', async () => {
    const backlog = (await handle(req('/backlog')))!
    expect(backlog.status).toBe(200)
    expect(backlog.headers.get('cache-control')).toBe('private, no-store')
    expect((await backlog.json()).items[0]).toMatchObject({ term: 'quitasarros', zeroRate: 1 })
    const body = { action: 'open', environment: 'production', term: 'quitasarros' }
    const created = (await handle(req('', 'POST', body)))!
    expect(created.status).toBe(200)
    const { item } = await created.json()
    expect(item).toMatchObject({ status: 'open', version: 1 })
    expect(await (await handle(req('', 'POST', body)))!.json()).toEqual({ item })
    const measured = (await handle(req(`/${item.id}/measurement`)))!
    expect(await measured.json()).toMatchObject({ verdict: 'not_actioned' })
    expect((await (await handle(req('?status=open')))!.json()).items).toHaveLength(1)
  })
  it('maps domain errors to stable codes', async () => {
    expect(
      (await handle(req('', 'POST', { action: 'open', environment: 'production', term: 'inexistente' })))!.status
    ).toBe(422)
    expect(
      (await handle(
        req('', 'POST', { action: 'dismiss', id: crypto.randomUUID(), expectedVersion: 1, note: 'No existe' })
      ))!.status
    ).toBe(404)
    expect((await handle(req('', 'POST', { unexpected: true })))!.status).toBe(422)
  })
  it('rejects missing auth, cross-site writes, bad media types, bad keys, methods and queries', async () => {
    expect((await handle(req('/backlog', 'GET', undefined, { cookie: '' })))!.status).toBe(401)
    expect((await handle(req('', 'POST', {}, { origin: 'https://attacker.invalid' })))!.status).toBe(403)
    expect((await handle(req('', 'POST', {}, { 'sec-fetch-site': 'cross-site' })))!.status).toBe(403)
    expect((await handle(req('', 'POST', {}, { 'content-type': 'text/plain' })))!.status).toBe(415)
    expect((await handle(req('', 'POST', {}, { 'content-length': '100000' })))!.status).toBe(413)
    expect((await handle(req('', 'POST', {}, { 'idempotency-key': 'bad key' })))!.status).toBe(400)
    expect((await handle(req('/backlog', 'DELETE')))!.status).toBe(405)
    expect((await handle(req('/backlog?unknown=1')))!.status).toBe(400)
    expect((await handle(req('/backlog?days=1&days=2')))!.status).toBe(400)
    expect((await handle(req('/backlog?minSearches=1')))!.status).toBe(422)
    expect((await handle(req('/nope')))!.status).toBe(400)
  })
  it('returns 503 when authentication is disabled and ignores foreign paths', async () => {
    const off = await handleSearchGapHttp(req('/backlog'), {
      DB: database,
      AUTH_ENABLED: 'false',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password
    })
    expect(off!.status).toBe(503)
    expect(
      await handleSearchGapHttp(new Request(origin + '/api/other'), {
        DB: database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password
      })
    ).toBeNull()
  })
})
