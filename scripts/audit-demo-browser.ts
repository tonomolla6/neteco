import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect, type Browser, type BrowserContext, type Page, type Response } from '@playwright/test'
import { z } from 'zod'
import { DEMO_IDENTITIES, DEMO_ORIGIN } from '../shared/demo-access'
import { catalogPolicyUuidSchema } from '../shared/catalog-publication-policy'

/** Root must confirm LISTA before: npx tsx scripts/audit-demo-browser.ts --run-demo
 * Real Chrome/HTTPS, no cookie injection, mocks, credentials, HAR or raw logs.
 * Coverage: four access scenarios. Catalog/order/stock UI are deliberately out
 * of this bounded acceptance; independent API evidence belongs to root.
 */
type Role = keyof typeof DEMO_IDENTITIES
const directory = resolve('test-results/demo-browser')
const evidence = {
  scenario: 'not_started',
  check: 'not_started',
  completed: 0,
  requests: 0,
  loginPosts: 0,
  privacyCookieClears: 0,
  outsideOrigin: 0,
  blockedWrites: 0,
  consoleErrors: 0,
  pageErrors: 0,
  failedRequests: 0,
  confirmedPrivacy204Aborts: 0,
  ignoredFavicon404: 0,
  consoleClassifications: [] as Array<{
    category: 'csp' | 'asset' | 'schema' | 'hydration' | 'other'
    source: string
    line: number
  }>,
  httpErrors: [] as Array<{ endpoint: string; status: number }>,
  transportFailures: [] as Array<{ endpoint: string; code: string }>,
  screenshots: [] as string[],
  titles: [] as Array<{ page: string; title: string }>
}
class EvidenceFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
function confirmed(condition: unknown, code: string): asserts condition {
  if (!condition) throw new EvidenceFailure(code)
}
function bounded<T>(promise: Promise<T>, code: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EvidenceFailure(code)), milliseconds)
  })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}
function scenario(name: string) {
  evidence.scenario = name
  console.log(JSON.stringify({ audit: 'demo_browser_checkpoint', scenario: name, completed: evidence.completed }))
}
function endpoint(path: string) {
  if (path === '/api/demo/login') return 'demo_login'
  if (path === '/api/_auth/session') return 'auth_session'
  if (path === '/api/analytics/session') return 'analytics_privacy_clear'
  if (['/login', '/cuenta', '/admin'].includes(path)) return path
  if (/^\/_nuxt\/[A-Za-z0-9._/-]{1,160}$/.test(path)) return path
  return path.startsWith('/api/') ? 'other_same_origin_api' : 'same_origin_page_or_asset'
}
function matching(response: Response, path: string, method = 'GET') {
  const url = new URL(response.url())
  return url.origin === DEMO_ORIGIN && url.pathname === path && response.request().method() === method
}
async function body(response: Response) {
  const bytes = await bounded(response.body(), 'bounded_response_body_timeout', 8000)
  confirmed(bytes.length <= 128 * 1024, 'bounded_response_body_too_large')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    demo: z.literal(true),
    role: z.enum(['customer', 'admin']),
    identityId: catalogPolicyUuidSchema
  })
  .strict()
const userSchema = z
  .object({
    user: z
      .object({
        id: catalogPolicyUuidSchema,
        email: z.string().email(),
        role: z.enum(['customer', 'admin']),
        emailVerified: z.literal(true),
        mfaVerified: z.boolean()
      })
      .passthrough()
  })
  .passthrough()
async function verifySession(response: Response, role: Role) {
  confirmed(response.status() === 200, 'fresh_session_not_200')
  verifySessionPayload(await body(response), role)
}
function verifySessionPayload(payload: unknown, role: Role) {
  const session = userSchema.safeParse(payload)
  confirmed(session.success, 'fresh_session_shape_unconfirmed')
  confirmed(
    session.data.user.id === DEMO_IDENTITIES[role].identityId &&
      session.data.user.email === DEMO_IDENTITIES[role].email &&
      session.data.user.role === role &&
      session.data.user.mfaVerified === (role === 'admin'),
    'fresh_session_not_exact_synthetic_identity'
  )
}
async function screenshot(page: Page, name: 'desktop-login' | 'mobile-login' | 'customer' | 'admin' | 'failure') {
  const title = (await bounded(page.title(), 'page_title_timeout', 3000))
    .replace(/\S+@\S+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[url]')
  const safe = [...title]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 120)
  await bounded(
    page.screenshot({ path: resolve(directory, name + '.png'), fullPage: true, timeout: 5000 }),
    'screenshot_timeout',
    6000
  )
  evidence.screenshots.push(`test-results/demo-browser/${name}.png`)
  evidence.titles.push({ page: name, title: safe })
}
let browser: Browser | undefined,
  stopped = false
