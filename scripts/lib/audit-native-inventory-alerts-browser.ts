import assert from 'node:assert/strict'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import { z } from 'zod'
import {
  inventoryAlertsResponseSchema,
  inventoryAlertPolicyResponseSchema,
  inventoryAlertThresholdInputSchema,
  inventoryAlertAckInputSchema,
  inventoryAlertEvaluationInputSchema,
  inventoryAlertCommandReceiptSchema,
  inventoryAlertCommandResponseSchema,
  inventoryAlertIntentHash,
  type InventoryAlertCommandReceipt,
  type InventoryAlertsResponse
} from '../../shared/inventory-alerts'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { sealedSessionCookie } from './audit-browser-session-cookie'

export const INVENTORY_ALERTS_BROWSER_SCENARIOS = [
  'native_inventory_alerts_compiled_threshold_ack_recovery_no_stock_writes_desktop',
  'native_inventory_alerts_compiled_threshold_ack_recovery_no_stock_writes_mobile'
] as const
export interface InventoryAlertsBrowserVariant {
  variantId: number
  sku: string
  threshold: number
}
export interface NativeInventoryAlertsBrowserInput {
  origin: string
  dispatch: (request: Request) => Promise<Response>
  adminCookie: string
  prepareVariant: (viewport: 'desktop' | 'mobile') => Promise<InventoryAlertsBrowserVariant>
  snapshotInventory: () => Promise<string>
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}
export type InventoryAlertsBrowserBridgeInput = Omit<
  NativeInventoryAlertsBrowserInput,
  'prepareVariant' | 'browserMode' | 'scenario'
> &
  InventoryAlertsBrowserVariant
type ForwardResult = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
type Episode = InventoryAlertsResponse['items'][number]
export class InventoryAlertsBrowserError extends Error {
  constructor(
    readonly stage: 'fixture' | 'forward' | 'completion' | 'compiled_page',
    readonly viewport: 'desktop' | 'mobile' | null = null
  ) {
    super('Isolated compiled inventory alert check failed')
    this.name = 'InventoryAlertsBrowserError'
  }
}
const base = '/api/admin/inventory/alerts',
  uuid = z.string().uuid()
