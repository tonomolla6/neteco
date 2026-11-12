import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleAnalyticsHttp,
  ownsAnalyticsNamespace,
  type AnalyticsHttpDependencies
} from '../../workers/analytics/http'
import { analyticsSnapshotSchema, analyticsReconciliationSchema } from '../../shared/analytics-measurement'
import { testUuid, testNow } from '../support/deterministic'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  vi.restoreAllMocks()
})
const origin = 'https://analytics.neteco.test',
  utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const claims = {
  identityId: '10000000-0000-4000-8000-000000000052',
  sessionId: '20000000-0000-4000-8000-000000000052',
  sessionVersion: 1
}
const consent = 'neteco-consent-v1=' + encodeURIComponent(JSON.stringify({ version: 'v1', analytics: true }))
async function fixture() {
  const sqlite = await openMigratedDatabase()
  opened.push(sqlite)
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='analytics_client_events'").get())
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0052_analytics_measurement.sql', import.meta.url), 'utf8')
    )
  sqlite.limits.exprDepth = 100
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0081_promotional_analytics.sql', import.meta.url), 'utf8'))
  sqlite.limits.variableNumber = 100
  const now = utc(),
    before = utc(-60000),
    database = d1OverSqlite(sqlite)
  sqlite.exec(`INSERT INTO roles VALUES('analytics_operator','Analytics operator','Synthetic');
    INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic existing grant');
    INSERT INTO role_permissions VALUES('analytics_operator','administration.manage');
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${claims.identityId}','analytics-operator@example.invalid','synthetic','${before}','active','${before}','${before}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${claims.sessionId}','${claims.identityId}',1,1,'${before}','${utc(3600000)}');
    INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${claims.identityId}','analytics_operator','${before}');`)
  const configuration = { password: 'synthetic-analytics-session-password-0123456789abcdef', maxAgeSeconds: 3600 }
  const cookie = (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
  const deps: AnalyticsHttpDependencies = {
    database,
    origin,
    environment: 'local',
    enabled: true,
    policy: {
      reference: 'synthetic-analytics-policy',
      version: 'v1',
      purpose: 'first_party_measurement',
      consentVersion: 'v1',
      retentionDays: 1,
      environment: 'local',
      approvedAt: before
    },
    sessionPepper: new Uint8Array(32).fill(7),
    sessionCookieConfiguration: configuration,
    now: () => now,
    edgeGate: vi.fn(async () => 'allowed' as const)
  }
  const query = '?' + new URLSearchParams({ from: utc(-3600000), to: utc(3600000) }),
    event = {
      eventId: testUuid(),
      name: 'search_completed',
      taxonomyVersion: 'v1',
      occurredAt: now,
      properties: { query: 'detergente', resultCount: 0 }
    }
  const request = (
    path = '/api/admin/analytics' + query,
    method = 'GET',
    payload?: unknown,
    cookies = cookie,
    headers: Record<string, string> = {}
  ) =>
    new Request(origin + path, {
      method,
      headers: {
        origin,
        'cf-connecting-ip': '192.0.2.52',
        ...(cookies ? { cookie: cookies } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    })
  const dispatch = (request: Request) => handleAnalyticsHttp(request, deps)
  return { sqlite, database, deps, cookie, query, event, request, dispatch }
}
describe('native analytics HTTP authorities and legacy client contracts', () => {
  it.each([
    '/api/analytics/events',
    '/api/analytics/session',
    '/api/admin/analytics',
    '/api/admin/analytics/reconciliation',
    '/api/%61nalytics/events',
    '/api/admin/%2561nalytics',
    '/api/analytics%2fevents',
    '/api/admin/analytics%ZZ',
    '/API/Analytics/events',
    '/API/ADMIN/ANALYTICS'
  ])('claims canonical and encoded namespace %s', (path) => expect(ownsAnalyticsNamespace(path)).toBe(true))
  it.each(['/api/products', '/api/analytics-other', '/api/admin/analytics-other', '/analytics'])(
    'does not claim unrelated route %s',
    (path) => expect(ownsAnalyticsNamespace(path)).toBe(false)
  )
  it('OFF never touches SQL, request body, cookie or policy', async () => {
    const f = await fixture()
    f.deps.enabled = false
    f.deps.database = {
      prepare: () => {
        throw Error('No OFF SQL')
      }
    } as D1Database
    Object.defineProperty(f.deps, 'policy', {
      get: () => {
        throw Error('No OFF policy')
      }
    })
    const request = f.request('/api/analytics/events', 'POST', f.event, consent)
    Object.defineProperty(request, 'body', {
      get: () => {
        throw Error('No OFF body')
      }
    })
    const get = vi.spyOn(request.headers, 'get')
    get.mockImplementation((name) => {
      if (name === 'cookie') throw Error('No OFF cookie')
      return null
    })
    const result = await f.dispatch(request)
    expect(result?.status).toBe(503)
    expect(await result?.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
  it('withdrawal clears only analytics cookie while acquisition/policy/database are OFF', async () => {
    const f = await fixture()
    f.deps.enabled = false
    f.deps.policy = null
    f.deps.database = {
      prepare: () => {
        throw Error('No withdrawal SQL')
      }
    } as D1Database
    const result = await f.dispatch(f.request('/api/analytics/session', 'DELETE', undefined, consent))
    expect(result?.status).toBe(204)
    expect(await result?.text()).toBe('')
    expect(result?.headers.get('set-cookie')).toMatch(
      /^neteco-analytics-id=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/
    )
    expect(result?.headers.get('set-cookie')).not.toContain('neteco-consent-v1')
  })
  it('requires dedicated edge control before acquisition body, but never blocks withdrawal', async () => {
    const f = await fixture()
    f.deps.edgeGate = undefined
    const request = f.request('/api/analytics/events', 'POST', f.event, consent)
    Object.defineProperty(request, 'body', {
      get: () => {
        throw Error('Never parse before edge')
      }
    })
    expect((await f.dispatch(request))?.status).toBe(503)
    f.deps.edgeGate = vi.fn(async () => 'limited')
    const limited = await f.dispatch(f.request('/api/analytics/session', 'DELETE'))
    expect(limited?.status).toBe(204)
    expect(limited?.headers.get('set-cookie')).toContain('Max-Age=0')
  })
  it('requires consent before reading any client body', async () => {
    const f = await fixture(),
      request = f.request('/api/analytics/events', 'POST', f.event, '')
    Object.defineProperty(request, 'body', {
      get: () => {
        throw Error('No nonconsented body')
      }
    })
    const result = await f.dispatch(request)
    expect(result?.status).toBe(403)
    expect(await result?.json()).toEqual({ error: { code: 'consent_required' } })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM analytics_client_events').get()).toEqual({ n: 0 })
  })
  it('accepts/deduplicates the Node v1 event and never persists raw query, cookie, IP or identity', async () => {
    const f = await fixture(),
      first = await f.dispatch(f.request('/api/analytics/events', 'POST', f.event, consent))
    expect(first?.status).toBe(202)
    expect(await first?.json()).toEqual({ accepted: true })
    if (!first) throw Error('analytics_response_unconfirmed')
    const anonymous = first.headers.get('set-cookie')?.split(';')[0]
    expect(anonymous).toMatch(/^neteco-analytics-id=[0-9a-f-]{36}$/)
    const replay = await f.dispatch(f.request('/api/analytics/events', 'POST', f.event, consent + '; ' + anonymous))
    expect(replay?.status).toBe(202)
    expect(await replay?.json()).toEqual({ accepted: true })
    const rows = f.sqlite.prepare('SELECT * FROM analytics_client_events').all()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toMatch(
      /detergente|192\.0\.2\.52|analytics-operator|neteco-session|neteco-consent/
    )
    expect(JSON.stringify(rows)).not.toContain(anonymous.split('=')[1])
  })
  it.each(['cliente@example.com', '600123456', '12345678Z'])(
    'rejects likely personal search text %s without effects',
    async (query) => {
      const f = await fixture(),
        result = await f.dispatch(
          f.request('/api/analytics/events', 'POST', { ...f.event, properties: { query, resultCount: 0 } }, consent)
        )
      expect(result?.status).toBe(400)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM analytics_client_events').get()).toEqual({ n: 0 })
    }
  )
  it('rejects stale timestamp, expanded JSON and event-id conflict without duplicate effects', async () => {
    const f = await fixture()
    for (const payload of [
      { ...f.event, occurredAt: utc(-2 * 86400000) },
      { ...f.event, properties: { ...f.event.properties, email: 'extra' } }
    ])
      expect((await f.dispatch(f.request('/api/analytics/events', 'POST', payload, consent)))?.status).toBe(400)
    expect((await f.dispatch(f.request('/api/analytics/events', 'POST', f.event, consent)))?.status).toBe(202)
    expect(
      (
        await f.dispatch(
          f.request(
            '/api/analytics/events',
            'POST',
            { ...f.event, properties: { query: 'otro', resultCount: 1 } },
            consent
          )
        )
      )?.status
    ).toBe(409)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM analytics_client_events').get()).toEqual({ n: 1 })
  })
  it('excludes bot/private page without assigning measurement cookies', async () => {
    const f = await fixture()
    for (const [event, headers] of [
      [f.event, { 'user-agent': 'Known crawler' }],
      [{ ...f.event, name: 'page_view', properties: { path: '/cuenta/pedidos' } }, {}]
    ] as const) {
      const result = await f.dispatch(f.request('/api/analytics/events', 'POST', event, consent, headers))
      expect(result?.status).toBe(202)
      expect(await result?.json()).toEqual({ accepted: false })
      expect(result?.headers.get('set-cookie')).toBeNull()
    }
  })
  it.each(['revoke', 'email', 'mfa', 'grant', 'version'])(
    'administrative reads require live %s authority',
    async (kind) => {
      const f = await fixture()
      if (kind === 'revoke') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(utc())
      if (kind === 'email') f.sqlite.exec('UPDATE identities SET email_verified_at=NULL')
      if (kind === 'mfa') f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      if (kind === 'grant') f.sqlite.exec('DELETE FROM role_permissions')
      if (kind === 'version') f.sqlite.exec('UPDATE identities SET session_version=2')
      const result = await f.dispatch(f.request())
      expect(result?.status).toBe(['revoke', 'version'].includes(kind) ? 401 : 403)
      expect(await result?.json()).toHaveProperty('error.code')
    }
  )
  it('requires actual sealed session, never consent or bare claims/body', async () => {
    const f = await fixture()
    for (const cookie of ['', consent, 'neteco-session=forged', `sessionId=${claims.sessionId}`])
      expect((await f.dispatch(f.request(undefined, 'GET', undefined, cookie)))?.status).toBe(401)
  })
  it('provides strictly confirmed private summaries and reconciliation, without GET writes', async () => {
    const f = await fixture(),
      before = f.sqlite.prepare('SELECT total_changes() AS n').get()
    const summary = await f.dispatch(f.request()),
      reconciliation = await f.dispatch(f.request('/api/admin/analytics/reconciliation' + f.query))
    expect(summary?.status).toBe(200)
    expect(reconciliation?.status).toBe(200)
    expect(analyticsSnapshotSchema.safeParse(await summary?.json()).success).toBe(true)
    expect(analyticsReconciliationSchema.safeParse(await reconciliation?.json()).success).toBe(true)
    expect(summary?.headers.get('cache-control')).toMatch(/private.*no-store/)
    expect(f.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })
  it.each([
    '',
    '?from=2026-10-01&to=2026-10-02',
    '?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00Z',
    '?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z',
    '?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z'
  ])('rejects absent/noncanonical/unbounded UTC range %s', async (query) => {
    const f = await fixture()
    expect((await f.dispatch(f.request('/api/admin/analytics' + query)))?.status).toBe(400)
  })
  it.each(['&page=0', '&perPage=51', '&page=1000001', '&page=1&page=2', '&token=private', '&from=extra'])(
    'rejects expanded/duplicate/pagination query %s',
    async (suffix) => {
      const f = await fixture()
      expect((await f.dispatch(f.request('/api/admin/analytics' + f.query + suffix)))?.status).toBe(400)
    }
  )
  it('rejects cross-site reads/writes and mutation/encoded aliases without fallback', async () => {
    const f = await fixture()
    expect(
      (await f.dispatch(f.request(undefined, 'GET', undefined, f.cookie, { origin: 'https://foreign.neteco.test' })))
        ?.status
    ).toBe(403)
    expect(
      (
        await f.dispatch(
          f.request('/api/analytics/events', 'POST', f.event, consent, { 'sec-fetch-site': 'cross-site' })
        )
      )?.status
    ).toBe(403)
    expect((await f.dispatch(f.request('/api/admin/analytics', 'POST', {})))?.status).toBe(405)
    expect((await f.dispatch(f.request('/api/admin/%2561nalytics')))?.status).toBe(400)
    expect(await f.dispatch(f.request('/api/products'))).toBeNull()
  })
  it('does not emit cached facts when grant disappears during awaited read', async () => {
    const f = await fixture(),
      original = f.database.prepare.bind(f.database)
    f.deps.database = {
      ...f.database,
      prepare(sql: string) {
        const statement = original(sql)
        if (!sql.includes('FROM analytics_')) return statement
        return {
          ...statement,
          bind(...parameters: unknown[]) {
            const bound = statement.bind(...parameters)
            return {
              ...bound,
              async all<T>() {
                const result = await bound.all<T>()
                f.sqlite.exec('DELETE FROM role_permissions')
                return result
              }
            }
          }
        } as D1PreparedStatement
      }
    } as D1Database
    const result = await f.dispatch(f.request())
    expect(result?.status).toBe(403)
    expect(await result?.json()).toEqual({ error: { code: 'forbidden' } })
  })
})
