import { chromium, expect, test as base } from '@playwright/test'
import { connectRemoteTestBrowser } from '../../scripts/lib/remote-test-browser'

// Runtime acceptance complements STATIC component images. The caller must supply
// already authenticated ephemeral fixtures using existing real auth APIs; this
// spec never creates a login bypass, role, DB record, provider or demo account.
const test = base.extend({
  browser: [
    async ({ browserName }, use) => {
      if (browserName !== 'chromium') throw Error('Only the authorized remote Chromium is supported')
      const browser = await connectRemoteTestBrowser(chromium)
      try {
        await use(browser)
      } finally {
        await browser.close()
      }
    },
    { scope: 'worker' }
  ]
})
function isolatedOrigin() {
  const raw = process.env.NETECO_UI_STATE_E2E_ORIGIN
  if (!raw) throw Error('Explicit isolated UI E2E runtime required')
  const origin = new URL(raw)
  if (origin.origin !== raw || !['127.0.0.1', 'localhost', 'shop-audit.neteco.test'].includes(origin.hostname))
    throw Error('Isolated UI E2E origin required')
  return raw
}
for (const audience of ['admin', 'customer'] as const)
  test(`${audience} real order route respects session and read-only boundary`, async ({ browser }) => {
    const origin = isolatedOrigin(),
      cookie = process.env[audience === 'admin' ? 'NETECO_UI_STATE_ADMIN_COOKIE' : 'NETECO_UI_STATE_CUSTOMER_COOKIE']
    const match = /^neteco-session=([^;\r\n]{1,16384})$/.exec(cookie ?? '')
    if (!match) throw Error('Existing ephemeral authenticated fixture cookie required')
    const context = await browser.newContext({
      locale: 'es-ES',
      serviceWorkers: 'block',
      viewport: { width: 1024, height: 1000 }
    })
    let writes = 0,
      external = 0
    try {
      await context.addCookies([
        {
          name: 'neteco-session',
          value: match[1]!,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax',
          secure: origin.startsWith('https:')
        }
      ])
      await context.route('**/*', async (route) => {
        const request = route.request()
        if (new URL(request.url()).origin !== origin) {
          external++
          await route.abort('blockedbyclient')
          return
        }
        if (!['GET', 'HEAD'].includes(request.method())) {
          writes++
          await route.abort('blockedbyclient')
          return
        }
        await route.continue()
      })
      const page = await context.newPage(),
        route = audience === 'admin' ? '/admin/pedidos' : '/cuenta/pedidos'
      await page.goto(origin + route, { waitUntil: 'networkidle' })
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: audience === 'admin' ? 'Pedidos · banco de preparación' : 'Mis pedidos'
        })
      ).toBeVisible()
      await expect(page.locator('html')).toBeVisible()
      expect(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1)).toBe(false)
      await context.clearCookies()
      await page.goto(origin + route, { waitUntil: 'networkidle' })
      await expect(page).toHaveURL(/\/login(?:\?|$)/)
      expect(writes).toBe(0)
      expect(external).toBe(0)
    } finally {
      await context.close()
    }
  })
