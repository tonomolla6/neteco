import { applicationSecurityHeaders } from '../../shared/http-security'
import { DEMO_ORIGIN } from '../../shared/demo-access'

/** The outer Worker routes APIs before Nitro buffers a request body. Nitro is
 * exclusively the UI renderer: a missing D1 route must never become a legacy
 * Node/PostgreSQL request. The renderer is injected to test this boundary. */
export interface ShopApi {
  fetch(request: Request, env: CloudflareEnv): Promise<Response>
  scheduled?(event: ScheduledController, env: CloudflareEnv, context: ExecutionContext): Promise<void>
  queue?(batch: MessageBatch, env: CloudflareEnv, context: ExecutionContext): Promise<void>
}

export interface ShopRenderer {
  fetch(request: Request, env: CloudflareEnv, context: ExecutionContext): Promise<Response>
}

/** Publication-aware redirects run before SSR. A failed authoritative lookup
 * must not become a renderer fallback with a stale or hidden destination. */
export type ShopCategoryRedirectResolver = (request: Request, env: CloudflareEnv) => Promise<Response | null>

const PRIVATE_ROUTES = [
  '/cuenta',
  '/admin',
  '/auth',
  '/pedido',
  '/pedidos',
  '/carrito',
  '/checkout',
  '/login',
  '/registro',
  '/recuperar-clave',
  '/restablecer-clave',
  '/verificar-email',
  '/newsletter'
]

function isAuthoritativePath(path: string) {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/health' ||
    path === '/robots.txt' ||
    path === '/sitemap.xml' ||
    path === '/sitemaps' ||
    path.startsWith('/sitemaps/') ||
    /^\/media(?:\/|$)/i.test(path) ||
    path === '/img/products' ||
    path.startsWith('/img/products/')
  )
}

function invalidAlias(path: string) {
  let decoded = path
  // Reject encoded aliases instead of rewriting identity, cookie or origin
  // boundaries. Encoded catalog slugs remain valid ordinary page paths.
  for (let round = 0; round < 4; round++) {
    // A case-folded API prefix must never become a Nitro/legacy route. Reject
    // the alias, without rewriting case-sensitive IDs or canonical parameters.
    if (/^\/api(?:\/|$)/i.test(decoded) && !/^\/api(?:\/|$)/.test(decoded)) return true
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return true
    }
    if (next === decoded) return false
    if (isAuthoritativePath(next) && !isAuthoritativePath(path)) return true
    decoded = next
  }
  return false
}

function failure(code: string, status: number) {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    }
  )
}

function secureRenderedResponse(response: Response, path: string, env: CloudflareEnv, hasPreview = false) {
  const headers = new Headers(response.headers)
  let classifiedPath = path
  for (let round = 0; round < 4; round++) {
    const decoded = decodeURIComponent(classifiedPath)
    if (decoded === classifiedPath) break
    classifiedPath = decoded
  }
  // Nuxt/Vue Router matches UI routes case-insensitively. Classify the same
  // pages without rewriting authoritative API boundaries.
  classifiedPath = classifiedPath.toLowerCase()
  const privatePage =
    (hasPreview && /^\/contenido(?:\/|$)/.test(classifiedPath)) ||
    PRIVATE_ROUTES.some((prefix) => classifiedPath === prefix || classifiedPath.startsWith(`${prefix}/`))
  const html = /\btext\/html\b/i.test(headers.get('content-type') ?? '')
  if (html) {
    // Only the native contact page embeds Turnstile. OFF/local and every other
    // document retain the self-only script/frame policy; no arbitrary origins.
    const enabled = (value: unknown) => value === true || value === 'true'
    const turnstile =
      /^\/contacto\/?$/.test(classifiedPath) &&
      ['preview', 'preprod', 'preproduction', 'canary', 'production'].includes(env.APP_ENV) &&
      enabled(env.SUPPORT_ENABLED) &&
      enabled(env.SUPPORT_TURNSTILE_ENABLED)
    for (const [name, value] of Object.entries(applicationSecurityHeaders(env.APP_ENV, { turnstile }))) {
      if (name === 'referrer-policy' && headers.has(name)) continue
      headers.set(name, value)
    }
  }
  if (privatePage || html) {
    const demo =
      html &&
      env.APP_ENV === 'preview' &&
      env.AUTH_ORIGIN === DEMO_ORIGIN &&
      (env as CloudflareEnv & { DEMO_ENABLED?: unknown }).DEMO_ENABLED === 'true'
    // Prevent the zone's automatic RUM script injection on this isolated demo,
    // without enabling third-party scripts or changing any zone-wide setting.
    headers.set('cache-control', demo ? 'private, no-store, no-transform' : 'private, no-store')
    const vary = (headers.get('vary') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (!vary.some((part) => part.toLowerCase() === 'cookie')) vary.push('Cookie')
    headers.set('vary', vary.join(', '))
    headers.set('x-frame-options', 'DENY')
  }
  if (privatePage) {
    headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
    headers.set('referrer-policy', 'no-referrer')
  } else if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function createShopIngress(
  api: ShopApi,
  renderer: ShopRenderer,
  resolveCategoryRedirect?: ShopCategoryRedirectResolver
) {
  return {
    async fetch(request: Request, env: CloudflareEnv, context: ExecutionContext): Promise<Response> {
      const url = new URL(request.url),
        path = url.pathname,
        hasPreview = url.searchParams.has('preview')
      if (invalidAlias(path)) return failure('invalid_path', 400)
      // Static demo originals bypass legal/scanner decisions if Nitro/ASSETS
      // serves them. Only publication-ID routes may deliver catalog media.
      if (/^\/img\/products(?:\/|$)/i.test(path)) return failure('not_found', 404)
      if (isAuthoritativePath(path)) {
        try {
          return await api.fetch(request, env)
        } catch {
          return failure('api_unavailable', 503)
        }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const response = failure('method_not_allowed', 405)
        response.headers.set('allow', 'GET, HEAD')
        return secureRenderedResponse(response, path, env, hasPreview)
      }
      try {
        const redirect = await resolveCategoryRedirect?.(request, env)
        if (redirect) return secureRenderedResponse(redirect, path, env, hasPreview)
      } catch {
        return secureRenderedResponse(failure('category_unavailable', 503), path, env, hasPreview)
      }
      try {
        return secureRenderedResponse(await renderer.fetch(request, env, context), path, env, hasPreview)
      } catch {
        return secureRenderedResponse(failure('renderer_unavailable', 502), path, env, hasPreview)
      }
    },
    async scheduled(event: ScheduledController, env: CloudflareEnv, context: ExecutionContext) {
      if (api.scheduled) await api.scheduled(event, env, context)
    },
    async queue(batch: MessageBatch, env: CloudflareEnv, context: ExecutionContext) {
      if (api.queue) await api.queue(batch, env, context)
    }
  }
}
