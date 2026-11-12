import { describe, expect, it, vi } from 'vitest'
import { createShopIngress } from '../../workers/runtime/shop-ingress'
import { testNow } from '../support/deterministic'

function context() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  } as unknown as ExecutionContext
}

function environment() {
  return { APP_ENV: 'preprod' } as unknown as CloudflareEnv
}

describe('Cloudflare shop ingress', () => {
  it.each(['/API/analytics/events', '/Api/admin/analytics', '/%41PI/analytics/events', '/%2541PI/admin/analytics'])(
    'rejects case-folded API alias %s before either API or legacy renderer dispatch',
    async (path) => {
      const api = { fetch: vi.fn() },
        renderer = { fetch: vi.fn() }
      const response = await createShopIngress(api, renderer).fetch(
        new Request(`https://preprod.neteco.es${path}`),
        environment(),
        context()
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_path' } })
      expect(api.fetch).not.toHaveBeenCalled()
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )
  it.each([
    ['/contacto', 'preprod', 'true', 'true', true],
    ['/contacto/', 'production', 'true', 'true', true],
    ['/contacto', 'local', 'true', 'true', false],
    ['/contacto', 'preprod', 'false', 'true', false],
    ['/contacto', 'preprod', 'true', 'false', false],
    ['/contacto', 'preprod', 'yes', 'true', false],
    ['/admin/newsletter', 'production', 'true', 'true', false],
    ['/checkout', 'production', 'true', 'true', false],
    ['/cuenta/soporte', 'preprod', 'true', 'true', false]
  ])(
    'scopes challenge CSP to enabled native contact HTML %s/%s/%s/%s',
    async (path, appEnv, support, captcha, allowed) => {
      const renderer = {
        fetch: vi.fn(async () => new Response('<html>contact</html>', { headers: { 'content-type': 'text/html' } }))
      }
      const env = {
        APP_ENV: appEnv,
        SUPPORT_ENABLED: support,
        SUPPORT_TURNSTILE_ENABLED: captcha
      } as unknown as CloudflareEnv
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
        new Request(`https://preprod.neteco.es${path}`),
        env,
        context()
      )
      const policy = response.headers.get('content-security-policy')!
      expect(policy.includes('https://challenges.cloudflare.com')).toBe(allowed)
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).toContain("connect-src 'self'")
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('strict-transport-security') !== null).toBe(appEnv === 'production')
    }
  )
  it.each(['/contenido/example?preview=sealed-read-only-token', '/contenido/example?preview='])(
    'keeps preview HTML non-indexable and prevents bearer referrers for %s',
    async (path) => {
      const renderer = {
        fetch: vi.fn(
          async () =>
            new Response('preview', {
              headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=999' }
            })
        )
      }
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
        new Request(`https://preprod.neteco.es${path}`),
        environment(),
        context()
      )
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
    }
  )
  it.each(['GET', 'HEAD'])('resolves governed category aliases before SSR for %s', async (method) => {
    const request = new Request('https://preprod.neteco.es/categoria/old-slug?utm_source=fixture', { method })
    const redirect = new Response(null, {
      status: 301,
      headers: { location: '/categoria/current-slug?utm_source=fixture', 'cache-control': 'private, no-store' }
    })
    const resolver = vi.fn(async () => redirect)
    const renderer = { fetch: vi.fn() }
    const env = environment()
    const result = await createShopIngress({ fetch: vi.fn() }, renderer, resolver).fetch(request, env, context())
    expect(result.status).toBe(301)
    expect(result.headers.get('location')).toBe('/categoria/current-slug?utm_source=fixture')
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resolver).toHaveBeenCalledExactlyOnceWith(request, env)
    expect(renderer.fetch).not.toHaveBeenCalled()
  })
  it('renders only after an authoritative redirect lookup confirms no alias', async () => {
    const resolver = vi.fn(async () => null)
    const renderer = {
      fetch: vi.fn(async () => new Response('category', { headers: { 'content-type': 'text/html' } }))
    }
    const result = await createShopIngress({ fetch: vi.fn() }, renderer, resolver).fetch(
      new Request('https://preprod.neteco.es/categoria/current-slug'),
      environment(),
      context()
    )
    expect(await result.text()).toBe('category')
    expect(resolver).toHaveBeenCalledOnce()
    expect(renderer.fetch).toHaveBeenCalledOnce()
  })
  it('fails closed on a redirect lookup outage without rendering or exposing details', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('SQL private-category-information')
    })
    const renderer = { fetch: vi.fn() }
    const response = await createShopIngress({ fetch: vi.fn() }, renderer, resolver).fetch(
      new Request('https://preprod.neteco.es/categoria/old-slug'),
      environment(),
      context()
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'category_unavailable' } })
    expect(renderer.fetch).not.toHaveBeenCalled()
  })
  it.each(['/api/admin/categories', '/categoria/old-slug'])(
    'does not resolve aliases before the API/write boundaries for %s',
    async (path) => {
      const resolver = vi.fn(async () => new Response(null, { status: 301 }))
      const api = { fetch: vi.fn(async () => new Response('API')) }
      const renderer = { fetch: vi.fn() }
      const request = new Request(`https://preprod.neteco.es${path}`, { method: 'POST', body: 'not-consumed' })
      const response = await createShopIngress(api, renderer, resolver).fetch(request, environment(), context())
      expect(response.status).toBe(path.startsWith('/api/') ? 200 : 405)
      expect(request.bodyUsed).toBe(false)
      expect(resolver).not.toHaveBeenCalled()
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )
  it('rejects UI writes before Nitro can buffer the request body', async () => {
    const request = new Request('https://preprod.neteco.es/catalogo', {
      method: 'POST',
      body: new Uint8Array(32768)
    })
    const renderer = { fetch: vi.fn() }
    const api = { fetch: vi.fn() }
    const response = await createShopIngress(api, renderer).fetch(request, environment(), context())
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    expect(request.bodyUsed).toBe(false)
    expect(renderer.fetch).not.toHaveBeenCalled()
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/api',
    '/api?next=%2Fcuenta',
    '/api/auth/login',
    '/health',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemaps/products.xml?page=2',
    '/sitemaps/unported.xml',
    '/media',
    '/MEDIA/12345678-1234-4321-aaaa-123456789abc/image',
    '/media/not-a-valid-publication/image',
    '/media/12345678-1234-4321-aaaa-123456789abc/image?w=800&format=jpeg'
  ])('routes %s exclusively to the authoritative Worker API', async (path) => {
    const apiResponse = new Response('authoritative', { status: 503 })
    const api = { fetch: vi.fn(async () => apiResponse) }
    const renderer = { fetch: vi.fn(async () => new Response('legacy')) }
    const ingress = createShopIngress(api, renderer)
    const request = new Request(`https://preprod.neteco.es${path}`)
    const env = environment()
    const ctx = context()

    const response = await ingress.fetch(request, env, ctx)

    expect(response).toBe(apiResponse)
    expect(api.fetch).toHaveBeenCalledExactlyOnceWith(request, env)
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it.each([404, 401, 429, 503])('never falls through to legacy rendering after API status %i', async (status) => {
    const api = { fetch: vi.fn(async () => new Response('API only', { status })) }
    const renderer = { fetch: vi.fn(async () => new Response('legacy fallback')) }
    const response = await createShopIngress(api, renderer).fetch(
      new Request('https://preprod.neteco.es/api/unimplemented'),
      environment(),
      context()
    )

    expect(response.status).toBe(status)
    expect(await response.text()).toBe('API only')
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('does not consume or clone a streaming oversized API request before edge/body validation', async () => {
    const request = new Request('https://preprod.neteco.es/api/auth/login', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024))
          controller.close()
        }
      }),
      duplex: 'half'
    } as RequestInit)
    const originalBody = request.body
    const api = {
      fetch: vi.fn(async (received: Request) => {
        expect(received).toBe(request)
        expect(received.body).toBe(originalBody)
        expect(received.bodyUsed).toBe(false)
        expect(received.body?.locked).toBe(false)
        return new Response('too large', { status: 413 })
      })
    }
    const renderer = { fetch: vi.fn(async () => new Response('legacy')) }
    const response = await createShopIngress(api, renderer).fetch(request, environment(), context())

    expect(response.status).toBe(413)
    expect(request.bodyUsed).toBe(false)
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('preserves API session cookies, repeated Set-Cookie and public-cache policy without rewriting the response', async () => {
    const headers = new Headers({ 'cache-control': 'no-store' })
    headers.append('set-cookie', 'session=first; Path=/; HttpOnly; Secure; SameSite=Lax')
    headers.append('set-cookie', 'csrf=second; Path=/; Secure; SameSite=Lax')
    const apiResponse = new Response('authenticated', { headers })
    const request = new Request('https://preprod.neteco.es/api/auth/session', {
      headers: { cookie: 'session=existing; preference=dark' }
    })
    const api = {
      fetch: vi.fn(async (received: Request) => {
        expect(received.headers.get('cookie')).toBe('session=existing; preference=dark')
        return apiResponse
      })
    }
    const response = await createShopIngress(api, { fetch: vi.fn() }).fetch(request, environment(), context())

    expect(response).toBe(apiResponse)
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(response.headers.get('cache-control')).toBe('no-store')

    const publicResponse = new Response('catalog', { headers: { 'cache-control': 'public, max-age=60' } })
    const publicIngress = createShopIngress({ fetch: vi.fn(async () => publicResponse) }, { fetch: vi.fn() })
    expect(
      (
        await publicIngress.fetch(new Request('https://preprod.neteco.es/api/products'), environment(), context())
      ).headers.get('cache-control')
    ).toBe('public, max-age=60')
  })

  it.each([
    '/%61pi/auth/login',
    '/api%2Fauth/login',
    '/%61%70%69/auth/login',
    '/%68ealth',
    '/%2561pi/auth/login',
    '/%72obots.txt',
    '/%73itemap.xml',
    '/sitemaps%2Fproducts.xml',
    '/%6dedia/12345678-1234-4321-aaaa-123456789abc/image',
    '/media%2F12345678-1234-4321-aaaa-123456789abc/image',
    '/%256dedia/original',
    '/img%2Fproducts/demo.jpg',
    '/img/%70roducts/demo.jpg'
  ])('never dispatches encoded reserved path %s to the legacy renderer', async (path) => {
    const api = { fetch: vi.fn(async () => new Response('API namespace', { status: 404 })) }
    const renderer = { fetch: vi.fn(async () => new Response('legacy')) }
    const response = await createShopIngress(api, renderer).fetch(
      new Request(`https://preprod.neteco.es${path}`),
      environment(),
      context()
    )

    expect(renderer.fetch).not.toHaveBeenCalled()
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it.each(['/img/products', '/img/products/demo.jpg', '/img/products/nested/source.png'])(
    'blocks legacy static catalog original %s without reaching Nitro or assets',
    async (path) => {
      const api = { fetch: vi.fn() }
      const renderer = { fetch: vi.fn(async () => new Response('unapproved original')) }
      const response = await createShopIngress(api, renderer).fetch(
        new Request(`https://preprod.neteco.es${path}`),
        environment(),
        context()
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(api.fetch).not.toHaveBeenCalled()
      expect(renderer.fetch).not.toHaveBeenCalled()
    }
  )

  it('forwards the original UI host, scheme, query, cookies, environment and execution context unchanged', async () => {
    const request = new Request('https://preprod.neteco.es/productos/limpiador?format=5L', {
      headers: { cookie: 'session=private', 'x-forwarded-host': 'do-not-trust.example' }
    })
    const env = environment()
    const ctx = context()
    const rendered = new Response('<html>product</html>', { headers: { 'content-type': 'text/html' } })
    const renderer = { fetch: vi.fn(async () => rendered) }
    const api = { fetch: vi.fn() }
    const response = await createShopIngress(api, renderer).fetch(request, env, ctx)

    expect(renderer.fetch).toHaveBeenCalledExactlyOnceWith(request, env, ctx)
    expect(request.url).toBe('https://preprod.neteco.es/productos/limpiador?format=5L')
    expect(request.headers.get('cookie')).toBe('session=private')
    expect(await response.text()).toBe('<html>product</html>')
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/cuenta',
    '/cuenta/pedidos/abc',
    '/admin',
    '/admin/pedidos',
    '/auth/login',
    '/checkout',
    '/pedido/abc',
    '/pedidos/abc',
    '/carrito',
    '/login',
    '/registro',
    '/recuperar-clave',
    '/restablecer-clave',
    '/verificar-email',
    '/newsletter/confirmar',
    '/newsletter/preferencias?token=synthetic-purpose-bearer',
    '/%6eewsletter/preferencias?token=synthetic-purpose-bearer'
  ])('prevents cache/index leakage on private UI %s, preserving cookies and existing Vary dimensions', async (path) => {
    const headers = new Headers({
      'content-type': 'text/html',
      'cache-control': 'public, max-age=86400',
      vary: 'Accept-Encoding',
      'x-robots-tag': 'index, follow'
    })
    headers.append('set-cookie', 'session=first; Path=/; HttpOnly; Secure')
    headers.append('set-cookie', 'preference=dark; Path=/; Secure')
    const renderer = { fetch: vi.fn(async () => new Response('<html>private</html>', { headers })) }
    const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
      new Request(`https://preprod.neteco.es${path}`),
      environment(),
      context()
    )

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const vary = response.headers
      .get('vary')
      ?.toLowerCase()
      .split(',')
      .map((value) => value.trim())
    expect(vary).toEqual(expect.arrayContaining(['cookie', 'accept-encoding']))
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(await response.text()).toBe('<html>private</html>')
  })

  it('protects redirect responses from private UI without changing their destination or status', async () => {
    const renderer = {
      fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: '/auth/login?next=%2Fadmin' } }))
    }
    const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
      new Request('https://preprod.neteco.es/admin'),
      environment(),
      context()
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/login?next=%2Fadmin')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  })

  it.each(['/%63uenta', '/admin%2Fpedidos', '/%2563uenta/pedidos'])(
    'applies private-UI index and referrer protection to encoded route %s without rewriting it',
    async (path) => {
      const request = new Request(`https://preprod.neteco.es${path}`)
      const renderer = {
        fetch: vi.fn(async () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }))
      }
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(request, environment(), context())
      expect(renderer.fetch).toHaveBeenCalledWith(request, expect.anything(), expect.anything())
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
  )

  it('sanitizes renderer failures into a private 502 response without exposing stack, secrets or SQL', async () => {
    const renderer = {
      fetch: vi.fn(async () => {
        throw new Error('secret-token SQL SELECT customer_email stacktrace')
      })
    }
    const api = { fetch: vi.fn() }
    const response = await createShopIngress(api, renderer).fetch(
      new Request('https://preprod.neteco.es/'),
      environment(),
      context()
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).not.toMatch(/secret-token|SELECT|customer_email|stacktrace/)
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it('sanitizes thrown API failures into 503 without invoking the renderer', async () => {
    const api = {
      fetch: vi.fn(async () => {
        throw new Error('SQL connection-secret unavailable')
      })
    }
    const renderer = { fetch: vi.fn(async () => new Response('legacy')) }
    const response = await createShopIngress(api, renderer).fetch(
      new Request('https://preprod.neteco.es/api/auth/session'),
      environment(),
      context()
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).not.toMatch(/SQL|connection-secret/)
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('prevents shared caching on public HTML because SSR can observe cookies', async () => {
    const renderer = {
      fetch: vi.fn(
        async () =>
          new Response('<html>personalized</html>', {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' }
          })
      )
    }
    const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
      new Request('https://preprod.neteco.es/productos'),
      environment(),
      context()
    )
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('vary')?.toLowerCase()).toContain('cookie')
  })

  it.each(['/_nuxt/app.abc123.js', '/images/logo.webp'])(
    'preserves immutable static-asset caching on %s',
    async (path) => {
      const asset = new Response('static', {
        headers: {
          'content-type': path.endsWith('.js') ? 'text/javascript' : 'image/webp',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      })
      const renderer = { fetch: vi.fn(async () => asset) }
      const response = await createShopIngress({ fetch: vi.fn() }, renderer).fetch(
        new Request(`https://preprod.neteco.es${path}`),
        environment(),
        context()
      )
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(await response.text()).toBe('static')
    }
  )

  it('does not mistake a public path sharing an API prefix for the reserved namespace', async () => {
    const api = { fetch: vi.fn() }
    const renderer = { fetch: vi.fn(async () => new Response('public UI')) }
    await createShopIngress(api, renderer).fetch(
      new Request('https://preprod.neteco.es/apiculture'),
      environment(),
      context()
    )
    expect(renderer.fetch).toHaveBeenCalledOnce()
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it('forwards scheduled and queue events only to the authoritative API with their runtime context', async () => {
    const scheduled = vi.fn(async () => undefined)
    const queue = vi.fn(async () => undefined)
    const api = { fetch: vi.fn(), scheduled, queue }
    const renderer = { fetch: vi.fn() }
    const ingress = createShopIngress(api, renderer)
    const controller = { scheduledTime: testNow(), cron: '* * * * *' } as ScheduledController
    const batch = { queue: 'neteco-preprod-jobs', messages: [] } as unknown as MessageBatch
    const env = environment()
    const ctx = context()

    await ingress.scheduled?.(controller, env, ctx)
    await ingress.queue?.(batch, env, ctx)

    expect(scheduled).toHaveBeenCalledExactlyOnceWith(controller, env, ctx)
    expect(queue).toHaveBeenCalledExactlyOnceWith(batch, env, ctx)
    expect(renderer.fetch).not.toHaveBeenCalled()
    expect(api.fetch).not.toHaveBeenCalled()
  })
})
