import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

/** Actual compiled Nuxt hydration/DOM/CSS against the disposable Worker.
 * Playwright forwards same-origin requests to real workerd, not mocked API
 * DTOs. Browser execution uses the dedicated private SSH-forwarded service. */
export async function auditNativeAnalyticsBrowser(input: {
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  range: { from: string; to: string }
  scenario: (name: string) => void
  browserMode?: 'required' | 'not-run'
}) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  catalogPolicyInstantSchema.parse(input.range.from)
  catalogPolicyInstantSchema.parse(input.range.to)
  const cookie = /^neteco-session=([^;\r\n]+)$/.exec(input.adminCookie)
  assert(cookie, 'Native browser must use the existing sealed synthetic session')
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      requests: null,
      pageErrors: null,
      blockedExternal: null,
      keyboardTraversal: null,
      viewports: [],
      screenshots: [],
      syntheticSessionOnly: true,
      productionBrowserAcceptance: false
    }
  const browser = await connectRemoteTestBrowser(chromium)
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1440, height: 1000 }
    })
    let blockedExternal = 0,
      pageErrors = 0,
      requests = 0
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
        requests++
        const headers = await incoming.allHeaders()
        // The private forwarding harness is the remote browser's trusted ingress,
        // never a claim about Cloudflare's real edge header provenance.
        headers['cf-connecting-ip'] = '192.0.2.52'
        headers['accept-encoding'] = 'identity'
        const bytes = incoming.postDataBuffer()
        const response = await input.dispatch(
          new Request(target, {
            method: incoming.method(),
            headers,
            ...(bytes ? { body: new Uint8Array(bytes) } : {})
          })
        )
        const forwarded = Object.fromEntries(response.headers)
        // Re-encoding the body locally must not retain compressed byte lengths.
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
      const directory = resolve('test-results/native-analytics-browser')
      await mkdir(directory, { recursive: true })
      input.scenario('native_analytics_browser_compiled_hydration_desktop')
      await page.goto(input.origin + '/admin/analitica', { waitUntil: 'networkidle', timeout: 30000 })
      await page.getByRole('heading', { name: 'Analítica operativa', exact: true }).waitFor({ timeout: 15000 })
      await page.locator('#analytics-from').fill(input.range.from.slice(0, 10))
      await page.locator('#analytics-to').fill(input.range.to.slice(0, 10))
      const expectedQuery = new URLSearchParams({
        from: input.range.from.slice(0, 10) + 'T00:00:00Z',
        to: input.range.to.slice(0, 10) + 'T00:00:00Z',
        page: '1',
        perPage: '20'
      })
      const snapshotResponse = page.waitForResponse((response) => {
        const target = new URL(response.url())
        return (
          target.origin === input.origin &&
          target.pathname === '/api/admin/analytics' &&
          response.request().method() === 'GET' &&
          response.status() === 200 &&
          target.searchParams.size === expectedQuery.size &&
          [...expectedQuery].every(
            ([key, value]) => target.searchParams.getAll(key).length === 1 && target.searchParams.get(key) === value
          )
        )
      })
      await Promise.all([snapshotResponse, page.getByTestId('analytics-apply').click()])
      await page.getByTestId('analytics-validation-only').waitFor({ timeout: 15000 })
      assert((await page.getByText('Esta lectura no certifica liquidación bancaria', { exact: false }).count()) > 0)
      assert.equal(
        await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
        false,
        'Desktop dashboard must not overflow'
      )
      await page.screenshot({ path: resolve(directory, 'desktop.png'), fullPage: true })
      input.scenario('native_analytics_browser_compiled_mobile_keyboard')
      await page.setViewportSize({ width: 390, height: 844 })
      let keyboardTabs = 0
      while (keyboardTabs < 80) {
        await page.keyboard.press('Tab')
        keyboardTabs++
        if (await page.getByTestId('analytics-refresh').evaluate((element) => element === document.activeElement)) break
      }
      assert.equal(
        await page.getByTestId('analytics-refresh').evaluate((element) => element === document.activeElement),
        true,
        'Mobile dashboard refresh must be reachable by real Tab navigation within 80 presses'
      )
      await page.screenshot({ path: resolve(directory, 'mobile.png'), fullPage: true })
      const mobileOverflow = await page.locator('html').evaluate((element) => ({
        viewport: window.innerWidth,
        width: element.scrollWidth,
        elements: Array.from(document.querySelectorAll('body *'))
          .map((node) => {
            const rect = node.getBoundingClientRect()
            return { tag: node.tagName, classes: node.getAttribute('class'), left: rect.left, right: rect.right }
          })
          .filter((node) => node.right > window.innerWidth + 1 && node.left >= 0)
          .slice(0, 20)
      }))
      if (mobileOverflow.width > mobileOverflow.viewport + 1)
        console.error(JSON.stringify({ audit: 'native-analytics-mobile-overflow', ...mobileOverflow }))
      assert.equal(mobileOverflow.width > mobileOverflow.viewport + 1, false, 'Mobile dashboard must not overflow')
      assert.equal(await page.locator('label[for="analytics-from"]').count(), 1)
      assert.equal(await page.locator('label[for="analytics-to"]').count(), 1)
      assert.equal(pageErrors, 0, 'Compiled dashboard must hydrate without browser exceptions')
      assert.equal(blockedExternal, 0, 'Compiled dashboard must not request external resources')
      return {
        scenarios: 2,
        browserStatus: 'passed' as const,
        reason: null,
        engine: 'remote_playwright_chromium',
        transport: 'playwright_same_origin_forwarding_to_real_workerd',
        requests,
        pageErrors,
        blockedExternal,
        keyboardTraversal: { key: 'Tab', presses: keyboardTabs, target: 'analytics-refresh' },
        viewports: ['1440x1000', '390x844'],
        screenshots: [
          'test-results/native-analytics-browser/desktop.png',
          'test-results/native-analytics-browser/mobile.png'
        ],
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
