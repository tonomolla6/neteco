import renderer from '#neteco/nitro-renderer'
import api from './canary'
import { createShopIngress } from './runtime/shop-ingress'
import { handleD1CategoryRedirect } from './catalog/category-redirects'
import { resolveCmsPublicRedirect } from './cms/public-http'
import { cmsRuntimeDependencies } from './runtime/operations-config'
import { handleGuestOrderAccessHttp } from './catalog/guest-order-access-http'

export { CanaryCoordinator, CanaryWorkflow, InventoryCoordinator, CartCoordinator } from './canary'

export default createShopIngress(api, renderer, async (request, env) => {
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
