import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleD1AdminOrdersRequest, type AdminOrdersHttpDependencies } from '../../workers/catalog/admin-orders-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const NOW = '2026-09-30T09:00:00Z'
const ORIGIN = 'https://neteco.invalid'
const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'synthetic-origin-cookie-password-at-least-32-characters', maxAgeSeconds: 3600 }
const PATHS = [
  '/api/admin/orders',
  '/api/admin/stats',
  '/api/admin/operations',
  `/api/admin/orders/${crypto.randomUUID()}/detail`
] as const

describe('existing administrative GET origin boundary', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    database = d1OverSqlite(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','private-admin@example.invalid','private-password-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T08:00:00Z','2026-09-30T11:00:00Z');
      INSERT INTO roles VALUES ('admin','Admin','fixture');
      INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture');
      INSERT INTO role_permissions VALUES ('admin','administration.manage');
      INSERT INTO identity_roles(identity_id,role_code,granted_at)
        VALUES ('${IDENTITY}','admin','2026-09-01T00:00:00Z');
    `)
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function dependencies(overrides: Partial<AdminOrdersHttpDependencies> = {}): AdminOrdersHttpDependencies {
    return { database, sessionCookieConfiguration: COOKIE, origin: ORIGIN, now: NOW, ...overrides }
  }

  function untouchedDependencies(origin: unknown = ORIGIN) {
    const cookieConfiguration = vi.fn(() => {
      throw new Error('Private cookie diagnostics must not be read')
    })
    const prepare = vi.fn(() => {
      throw new Error('Private D1 diagnostics must not be read')
    })
    const deps = {
      origin,
      database: { ...database, prepare },
      get sessionCookieConfiguration() {
        return cookieConfiguration()
      },
      now: NOW
    } as unknown as AdminOrdersHttpDependencies
    return { deps, cookieConfiguration, prepare }
  }

  async function request(
    path: string = '/api/admin/stats',
    headers: HeadersInit = {},
    deps = dependencies(),
    urlOrigin = ORIGIN
  ) {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('cookie', cookie)
    return (await handleD1AdminOrdersRequest(new Request(`${urlOrigin}${path}`, { headers: requestHeaders }), deps))!
  }

  function expectPrivateHeaders(response: Response) {
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
    expect(response.headers.get('vary')).toBe('Cookie')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  }

  it.each([
    undefined,
    null,
    '',
    'not an origin',
    '/relative',
    'neteco.invalid',
    'http://neteco.invalid',
    'ftp://neteco.invalid',
    'data:text/plain,private',
    'https://neteco.invalid/',
    'https://neteco.invalid/path',
    'https://neteco.invalid?private=query',
    'https://neteco.invalid#private-fragment',
    'https://operator:private@neteco.invalid',
    'https://NETECO.invalid',
    'https://neteco.invalid:443',
    ' https://neteco.invalid',
    `https://${'a'.repeat(1990)}.invalid`
  ])('rejects malformed/noncanonical origin configuration before cookies or D1 (%s)', async (origin) => {
    const { deps, prepare, cookieConfiguration } = untouchedDependencies(origin)
    // undefined means a genuinely omitted/misconfigured dependency, not the
    // helper's normal default value.
    if (origin === undefined) Reflect.deleteProperty(deps, 'origin')
    const response = await request('/api/admin/stats', { origin: ORIGIN, host: 'neteco.invalid' }, deps)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
    expectPrivateHeaders(response)
  })

  it.each(PATHS)('rejects a foreign Origin before inspecting a cookie or D1 on %s', async (path) => {
    const { deps, prepare, cookieConfiguration } = untouchedDependencies()
    const response = await request(path, { origin: 'https://foreign.invalid' }, deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
    expectPrivateHeaders(response)
  })

  it.each([
    'null',
    '',
    'https://neteco.invalid/',
    'https://neteco.invalid:443',
    'https://neteco.invalid:8443',
    'http://neteco.invalid',
    'https://NETECO.invalid',
    'https://neteco.invalid/path',
    'https://neteco.invalid?query=private',
    'https://neteco.invalid.evil.invalid',
    'https://neteco.invalid, https://foreign.invalid'
  ])('does not normalize an explicit Origin header into configured authority (%s)', async (origin) => {
    const { deps, prepare, cookieConfiguration } = untouchedDependencies()
    const response = await request('/api/admin/stats', { origin }, deps)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
  })

  it('rejects duplicate Origin headers rather than selecting a trusted member', async () => {
    const headers = new Headers({ origin: ORIGIN })
    headers.append('origin', ORIGIN)
    const { deps, prepare, cookieConfiguration } = untouchedDependencies()
    const response = await request('/api/admin/stats', headers, deps)
    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
  })

  it.each(PATHS)('rejects cross-site fetch metadata even without Origin on %s', async (path) => {
    for (const origin of [undefined, ORIGIN]) {
      const headers: Record<string, string> = { 'sec-fetch-site': 'cross-site' }
      if (origin !== undefined) headers.origin = origin
      const { deps, prepare, cookieConfiguration } = untouchedDependencies()
      const response = await request(path, headers, deps)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
      expect(prepare).not.toHaveBeenCalled()
      expect(cookieConfiguration).not.toHaveBeenCalled()
    }
  })

  it.each(PATHS)('preserves sealed-cookie SSR/navigation reads without Origin on %s', async (path) => {
    const response = await request(path)
    expect(response.status).toBe(path.endsWith('/detail') ? 404 : 200)
    expectPrivateHeaders(response)
    if (path === '/api/admin/operations') {
      const body = (await response.json()) as { source: string; summary: { inventoryExceptions: number } }
      expect(body.source).toBe('cloudflare')
      expect(body.summary.inventoryExceptions).toBe(0)
    }
  })

  it.each([undefined, 'same-origin', 'same-site', 'none'])(
    'accepts a configured exact Origin with non-cross-site metadata (%s)',
    async (fetchSite) => {
      const headers: Record<string, string> = { origin: ORIGIN }
      if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite
      expect((await request('/api/admin/stats', headers)).status).toBe(200)
    }
  )

  it('requires an exact configured non-default HTTPS port when one is configured', async () => {
    const configured = 'https://neteco.invalid:8443'
    expect(
      (await request('/api/admin/stats', { origin: configured }, dependencies({ origin: configured }))).status
    ).toBe(200)
    expect((await request('/api/admin/stats', { origin: ORIGIN }, dependencies({ origin: configured }))).status).toBe(
      403
    )
  })

  it('does not derive authority from request URL, Host, Referer or forwarded headers', async () => {
    const forgedHeaders = {
      host: 'foreign.invalid',
      'x-forwarded-host': 'foreign.invalid',
      'x-forwarded-proto': 'http',
      forwarded: 'host=foreign.invalid;proto=http',
      referer: 'https://foreign.invalid/private',
      'x-origin': 'https://foreign.invalid'
    }
    expect(
      (
        await request(
          '/api/admin/stats',
          { ...forgedHeaders, origin: ORIGIN },
          dependencies(),
          'https://foreign.invalid'
        )
      ).status
    ).toBe(200)
    expect((await request('/api/admin/stats', forgedHeaders)).status).toBe(200)
    const { deps, prepare, cookieConfiguration } = untouchedDependencies()
    expect(
      (
        await request(
          '/api/admin/stats',
          { ...forgedHeaders, host: 'neteco.invalid', origin: 'https://foreign.invalid' },
          deps,
          'https://foreign.invalid'
        )
      ).status
    ).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])(
    'preserves immediate %s 405 without configuration/cookie/D1/body reads',
    async (method) => {
      for (const path of PATHS) {
        const { deps, prepare, cookieConfiguration } = untouchedDependencies(
          'http://invalid-configuration.invalid/private'
        )
        const incoming = new Request(`${ORIGIN}${path}`, {
          method,
          headers: { cookie, origin: 'https://foreign.invalid', 'sec-fetch-site': 'cross-site' },
          ...(method === 'HEAD' ? {} : { body: '{"token":"private-body-token","origin":"https://neteco.invalid"}' })
        })
        const response = (await handleD1AdminOrdersRequest(incoming, deps))!
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET')
        expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
        expect(incoming.bodyUsed).toBe(false)
        expect(prepare).not.toHaveBeenCalled()
        expect(cookieConfiguration).not.toHaveBeenCalled()
        expectPrivateHeaders(response)
      }
    }
  )

  it.each([
    '/api/products',
    '/api/admin/products',
    '/api/admin/media',
    '/api/admin/prices',
    '/api/admin/orders/example/status',
    '/api/admin/operations/other'
  ])('leaves another namespace %s untouched', async (path) => {
    const { deps, prepare, cookieConfiguration } = untouchedDependencies(null)
    const incoming = new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      body: 'private token',
      headers: { origin: 'https://foreign.invalid' }
    })
    expect(await handleD1AdminOrdersRequest(incoming, deps)).toBeNull()
    expect(incoming.bodyUsed).toBe(false)
    expect(prepare).not.toHaveBeenCalled()
    expect(cookieConfiguration).not.toHaveBeenCalled()
  })

  it('still requires live sealed-session authentication after an accepted Origin', async () => {
    const noCookie = await handleD1AdminOrdersRequest(
      new Request(`${ORIGIN}/api/admin/stats`, {
        headers: { origin: ORIGIN, 'x-session-id': SESSION, 'x-role': 'admin' }
      }),
      dependencies()
    )
    expect(noCookie?.status).toBe(401)
    expect(await noCookie?.json()).toEqual({ error: { code: 'unauthenticated' } })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, SESSION)
    const revoked = await request('/api/admin/stats', { origin: ORIGIN })
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toEqual({ error: { code: 'unauthenticated' } })
    expectPrivateHeaders(revoked)
  })

  it('returns sanitized private 503 on D1 outage after the accepted Origin guard', async () => {
    const unavailable = {
      ...database,
      prepare() {
        throw new Error('private SQL; password; quarantine URL')
      }
    } as unknown as D1Database
    const response = await request('/api/admin/stats', { origin: ORIGIN }, dependencies({ database: unavailable }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expectPrivateHeaders(response)
  })
})
