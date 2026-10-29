import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect, type Page } from '@playwright/test'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export function checkoutRecoveryForm(page: Pick<Page, 'locator'>) {
  return page.locator('form').filter({ has: page.locator('input[autocomplete="name"]') })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Outcome = { action: 'fulfill'; response: Response } | { action: 'abort'; reason: string }

/** The only injected faults are lost successful responses. Neither DTOs nor
 * access grants are manufactured; durable readback must precede every abort. */
export function createCheckoutRecoveryBrowserBridge(input: {
  origin: string
  dispatch: (request: Request) => Promise<Response>
  readOrder: (orderId: string, request: Pick<Request, 'headers' | 'json'>) => Promise<void>
  readPayment: (orderId: string, key: string, body: unknown, response: unknown) => Promise<void>
}) {
  const proof = {
    orderId: null as string | null,
    orderPosts: 0,
    paymentPosts: 0,
    recoveryGets: 0,
    blockedExternal: 0,
    forbiddenWrites: 0,
    paymentKey: null as string | null,
    paymentBody: null as { orderId: string; method: 'tarjeta' } | null
  }
  return {
    proof,
    async forward(request: Request): Promise<Outcome> {
      const target = new URL(request.url)
      if (target.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const orderPost = request.method === 'POST' && target.pathname === '/api/orders'
      const paymentPost = request.method === 'POST' && target.pathname === '/api/checkout/pay'
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        !(request.method === 'POST' && (orderPost || paymentPost || target.pathname === '/api/shipping/rates')) &&
        !(request.method === 'DELETE' && target.pathname === '/api/analytics/session')
      ) {
        proof.forbiddenWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      if (orderPost) {
        assert.equal(proof.orderPosts, 0, 'An uncertain checkout must never send another order command')
        proof.orderPosts++
      }
      if (target.pathname === '/api/checkout/recover') {
        assert.equal(request.method, 'GET')
        proof.recoveryGets++
      }
      const copy = request.clone()
      let payment: { orderId: string; method: 'tarjeta' } | null = null
      let key: string | null = null
      if (paymentPost) {
        const body = (await copy.clone().json()) as Record<string, unknown>
        assert(proof.orderId && body.orderId === proof.orderId)
        assert.deepEqual(Object.keys(body).sort(), ['method', 'orderId'])
        assert.equal(body.method, 'tarjeta', 'The audit explicitly selects the enabled sandbox card method')
        key = request.headers.get('idempotency-key')
        assert(key && UUID.test(key), 'Recovered order payment requires its real UUID command key')
        payment = { orderId: proof.orderId, method: 'tarjeta' }
        if (proof.paymentKey) {
          assert.equal(key, proof.paymentKey, 'Manual payment retry must preserve the original command key')
          assert.deepEqual(payment, proof.paymentBody)
        }
      }
      const response = await input.dispatch(request)
      if (orderPost && response.status === 201) {
        const body = (await response.clone().json()) as { id?: unknown }
        assert(typeof body.id === 'string' && UUID.test(body.id), 'Lost order response needs a valid Worker receipt')
        await input.readOrder(body.id, copy)
        proof.orderId = body.id
        return { action: 'abort', reason: 'lost_order_response' }
      }
      if (paymentPost) {
        assert.equal(response.status, 200, 'Compiled payment request must succeed against the real Worker')
        const body = (await response.clone().json()) as { ok?: unknown }
        assert.equal(body.ok, true)
        await input.readPayment(proof.orderId!, key!, payment, body)
        proof.paymentKey = key
        proof.paymentBody = payment
        proof.paymentPosts++
        // Do not expose a valid signed bank redirect to the DOM/form submitter.
        return { action: 'abort', reason: 'prevent_provider_submission' }
      }
      return { action: 'fulfill', response }
    }
  }
}

/** Real compiled Nuxt hydration + disposable Worker/D1. Uses only the existing
 * private browser connection; never launches or provisions a browser. Seeds a
 * cart through APIs, never SQL orders/payment facts. The bank receives nothing. */
export async function auditNativeCheckoutRecoveryBrowser(input: {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  variantId: number
  quantity: number
  scenario: (name: string) => void
  browserMode?: 'required' | 'not-run'
}) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  assert(Number.isSafeInteger(input.variantId) && input.variantId > 0)
  assert(Number.isSafeInteger(input.quantity) && input.quantity > 0)
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
      orderId: null,
      orderPosts: null,
      paymentPosts: null,
      recoveryGets: null,
      paymentReadRefreshes: null,
      screenshots: [],
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  const browser = await connectRemoteTestBrowser(chromium)
  try {
    const context = await browser.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1440, height: 1000 }
    })
    try {
      const empty = await input.dispatch(
        new Request(input.origin + '/api/cart', {
          headers: { 'cf-connecting-ip': '192.0.2.56' }
        })
      )
      assert.equal(empty.status, 200)
      const cookie = empty.headers
        .getSetCookie()
        .find((value) => value.startsWith('neteco-cart-v2='))
        ?.split(';')[0]
      assert(cookie, 'Browser cart credentials must come from the real cart API')
      const cart = (await empty.json()) as { id: string; version: number }
      assert(UUID.test(cart.id))
      const added = await input.dispatch(
        new Request(input.origin + '/api/cart/items', {
          method: 'POST',
          headers: {
            origin: input.origin,
            cookie,
            'content-type': 'application/json',
            'cf-connecting-ip': '192.0.2.56'
          },
          body: JSON.stringify({
            variantId: input.variantId,
            quantity: input.quantity,
            expectedVersion: cart.version,
            idempotencyKey: randomUUID()
          })
        })
      )
      assert.equal(added.status, 200)
      await context.addCookies([
        {
          name: 'neteco-cart-v2',
          value: cookie.slice('neteco-cart-v2='.length),
          url: input.origin,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax'
        }
      ])
      let requests = 0,
        pageErrors = 0,
        paymentReadRefreshes = 0
      const bridge = createCheckoutRecoveryBrowserBridge({
        origin: input.origin,
        dispatch: input.dispatch,
        async readOrder(orderId, request) {
          const body = (await request.json()) as { cartId: string }
          assert.equal(body.cartId, cart.id)
          const row = await input.database
            .prepare(
              `SELECT o.cart_id AS cartId, r.status AS reservation,
            a.state AS attemptState, a.command_key AS commandKey FROM orders o
            JOIN inventory_reservations r ON r.id=o.reservation_id
            JOIN checkout_attempts a ON a.order_id=o.id WHERE o.id=?`
            )
            .bind(orderId)
            .first<{ cartId: string; reservation: string; attemptState: string; commandKey: string }>()
          assert(row)
          assert.equal(row.cartId, cart.id)
          assert.equal(row.reservation, 'reserved')
          assert.equal(row.attemptState, 'completed')
          assert.equal(row.commandKey, request.headers.get('idempotency-key'))
          assert.equal(
            (
              await input.database
                .prepare('SELECT COUNT(*) AS n FROM orders WHERE cart_id=?')
                .bind(cart.id)
                .first<{ n: number }>()
            )?.n,
            1
          )
        },
        async readPayment(orderId, key, body, response) {
          assert.deepEqual(body, { orderId, method: 'tarjeta' })
          const redirect = response as {
            ok: boolean
            redirect: { actionUrl: string; method: string; fields: Record<string, string> }
          }
          assert.equal(redirect.redirect.actionUrl, 'https://sis-t.redsys.es:25443/sis/realizarPago')
          assert.equal(redirect.redirect.method, 'POST')
          assert.equal(redirect.redirect.fields.Ds_SignatureVersion, 'HMAC_SHA512_V2')
          assert(redirect.redirect.fields.Ds_Signature && redirect.redirect.fields.Ds_MerchantParameters)
          const intent = await input.database
            .prepare(`SELECT id,method,status FROM payment_intents WHERE order_id=?`)
            .bind(orderId)
            .first<{ id: string; method: string; status: string }>()
          assert(intent)
          assert.equal(intent.method, 'card')
          assert.equal(intent.status, 'redirect_ready')
          assert.equal(
            (
              await input.database
                .prepare('SELECT COUNT(*) AS n FROM payment_intents WHERE order_id=?')
                .bind(orderId)
                .first<{ n: number }>()
            )?.n,
            1
          )
          const command = await input.database
            .prepare(
              `SELECT response_body AS body FROM payment_commands
            WHERE order_id=? AND command_id=?`
            )
            .bind(orderId, key)
            .first<{ body: string }>()
          assert(command)
          const saved = JSON.parse(command.body) as { paymentIntentId: string; redirect: unknown }
          assert.equal(saved.paymentIntentId, intent.id)
          assert.deepEqual(saved.redirect, redirect.redirect)
          assert.equal(
            (
              await input.database
                .prepare('SELECT COUNT(*) AS n FROM payment_commands WHERE order_id=?')
                .bind(orderId)
                .first<{ n: number }>()
            )?.n,
            1
          )
        }
      })
      const routeFailures: unknown[] = []
      await context.route('**/*', async (route) => {
        try {
          const incoming = route.request()
          const headers = await incoming.allHeaders()
          headers['cf-connecting-ip'] = '192.0.2.56'
          headers['accept-encoding'] = 'identity'
          const bytes = incoming.postDataBuffer()
          requests++
          const target = new URL(incoming.url())
          if (target.pathname === `/api/orders/${bridge.proof.orderId}` && incoming.method() === 'GET')
            paymentReadRefreshes++
          const result = await bridge.forward(
            new Request(target, {
              method: incoming.method(),
              headers,
              ...(bytes ? { body: new Uint8Array(bytes) } : {})
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
        } catch (error) {
          routeFailures.push(error)
          await route.abort('failed')
        }
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      const directory = resolve('test-results/native-checkout-recovery-browser')
      await mkdir(directory, { recursive: true })
      input.scenario('native_checkout_compiled_lost_response_manual_recovery')
      await page.goto(input.origin + '/checkout', { waitUntil: 'networkidle', timeout: 30_000 })
      await page.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
      const checkoutForm = checkoutRecoveryForm(page)
      await expect(checkoutForm.locator('input[autocomplete="name"]')).toBeVisible({ timeout: 15_000 })
      await checkoutForm.locator('input[autocomplete="name"]').fill('Comprador sintético local')
      await checkoutForm.locator('input[autocomplete="email"]').fill('synthetic-browser@example.invalid')
      await checkoutForm.locator('input[autocomplete="tel"]').fill('600000000')
      await checkoutForm.locator('input[autocomplete="shipping address-line1"]').fill('Carrer Major 1')
      await checkoutForm.locator('input[autocomplete="shipping postal-code"]').fill('46870')
      await checkoutForm.locator('input[autocomplete="shipping address-level2"]').fill('Ontinyent')
      await expect(checkoutForm.locator('input[type="radio"][value="recogida"]')).toBeVisible()
      await checkoutForm.locator('input[type="radio"][value="recogida"]').check()
      await checkoutForm.locator('label').filter({ hasText: 'Acepto las' }).locator('input[type="checkbox"]').check()
      await checkoutForm.locator('button[type="submit"]').click()
      await expect(page.getByRole('button', { name: 'Comprobar pedido', exact: true })).toBeEnabled({ timeout: 15_000 })
      assert(bridge.proof.orderId, 'The first order must be committed before its response is dropped')
      await checkoutForm.locator('input[autocomplete="name"]').fill('Comprador editado tras respuesta perdida')
      await checkoutForm.locator('input[autocomplete="shipping address-line1"]').fill('Otra dirección sintética 99')
      await expect(checkoutForm.locator('button[type="submit"]')).toBeDisabled()
      assert.equal(bridge.proof.orderPosts, 1)
      assert.equal(bridge.proof.paymentPosts, 0)
      await page.screenshot({ path: resolve(directory, 'lost-order-response.png'), fullPage: true })
      await page.getByRole('button', { name: 'Comprobar pedido', exact: true }).click()
      await expect(page).toHaveURL(input.origin + '/pedido/' + bridge.proof.orderId, { timeout: 15_000 })
      await expect(page.locator('[data-order-payment-submit]')).toBeVisible({ timeout: 15_000 })
      assert.equal(bridge.proof.orderPosts, 1)
      assert.equal(bridge.proof.paymentPosts, 0, 'Recovery navigation must never automatically initiate payment')
      assert(bridge.proof.recoveryGets >= 2, 'Checkout must explicitly repeat the authenticated recovery read')
      input.scenario('native_recovered_order_compiled_explicit_payment_durable_retry')
      await page.locator('input[name="order-payment-method"][value="tarjeta"]').check()
      await page.locator('[data-order-payment-submit]').click()
      await expect(page.locator('[data-order-payment-refresh]')).toBeEnabled({ timeout: 15_000 })
      assert.equal(bridge.proof.paymentPosts, 1)
      await expect(page.locator('[data-order-payment-submit]')).toBeDisabled()
      const readsBefore = paymentReadRefreshes
      await page.locator('[data-order-payment-refresh]').click()
      await expect(page.locator('[data-order-payment-submit]')).toBeEnabled({ timeout: 15_000 })
      assert.equal(paymentReadRefreshes, readsBefore + 1)
      assert.equal(bridge.proof.paymentPosts, 1, 'A manual refresh must never reissue payment')
      await page.locator('[data-order-payment-submit]').click()
      await expect(page.locator('[data-order-payment-refresh]')).toBeEnabled({ timeout: 15_000 })
      assert.equal(bridge.proof.paymentPosts, 2)
      await page.screenshot({ path: resolve(directory, 'recovered-order-payment.png'), fullPage: true })
      assert.deepEqual(routeFailures, [], 'Every forwarded browser request must satisfy the real Worker contract')
      assert.equal(pageErrors, 0)
      assert.equal(bridge.proof.blockedExternal, 0, 'No bank or other external request may even be attempted')
      assert.equal(bridge.proof.forbiddenWrites, 0)
      return {
        scenarios: 2,
        browserStatus: 'passed' as const,
        reason: null,
        engine: 'remote_playwright_chromium',
        transport: 'playwright_same_origin_forwarding_to_real_workerd',
        requests,
        pageErrors,
        ...bridge.proof,
        paymentReadRefreshes,
        screenshots: [
          'test-results/native-checkout-recovery-browser/lost-order-response.png',
          'test-results/native-checkout-recovery-browser/recovered-order-payment.png'
        ],
        syntheticSessionOnly: true,
        providerSubmission: false,
        productionBrowserAcceptance: false
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
