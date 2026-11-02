import renderer from '#neteco/nitro-renderer'
import api from './canary'
import { createShopIngress } from './runtime/shop-ingress'
import { handleD1CategoryRedirect } from './catalog/category-redirects'
import { resolveCmsPublicRedirect } from './cms/public-http'
import { cmsRuntimeDependencies } from './runtime/operations-config'
import { handleGuestOrderAccessHttp } from './catalog/guest-order-access-http'
import { handleCspReportHttp, ownsCspReportNamespace } from './security/csp-report-http'
import { buildStrictCsp, generateCspNonce, injectNonceIntoHtml, resolveCspMode } from '../shared/csp'

export { CanaryCoordinator, CanaryWorkflow, InventoryCoordinator, CartCoordinator } from './canary'

type ShopEnvironment = CloudflareEnv & {
  CSP_MODE?: string
}

const baseIngress = createShopIngress(api, renderer, async (request, env) => {
  const url = new URL(request.url)
  // Classification only, matching the ingress's bounded decoding of private
  // UI paths. Never normalize an order ID, credential or dispatched request.
  if (url.searchParams.has('token')) {
    let classifiedPath = url.pathname
    for (let round = 0; round < 4; round++) {
      const decoded = decodeURIComponent(classifiedPath)
      if (decoded === classifiedPath) break
      classifiedPath = decoded
    }
    if (
      /^\/pedido\/[^/]+\/?$/i.test(classifiedPath) &&
      (classifiedPath !== url.pathname || !/^\/pedido\/[^/]+$/.test(url.pathname))
    )
      return Response.json(
        { error: { code: 'invalid_path' } },
        {
          status: 400,
          headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', vary: 'Cookie' }
        }
      )
  }
  if (/^\/pedido\/[^/]+$/.test(url.pathname) && url.searchParams.has('token')) {
    if (env.AUTH_ENABLED !== 'true')
      return Response.json(
        { error: { code: 'service_unavailable' } },
        {
          status: 503,
          headers: { 'cache-control': 'private, no-store', vary: 'Cookie', 'referrer-policy': 'no-referrer' }
        }
      )
    const response = await handleGuestOrderAccessHttp(request, {
      database: env.DB,
      origin: env.AUTH_ORIGIN,
      edgeLimiter: env.AUTH_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
    })
    if (response) return response
  }
  return (
    (await handleD1CategoryRedirect(request, env.DB)) ??
    (await resolveCmsPublicRedirect(request, cmsRuntimeDependencies(env)))
  )
})

export default {
  async fetch(request: Request, env: ShopEnvironment, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Intercept CSP violation report submissions and queries before any SSR buffering
    if (ownsCspReportNamespace(url.pathname)) {
      const cspResponse = await handleCspReportHttp(request, env)
      if (cspResponse) return cspResponse
    }

    const response = await baseIngress.fetch(request, env, context)
    const contentType = response.headers.get('content-type') ?? ''
    const isHtml = /\btext\/html\b/i.test(contentType)

    if (!isHtml) {
      return response
    }

    const mode = resolveCspMode(env.CSP_MODE)
    const headers = new Headers(response.headers)

    // Clear legacy CSP headers to enforce new mode
    headers.delete('content-security-policy')
    headers.delete('content-security-policy-report-only')

    if (mode === 'off') {
      headers.delete('reporting-endpoints')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    }

    // Generate response nonce and evaluate Turnstile allowance
    const nonce = generateCspNonce()
    const enabled = (value: unknown) => value === true || value === 'true'
    const turnstile =
      /^\/contacto\/?$/i.test(url.pathname) &&
      ['preview', 'preprod', 'preproduction', 'canary', 'production'].includes(env.APP_ENV) &&
      enabled(env.SUPPORT_ENABLED) &&
      enabled(env.SUPPORT_TURNSTILE_ENABLED)

    const strictCsp = buildStrictCsp({ nonce, turnstile })
    headers.set('reporting-endpoints', 'csp-endpoint="/api/security/csp-reports"')

    if (mode === 'enforce') {
      headers.set('content-security-policy', strictCsp)
    } else {
      // Default: report-only
      headers.set('content-security-policy-report-only', strictCsp)
    }

    // Inject nonces into script tags in the HTML body
    const html = await response.text()
    const noncedHtml = injectNonceIntoHtml(html, nonce)

    return new Response(noncedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  },

  async scheduled(event: ScheduledController, env: CloudflareEnv, context: ExecutionContext) {
    if (baseIngress.scheduled) await baseIngress.scheduled(event, env, context)
  },

  async queue(batch: MessageBatch, env: CloudflareEnv, context: ExecutionContext) {
    if (baseIngress.queue) await baseIngress.queue(batch, env, context)
  }
}
