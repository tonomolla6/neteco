import assert from 'node:assert/strict'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import { z } from 'zod'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { orderTrackingSchema, type OrderTracking } from '../../shared/order-tracking'

export const GUEST_ORDER_BROWSER_SCENARIOS = [
  'native_guest_order_email_link_compiled_view_only_desktop',
  'native_guest_order_email_link_compiled_view_only_mobile'
] as const
export interface GuestOrderBrowserFixture {
  orderId: string
  /** Synthetic real order.created email URL, never the original payment bearer. */
  emailLink: string
  forbiddenValues: readonly string[]
}
export interface NativeGuestOrderBrowserInput {
  origin: string
  dispatch: (request: Request) => Promise<Response>
  prepareGuestOrder: (viewport: 'desktop' | 'mobile') => Promise<GuestOrderBrowserFixture>
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}
type BridgeInput = Pick<NativeGuestOrderBrowserInput, 'origin' | 'dispatch'> & GuestOrderBrowserFixture
type ForwardResult = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
export class GuestOrderBrowserError extends Error {
  constructor(
    readonly stage: string,
    readonly viewport: 'desktop' | 'mobile' | null = null
  ) {
    super('Isolated compiled guest order check failed')
    this.name = 'GuestOrderBrowserError'
  }
}
function isolatedOrigin(origin: string) {
  const url = new URL(origin)
  assert(
    url.origin === origin && url.protocol === 'https:' && url.hostname === 'shop-audit.neteco.test',
    'Isolated origin required'
  )
}
const VIEW_ONLY_NOTICE =
  'Este enlace permite solo consulta. No permite iniciar ni reintentar pagos. Si necesitas gestionar el pago, contacta con NETECO.'
/** Real HTTP forwarding only. No fabricated app HTML, session, response DTOs or
 * grants. The only mutation is explicit CSRF-checked logout outside forwarding.
 * All errors are deliberately stripped of URLs, cookies, HTML and provider text. */
