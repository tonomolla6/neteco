import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { fulfillmentOrderIdSchema } from '../../shared/order-fulfillment'
import {
  adminOrderPackingSchema,
  orderPackingInputSchema,
  orderPackingReceiptSchema,
  orderPackingCommandResponseSchema,
  orderPackingIntentHash,
  type OrderPackingReceipt
} from '../../shared/order-packing'
import { readOrderReturnsDomainDigest } from './audit-native-order-returns-browser'
import { auditNativeOrderTrackingBrowser } from './audit-native-order-tracking-browser'

export const PACKING_BROWSER_SCENARIOS = [
  'native_packing_compiled_exact_recovery_desktop',
  'native_packing_compiled_exact_recovery_mobile'
] as const
export interface NativeOrderPackingBrowserInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  browserMode?: 'required' | 'not-run'
  prepare: (viewport: 'desktop' | 'mobile') => Promise<{ adminCookie: string; orderId: string; customerCookie: string }>
  scenario?: (name: string) => void
}
function isolated(origin: string) {
  assert.equal(origin, 'https://shop-audit.neteco.test')
}
function sessionCookie(cookie: string) {
  assert(typeof cookie === 'string' && cookie.length <= 16384)
  const match = /^neteco-session=([^;\s]+)$/.exec(cookie)
  assert(match, 'One synthetic administrator session required')
  return match[1]!
}
export function createPackingBrowserBridge(
  input: Pick<NativeOrderPackingBrowserInput, 'database' | 'dispatch' | 'origin'> & {
    adminCookie: string
    orderId: string
  }
) {
  isolated(input.origin)
  fulfillmentOrderIdSchema.parse(input.orderId)
  sessionCookie(input.adminCookie)
  const base = `/api/admin/orders/${input.orderId}/packing`
  const proof = {
    packPosts: 0,
    dispatchPosts: 0,
    lostResponses: 0,
    blockedExternal: 0,
    blockedWrites: 0,
    recoveryReads: 0,
    currentReadsAfterLoss: 0
  }
  let packed: OrderPackingReceipt | null = null
  async function read(path: string, hash?: string) {
    const response = await input.dispatch(
      new Request(input.origin + path, {
        headers: {
          Cookie: input.adminCookie,
          'CF-Connecting-IP': '192.0.2.170',
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        }
      })
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    return response.json()
  }
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
      const command = request.method === 'POST' && url.pathname === base + '/commands' && !url.search
      const consent = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      if (!['GET', 'HEAD'].includes(request.method) && !command && !consent) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      if (!command) {
        const response = await input.dispatch(request)
        if (packed && request.method === 'GET') {
          if (url.pathname === base + '/commands/' + packed.commandId && response.status === 200) {
            assert.equal(request.headers.get('X-Neteco-Command-Payload-Hash'), packed.payloadHash)
            const recovered = orderPackingCommandResponseSchema.parse(await response.clone().json())
            assert.deepEqual(recovered, { source: 'cloudflare', outcome: 'applied', receipt: packed })
            proof.recoveryReads++
          }
          if (url.pathname === base && response.status === 200) {
            const current = adminOrderPackingSchema.parse(await response.clone().json())
            assert.equal(current.orderId, input.orderId)
            assert(current.version >= packed.version)
            proof.currentReadsAfterLoss++
          }
        }
        return { action: 'fulfill', response }
      }
      assert.equal(
        /(?:^|;\s*)neteco-session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1],
        sessionCookie(input.adminCookie)
      )
      const text = await request.clone().text()
      assert(Buffer.byteLength(text) <= 65536)
      const body = orderPackingInputSchema.parse(JSON.parse(text)),
        key = request.headers.get('Idempotency-Key')
      assert(key && /^[a-f0-9-]{36}$/.test(key))
      if (body.action === 'pack') {
        assert.equal(proof.packPosts, 0, 'A lost pack must never be reposted')
        assert.equal(proof.dispatchPosts, 0)
        proof.packPosts++
      } else {
        assert(packed, 'Packing must commit before manual expedition')
        assert.equal(proof.dispatchPosts, 0)
        assert(
          proof.recoveryReads > 0 && proof.currentReadsAfterLoss > 0,
          'Explicit receipt plus fresh state recovery required'
        )
        proof.dispatchPosts++
      }
      const response = await input.dispatch(request)
      if (response.status !== 201) return { action: 'fulfill', response }
      assert.match(response.headers.get('cache-control') ?? '', /no-store/)
      const receipt = orderPackingReceiptSchema.parse(await response.clone().json())
      assert.equal(receipt.commandId, key)
      assert.equal(receipt.orderId, input.orderId)
      assert.equal(receipt.action, body.action)
      assert.equal(receipt.payloadHash, await orderPackingIntentHash(input.orderId, body))
      assert.equal(receipt.version, body.expectedVersion + 1)
      assert.equal(receipt.fulfillmentVersion, body.expectedFulfillmentVersion)
      const row = await input.database
        .prepare(
          `SELECT c.input,c.response,c.result_version,
      (SELECT COUNT(*) FROM order_packing_audit a WHERE a.command_id=c.command_id AND a.input=c.input AND a.response=c.response AND a.payload_hash=c.payload_hash) AS audits
      FROM order_packing_commands c WHERE c.command_id=? AND c.order_id=? AND c.payload_hash=?`
        )
        .bind(key, input.orderId, receipt.payloadHash)
        .first<{ input: string; response: string; result_version: number; audits: number }>()
      assert(row)
      assert.equal(row.audits, 1)
      assert.equal(row.result_version, receipt.version)
      assert.deepEqual(JSON.parse(row.input), body)
      assert.deepEqual(orderPackingReceiptSchema.parse(JSON.parse(row.response)), receipt)
      assert.deepEqual(
        orderPackingCommandResponseSchema.parse(await read(base + '/commands/' + key, receipt.payloadHash)),
        { source: 'cloudflare', outcome: 'applied', receipt }
      )
      const current = adminOrderPackingSchema.parse(await read(base))
      assert.equal(current.orderId, input.orderId)
      assert.equal(current.version, receipt.version)
      assert.equal(current.fulfillmentVersion, receipt.fulfillmentVersion)
      if (body.action === 'pack') {
        assert.deepEqual(current.parcels, body.parcels)
        assert.equal(current.dispatch, null)
        packed = receipt
        proof.lostResponses++
        return { action: 'abort', reason: 'lost_packing_response' }
      }
      assert(current.dispatch)
      assert.equal(current.dispatch.commandId, key)
      assert.deepEqual(current.dispatch.shipments, body.shipments)
      assert.equal(current.dispatch.actualNetCents, body.actualNetCents)
      assert.equal(current.dispatch.taxBps, body.taxBps)
      return { action: 'fulfill', response }
    }
  }
}
export async function auditNativeOrderPackingBrowser(input: NativeOrderPackingBrowserInput) {
  isolated(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      productionBrowserAcceptance: false,
      providerSubmission: false
    }
  const browser = await connectRemoteTestBrowser(chromium)
  const evidence: Array<{
    viewport: string
    before: string
    after: string
    packPosts: number
    dispatchPosts: number
    lostResponses: number
    tracking: Awaited<ReturnType<typeof auditNativeOrderTrackingBrowser>>
  }> = []
  let pageErrors = 0
  try {
    for (const [index, viewport] of (
      [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ] as const
    ).entries()) {
      const prepared = await input.prepare(viewport.name)
      fulfillmentOrderIdSchema.parse(prepared.orderId)
      const credential = sessionCookie(prepared.adminCookie)
      const before = await readOrderReturnsDomainDigest(input.database, prepared.orderId)
      const bridge = createPackingBrowserBridge({ ...input, ...prepared })
      const context = await browser.newContext({
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        viewport: { width: viewport.width, height: viewport.height },
        serviceWorkers: 'block'
      })
      let transportFailure: unknown = null
      try {
        await context.addCookies([
          {
            name: 'neteco-session',
            value: credential,
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ])
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              bytes = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.170'
            headers['accept-encoding'] = 'identity'
            const result = await bridge.forward(
              new Request(incoming.url(), {
                method: incoming.method(),
                headers,
                ...(bytes ? { body: Uint8Array.from(bytes).buffer } : {}),
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
          } catch (error) {
            transportFailure = error
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => pageErrors++)
        await page.goto(input.origin + '/admin/pedidos/' + prepared.orderId, {
          waitUntil: 'networkidle',
          timeout: 30000
        })
        const panel = page.getByRole('region', { name: 'Embalaje y expedición manual', exact: true })
        await expect(panel.getByTestId('packing-weight-0')).toBeVisible({ timeout: 15000 })
        await panel.getByTestId('packing-add-parcel').click()
        for (const parcel of [0, 1]) {
          for (const [field, value] of [
            ['weight', '1000'],
            ['width', '200'],
            ['height', '100'],
            ['depth', '100']
          ])
            await panel.getByTestId(`packing-${field}-${parcel}`).fill(value!)
          await panel.getByTestId(`packing-quantity-${parcel}-0`).fill('2')
        }
        await panel.getByTestId('packing-reason').fill('Revisión sintética de dos bultos en almacén aislado')
        await panel.getByTestId('packing-review').click()
        assert.equal(bridge.proof.packPosts, 0)
        await panel.getByTestId('packing-confirm').click()
        await expect(panel.getByTestId('packing-recover')).toBeVisible({ timeout: 15000 })
        assert.equal(bridge.proof.packPosts, 1)
        assert.equal(bridge.proof.lostResponses, 1)
        await panel.getByTestId('packing-recover').click()
        await expect(panel).toContainText('Registro confirmado', { timeout: 15000 })
        assert.equal(bridge.proof.packPosts, 1)
        await panel.getByTestId('packing-dispatch-mode').click()
        for (const parcel of [0, 1])
          for (const [field, value] of [
            ['carrier', 'Operador sintético'],
            ['shipment', `SYNTHETIC-${parcel}`],
            ['tracking', `TRACK-${parcel}`],
            ['label', `DOCUMENT-${parcel}`]
          ])
            await panel.getByTestId(`packing-${field}-${parcel}`).fill(value!)
        await panel.getByTestId('packing-actual-net').fill('700')
        await panel.getByTestId('packing-tax').fill('2100')
        await panel
          .getByTestId('packing-reason')
          .fill('Registro manual sintético de referencias externas no verificadas')
        await panel.getByTestId('packing-review').click()
        assert.equal(bridge.proof.dispatchPosts, 0)
        await panel.getByTestId('packing-confirm').click()
        await expect(panel).toContainText('Expedición manual registrada', { timeout: 15000 })
        await expect(panel).toContainText('Referencias no verificadas por el transportista')
        assert.equal(bridge.proof.packPosts, 1)
        assert.equal(bridge.proof.dispatchPosts, 1)
        const tracking = await auditNativeOrderTrackingBrowser({
          browser,
          adminPage: page,
          database: input.database,
          dispatch: input.dispatch,
          origin: input.origin,
          orderId: prepared.orderId,
          adminCookie: prepared.adminCookie,
          customerCookie: prepared.customerCookie,
          viewport: { width: viewport.width, height: viewport.height }
        })
        if (transportFailure) throw transportFailure
        const width = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }))
        assert(width.width <= width.viewport + 1, 'Packing must not overflow viewport')
        const after = await readOrderReturnsDomainDigest(input.database, prepared.orderId)
        assert.equal(after, before, 'Manual packing must not change stock, money or fulfillment')
        const counts = await input.database
          .prepare(
            'SELECT COUNT(*) AS commands,(SELECT COUNT(*) FROM order_packing_audit WHERE order_id=?1) AS audits FROM order_packing_commands WHERE order_id=?1'
          )
          .bind(prepared.orderId)
          .first<{ commands: number; audits: number }>()
        assert.deepEqual(counts, { commands: 2, audits: 2 })
        evidence.push({
          viewport: viewport.name,
          before,
          after,
          packPosts: bridge.proof.packPosts,
          dispatchPosts: bridge.proof.dispatchPosts,
          lostResponses: bridge.proof.lostResponses,
          tracking
        })
        assert.equal(pageErrors, 0, 'Compiled packing must have no JavaScript errors')
        input.scenario?.(PACKING_BROWSER_SCENARIOS[index]!)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return {
    scenarios: evidence.length,
    browserStatus: 'passed' as const,
    productionBrowserAcceptance: false,
    providerSubmission: false,
    pageErrors,
    viewports: evidence
  }
}
