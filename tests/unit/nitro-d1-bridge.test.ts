import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import { dispatchNitroD1Request, isD1ApiPath } from '../../workers/runtime/nitro-bridge'
import type { NitroCloudflarePlatform } from '../../workers/runtime/nitro-bridge'
import middleware from '../../server-cloudflare/middleware/00.d1-api'
import { checkAdministrativeEdgeLimit } from '../../workers/auth/edge-limit'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { randomBytes, randomUUID } from 'node:crypto'

const { fetchD1 } = vi.hoisted(() => ({ fetchD1: vi.fn() }))
vi.mock('../../workers/canary', () => ({ default: { fetch: fetchD1 } }))
beforeEach(() => {
  fetchD1.mockReset()
})

function platform(): NitroCloudflarePlatform {
  return {
    request: new Request('https://shop.neteco.invalid/catalogo', { headers: { cookie: 'neteco-session=opaque' } }),
    env: { DB: {} } as CloudflareEnv
  }
}

async function authenticatedNavigationFixture() {
  const sqlite = await openMigratedDatabase()
  try {
    const database = d1OverSqlite(sqlite)
    const context = platform()
    context.env = { DB: database } as CloudflareEnv
    context.request.headers.set('cf-connecting-ip', '192.0.2.10')
    context.request.headers.set('sec-fetch-site', 'cross-site')
    context.request.headers.set('sec-fetch-mode', 'navigate')
    context.request.headers.set('sec-fetch-dest', 'document')
    const configuration = {
      password: randomBytes(32).toString('hex'),
      maxAgeSeconds: 3600,
      origin: new URL(context.request.url).origin,
      tokenPepper: randomBytes(32).toString('hex'),
      encryptionKey: randomBytes(32).toString('base64')
    }
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const expires = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const identityId = randomUUID()
    const customerId = randomUUID()
    const sessionId = randomUUID()
    sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES (?,?,?,?)')
      .run(customerId, 'Navigation Customer', now, now)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,customer_id,created_at,updated_at) VALUES (?, 'navigation@example.invalid', 'synthetic', 'active', ?, ?, ?)"
      )
      .run(identityId, customerId, now, now)
    sqlite
      .prepare('INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES (?,?,1,?,?)')
      .run(sessionId, identityId, now, expires)
    const issued = await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, configuration)
    expect(issued).toBeTruthy()
    const cookie = issued!.split(';')[0]!
    const headers = {
      cookie,
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-user': '?1'
    }
    fetchD1.mockImplementation(async (request: Request) => {
      return handleAuthenticationHttp(request, {
        database,
        edgeLimiter: { limit: async () => ({ success: true }) },
        configuration: () => configuration
      })
    })
    return { sqlite, context, configuration, cookie, headers, identityId, sessionId }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

