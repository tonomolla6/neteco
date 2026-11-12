import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import { z } from 'zod'
import { previewQuickOrder, type QuickOrderReady } from '../../shared/quick-order'
import { canonicalPayloadHash } from '../../workers/catalog/cart'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export const QUICK_ORDER_BROWSER_SCENARIOS = [
  'native_quick_order_compiled_exact_preview_recovery_desktop',
  'native_quick_order_compiled_exact_preview_recovery_mobile'
] as const
export interface QuickOrderFixture {
  skuReference: string
  eanReference: string
  unknownReference: string
  quantities: [number, number]
}
export interface NativeQuickOrderBrowserInput {
  origin: string
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  prepareQuickOrder: (viewport: 'desktop' | 'mobile') => Promise<QuickOrderFixture>
  browserMode?: 'required' | 'not-run'
  scenario?: (id: string) => void
}
const positive = z.number().int().safe().positive(),
  uuid = z.string().uuid()
const addSchema = z
  .object({ variantId: positive, quantity: positive.max(999), expectedVersion: positive, idempotencyKey: uuid })
  .strict()
const cartSchema = z.object({
  id: uuid,
  version: positive,
  items: z.array(z.object({ variantId: positive, qty: positive.max(999) })).max(200)
})
const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    cartId: uuid,
    commandId: uuid,
    outcome: z.literal('applied'),
    appliedVersion: positive
  })
  .strict()
export type QuickOrderAddBody = z.infer<typeof addSchema>
export interface QuickOrderCommitProof {
  body: QuickOrderAddBody
  cart: z.infer<typeof cartSchema>
}
function isolatedOrigin(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test')
}
function cartCookie(cookie: string) {
  assert(/^neteco-cart-v2=[^;\s]+$/.test(cookie) && cookie.length <= 8192)
}

/** Faults only the response, AFTER independently verified durable commit.
 * The journey supplies real D1+authorized GET proof; boundary tests mock no DOM. */
