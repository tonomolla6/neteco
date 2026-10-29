import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_IDENTITY, CMS_SESSION, cmsDocument } from './d1-cms-fixture'
import { readCmsEditorialCalendar } from '../../workers/cms/calendar'
import { cmsCalendarRange, cmsEditorialCalendarSchema } from '../../shared/cms-calendar'
import { handleCmsDraftHttp } from '../../workers/cms/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'

const origin = 'https://cms.neteco.invalid',
  password = 'synthetic-calendar-cookie-password-independent'
describe('D1 editorial calendar: approved history, Madrid boundaries and private alerts', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>, cookie: string
  beforeEach(async () => {
    f = await cmsPublicationFixture()
    cookie = (await issueD1SessionCookie(f.database, CMS_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => f.sqlite.close())
  function schedule(publishAt: string | null, unpublishAt: string | null = null, active = true) {
    const id = crypto.randomUUID()
    f.sqlite
      .prepare(
        `INSERT INTO content_schedules(id,page_id,version_id,actor_id,reason,publish_at,unpublish_at,created_at)
      VALUES (?,?,?,?,'Synthetic calendar approval',?,?,'2026-01-01T00:00:00Z')`
      )
      .run(id, f.created.pageId, f.created.versionId, CMS_IDENTITY, publishAt, unpublishAt)
    if (active)
      f.sqlite
        .prepare(
          `INSERT INTO content_publication_states(page_id,revision,publication_id,schedule_id,updated_at) VALUES (?,1,NULL,?,'2026-01-01T00:00:00Z')
      ON CONFLICT(page_id) DO UPDATE SET revision=revision+1,schedule_id=excluded.schedule_id,updated_at=excluded.updated_at`
        )
        .run(f.created.pageId, id)
    return id
  }
  function blocked(id: string, phase = 'publish', code = 'media_blocked') {
    f.sqlite
      .prepare(
        `INSERT INTO content_schedule_events(id,schedule_id,phase,outcome,code,created_at) VALUES (?,?,?,'blocked',?,'2026-09-01T00:01:00Z')`
      )
      .run(crypto.randomUUID(), id, phase, code)
  }
  const read = (input: unknown = { month: '2026-10' }) =>
    readCmsEditorialCalendar({ ...f.deps, now: () => '2026-10-03T12:00:00Z' }, CMS_CLAIMS, input)
  function withBatch(batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
    return new Proxy(f.database, {
      get: (target, key, receiver) => (key === 'batch' ? batch : Reflect.get(target, key, receiver))
    })
  }
  const env = () => ({ DB: f.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password })
  const request = (
    query = '?month=2026-10',
    headers: Record<string, string> = {},
    method = 'GET',
    path = '/api/admin/content/calendar'
  ) => new Request(`${origin}${path}${query}`, { method, headers: { cookie, ...headers } })

  it('uses real Madrid DST month boundaries including UTC dates outside the selected month', () => {
    expect(cmsCalendarRange('2026-03')).toEqual({ start: '2026-02-28T23:00:00Z', end: '2026-03-31T22:00:00Z' })
    expect(cmsCalendarRange('2026-10')).toEqual({ start: '2026-09-30T22:00:00Z', end: '2026-10-31T23:00:00Z' })
    expect(cmsCalendarRange('2099-12').end).toBe('2099-12-31T23:00:00Z')
  })
  it('confirmed empty calendar is distinct from read failure and defaults to Madrid month', async () => {
    const value = await read({})
    expect(value).toMatchObject({
      source: 'cloudflare',
      timeZone: 'Europe/Madrid',
      month: '2026-10',
      events: [],
      pagination: { total: 0, hasMore: false },
      alerts: { blockedCount: 0, dueCount: 0 }
    })
  })
  it('range is start-inclusive/end-exclusive; repeated Madrid hour has distinct offsets and instants', async () => {
    const inside = ['2026-09-30T22:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-31T22:59:59Z']
    for (const at of ['2026-09-30T21:59:59Z', ...inside, '2026-10-31T23:00:00Z']) schedule(at, null, false)
    const result = await read()
    expect(result.events.map((event) => event.scheduledAt)).toEqual(inside)
    expect(result.events[1]).toMatchObject({ localDateTime: '2026-10-25T02:30:00', utcOffsetMinutes: 120 })
    expect(result.events[2]).toMatchObject({ localDateTime: '2026-10-25T02:30:00', utcOffsetMinutes: 60 })
    expect(result.events.every((event) => event.status === 'superseded')).toBe(true)
  })
  it('each phase is counted and paginated exactly; identical dates have deterministic ordering', async () => {
    for (let index = 0; index < 16; index++) schedule('2026-10-20T08:00:00Z', '2026-10-21T08:00:00Z', false)
    const one = await read({ month: '2026-10', page: 1, perPage: 25 }),
      two = await read({ month: '2026-10', page: 2, perPage: 25 })
    expect(one.pagination).toEqual({ page: 1, perPage: 25, total: 32, hasMore: true })
    expect(two.events).toHaveLength(7)
    expect(new Set([...one.events, ...two.events].map((event) => `${event.scheduleId}:${event.phase}`)).size).toBe(32)
    expect((await read({ month: '2026-10', page: 3 })).events).toEqual([])
    expect((await read()).events).toEqual(one.events)
  })
  it('shows frozen approved version title/slug, not later edits to its draft', async () => {
    schedule('2026-10-20T08:00:00Z')
    await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: f.created.pageId },
      { ...cmsDocument({ title: 'Nuevo borrador privado', slug: 'nuevo-borrador' }), expectedVersion: 1 },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect((await read()).events[0]).toMatchObject({
      title: 'Guía editorial',
      slug: 'guia-editorial',
      version: 1,
      versionId: f.created.versionId
    })
  })
  it('old-month blocked phase stays globally visible; due is pending without fabricating a cron failure', async () => {
    const id = schedule('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')
    blocked(id)
    const result = await read()
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ phase: 'unpublish', status: 'due', code: null, recordedAt: null })
    expect(result.alerts).toMatchObject({ blockedCount: 1, dueCount: 1, hasMore: false })
    expect(result.alerts.blockedEvents[0]).toMatchObject({
      scheduleId: id,
      status: 'blocked',
      active: true,
      localDateTime: '2026-09-01T02:00:00'
    })
    schedule('2026-10-20T08:00:00Z')
    expect((await read()).alerts).toMatchObject({ blockedCount: 0, dueCount: 0, blockedEvents: [] })
    expect((await read({ month: '2026-09' })).events[0]).toMatchObject({ status: 'blocked', active: false })
  })
  it('applied history remains applied after cancellation, but unexecuted phase is cancelled', async () => {
    const id = schedule('2026-09-01T00:00:00Z', '2026-10-20T08:00:00Z'),
      publication = crypto.randomUUID()
    f.sqlite
      .prepare(
        `INSERT INTO content_publications VALUES (?,?,?,?,?,'Synthetic approved publication','2026-09-01T00:00:00Z')`
      )
      .run(publication, f.created.pageId, f.created.versionId, 'guia-editorial', CMS_IDENTITY)
    f.sqlite
      .prepare(
        `INSERT INTO content_schedule_events(id,schedule_id,phase,outcome,publication_id,created_at) VALUES (?,?,'publish','applied',?,'2026-09-01T00:00:00Z')`
      )
      .run(crypto.randomUUID(), id, publication)
    f.sqlite
      .prepare(
        `INSERT INTO content_schedule_events(id,schedule_id,phase,outcome,created_at) VALUES (?,?,'cancel','cancelled','2026-09-02T00:00:00Z')`
      )
      .run(crypto.randomUUID(), id)
    f.sqlite
      .prepare(`UPDATE content_publication_states SET revision=revision+1,schedule_id=NULL WHERE page_id=?`)
      .run(f.created.pageId)
    expect((await read({ month: '2026-09' })).events[0]).toMatchObject({
      status: 'applied',
      active: false,
      recordedAt: '2026-09-01T00:00:00Z'
    })
    expect((await read()).events[0]).toMatchObject({
      status: 'cancelled',
      active: false,
      recordedAt: '2026-09-02T00:00:00Z'
    })
  })
  it('snapshot is one read-only batch and rechecks live authorization after awaited read', async () => {
    schedule('2026-10-20T08:00:00Z')
    const batch = f.database.batch,
      original = f.sqlite.prepare('SELECT count(*) AS n FROM content_publication_commands').get()?.n
    let calls = 0
    const database = withBatch(async (statements: D1PreparedStatement[]) => {
      calls++
      const result = await batch(statements)
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CMS_SESSION)
      return result
    })
    await expect(readCmsEditorialCalendar({ ...f.deps, database }, CMS_CLAIMS, {})).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(calls).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publication_commands').get()?.n).toBe(original)
  })
  it.each(['forbidden', 'mfa_required', 'email_unverified', 'unauthenticated'])(
    'rejects %s before reading schedule rows',
    async (code) => {
      if (code === 'forbidden') f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
      if (code === 'mfa_required')
        f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CMS_SESSION)
      if (code === 'email_unverified')
        f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CMS_IDENTITY)
      if (code === 'unauthenticated')
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CMS_SESSION)
      const database = withBatch(async () => {
        throw new Error('Private rows should never be queried')
      })
      await expect(readCmsEditorialCalendar({ ...f.deps, database }, CMS_CLAIMS, {})).rejects.toMatchObject({ code })
    }
  )
  it('outage or malformed read is not a confirmed empty result', async () => {
    const database = withBatch(async () => [])
    await expect(readCmsEditorialCalendar({ ...f.deps, database }, CMS_CLAIMS, {})).rejects.toMatchObject({
      code: 'read_unconfirmed'
    })
  })
  it('calendar HTTP is sealed-cookie authenticated, uncached, feature-gated and performs no command', async () => {
    expect((await handleCmsDraftHttp(request(), env()))?.status).toBe(501)
    const value = await handleCmsDraftHttp(request(), env(), { publication: f.deps })
    expect(value?.status).toBe(200)
    expect(value?.headers.get('cache-control')).toBe('private, no-store')
    expect(value?.headers.get('vary')).toBe('Cookie')
    expect(value?.headers.get('x-robots-tag')).toContain('noindex')
    expect(cmsEditorialCalendarSchema.safeParse(await value!.json()).success).toBe(true)
    expect((await handleCmsDraftHttp(request('', { cookie: '' }), env(), { publication: f.deps }))?.status).toBe(401)
    expect(
      (await handleCmsDraftHttp(request(), { ...env(), AUTH_ENABLED: 'false' }, { publication: f.deps }))?.status
    ).toBe(503)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publication_commands').get()?.n).toBe(0)
  })
  it.each([
    '?month=2026-13',
    '?month=26-10',
    '?month=2026-10&month=2026-11',
    '?page=0',
    '?page=1e2',
    '?perPage=101',
    '?page=1000001',
    '?instant=2026-10-03',
    '?month=2026-10%27%3BDROP%20TABLE%20content_pages'
  ])('rejects hostile or noncanonical calendar query %s', async (query) => {
    const value = await handleCmsDraftHttp(request(query), env(), { publication: f.deps })
    expect(value?.status).toBe(400)
    expect(await value?.json()).toEqual({ error: { code: 'invalid_input' } })
  })
  it('exact namespace never falls back to legacy CMS; no cross-site access or mutation route', async () => {
    for (const path of [
      '/api/admin/content/%63alendar',
      '/api/admin/content/calendar/extra',
      '/api/admin/content/calendar/'
    ])
      expect((await handleCmsDraftHttp(request('', {}, 'GET', path), env(), { publication: f.deps }))?.status).toBe(400)
    expect((await handleCmsDraftHttp(request('', {}, 'POST'), env(), { publication: f.deps }))?.status).toBe(405)
    expect(
      (await handleCmsDraftHttp(request('', { origin: 'https://outsider.invalid' }), env(), { publication: f.deps }))
        ?.status
    ).toBe(403)
    expect(
      (await handleCmsDraftHttp(request('', { 'sec-fetch-site': 'cross-site' }), env(), { publication: f.deps }))
        ?.status
    ).toBe(403)
  })
})
