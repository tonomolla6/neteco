import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export const CART_ADD_RECOVERY_BROWSER_SCENARIOS = [
  'native_cart_add_compiled_committed_response_lost_reload_recovery_desktop',
  'native_cart_add_compiled_committed_response_lost_reload_recovery_mobile'
] as const
const JOURNAL = 'neteco-cart-add-v1'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
type AddBody = { variantId: number; quantity: number; expectedVersion: number; idempotencyKey: string }
type Cart = { id: string; version: number; items: Array<{ variantId: number; qty: number; name: string }> }

/** Real compiled guest UI and real disposable workerd. The only injected fault
 * is aborting an ADD response AFTER its successful durable commit. Never writes
 * browser state/DTO fixtures, launches locally, retries ADD, or submits payment. */
export async function auditNativeCartAddRecoveryBrowser(input: {
  dispatch: (request: Request) => Promise<Response>
  origin: string
  productSlug: string
  variantLegacyId: number
  sku?: string
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}) {
  const origin = new URL(input.origin)
  assert(origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'))
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.productSlug))
  assert(Number.isSafeInteger(input.variantLegacyId) && input.variantLegacyId > 0)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      journeys: [],
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  const productResponse = await input.dispatch(
    new Request(`${input.origin}/api/products/${input.productSlug}`, {
      headers: { 'cf-connecting-ip': '192.0.2.57' }
    })
  )
  assert.equal(productResponse.status, 200, 'Caller must supply a currently published disposable product')
  const product = (await productResponse.json()) as { variants: Array<{ id: number; sku: string }> }
  assert(Array.isArray(product.variants))
  const variant = product.variants.find((item) => item.id === input.variantLegacyId)
  assert(variant && typeof variant.sku === 'string' && variant.sku.length > 0)
  if (input.sku !== undefined) assert.equal(input.sku, variant.sku)
  const productPath = `/producto/${input.productSlug}?${new URLSearchParams({ sku: variant.sku })}`
  const browser = await connectRemoteTestBrowser(chromium)
  const journeys = []
  try {
    for (const [index, viewport] of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 }
    ].entries()) {
      input.scenario?.(CART_ADD_RECOVERY_BROWSER_SCENARIOS[index]!)
      const context = await browser.newContext({
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        viewport,
        serviceWorkers: 'block'
      })
      try {
        // Credentials originate only from this execution's genuine guest API.
        const emptyResponse = await input.dispatch(
          new Request(`${input.origin}/api/cart`, {
            headers: { 'cf-connecting-ip': '192.0.2.57' }
          })
        )
        assert.equal(emptyResponse.status, 200)
        const cookie = emptyResponse.headers
          .getSetCookie()
          .find((value) => value.startsWith('neteco-cart-v2='))
          ?.split(';')[0]
        assert(cookie)
        const initial = (await emptyResponse.json()) as Cart
        assert(UUID.test(initial.id) && Number.isSafeInteger(initial.version) && initial.version > 0)
        assert.deepEqual(initial.items, [], 'Each viewport must have its own initially empty guest cart')
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
          posts = 0,
          droppedResponses = 0,
          receiptGets = 0,
          currentCartGets = 0,
          blockedExternal = 0,
          blockedWrites = 0,
          privacyClears = 0,
          pageErrors = 0
        let original: AddBody | null = null
        const observedAddBody = (): AddBody => {
          assert(original, 'A real browser ADD must have been observed')
          return original
        }
        let committedLineName = ''
        const recoveryOrder: string[] = []
        await context.route('**/*', async (route) => {
          const incoming = route.request(),
            target = new URL(incoming.url()),
            method = incoming.method()
          if (target.origin !== input.origin) {
            blockedExternal++
            await route.abort('blockedbyclient')
            return
          }
          const add = method === 'POST' && target.pathname === '/api/cart/items'
          // Real CMP rejection clears only its anonymous analytics cookie. It is
          // not an order/payment/catalog write and must not be replaced by a mock.
          const privacyClear = method === 'DELETE' && target.pathname === '/api/analytics/session'
          if (!['GET', 'HEAD'].includes(method) && !add && !privacyClear) {
            blockedWrites++
            await route.abort('blockedbyclient')
            return
          }
          requests++
          const headers = await incoming.allHeaders()
          headers['cf-connecting-ip'] = '192.0.2.57'
          headers['accept-encoding'] = 'identity'
          const bytes = incoming.postDataBuffer()
          if (add) {
            posts++
            assert.equal(posts, 1, 'No automatic or recovery ADD replay may occur')
            const body = JSON.parse(bytes!.toString()) as AddBody
            assert.deepEqual(Object.keys(body).sort(), ['expectedVersion', 'idempotencyKey', 'quantity', 'variantId'])
            assert.equal(body.variantId, input.variantLegacyId)
            assert.equal(body.expectedVersion, initial.version)
            assert(Number.isSafeInteger(body.quantity) && body.quantity > 0 && body.quantity <= 999)
            assert(UUID.test(body.idempotencyKey))
            assert.equal(headers['x-neteco-cart-id'], initial.id, 'Frozen ADD must be bound to its real cart')
            original = body
          }
          const response = await input.dispatch(
            new Request(target, { method, headers, ...(bytes ? { body: new Uint8Array(bytes) } : {}) })
          )
          if (privacyClear) {
            privacyClears++
            assert.equal(response.status, 204)
          }
          if (add) {
            assert.equal(response.status, 200, 'Only a genuinely committed ADD response may be lost')
            const committed = (await response.clone().json()) as Cart
            assert.equal(committed.id, initial.id)
            assert.equal(committed.version, original!.expectedVersion + 1)
            assert.equal(committed.items.length, 1)
            assert.equal(committed.items[0]!.variantId, input.variantLegacyId)
            assert.equal(committed.items[0]!.qty, original!.quantity)
            committedLineName = committed.items[0]!.name
            droppedResponses++
            await route.abort('failed')
            return
          }
          if (target.pathname.startsWith('/api/cart/operations/')) {
            assert(original)
            assert.equal(method, 'GET')
            assert.equal(target.pathname, `/api/cart/operations/${original.idempotencyKey}`)
            assert.deepEqual([...target.searchParams.keys()].sort(), ['expectedVersion', 'quantity', 'variantId'])
            assert.equal(target.searchParams.get('variantId'), String(original.variantId))
            assert.equal(target.searchParams.get('quantity'), String(original.quantity))
            assert.equal(target.searchParams.get('expectedVersion'), String(original.expectedVersion))
            assert.equal(response.status, 200)
            assert.deepEqual(await response.clone().json(), {
              source: 'cloudflare',
              cartId: initial.id,
              commandId: original.idempotencyKey,
              outcome: 'applied',
              appliedVersion: original.expectedVersion + 1
            })
            receiptGets++
            recoveryOrder.push('receipt')
          }
          if (target.pathname === '/api/cart' && receiptGets > 0) {
            assert.equal(method, 'GET')
            assert.equal(response.status, 200)
            const current = (await response.clone().json()) as Cart
            assert.equal(current.id, initial.id)
            assert.equal(current.items.length, 1)
            assert.equal(current.items[0]!.variantId, input.variantLegacyId)
            assert.equal(current.items[0]!.qty, original!.quantity)
            currentCartGets++
            recoveryOrder.push('cart')
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
        await page.goto(input.origin + productPath, { waitUntil: 'networkidle', timeout: 30000 })
        await page.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
        const addButtons = page.getByRole('button', { name: 'Añadir al carrito', exact: true })
        const addButton = index === 0 ? addButtons.first() : addButtons.last()
        await expect(addButton).toBeEnabled()
        await addButton.click()
        await expect.poll(() => droppedResponses).toBe(1)
        const observed = observedAddBody()
        const journal = await page.evaluate((key) => localStorage.getItem(key), JOURNAL)
        assert(journal, 'The real UI must persist its original uncertain ADD before sending')
        const saved = JSON.parse(journal) as { cartId: string; body: AddBody; confirmed: boolean }
        assert.equal(saved.cartId, initial.id)
        assert.deepEqual(saved.body, observed)
        assert.equal(saved.confirmed, false)
        await page.goto(input.origin + '/carrito', { waitUntil: 'networkidle', timeout: 30000 })
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
        const recover = page.getByRole('button', { name: 'Comprobar adición', exact: true })
        await expect(recover).toBeEnabled({ timeout: 15000 })
        assert.equal(posts, 1, 'Navigation/reload must not resubmit the journal')
        assert.equal(receiptGets, 0, 'Recovery must require the explicit user action')
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), JOURNAL), journal)
        await expect(page.getByRole('link', { name: 'Tramitar pedido', exact: true })).toHaveCount(0)
        await recover.focus()
        await expect(recover).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(recover).toHaveCount(0)
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), JOURNAL)).toBeNull()
        assert.equal(receiptGets, 1)
        assert.equal(currentCartGets, 1)
        assert.deepEqual(recoveryOrder, ['receipt', 'cart'])
        await expect(page.getByRole('status', { name: committedLineName, exact: true })).toHaveText(
          String(saved.body.quantity)
        )
        await expect(page.getByText('No sabemos si se añadió el producto.', { exact: false })).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'Tramitar pedido', exact: true })).toBeVisible()
        assert.equal(posts, 1)
        assert.equal(pageErrors, 0)
        assert.equal(blockedExternal, 0)
        assert.equal(blockedWrites, 0, 'No checkout, payment, quantity mutation or other business write is allowed')
        assert.equal(
          await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
          false
        )
        journeys.push({
          viewport: `${viewport.width}x${viewport.height}`,
          requests,
          posts,
          droppedResponses,
          receiptGets,
          currentCartGets,
          privacyClears,
          pageErrors,
          blockedExternal,
          blockedWrites,
          journalRemoved: true,
          quantityDuplicated: false
        })
      } finally {
        await context.close()
      }
    }
    return {
      scenarios: journeys.length,
      browserStatus: 'passed' as const,
      reason: null,
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      journeys,
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    }
  } finally {
    await browser.close()
  }
}
