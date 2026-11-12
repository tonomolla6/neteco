import type { Browser } from '@playwright/test'
import assert from 'node:assert/strict'

export const RESOURCE_HUB_BROWSER_SCENARIOS = [
  'native_resource_hub_compiled_navigation_desktop',
  'native_resource_hub_compiled_navigation_mobile',
  'native_resource_hub_compiled_navigation_without_javascript'
] as const

export interface ResourceHubBrowserFixture {
  slug: string
  expiredSlug: string
  title: string
  description: string
  content: string
  author: string
}
export interface NativeResourceHubBrowserInput {
  browser: Browser
  origin: string
  dispatch: (request: Request) => Promise<Response>
  fixture: ResourceHubBrowserFixture
  scenario?: (id: (typeof RESOURCE_HUB_BROWSER_SCENARIOS)[number]) => void
}
export interface NativeResourceHubBrowserResult {
  scenarios: number
  browserExecuted: true
  productionBrowserAcceptance: false
  providerSubmission: false
  viewports: Array<{
    viewport: 'desktop' | 'mobile'
    javaScriptEnabled: boolean
    listToDetail: true
    metadataConfirmed: true
    expiredStatus: 404
    externalRequests: 0
    forbiddenWrites: 0
  }>
}

export async function auditNativeResourceHubBrowser(
  input: NativeResourceHubBrowserInput
): Promise<NativeResourceHubBrowserResult> {
  assert.equal(input.origin, 'https://shop-audit.neteco.test', 'Private resource browser origin required')
  const f = input.fixture
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(f.slug) && f.slug.length <= 160)
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(f.expiredSlug) && f.expiredSlug.length <= 160)
  assert.notEqual(f.slug, f.expiredSlug)
  for (const value of [f.title, f.description, f.content, f.author]) assert(value.trim().length > 0)
  const detailPath = '/recursos/' + f.slug
  const expired = await input.dispatch(new Request(input.origin + '/api/resources/' + f.expiredSlug))
  assert.equal(expired.status, 404, 'Expired resource must return 404')
  assert.deepEqual(await expired.json(), { error: { code: 'not_found' } }, 'Expired resource must not leak content')
  const viewports: NativeResourceHubBrowserResult['viewports'] = []

  function allowed(request: Request) {
    const url = new URL(request.url)
    if (url.origin !== input.origin) return false
    if (request.method === 'DELETE') return url.pathname === '/api/analytics/session' && !url.search
    if (request.method !== 'GET') return false
    if (
      !url.search &&
      [
        '/recursos',
        detailPath,
        '/api/resources/' + f.slug,
        '/api/cart',
        '/api/_auth/session',
        '/api/categories',
        '/logo-figura.svg',
        '/logo-texto.svg',
        '/favicon.svg',
        '/favicon.ico'
      ].includes(url.pathname)
    )
      return true
    if (!url.search && /^\/_nuxt\/[A-Za-z0-9_./@-]+$/.test(url.pathname)) return true
    if (url.pathname !== '/api/resources') return false
    if (!url.search) return true
    // Exactly the initial ResourceHubPanel list request, not arbitrary filters.
    const entries = [...url.searchParams]
    return (
      entries.length === 3 &&
      new Set(entries.map(([key]) => key)).size === 3 &&
      url.searchParams.get('q') === '' &&
      url.searchParams.get('page') === '1' &&
      url.searchParams.get('perPage') === '20'
    )
  }

  for (let index = 0; index < RESOURCE_HUB_BROWSER_SCENARIOS.length; index++) {
    const viewport = index === 1 ? 'mobile' : 'desktop'
    const javaScriptEnabled = index !== 2
    const context = await input.browser.newContext({
      locale: 'es-ES',
      serviceWorkers: 'block',
      javaScriptEnabled,
      viewport: viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 1000 }
    })
    let externalRequests = 0,
      forbiddenWrites = 0,
      transportErrors = 0,
      pageErrors = 0,
      responseErrors = 0
    const transportPaths: string[] = []
    function assertTransport() {
      assert.equal(externalRequests, 0, 'External resource browser request forbidden')
      assert.equal(forbiddenWrites, 0, 'Resource browser write forbidden')
      assert.equal(transportErrors, 0, `Resource browser transport failed: ${transportPaths.join(', ')}`)
      assert.equal(pageErrors, 0, 'Resource browser page error')
      assert.equal(responseErrors, 0, 'Resource browser response error')
    }
    try {
      await context.route('**/*', async (route) => {
        try {
          const incoming = route.request()
          const url = new URL(incoming.url())
          const headers = await incoming.allHeaders()
          const bytes = incoming.postDataBuffer()
          const request = new Request(url, {
            method: incoming.method(),
            headers,
            redirect: 'manual',
            ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {})
          })
          if (!allowed(request)) {
            if (url.origin !== input.origin) externalRequests++
            else if (request.method !== 'GET') forbiddenWrites++
            else {
              transportErrors++
              if (transportPaths.length < 4)
                transportPaths.push(/^\/[A-Za-z0-9/_@.-]{1,160}$/.test(url.pathname) ? url.pathname : '[redacted]')
            }
            await route.abort('failed')
            return
          }
          // The browser's original Cookie/header values cross unchanged.
          const response = await input.dispatch(request)
          if (response.status >= 400) responseErrors++
          const outgoingHeaders = Object.fromEntries(response.headers)
          delete outgoingHeaders['content-length']
          delete outgoingHeaders['content-encoding']
          await route.fulfill({
            status: response.status,
            headers: outgoingHeaders,
            body: Buffer.from(await response.arrayBuffer())
          })
        } catch {
          transportErrors++
          if (transportPaths.length < 4) transportPaths.push('[dispatch-error]')
          await route.abort('failed')
        }
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      page.on('response', (response) => {
        if (response.status() >= 400) responseErrors++
      })
      const listing = await page.goto(input.origin + '/recursos', { waitUntil: 'networkidle' })
      assert.equal(listing?.status(), 200, 'Resource listing navigation failed')
      assertTransport()
      if (javaScriptEnabled) {
        const consent = page.getByRole('button', { name: 'Rechazar opcionales', exact: true })
        if (await consent.isVisible()) await consent.click()
      }
      const link = page.getByRole('link', { name: f.title, exact: true })
      await link.waitFor({ state: 'visible' })
      assert.equal(await link.getAttribute('href'), detailPath, 'Resource listing link must be canonical')
      await link.click()
      await page.waitForURL(input.origin + detailPath, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: f.title, exact: true }).waitFor({ state: 'visible' })
      const article = await page.locator('article').innerText()
      for (const value of [f.title, f.description, f.content, f.author])
        assert(article.includes(value), 'Published resource content/author missing')
      assert((await page.title()).includes(f.title), 'Resource title metadata missing')
      assert.equal(
        await page.locator('meta[name="description"]').getAttribute('content'),
        f.description,
        'Resource description metadata mismatch'
      )
      assert.equal(
        await page.locator('link[rel="canonical"]').getAttribute('href'),
        input.origin + detailPath,
        'Resource canonical metadata mismatch'
      )
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Resource viewport overflows'
      )
      assertTransport()
      viewports.push({
        viewport,
        javaScriptEnabled,
        listToDetail: true,
        metadataConfirmed: true,
        expiredStatus: 404,
        externalRequests: 0,
        forbiddenWrites: 0
      })
      input.scenario?.(RESOURCE_HUB_BROWSER_SCENARIOS[index]!)
    } finally {
      await context.close()
    }
  }
  return {
    scenarios: viewports.length,
    browserExecuted: true,
    productionBrowserAcceptance: false,
    providerSubmission: false,
    viewports
  }
}
