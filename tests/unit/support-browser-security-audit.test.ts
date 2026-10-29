import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { applicationSecurityHeaders } from '../../shared/http-security'
import { supportContactDocumentTarget } from '../../shared/support-navigation'
import { createShopIngress } from '../../workers/runtime/shop-ingress'

const ORIGIN = 'https://support-browser-audit.neteco.test'
const CHALLENGE = 'https://challenges.cloudflare.com'
const LEAK = 'private-database-credential-and-customer-email'

function environment(overrides: Record<string, unknown> = {}) {
  return {
    APP_ENV: 'preprod',
    SUPPORT_ENABLED: 'true',
    SUPPORT_TURNSTILE_ENABLED: 'true',
    ...overrides
  } as unknown as CloudflareEnv
}

function context() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
}

function directives(response: Response) {
  return new Map(
    (response.headers.get('content-security-policy') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/)
        return [name, sources] as const
      })
  )
}

async function render(path: string, overrides: Record<string, unknown> = {}) {
  const api = { fetch: vi.fn(async () => new Response('authoritative-api')) }
  const renderer = {
    fetch: vi.fn(
      async (_request: Request) =>
        new Response('<!doctype html><html>offline browser-boundary fixture</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
    )
  }
  const response = await createShopIngress(api, renderer).fetch(
    new Request(new URL(path, ORIGIN)),
    environment(overrides),
    context()
  )
  return { response, api, renderer }
}

describe('support browser authority audit: real ingress and pure shared headers, no browser/provider I/O', () => {
  it('grants the exact challenge origin only to script and frame directives', () => {
    const response = new Response(null, {
      headers: applicationSecurityHeaders('production', { turnstile: true })
    })
    const policy = directives(response)
    expect(policy.get('script-src')).toEqual(["'self'", "'unsafe-inline'", CHALLENGE])
    expect(policy.get('frame-src')).toEqual(["'self'", CHALLENGE])
    expect(policy.get('connect-src')).toEqual(["'self'"])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'self'", 'https://sis-t.redsys.es:25443', 'https://sis.redsys.es'])
    expect([...policy].filter(([, sources]) => sources.includes(CHALLENGE)).map(([name]) => name)).toEqual([
      'script-src',
      'frame-src'
    ])
    expect(response.headers.get('content-security-policy')).not.toContain('*')
  })

  it.each(['preview', 'preprod', 'preproduction', 'canary', 'production'])(
    'allows an enabled native contact document in %s',
    async (appEnv) => {
      const { response, api } = await render('/contacto?producto=public-slug', { APP_ENV: appEnv })
      expect(directives(response).get('script-src')).toContain(CHALLENGE)
      expect(directives(response).get('frame-src')).toContain(CHALLENGE)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')).toBe('Cookie')
      expect(response.headers.has('strict-transport-security')).toBe(appEnv === 'production')
      expect(api.fetch).not.toHaveBeenCalled()
    }
  )

  it.each([
    { APP_ENV: 'local' },
    { APP_ENV: 'test' },
    { APP_ENV: 'unknown' },
    { SUPPORT_ENABLED: undefined },
    { SUPPORT_ENABLED: false },
    { SUPPORT_ENABLED: 'false' },
    { SUPPORT_ENABLED: 'TRUE' },
    { SUPPORT_TURNSTILE_ENABLED: undefined },
    { SUPPORT_TURNSTILE_ENABLED: false },
    { SUPPORT_TURNSTILE_ENABLED: 'false' },
    { SUPPORT_TURNSTILE_ENABLED: 'yes' }
  ])('does not authorize provider origins for absent/unapproved environment or flags %#', async (overrides) => {
    const { response } = await render('/contacto', overrides)
    expect(directives(response).get('script-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(directives(response).get('frame-src')).toEqual(["'self'"])
  })

  it.each(['/catalogo', '/cuenta/soporte', '/admin/soporte', '/contacto/extra', '/contactos', '/contacto.js'])(
    'does not inherit contact challenge authority on %s',
    async (path) => {
      const { response } = await render(path)
      expect(response.headers.get('content-security-policy')).not.toContain(CHALLENGE)
    }
  )

  it.each(['/contacto/', '/%63ontacto', '/%2563ontacto'])('classifies genuine contact route alias %s', async (path) => {
    const { response, renderer } = await render(path)
    expect(response.status).toBe(200)
    expect(directives(response).get('script-src')).toContain(CHALLENGE)
    expect(renderer.fetch.mock.calls[0]?.[0].url).toBe(new URL(path, ORIGIN).href)
  })

  it('documents why an ordinary NuxtLink cannot upgrade a previously self-only document CSP', async () => {
    const catalog = (await render('/catalogo')).response
    const contact = (await render('/contacto')).response
    expect(directives(catalog).get('script-src')).not.toContain(CHALLENGE)
    expect(directives(contact).get('script-src')).toContain(CHALLENGE)
    // Source evidence only: no component/browser runner, no provider script.
    // Normal client routing does not replace the initiating document's headers.
    const footer = readFileSync(new URL('../../app/components/AppFooter.vue', import.meta.url), 'utf8')
    expect(footer).toMatch(/<NuxtLink\s+to="\/contacto"/)
    expect(catalog.headers.get('content-security-policy')).not.toBe(contact.headers.get('content-security-policy'))
  })

  it('upgrades that SPA transition through a relative fresh contact document with exact public context', async () => {
    const initial = (await render('/catalogo')).response
    const target = '/contacto?pedido=DECLARED%2FREF&producto=public-slug#consulta'
    const documentTarget = supportContactDocumentTarget('cloudflare', '/catalogo', {
      path: '/contacto',
      fullPath: target
    })
    expect(documentTarget).toBe(target)
    expect(directives(initial).get('script-src')).not.toContain(CHALLENGE)
    const fresh = (await render(documentTarget!)).response
    expect(directives(fresh).get('script-src')).toContain(CHALLENGE)
    expect(new URL(documentTarget!, ORIGIN).origin).toBe(ORIGIN)
  })

  it.each(['/contacto', '/contacto/', '/%63ontacto', '/%2563ontacto'])(
    'does not loop when document %s already has contact challenge authority',
    async (documentPath) => {
      expect(directives((await render(documentPath)).response).get('script-src')).toContain(CHALLENGE)
      expect(
        supportContactDocumentTarget('cloudflare', documentPath, {
          path: '/contacto',
          fullPath: '/contacto?pedido=REF'
        })
      ).toBeNull()
    }
  )

  it.each(['node', 'unknown', undefined])('never enables native document navigation for runtime %s', (runtime) => {
    expect(supportContactDocumentTarget(runtime, '/catalogo', { path: '/contacto', fullPath: '/contacto' })).toBeNull()
    expect(applicationSecurityHeaders('production')['content-security-policy']).not.toContain(CHALLENGE)
  })

  it.each(['https://attacker.invalid/contacto', '//attacker.invalid/contacto', '/contacto\\evil', '/contacto.evil'])(
    'never constructs an external document destination from %s',
    (fullPath) => {
      expect(supportContactDocumentTarget('cloudflare', '/catalogo', { path: '/contacto', fullPath })).toBeNull()
    }
  )

  it.each(['/CONTACTO', '/Contacto/', '/%43ONTACTO'])(
    'applies contact document CSP to the case-insensitive UI route alias %s',
    async (path) => {
      // This is the installed real route matcher, not a component mount or
      // a fake browser. Nuxt has no custom case-sensitive router options.
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/contacto', name: 'contacto', component: {} }]
      })
      const classified = decodeURIComponent(new URL(path, ORIGIN).pathname)
      expect(router.resolve(classified).name).toBe('contacto')
      expect(directives((await render(path)).response).get('script-src')).toContain(CHALLENGE)
    }
  )

  it('forces a canonical document for an uppercase contact SPA target recognized by the installed router', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/contacto', name: 'contacto', component: {} }]
    })
    const target = router.resolve('/CONTACTO?pedido=DECLARED%2FREF#consulta')
    expect(target.name).toBe('contacto')
    expect(supportContactDocumentTarget('cloudflare', '/catalogo', target)).toBe(
      '/contacto?pedido=DECLARED%2FREF#consulta'
    )
  })

  it.each(['/CUENTA/SOPORTE', '/Admin/Soporte', '/%43UENTA/soporte'])(
    'preserves private route header protection on case-insensitive UI alias %s',
    async (path) => {
      const { response } = await render(path)
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('content-security-policy')).not.toContain(CHALLENGE)
    }
  )

  it.each(['/%61pi/support/options', '/api%2fsupport/tickets', '/%2561pi/support/tickets', '/%ZZ'])(
    'rejects malformed/reserved aliases before reaching either backend %s',
    async (path) => {
      const { response, api, renderer } = await render(path)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_path' } })
      expect(response.headers.get('content-security-policy')).toBeNull()
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(api.fetch).not.toHaveBeenCalled()
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['/api/support/options', '/api/support/tickets', '/api/account/support', '/api/admin/support'])(
    'preserves authoritative API responses/cookies and never adds UI challenge authority on %s',
    async (path) => {
      const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store' })
      headers.append('set-cookie', 'intake=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax')
      headers.append('set-cookie', 'session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax')
      const answer = new Response('{"fixture":true}', { status: 403, headers })
      const api = { fetch: vi.fn(async () => answer) }
      const renderer = { fetch: vi.fn(async () => new Response('forbidden-legacy-fallback')) }
      const request = new Request(new URL(path, ORIGIN), { headers: { cookie: 'session=existing' } })
      const response = await createShopIngress(api, renderer).fetch(request, environment(), context())
      expect(response).toBe(answer)
      expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
      expect(response.headers.get('content-security-policy')).toBeNull()
      expect(api.fetch).toHaveBeenCalledWith(request, expect.anything())
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )

  it('preserves repeated SSR cookies, existing private referrer policy and Cookie Vary without duplication', async () => {
    const headers = new Headers({
      'content-type': 'text/html',
      'cache-control': 'public, max-age=86400',
      'referrer-policy': 'no-referrer',
      vary: 'Accept-Encoding, cookie'
    })
    headers.append('set-cookie', 'one=synthetic; HttpOnly; Secure; Path=/')
    headers.append('set-cookie', 'two=synthetic; HttpOnly; Secure; Path=/')
    const renderer = { fetch: vi.fn(async () => new Response('<html>contact</html>', { headers })) }
    const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
      new Request(new URL('/contacto', ORIGIN)),
      environment(),
      context()
    )
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(response.headers.get('vary')).toBe('Accept-Encoding, cookie')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(directives(response).get('frame-src')).toContain(CHALLENGE)
  })

  it.each(['application/json', 'text/javascript', 'image/svg+xml', 'text/plain'])(
    'does not turn non-HTML MIME %s into a challenge-authorized document',
    async (mime) => {
      const renderer = {
        fetch: vi.fn(async () => new Response('synthetic asset', { headers: { 'content-type': mime } }))
      }
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
        new Request(new URL('/contacto', ORIGIN)),
        environment(),
        context()
      )
      expect(response.headers.get('content-type')).toBe(mime)
      expect(response.headers.get('content-security-policy')).toBeNull()
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
  )

  it.each(['/contacto', '/%63uenta/soporte', '/admin/soporte'])(
    'sanitizes a renderer exception and preserves private protections on %s',
    async (path) => {
      const renderer = {
        fetch: vi.fn(async () => {
          throw new Error(LEAK)
        })
      }
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
        new Request(new URL(path, ORIGIN)),
        environment(),
        context()
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: { code: 'renderer_unavailable' } })
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('content-security-policy')).toBeNull()
      if (path !== '/contacto') {
        expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(response.headers.get('vary')).toBe('Cookie')
      }
    }
  )

  it('rejects contact POST before SSR consumes its body and without HTML challenge permissions', async () => {
    const renderer = { fetch: vi.fn() }
    const request = new Request(new URL('/contacto', ORIGIN), { method: 'POST', body: LEAK })
    const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(request, environment(), context())
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(request.bodyUsed).toBe(false)
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
    expect(renderer.fetch).not.toHaveBeenCalled()
  })
})
