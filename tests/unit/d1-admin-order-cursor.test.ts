import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fulfillmentFixture, ACTOR, CLAIMS, SESSION, utc } from './d1-fulfillment-fixture'
import { listD1AdminOrders, type AdminOrderQuery } from '../../workers/catalog/admin-orders'
import { listD1AdminOrdersByCursor, type AdminOrderCursorPage } from '../../workers/catalog/admin-order-cursor'
import { handleD1AdminOrdersRequest } from '../../workers/catalog/admin-orders-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const CONFIG = { password: 'synthetic-cursor-secret-not-a-production-value-32', maxAgeSeconds: 3600 }
const ORIGIN = 'https://cursor.neteco.invalid'
const base: AdminOrderQuery = {
  page: 1,
  perPage: 2,
  q: '',
  bucket: 'todos',
  sortKey: 'createdAt',
  sortDir: 'desc'
}

describe('live, sealed, actor-bound administrative order keyset pages', () => {
  let fixture: Awaited<ReturnType<typeof fulfillmentFixture>>
  let now: string

  beforeEach(async () => {
    fixture = await fulfillmentFixture()
    now = utc()
    fixture.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-enrollment','[]',?,?)"
      )
      .run(ACTOR, utc(-60000), utc(-60000))
    for (let index = 0; index < 6; index++) await fixture.order(index % 2 ? 'own_delivery' : 'pickup', false)
  })
  afterEach(() => {
    vi.useRealTimers()
    fixture?.sqlite.close()
  })

  async function page(query: AdminOrderQuery = base, cursor: { after?: string; before?: string } = {}) {
    const result = await listD1AdminOrdersByCursor(fixture.database, CLAIMS, now, query, {
      password: CONFIG.password,
      ...cursor
    })
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('private_page_not_released')
    return result.data
  }

  it.each(
    (['id', 'createdAt', 'name', 'total'] as const).flatMap((sortKey) =>
      (['asc', 'desc'] as const).map((sortDir) => ({ sortKey, sortDir }))
    )
  )('walks both ways without duplicates for $sortKey/$sortDir, including equal sort values', async (sort) => {
    const query = { ...base, ...sort }
    const oracle = await listD1AdminOrders(fixture.database, CLAIMS, now, { ...query, perPage: 100 })
    if (oracle.outcome !== 'found') throw new Error('oracle_unavailable')
    const changes = fixture.sqlite.prepare('SELECT total_changes() AS n').get()
    const first = await page(query)
    expect(first.pagination).toMatchObject({ mode: 'cursor', page: 1, total: 6, pages: 3, previousCursor: null })
    expect(first.pagination.nextCursor).toEqual(expect.any(String))
    const second = await page({ ...query, page: 2 }, { after: first.pagination.nextCursor! })
    const third = await page({ ...query, page: 3 }, { after: second.pagination.nextCursor! })
    expect(third.pagination.nextCursor).toBeNull()
    expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(
      oracle.data.items.map((item) => item.id)
    )
    const back = await page({ ...query, page: 2 }, { before: third.pagination.previousCursor! })
    expect(back.items).toEqual(second.items)
    const beginning = await page(query, { before: back.pagination.previousCursor! })
    expect(beginning.items).toEqual(first.items)
    expect(beginning.pagination.previousCursor).toBeNull()
    expect(first.pagination.nextCursor).not.toContain('Original buyer')
    expect(first.pagination.nextCursor).not.toContain(ACTOR)
    expect(fixture.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
  })

  it('returns an honest empty first page and uses bounded keysets, never OFFSET', async () => {
    const seen: string[] = []
    const db = {
      ...fixture.database,
      prepare(sql: string) {
        seen.push(sql)
        return fixture.database.prepare(sql)
      }
    } as D1Database
    const result = await listD1AdminOrdersByCursor(db, CLAIMS, now, { ...base, q: 'absent@example.invalid' }, CONFIG)
    expect(result).toMatchObject({
      outcome: 'found',
      data: { items: [], pagination: { total: 0, pages: 0, mode: 'cursor', nextCursor: null, previousCursor: null } }
    })
    expect(seen.some((sql) => /\bLIMIT\b/i.test(sql))).toBe(true)
    expect(seen.some((sql) => /\bOFFSET\b/i.test(sql))).toBe(false)
  })

  it('binds tokens to every filter, sorting, page size and target page, with no arbitrary page jump', async () => {
    const first = await page()
    for (const change of [
      { q: 'buyer' },
      { bucket: 'por_cobrar' as const },
      { sortKey: 'total' as const },
      { sortDir: 'asc' as const },
      { perPage: 3 },
      { from: '2026-01-01' },
      { page: 3 }
    ])
      await expect(
        page({ ...base, page: 2, ...change }, { after: first.pagination.nextCursor! })
      ).rejects.toMatchObject({
        code: 'invalid_cursor'
      })
    await expect(page({ ...base, page: 2 })).rejects.toMatchObject({ code: 'invalid_cursor' })
    await expect(page(base, { before: first.pagination.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor' })
    await expect(page(base, { after: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'invalid_cursor' })
    await expect(page(base, { after: 'x', before: 'y' })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('rejects tampering, a session cookie as cursor, and a cursor as session cookie', async () => {
    const first = await page()
    const token = first.pagination.nextCursor!
    await expect(page({ ...base, page: 2 }, { after: token.slice(0, -8) + 'aaaaaaaa' })).rejects.toMatchObject({
      code: 'invalid_cursor'
    })
    const cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, CONFIG))!.split(';')[0]!
    await expect(
      page({ ...base, page: 2 }, { after: decodeURIComponent(cookie.split('=')[1]!) })
    ).rejects.toMatchObject({
      code: 'invalid_cursor'
    })
    const response = await handleD1AdminOrdersRequest(
      new Request(ORIGIN + '/api/admin/orders?pagination=cursor', {
        headers: { cookie: 'neteco-session=' + encodeURIComponent(token) }
      }),
      { database: fixture.database, origin: ORIGIN, sessionCookieConfiguration: CONFIG, now }
    )
    expect(response?.status).toBe(401)
  })

  it('rejects a cursor reused by another live session of the same actor', async () => {
    const first = await page()
    const otherSession = crypto.randomUUID()
    fixture.sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(otherSession, ACTOR, utc(-60000), utc(3600000))
    await expect(
      listD1AdminOrdersByCursor(
        fixture.database,
        { ...CLAIMS, sessionId: otherSession },
        now,
        { ...base, page: 2 },
        {
          password: CONFIG.password,
          after: first.pagination.nextCursor!
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('expires cursors after ten minutes without extending the session', async () => {
    const first = await page()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11 * 60000)
    await expect(
      listD1AdminOrdersByCursor(
        fixture.database,
        CLAIMS,
        utc(),
        { ...base, page: 2 },
        {
          password: CONFIG.password,
          after: first.pagination.nextCursor!
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('requires live enrolled MFA and rechecks authority after the read before releasing any private rows', async () => {
    fixture.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ACTOR)
    expect(await listD1AdminOrdersByCursor(fixture.database, CLAIMS, now, base, CONFIG)).toEqual({
      outcome: 'denied',
      code: 'mfa_required'
    })
    fixture.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic','[]',?,?)"
      )
      .run(ACTOR, utc(-60000), utc(-60000))
    const revokedDuringRead = {
      ...fixture.database,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await fixture.database.batch<T>(statements)
        fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now, SESSION)
        return result
      }
    } as D1Database
    expect(await listD1AdminOrdersByCursor(revokedDuringRead, CLAIMS, now, base, CONFIG)).toEqual({
      outcome: 'denied',
      code: 'unauthenticated'
    })
  })

  it('adds cursor HTTP navigation without changing the legacy list contract or leaking internal errors', async () => {
    const cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, CONFIG))!.split(';')[0]!
    const send = (search: string) =>
      handleD1AdminOrdersRequest(
        new Request(ORIGIN + '/api/admin/orders' + search, { headers: { cookie, origin: ORIGIN } }),
        { database: fixture.database, origin: ORIGIN, sessionCookieConfiguration: CONFIG, now }
      )
    const first = await send('?pagination=cursor&perPage=2')
    expect(first?.status).toBe(200)
    expect(first?.headers.get('cache-control')).toBe('private, no-store')
    const body = (await first!.json()) as AdminOrderCursorPage
    expect(body.pagination).toMatchObject({ mode: 'cursor', page: 1, total: 6 })
    const next = await send(
      '?pagination=cursor&perPage=2&page=2&after=' + encodeURIComponent(body.pagination.nextCursor!)
    )
    expect(next?.status).toBe(200)
    expect(((await next!.json()) as AdminOrderCursorPage).items.map((item) => item.id)).not.toEqual(
      body.items.map((item) => item.id)
    )
    for (const suffix of [
      '?pagination=offset',
      '?after=x',
      '?pagination=cursor&after=x&before=y',
      '?pagination=cursor&after=x&after=y'
    ]) {
      const invalid = await send(suffix)
      expect(invalid?.status).toBe(400)
      expect(await invalid?.json()).toEqual({ error: { code: 'invalid_input' } })
    }
    const legacy = await send('?perPage=2&page=2')
    expect(legacy?.status).toBe(200)
    expect(((await legacy!.json()) as { pagination: Record<string, unknown> }).pagination).not.toHaveProperty('mode')
  })

  it('rejects cursor reads on an unconfigured request authority before any private D1 access', async () => {
    const cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, CONFIG))!.split(';')[0]!
    const prepare = vi.fn(() => {
      throw new Error('unexpected_private_read')
    })
    const response = await handleD1AdminOrdersRequest(
      new Request('https://alternate.neteco.invalid/api/admin/orders?pagination=cursor', { headers: { cookie } }),
      { database: { prepare } as unknown as D1Database, origin: ORIGIN, sessionCookieConfiguration: CONFIG, now }
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
    expect(prepare).not.toHaveBeenCalled()
  })
})
