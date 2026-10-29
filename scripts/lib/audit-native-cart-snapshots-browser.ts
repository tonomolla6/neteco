import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import { z } from 'zod'
import {
  cartSnapshotInputSchema,
  cartSnapshotResponseSchema,
  cartSnapshotCommandSchema,
  cartSnapshotListSchema,
  cartSnapshotRevokeReceiptSchema,
  sharedCartResolveInputSchema,
  sharedCartResolveResponseSchema,
  cartSnapshotIntentHash,
  cartSnapshotRevokeIntentHash,
  type CartSnapshotResponse
} from '../../shared/cart-snapshots'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export const CART_SNAPSHOTS_BROWSER_SCENARIOS = [
  'native_cart_snapshots_compiled_save_share_recovery_desktop',
  'native_cart_snapshots_compiled_save_share_recovery_mobile'
] as const
export interface CartSnapshotsBrowserFixture {
  customerCookie: string
  cartCookie: string
  cartId: string
  cartVersion: number
  variantId: string
  variantLegacyId: number
  quantity: number
}
export interface NativeCartSnapshotsBrowserInput {
  origin: string
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  prepare: (viewport: 'desktop' | 'mobile') => Promise<CartSnapshotsBrowserFixture>
  browserMode?: 'required' | 'not-run'
  scenario?: (id: string) => void
}
const uuid = z.string().uuid()
function isolated(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test')
}
async function rows(database: D1Database, sql: string, ...parameters: (string | number)[]) {
  const result = await database
    .prepare(sql)
    .bind(...parameters)
    .all<Record<string, unknown>>()
  assert(result.success && result.results.length <= 1000, 'Bounded readonly evidence required')
  if (result.meta?.rows_written !== undefined) assert.equal(result.meta.rows_written, 0)
  return result.results.map((row) => Object.fromEntries(Object.entries(row)))
}
export function createCartSnapshotsBrowserBridge(input: {
  origin: string
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  fixture: CartSnapshotsBrowserFixture
}) {
  isolated(input.origin)
  uuid.parse(input.fixture.cartId)
  const proof = {
    creates: 0,
    lostResponses: 0,
    receipts: 0,
    listsAfterRecovery: 0,
    resolves: 0,
    adds: 0,
    revokes: 0,
    revokedDenials: 0,
    blockedExternal: 0,
    blockedWrites: 0
  }
  let claimed = false,
    original: CartSnapshotResponse | null = null,
    originalKey = '',
    originalHash = '',
    revoked = false
  const owner = (request: Request) => {
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((value) => value.trim())
    assert(cookies.includes(input.fixture.customerCookie))
    return cookies
  }
  return {
    proof,
    get saved() {
      return original
    },
    async forward(
      request: Request
    ): Promise<{ action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }> {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external_request' }
      }
      // Capability credentials may only appear in the resolve JSON body, never URL/referrer.
      assert(!url.hash && !url.searchParams.has('token'))
      if (original?.share) {
        assert(!request.url.includes(original.share.token))
        assert(!(request.headers.get('referer') ?? '').includes(original.share.token))
      }
      const create = request.method === 'POST' && url.pathname === '/api/account/cart-snapshots' && !url.search
      const resolve = request.method === 'POST' && url.pathname === '/api/cart/shared/resolve' && !url.search
      const revoke =
        request.method === 'POST' && /^\/api\/account\/cart-snapshots\/[^/]+\/revoke$/.test(url.pathname) && !url.search
      const add = request.method === 'POST' && url.pathname === '/api/cart/items' && !url.search
      const privacy = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !create && !resolve && !revoke && !add && !privacy) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'unapproved_write' }
      }
      if (create) {
        assert(!claimed, 'Second create/repost forbidden after an uncertain result')
        claimed = true
        assert(owner(request).includes(input.fixture.cartCookie))
        assert.equal(request.headers.get('x-neteco-cart-id'), input.fixture.cartId)
        assert.equal(request.headers.get('origin'), input.origin)
        const raw = await request.clone().text()
        assert(Buffer.byteLength(raw) <= 8192)
        const body = cartSnapshotInputSchema.parse(JSON.parse(raw))
        assert.equal(body.expectedCartVersion, input.fixture.cartVersion)
        assert.equal(body.createShare, true)
        originalKey = uuid.parse(request.headers.get('idempotency-key'))
        originalHash = await cartSnapshotIntentHash(body)
        proof.creates++
      }
      if (resolve) {
        assert(original?.share)
        const capability = sharedCartResolveInputSchema.parse(await request.clone().json())
        assert(
          capability.id === original.share.id && capability.token === original.share.token,
          'Resolve must use the original private capability'
        )
      }
      if (revoke) {
        owner(request)
        assert(original?.share)
        assert.equal(url.pathname, `/api/account/cart-snapshots/${original.share.id}/revoke`)
        assert.deepEqual(await request.clone().json(), {})
      }
      if (add) {
        assert(proof.resolves > 0 && !revoked, 'Only explicitly resolved live references may be copied')
        assert.equal(proof.adds, 0, 'No repeated copied line')
        const body = (await request.clone().json()) as Record<string, unknown>
        assert.equal(body.variantId, input.fixture.variantLegacyId)
        assert.equal(body.quantity, input.fixture.quantity)
        assert.notEqual(
          request.headers.get('x-neteco-cart-id'),
          input.fixture.cartId,
          'Destination must not be the source cart'
        )
        proof.adds++
      }
      const response = await input.dispatch(request)
      if (create && response.status === 201) {
        const result = cartSnapshotResponseSchema.parse(await response.clone().json())
        assert.equal(result.receipt.commandId, originalKey)
        assert.equal(result.receipt.payloadHash, originalHash)
        assert.equal(result.receipt.cartVersion, input.fixture.cartVersion)
        assert(result.share)
        assert.equal(Date.parse(result.share.expiresAt) - Date.parse(result.receipt.createdAt), 24 * 3600000)
        const commands = await rows(
          input.database,
          'SELECT command_id,payload_hash,cart_id,cart_version,list_id,share_id,receipt_json FROM customer_cart_snapshot_commands WHERE command_id=? LIMIT 1001',
          originalKey
        )
        assert.equal(commands.length, 1)
        const { receipt_json: persistedReceipt, ...facts } = commands[0]!
        assert.deepEqual(facts, {
          command_id: originalKey,
          payload_hash: originalHash,
          cart_id: input.fixture.cartId,
          cart_version: input.fixture.cartVersion,
          list_id: result.receipt.listId,
          share_id: result.share.id
        })
        assert.deepEqual(JSON.parse(String(persistedReceipt)), result.receipt)
        assert.deepEqual(
          await rows(
            input.database,
            'SELECT variant_id,quantity FROM customer_favorite_items WHERE list_id=? ORDER BY variant_id LIMIT 1001',
            result.receipt.listId
          ),
          [{ variant_id: input.fixture.variantId, quantity: input.fixture.quantity }]
        )
        const shares = await rows(
          input.database,
          'SELECT token_hash,snapshot_json,created_at,expires_at,revoked_at FROM customer_cart_shares WHERE id=? LIMIT 1001',
          result.share.id
        )
        assert.equal(shares.length, 1)
        assert.equal(shares[0]!.token_hash, createHash('sha256').update(result.share.token).digest('hex'))
        assert.deepEqual(JSON.parse(String(shares[0]!.snapshot_json)), [
          { variantId: input.fixture.variantId, quantity: input.fixture.quantity }
        ])
        assert.equal(shares[0]!.created_at, result.receipt.createdAt)
        assert.equal(shares[0]!.expires_at, result.share.expiresAt)
        assert.equal(shares[0]!.revoked_at, null)
        original = result
        proof.lostResponses++
        return { action: 'abort', reason: 'proven_cart_snapshot_response_lost' }
      }
      if (original && request.method === 'GET' && url.pathname.startsWith('/api/account/cart-snapshots/commands/')) {
        owner(request)
        assert.equal(url.pathname, '/api/account/cart-snapshots/commands/' + originalKey)
        assert.equal(request.headers.get('x-neteco-command-payload-hash'), originalHash)
        assert.equal(response.status, 200)
        const result = cartSnapshotCommandSchema.parse(await response.clone().json())
        assert(
          JSON.stringify(result) ===
            JSON.stringify(cartSnapshotCommandSchema.parse({ ...original, action: 'create', outcome: 'applied' })),
          'Recovered private receipt and capability must match original'
        )
        proof.receipts++
      }
      if (original && proof.receipts && request.method === 'GET' && url.pathname === '/api/account/cart-snapshots') {
        assert.equal(response.status, 200)
        assert(
          cartSnapshotListSchema
            .parse(await response.clone().json())
            .items.some((item) => item.receipt.commandId === originalKey && item.revoked === revoked)
        )
        proof.listsAfterRecovery++
      }
      if (resolve) {
        if (revoked) {
          assert.equal(response.status, 404)
          proof.revokedDenials++
        } else {
          assert.equal(response.status, 200)
          const result = sharedCartResolveResponseSchema.parse(await response.clone().json())
          assert.equal(result.id, original!.share!.id)
          assert.equal(result.expiresAt, original!.share!.expiresAt)
          assert.equal(result.items.length, 1)
          assert(result.items[0]!.available)
          assert.equal(result.items[0]!.variantId, input.fixture.variantId)
          assert.equal(result.items[0]!.quantity, input.fixture.quantity)
          proof.resolves++
        }
      }
      if (add) {
        assert.equal(response.status, 200)
        const destination = z
          .object({ id: uuid, items: z.array(z.object({ variantId: z.number(), qty: z.number() })) })
          .parse(await response.clone().json())
        assert.notEqual(destination.id, input.fixture.cartId)
        assert.deepEqual(destination.items, [{ variantId: input.fixture.variantLegacyId, qty: input.fixture.quantity }])
        assert.deepEqual(
          await rows(
            input.database,
            'SELECT variant_id,quantity FROM cart_lines WHERE cart_id=? ORDER BY variant_id LIMIT 1001',
            destination.id
          ),
          [{ variant_id: input.fixture.variantId, quantity: input.fixture.quantity }]
        )
      }
      if (revoke) {
        assert.equal(response.status, 200)
        const receipt = cartSnapshotRevokeReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.commandId, request.headers.get('idempotency-key'))
        assert.equal(receipt.payloadHash, await cartSnapshotRevokeIntentHash(original!.share!.id, {}))
        assert.equal(receipt.shareId, original!.share!.id)
        const stored = await rows(
          input.database,
          'SELECT revoked_at FROM customer_cart_shares WHERE id=? LIMIT 1001',
          receipt.shareId
        )
        assert.equal(stored[0]?.revoked_at, receipt.revokedAt)
        revoked = true
        proof.revokes++
      }
      return { action: 'fulfill', response }
    }
  }
}
export async function auditNativeCartSnapshotsBrowser(input: NativeCartSnapshotsBrowserInput) {
  isolated(input.origin)
  const base = { productionBrowserAcceptance: false, providerSubmission: false, syntheticSessionOnly: true }
  if (input.browserMode === 'not-run')
    return {
      ...base,
      scenarios: 0,
      browserExecuted: false,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      viewports: []
    }
  const browser = await connectRemoteTestBrowser(chromium),
    viewports = []
  try {
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      const fixture = await input.prepare(viewport)
      const bridge = createCartSnapshotsBrowserBridge({ ...input, fixture })
      const digest = async () =>
        createHash('sha256')
          .update(
            JSON.stringify(
              await Promise.all(
                [
                  'orders',
                  'order_lines',
                  'payment_intents',
                  'payment_commands',
                  'inventory_balances',
                  'inventory_movements',
                  'inventory_reservations',
                  'inventory_reservation_lines'
                ].map((table) => rows(input.database, `SELECT * FROM ${table} ORDER BY 1,2 LIMIT 1001`))
              )
            )
          )
          .digest('hex')
      const source = async () =>
        Promise.all([
          rows(input.database, 'SELECT * FROM carts WHERE id=? LIMIT 1001', fixture.cartId),
          rows(
            input.database,
            'SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id LIMIT 1001',
            fixture.cartId
          ),
          rows(
            input.database,
            'SELECT * FROM cart_commands WHERE cart_id=? ORDER BY command_id LIMIT 1001',
            fixture.cartId
          )
        ])
      const baseline = await digest(),
        originalCart = await source()
      const options = {
        locale: 'es-ES',
        serviceWorkers: 'block' as const,
        viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
      }
      const ownerContext = await browser.newContext(options),
        recipientContext = await browser.newContext(options)
      let failed = false,
        pageErrors = 0
      const attach = async (context: BrowserContext) => {
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              bytes = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.191'
            headers['accept-encoding'] = 'identity'
            const result = await bridge.forward(
              new Request(incoming.url(), {
                method: incoming.method(),
                headers,
                redirect: 'manual',
                ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {})
              })
            )
            if (result.action === 'abort') {
              if (result.reason !== 'proven_cart_snapshot_response_lost') failed = true
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
            failed = true
            await route.abort('failed')
          }
        })
      }
      try {
        await ownerContext.addCookies(
          [fixture.customerCookie, fixture.cartCookie].map((cookie) => {
            const index = cookie.indexOf('=')
            return {
              name: cookie.slice(0, index),
              value: cookie.slice(index + 1),
              url: input.origin,
              secure: true,
              httpOnly: true,
              sameSite: 'Lax' as const
            }
          })
        )
        await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: input.origin })
        await attach(ownerContext)
        await attach(recipientContext)
        const ownerPage = await ownerContext.newPage(),
          recipient = await recipientContext.newPage()
        for (const page of [ownerPage, recipient]) {
          page.on('pageerror', () => {
            pageErrors++
          })
          page.on('console', (message) => {
            if (bridge.saved?.share && message.text().includes(bridge.saved.share.token)) failed = true
          })
        }
        await ownerPage.goto(input.origin + '/carrito', { waitUntil: 'networkidle' })
        const banner = ownerPage.getByRole('button', { name: 'Rechazar opcionales', exact: true })
        if (await banner.isVisible()) await banner.click()
        const panel = ownerPage.getByRole('region', { name: 'Guardar y compartir carrito', exact: true })
        await expect(panel).toBeVisible()
        await panel.locator('[data-snapshot-name]').fill(`Synthetic ${viewport} saved quantities`)
        assert.equal(bridge.proof.creates, 0)
        await panel.locator('[data-snapshot-share]').click()
        await expect(panel.locator('[data-snapshot-check]')).toBeVisible()
        await panel.locator('[data-snapshot-check]').click()
        await expect(panel.locator('[data-snapshot-copy]')).toBeVisible()
        assert.equal(bridge.proof.creates, 1)
        assert(bridge.proof.receipts > 0 && bridge.proof.listsAfterRecovery > 0)
        await panel.locator('[data-snapshot-copy]').click()
        await expect(panel).toContainText('Enlace original copiado.')
        const link = await ownerPage.evaluate(() => navigator.clipboard.readText())
        const share = bridge.saved!.share!
        assert(
          link === `${input.origin}/carrito/compartido#${share.id}.${share.token}`,
          'Copied capability must match original exactly'
        )
        await ownerPage.evaluate(() => navigator.clipboard.writeText(''))
        try {
          await recipient.goto(link, { waitUntil: 'networkidle' })
        } catch {
          throw new Error('Private shared-cart landing failed')
        }
        await expect.poll(() => recipient.url() === input.origin + '/carrito/compartido').toBe(true)
        assert(!(await recipient.content()).includes(share.token), 'Private capability must not enter rendered HTML')
        await recipient.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
        assert.equal(bridge.proof.resolves, 0, 'Landing must not automatically resolve or copy')
        assert.equal(bridge.proof.adds, 0)
        await recipient.locator('[data-shared-resolve]').click()
        await expect(recipient.locator('[data-shared-copy]')).toBeDisabled()
        await recipient.locator('[data-shared-confirm]').check()
        await recipient.locator('[data-shared-copy]').click()
        await expect(recipient.getByRole('status')).toContainText('referencias confirmadas en tu carrito')
        assert.equal(bridge.proof.adds, 1)
        for (const page of [ownerPage, recipient]) {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
          const stored = await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)])
          assert(
            stored.every((value) => !value.includes(share.token)),
            'Capability must not enter storage'
          )
        }
        await panel.locator(`[data-snapshot-revoke="${share.id}"]`).click()
        await expect(panel).toContainText('Enlace revocado')
        await recipient.locator('[data-shared-resolve]').click()
        await expect(recipient.getByRole('alert')).toContainText('No se ha podido consultar este enlace')
        assert.equal(bridge.proof.revokedDenials, 1)
        await recipient.reload({ waitUntil: 'networkidle' })
        await expect(recipient.getByRole('alert')).toContainText('Enlace inválido o incompleto')
        assert.equal(await digest(), baseline)
        assert.deepEqual(await source(), originalCart)
        assert.equal(failed, false)
        assert.equal(pageErrors, 0)
        input.scenario?.(CART_SNAPSHOTS_BROWSER_SCENARIOS[index]!)
        viewports.push({
          viewport,
          ...bridge.proof,
          originUnchanged: true,
          economicStateUnchanged: true,
          fragmentPurged: true
        })
      } finally {
        await ownerContext.close()
        await recipientContext.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { ...base, scenarios: viewports.length, browserExecuted: true, viewports }
}