export function createQuickOrderBrowserBridge(input: {
  origin: string
  cartId: string
  cartCookie: string
  initialVersion: number
  variantLegacyId: number
  quantity: number
  dispatch: (request: Request) => Promise<Response>
  readCommitted: (proof: QuickOrderCommitProof) => Promise<void>
}) {
  isolatedOrigin(input.origin)
  uuid.parse(input.cartId)
  cartCookie(input.cartCookie)
  positive.parse(input.initialVersion)
  positive.parse(input.variantLegacyId)
  positive.max(999).parse(input.quantity)
  const proof = { posts: 0, lostResponses: 0, receiptGets: 0, currentCartGets: 0, blockedExternal: 0, blockedWrites: 0 }
  let original: QuickOrderAddBody | null = null,
    claimed = false
  return {
    proof,
    async forward(request: Request) {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort' as const, reason: 'external_request' }
      }
      const add = request.method === 'POST' && url.pathname === '/api/cart/items' && !url.search
      const privacy = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !add && !privacy) {
        proof.blockedWrites++
        return { action: 'abort' as const, reason: 'unapproved_write' }
      }
      let body: QuickOrderAddBody | null = null
      if (add) {
        assert.equal(claimed, false, 'No double-click, remaining-line ADD or automatic replay allowed')
        claimed = true
        const cartCookies = (request.headers.get('cookie') ?? '')
          .split(';')
          .map((value) => value.trim())
          .filter((value) => value.startsWith('neteco-cart-v2='))
        assert.deepEqual(cartCookies, [input.cartCookie])
        assert.equal(request.headers.get('origin'), input.origin)
        assert.equal(request.headers.get('x-neteco-cart-id'), input.cartId)
        const text = await request.clone().text()
        assert(Buffer.byteLength(text) <= 1024)
        body = addSchema.parse(JSON.parse(text))
        assert.equal(body.variantId, input.variantLegacyId)
        assert.equal(body.quantity, input.quantity)
        assert.equal(body.expectedVersion, input.initialVersion)
        proof.posts++
      }
      const response = await input.dispatch(request)
      if (add && response.status === 200) {
        const cart = cartSchema.parse(await response.clone().json())
        assert.equal(cart.id, input.cartId)
        assert.equal(cart.version, body!.expectedVersion + 1)
        assert.deepEqual(cart.items, [{ variantId: input.variantLegacyId, qty: input.quantity }])
        await input.readCommitted({ body: body!, cart })
        original = body
        proof.lostResponses++
        return { action: 'abort' as const, reason: 'proven_quick_order_response_lost' }
      }
      if (original && request.method === 'GET' && url.pathname.startsWith('/api/cart/operations/')) {
        assert.equal(url.pathname, `/api/cart/operations/${original.idempotencyKey}`)
        assert.deepEqual([...url.searchParams.keys()].sort(), ['expectedVersion', 'quantity', 'variantId'])
        assert.equal(url.searchParams.get('variantId'), String(original.variantId))
        assert.equal(url.searchParams.get('quantity'), String(original.quantity))
        assert.equal(url.searchParams.get('expectedVersion'), String(original.expectedVersion))
        assert.equal(response.status, 200)
        assert.deepEqual(receiptSchema.parse(await response.clone().json()), {
          source: 'cloudflare',
          cartId: input.cartId,
          commandId: original.idempotencyKey,
          outcome: 'applied',
          appliedVersion: original.expectedVersion + 1
        })
        proof.receiptGets++
      }
      if (
        original &&
        proof.receiptGets > 0 &&
        request.method === 'GET' &&
        url.pathname === '/api/cart' &&
        !url.search
      ) {
        assert.equal(response.status, 200)
        assert.deepEqual(cartSchema.parse(await response.clone().json()), {
          id: input.cartId,
          version: original.expectedVersion + 1,
          items: [{ variantId: original.variantId, qty: original.quantity }]
        })
        proof.currentCartGets++
      }
      return { action: 'fulfill' as const, response }
    }
  }
}
const unchangedTables = [
  'inventory_balances',
  'inventory_reservations',
  'inventory_reservation_lines',
  'inventory_movements',
  'orders',
  'order_lines',
  'payment_intents',
  'payment_commands'
] as const
export async function auditNativeQuickOrderBrowser(input: NativeQuickOrderBrowserInput) {
  isolatedOrigin(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  const base = {
    productionBrowserAcceptance: false,
    syntheticSessionOnly: true,
    providerSubmission: false,
    legacyNodeAcceptance: false,
    contractualQuoteAcceptance: false,
    persistedBatchAcceptance: false
  }
  if (input.browserMode === 'not-run')
    return { ...base, scenarios: 0, browserExecuted: false, reason: REMOTE_BROWSER_NOT_RUN_REASON, viewports: [] }
  const browser = await connectRemoteTestBrowser(chromium),
    journeys = []
  let scenarios = 0
  try {
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      const fixture = await input.prepareQuickOrder(viewport)
      const ref = z
        .string()
        .min(2)
        .max(160)
        .refine((value) => !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      ref.parse(fixture.skuReference)
      ref.parse(fixture.eanReference)
      ref.parse(fixture.unknownReference)
      assert.equal(new Set([fixture.skuReference, fixture.eanReference, fixture.unknownReference]).size, 3)
      const quantities = z.tuple([positive.max(999), positive.max(999)]).parse(fixture.quantities)
      const serverGet = async (path: string, cookie?: string) => {
        const response = await input.dispatch(
          new Request(input.origin + path, {
            headers: { 'cf-connecting-ip': '192.0.2.169', ...(cookie ? { Cookie: cookie } : {}) }
          })
        )
        assert.equal(response.status, 200)
        assert.match(response.headers.get('cache-control') ?? '', /no-store/)
        return response
      }
      const offers = await previewQuickOrder(
        [
          { reference: fixture.skuReference, quantity: quantities[0] },
          { reference: fixture.eanReference, quantity: quantities[1] }
        ],
        async (path, options) =>
          (await serverGet(path + (options.query ? '?' + new URLSearchParams(options.query) : ''))).json()
      )
      assert(
        offers.every((row) => row.status === 'ready'),
        'Two exact, unambiguous, currently published fixture variants required'
      )
      const first = offers[0] as QuickOrderReady,
        second = offers[1] as QuickOrderReady
      assert.equal(first.variant.sku, fixture.skuReference)
      assert.equal(second.variant.ean, fixture.eanReference)
      assert.notEqual(first.variant.uuid, second.variant.uuid)
      assert(
        first.variant.taxRateBasisPoints > 0 &&
          first.variant.priceTiers.some(
            (tier) => first.quantity >= tier.minimumQuantity && tier.unitGrossCents < first.variant.price
          ),
        'Fixture must exercise real tier and VAT'
      )
      assert.equal(
        (
          await previewQuickOrder([{ reference: fixture.unknownReference, quantity: 1 }], async (path, options) =>
            (await serverGet(path + (options.query ? '?' + new URLSearchParams(options.query) : ''))).json()
          )
        )[0]?.status,
        'error'
      )
      const created = await serverGet('/api/cart'),
        cookie = created.headers
          .getSetCookie()
          .find((value) => value.startsWith('neteco-cart-v2='))
          ?.split(';')[0]
      assert(cookie)
      cartCookie(cookie)
      const initial = cartSchema.parse(await created.json())
      assert.deepEqual(initial.items, [])
      const rows = async (sql: string, ...parameters: string[]) => {
        const result = await input.database
          .prepare(sql)
          .bind(...parameters)
          .all<Record<string, unknown>>()
        assert(result.success && result.results.length <= 10000)
        if (result.meta?.rows_written !== undefined) assert.equal(result.meta.rows_written, 0)
        return result.results
      }
      const digest = async () =>
        createHash('sha256')
          .update(
            JSON.stringify(
              await Promise.all(unchangedTables.map((table) => rows(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 10001`)))
            )
          )
          .digest('hex')
      const baseline = await digest()
      const cartSnapshot = async () =>
        Promise.all([
          rows('SELECT id,version,status FROM carts WHERE id=?', initial.id),
          rows('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id', initial.id),
          rows('SELECT * FROM cart_commands WHERE cart_id=? ORDER BY command_id', initial.id)
        ])
      const emptySnapshot = await cartSnapshot()
      let original: QuickOrderAddBody | null = null
      const bridge = createQuickOrderBrowserBridge({
        origin: input.origin,
        cartId: initial.id,
        cartCookie: cookie,
        initialVersion: initial.version,
        variantLegacyId: first.variant.id,
        quantity: first.quantity,
        dispatch: input.dispatch,
        readCommitted: async (proof) => {
          const hash = await canonicalPayloadHash({
            kind: 'add',
            cartId: initial.id,
            expectedVersion: proof.body.expectedVersion,
            variantId: first.variant.uuid,
            quantity: proof.body.quantity
          })
          const commands = await rows(
            'SELECT command_id,kind,payload_hash,response_status,response_body FROM cart_commands WHERE cart_id=? ORDER BY command_id',
            initial.id
          )
          assert.equal(commands.length, 1)
          const command = commands[0]!
          assert.equal(command.command_id, proof.body.idempotencyKey)
          assert.equal(command.kind, 'mutate')
          assert.equal(command.payload_hash, hash)
          assert.equal(command.response_status, 200)
          const persisted = JSON.parse(String(command.response_body)) as {
            outcome: string
            body: {
              cartVersion: number
              removed: boolean
              status: string
              line: { variantId: string; quantity: number }
            }
          }
          assert.equal(persisted.outcome, 'applied')
          assert.equal(persisted.body.cartVersion, initial.version + 1)
          assert.equal(persisted.body.status, 'active')
          assert.equal(persisted.body.removed, false)
          assert.equal(persisted.body.line.variantId, first.variant.uuid)
          assert.equal(persisted.body.line.quantity, first.quantity)
          assert.deepEqual(
            await rows('SELECT variant_id,quantity FROM cart_lines WHERE cart_id=? ORDER BY variant_id', initial.id),
            [{ variant_id: first.variant.uuid, quantity: first.quantity }]
          )
          const query = new URLSearchParams({
            variantId: String(proof.body.variantId),
            quantity: String(proof.body.quantity),
            expectedVersion: String(proof.body.expectedVersion)
          })
          assert.deepEqual(
            receiptSchema.parse(
              await (await serverGet(`/api/cart/operations/${proof.body.idempotencyKey}?${query}`, cookie)).json()
            ),
            {
              source: 'cloudflare',
              cartId: initial.id,
              commandId: proof.body.idempotencyKey,
              outcome: 'applied',
              appliedVersion: initial.version + 1
            }
          )
          const current = (await (await serverGet('/api/cart', cookie)).json()) as {
            items: Array<{ price: number; taxRateBasisPoints: number }>
          }
          assert.deepEqual(cartSchema.parse(current), proof.cart)
          assert.equal(current.items[0]!.price, first.unitGrossCents)
          assert.equal(current.items[0]!.taxRateBasisPoints, first.variant.taxRateBasisPoints)
          assert.equal(await digest(), baseline, 'ADD must not reserve inventory, pay or place orders')
          original = proof.body
        }
      })
      const context = await browser.newContext({
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        serviceWorkers: 'block',
        viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
      })
      try {
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
        let transportFailure = false,
          pageErrors = 0,
          searchGets = 0
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              bytes = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.169'
            headers['accept-encoding'] = 'identity'
            if (new URL(incoming.url()).pathname === '/api/search') searchGets++
            const result = await bridge.forward(
              new Request(incoming.url(), {
                method: incoming.method(),
                headers,
                redirect: 'manual',
                ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {})
              })
            )
            if (result.action === 'abort') {
              if (result.reason !== 'proven_quick_order_response_lost') transportFailure = true
              await route.abort('failed')
            } else {
              const headers = Object.fromEntries(result.response.headers)
              delete headers['content-encoding']
              delete headers['content-length']
              await route.fulfill({
                status: result.response.status,
                headers,
                body: Buffer.from(await result.response.arrayBuffer())
              })
            }
          } catch {
            transportFailure = true
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => {
          pageErrors++
        })
        await page.goto(input.origin + '/', { waitUntil: 'networkidle', timeout: 30000 })
        await page.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
        if (viewport === 'mobile') await page.getByRole('button', { name: 'Abrir menú', exact: true }).click()
        const navigation =
          viewport === 'mobile'
            ? page.getByRole('dialog', { name: 'Menú de navegación', exact: true })
            : page.locator('header')
        await navigation.getByRole('link', { name: 'Pedido rápido', exact: true }).click()
        await expect(page).toHaveURL(input.origin + '/pedido-rapido')
        // One screen, three entries. The pasted list is the bulk path: one reference per line.
        const pasteTab = page.locator('[data-quick-tab="paste"]'),
          list = page.locator('[data-quick-paste]'),
          apply = page.locator('[data-quick-paste-apply]'),
          rows = page.locator('[data-quick-row]')
        await expect(pasteTab).toBeEnabled({ timeout: 15000 })
        await pasteTab.click()
        const beforeTyping = searchGets
        await list.fill(`${fixture.unknownReference} 1`)
        assert.equal(bridge.proof.posts, 0)
        assert.equal(searchGets, beforeTyping, 'No GET per keystroke')
        await apply.focus()
        await page.keyboard.press('Enter')
        await expect(rows.first()).toContainText('No encontramos', { timeout: 15000 })
        await expect(page.locator('[data-quick-line-total]')).toHaveCount(0)
        await expect(page.locator('[data-quick-add]')).toBeDisabled()
        assert.deepEqual(await cartSnapshot(), emptySnapshot, 'Unknown reference must not mutate cart')
        assert.equal(await digest(), baseline)
        await rows.first().locator('[data-quick-remove]').click()
        await pasteTab.click()
        await list.fill(`${fixture.skuReference} ${quantities[0]}\n${fixture.eanReference} ${quantities[1]}`)
        await apply.click()
        await expect(page.locator('[data-quick-line-total]')).toHaveCount(2, { timeout: 15000 })
        const money = (cents: number) =>
          new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100)
        for (const [row, index] of [first, second].map((row, index) => [row, index] as const)) {
          const item = rows.nth(index)
          await expect(item.locator('[data-quick-reference]')).toHaveValue(row.reference)
          for (const text of [row.variant.format, money(row.unitGrossCents), money(row.grossCents)])
            await expect(item).toContainText(text)
        }
        await expect(page.getByText(/el carrito los confirma/)).toBeVisible()
        assert.equal(bridge.proof.posts, 0, 'Resolving references is not an order')
        await page.locator('[data-quick-add]').dblclick()
        await expect.poll(() => bridge.proof.lostResponses, { timeout: 15000 }).toBe(1)
        await expect(page.locator('[data-quick-notice]')).toContainText('No sabemos si la referencia')
        assert.equal(bridge.proof.posts, 1)
        assert.equal(bridge.proof.receiptGets, 0)
        const saved = await page.evaluate(() => localStorage.getItem('neteco-cart-add-v1'))
        assert(saved && original)
        const journal = JSON.parse(saved) as { cartId: string; body: QuickOrderAddBody; confirmed: boolean }
        assert.equal(journal.cartId, initial.id)
        assert.deepEqual(journal.body, original)
        assert.equal(journal.confirmed, false)
        const beforeResume = searchGets
        // The uncertain reference is never resent; the rest waits for the cart to resolve it.
        await page.locator('[data-quick-add]').click()
        await expect(page.locator('[data-quick-notice]')).toContainText('Revisa primero el carrito')
        assert.equal(searchGets, beforeResume)
        assert.equal(bridge.proof.posts, 1)
        assert.equal(await page.evaluate(() => localStorage.getItem('neteco-cart-add-v1')), saved)
        assert.equal(
          await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
          false
        )
        await page.locator('[data-quick-notice]').getByRole('link', { name: 'Ir al carrito', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Comprobar adición', exact: true })).toBeEnabled({
          timeout: 15000
        })
        assert.equal(bridge.proof.receiptGets, 0, 'No automatic recovery')
        await page.getByRole('button', { name: 'Comprobar adición', exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => localStorage.getItem('neteco-cart-add-v1')), { timeout: 15000 })
          .toBeNull()
        assert.equal(bridge.proof.posts, 1)
        assert.equal(bridge.proof.receiptGets, 1)
        assert(
          bridge.proof.currentCartGets >= 1,
          'Manual receipt recovery must obtain a fresh correlated cart before clearing the journal'
        )
        assert.equal(await digest(), baseline)
        assert.equal(bridge.proof.blockedExternal, 0)
        assert.equal(bridge.proof.blockedWrites, 0)
        assert.equal(transportFailure, false)
        assert.equal(pageErrors, 0)
        input.scenario?.(QUICK_ORDER_BROWSER_SCENARIOS[index]!)
        scenarios++
        journeys.push({ viewport, ...bridge.proof, pageErrors, stockReservation: false })
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return {
    ...base,
    scenarios,
    browserExecuted: true,
    engine: 'remote_playwright_chromium',
    transport: 'playwright_same_origin_forwarding_to_real_workerd',
    journeys,
    viewports: ['desktop', 'mobile']
  }
}