const contexts = new Set<BrowserContext>()
const privacyIntents = new WeakMap<BrowserContext, { remaining: number }>()
async function withPage(role: Role | null, mobile: boolean, run: (page: Page) => Promise<void>) {
  confirmed(browser && !stopped, 'browser_context_unavailable')
  const context = await bounded(
    browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      serviceWorkers: 'block',
      acceptDownloads: false
    }),
    'browser_context_timeout',
    8000
  )
  contexts.add(context)
  const privacy = { remaining: 0 },
    completed204 = new WeakSet<object>()
  privacyIntents.set(context, privacy)
  let page: Page | undefined,
    logins = 0
  try {
    await context.route('**/*', async (route) => {
      const request = route.request(),
        target = new URL(request.url())
      evidence.requests++
      if (stopped || target.origin !== DEMO_ORIGIN || target.username || target.password) {
        evidence.outsideOrigin++
        await route.abort('blockedbyclient')
        return
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (
          request.method() === 'DELETE' &&
          target.pathname === '/api/analytics/session' &&
          !target.search &&
          !request.postData() &&
          privacy.remaining === 1
        ) {
          privacy.remaining = 0
          evidence.privacyCookieClears++
        } else {
          let valid = false
          if (
            role &&
            request.method() === 'POST' &&
            target.pathname === '/api/demo/login' &&
            !target.search &&
            logins === 0
          ) {
            try {
              const data: unknown = JSON.parse(request.postData() ?? '')
              valid =
                !!data &&
                typeof data === 'object' &&
                !Array.isArray(data) &&
                Object.keys(data).length === 1 &&
                Object.getOwnPropertyDescriptor(data, 'role')?.value === role
            } catch {
              /* No raw payload diagnostics. */
            }
          }
          if (!valid) {
            evidence.blockedWrites++
            await route.abort('blockedbyclient')
            return
          }
          logins++
          evidence.loginPosts++
        }
      }
      await route.continue()
    })
    await context.routeWebSocket('**/*', (socket) => {
      evidence.outsideOrigin++
      socket.close()
    })
    page = await bounded(context.newPage(), 'browser_page_timeout', 8000)
    page.setDefaultTimeout(8000)
    page.setDefaultNavigationTimeout(12000)
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      evidence.consoleErrors++
      const text = message.text().slice(0, 2048).toLowerCase()
      if (evidence.consoleClassifications.length < 20) {
        const location = message.location()
        let source = 'unclassified_console_source'
        try {
          const target = new URL(location.url)
          source = target.origin === DEMO_ORIGIN ? endpoint(target.pathname) : 'outside_origin_source'
        } catch {
          /* Never echo source text or unvalidated URLs. */
        }
        evidence.consoleClassifications.push({
          category: /content security policy|violates.*directive|refused to/.test(text)
            ? 'csp'
            : /hydration|hydrating|mismatch/.test(text)
              ? 'hydration'
              : /failed to load resource|net::err/.test(text)
                ? 'asset'
                : /zod|schema|invalid.*(?:json|dto)/.test(text)
                  ? 'schema'
                  : 'other',
          source,
          line: Number.isSafeInteger(location.lineNumber) && location.lineNumber >= 0 ? location.lineNumber : 0
        })
      }
    })
    page.on('pageerror', () => {
      evidence.pageErrors++
    })
    page.on('response', (response) => {
      const target = new URL(response.url())
      if (target.origin !== DEMO_ORIGIN) return
      if (matching(response, '/api/analytics/session', 'DELETE') && response.status() === 204)
        completed204.add(response.request())
      if (target.pathname === '/favicon.ico' && response.status() === 404) {
        evidence.ignoredFavicon404++
        return
      }
      if (response.status() >= 400 && evidence.httpErrors.length < 50)
        evidence.httpErrors.push({ endpoint: endpoint(target.pathname), status: response.status() })
    })
    page.on('requestfailed', (request) => {
      const target = new URL(request.url())
      if (target.origin !== DEMO_ORIGIN) return
      evidence.failedRequests++
      const code = request.failure()?.errorText
      if (code === 'net::ERR_ABORTED' && completed204.has(request)) evidence.confirmedPrivacy204Aborts++
      if (evidence.transportFailures.length < 20)
        evidence.transportFailures.push({
          endpoint: endpoint(target.pathname),
          code: [
            'net::ERR_ABORTED',
            'net::ERR_FAILED',
            'net::ERR_CONNECTION_CLOSED',
            'net::ERR_HTTP2_PROTOCOL_ERROR',
            'net::ERR_TIMED_OUT'
          ].includes(code ?? '')
            ? code!
            : 'unclassified_transport_failure'
        })
    })
    await run(page)
  } catch (failure) {
    if (page && !stopped) await screenshot(page, 'failure').catch(() => undefined)
    throw failure
  } finally {
    privacyIntents.delete(context)
    await bounded(context.close(), 'context_cleanup_timeout', 2000).finally(() => contexts.delete(context))
  }
}
async function login(page: Page, mobile: boolean, capture: boolean) {
  evidence.check = 'login_document'
  const loginResponse = await page.goto(DEMO_ORIGIN + '/login', { waitUntil: 'networkidle' })
  confirmed(loginResponse?.status() === 200, 'login_document_not_200')
  evidence.check = 'reject_optional_consent_ui'
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control', exact: true })
  await expect(dialog).toBeVisible()
  const privacy = privacyIntents.get(page.context())
  confirmed(privacy, 'privacy_ui_context_unavailable')
  privacy.remaining = 1
  const [clear] = await Promise.all([
    page.waitForResponse((response) => matching(response, '/api/analytics/session', 'DELETE')),
    dialog.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
  ])
  confirmed(clear.status() === 204, 'privacy_cookie_clear_not_204')
  await expect(dialog).not.toBeVisible()
  evidence.check = 'public_boolean_flags_and_controls'
  const flags = await page.evaluate(() => {
    const use: unknown = Reflect.get(window, 'useNuxtApp')
    if (typeof use !== 'function') return false
    const nuxt: unknown = use()
    if (!nuxt || typeof nuxt !== 'object') return false
    const config: unknown = Reflect.get(nuxt, '$config')
    if (!config || typeof config !== 'object') return false
    const publicConfig: unknown = Reflect.get(config, 'public')
    return (
      !!publicConfig &&
      typeof publicConfig === 'object' &&
      Reflect.get(publicConfig, 'serverRuntime') === 'cloudflare' &&
      Reflect.get(publicConfig, 'demoEnabled') === true
    )
  })
  confirmed(flags, 'demo_public_opt_in_not_boolean_cloudflare')
  const banner = page.getByTestId('demo-login-shortcuts')
  await expect(banner).toBeVisible()
  await expect(banner.getByText('DEMO · sintética y aislada', { exact: true })).toBeVisible()
  for (const role of ['customer', 'admin'] as const) await expect(page.getByTestId('demo-login-' + role)).toBeEnabled()
  const box = await banner.boundingBox(),
    viewport = page.viewportSize()
  confirmed(
    box &&
      viewport &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1 &&
      viewport.width - box.x - box.width <= 48 &&
      viewport.height - box.y - box.height <= 48 &&
      (await banner.evaluate((element) => getComputedStyle(element).position === 'fixed')),
    'floating_controls_geometry_unconfirmed'
  )
  if (mobile) {
    evidence.check = 'mobile_keyboard_controls'
    for (let tabs = 0; tabs < 80; tabs++) {
      await page.keyboard.press('Tab')
      if (await page.getByTestId('demo-login-customer').evaluate((element) => element === document.activeElement)) break
    }
    confirmed(
      await page.getByTestId('demo-login-customer').evaluate((element) => element === document.activeElement),
      'customer_control_not_keyboard_reachable'
    )
    await page.keyboard.press('Tab')
    confirmed(
      await page.getByTestId('demo-login-admin').evaluate((element) => element === document.activeElement),
      'admin_control_not_keyboard_reachable'
    )
  }
  if (capture) await screenshot(page, mobile ? 'mobile-login' : 'desktop-login')
}
async function enterAndReload(page: Page, role: Role) {
  confirmed(!stopped, 'audit_timeout')
  evidence.check = role + '_explicit_login_post'
  const [post, session] = await Promise.all([
    page.waitForResponse((response) => matching(response, '/api/demo/login', 'POST')),
    page.waitForResponse((response) => matching(response, '/api/_auth/session')),
    page.getByTestId('demo-login-' + role).click()
  ])
  confirmed(post.status() === 200, 'demo_login_not_200')
  evidence.check = role + '_receipt_and_fresh_session'
  const receipt = receiptSchema.safeParse(await body(post))
  confirmed(
    receipt.success && receipt.data.role === role && receipt.data.identityId === DEMO_IDENTITIES[role].identityId,
    'demo_receipt_not_exact_synthetic_identity'
  )
  await verifySession(session, role)
  const destination = role === 'admin' ? '/admin' : '/cuenta',
    heading = role === 'admin' ? 'Hoy' : 'Resumen'
  evidence.check = role + '_fixed_destination_heading'
  await page.waitForURL(DEMO_ORIGIN + destination)
  await page.getByRole('heading', { name: heading, exact: true }).waitFor()
  await page.waitForLoadState('networkidle')
  await screenshot(page, role)
  evidence.check = role + '_reload_and_fresh_session'
  await page.reload({ waitUntil: 'networkidle' })
  const [fresh, browserRead] = await Promise.all([
    page.waitForResponse((response) => matching(response, '/api/_auth/session')),
    bounded(
      page.evaluate(async () => {
        const response = await fetch('/api/_auth/session', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer'
        })
        // Consume the actual fetch body in Chrome. A headers-only fetch can leave
        // Playwright's later response.body() waiting indefinitely on this transport.
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 128 * 1024) throw Error('bounded_session_body')
        const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        const user: unknown = data && typeof data === 'object' ? Reflect.get(data, 'user') : null
        const value =
          user && typeof user === 'object'
            ? {
                id: Reflect.get(user, 'id'),
                email: Reflect.get(user, 'email'),
                role: Reflect.get(user, 'role'),
                emailVerified: Reflect.get(user, 'emailVerified'),
                mfaVerified: Reflect.get(user, 'mfaVerified')
              }
            : null
        return { status: response.status, payload: { user: value } }
      }),
      'fresh_browser_session_body_timeout',
      8000
    )
  ])
  confirmed(fresh.status() === 200 && browserRead.status === 200, 'fresh_session_not_200')
  verifySessionPayload(browserRead.payload, role)
  confirmed(page.url() === DEMO_ORIGIN + destination, 'reload_destination_not_exact')
  await page.getByRole('heading', { name: heading, exact: true }).waitFor()
}
async function run() {
  confirmed(
    process.argv.length === 3 && process.argv[2] === '--run-demo' && DEMO_ORIGIN === 'https://neteco.tonomolla.es',
    'explicit_demo_operator_flag_required'
  )
  await access('/usr/bin/google-chrome')
  await mkdir(directory, { recursive: true })
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'Europe/Madrid' },
    args: [
      '--no-sandbox',
      '--no-proxy-server',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--no-first-run'
    ]
  })
  scenario('real_demo_mobile_login')
  await withPage(null, true, async (page) => {
    await login(page, true, true)
    evidence.completed++
  })
  await withPage('customer', false, async (page) => {
    scenario('real_demo_desktop_login')
    await login(page, false, true)
    evidence.completed++
    scenario('real_demo_customer_access_and_reload')
    await enterAndReload(page, 'customer')
    evidence.completed++
  })
  scenario('real_demo_admin_access_and_reload')
  await withPage('admin', false, async (page) => {
    await login(page, false, false)
    await enterAndReload(page, 'admin')
    evidence.completed++
  })
  evidence.check = 'network_and_console_boundaries'
  confirmed(
    evidence.completed === 4 && evidence.loginPosts === 2 && evidence.privacyCookieClears === 3,
    'scenario_or_explicit_mutation_count_mismatch'
  )
  confirmed(evidence.outsideOrigin === 0 && evidence.blockedWrites === 0, 'unexpected_network_or_mutation_attempt')
  confirmed(
    evidence.consoleErrors === 0 && evidence.pageErrors === 0 && evidence.httpErrors.length === 0,
    'browser_console_or_http_errors'
  )
  confirmed(evidence.failedRequests === evidence.confirmedPrivacy204Aborts, 'unexpected_transport_failure')
}
let failureCode: string | null = null
try {
  await bounded(run(), 'global_60_second_timeout', 60_000)
} catch (failure) {
  failureCode = failure instanceof EvidenceFailure ? failure.code : 'browser_assertion_or_transport_unconfirmed'
} finally {
  stopped = true
  for (const context of contexts)
    await bounded(context.close(), 'context_cleanup_timeout', 2000).catch(() => {
      failureCode ??= 'context_cleanup_timeout'
    })
  if (browser)
    await bounded(browser.close(), 'browser_cleanup_timeout', 2500).catch(() => {
      failureCode ??= 'browser_cleanup_timeout'
    })
}
console.log(
  JSON.stringify({
    audit: 'demo_browser',
    status: failureCode ? 'failed' : 'passed',
    ...(failureCode ? { code: failureCode } : {}),
    ...evidence,
    origin: DEMO_ORIGIN,
    engine: 'installed_google_chrome',
    transport: 'real_https_demo_worker',
    covered: ['mobile_and_desktop_login_ui', 'customer_and_admin_receipt_live_session_navigation_reload'],
    notCovered: ['catalog_orders_stock_ui', 'commerce_or_provider_operations'],
    cookiesOrTokensLogged: false
  })
)
if (failureCode) process.exitCode = 1