describe('Nitro SSR to authoritative D1 Worker bridge', () => {
  it('owns the complete API namespace but not pages, icon assets or lookalike prefixes', async () => {
    expect(isD1ApiPath('/api')).toBe(true)
    expect(isD1ApiPath('/api/_auth/session')).toBe(true)
    for (const path of ['/catalogo', '/_icons/lucide', '/apiculture']) {
      expect(isD1ApiPath(path)).toBe(false)
      expect(await dispatchNitroD1Request(new Request(`https://ignored.invalid${path}`), platform())).toBeUndefined()
    }
    expect(fetchD1).not.toHaveBeenCalled()
  })

  it('fails closed without trusted request-scoped bindings instead of falling back to PostgreSQL', async () => {
    const response = await dispatchNitroD1Request(new Request('https://ignored.invalid/api/_auth/session'), undefined)
    expect(response?.status).toBe(503)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(await response?.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(fetchD1).not.toHaveBeenCalled()
  })

  it('uses the platform origin, preserves query/cookie/method/body, and returns response and set-cookie unchanged', async () => {
    const context = platform()
    const result = new Response('{"ok":true}', {
      headers: { 'set-cookie': 'neteco-session=next; HttpOnly', 'cache-control': 'no-store' }
    })
    fetchD1.mockResolvedValue(result)
    const response = await dispatchNitroD1Request(
      new Request('https://spoofed.invalid/api/auth/login?next=1', {
        method: 'POST',
        headers: {
          cookie: 'neteco-session=opaque',
          origin: 'https://cross-site.invalid',
          'content-type': 'application/json',
          'x-forwarded-host': 'spoofed.invalid'
        },
        body: '{"email":"customer@example.invalid"}'
      }),
      context
    )
    expect(response).toBe(result)
    expect(fetchD1).toHaveBeenCalledOnce()
    const [request, env] = fetchD1.mock.calls[0] as [Request, CloudflareEnv]
    expect(request.url).toBe('https://shop.neteco.invalid/api/auth/login?next=1')
    expect(request.method).toBe('POST')
    expect(request.headers.get('cookie')).toBe('neteco-session=opaque')
    expect(request.headers.get('origin')).toBe('https://cross-site.invalid')
    expect(await request.text()).toBe('{"email":"customer@example.invalid"}')
    expect(env).toBe(context.env)
  })

  it('keeps request-scoped environments isolated during overlapping SSR requests', async () => {
    const first = platform()
    const second = { ...platform(), env: { DB: { second: true } } as unknown as CloudflareEnv }
    fetchD1.mockImplementation(async (_request: Request, env: CloudflareEnv) => {
      await Promise.resolve()
      return Response.json({ second: env === second.env })
    })
    const responses = await Promise.all([
      dispatchNitroD1Request(new Request('https://ignored.invalid/api/products'), first),
      dispatchNitroD1Request(new Request('https://ignored.invalid/api/products'), second)
    ])
    expect(await responses[0]?.json()).toEqual({ second: false })
    expect(await responses[1]?.json()).toEqual({ second: true })
  })

  it('restores only the trusted platform edge IP when an internal request omits or spoofs it', async () => {
    const context = platform()
    context.request.headers.set('cf-connecting-ip', '192.0.2.10')
    fetchD1.mockResolvedValue(Response.json({ ok: true }))
    for (const headers of [{}, { 'cf-connecting-ip': '198.51.100.99' }]) {
      await dispatchNitroD1Request(new Request('https://ignored.invalid/api/account/favorites', { headers }), context)
    }
    for (const [request] of fetchD1.mock.calls as [Request, CloudflareEnv][]) {
      expect(request.headers.get('cf-connecting-ip')).toBe('192.0.2.10')
    }
  })

  it('removes a forged internal IP when the platform has none, leaving edge guards fail-closed', async () => {
    const limit = vi.fn(async () => ({ success: true }))
    fetchD1.mockImplementation(async (request: Request) => {
      const outcome = await checkAdministrativeEdgeLimit(
        request,
        { limit },
        'test-only-pepper-more-than-32-characters',
        'admin-orders'
      )
      return Response.json(
        { edgeAddress: request.headers.get('cf-connecting-ip'), outcome },
        { status: outcome === 'allowed' ? 200 : 503 }
      )
    })
    const response = await dispatchNitroD1Request(
      new Request('https://ignored.invalid/api/admin/orders', {
        headers: { 'cf-connecting-ip': '198.51.100.99' }
      }),
      platform()
    )
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ edgeAddress: null, outcome: 'unavailable' })
    expect(limit).not.toHaveBeenCalled()
  })

  it('bridges the real H3 middleware before any later generated session handler can run', async () => {
    const context = platform()
    const laterHandler = vi.fn(() => ({ legacy: true }))
    const app = createApp({
      onRequest(event) {
        event.context.cloudflare = context
      }
    })
    app.use(middleware)
    app.use(defineEventHandler(laterHandler))
    fetchD1.mockResolvedValue(Response.json({ user: null }, { headers: { 'cache-control': 'no-store' } }))
    const response = await toWebHandler(app)(
      new Request('https://ignored.invalid/api/_auth/session', {
        headers: { cookie: 'neteco-session=opaque' }
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ user: null })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(laterHandler).not.toHaveBeenCalled()
    expect(fetchD1.mock.calls[0]?.[0].headers.get('cookie')).toBe('neteco-session=opaque')
    expect(fetchD1.mock.calls[0]?.[1]).toBe(context.env)
  })

  it('refreshes a real D1 session on a server-side API read after an external document navigation', async () => {
    const fixture = await authenticatedNavigationFixture()
    try {
      const response = await dispatchNitroD1Request(
        new Request(`${fixture.configuration.origin}/api/_auth/session`, { headers: fixture.headers }),
        fixture.context
      )
      expect(response?.status).toBe(200)
      expect(await response?.json()).toMatchObject({
        user: { id: fixture.identityId, name: 'Navigation Customer' },
        sessionId: fixture.sessionId
      })
      const forwarded = fetchD1.mock.calls[0]![0] as Request
      expect([...forwarded.headers.keys()].some((name) => name.startsWith('sec-fetch-'))).toBe(false)
      expect(forwarded.headers.get('cookie')).toBe(fixture.cookie)
      expect(forwarded.headers.get('origin')).toBeNull()
    } finally {
      fixture.sqlite.close()
    }
  })

  it('does not normalize cross-site API writes even during a valid document navigation', async () => {
    const fixture = await authenticatedNavigationFixture()
    try {
      const response = await dispatchNitroD1Request(
        new Request(`${fixture.configuration.origin}/api/auth/logout`, {
          method: 'POST',
          headers: { ...fixture.headers, origin: fixture.configuration.origin }
        }),
        fixture.context
      )
      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
      expect(
        fixture.sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(fixture.sessionId)?.revoked_at
      ).toBeNull()
      expect((fetchD1.mock.calls[0]![0] as Request).headers.get('sec-fetch-site')).toBe('cross-site')
    } finally {
      fixture.sqlite.close()
    }
  })

  it.each(['non-document', 'direct-api', 'wrong-origin', 'parent-write'])(
    'retains real CSRF rejection for %s requests',
    async (scenario) => {
      const fixture = await authenticatedNavigationFixture()
      try {
        const headers: Record<string, string> = { ...fixture.headers }
        if (scenario === 'non-document') fixture.context.request.headers.set('sec-fetch-dest', 'empty')
        if (scenario === 'direct-api')
          fixture.context.request = new Request(`${fixture.configuration.origin}/api/_auth/session`, {
            headers: fixture.context.request.headers
          })
        if (scenario === 'wrong-origin') headers.origin = 'https://cross-site.invalid'
        if (scenario === 'parent-write')
          fixture.context.request = new Request(fixture.context.request.url, {
            method: 'POST',
            headers: fixture.context.request.headers
          })
        const response = await dispatchNitroD1Request(
          new Request(`${fixture.configuration.origin}/api/_auth/session`, { headers }),
          fixture.context
        )
        expect(response?.status).toBe(403)
        expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
      } finally {
        fixture.sqlite.close()
      }
    }
  )
})
