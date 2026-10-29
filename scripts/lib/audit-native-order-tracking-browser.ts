import assert from 'node:assert/strict'
import { expect, type Browser, type Page } from '@playwright/test'
import { fulfillmentOrderIdSchema } from '../../shared/order-fulfillment'
import { orderTrackingSchema, type OrderTracking, type OrderTrackingAudience } from '../../shared/order-tracking'
import { readOrderReturnsDomainDigest } from './audit-native-order-returns-browser'

export interface OrderTrackingBrowserBridgeInput {
  origin: string
  orderId: string
  cookie: string
  audience: OrderTrackingAudience
  dispatch: (request: Request) => Promise<Response>
}
/** Read-only forwarding to the actual Worker: no DTO/DOM synthesis, provider
 * requests, arbitrary private reads, payment or retry commands. */
export function createOrderTrackingBrowserBridge(input: OrderTrackingBrowserBridgeInput) {
  assert.equal(input.origin, 'https://shop-audit.neteco.test')
  fulfillmentOrderIdSchema.parse(input.orderId)
  assert(input.cookie.length > 0 && input.cookie.length <= 16384 && !/[\r\n]/.test(input.cookie))
  const trackingPath = `/api/${input.audience === 'admin' ? 'admin/' : ''}orders/${input.orderId}/tracking`
  const allowed = new Set([
    '/api/auth/session',
    `/api/orders/${input.orderId}`,
    `/api/orders/${input.orderId}/lines`,
    trackingPath
  ])
  const proof = { trackingReads: 0, blockedExternal: 0, blockedWrites: 0, blockedPrivateReads: 0 }
  return {
    proof,
    async forward(
      request: Request
    ): Promise<{ action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }> {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const consent = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !consent) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      if (
        !consent &&
        ((url.pathname.startsWith('/api/') && (!allowed.has(url.pathname) || url.search)) ||
          url.pathname.startsWith('/admin'))
      ) {
        proof.blockedPrivateReads++
        return { action: 'abort', reason: 'unrelated_private_read' }
      }
      const response = await input.dispatch(request)
      if (url.pathname === trackingPath && response.status === 200) {
        assert.match(response.headers.get('cache-control') ?? '', /no-store/)
        assert.equal(response.headers.get('set-cookie'), null)
        const dto = orderTrackingSchema.parse(await response.clone().json())
        assert.equal(dto.orderId, input.orderId)
        assert.equal(dto.audience, input.audience)
        proof.trackingReads++
      }
      return { action: 'fulfill', response }
    }
  }
}
export interface NativeOrderTrackingBrowserInput {
  browser: Browser
  adminPage: Page
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  orderId: string
  adminCookie: string
  customerCookie: string
  viewport: { width: number; height: number }
}

function credential(cookie: string) {
  const match = /^neteco-session=([^;\s]+)$/.exec(cookie)
  assert(match, 'One current synthetic customer session required')
  return match[1]!
}
function confirmed(dto: OrderTracking, id: string, audience: 'admin' | 'customer') {
  assert.equal(dto.orderId, id)
  assert.equal(dto.audience, audience)
  assert.equal(dto.fulfillment.state, 'packed')
  assert.equal(dto.fulfillment.version, 2)
  assert.equal(dto.packing.parcelCount, 2)
  assert.equal(dto.shipments.length, 2)
  assert(dto.shipments.every((item) => item.verification === 'manual_unverified'))
  assert.equal(dto.carrierStatus, 'not_connected')
  assert.deepEqual(dto.carrierEvents, [])
}
/** Embedded in the existing packing desktop/mobile journeys: zero additional
 * scenario IDs, no separate connection/lease or synthetic carrier events. */
