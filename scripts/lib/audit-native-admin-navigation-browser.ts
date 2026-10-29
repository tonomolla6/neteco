import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { adminCapabilitiesSchema, adminNavigationGroups, canNavigateAdmin } from '../../shared/admin-navigation'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export const ADMIN_NAVIGATION_BROWSER_SCENARIOS = [
  'native_admin_navigation_compiled_live_grants_palette_and_recent_desktop',
  'native_admin_navigation_compiled_recent_keyboard_and_overflow_mobile'
] as const

/** Acceptance test of compiled UI against the disposable real Worker. No UI/API
 * fixtures, capability overrides, production cookies, or local browser launch.
 * Invoke before the caller revokes its existing synthetic administrator. */
export async function auditNativeAdminNavigationBrowser(input: {
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  const cookie = /^neteco-session=([^;\r\n]+)$/.exec(input.adminCookie)
  assert(cookie, "Use only the caller's existing sealed synthetic session")
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      requests: null,
      capabilityReads: null,
      pageErrors: null,
      blockedExternal: null,
      blockedWrites: null,
      viewports: [],
      syntheticSessionOnly: true,
      productionBrowserAcceptance: false
    }

  // Establish the actual live server grants, not a role inferred by this test.
  const authorization = await input.dispatch(
    new Request(`${input.origin}/api/admin/capabilities`, {
      headers: { cookie: input.adminCookie, 'cf-connecting-ip': '192.0.2.53', 'cache-control': 'no-store' }
    })
  )
  assert.equal(authorization.status, 200, 'Existing synthetic session must have live capabilities')
  const capabilities = adminCapabilitiesSchema.parse(await authorization.json())
  assert.equal(capabilities.state, 'ready')
  assert(
    canNavigateAdmin('/admin/pedidos', capabilities) && canNavigateAdmin('/admin/operaciones', capabilities),
    'Journey requires real grants for both destinations; do not manufacture or broaden them'
  )
  const authorized = adminNavigationGroups(capabilities).flatMap((group) => group.links)
  const orders = authorized.find((link) => link.to === '/admin/pedidos')!
  const operations = authorized.find((link) => link.to === '/admin/operaciones')!
  const browser = await connectRemoteTestBrowser(chromium)
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block'
    })
    let requests = 0,
      capabilityReads = 0,
      pageErrors = 0,
      blockedExternal = 0,
      blockedWrites = 0
    try {
      await context.addCookies([
        { name: 'neteco-session', value: cookie[1]!, url: input.origin, httpOnly: true, secure: true, sameSite: 'Lax' }
      ])
      await context.route('**/*', async (route) => {
        const incoming = route.request(),
          target = new URL(incoming.url())
        if (target.origin !== input.origin) {
          blockedExternal++
          await route.abort('blockedbyclient')
          return
        }
        // This journey is navigation only; never execute a business command.
        if (!['GET', 'HEAD'].includes(incoming.method())) {
          blockedWrites++
          await route.abort('blockedbyclient')
          return
        }
        requests++
        const headers = await incoming.allHeaders()
        headers['cf-connecting-ip'] = '192.0.2.53'
        headers['accept-encoding'] = 'identity'
        const response = await input.dispatch(new Request(target, { method: incoming.method(), headers }))
        if (target.pathname === '/api/admin/capabilities') {
          assert.equal(response.status, 200, 'Route refresh must reauthorize against the real Worker')
          const live = adminCapabilitiesSchema.parse(await response.clone().json())
          assert.equal(live.identityId, capabilities.identityId)
          assert.equal(live.sessionId, capabilities.sessionId)
          assert.equal(live.sessionVersion, capabilities.sessionVersion)
          assert(canNavigateAdmin('/admin/pedidos', live) && canNavigateAdmin('/admin/operaciones', live))
          capabilityReads++
        }
        const forwarded = Object.fromEntries(response.headers)
        delete forwarded['content-encoding']
        delete forwarded['content-length']
        await route.fulfill({
          status: response.status,
          headers: forwarded,
          body: Buffer.from(await response.arrayBuffer())
        })
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      input.scenario?.(ADMIN_NAVIGATION_BROWSER_SCENARIOS[0])
      await page.goto(`${input.origin}/admin/pedidos`, { waitUntil: 'networkidle', timeout: 30000 })
      const breadcrumbs = page.getByRole('navigation', { name: 'Ubicación administrativa', exact: true })
      await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(orders.label, { timeout: 15000 })
      await expect(page.locator('[data-recent] a[href="/admin/pedidos"]')).toHaveText(orders.label)
      await expect(page.locator('[data-palette-open]')).toBeEnabled()
      await page.keyboard.press('Control+k')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      const query = dialog.locator('[data-palette-query]')
      await expect(query).toBeFocused()
      // Every offered destination must come from the actual server grant map.
      for (const option of await dialog.getByRole('option').all()) {
        const label = await option.locator('span').first().innerText()
        assert(
          authorized.some((link) => link.label === label),
          'Palette offered an unauthorized destination'
        )
      }
      await query.fill(operations.label)
      await expect(dialog.getByRole('option')).toHaveCount(1)
      await expect(dialog.getByRole('option')).toContainText(operations.label)
      const previousReads = capabilityReads
      const refresh = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/admin/capabilities' &&
          response.request().method() === 'GET' &&
          response.status() === 200,
        { timeout: 15000 }
      )
      await page.keyboard.press('Enter')
      await refresh
      await expect(page).toHaveURL(`${input.origin}/admin/operaciones`)
      await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(operations.label)
      assert(capabilityReads > previousReads, 'Client navigation must obtain fresh server authorization')
      await expect(page.locator('[data-recent] a')).toHaveCount(2)
      await expect(page.locator('[data-recent] a').nth(0)).toHaveAttribute('href', '/admin/operaciones')
      await expect(page.locator('[data-recent] a').nth(1)).toHaveAttribute('href', '/admin/pedidos')
      await expect(dialog).toHaveCount(0)
      assert.equal(
        await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
        false,
        'Desktop navigation must not overflow'
      )

      input.scenario?.(ADMIN_NAVIGATION_BROWSER_SCENARIOS[1])
      await page.setViewportSize({ width: 390, height: 844 })
      const recentOrders = page.locator('[data-recent] a[href="/admin/pedidos"]')
      await recentOrders.focus()
      await expect(recentOrders).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(`${input.origin}/admin/pedidos`)
      await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(orders.label)
      await expect(page.locator('[data-recent] a[href="/admin/operaciones"]')).toHaveText(operations.label)
      await page.locator('[data-palette-open]').click()
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-palette-open]')).toBeFocused()
      assert.equal(
        await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
        false,
        'Mobile navigation must not overflow'
      )
      assert.equal(pageErrors, 0, 'Compiled navigation must hydrate without browser exceptions')
      assert.equal(blockedExternal, 0, 'Navigation must not request external resources')
      assert.equal(blockedWrites, 0, 'Navigation must not issue business or telemetry writes')
      return {
        scenarios: ADMIN_NAVIGATION_BROWSER_SCENARIOS.length,
        browserStatus: 'passed' as const,
        reason: null,
        engine: 'remote_playwright_chromium',
        transport: 'playwright_same_origin_forwarding_to_real_workerd',
        requests,
        capabilityReads,
        pageErrors,
        blockedExternal,
        blockedWrites,
        viewports: ['1440x1000', '390x844'],
        syntheticSessionOnly: true,
        productionBrowserAcceptance: false
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
