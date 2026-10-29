import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import {
  catalogRelationsInputSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsCommandSchema,
  adminCatalogRelationsSchema,
  publicCatalogRelationsSchema,
  catalogRelationsIntentHash,
  type CatalogRelationsReceipt,
  type CatalogRelationsInput
} from '../../shared/catalog-relations'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'

export const CATALOG_RELATIONS_BROWSER_SCENARIOS = [
  'native_catalog_relations_compiled_review_public_context_desktop',
  'native_catalog_relations_compiled_review_public_context_mobile'
] as const
export interface CatalogRelationsBrowserFixture {
  sourceProductId: number
  sourceSlug: string
  targetProductId: number
  targetSlug: string
  targetName: string
  customerCookie: string
  cartCookie: string
  supportRef: string
}
export interface NativeCatalogRelationsBrowserInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  prepare: (viewport: 'desktop' | 'mobile') => Promise<CatalogRelationsBrowserFixture>
  browserMode?: 'required' | 'not-run'
  scenario?: (id: string) => void
}
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
export function createCatalogRelationsBrowserBridge(
  input: Omit<NativeCatalogRelationsBrowserInput, 'prepare' | 'browserMode' | 'scenario'> & {
    fixture: CatalogRelationsBrowserFixture
  }
) {
  isolated(input.origin)
  const path = `/api/admin/products/${input.fixture.sourceProductId}/relations`
  const proof = {
    posts: 0,
    lostResponses: 0,
    receiptGets: 0,
    currentGets: 0,
    publicGets: 0,
    blockedExternal: 0,
    blockedWrites: 0
  }
  let claimed = false,
    original: CatalogRelationsReceipt | null = null,
    body: CatalogRelationsInput | null = null
  return {
    proof,
    async forward(
      request: Request
    ): Promise<{ action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }> {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external_request' }
      }
      const write = request.method === 'POST' && url.pathname === path + '/commands' && !url.search
      const privacy = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      const owner = (request.headers.get('cookie') ?? '')
        .split(';')
        .map((value) => value.trim())
        .includes(input.adminCookie)
      if (!['GET', 'HEAD'].includes(request.method) && !privacy && !(write && owner)) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'unapproved_write' }
      }
      let key = '',
        hash = ''
      if (write) {
        assert(!claimed, 'Second POST/repost forbidden after uncertain response')
        claimed = true
        assert.equal(request.headers.get('origin'), input.origin)
        key = request.headers.get('idempotency-key') ?? ''
        assert(/^[0-9a-f-]{36}$/i.test(key))
        const text = await request.clone().text()
        assert(Buffer.byteLength(text) <= 32768)
        body = catalogRelationsInputSchema.parse(JSON.parse(text))
        assert(body.relations.some((edge) => edge.targetProductId === input.fixture.targetProductId))
        hash = await catalogRelationsIntentHash(input.fixture.sourceProductId, body)
        proof.posts++
      }
      const response = await input.dispatch(request)
      if (write && response.status === 201) {
        const receipt = catalogRelationsReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.commandId, key)
        assert.equal(receipt.productId, input.fixture.sourceProductId)
        assert.equal(receipt.expectedVersion, body!.expectedVersion)
        assert.equal(receipt.payloadHash, hash)
        const commands = await rows(
          input.database,
          'SELECT input_json,receipt_json,result_version,payload_hash FROM catalog_relation_commands WHERE command_id=? AND product_legacy_id=? LIMIT 1001',
          key,
          receipt.productId
        )
        assert.equal(commands.length, 1)
        assert.deepEqual(JSON.parse(String(commands[0]!.input_json)), body)
        assert.deepEqual(JSON.parse(String(commands[0]!.receipt_json)), receipt)
        assert.equal(commands[0]!.result_version, receipt.version)
        assert.equal(commands[0]!.payload_hash, hash)
        const revisions = await rows(
          input.database,
          `SELECT r.relations_json,r.payload_hash,r.version,h.command_id FROM catalog_relation_revisions r JOIN catalog_relation_heads h ON h.product_id=r.product_id AND h.version=r.version JOIN products p ON p.id=r.product_id WHERE p.legacy_id=? AND r.command_id=? LIMIT 1001`,
          receipt.productId,
          key
        )
        assert.equal(revisions.length, 1)
        assert.deepEqual(JSON.parse(String(revisions[0]!.relations_json)), body!.relations)
        assert.equal(revisions[0]!.payload_hash, hash)
        assert.equal(revisions[0]!.version, receipt.version)
        assert.equal(revisions[0]!.command_id, key)
        original = receipt
        proof.lostResponses++
        return { action: 'abort', reason: 'proven_catalog_relations_response_lost' }
      }
      if (original && request.method === 'GET' && url.pathname.startsWith(path + '/commands/')) {
        assert(owner)
        assert.equal(url.pathname, path + '/commands/' + original.commandId)
        assert.equal(request.headers.get('x-neteco-command-payload-hash'), original.payloadHash)
        assert.equal(response.status, 200)
        assert.deepEqual(catalogRelationsCommandSchema.parse(await response.clone().json()), {
          source: 'cloudflare',
          outcome: 'applied',
          receipt: original
        })
        proof.receiptGets++
      }
      if (original && proof.receiptGets && request.method === 'GET' && url.pathname === path) {
        assert(owner)
        assert.equal(response.status, 200)
        const current = adminCatalogRelationsSchema.parse(await response.clone().json())
        assert.equal(current.version, original.version)
        assert.deepEqual(current.items, body!.relations)
        proof.currentGets++
      }
      if (request.method === 'GET' && url.pathname === '/api/product-relations') {
        assert.equal(response.status, 200)
        const result = publicCatalogRelationsSchema.parse(await response.clone().json())
        if (original && url.searchParams.get('slugs')?.split(',').includes(input.fixture.sourceSlug)) {
          const group = result.groups.find((group) => group.productSlug === input.fixture.sourceSlug)
          assert(group && group.productId === input.fixture.sourceProductId)
          for (const edge of body!.relations.filter((edge) => edge.targetProductId === input.fixture.targetProductId))
            assert(
              group.items.some(
                (item) =>
                  item.kind === edge.kind &&
                  item.productId === edge.targetProductId &&
                  item.slug === input.fixture.targetSlug
              )
            )
        }
        proof.publicGets++
      }
      return { action: 'fulfill', response }
    }
  }
}
export async function auditNativeCatalogRelationsBrowser(input: NativeCatalogRelationsBrowserInput) {
  isolated(input.origin)
  const base = { productionBrowserAcceptance: false, providerSubmission: false, syntheticSessionOnly: true }
  if (input.browserMode === 'not-run')
    return { ...base, scenarios: 0, browserExecuted: false, reason: REMOTE_BROWSER_NOT_RUN_REASON, viewports: [] }
  const browser = await connectRemoteTestBrowser(chromium),
    viewports = []
  try {
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      const fixture = await input.prepare(viewport),
        bridge = createCatalogRelationsBrowserBridge({ ...input, fixture })
      const sourceCart = /^neteco-cart-v2=v1\.([0-9a-f-]{36})\./i.exec(fixture.cartCookie)?.[1]
      assert(sourceCart)
      assert(/^SOP-[A-F0-9]{24}$/.test(fixture.supportRef))
      const digest = async () =>
        createHash('sha256')
          .update(
            JSON.stringify(
              await Promise.all([
                ...[
                  'orders',
                  'order_lines',
                  'payment_intents',
                  'payment_commands',
                  'inventory_balances',
                  'inventory_movements',
                  'inventory_reservations',
                  'inventory_reservation_lines'
                ].map((table) => rows(input.database, `SELECT * FROM ${table} ORDER BY 1,2 LIMIT 1001`)),
                rows(input.database, 'SELECT * FROM carts WHERE id=? LIMIT 1001', sourceCart),
                rows(
                  input.database,
                  'SELECT * FROM cart_lines WHERE cart_id=? ORDER BY variant_id LIMIT 1001',
                  sourceCart
                )
              ])
            )
          )
          .digest('hex')
      const before = await digest(),
        contexts: BrowserContext[] = []
      let failed = false,
        pageErrors = 0
      const pageFor = async (cookies: string[]) => {
        const context = await browser.newContext({
          locale: 'es-ES',
          serviceWorkers: 'block',
          viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
        })
        contexts.push(context)
        await context.addCookies(
          cookies.map((cookie) => {
            const at = cookie.indexOf('=')
            return {
              name: cookie.slice(0, at),
              value: cookie.slice(at + 1),
              url: input.origin,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax' as const
            }
          })
        )
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              bytes = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.198'
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
              if (result.reason !== 'proven_catalog_relations_response_lost') failed = true
              await route.abort('failed')
            } else {
              const headers = Object.fromEntries(result.response.headers)
              delete headers['content-length']
              delete headers['content-encoding']
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
        const page = await context.newPage()
        page.on('pageerror', () => pageErrors++)
        return page
      }
      try {
        const admin = await pageFor([input.adminCookie])
        await admin.goto(`${input.origin}/admin/productos/${fixture.sourceProductId}`, { waitUntil: 'networkidle' })
        const consent = admin.getByRole('button', { name: 'Rechazar opcionales', exact: true })
        if (await consent.isVisible()) await consent.click()
        const editor = admin.getByRole('region', { name: 'Relaciones dirigidas de producto', exact: true })
        await expect(editor.locator('[data-relation-query]')).toBeEnabled()
        await editor.locator('[data-relation-query]').fill(fixture.targetName)
        await editor.locator('[data-relation-search] button[type=submit]').click()
        await editor.locator(`[data-relation-pick="${fixture.targetProductId}"]`).click()
        await editor.locator('[data-relation-kind]').selectOption(viewport === 'desktop' ? 'compatible' : 'equivalent')
        await editor.locator('[data-relation-add]').click()
        await editor.locator('[data-relation-reason]').fill(`Synthetic ${viewport} documented review`)
        await editor.locator('[data-relation-reference]').fill(`synthetic-${viewport}-reference`)
        await editor.locator('[data-relation-review] button[type=submit]').click()
        assert.equal(bridge.proof.posts, 0)
        await editor.locator('[data-relation-confirm]').click()
        const check = editor.locator('[data-relation-check]')
        await expect(check).toBeEnabled()
        await expect(editor).toContainText('Resultado incierto')
        assert.equal(bridge.proof.lostResponses, 1)
        await check.click()
        await expect(editor).toContainText('Relaciones confirmadas.')
        assert(bridge.proof.receiptGets > 0 && bridge.proof.currentGets > 0)
        const customer = await pageFor([fixture.customerCookie, fixture.cartCookie])
        const observe = async () => {
          const region = customer.getByRole('region', { name: 'Relaciones publicadas de productos', exact: true })
          await expect(region.getByRole('link', { name: fixture.targetName, exact: true }).first()).toHaveAttribute(
            'href',
            '/producto/' + fixture.targetSlug
          )
          await expect(region).toContainText('no confirma compatibilidad química')
          assert(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        }
        await customer.goto(input.origin + '/producto/' + fixture.sourceSlug, { waitUntil: 'networkidle' })
        await customer.getByRole('button', { name: 'Rechazar opcionales', exact: true }).click()
        await observe()
        await customer.goto(input.origin + '/carrito', { waitUntil: 'networkidle' })
        await observe()
        await customer.goto(input.origin + '/cuenta/soporte', { waitUntil: 'networkidle' })
        await customer.getByRole('button', { name: new RegExp('^' + fixture.supportRef + ' ·') }).click()
        await observe()
        assert.equal(bridge.proof.posts, 1)
        assert.equal(bridge.proof.lostResponses, 1)
        assert(bridge.proof.publicGets >= 3)
        assert.equal(await digest(), before)
        assert.equal(failed, false)
        assert.equal(pageErrors, 0)
        assert(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        input.scenario?.(CATALOG_RELATIONS_BROWSER_SCENARIOS[index]!)
        viewports.push({ viewport, ...bridge.proof, economicStateUnchanged: true })
      } finally {
        for (const context of contexts) await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { ...base, scenarios: viewports.length, browserExecuted: true, viewports }
}