export async function auditNativeOrderTrackingBrowser(input: NativeOrderTrackingBrowserInput) {
  assert.equal(input.origin, 'https://shop-audit.neteco.test')
  fulfillmentOrderIdSchema.parse(input.orderId)
  assert.notEqual(input.adminCookie, input.customerCookie, 'Customer and administrator contexts must be distinct')
  const customerCredential = credential(input.customerCookie)
  const before = await readOrderReturnsDomainDigest(input.database, input.orderId)
  async function read(admin: boolean) {
    const response = await input.dispatch(
      new Request(`${input.origin}/api/${admin ? 'admin/' : ''}orders/${input.orderId}/tracking`, {
        headers: { Cookie: admin ? input.adminCookie : input.customerCookie, 'CF-Connecting-IP': '192.0.2.173' }
      })
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(response.headers.get('set-cookie'), null)
    const dto = orderTrackingSchema.parse(await response.json())
    confirmed(dto, input.orderId, admin ? 'admin' : 'customer')
    return dto
  }
  const admin = await read(true),
    customer = await read(false)
  // Audience and server evaluation time differ; operational facts must not.
  for (const key of [
    'shippingMethod',
    'fulfillment',
    'packing',
    'shipments',
    'carrierEvents',
    'carrierStatus',
    'fallback'
  ] as const)
    assert.deepEqual(customer[key], admin[key])
  async function visible(page: Page, dto: OrderTracking) {
    const panel = page.getByRole('region', { name: 'Seguimiento operativo del pedido', exact: true })
    await expect(panel.getByTestId('order-tracking-refresh')).toBeVisible({ timeout: 15000 })
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname.endsWith(`/${input.orderId}/tracking`) && value.request().method() === 'GET'
    )
    await panel.getByTestId('order-tracking-refresh').click()
    const refreshed = await response
    assert.equal(refreshed.status(), 200)
    confirmed(orderTrackingSchema.parse(await refreshed.json()), input.orderId, dto.audience as 'admin' | 'customer')
    await expect(panel).toContainText('Seguimiento del transportista no conectado')
    await expect(panel).toContainText('Referencia manual no verificada')
    for (const shipment of dto.shipments) {
      await expect(panel).toContainText(shipment.carrier)
      await expect(panel).toContainText(shipment.trackingNumber)
    }
    await expect(panel.getByRole('link')).toHaveCount(1)
    await expect(panel.getByRole('link')).toHaveAttribute('href', '/contacto')
    assert.equal(await panel.locator('a[href^="http"]').count(), 0)
    const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))
    assert(size.width <= size.viewport + 1, 'Tracking must not overflow viewport')
  }
  await visible(input.adminPage, admin)
  const context = await input.browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    viewport: input.viewport,
    serviceWorkers: 'block'
  })
  const bridge = createOrderTrackingBrowserBridge({ ...input, cookie: input.customerCookie, audience: 'customer' })
  let failure: unknown = null,
    pageErrors = 0
  try {
    await context.addCookies([
      {
        name: 'neteco-session',
        value: customerCredential,
        url: input.origin,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }
    ])
    await context.route('**/*', async (route) => {
      try {
        const incoming = route.request(),
          headers = await incoming.allHeaders()
        headers['cf-connecting-ip'] = '192.0.2.173'
        headers['accept-encoding'] = 'identity'
        const payload = incoming.postDataBuffer()
        const result = await bridge.forward(
          new Request(incoming.url(), {
            method: incoming.method(),
            headers,
            ...(payload ? { body: Uint8Array.from(payload).buffer } : {}),
            redirect: 'manual'
          })
        )
        if (result.action === 'abort') {
          await route.abort('failed')
          return
        }
        const forwarded = Object.fromEntries(result.response.headers)
        delete forwarded['content-encoding']
        delete forwarded['content-length']
        await route.fulfill({
          status: result.response.status,
          headers: forwarded,
          body: Buffer.from(await result.response.arrayBuffer())
        })
      } catch (cause) {
        failure = cause
        await route.abort('failed')
      }
    })
    const page = await context.newPage()
    page.on('pageerror', () => pageErrors++)
    await page.goto(`${input.origin}/pedido/${input.orderId}`, { waitUntil: 'networkidle', timeout: 30000 })
    await visible(page, customer)
    if (failure) throw failure
    assert.equal(pageErrors, 0)
    assert(bridge.proof.trackingReads >= 1, 'Compiled customer refresh must reach the actual tracking endpoint')
  } finally {
    await context.close()
  }
  const after = await readOrderReturnsDomainDigest(input.database, input.orderId)
  assert.equal(after, before, 'Tracking reads must not mutate stock, money or fulfillment')
  return {
    source: 'cloudflare' as const,
    audiences: ['admin', 'customer'],
    customerTrackingReads: bridge.proof.trackingReads,
    before,
    after,
    pageErrors,
    providerSubmission: false,
    productionAcceptance: false
  }
}
