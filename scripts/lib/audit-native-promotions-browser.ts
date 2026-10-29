import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { z } from 'zod'
import {
  adminPromotionInputSchema,
  adminPromotionReceiptSchema,
  adminPromotionCommandSchema,
  adminPromotionDetailSchema,
  adminPromotionIntentHash,
  type AdminPromotionInput,
  type AdminPromotionReceipt
} from '../../shared/admin-promotions'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { checkoutRecoveryForm } from './audit-native-checkout-recovery-browser'
import {
  promotionBasketPreviewInputSchema,
  promotionBasketPreviewResponseSchema
} from '../../shared/promotion-basket-preview'

export const PROMOTIONS_BROWSER_SCENARIOS = [
  'native_promotions_compiled_admin_and_coupon_checkout_recovery_desktop',
  'native_promotions_compiled_admin_and_coupon_checkout_recovery_mobile'
] as const
export interface PromotionsBrowserFixture {
  customerCookie: string
  cartCookie: string
  cartId: string
  code: string
  startsAt: string
  quantity: number
  goodsGrossCents: number
  discountGrossCents: number
  variantId: string
  sku: string
  customerId: string
}
export interface NativePromotionsBrowserInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  browserMode?: 'required' | 'not-run'
  prepare: (viewport: 'desktop' | 'mobile') => Promise<PromotionsBrowserFixture>
  scenario?: (name: string) => void
}
export type PromotionsBrowserBridgeInput = Omit<NativePromotionsBrowserInput, 'browserMode' | 'prepare' | 'scenario'> &
  PromotionsBrowserFixture & { purchaseOrderReference?: string }
