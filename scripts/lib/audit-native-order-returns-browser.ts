import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import {
  customerOrderReturnsSchema,
  adminOrderReturnSchema,
  returnRequestInputSchema,
  returnTransitionInputSchema,
  returnCommandReceiptSchema,
  returnOrderIdSchema,
  type ReturnRequestInput,
  type ReturnTransitionInput,
  type ReturnCommandReceipt
} from '../../shared/order-returns'
import { canonicalJson } from '../../workers/catalog/inventory'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export async function ensureOrderReturnsRowExpanded(control: Pick<Locator, 'getAttribute' | 'click'>) {
  if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click()
}

export async function navigateCustomerOrderReturns(
  row: Pick<Locator, 'getByRole'>,
  page: Pick<Page, 'getByRole' | 'waitForURL'>,
  orderId: string
) {
  returnOrderIdSchema.parse(orderId)
  await row.getByRole('link', { name: 'Ver pedido completo', exact: true }).click()
  await page.waitForURL((url) => url.pathname === `/pedido/${orderId}`, { timeout: 15000 })
  await page.getByRole('link', { name: 'Solicitar devolución', exact: true }).click()
  await page.waitForURL(
    (url) => url.pathname === '/devoluciones' && url.search === `?pedido=${encodeURIComponent(orderId)}`,
    { timeout: 15000 }
  )
  return page.getByRole('region', { name: 'Solicitudes de devolución del pedido', exact: true })
}

function isolatedOrigin(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test', 'Disposable native origin required')
}
function sessionCookie(cookie: string) {
  const matches = cookie
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('neteco-session='))
  assert.equal(matches.length, 1, 'Exactly one synthetic session cookie required')
  const value = matches[0]!.slice('neteco-session='.length)
  assert(value.length > 0 && value.length <= 16384 && !/[\s;\r\n]/.test(value))
  return value
}
export interface OrderReturnsBrowserProof {
  key: string
  body: ReturnRequestInput | ReturnTransitionInput
  receipt: ReturnCommandReceipt
}
type Forward = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
export interface OrderReturnsBrowserDiagnostic {
  stage: 'command_dispatch' | 'command_response' | 'command_receipt' | 'committed_readback' | 'loss_checkpoint'
  action: 'requested' | 'approved' | 'received'
  status: number | null
}
export class OrderReturnsBrowserDiagnosticError extends Error {
  constructor(
    readonly safeDiagnostic: OrderReturnsBrowserDiagnostic,
    cause?: unknown
  ) {
    super('Order returns browser acceptance failed', { cause })
    this.name = 'OrderReturnsBrowserDiagnosticError'
  }
}
export function requireOrderReturnsLostResponse(
  proof: { lostResponses: number },
  transportFailure: unknown,
  diagnostic: OrderReturnsBrowserDiagnostic
) {
  if (transportFailure || proof.lostResponses !== 1)
    throw new OrderReturnsBrowserDiagnosticError({ ...diagnostic }, transportFailure)
  assert.equal(proof.lostResponses, 1)
}
function parseCommand(customer: boolean, text: string): ReturnRequestInput | ReturnTransitionInput {
  if (customer) return returnRequestInputSchema.parse(JSON.parse(text))
  return returnTransitionInputSchema.parse(JSON.parse(text))
}
/** Transport fault only: the response is real, and independent D1 + GET proof
 * must finish before a successful receipt can be deliberately lost. */
