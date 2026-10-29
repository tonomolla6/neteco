import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import {
  customerSatisfactionSchema,
  satisfactionInputSchema,
  satisfactionReceiptSchema,
  satisfactionCommandResponseSchema,
  adminSatisfactionResponseSchema,
  satisfactionIntentHash,
  type CustomerSatisfaction,
  type SatisfactionInput,
  type SatisfactionReceipt,
  type SatisfactionSource
} from '../../shared/support-satisfaction'
import { supportRef, supportUuid } from '../../shared/support-operations'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
export const SATISFACTION_BROWSER_SCENARIOS = [
  'native_satisfaction_compiled_support_delivery_receipt_recovery_admin_segments_desktop',
  'native_satisfaction_compiled_support_delivery_receipt_recovery_admin_segments_mobile'
] as const
export interface SatisfactionBrowserFixture {
  customerCookie: string
  supportRef: string
  deliveryOrderId: string
}
export interface NativeSatisfactionBrowserInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  browserMode?: 'required' | 'not-run'
  prepare: (viewport: 'desktop' | 'mobile') => Promise<SatisfactionBrowserFixture>
  scenario?: (name: string) => void
}
export type SatisfactionBrowserBridgeInput = Omit<
  NativeSatisfactionBrowserInput,
  'prepare' | 'browserMode' | 'scenario'
> &
  SatisfactionBrowserFixture