export async function createGuestOrderBrowserBridge(input: BridgeInput) {
  try {
    isolatedOrigin(input.origin)
    z.string().uuid().parse(input.orderId)
    const link = new URL(input.emailLink)
    assert(
      link.origin === input.origin &&
        link.pathname === `/pedido/${input.orderId}` &&
        !link.hash &&
        !link.username &&
        !link.password &&
        link.searchParams.size === 1 &&
        /^[a-f0-9]{64}$/.test(link.searchParams.get('token') ?? ''),
      'Real purpose-separated email link required'
    )
    assert(input.forbiddenValues.length > 0 && input.forbiddenValues.length <= 20)
    for (const marker of input.forbiddenValues)
      assert(typeof marker === 'string' && marker.length >= 8 && marker.length <= 16384)
  } catch {
    throw new GuestOrderBrowserError('fixture')
  }
  const claim = new URL(input.emailLink).searchParams.get('token')!,
    path = `/pedido/${input.orderId}`,
    detailPath = `/api/orders/${input.orderId}`,
    trackingPath = `${detailPath}/tracking`,
    counters = { landings: 0, documentReads: 0, blockedWrites: 0, blockedExternal: 0, revoked: false }
  let cookie: string | null = null,
    verified = false,
    browserTracking: OrderTracking | null = null
  const abort = (reason: string): ForwardResult => ({ action: 'abort', reason })
  function noSecrets(bytes: string, includeCookie = true) {
    assert(!bytes.includes(claim), 'Link claim must not escape the initial exchange')
    for (const marker of input.forbiddenValues) assert(!bytes.includes(marker), 'Forbidden credential/foreign marker')
    if (includeCookie && cookie) assert(!bytes.includes(cookie.slice(cookie.indexOf('=') + 1)), 'No cookie disclosure')
  }
  const get = (target: string, credential = cookie) =>
    input.dispatch(
      new Request(input.origin + target, {
        headers: {
          Origin: input.origin,
          'CF-Connecting-IP': '192.0.2.173',
          ...(credential ? { Cookie: credential } : {})
        },
        redirect: 'manual'
      })
    )
  async function readOwn() {
    const response = await get(detailPath)
    assert.equal(response.status, 200, 'Owned guest detail must be readable')
    assert(response.headers.get('cache-control')?.includes('no-store'))
    assert(!response.headers.has('set-cookie'), 'Read must not renew authority')
    const bytes = await response.text()
    assert(Buffer.byteLength(bytes) <= 1024 * 1024, 'Bounded detail')
    noSecrets(bytes)
    const dto = JSON.parse(bytes) as Record<string, unknown>
    assert(
      dto.id === input.orderId && dto.source === 'cloudflare' && dto.accessMode === 'view_only',
      'Strict read-only identity'
    )
  }
  async function tracking(response: Response) {
    assert.equal(response.status, 200, 'Guest tracking must be readable')
    assert(response.headers.get('cache-control')?.includes('no-store'))
    assert(!response.headers.has('set-cookie'), 'Tracking read must not renew authority')
    const bytes = await response.text()
    assert(Buffer.byteLength(bytes) <= 64 * 1024, 'Bounded tracking')
    noSecrets(bytes)
    const dto = orderTrackingSchema.parse(JSON.parse(bytes))
    assert(dto.orderId === input.orderId && dto.audience === 'guest' && dto.source === 'cloudflare')
    assert.deepEqual(
      dto.fulfillment,
      { state: 'pending', version: 0, updatedAt: null },
      'Real unpaid checkout has no preparation'
    )
    assert.deepEqual(dto.packing, { parcelCount: 0, recordedAt: null })
    assert.deepEqual(dto.shipments, [])
    assert.deepEqual(dto.carrierEvents, [])
    assert.equal(dto.carrierStatus, 'not_connected')
    return dto
  }
  async function forward(request: Request): Promise<ForwardResult> {
    try {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        counters.blockedExternal++
        return abort('external_request')
      }
      const consentDelete = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !consentDelete) {
        counters.blockedWrites++
        return abort('unapproved_write')
      }
      if ((request.headers.get('referer') ?? '').includes(claim)) return abort('sensitive_referrer')
      if (url.searchParams.has('token') && request.url !== input.emailLink) return abort('unexpected_claim_url')
      for (const marker of input.forbiddenValues)
        if (request.url.includes(marker) || (request.headers.get('cookie') ?? '').includes(marker))
          return abort('forbidden_credential')
      const response = await input.dispatch(request)
      if (request.url === input.emailLink) {
        assert(request.method === 'GET' && !counters.revoked)
        assert.equal(response.status, 303)
        assert(response.headers.get('location') === path, 'Clean same-order redirect required')
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
        const raw = response.headers.get('set-cookie') ?? ''
        assert(/^neteco-guest-order-access-v1=[^;\r\n]+;/.test(raw) && /; HttpOnly; Secure; SameSite=Lax/.test(raw))
        assert(!raw.includes('neteco-session=') && !raw.includes('neteco-order-access-v2='))
        assert(!raw.includes(claim))
        for (const marker of input.forbiddenValues) assert(!raw.includes(marker))
        assert.equal(await response.clone().text(), '', 'No SSR or PII before clean redirect')
        cookie = raw.split(';')[0]!
        counters.landings++
      } else if (url.pathname === path && request.method === 'GET') {
        assert(cookie && request.headers.get('cookie')?.includes(cookie), 'Browser must present issued cookie')
        assert.equal(response.status, 200, 'Real compiled SSR must succeed')
        assert(response.headers.get('content-type')?.includes('text/html'))
        const html = await response.clone().text()
        assert(Buffer.byteLength(html) <= 5 * 1024 * 1024, 'Bounded compiled document')
        noSecrets(html)
        assert(html.includes('Este enlace permite solo consulta.'), 'Real SSR view-only notice required')
        counters.documentReads++
      } else if (url.pathname === trackingPath && request.method === 'GET') {
        assert(cookie && request.headers.get('cookie')?.includes(cookie), 'Tracking requires the issued sealed grant')
        browserTracking = await tracking(response.clone())
      }
      return { action: 'fulfill', response }
    } catch {
      throw new GuestOrderBrowserError('forward')
    }
  }
  async function verifyReadOnlyGrant() {
    try {
      assert(cookie && counters.landings === 1 && !counters.revoked)
      await readOwn()
      await tracking(await get(trackingPath))
      const anonymousTracking = await get(trackingPath, null)
      assert.equal(anonymousTracking.status, 401)
      assert(anonymousTracking.headers.get('cache-control')?.includes('no-store'))
      assert(!anonymousTracking.headers.has('set-cookie'))
      const foreignTracking = await get('/api/orders/00000000-0000-4000-8000-000000000008/tracking')
      assert.equal(foreignTracking.status, 404)
      assert(foreignTracking.headers.get('cache-control')?.includes('no-store'))
      assert(!foreignTracking.headers.has('set-cookie'))
      assert.equal((await get(detailPath, null)).status, 401)
      for (const protectedPath of [detailPath + '/lines', detailPath + '/fiscal', detailPath + '/refunds'])
        assert.equal((await get(protectedPath)).status, 401, 'View cookie cannot authorize private APIs')
      assert.equal((await get('/api/orders/00000000-0000-4000-8000-000000000008')).status, 401)
      verified = true
    } catch {
      throw new GuestOrderBrowserError('read_only_grant')
    }
  }
  async function revoke() {
    try {
      assert(verified && cookie && !counters.revoked)
      const logout = (origin: string) =>
        input.dispatch(
          new Request(input.origin + '/api/auth/logout', {
            method: 'POST',
            headers: { Cookie: cookie!, Origin: origin, 'CF-Connecting-IP': '192.0.2.173' },
            redirect: 'manual'
          })
        )
      assert.equal((await logout('https://foreign.invalid')).status, 403, 'CSRF rejection cannot revoke')
      await readOwn()
      const response = await logout(input.origin)
      assert.equal(response.status, 200)
      assert(response.headers.get('set-cookie')?.includes('neteco-guest-order-access-v1=; Max-Age=0'))
      assert.equal((await get(detailPath)).status, 401, 'Old guest cookie must lose authority')
      const revokedTracking = await get(trackingPath)
      assert.equal(revokedTracking.status, 404, 'Revocation also denies tracking')
      assert(revokedTracking.headers.get('cache-control')?.includes('no-store'))
      assert(!revokedTracking.headers.has('set-cookie'))
      assert.equal(
        (
          await input.dispatch(
            new Request(input.emailLink, { headers: { 'CF-Connecting-IP': '192.0.2.173' }, redirect: 'manual' })
          )
        ).status,
        404,
        'Original view link must also be revoked'
      )
      counters.revoked = true
    } catch {
      throw new GuestOrderBrowserError('revocation')
    }
  }
  return {
    forward,
    verifyReadOnlyGrant,
    revoke,
    state: () => ({ ...counters }),
    trackingSnapshot: () => browserTracking
  }
}
export async function auditNativeGuestOrderBrowser(input: NativeGuestOrderBrowserInput) {
  try {
    isolatedOrigin(input.origin)
    assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  } catch {
    throw new GuestOrderBrowserError('configuration')
  }
  if (input.browserMode === 'not-run')
    return { scenarios: 0, browserExecuted: false, viewports: [], reason: REMOTE_BROWSER_NOT_RUN_REASON }
  const browser = await connectRemoteTestBrowser(chromium)
  const contexts: BrowserContext[] = [],
    viewports = ['desktop', 'mobile'] as const
  let scenarios = 0,
    currentViewport: 'desktop' | 'mobile' | null = null
  try {
    for (const [index, viewport] of viewports.entries()) {
      currentViewport = viewport
      const fixture = await input.prepareGuestOrder(viewport),
        bridge = await createGuestOrderBrowserBridge({ ...input, ...fixture }),
        context = await browser.newContext({
          locale: 'es-ES',
          timezoneId: 'Europe/Madrid',
          serviceWorkers: 'block',
          viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
        })
      contexts.push(context)
      let transportFailed = false,
        pageErrors = 0
      await context.route('**/*', async (route) => {
        try {
          const incoming = route.request(),
            headers = await incoming.allHeaders(),
            payload = incoming.postDataBuffer()
          headers['cf-connecting-ip'] = '192.0.2.173'
          headers['accept-encoding'] = 'identity'
          const result = await bridge.forward(
            new Request(incoming.url(), {
              method: incoming.method(),
              headers,
              redirect: 'manual',
              ...(payload ? { body: Uint8Array.from(payload).buffer } : {})
            })
          )
          if (result.action === 'abort') {
            transportFailed = true
            await route.abort('failed')
          } else {
            const forwarded = Object.fromEntries(result.response.headers)
            delete forwarded['content-length']
            delete forwarded['content-encoding']
            await route.fulfill({
              status: result.response.status,
              headers: forwarded,
              body: Buffer.from(await result.response.arrayBuffer())
            })
          }
        } catch {
          transportFailed = true
          await route.abort('failed')
        }
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      await page.goto(fixture.emailLink, { waitUntil: 'networkidle', timeout: 30000 })
      const clean = new URL(page.url())
      assert(
        clean.origin === input.origin &&
          clean.pathname === `/pedido/${fixture.orderId}` &&
          !clean.search &&
          !clean.hash,
        'Browser URL must be clean'
      )
      await expect(page.getByRole('status').filter({ hasText: VIEW_ONLY_NOTICE })).toBeVisible({ timeout: 15000 })
      const trackingPanel = page.getByRole('region', { name: 'Seguimiento operativo del pedido', exact: true })
      await expect(
        trackingPanel.getByRole('heading', { name: 'Seguimiento operativo del pedido', exact: true })
      ).toBeVisible({ timeout: 15000 })
      await expect(trackingPanel.getByText('Pendiente de preparación', { exact: true })).toBeVisible({ timeout: 15000 })
      await expect(trackingPanel.getByText('No hay bultos registrados', { exact: true })).toBeVisible()
      await expect(
        trackingPanel.getByText('No hay referencias manuales de seguimiento registradas.', { exact: true })
      ).toBeVisible()
      await expect(
        trackingPanel.getByText('Seguimiento del transportista no conectado.', { exact: false })
      ).toBeVisible()
      const renderedTracking = bridge.trackingSnapshot()
      assert(renderedTracking, 'Rendered tracking must come from the actual sealed guest HTTP read')
      await expect(trackingPanel.locator('time')).toHaveAttribute('datetime', renderedTracking.evaluatedAt)
      await expect(page.locator('[data-order-payment-submit]')).toHaveCount(0)
      await expect(page.locator('[data-testid="credit-private-pdf"]')).toHaveCount(0)
      await expect(page.locator(`a[href^="/api/orders/${fixture.orderId}/invoice"]`)).toHaveCount(0)
      const html = await page.content(),
        claim = new URL(fixture.emailLink).searchParams.get('token')!
      assert(!html.includes(claim))
      for (const marker of fixture.forbiddenValues) assert(!html.includes(marker))
      await page.keyboard.press('Tab')
      assert(
        await page.evaluate(() => document.activeElement !== document.body),
        'Keyboard focus must reach an existing control'
      )
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      await bridge.verifyReadOnlyGrant()
      await bridge.revoke()
      assert(bridge.state().landings === 1 && bridge.state().documentReads >= 1 && bridge.state().revoked)
      assert(
        !transportFailed &&
          pageErrors === 0 &&
          bridge.state().blockedWrites === 0 &&
          bridge.state().blockedExternal === 0
      )
      input.scenario?.(GUEST_ORDER_BROWSER_SCENARIOS[index]!)
      scenarios++
      await context.close()
      contexts.pop()
    }
    return {
      scenarios,
      browserExecuted: true,
      viewports: [...viewports],
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd'
    }
  } catch {
    throw new GuestOrderBrowserError('compiled_guest_view', currentViewport)
  } finally {
    for (const context of contexts) {
      try {
        await context.close()
      } catch {
        /* No private browser errors escape. */
      }
    }
    try {
      await browser.close()
    } catch {
      /* Disconnect only, no browser launched here. */
    }
  }
}