function isolatedOrigin(origin: string) {
  const url = new URL(origin)
  assert(
    url.origin === origin && url.protocol === 'https:' && url.hostname === 'shop-audit.neteco.test',
    'Isolated origin required'
  )
}
function cookieValue(cookie: string) {
  assert(cookie.length <= 16384)
  const value = /^neteco-session=([^;\r\n]+)$/.exec(cookie)
  assert(value, 'Isolated signed session required')
  return value[1]!
}
async function privateJson(response: Response) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert(!response.headers.has('set-cookie'))
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i)
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  assert(bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
/** Only real same-origin HTTP bytes. The inventory digest is supplied by the
 * isolated caller; it excludes alert commands/audits and intentional quotas.
 * A response is lost only after both immutable receipt and fresh queue proof. */
export async function createInventoryAlertsBrowserBridge(input: InventoryAlertsBrowserBridgeInput) {
  let baseline: string, initialPolicy: z.infer<typeof inventoryAlertPolicyResponseSchema>
  const policyPath = `/api/admin/inventory/variants/${input.variantId}/alert-policy`
  const get = (path: string, hash?: string) =>
    input.dispatch(
      new Request(input.origin + path, {
        headers: {
          Cookie: input.adminCookie,
          Origin: input.origin,
          'CF-Connecting-IP': '192.0.2.167',
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        }
      })
    )
  const queue = async (query: Record<string, string>) =>
    inventoryAlertsResponseSchema.parse(await privateJson(await get(base + '?' + new URLSearchParams(query))))
  try {
    isolatedOrigin(input.origin)
    cookieValue(input.adminCookie)
    z.object({
      variantId: z.number().int().positive().safe(),
      sku: z.string().min(2).max(100),
      threshold: z.number().int().nonnegative().safe()
    })
      .strict()
      .parse({ variantId: input.variantId, sku: input.sku, threshold: input.threshold })
    baseline = await input.snapshotInventory()
    assert.match(baseline, /^[0-9a-f]{64}$/)
    initialPolicy = inventoryAlertPolicyResponseSchema.parse(await privateJson(await get(policyPath)))
    assert.equal(initialPolicy.variantId, input.variantId)
    assert.equal(initialPolicy.threshold, null)
    assert(initialPolicy.capabilities.inventoryWrite)
    const initial = await queue({ state: 'all', q: input.sku, page: '1', perPage: '25' })
    assert(
      !initial.items.some((item) => item.variantId === input.variantId && item.state !== 'resolved'),
      'Fixture must start without an active episode'
    )
  } catch {
    throw new InventoryAlertsBrowserError('fixture')
  }
  const counters = {
    thresholdPuts: 0,
    ackPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    freshAckGets: 0,
    evaluationPosts: 0,
    recovered: false,
    episodeId: null as string | null,
    blockedWrites: 0,
    blockedExternal: 0
  }
  let thresholdClaimed = false,
    ackClaimed = false,
    evaluationClaimed = false,
    thresholdConfirmed = false,
    manualReceiptRead = false
  let thresholdReceipt: InventoryAlertCommandReceipt | null = null,
    ackReceipt: InventoryAlertCommandReceipt | null = null,
    episode: Episode | null = null
  const abort = (reason: string): ForwardResult => ({ action: 'abort', reason })
  async function unchanged() {
    assert.equal(await input.snapshotInventory(), baseline, 'Alert governance must not change inventory')
  }
  async function exactEpisode() {
    assert(episode)
    const fresh = await queue({ state: 'all', alertId: episode.id, page: '1', perPage: '25' })
    assert.equal(fresh.pagination.total, 1)
    assert.equal(fresh.items.length, 1)
    const item = fresh.items[0]!
    assert.equal(item.id, episode.id)
    assert.equal(item.variantId, input.variantId)
    assert.equal(item.sku, input.sku)
    return item
  }
  function matching(
    raw: unknown,
    key: string,
    action: InventoryAlertCommandReceipt['action'],
    target: string,
    hash: string,
    version: number | null
  ) {
    const receipt = inventoryAlertCommandReceiptSchema.parse(raw)
    assert.equal(receipt.commandId, key)
    assert.equal(receipt.action, action)
    assert.equal(receipt.targetId, target)
    assert.equal(receipt.payloadHash, hash)
    assert.equal(receipt.version, version)
    return receipt
  }
  async function forward(request: Request): Promise<ForwardResult> {
    try {
      const url = new URL(request.url),
        path = url.pathname
      if (url.origin !== input.origin) {
        counters.blockedExternal++
        return abort('external_request')
      }
      const read = ['GET', 'HEAD'].includes(request.method),
        consent = request.method === 'DELETE' && path === '/api/analytics/session' && !url.search
      const threshold = request.method === 'PUT' && path === policyPath
      const ack = request.method === 'POST' && episode !== null && path === `${base}/${episode.id}/ack`
      const evaluate = request.method === 'POST' && path === base + '/evaluate'
      if (!read && !consent && !threshold && !ack && !evaluate) {
        counters.blockedWrites++
        return abort('unapproved_write')
      }
      if (threshold || ack || evaluate) {
        const key = request.headers.get('idempotency-key'),
          bytes = await request.clone().text()
        if (
          url.search ||
          sealedSessionCookie(request.headers.get('cookie')) !== input.adminCookie ||
          request.headers.get('origin') !== input.origin ||
          !uuid.safeParse(key).success ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
          Buffer.byteLength(bytes) > 2048
        ) {
          counters.blockedWrites++
          return abort('invalid_frozen_intention')
        }
        let raw: unknown
        try {
          raw = JSON.parse(bytes)
        } catch {
          counters.blockedWrites++
          return abort('invalid_body')
        }
        if (threshold) {
          const parsed = inventoryAlertThresholdInputSchema.safeParse(raw)
          if (
            thresholdClaimed ||
            !parsed.success ||
            parsed.data.expectedVersion !== initialPolicy.version ||
            parsed.data.threshold !== input.threshold
          ) {
            counters.blockedWrites++
            return abort('invalid_threshold_intention')
          }
          thresholdClaimed = true
          counters.thresholdPuts++
          const hash = await inventoryAlertIntentHash('threshold', String(input.variantId), parsed.data),
            response = await input.dispatch(request)
          if (response.status === 200) {
            thresholdReceipt = matching(
              await privateJson(response),
              key!,
              'threshold',
              String(input.variantId),
              hash,
              initialPolicy.version + 1
            )
            assert.equal(thresholdReceipt.opened, 1)
            const fresh = await queue({ state: 'open', q: input.sku, page: '1', perPage: '25' }),
              own = fresh.items.filter((item) => item.variantId === input.variantId)
            assert.equal(own.length, 1)
            episode = own[0]!
            assert.equal(episode.sku, input.sku)
            assert.equal(episode.state, 'open')
            assert.equal(episode.version, 1)
            assert.equal(episode.currentKind, episode.kind)
            assert(['low', 'out_of_stock'].includes(episode.kind))
            assert.equal(episode.threshold, input.threshold)
            counters.episodeId = episode.id
            await unchanged()
          }
          return { action: 'fulfill', response }
        }
        if (ack) {
          const parsed = inventoryAlertAckInputSchema.safeParse(raw)
          if (
            ackClaimed ||
            !thresholdConfirmed ||
            !episode ||
            !parsed.success ||
            parsed.data.expectedVersion !== episode.version
          ) {
            counters.blockedWrites++
            return abort('invalid_ack_intention')
          }
          ackClaimed = true
          counters.ackPosts++
          const hash = await inventoryAlertIntentHash('ack', episode.id, parsed.data),
            response = await input.dispatch(request)
          if (response.status !== 200) return { action: 'fulfill', response }
          const receipt = matching(await privateJson(response), key!, 'ack', episode.id, hash, episode.version + 1)
          const proof = inventoryAlertCommandResponseSchema.parse(
            await privateJson(await get(`${base}/commands/${key}`, hash))
          )
          assert.equal(proof.outcome, 'applied')
          assert(proof.outcome === 'applied')
          assert.deepEqual(proof.receipt, receipt)
          const fresh = await exactEpisode()
          assert.equal(fresh.state, 'acknowledged')
          assert.equal(fresh.version, receipt.version)
          assert.equal(fresh.currentKind, episode.kind)
          await unchanged()
          ackReceipt = receipt
          counters.lostResponses++
          return abort('proven_inventory_ack_response_lost')
        }
        const parsed = inventoryAlertEvaluationInputSchema.safeParse(raw)
        if (
          evaluationClaimed ||
          !counters.recovered ||
          !parsed.success ||
          parsed.data.limit !== 100 ||
          parsed.data.afterVariantId !== undefined
        ) {
          counters.blockedWrites++
          return abort('invalid_evaluation_intention')
        }
        evaluationClaimed = true
        counters.evaluationPosts++
        const hash = await inventoryAlertIntentHash('evaluate', 'warehouse', parsed.data),
          response = await input.dispatch(request)
        if (response.status === 200) {
          const receipt = matching(await privateJson(response), key!, 'evaluate', 'warehouse', hash, null)
          assert(
            receipt.processed > 0 &&
              (receipt.nextAfterVariantId === null || receipt.nextAfterVariantId >= input.variantId),
            'Prepared variant must be included in the evaluated bounded page'
          )
          const fresh = await exactEpisode()
          assert.equal(fresh.state, 'acknowledged')
          assert.equal(fresh.version, ackReceipt!.version)
          assert.equal(fresh.currentKind, episode!.kind)
          await unchanged()
        }
        return { action: 'fulfill', response }
      }
      const response = await input.dispatch(request)
      if (request.method === 'GET' && response.status === 200) {
        if (path === policyPath && !url.search) {
          const policy = inventoryAlertPolicyResponseSchema.parse(await privateJson(response))
          assert.equal(policy.variantId, input.variantId)
          if (thresholdReceipt) {
            assert.equal(policy.version, thresholdReceipt.version)
            assert.equal(policy.threshold, input.threshold)
            thresholdConfirmed = true
          }
        } else if (ackReceipt && path === `${base}/commands/${ackReceipt.commandId}` && !url.search) {
          assert.equal(request.headers.get('x-neteco-command-payload-hash'), ackReceipt.payloadHash)
          const proof = inventoryAlertCommandResponseSchema.parse(await privateJson(response))
          assert.equal(proof.outcome, 'applied')
          assert(proof.outcome === 'applied')
          assert.deepEqual(proof.receipt, ackReceipt)
          manualReceiptRead = true
          counters.receiptGets++
        } else if (ackReceipt && path === base && url.searchParams.get('alertId') === ackReceipt.targetId) {
          const fresh = inventoryAlertsResponseSchema.parse(await privateJson(response))
          assert.equal(fresh.items.length, 1)
          assert.equal(fresh.pagination.total, 1)
          const item = fresh.items[0]!
          assert.equal(item.id, ackReceipt.targetId)
          assert.equal(item.variantId, input.variantId)
          assert.equal(item.state, 'acknowledged')
          assert.equal(item.version, ackReceipt.version)
          if (manualReceiptRead) {
            counters.freshAckGets++
            counters.recovered = true
            await unchanged()
          }
        }
      }
      return { action: 'fulfill', response }
    } catch {
      throw new InventoryAlertsBrowserError('forward')
    }
  }
  async function assertComplete() {
    try {
      assert.equal(counters.thresholdPuts, 1)
      assert.equal(counters.ackPosts, 1)
      assert.equal(counters.evaluationPosts, 1)
      assert.equal(counters.lostResponses, 1)
      assert.equal(counters.receiptGets, 1)
      assert(counters.freshAckGets >= 1)
      assert(counters.recovered && thresholdConfirmed && ackReceipt && episode)
      assert.equal(counters.blockedWrites, 0)
      assert.equal(counters.blockedExternal, 0)
      const fresh = await exactEpisode()
      assert.equal(fresh.state, 'acknowledged')
      assert.equal(fresh.version, ackReceipt.version)
      await unchanged()
      return { ...counters }
    } catch {
      throw new InventoryAlertsBrowserError('completion')
    }
  }
  return { forward, assertComplete, state: () => ({ ...counters }) }
}
export async function auditNativeInventoryAlertsBrowser(input: NativeInventoryAlertsBrowserInput) {
  isolatedOrigin(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return { scenarios: 0, browserExecuted: false, reason: REMOTE_BROWSER_NOT_RUN_REASON, viewports: [] }
  const browser = await connectRemoteTestBrowser(chromium),
    contexts: BrowserContext[] = [],
    viewports = ['desktop', 'mobile'] as const
  let scenarios = 0
  try {
    for (const [index, viewport] of viewports.entries()) {
      try {
        const variant = await input.prepareVariant(viewport),
          bridge = await createInventoryAlertsBrowserBridge({ ...input, ...variant })
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
            value: cookieValue(input.adminCookie),
            url: input.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }
        ])
        let transportFailure = false,
          pageErrors = 0
        await context.route('**/*', async (route) => {
          try {
            const incoming = route.request(),
              headers = await incoming.allHeaders(),
              payload = incoming.postDataBuffer()
            headers['cf-connecting-ip'] = '192.0.2.167'
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
              if (result.reason !== 'proven_inventory_ack_response_lost') transportFailure = true
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
            transportFailure = true
            await route.abort('failed')
          }
        })
        const page = await context.newPage()
        page.on('pageerror', () => {
          pageErrors++
        })
        await page.goto(input.origin + '/admin/inventario', { waitUntil: 'networkidle', timeout: 30000 })
        const alerts = page.getByRole('region', { name: 'Alertas operativas de inventario', exact: true })
        await expect(alerts).toBeVisible({ timeout: 15000 })
        await page.getByTestId('inventory-search').fill(variant.sku)
        await page.getByTestId('search-inventory').focus()
        await page.keyboard.press('Enter')
        const choose = page.locator('li').filter({ hasText: variant.sku }).getByTestId('choose-inventory-variant')
        await expect(choose).toHaveCount(1)
        await choose.click()
        const selected = alerts.getByTestId('alerts-selected-policy')
        await expect(selected).toBeEnabled({ timeout: 15000 })
        await selected.focus()
        await page.keyboard.press('Enter')
        await expect(alerts.getByTestId('alerts-threshold')).toBeEnabled({ timeout: 15000 })
        await alerts.getByTestId('alerts-threshold').fill(String(variant.threshold))
        await alerts
          .getByTestId('alerts-threshold-reason')
          .fill('Synthetic browser explicit warehouse threshold decision')
        await alerts.getByRole('button', { name: 'Revisar cambio de umbral', exact: true }).click()
        await expect(alerts.getByTestId('alerts-confirm')).toBeVisible()
        assert.equal(bridge.state().thresholdPuts, 0)
        await alerts.getByTestId('alerts-confirm').focus()
        await page.keyboard.press('Enter')
        await expect(
          alerts.getByText('Umbral confirmado. No modifica el stock de seguridad ni las existencias.', { exact: true })
        ).toBeVisible({ timeout: 15000 })
        const id = bridge.state().episodeId
        assert(id)
        await alerts.locator(`[data-alert-ack="${id}"]`).click()
        await alerts
          .getByTestId('alerts-ack-reason')
          .fill('Synthetic browser manual recognition without inventory changes')
        await alerts.getByRole('button', { name: 'Revisar reconocimiento', exact: true }).click()
        await alerts.getByTestId('alerts-confirm').focus()
        await page.keyboard.press('Enter')
        await expect(alerts.getByTestId('alerts-recover')).toBeVisible({ timeout: 15000 })
        await expect(alerts.getByTestId('alerts-confirm')).toHaveCount(0)
        assert.equal(bridge.state().ackPosts, 1)
        await alerts.getByTestId('alerts-recover').focus()
        await page.keyboard.press('Enter')
        await expect(
          alerts.getByText('Reconocimiento confirmado. No repara ni resuelve el stock.', { exact: true })
        ).toBeVisible({ timeout: 15000 })
        assert(bridge.state().recovered)
        assert.equal(bridge.state().ackPosts, 1)
        await alerts.getByTestId('alerts-evaluate').click()
        await alerts.getByTestId('alerts-confirm').focus()
        await page.keyboard.press('Enter')
        await expect(alerts.getByText(/^Evaluación confirmada:/)).toBeVisible({ timeout: 15000 })
        await bridge.assertComplete()
        assert.equal(transportFailure, false)
        assert.equal(pageErrors, 0)
        assert.equal(
          await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
          false
        )
        await context.close()
        contexts.pop()
        input.scenario?.(INVENTORY_ALERTS_BROWSER_SCENARIOS[index]!)
        scenarios++
      } catch {
        throw new InventoryAlertsBrowserError('compiled_page', viewport)
      }
    }
    return {
      scenarios,
      browserExecuted: true,
      viewports: [...viewports],
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      thresholdPuts: 2,
      ackPosts: 2,
      evaluationPosts: 2
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
