import { expect, it } from 'vitest'
import { createShopIngress } from '../../workers/runtime/shop-ingress'
import { DEMO_ORIGIN } from '../../shared/demo-access'

it.each([
  ['preview', 'true', DEMO_ORIGIN, true],
  ['production', 'true', DEMO_ORIGIN, false],
  ['preview', 'false', DEMO_ORIGIN, false],
  ['preview', 'true', 'https://neteco.es', false]
])(
  'only the opted-in isolated demo prevents injected RUM: %s/%s/%s',
  async (APP_ENV, DEMO_ENABLED, AUTH_ORIGIN, demo) => {
    const ingress = createShopIngress(
      { fetch: async () => new Response(null, { status: 404 }) },
      { fetch: async () => new Response('<html>demo</html>', { headers: { 'content-type': 'text/html' } }) }
    )
    const response = await ingress.fetch(
      new Request(DEMO_ORIGIN + '/login'),
      { APP_ENV, DEMO_ENABLED, AUTH_ORIGIN } as unknown as CloudflareEnv,
      {} as ExecutionContext
    )
    expect(response.headers.get('cache-control')).toBe(demo ? 'private, no-store, no-transform' : 'private, no-store')
    expect(response.headers.get('content-security-policy')).not.toContain('cloudflareinsights.com')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  }
)