export class SatisfactionBrowserError extends Error {
  constructor(
    readonly stage: 'fixture' | 'forward' | 'completion' | 'compiled_page',
    readonly viewport: 'desktop' | 'mobile' | null = null
  ) {
    super('Isolated compiled satisfaction check failed')
    this.name = 'SatisfactionBrowserError'
  }
}
const comments = { support: 'Synthetic browser support feedback', delivery: 'Synthetic browser delivery feedback' }
function isolatedOrigin(origin: string) {
  const url = new URL(origin)
  assert(url.origin === origin && url.protocol === 'https:' && url.hostname === 'shop-audit.neteco.test')
}
function sessionValue(cookie: string) {
  assert(cookie.length <= 16384)
  const value = /(?:^|;\s*)neteco-session=([^;\r\n]+)/.exec(cookie)
  assert(value)
  return value[1]!
}
async function privateJson(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert((response.headers.get('vary') ?? '').split(',').some((value) => value.trim() === 'Cookie'))
  assert(!response.headers.has('set-cookie'))
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i)
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  assert(bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
async function economicDigest(database: D1Database) {
  const tables = [
    'orders',
    'order_lines',
    'order_events',
    'order_fulfillments',
    'order_fulfillment_commands',
    'order_fulfillment_audit',
    'inventory_balances',
    'inventory_movements',
    'inventory_reservations',
    'inventory_reservation_lines',
    'payment_intents',
    'payment_events',
    'order_payment_states',
    'support_tickets',
    'support_events',
    'support_commands'
  ]
  const rows = await database.batch(tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY 1`)))
  const serialized = JSON.stringify(rows.map((row) => row.results))
  assert(Buffer.byteLength(serialized) <= 4 * 1024 * 1024, 'Isolated bounded source snapshot required')
  return createHash('sha256').update(serialized).digest('hex')
}
export async function createSatisfactionBrowserBridge(input: SatisfactionBrowserBridgeInput) {
  isolatedOrigin(input.origin)
  sessionValue(input.adminCookie)
  sessionValue(input.customerCookie)
  supportRef.parse(input.supportRef)
  supportUuid.parse(input.deliveryOrderId)
  const target = { support: input.supportRef, delivery: input.deliveryOrderId }
  const endpoint = (kind: SatisfactionSource) => `/api/account/satisfaction/${kind}/${target[kind]}`
  const get = (path: string, hash?: string) =>
    input.dispatch(
      new Request(input.origin + path, {
        headers: {
          Cookie: input.customerCookie,
          Origin: input.origin,
          'CF-Connecting-IP': '192.0.2.168',
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        }
      })
    )
  const parsedState = (raw: unknown, kind: SatisfactionSource) => {
    const value = customerSatisfactionSchema.parse(raw)
    assert.equal(value.target.kind, kind)
    assert.equal(value.target.id, target[kind])
    return value
  }
  const initial: Partial<Record<SatisfactionSource, CustomerSatisfaction>> = {}
  let baseline: string
  try {
    baseline = await economicDigest(input.database)
    for (const kind of ['support', 'delivery'] as const) {
      const value = parsedState(await privateJson(await get(endpoint(kind))), kind)
      assert(value.eligible && value.privacy && value.feedback === null)
      initial[kind] = value
    }
  } catch {
    throw new SatisfactionBrowserError('fixture')
  }
  const counters = {
    supportPosts: 0,
    deliveryPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    recovered: false,
    deliveryConfirmed: false,
    adminWithoutComments: false,
    adminWithComments: false,
    adminSegment: false,
    blockedWrites: 0,
    blockedExternal: 0
  }
  const claims: Partial<Record<SatisfactionSource, { body: SatisfactionInput; receipt: SatisfactionReceipt }>> = {}
  const started = new Set<SatisfactionSource>()
  let manualReceipt = false
  const unchanged = async () => assert.equal(await economicDigest(input.database), baseline)
  const matchReceipt = (raw: unknown, kind: SatisfactionSource, key: string, hash: string, body: SatisfactionInput) => {
    const receipt = satisfactionReceiptSchema.parse(raw)
    assert.equal(receipt.commandId, key)
    assert.equal(receipt.payloadHash, hash)
    assert.equal(receipt.target.kind, kind)
    assert.equal(receipt.target.id, target[kind])
    assert.equal(receipt.target.version, body.expectedSourceVersion)
    assert.equal(receipt.score, body.score)
    return receipt
  }
  const matchFeedback = (value: CustomerSatisfaction, kind: SatisfactionSource) => {
    const claim = claims[kind]
    assert(claim)
    assert.equal(value.eligible, false)
    assert.equal(value.reason, 'already_submitted')
    assert(value.feedback)
    assert.equal(value.feedback.score, claim.body.score)
    assert.equal(value.feedback.comment, claim.body.comment ?? null)
    assert.equal(value.feedback.submittedAt, claim.receipt.submittedAt)
  }
  async function forward(
    request: Request
  ): Promise<{ action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }> {
    try {
      const url = new URL(request.url)
      if (url.origin !== input.origin) {
        counters.blockedExternal++
        return { action: 'abort', reason: 'external_request' }
      }
      const read = request.method === 'GET' || request.method === 'HEAD'
      const consent = request.method === 'DELETE' && url.pathname === '/api/analytics/session' && !url.search
      const kind = (['support', 'delivery'] as const).find((value) => url.pathname === endpoint(value))
      if (!read && !consent) {
        if (request.method !== 'POST' || !kind || url.search) {
          counters.blockedWrites++
          return { action: 'abort', reason: 'unapproved_write' }
        }
        if (started.has(kind)) {
          counters.blockedWrites++
          return { action: 'abort', reason: 'duplicate_satisfaction_post' }
        }
        const bytes = await request.clone().text(),
          key = request.headers.get('idempotency-key')
        if (
          Buffer.byteLength(bytes) > 2048 ||
          !supportUuid.safeParse(key).success ||
          request.headers.get('origin') !== input.origin ||
          sessionValue(request.headers.get('cookie') ?? '') !== sessionValue(input.customerCookie) ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
        ) {
          counters.blockedWrites++
          return { action: 'abort', reason: 'invalid_satisfaction_intention' }
        }
        const body = satisfactionInputSchema.parse(JSON.parse(bytes))
        assert.equal(body.score, 5)
        assert.equal(body.comment, comments[kind])
        assert.equal(body.expectedSourceVersion, initial[kind]!.target.version)
        assert.equal(body.expectedPolicyHash, initial[kind]!.privacy!.policyHash)
        if (kind === 'delivery') assert(counters.recovered)
        started.add(kind)
        if (kind === 'support') counters.supportPosts++
        else counters.deliveryPosts++
        const hash = await satisfactionIntentHash(kind, target[kind], body),
          response = await input.dispatch(request)
        if (response.status !== 201) return { action: 'fulfill', response }
        const receipt = matchReceipt(await privateJson(response, 201), kind, key!, hash, body)
        claims[kind] = { body, receipt }
        const proof = satisfactionCommandResponseSchema.parse(
          await privateJson(await get(endpoint(kind) + '/commands/' + key, hash))
        )
        assert(proof.outcome === 'applied')
        assert.deepEqual(proof.receipt, receipt)
        matchFeedback(parsedState(await privateJson(await get(endpoint(kind))), kind), kind)
        await unchanged()
        if (kind === 'support') {
          counters.lostResponses++
          return { action: 'abort', reason: 'proven_satisfaction_response_lost' }
        }
        return { action: 'fulfill', response }
      }
      const response = await input.dispatch(request)
      if (request.method === 'GET' && response.status === 200) {
        const supportClaim = claims.support
        if (supportClaim && url.pathname === endpoint('support') + '/commands/' + supportClaim.receipt.commandId) {
          assert(!url.search)
          assert.equal(request.headers.get('x-neteco-command-payload-hash'), supportClaim.receipt.payloadHash)
          assert.equal(sessionValue(request.headers.get('cookie') ?? ''), sessionValue(input.customerCookie))
          const proof = satisfactionCommandResponseSchema.parse(await privateJson(response))
          assert(proof.outcome === 'applied')
          assert.deepEqual(proof.receipt, supportClaim.receipt)
          manualReceipt = true
          counters.receiptGets++
        } else if (kind && claims[kind]) {
          matchFeedback(parsedState(await privateJson(response), kind), kind)
          if (kind === 'support' && manualReceipt) counters.recovered = true
          if (kind === 'delivery') counters.deliveryConfirmed = true
        } else if (url.pathname === '/api/admin/support/satisfaction' && counters.deliveryConfirmed) {
          assert.equal(sessionValue(request.headers.get('cookie') ?? ''), sessionValue(input.adminCookie))
          const summary = adminSatisfactionResponseSchema.parse(await privateJson(response)),
            requestedComments = url.searchParams.get('comments') === 'true'
          assert.equal(summary.commentsIncluded, requestedComments)
          const relevant = summary.items.filter((item) => target[item.target.kind] === item.target.id)
          const segment = url.searchParams.get('source')
          for (const source of ['support', 'delivery'] as const) {
            if (segment && segment !== source) continue
            const item = relevant.find((item) => item.target.kind === source)
            assert(item)
            assert.equal(item.score, 5)
            assert.equal(item.comment, requestedComments ? comments[source] : null)
          }
          assert(summary.stats.count >= relevant.length)
          if (requestedComments) counters.adminWithComments = true
          else counters.adminWithoutComments = true
          if (segment === 'support' && url.searchParams.get('score') === '5') counters.adminSegment = true
        }
      }
      return { action: 'fulfill', response }
    } catch {
      throw new SatisfactionBrowserError('forward')
    }
  }
  async function assertComplete() {
    try {
      assert.equal(counters.supportPosts, 1)
      assert.equal(counters.deliveryPosts, 1)
      assert.equal(counters.lostResponses, 1)
      assert.equal(counters.receiptGets, 1)
      assert(
        counters.recovered &&
          counters.deliveryConfirmed &&
          counters.adminWithoutComments &&
          counters.adminWithComments &&
          counters.adminSegment
      )
      assert.equal(counters.blockedWrites, 0)
      assert.equal(counters.blockedExternal, 0)
      for (const kind of ['support', 'delivery'] as const) {
        matchFeedback(parsedState(await privateJson(await get(endpoint(kind))), kind), kind)
        const count = await input.database
          .prepare('SELECT count(*) AS n FROM support_satisfaction_commands WHERE kind=? AND target_id=?')
          .bind(kind, target[kind])
          .first<{ n: number }>()
        assert.equal(count?.n, 1)
      }
      await unchanged()
      return { ...counters, inventoryEffect: 'none', economicEffect: 'none' }
    } catch {
      throw new SatisfactionBrowserError('completion')
    }
  }
  return { forward, assertComplete, state: () => ({ ...counters }) }
}
export async function auditNativeSatisfactionBrowser(input: NativeSatisfactionBrowserInput) {
  if (input.browserMode === 'not-run')
    return { scenarios: 0, browserExecuted: false, reason: REMOTE_BROWSER_NOT_RUN_REASON, viewports: [] }
  isolatedOrigin(input.origin)
  assert(input.browserMode === undefined || input.browserMode === 'required')
  const browser = await connectRemoteTestBrowser(chromium),
    contexts: BrowserContext[] = []
  let scenarios = 0
  try {
    for (const [index, viewport] of (['desktop', 'mobile'] as const).entries()) {
      try {
        const fixture = await input.prepare(viewport),
          bridge = await createSatisfactionBrowserBridge({ ...input, ...fixture })
        let transportFailure = false,
          pageErrors = 0
        async function context(cookie: string) {
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
              value: sessionValue(cookie),
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
                payload = incoming.postDataBuffer()
              headers['cf-connecting-ip'] = '192.0.2.168'
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
                if (result.reason !== 'proven_satisfaction_response_lost') transportFailure = true
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
          return page
        }
        const customer = await context(fixture.customerCookie)
        await customer.goto(input.origin + '/cuenta/soporte', { waitUntil: 'networkidle', timeout: 30000 })
        const ticket = customer.getByRole('button').filter({ hasText: fixture.supportRef })
        await expect(ticket).toHaveCount(1)
        await ticket.click()
        const support = customer.getByRole('region', { name: 'Valoración opcional de soporte', exact: true })
        await expect(support).toBeVisible({ timeout: 15000 })
        async function submit(panel: ReturnType<typeof customer.getByRole>, kind: SatisfactionSource) {
          await expect(panel.locator('input[name="satisfaction-score"][value="5"]')).toBeEnabled({ timeout: 15000 })
          await panel.locator('input[name="satisfaction-score"][value="5"]').check()
          await panel.getByTestId('satisfaction-comment').fill(comments[kind])
          await panel.getByTestId('satisfaction-privacy').check()
          await panel.getByRole('button', { name: 'Revisar valoración', exact: true }).click()
          await panel.getByTestId('satisfaction-confirm').focus()
          await customer.keyboard.press('Enter')
        }
        await submit(support, 'support')
        await expect(support.getByTestId('satisfaction-recover')).toBeEnabled({ timeout: 15000 })
        assert.equal(bridge.state().supportPosts, 1)
        await support.getByTestId('satisfaction-recover').focus()
        await customer.keyboard.press('Enter')
        await expect(
          support.getByText('Valoración confirmada. No cambia la atención, el pedido ni tus derechos.', { exact: true })
        ).toBeVisible({ timeout: 15000 })
        assert(bridge.state().recovered)
        await customer.goto(input.origin + '/pedido/' + fixture.deliveryOrderId, {
          waitUntil: 'networkidle',
          timeout: 30000
        })
        const delivery = customer.getByRole('region', { name: 'Valoración opcional de entrega', exact: true })
        await expect(delivery).toBeVisible({ timeout: 15000 })
        await submit(delivery, 'delivery')
        await expect(delivery.getByTestId('satisfaction-saved')).toContainText(comments.delivery, { timeout: 15000 })
        const staff = await context(input.adminCookie)
        await staff.goto(input.origin + '/admin/soporte', { waitUntil: 'networkidle', timeout: 30000 })
        const summary = staff.getByRole('region', { name: 'Satisfacción de clientes', exact: true })
        await expect(summary).toBeVisible({ timeout: 15000 })
        await expect(summary.getByTestId('satisfaction-admin-refresh')).toBeEnabled({ timeout: 15000 })
        await summary.getByTestId('satisfaction-admin-refresh').click()
        await expect(summary.getByTestId('satisfaction-admin-refresh')).toBeEnabled({ timeout: 15000 })
        await expect(summary.getByText(comments.support, { exact: true })).toHaveCount(0)
        await summary.getByTestId('satisfaction-source').selectOption('support')
        await summary.getByTestId('satisfaction-score-filter').selectOption('5')
        await summary.getByTestId('satisfaction-comments-optin').check()
        await summary.getByRole('button', { name: 'Aplicar segmentos', exact: true }).click()
        await expect(summary.getByText(comments.support, { exact: true }).first()).toBeVisible({ timeout: 15000 })
        await bridge.assertComplete()
        assert.equal(transportFailure, false)
        assert.equal(pageErrors, 0)
        for (const page of [customer, staff])
          assert.equal(
            await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
            false
          )
        while (contexts.length) await contexts.pop()!.close()
        input.scenario?.(SATISFACTION_BROWSER_SCENARIOS[index]!)
        scenarios++
      } catch {
        throw new SatisfactionBrowserError('compiled_page', viewport)
      }
    }
    return {
      scenarios,
      browserExecuted: true,
      viewports: ['desktop', 'mobile'],
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      supportPosts: 2,
      deliveryPosts: 2,
      lostResponses: 2,
      inventoryEffect: 'none',
      economicEffect: 'none'
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}