export function createOrderReturnsBrowserBridge(input: {
  origin: string
  orderId: string
  dispatch: (request: Request) => Promise<Response>
  readCommitted: (proof: OrderReturnsBrowserProof) => Promise<void>
}) {
  isolatedOrigin(input.origin)
  returnOrderIdSchema.parse(input.orderId)
  const path = `/api/orders/${input.orderId}/returns`
  const proof = {
    requestPosts: 0,
    transitionPuts: 0,
    lostResponses: 0,
    replayPuts: 0,
    blockedExternal: 0,
    blockedWrites: 0
  }
  let requested: ReturnCommandReceipt | null = null,
    approved = false,
    lost: { key: string; text: string; receipt: ReturnCommandReceipt } | null = null,
    replayed = false
  const diagnostic: OrderReturnsBrowserDiagnostic = { stage: 'command_dispatch', action: 'requested', status: null }
  return {
    proof,
    diagnostic,
    async forward(request: Request): Promise<Forward> {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const customer = request.method === 'POST' && url.pathname === path && !url.search
      const admin =
        request.method === 'PUT' && url.pathname === `/api/admin/returns/${requested?.publicRef}` && !url.search
      const consentDeletion = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !customer && !admin && !consentDeletion) {
        // Malformed/out-of-order RMA commands must fail this acceptance, not be
        // confused with harmless blocked unrelated writes.
        assert(!url.pathname.startsWith('/api/admin/returns/'), 'RMA request must precede administrative review')
        proof.blockedWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      if (!customer && !admin) return { action: 'fulfill', response: await input.dispatch(request) }
      const text = await request.clone().text()
      assert(text.length <= 8192)
      const key = request.headers.get('idempotency-key')
      assert(key && key.length <= 200 && !/[\r\n]/.test(key), 'Original idempotency key required')
      const body = parseCommand(customer, text)
      if (customer) {
        assert.equal(proof.requestPosts, 0, 'Only one explicit customer request allowed')
        assert.equal(body.expectedVersion, 0)
        proof.requestPosts++
      } else {
        assert(
          'action' in body && ['approved', 'received'].includes(body.action),
          'Only reviewed custody commands allowed'
        )
        if (lost) {
          assert(!replayed && body.action === 'received', 'Exactly one manual recovery permitted')
          assert.equal(key, lost.key, 'Recovery must preserve original key')
          assert.equal(text, lost.text, 'Recovery must preserve original body bytes')
          replayed = true
          proof.replayPuts++
        } else if (body.action === 'approved') {
          assert(!approved && body.expectedVersion === 1)
        } else assert(approved && body.expectedVersion === 2)
        proof.transitionPuts++
      }
      const action: OrderReturnsBrowserDiagnostic['action'] = customer
        ? 'requested'
        : 'action' in body && body.action === 'approved'
          ? 'approved'
          : 'received'
      diagnostic.action = action
      diagnostic.stage = 'command_dispatch'
      diagnostic.status = null
      const response = await input.dispatch(request)
      diagnostic.status = response.status
      diagnostic.stage = 'command_response'
      if (response.status !== (customer ? 201 : 200)) return { action: 'fulfill', response }
      diagnostic.stage = 'command_receipt'
      const receipt = returnCommandReceiptSchema.parse(await response.clone().json())
      assert.equal(receipt.orderId, input.orderId)
      assert.equal(receipt.action, action)
      assert.equal(receipt.version, action === 'requested' ? 1 : body.expectedVersion + 1)
      if (requested) {
        assert.equal(receipt.returnId, requested.returnId)
        assert.equal(receipt.publicRef, requested.publicRef)
      }
      diagnostic.stage = 'committed_readback'
      await input.readCommitted({ key, body, receipt })
      diagnostic.stage = 'loss_checkpoint'
      if (customer) requested = receipt
      else if (action === 'approved') approved = true
      else if (!lost) {
        lost = { key, text, receipt }
        proof.lostResponses++
        return { action: 'abort', reason: 'lost_return_response' }
      } else assert.deepEqual(receipt, lost.receipt, 'Recovery must return the immutable original receipt')
      return { action: 'fulfill', response }
    }
  }
}
export const ORDER_RETURNS_BROWSER_SCENARIOS = [
  'native_order_returns_compiled_customer_request_private_desktop',
  'native_order_returns_compiled_custody_exact_recovery_desktop',
  'native_order_returns_compiled_customer_request_private_mobile',
  'native_order_returns_compiled_custody_exact_recovery_mobile'
] as const
export interface NativeOrderReturnsBrowserInput {
  origin: string
  adminCookie: string
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  /** Dedicated authenticated paid/delivered checkout through existing native
   * checkout/payment + fulfillment helpers, never SQL ownership/status seeds. */
  prepareDeliveredOrder: (viewport: 'desktop' | 'mobile') => Promise<{ orderId: string; ownerCookie: string }>
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}
export async function readOrderReturnsDomainDigest(database: D1Database, orderId: string) {
  const queries = [
    'SELECT * FROM orders WHERE id=?1',
    'SELECT * FROM order_lines WHERE order_id=?1 ORDER BY line_index',
    'SELECT * FROM order_events WHERE order_id=?1 ORDER BY id',
    'SELECT * FROM order_payment_states WHERE order_id=?1',
    'SELECT * FROM payment_intents WHERE order_id=?1 ORDER BY id',
    'SELECT * FROM payment_events WHERE payment_intent_id IN(SELECT id FROM payment_intents WHERE order_id=?1) ORDER BY id',
    'SELECT * FROM order_fulfillments WHERE order_id=?1',
    'SELECT * FROM inventory_balances WHERE variant_id IN(SELECT variant_id FROM order_lines WHERE order_id=?1) ORDER BY variant_id,location_id',
    'SELECT * FROM inventory_movements WHERE variant_id IN(SELECT variant_id FROM order_lines WHERE order_id=?1) ORDER BY id',
    'SELECT * FROM inventory_reservations WHERE id IN(SELECT reservation_id FROM orders WHERE id=?1) ORDER BY id',
    'SELECT * FROM inventory_reservation_lines WHERE reservation_id IN(SELECT reservation_id FROM orders WHERE id=?1) ORDER BY reservation_id,variant_id,location_id',
    'SELECT * FROM fiscal_documents WHERE order_id=?1 ORDER BY id',
    'SELECT * FROM refund_contracts WHERE order_id=?1 ORDER BY id',
    'SELECT * FROM fiscal_credit_contracts WHERE order_id=?1 ORDER BY id'
  ]
  const rows = await database.batch(queries.map((sql) => database.prepare(sql).bind(orderId)))
  assert.equal(rows.length, queries.length)
  for (const row of rows) {
    assert.equal(row.success, true)
    assert(Array.isArray(row.results) && row.results.length <= 10000, 'Bounded domain snapshot required')
    assert.equal(row.meta.rows_written, 0, 'Acceptance snapshot must remain read-only')
  }
  return createHash('sha256')
    .update(canonicalJson(rows.map((row) => row.results)))
    .digest('hex')
}
export async function auditNativeOrderReturnsBrowser(input: NativeOrderReturnsBrowserInput) {
  isolatedOrigin(input.origin)
  sessionCookie(input.adminCookie)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  const base = {
    syntheticSessionOnly: true,
    providerSubmission: false,
    productionBrowserAcceptance: false,
    economicEffects: false,
    custody: 'non_sellable' as const
  }
  if (input.browserMode === 'not-run')
    return {
      ...base,
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      viewports: []
    }
  const browser = await connectRemoteTestBrowser(chromium)
  let requests = 0,
    pageErrors = 0,
    lostResponses = 0,
    replayPuts = 0
  const viewports: string[] = []
  const domainDigests: Array<{ viewport: string; before: string; after: string }> = []
  try {
    for (const [index, viewport] of (
      [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ] as const
    ).entries()) {
      const prepared = await input.prepareDeliveredOrder(viewport.name)
      returnOrderIdSchema.parse(prepared.orderId)
      sessionCookie(prepared.ownerCookie)
      const orderId = prepared.orderId,
        customerPath = `/api/orders/${orderId}/returns`
      const privateReason = `Private synthetic custody ${viewport.name}`,
        privateEvidence = `Private synthetic document ${viewport.name}`
      const publicMessage = 'Recepción física registrada, sin efectos económicos.'
      const read = async (path: string, cookie: string) => {
        requests++
        const response = await input.dispatch(
          new Request(input.origin + path, { headers: { cookie, 'cf-connecting-ip': '192.0.2.166' } })
        )
        assert.equal(response.status, 200)
        assert.match(response.headers.get('cache-control') ?? '', /no-store/)
        return response.json() as Promise<unknown>
      }
      const baseline = customerOrderReturnsSchema.parse(await read(customerPath, prepared.ownerCookie))
      assert.equal(baseline.orderId, orderId)
      assert(baseline.readiness.ready && baseline.capabilities.returnRequest)
      assert.equal(baseline.version, 0)
      assert.equal(baseline.pagination.total, 0)
      assert(baseline.lines.some((line) => line.availableQuantity >= 1))
      const digestBefore = await readOrderReturnsDomainDigest(input.database, orderId)
      let currentReceipt: ReturnCommandReceipt | null = null,
        transportFailure: unknown = null
      const contexts: BrowserContext[] = []
      const bridge = createOrderReturnsBrowserBridge({
        origin: input.origin,
        orderId,
        dispatch: input.dispatch,
        async readCommitted(proof) {
          // Independent immutable command + audit read, not the UI or renderer.
          const row = await input.database
            .prepare(
              `SELECT c.input,c.response,c.action,c.result_version,
            (SELECT count(*) FROM order_return_events e WHERE e.command_id=c.id AND e.input=c.input AND e.response=c.response) AS audits
            FROM order_return_commands c WHERE c.id=?1 AND c.order_id=?2 AND c.idempotency_key=?3`
            )
            .bind(proof.receipt.commandId, orderId, proof.key)
            .first<{ input: string; response: string; action: string; result_version: number; audits: number }>()
          assert(row)
          assert.equal(row.audits, 1)
          assert.deepEqual(JSON.parse(row.input), proof.body)
          assert.deepEqual(returnCommandReceiptSchema.parse(JSON.parse(row.response)), proof.receipt)
          assert.equal(row.action, proof.receipt.action)
          assert.equal(row.result_version, proof.receipt.version)
          const customer = customerOrderReturnsSchema.parse(await read(customerPath, prepared.ownerCookie))
          assert.equal(customer.orderId, orderId)
          assert.equal(customer.version, proof.receipt.orderVersion)
          const entry = customer.returns.find((item) => item.id === proof.receipt.returnId)
          assert(entry && entry.state === proof.receipt.state)
          const serialized = JSON.stringify(customer)
          assert(
            !serialized.includes(privateReason) && !serialized.includes(privateEvidence),
            'Internal custody evidence leaked to customer'
          )
          if (proof.receipt.action !== 'requested') {
            const admin = adminOrderReturnSchema.parse(
              await read(`/api/admin/returns/${proof.receipt.publicRef}`, input.adminCookie)
            )
            assert.equal(admin.version, proof.receipt.version)
            assert.equal(admin.state, proof.receipt.state)
          }
          currentReceipt = proof.receipt
        }
      })
      const pageFor = async (cookie: string, customer: boolean) => {
        const context = await browser.newContext({
          locale: 'es-ES',
          timezoneId: 'Europe/Madrid',
          viewport: { width: viewport.width, height: viewport.height },
          serviceWorkers: 'block'
        })
        contexts.push(context)
        await context.addCookies([
          {
            name: 'neteco-session',
            value: sessionCookie(cookie),
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ])
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              target = new URL(incoming.url())
            const headers = await incoming.allHeaders()
            headers['cf-connecting-ip'] = '192.0.2.166'
            headers['accept-encoding'] = 'identity'
            const payload = incoming.postDataBuffer()
            requests++
            const result = await bridge.forward(
              new Request(target, {
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
            const response = result.response
            if (customer && response.headers.get('content-type')?.includes('application/json')) {
              const json = JSON.stringify(await response.clone().json())
              assert(
                !json.includes(privateReason) && !json.includes(privateEvidence),
                'Private return evidence in customer response'
              )
            }
            const forwarded = Object.fromEntries(response.headers)
            delete forwarded['content-encoding']
            delete forwarded['content-length']
            // These are exact dispatched Worker bytes, never fabricated DTOs.
            await route.fulfill({
              status: response.status,
              headers: forwarded,
              body: Buffer.from(await response.arrayBuffer())
            })
          } catch (failure) {
            transportFailure = failure
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => pageErrors++)
        return page
      }
      try {
        const customer = await pageFor(prepared.ownerCookie, true)
        await customer.goto(input.origin + '/cuenta/pedidos', { waitUntil: 'networkidle', timeout: 30000 })
        const row = customer.locator('article').filter({ hasText: orderId })
        await expect(row).toHaveCount(1)
        const control = row.locator('button[aria-expanded]')
        await expect(control).toBeVisible({ timeout: 15000 })
        await ensureOrderReturnsRowExpanded(control)
        const panel = await navigateCustomerOrderReturns(row, customer, orderId)
        await expect(panel.locator('[data-testid="customer-return-reason"]')).toBeVisible({ timeout: 15000 })
        await panel.locator('[data-testid^="customer-return-quantity-"]').first().fill('1')
        await panel
          .locator('[data-testid="customer-return-reason"]')
          .fill('Solicitud sintética local de revisión del producto recibido')
        await panel.locator('[data-testid="customer-return-prepare"]').click()
        assert.equal(bridge.proof.requestPosts, 0, 'Preparation must not POST')
        await panel.locator('[data-testid="customer-return-confirm"]').click()
        await expect(panel.locator('[data-testid="customer-return-message"]')).toContainText('Solicitud registrada', {
          timeout: 15000
        })
        const publicRef = returnCommandReceiptSchema.parse(currentReceipt).publicRef
        await expect(panel).toContainText('no autoriza enviar productos ni confirma admisión')
        await expect(panel).toContainText('reembolso o factura rectificativa')
        const customerWidth = await customer.evaluate(() => ({
          viewport: innerWidth,
          width: document.documentElement.scrollWidth
        }))
        assert(customerWidth.width <= customerWidth.viewport + 1, 'Customer RMA must not overflow mobile viewport')
        input.scenario?.(ORDER_RETURNS_BROWSER_SCENARIOS[index * 2]!)
        const admin = await pageFor(input.adminCookie, false)
        await admin.goto(input.origin + '/admin/devoluciones', { waitUntil: 'networkidle', timeout: 30000 })
        await expect(admin.locator(`[data-testid="return-open-${publicRef}"]`)).toBeVisible({ timeout: 15000 })
        await admin.locator(`[data-testid="return-open-${publicRef}"]`).click()
        const custody = admin.getByRole('region', { name: 'Custodia e inspección del expediente RMA' })
        const perform = async (action: 'approved' | 'received') => {
          await expect(custody.locator('[data-testid="return-action"]')).toBeVisible({ timeout: 15000 })
          await custody.locator('[data-testid="return-action"]').selectOption(action)
          await custody.locator('[data-testid="return-reason"]').fill(privateReason)
          await custody.locator('[data-testid="return-public-message"]').fill(publicMessage)
          await custody.locator('[data-testid="return-evidence"]').fill(privateEvidence)
          if (action === 'approved')
            await custody.locator('[data-testid="return-decision"]').fill('Synthetic documented local decision')
          await custody.locator('[data-testid="return-prepare"]').click()
          await custody.locator('[data-testid="return-confirm"]').click()
        }
        await perform('approved')
        await expect(custody.locator('[data-testid="return-message"]')).toContainText('confirmada', { timeout: 15000 })
        await perform('received')
        await expect(custody.locator('[data-testid="return-confirm"]')).toHaveText('Recuperar con la misma clave', {
          timeout: 15000
        })
        // The label changes as soon as the PUT is sent, while busy still
        // disables recovery. Wait for the settled uncertainty state, not the
        // optimistic in-flight label, before inspecting the lost-response proof.
        await expect(custody.locator('[data-testid="return-confirm"]')).toBeEnabled({ timeout: 15000 })
        await expect(custody.locator('[data-testid="return-message"]')).toContainText('Resultado no confirmado', {
          timeout: 15000
        })
        requireOrderReturnsLostResponse(bridge.proof, transportFailure, bridge.diagnostic)
        await custody.locator('[data-testid="return-confirm"]').click()
        await expect(custody.locator('[data-testid="return-message"]')).toContainText('confirmada', { timeout: 15000 })
        assert.equal(bridge.proof.requestPosts, 1)
        assert.equal(bridge.proof.transitionPuts, 3)
        assert.equal(bridge.proof.replayPuts, 1)
        const counts = await input.database
          .prepare(
            `SELECT
          (SELECT count(*) FROM order_return_commands WHERE order_id=?1) AS commands,
          (SELECT count(*) FROM order_return_events WHERE order_id=?1) AS events,
          (SELECT count(*) FROM order_returns WHERE order_id=?1) AS returns`
          )
          .bind(orderId)
          .first<{ commands: number; events: number; returns: number }>()
        assert.deepEqual(counts, { commands: 3, events: 3, returns: 1 }, 'Replay must not duplicate custody ledger')
        const adminWidth = await admin.evaluate(() => ({
          viewport: innerWidth,
          width: document.documentElement.scrollWidth
        }))
        assert(adminWidth.width <= adminWidth.viewport + 1, 'Admin RMA must not overflow mobile viewport')
        await customer
          .getByRole('region', { name: 'Contexto privado de devolución del pedido', exact: true })
          .locator('[data-testid="customer-return-refresh"]')
          .click()
        await expect(panel).toContainText(publicMessage, { timeout: 15000 })
        assert(!(await customer.locator('body').innerText()).includes(privateReason))
        assert(!(await customer.locator('body').innerText()).includes(privateEvidence))
        const digestAfter = await readOrderReturnsDomainDigest(input.database, orderId)
        assert.equal(digestAfter, digestBefore, 'RMA must not change stock/money/contracts')
        domainDigests.push({ viewport: viewport.name, before: digestBefore, after: digestAfter })
        const forbidden = await input.dispatch(
          new Request(input.origin + `/api/admin/returns/${publicRef}`, { headers: { cookie: prepared.ownerCookie } })
        )
        assert.equal(forbidden.status, 403, 'Customer must not read administrative custody DTO')
        await customer.context().clearCookies()
        await customer.reload({ waitUntil: 'networkidle' })
        await expect(customer.locator('[data-testid="customer-return-reason"]')).toHaveCount(0)
        await expect(customer.getByRole('region', { name: 'Solicitudes de devolución del pedido' })).toHaveCount(0)
        if (transportFailure) throw transportFailure
        assert.equal(bridge.proof.blockedExternal, 0)
        assert.equal(bridge.proof.blockedWrites, 0)
        input.scenario?.(ORDER_RETURNS_BROWSER_SCENARIOS[index * 2 + 1]!)
        lostResponses += bridge.proof.lostResponses
        replayPuts += bridge.proof.replayPuts
        viewports.push(viewport.name)
      } finally {
        for (const context of contexts) await context.close()
      }
    }
    assert.equal(pageErrors, 0)
    return {
      ...base,
      scenarios: ORDER_RETURNS_BROWSER_SCENARIOS.length,
      browserStatus: 'passed' as const,
      requests,
      pageErrors,
      lostResponses,
      replayPuts,
      viewports,
      domainDigests,
      inventoryAndMoneyUnchanged: true
    }
  } finally {
    await browser.close()
  }
}