function isolated(origin: string) {
  const url = new URL(origin)
  assert(url.origin === origin && url.protocol === 'https:' && url.hostname === 'shop-audit.neteco.test')
}
function session(cookie: string) {
  const match = /^neteco-session=([^;\r\n]+)$/.exec(cookie)
  assert(match && cookie.length <= 16384)
  return match[1]!
}
async function json(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i)
  const bytes = await response.clone().arrayBuffer()
  assert(bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
/** Transport faults are injected only AFTER actual HTTP success, immutable
 * receipt proof and independent D1/readback. Never fabricates a success DTO. */
export async function createPromotionsBrowserBridge(input: PromotionsBrowserBridgeInput) {
  isolated(input.origin)
  session(input.adminCookie)
  session(input.customerCookie)
  z.object({
    cartId: z.string().uuid(),
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/),
    startsAt: z.string().datetime(),
    quantity: z.number().int().min(1).max(999),
    goodsGrossCents: z.number().int().positive().safe(),
    discountGrossCents: z.number().int().positive().safe(),
    purchaseOrderReference: z.string().min(1).max(120).optional(),
    variantId: z.string().min(1).max(200),
    sku: z.string().min(1).max(200),
    customerId: z.string().uuid()
  })
    .strict()
    .parse({
      cartId: input.cartId,
      code: input.code,
      startsAt: input.startsAt,
      quantity: input.quantity,
      goodsGrossCents: input.goodsGrossCents,
      discountGrossCents: input.discountGrossCents,
      purchaseOrderReference: input.purchaseOrderReference,
      variantId: input.variantId,
      sku: input.sku,
      customerId: input.customerId
    })
  assert(input.goodsGrossCents > input.discountGrossCents)
  assert.match(input.cartCookie, new RegExp('^neteco-cart-v2=v1\\.' + input.cartId + '\\.[A-Za-z0-9_-]{43}$'))
  const counts = {
    adminCreates: 0,
    adminUpdates: 0,
    adminRecovered: false,
    orderPosts: 0,
    orderRecovered: false,
    lostResponses: 0,
    receiptGets: 0,
    recoveryGets: 0,
    paymentPosts: 0,
    blockedWrites: 0,
    blockedExternal: 0,
    basketPreviews: 0
  }
  async function domainDigest() {
    const tables = [
      'carts',
      'cart_lines',
      'checkout_quotes',
      'shipping_quotes',
      'orders',
      'promotion_rules',
      'promotion_rule_versions',
      'promotion_redemptions',
      'promotion_admin_commands',
      'inventory_balances',
      'inventory_movements'
    ]
    const hash = createHash('sha256')
    for (const table of tables) {
      const rows = await input.database.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1001`).all()
      assert(rows.success && rows.results.length <= 1000)
      hash.update(table).update(JSON.stringify(rows.results))
    }
    return hash.digest('hex')
  }
  let initial: AdminPromotionInput | null = null,
    activation: AdminPromotionReceipt | null = null,
    adminReceiptRead = false,
    orderId: string | null = null
  const get = (path: string, hash?: string) =>
    input.dispatch(
      new Request(input.origin + path, {
        headers: {
          Cookie: input.adminCookie,
          Origin: input.origin,
          'CF-Connecting-IP': '192.0.2.173',
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        }
      })
    )
  async function currentRule(receipt: AdminPromotionReceipt) {
    const current = adminPromotionDetailSchema.parse(
      await json(await get('/api/admin/promotions/' + receipt.ruleId), 200)
    )
    assert(initial)
    assert.deepEqual(current.rule, { ...initial.rule, version: 2, status: 'active' })
    assert.equal(current.redemptions, 0)
    return current
  }
  async function orderProof(id: string, key?: string) {
    assert(initial)
    const row = await input.database
      .prepare(
        `SELECT o.cart_id,o.customer_id,o.total_gross_cents,o.quote_id,o.purchase_order_reference,a.state,a.command_key,
      r.rule_id,r.rule_version,r.discount_gross_cents,
      (SELECT sum(quantity) FROM order_lines WHERE order_id=o.id) AS quantity,
      (SELECT sum(unit_gross_cents*quantity) FROM order_lines WHERE order_id=o.id) AS base_gross,
      (SELECT sum(discount_gross_cents) FROM order_lines WHERE order_id=o.id) AS discount,
      (SELECT sum(gross_cents) FROM order_lines WHERE order_id=o.id) AS gross,
      (SELECT count(*) FROM orders WHERE cart_id=o.cart_id) AS order_count,
      (SELECT count(*) FROM promotion_redemptions WHERE order_id=o.id) AS uses,
      (SELECT count(*) FROM payment_intents WHERE order_id=o.id) AS payments
      FROM orders o JOIN checkout_attempts a ON a.order_id=o.id JOIN promotion_redemptions r ON r.order_id=o.id WHERE o.id=?`
      )
      .bind(id)
      .first<Record<string, unknown>>()
    assert(row)
    assert.equal(row.cart_id, input.cartId)
    if (input.purchaseOrderReference !== undefined) {
      assert.equal(row.purchase_order_reference, input.purchaseOrderReference)
    }
    assert.equal(row.state, 'completed')
    assert(row.customer_id)
    if (key) assert.equal(row.command_key, key)
    assert.equal(row.rule_id, initial.rule.id)
    assert.equal(row.rule_version, 2)
    assert.equal(row.quantity, input.quantity)
    assert.equal(row.base_gross, input.goodsGrossCents)
    assert.equal(row.discount, input.discountGrossCents)
    assert.equal(row.discount_gross_cents, input.discountGrossCents)
    assert.equal(row.gross, input.goodsGrossCents - input.discountGrossCents)
    assert.equal(row.total_gross_cents, row.gross)
    assert.equal(row.order_count, 1)
    assert.equal(row.uses, 1)
    assert.equal(row.payments, 0)
  }
  async function forward(
    request: Request
  ): Promise<{ action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }> {
    const url = new URL(request.url),
      path = url.pathname
    if (url.origin !== input.origin) {
      counts.blockedExternal++
      return { action: 'abort', reason: 'external_request' }
    }
    const create = path === '/api/admin/promotions' && request.method === 'POST',
      update = Boolean(initial) && path === '/api/admin/promotions/' + initial!.rule.id && request.method === 'PUT',
      checkout = path === '/api/orders' && request.method === 'POST',
      shipping = path === '/api/shipping/rates' && request.method === 'POST',
      basketPreview =
        path === '/api/admin/promotions/basket-preview' &&
        request.method === 'POST' &&
        !url.search &&
        (request.headers.get('cookie') ?? '').split(';').some((cookie) => cookie.trim() === input.adminCookie),
      consent = path === '/api/analytics/session' && request.method === 'DELETE' && !url.search
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !create &&
      !update &&
      !checkout &&
      !shipping &&
      !basketPreview &&
      !consent
    ) {
      counts.blockedWrites++
      return { action: 'abort', reason: 'forbidden_write' }
    }
    let command: AdminPromotionInput | null = null,
      key: string | null = null
    if (create || update) {
      key = z.string().uuid().parse(request.headers.get('idempotency-key'))
      command = adminPromotionInputSchema.parse(await request.clone().json())
      assert.equal(command.rule.code, input.code)
      assert.equal(command.rule.startsAt, input.startsAt)
      assert.deepEqual(command.rule.benefit, { kind: 'fixed', grossCents: input.discountGrossCents })
      assert.deepEqual(command.rule.scope, { kind: 'all' })
      assert.equal(command.rule.segment, 'registered')
      assert.equal(command.rule.volumeMode, 'stack_volume')
      assert.equal(command.rule.perCustomerLimit, 1)
      assert.equal(command.rule.totalLimit, null)
      if (create) {
        assert.equal(counts.adminCreates, 0)
        assert.equal(command.expectedVersion, 0)
        assert.equal(command.rule.status, 'paused')
        counts.adminCreates++
      } else {
        assert(initial)
        assert.equal(counts.adminUpdates, 0)
        assert.equal(command.expectedVersion, 1)
        assert.deepEqual(command.rule, { ...initial.rule, version: 2, status: 'active' })
        counts.adminUpdates++
      }
    }
    if (checkout) {
      assert(counts.adminRecovered)
      assert.equal(counts.orderPosts, 0)
      const body = (await request.clone().json()) as Record<string, unknown>
      assert.equal(body.cartId, input.cartId)
      assert.equal(body.expectedTotalGrossCents, input.goodsGrossCents - input.discountGrossCents)
      key = z.string().uuid().parse(request.headers.get('idempotency-key'))
      counts.orderPosts++
    }
    let beforePreview: string | undefined
    if (basketPreview) {
      assert(initial && counts.adminRecovered)
      const body = promotionBasketPreviewInputSchema.parse(await request.clone().json())
      assert.deepEqual(body.lines, [{ variantId: input.variantId, quantity: input.quantity }])
      assert.deepEqual(body.destination, { postalCode: '46870', city: 'Ontinyent' })
      assert.equal(body.customerId, input.customerId)
      assert(body.rule.version >= 2)
      assert.deepEqual(body.rule, { ...initial.rule, version: body.rule.version, status: 'active' })
      beforePreview = await domainDigest()
    }
    const response = await input.dispatch(request)
    if (basketPreview) {
      const preview = promotionBasketPreviewResponseSchema.parse(await json(response, 200))
      assert.equal(preview.lines.length, 1)
      assert.equal(preview.lines[0]!.variantId, input.variantId)
      assert.equal(preview.lines[0]!.sku, input.sku)
      assert.equal(preview.lines[0]!.quantity, input.quantity)
      assert.equal(preview.totals.base.grossCents, input.goodsGrossCents)
      assert.equal(preview.totals.proposed.grossCents, input.goodsGrossCents - input.discountGrossCents)
      const variant = await input.database
        .prepare('SELECT cost_net_cents FROM variants WHERE id=?')
        .bind(input.variantId)
        .first<{ cost_net_cents: number | null }>()
      assert(variant)
      const cost = variant.cost_net_cents === null ? null : variant.cost_net_cents * input.quantity
      assert.equal(preview.lines[0]!.costNetCents, cost)
      assert.equal(preview.totals.proposed.costNetCents, cost)
      assert.equal(
        preview.totals.proposed.marginNetCents,
        cost === null ? null : preview.totals.proposed.netCents - cost
      )
      assert.equal(await domainDigest(), beforePreview)
      counts.basketPreviews++
    }
    if (create || update) {
      assert(command && key)
      const receipt = adminPromotionReceiptSchema.parse(await json(response, 201)),
        hash = await adminPromotionIntentHash(command)
      assert.equal(receipt.commandId, key)
      assert.equal(receipt.payloadHash, hash)
      assert.equal(receipt.ruleId, command.rule.id)
      assert.equal(receipt.version, command.rule.version)
      const proof = adminPromotionCommandSchema.parse(
        await json(await get('/api/admin/promotions/commands/' + key, hash), 200)
      )
      assert(proof.outcome === 'applied')
      assert.deepEqual(proof.receipt, receipt)
      if (create) initial = command
      else {
        await currentRule(receipt)
        activation = receipt
        counts.lostResponses++
        return { action: 'abort', reason: 'proven_promotion_activation_response_lost' }
      }
    }
    if (activation && path === '/api/admin/promotions/commands/' + activation.commandId && request.method === 'GET') {
      assert.equal(request.headers.get('x-neteco-command-payload-hash'), activation.payloadHash)
      const proof = adminPromotionCommandSchema.parse(await json(response, 200))
      assert(proof.outcome === 'applied')
      assert.deepEqual(proof.receipt, activation)
      adminReceiptRead = true
      counts.receiptGets++
    }
    if (
      activation &&
      path === '/api/admin/promotions/' + activation.ruleId &&
      request.method === 'GET' &&
      adminReceiptRead
    ) {
      const detail = adminPromotionDetailSchema.parse(await json(response, 200))
      assert(initial)
      assert.deepEqual(detail.rule, { ...initial.rule, version: 2, status: 'active' })
      counts.adminRecovered = true
    }
    if (checkout) {
      const receipt = z
        .object({ id: z.string().uuid() })
        .strict()
        .parse(await json(response, 201))
      await orderProof(receipt.id, key!)
      orderId = receipt.id
      counts.lostResponses++
      return { action: 'abort', reason: 'proven_coupon_order_response_lost' }
    }
    if (path === '/api/checkout/recover' && request.method === 'GET') {
      counts.recoveryGets++
      if (orderId) {
        const recovered = z
          .object({ orderId: z.string().uuid().nullable() })
          .strict()
          .parse(await json(response, 200))
        assert.equal(recovered.orderId, orderId)
        await orderProof(orderId)
        counts.orderRecovered = true
      }
    }
    return { action: 'fulfill', response }
  }
  return {
    forward,
    state: () => ({ ...counts, orderId }),
    assertComplete: async () => {
      assert(counts.adminRecovered && counts.orderRecovered && orderId)
      assert.equal(counts.adminCreates, 1)
      assert.equal(counts.adminUpdates, 1)
      assert.equal(counts.basketPreviews, 1)
      assert.equal(counts.orderPosts, 1)
      assert.equal(counts.lostResponses, 2)
      assert.equal(counts.paymentPosts, 0)
      assert.equal(counts.blockedWrites, 0)
      assert.equal(counts.blockedExternal, 0)
      assert(counts.receiptGets >= 1 && counts.recoveryGets >= 1)
      await orderProof(orderId)
      return { ...counts }
    }
  }
}
async function noOverflow(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
}
/** Compiled DOM only, private connect-only Chromium; never launches a browser. */
export async function auditNativePromotionsBrowser(input: NativePromotionsBrowserInput) {
  isolated(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserExecuted: false,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      viewports: [],
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  const browser = await connectRemoteTestBrowser(chromium),
    contexts: BrowserContext[] = [],
    results = []
  try {
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      const prepared = await input.prepare(viewport),
        purchaseOrderReference = `PO-AUDIT-${viewport.toUpperCase()}`,
        bridge = await createPromotionsBrowserBridge({ ...input, ...prepared, purchaseOrderReference })
      const contextFor = async (cookie: string, cart = false) => {
        const context = await browser.newContext({
          locale: 'es-ES',
          timezoneId: 'Europe/Madrid',
          serviceWorkers: 'block',
          viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
        })
        contexts.push(context)
        await context.addCookies([
          {
            name: 'neteco-session',
            value: session(cookie),
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          },
          ...(cart
            ? [
                {
                  name: 'neteco-cart-v2',
                  value: prepared.cartCookie.slice('neteco-cart-v2='.length),
                  url: input.origin,
                  httpOnly: true,
                  secure: true,
                  sameSite: 'Lax' as const
                }
              ]
            : [])
        ])
        let failures = 0,
          pageErrors = 0
        await context.route('**/*', async (route) => {
          try {
            const request = route.request(),
              headers = await request.allHeaders(),
              body = request.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.173'
            headers['accept-encoding'] = 'identity'
            const forwarded = await bridge.forward(
              new Request(request.url(), {
                method: request.method(),
                headers,
                redirect: 'manual',
                ...(body ? { body: Uint8Array.from(body).buffer } : {})
              })
            )
            if (forwarded.action === 'abort') {
              if (
                !['proven_promotion_activation_response_lost', 'proven_coupon_order_response_lost'].includes(
                  forwarded.reason
                )
              )
                failures++
              await route.abort('failed')
            } else {
              const headers = Object.fromEntries(forwarded.response.headers)
              delete headers['content-encoding']
              delete headers['content-length']
              const cookies = forwarded.response.headers.getSetCookie()
              if (cookies.length) headers['set-cookie'] = cookies.join('\n')
              await route.fulfill({
                status: forwarded.response.status,
                headers,
                body: Buffer.from(await forwarded.response.arrayBuffer())
              })
            }
          } catch {
            failures++
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => {
          pageErrors++
        })
        return {
          page,
          assertHealthy: async () => {
            assert.equal(failures, 0)
            assert.equal(pageErrors, 0)
            await noOverflow(page)
          }
        }
      }
      const admin = await contextFor(input.adminCookie)
      await admin.page.goto(input.origin + '/admin/promociones', { waitUntil: 'networkidle', timeout: 30000 })
      const panel = admin.page.getByRole('region', { name: 'Promociones', exact: true })
      await expect(panel.getByTestId('promotion-create')).toBeEnabled({ timeout: 15000 })
      await panel.getByTestId('promotion-create').click()
      await panel.getByTestId('promotion-code').fill(prepared.code)
      await panel.getByTestId('promotion-start').fill(prepared.startsAt.slice(0, 19))
      await panel.getByLabel('Beneficio', { exact: true }).selectOption('fixed')
      await panel.getByLabel('Céntimos brutos', { exact: true }).fill(String(prepared.discountGrossCents))
      await panel.getByLabel('Segmento', { exact: true }).selectOption('registered')
      await panel.getByLabel('Volumen', { exact: true }).selectOption('stack_volume')
      await panel.getByLabel('Límite por cliente (vacío: sin límite)', { exact: true }).fill('1')
      await panel.getByTestId('promotion-reason').fill('Synthetic explicit compiled campaign')
      await panel.getByTestId('promotion-review').click()
      await panel.getByTestId('promotion-confirm').click()
      await expect(panel.getByText('Cambio registrado y regla vigente comprobada.', { exact: true })).toBeVisible({
        timeout: 15000
      })
      const edit = panel.locator('li').filter({ hasText: prepared.code }).getByTestId('promotion-edit')
      await expect(edit).toHaveCount(1)
      await Promise.all([
        admin.page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            /^\/api\/admin\/promotions\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname) &&
            response.status() === 200
        ),
        edit.click()
      ])
      await panel.getByTestId('promotion-status').selectOption('active')
      await panel.getByTestId('promotion-reason').fill('Synthetic explicit compiled activation')
      await panel.getByTestId('promotion-review').click()
      await panel.getByTestId('promotion-confirm').click()
      await expect(panel.getByTestId('promotion-check')).toBeEnabled({ timeout: 15000 })
      assert.equal(bridge.state().adminUpdates, 1)
      await panel.getByTestId('promotion-check').click()
      await expect(panel.getByText('Cambio registrado y regla vigente comprobada.', { exact: true })).toBeVisible({
        timeout: 15000
      })
      assert(bridge.state().adminRecovered)
      const simulator = admin.page.getByRole('region', { name: 'Simulador de margen de mercancía', exact: true })
      await simulator.getByTestId('basket-query').fill(prepared.sku)
      await simulator.getByTestId('basket-search').locator('button[type="submit"]').click()
      await simulator.getByTestId(`basket-add-${prepared.variantId}`).click()
      await simulator.getByTestId(`basket-quantity-${prepared.variantId}`).fill(String(prepared.quantity))
      await simulator.getByTestId('basket-city').fill('Ontinyent')
      await simulator.getByTestId('basket-postal').fill('46870')
      await simulator.getByTestId('basket-customer').fill(prepared.customerId)
      await simulator.getByTestId('basket-run').click()
      await expect(simulator.getByTestId('basket-result')).toBeVisible({ timeout: 15000 })
      await expect(simulator.getByTestId('basket-cost')).toBeVisible()
      await expect(simulator.getByTestId('basket-margin')).toBeVisible()
      assert.equal(bridge.state().basketPreviews, 1)
      await admin.assertHealthy()
      const customer = await contextFor(prepared.customerCookie, true)
      await customer.page.goto(input.origin + '/checkout', { waitUntil: 'networkidle', timeout: 30000 })
      await customer.page.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
      const form = checkoutRecoveryForm(customer.page)
      await expect(form.locator('input[autocomplete="name"]')).toBeVisible({ timeout: 15000 })
      await form.locator('input[autocomplete="name"]').fill('Comprador sintético local')
      await form.locator('input[autocomplete="email"]').fill('synthetic-coupon@example.invalid')
      await form.locator('input[autocomplete="tel"]').fill('600000000')
      await form.getByLabel('Referencia interna / PO (opcional)', { exact: true }).fill(purchaseOrderReference)
      await form.locator('input[autocomplete="shipping address-line1"]').fill('Carrer Major 1')
      await form.locator('input[autocomplete="shipping postal-code"]').fill('46870')
      await form.locator('input[autocomplete="shipping address-level2"]').fill('Ontinyent')
      await form.locator('input[type="radio"][value="recogida"]').check()
      await customer.page.getByTestId('checkout-coupon-code').fill(prepared.code)
      await customer.page.getByTestId('checkout-coupon-apply').click()
      await expect(customer.page.getByTestId('checkout-coupon-feedback')).toHaveText(
        'Cupón aplicado. El descuento ya está incluido en el total.',
        { timeout: 15000 }
      )
      await expect(customer.page.getByTestId('checkout-coupon-discount')).toBeVisible()
      await form.locator('label').filter({ hasText: 'Acepto las' }).locator('input[type="checkbox"]').check()
      await form.locator('button[type="submit"]').click()
      await expect(customer.page.getByRole('button', { name: 'Comprobar pedido', exact: true })).toBeEnabled({
        timeout: 15000
      })
      await expect(form.locator('button[type="submit"]')).toBeDisabled()
      await customer.page.getByRole('button', { name: 'Comprobar pedido', exact: true }).click()
      await expect(customer.page).toHaveURL(input.origin + '/pedido/' + bridge.state().orderId, { timeout: 15000 })
      await expect(customer.page.getByTestId('order-purchase-reference')).toContainText(purchaseOrderReference)
      await customer.assertHealthy()
      const proof = await bridge.assertComplete()
      input.scenario?.(PROMOTIONS_BROWSER_SCENARIOS[index]!)
      results.push({ viewport, ...proof })
    }
    return {
      scenarios: results.length,
      browserExecuted: true,
      viewports: results,
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  } finally {
    for (const context of contexts) await context.close()
    await browser.close()
  }
}
