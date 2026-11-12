import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  orderCancellationInputSchema,
  orderCancellationReceiptSchema,
  orderCancellationEligibilitySchema,
  type OrderCancellationInput,
  type OrderCancellationReceipt
} from '../../shared/order-cancellation'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import {
  orderAnnotationsInputSchema,
  orderAnnotationsReceiptSchema,
  orderAnnotationsResponseSchema,
  orderAnnotationCommandSchema,
  type OrderAnnotationsInput,
  type OrderAnnotationsReceipt
} from '../../shared/order-annotations'
import {
  adminOrderBulkPreviewInputSchema,
  adminOrderBulkCreateInputSchema,
  adminOrderBulkPreviewSchema,
  adminOrderBulkReceiptSchema,
  adminOrderBulkCommandSchema,
  adminOrderBulkGroupSchema,
  adminOrderBulkIntentHash,
  type AdminOrderBulkCreateInput,
  type AdminOrderBulkReceipt
} from '../../shared/admin-order-bulk'
import {
  adminOrderViewCreateInputSchema,
  adminOrderViewReceiptSchema,
  adminOrderViewDetailSchema,
  adminOrderViewListSchema,
  adminOrderViewIntentHash
} from '../../shared/admin-order-views'
import {
  ORDER_EXPORT_FILENAME,
  ORDER_EXPORT_HEADERS,
  ORDER_EXPORT_MAX_BYTES,
  orderExportMetadataSchema,
  verifyOrderExportCsv
} from '../../shared/order-export'

/** Deliberately exclude paths, query values, origins and headers from evidence. */
export function foreignOrderReadDiagnostic(request: Request): {
  method: 'GET' | 'HEAD' | 'OTHER'
  routeKind: 'icon_api' | 'asset' | 'private_api' | 'page'
} {
  const pathname = new URL(request.url).pathname
  return {
    method: request.method === 'GET' || request.method === 'HEAD' ? request.method : 'OTHER',
    routeKind: pathname.startsWith('/_icons/')
      ? 'icon_api'
      : pathname.startsWith('/_nuxt/')
        ? 'asset'
        : pathname.startsWith('/api/')
          ? 'private_api'
          : 'page'
  }
}

function isWorkbenchActivityRead(request: Request, target: URL): boolean {
  // The layout requests exactly five audit records. Forward the caller's
  // original credentials to the actual authorization handler, never a feed
  // fixture or a broader private-API exception.
  return request.method === 'GET' && target.pathname === '/api/admin/activity' && target.search === '?limit=5'
}

function isWorkbenchCartHydration(request: Request, target: URL): boolean {
  // The global client plugin loads its own cart even on an admin page. This
  // exact read keeps the original cart cookie; it grants no cart command.
  return request.method === 'GET' && target.pathname === '/api/cart' && !target.search
}

export function allowsOrderOperationsForeignRead(
  request: Request,
  input: { origin: string; savedViewId?: string | null; groupId?: string; commandId?: string }
): boolean {
  const target = new URL(request.url)
  if (target.origin !== input.origin || !['GET', 'HEAD'].includes(request.method)) return false
  const views = '/api/admin/order-views'
  const bulk = '/api/admin/orders/bulk-fulfillment'
  const allowed = [
    '/',
    '/admin/pedidos',
    '/logo-figura.svg',
    '/favicon.svg',
    '/api/_auth/session',
    '/api/admin/capabilities',
    '/api/admin/orders',
    views,
    ...(input.savedViewId ? [views + '/' + input.savedViewId] : []),
    ...(input.groupId && input.commandId ? [bulk + '/' + input.groupId, bulk + '/commands/' + input.commandId] : [])
  ]
  return (
    isWorkbenchActivityRead(request, target) ||
    isWorkbenchCartHydration(request, target) ||
    allowed.includes(target.pathname) ||
    target.pathname.startsWith('/_nuxt/') ||
    target.pathname === '/favicon.ico'
  )
}

export interface OrderOperationsBulkProof {
  commandId: string
  body: AdminOrderBulkCreateInput
  receipt: AdminOrderBulkReceipt
}
export interface OrderOperationsWorkbenchFixture {
  adminCookie: string
  otherActorCookie: string
  orderIds: string[]
  query: string
  eligibleOrderIds: string[]
  blockedOrderId: string
}
type BulkBrowserBoundary = {
  adminCookie: string
  orderIds: string[]
  readCommittedBulk: (proof: OrderOperationsBulkProof) => Promise<void>
  consumeBulkQueue: (message: { groupId: string; dispatchId: string }) => Promise<void>
}

export interface OrderOperationsBrowserDiagnostic {
  stage: 'admin_detail_history_heading'
  viewport: 'desktop' | 'mobile'
  pathname: string | null
  errorClass: 'Error' | 'AssertionError' | 'TimeoutError' | 'Other'
  responses: Array<{ path: string; status: number }>
  counts: {
    historyHeading: number | null
    timelineItems: number | null
    annotationInputs: number | null
    loginInputs: number | null
    detailHeading: number | null
  }
  screenshotPath: string | null
  captureFailed: boolean
}
export class OrderOperationsBrowserDiagnosticError extends Error {
  constructor(readonly safeDiagnostic: OrderOperationsBrowserDiagnostic) {
    super('Compiled administrative order history unavailable')
    this.name = 'OrderOperationsBrowserDiagnosticError'
  }
}
export async function awaitOrderOperationsHistory(input: {
  origin: string
  orderId: string
  viewport: 'desktop' | 'mobile'
  responses: Array<{ path: string; status: number }>
  wait: () => Promise<void>
  url: () => string
  count: (key: keyof OrderOperationsBrowserDiagnostic['counts']) => Promise<number>
  screenshot: (path: string) => Promise<void>
}): Promise<void> {
  try {
    await input.wait()
  } catch (error) {
    const allowedPages = ['/', '/login', '/admin', '/admin/pedidos', `/admin/pedidos/${input.orderId}`]
    const allowedApis = [
      '/api/_auth/session',
      '/api/admin/capabilities',
      '/api/admin/orders',
      `/api/admin/orders/${input.orderId}/detail`,
      `/api/admin/orders/${input.orderId}/timeline`,
      `/api/admin/orders/${input.orderId}/annotations`
    ]
    let pathname: string | null = null
    try {
      const url = new URL(input.url())
      if (url.origin === input.origin && allowedPages.includes(url.pathname)) pathname = url.pathname
    } catch {
      /* Never retain malformed URLs or provider messages. */
    }
    const responses = input.responses
      .flatMap((response) => {
        if (
          !response.path.startsWith('/') ||
          response.path.startsWith('//') ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        )
          return []
        try {
          const url = new URL(response.path, input.origin)
          return url.origin === input.origin && allowedApis.includes(url.pathname)
            ? [{ path: url.pathname, status: response.status }]
            : []
        } catch {
          return []
        }
      })
      .slice(-20)
    const counts: OrderOperationsBrowserDiagnostic['counts'] = {
      historyHeading: null,
      timelineItems: null,
      annotationInputs: null,
      loginInputs: null,
      detailHeading: null
    }
    let captureFailed = false
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      try {
        const value = await input.count(key)
        if (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) counts[key] = value
        else captureFailed = true
      } catch {
        captureFailed = true
      }
    }
    let screenshotPath: string | null =
      `test-results/.artifacts/order-operations-browser/admin-history-${input.viewport}.png`
    try {
      await input.screenshot(screenshotPath)
    } catch {
      screenshotPath = null
      captureFailed = true
    }
    const errorClass =
      error instanceof Error && ['Error', 'AssertionError', 'TimeoutError'].includes(error.name)
        ? (error.name as OrderOperationsBrowserDiagnostic['errorClass'])
        : 'Other'
    throw new OrderOperationsBrowserDiagnosticError({
      stage: 'admin_detail_history_heading',
      viewport: input.viewport,
      pathname,
      errorClass,
      responses,
      counts,
      screenshotPath,
      captureFailed
    })
  }
}

export interface OrderOperationsAnnotationsProof {
  orderId: string
  commandId: string
  body: OrderAnnotationsInput
  receipt: OrderAnnotationsReceipt
}
export function createOrderAnnotationsBrowserBridge(input: {
  origin: string
  orderId: string
  adminCookie: string
  dispatch: (request: Request) => Promise<Response>
  readCommittedAnnotations: (proof: OrderOperationsAnnotationsProof) => Promise<void>
}) {
  isolatedOrigin(input.origin)
  assert(UUID.test(input.orderId))
  const credential = sessionCookie(input.adminCookie)
  const proof = {
    annotationPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    currentGets: 0,
    blockedExternal: 0,
    blockedWrites: 0
  }
  const path = `/api/admin/orders/${input.orderId}/annotations`
  let claimed = false,
    committedKey: string | null = null
  return {
    proof,
    async forward(request: Request): Promise<ForwardResult> {
      const target = new URL(request.url)
      if (target.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const command = request.method === 'POST' && target.pathname === path && !target.search
      const consent = request.method === 'DELETE' && target.pathname === '/api/analytics/session' && !target.search
      if (!['GET', 'HEAD'].includes(request.method) && !command && !consent) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      let body: OrderAnnotationsInput | null = null,
        commandId: string | null = null
      if (command) {
        assert.equal(claimed, false, 'Manual annotation recovery must never POST again')
        claimed = true
        assert.equal(request.headers.get('origin'), input.origin)
        assert.equal(/(?:^|;\s*)neteco-session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1], credential)
        commandId = request.headers.get('idempotency-key')
        assert(commandId && UUID.test(commandId))
        const text = await request.clone().text()
        assert(new TextEncoder().encode(text).byteLength <= 4096)
        body = orderAnnotationsInputSchema.parse(JSON.parse(text))
        proof.annotationPosts++
      }
      if (request.method === 'GET' && target.pathname === path) proof.currentGets++
      if (request.method === 'GET' && target.pathname.startsWith(path + '/commands/')) {
        assert(committedKey && target.pathname === path + '/commands/' + committedKey && !target.search)
        proof.receiptGets++
      }
      const response = await input.dispatch(request)
      if (command && response.status === 200) {
        const receipt = orderAnnotationsReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.orderId, input.orderId)
        assert.equal(receipt.commandId, commandId)
        assert.equal(receipt.version, body!.expectedVersion + 1)
        if (body!.labels !== undefined) assert.deepEqual(receipt.labels, body!.labels)
        assert.equal(receipt.noteId !== null, body!.note !== undefined)
        await input.readCommittedAnnotations({ orderId: input.orderId, commandId: commandId!, body: body!, receipt })
        committedKey = commandId
        proof.lostResponses++
        return { action: 'abort', reason: 'lost_annotations_response' }
      }
      return { action: 'fulfill', response }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type ForwardResult = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
export interface OrderOperationsCancellationProof {
  orderId: string
  commandId: string
  body: OrderCancellationInput
  receipt: OrderCancellationReceipt
  request: ReturnType<Request['clone']>
}
function isolatedOrigin(origin: string) {
  const url = new URL(origin)
  assert(
    url.protocol === 'https:' && url.origin === origin && url.hostname === 'shop-audit.neteco.test',
    'Isolated compiled audit origin required'
  )
}
function sessionCookie(cookie: string) {
  assert(typeof cookie === 'string' && cookie.length <= 16384)
  const match = /^neteco-session=([^;\r\n]+)$/.exec(cookie)
  assert(match, 'Use only the caller-owned sealed synthetic session')
  return match[1]!
}
export function createWorkbenchBrowserBridge(input: {
  origin: string
  dispatch: (request: Request) => Promise<Response>
  bulk: BulkBrowserBoundary
}) {
  const base = '/api/admin/orders/bulk-fulfillment',
    views = '/api/admin/order-views'
  const credential = sessionCookie(input.bulk.adminCookie)
  const selected = new Set(input.bulk.orderIds)
  assert(selected.size === input.bulk.orderIds.length && selected.size > 0 && selected.size <= 25)
  assert(input.bulk.orderIds.every((id) => UUID.test(id)))
  const proof = {
    cancellationPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    currentCancellationGets: 0,
    blockedExternal: 0,
    blockedWrites: 0,
    bulkPosts: 0,
    bulkLostResponses: 0,
    bulkReceiptGets: 0,
    bulkGroupGets: 0,
    viewPosts: 0,
    viewDetailGets: 0,
    viewListGets: 0,
    logoutPosts: 0
  }
  let preview: z.infer<typeof adminOrderBulkPreviewSchema> | null = null
  let previewInput: z.infer<typeof adminOrderBulkPreviewInputSchema> | null = null
  let receipt: AdminOrderBulkReceipt | null = null,
    commandKey: string | null = null,
    commandHash: string | null = null
  let viewId: string | null = null,
    commandClaimed = false,
    viewClaimed = false,
    completeObserved = false
  const ownedCredential = (request: Request) => {
    assert.equal(/(?:^|;\s*)neteco-session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1], credential)
  }
  const parsedBody = async (request: Request) => {
    assert.equal(request.headers.get('origin'), input.origin)
    ownedCredential(request)
    const text = await request.clone().text()
    assert(Buffer.byteLength(text, 'utf8') <= 32768)
    return JSON.parse(text) as unknown
  }
  return {
    proof,
    async forward(request: Request): Promise<ForwardResult> {
      const target = new URL(request.url)
      if (target.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const path = target.pathname
      const read = request.method === 'GET' || request.method === 'HEAD'
      const command = request.method === 'POST' && path === base + '/commands' && !target.search
      const review = request.method === 'POST' && path === base + '/preview' && !target.search
      const saveView = request.method === 'POST' && path === views && !target.search
      const logout =
        request.method === 'POST' &&
        path === '/api/auth/logout' &&
        !target.search &&
        completeObserved &&
        proof.logoutPosts === 0
      const clearSession =
        request.method === 'DELETE' && path === '/api/_auth/session' && !target.search && proof.logoutPosts === 1
      const consentDeletion = request.method === 'DELETE' && path === '/api/analytics/session' && !target.search
      const staticRead =
        read &&
        ([
          '/',
          '/admin/pedidos',
          '/login',
          '/logo-figura.svg',
          '/favicon.svg',
          '/api/_auth/session',
          '/api/admin/capabilities'
        ].includes(path) ||
          path.startsWith('/_nuxt/') ||
          path === '/favicon.ico')
      // Logout performs a hard navigation to the real storefront. Its bounded
      // public reads are allowed only after the owned session was revoked.
      const publicRead =
        read &&
        proof.logoutPosts === 1 &&
        ['/api/categories', '/api/products', '/api/promotional-content', '/api/cart'].includes(path)
      const queueRead = read && path === '/api/admin/orders'
      const activityRead = isWorkbenchActivityRead(request, target)
      const cartHydration = isWorkbenchCartHydration(request, target)
      const exportRead = request.method === 'GET' && path === '/api/admin/orders/export.csv'
      const viewRead =
        request.method === 'GET' &&
        (path === views || (viewId !== null && path === views + '/' + viewId)) &&
        !target.search
      const receiptRead = request.method === 'GET' && receipt !== null && path === base + '/commands/' + commandKey
      const groupRead =
        request.method === 'GET' && receipt !== null && path === base + '/' + receipt.groupId && !target.search
      if (
        !staticRead &&
        !publicRead &&
        !queueRead &&
        !activityRead &&
        !cartHydration &&
        !exportRead &&
        !viewRead &&
        !receiptRead &&
        !groupRead &&
        !command &&
        !review &&
        !saveView &&
        !logout &&
        !clearSession &&
        !consentDeletion
      ) {
        if (!read) proof.blockedWrites++
        return { action: 'abort', reason: 'unapproved_request' }
      }
      if (command) {
        assert.equal(commandClaimed, false, 'Bulk recovery must never send a second POST or UUID')
        commandClaimed = true
      }
      if (saveView) {
        assert.equal(viewClaimed, false, 'Only one explicitly created private view is allowed')
        viewClaimed = true
      }
      let body: AdminOrderBulkCreateInput | null = null
      let viewBody: z.infer<typeof adminOrderViewCreateInputSchema> | null = null,
        viewKey: string | null = null
      if (review) {
        assert.equal(commandClaimed, false)
        previewInput = adminOrderBulkPreviewInputSchema.parse(await parsedBody(request))
        assert.deepEqual([...previewInput.orderIds].sort(), [...selected].sort())
        assert.equal(request.headers.get('idempotency-key'), null, 'Preview must not claim a command')
      }
      if (command) {
        body = adminOrderBulkCreateInputSchema.parse(await parsedBody(request))
        commandKey = request.headers.get('idempotency-key')
        assert(commandKey && UUID.test(commandKey))
        assert(preview && previewInput, 'A current explicit server preview must precede commit')
        assert.equal(body.action, preview.action)
        assert.equal(body.reason, previewInput.reason)
        assert.equal(body.evidence, previewInput.evidence)
        assert.equal(body.previewHash, preview.previewHash)
        assert.deepEqual(
          body.orders,
          preview.rows.map((row) => ({ orderId: row.orderId, expectedVersion: row.expectedVersion }))
        )
        commandHash = await adminOrderBulkIntentHash(body)
        proof.bulkPosts++
      }
      if (saveView) {
        viewBody = adminOrderViewCreateInputSchema.parse(await parsedBody(request))
        viewKey = request.headers.get('idempotency-key')
        assert(viewKey && UUID.test(viewKey))
        proof.viewPosts++
      }
      if (receiptRead) {
        ownedCredential(request)
        assert.deepEqual([...target.searchParams.keys()], ['payloadHash'])
        assert.equal(target.searchParams.get('payloadHash'), commandHash)
        proof.bulkReceiptGets++
      }
      if (groupRead) {
        ownedCredential(request)
        proof.bulkGroupGets++
      }
      if (viewRead) {
        ownedCredential(request)
        if (path === views) proof.viewListGets++
        else proof.viewDetailGets++
      }
      if (logout) {
        ownedCredential(request)
        assert.equal(request.headers.get('origin'), input.origin)
        proof.logoutPosts++
      }
      const response = await input.dispatch(request)
      if (review && response.status === 200) {
        preview = adminOrderBulkPreviewSchema.parse(await response.clone().json())
        assert.equal(preview.action, previewInput!.action)
        assert.deepEqual(preview.rows.map((row) => row.orderId).sort(), [...selected].sort())
      }
      if (saveView && response.status === 201) {
        const saved = adminOrderViewReceiptSchema.parse(await response.clone().json())
        assert.equal(saved.commandId, viewKey)
        assert.equal(saved.payloadHash, await adminOrderViewIntentHash('create', null, viewBody))
        assert.equal(saved.action, 'create')
        assert.equal(saved.version, 1)
        viewId = saved.viewId
      }
      if (command && response.status === 201) {
        receipt = adminOrderBulkReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.commandId, commandKey)
        assert.equal(receipt.payloadHash, commandHash)
        assert.equal(receipt.previewHash, body!.previewHash)
        assert.equal(receipt.selected, selected.size)
        assert.equal(receipt.eligible, preview!.eligible)
        assert.equal(receipt.blocked, preview!.blocked)
        await input.bulk.readCommittedBulk({ commandId: commandKey!, body: body!, receipt })
        await input.bulk.consumeBulkQueue({ groupId: receipt.groupId, dispatchId: receipt.dispatchId })
        proof.bulkLostResponses++
        return { action: 'abort', reason: 'lost_bulk_response' }
      }
      if (receiptRead && response.status === 200) {
        const current = adminOrderBulkCommandSchema.parse(await response.clone().json())
        assert.equal(current.outcome, 'applied')
        if (current.outcome === 'applied') assert.deepEqual(current.receipt, receipt)
      }
      if (groupRead && response.status === 200) {
        const current = adminOrderBulkGroupSchema.parse(await response.clone().json())
        assert.equal(current.groupId, receipt!.groupId)
        assert.equal(current.commandId, commandKey)
        assert.equal(current.dispatchId, receipt!.dispatchId)
        assert.equal(current.payloadHash, commandHash)
        completeObserved = current.status === 'completed' && current.remaining === 0
      }
      return { action: 'fulfill', response }
    }
  }
}
/** Fault injection drops only a real successful response, AFTER independent
 * durable readback. Never constructs Worker DTOs, grants or business facts. */
export function createOrderOperationsBrowserBridge(input: {
  origin: string
  orderId: string
  dispatch: (request: Request) => Promise<Response>
  readCommittedCancellation: (proof: OrderOperationsCancellationProof) => Promise<void>
  bulk?: BulkBrowserBoundary
}) {
  isolatedOrigin(input.origin)
  assert(UUID.test(input.orderId))
  if (input.bulk) return createWorkbenchBrowserBridge({ ...input, bulk: input.bulk })
  const proof = {
    cancellationPosts: 0,
    lostResponses: 0,
    receiptGets: 0,
    currentCancellationGets: 0,
    blockedExternal: 0,
    blockedWrites: 0
  }
  const path = `/api/orders/${input.orderId}/cancellation`
  let committedKey: string | null = null
  let commandClaimed = false
  return {
    proof,
    async forward(request: Request): Promise<ForwardResult> {
      const target = new URL(request.url)
      if (target.origin !== input.origin) {
        proof.blockedExternal++
        return { action: 'abort', reason: 'external' }
      }
      const command = request.method === 'POST' && target.pathname === path && !target.search
      const consentDeletion =
        request.method === 'DELETE' && target.pathname === '/api/analytics/session' && !target.search
      if (!['GET', 'HEAD'].includes(request.method) && !command && !consentDeletion) {
        proof.blockedWrites++
        return { action: 'abort', reason: 'forbidden_write' }
      }
      let commandId: string | null = null,
        body: OrderCancellationInput | null = null
      const copy = request.clone()
      if (command) {
        assert.equal(commandClaimed, false, 'Receipt recovery must not issue another cancellation POST')
        commandId = request.headers.get('idempotency-key')
        assert(commandId && UUID.test(commandId), 'Original UUID command key required')
        commandClaimed = true
        body = orderCancellationInputSchema.parse(await copy.clone().json())
        proof.cancellationPosts++
      }
      if (request.method === 'GET' && target.pathname === path) proof.currentCancellationGets++
      if (request.method === 'GET' && target.pathname.startsWith(path + '/commands/')) {
        assert(
          committedKey && target.pathname === path + '/commands/' + committedKey,
          'Lookup must use the committed original key'
        )
        proof.receiptGets++
      }
      const response = await input.dispatch(request)
      if (command && response.status === 200) {
        const receipt = orderCancellationReceiptSchema.parse(await response.clone().json())
        assert.equal(receipt.orderId, input.orderId)
        assert.equal(receipt.commandId, commandId)
        await input.readCommittedCancellation({
          orderId: input.orderId,
          commandId: commandId!,
          body: body!,
          receipt,
          request: copy
        })
        committedKey = commandId
        proof.lostResponses++
        return { action: 'abort', reason: 'lost_cancellation_response' }
      }
      return { action: 'fulfill', response }
    }
  }
}
export const ORDER_OPERATIONS_BROWSER_SCENARIOS = [
  'native_order_operations_compiled_workbench_filters_and_detail_desktop',
  'native_order_operations_compiled_customer_cancel_receipt_recovery_desktop',
  'native_order_operations_compiled_workbench_filters_and_detail_mobile',
  'native_order_operations_compiled_customer_cancel_receipt_recovery_mobile'
] as const
function workbenchFixture(raw: unknown): OrderOperationsWorkbenchFixture {
  const schema = z
    .object({
      adminCookie: z.string(),
      otherActorCookie: z.string(),
      orderIds: z.array(z.string().regex(UUID)).length(26),
      query: z.string().trim().min(1).max(120),
      eligibleOrderIds: z.array(z.string().regex(UUID)).length(2),
      blockedOrderId: z.string().regex(UUID)
    })
    .strict()
  const parsed = schema.safeParse(raw)
  assert(parsed.success, 'workbench_fixture: exactly26 bounded synthetic orders required')
  const fixture = parsed.data
  const firstPage = [...fixture.orderIds].sort().slice(0, 25)
  assert(
    new Set(fixture.orderIds).size === 26 &&
      new Set(fixture.eligibleOrderIds).size === 2 &&
      fixture.eligibleOrderIds.every((id) => firstPage.includes(id)) &&
      firstPage.includes(fixture.blockedOrderId) &&
      !fixture.eligibleOrderIds.includes(fixture.blockedOrderId) &&
      [...fixture.query].every((character) => {
        const code = character.codePointAt(0)!
        return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x2028 && code !== 0x2029
      }),
    'workbench_fixture: distinct eligible and blocked IDs must belong to the first25 live orders'
  )
  assert(
    sessionCookie(fixture.adminCookie) !== sessionCookie(fixture.otherActorCookie),
    'workbench_fixture: independent actors required'
  )
  return fixture
}
const workbenchPageSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(z.object({ id: z.string().regex(UUID) }).passthrough()).max(25),
    pagination: z
      .object({
        page: z.number().int().positive(),
        perPage: z.literal(25),
        total: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        mode: z.literal('cursor'),
        nextCursor: z.string().min(1).nullable(),
        previousCursor: z.string().min(1).nullable()
      })
      .strict()
  })
  .passthrough()
async function workbenchEconomicDigest(database: D1Database, ids: string[]) {
  assert(ids.length === 26 && new Set(ids).size === 26)
  const selected = 'SELECT value FROM json_each(?1)'
  const variants = `SELECT DISTINCT variant_id FROM order_lines WHERE order_id IN(${selected})`
  const reservations = `SELECT reservation_id FROM orders WHERE id IN(${selected})`
  const queries = [
    // Global hydration may create an unrelated empty cart. Every contractual
    // checkout cart and its lines must remain byte-identical nevertheless.
    `SELECT * FROM carts WHERE id IN(SELECT cart_id FROM orders WHERE id IN(${selected})) ORDER BY id`,
    `SELECT * FROM cart_lines WHERE cart_id IN(SELECT cart_id FROM orders WHERE id IN(${selected})) ORDER BY cart_id,variant_id`,
    `SELECT * FROM orders WHERE id IN(${selected}) ORDER BY id`,
    `SELECT * FROM order_lines WHERE order_id IN(${selected}) ORDER BY order_id,line_index`,
    `SELECT * FROM order_shipping_address WHERE order_id IN(${selected}) ORDER BY order_id`,
    `SELECT * FROM order_payment_states WHERE order_id IN(${selected}) ORDER BY order_id`,
    `SELECT * FROM payment_intents WHERE order_id IN(${selected}) ORDER BY id`,
    `SELECT * FROM payment_events WHERE payment_intent_id IN(SELECT id FROM payment_intents WHERE order_id IN(${selected})) ORDER BY id`,
    `SELECT * FROM inventory_balances WHERE variant_id IN(${variants}) ORDER BY variant_id,location_id`,
    `SELECT * FROM inventory_movements WHERE variant_id IN(${variants}) ORDER BY id`,
    `SELECT * FROM inventory_reservations WHERE id IN(${reservations}) ORDER BY id`,
    `SELECT * FROM inventory_reservation_lines WHERE reservation_id IN(${reservations}) ORDER BY reservation_id,variant_id,location_id`,
    `SELECT * FROM fiscal_documents WHERE order_id IN(${selected}) ORDER BY id`,
    `SELECT * FROM refund_contracts WHERE order_id IN(${selected}) ORDER BY id`,
    `SELECT * FROM fiscal_credit_contracts WHERE order_id IN(${selected}) ORDER BY id`
  ]
  const rows = await database.batch(queries.map((sql) => database.prepare(sql).bind(JSON.stringify(ids))))
  assert.equal(rows.length, queries.length)
  for (const row of rows) {
    assert.equal(row.success, true)
    assert.equal(row.meta.rows_written, 0)
    assert(Array.isArray(row.results) && row.results.length <= 10000, 'Bounded workbench domain read required')
  }
  return createHash('sha256')
    .update(JSON.stringify(rows.map((row) => row.results)))
    .digest('hex')
}
async function runIntegralWorkbench(
  input: NativeOrderOperationsBrowserInput,
  browser: Awaited<ReturnType<typeof connectRemoteTestBrowser>>,
  viewport: { name: 'desktop' | 'mobile'; width: number; height: number },
  fixture: OrderOperationsWorkbenchFixture
) {
  assert(input.database, 'Caller-owned actual D1 required for workbench invariants')
  const database = input.database,
    base = '/api/admin/orders/bulk-fulfillment',
    views = '/api/admin/order-views'
  const selected = [...fixture.eligibleOrderIds, fixture.blockedOrderId]
  const before = await workbenchEconomicDigest(database, fixture.orderIds)
  let requests = 0,
    pageErrors = 0,
    bulkResponseStatus: number | null = null,
    transportFailure: unknown = null,
    savedViewId: string | null = null
  const durable: { committed: OrderOperationsBulkProof | null } = { committed: null }
  let holdNextQueue = false,
    releaseHeld: (() => void) | null = null,
    heldObserved = false,
    revoked = false
  const queueReads: Array<{ query: URLSearchParams; body: z.infer<typeof workbenchPageSchema> }> = []
  const contexts: BrowserContext[] = []
  const dispatch = async (request: Request) => {
    requests++
    const response = await input.dispatch(request)
    if (request.method === 'POST' && new URL(request.url).pathname === base + '/commands')
      bulkResponseStatus = response.status
    return response
  }
  async function read(path: string, cookie = fixture.adminCookie) {
    return dispatch(
      new Request(input.origin + path, {
        headers: { cookie, 'cf-connecting-ip': '192.0.2.165', 'cache-control': 'no-store' }
      })
    )
  }
  const bridge = createWorkbenchBrowserBridge({
    origin: input.origin,
    dispatch,
    bulk: {
      adminCookie: fixture.adminCookie,
      orderIds: selected,
      async readCommittedBulk(proof) {
        const response = await read(`${base}/commands/${proof.commandId}?payloadHash=${proof.receipt.payloadHash}`)
        assert.equal(response.status, 200)
        const command = adminOrderBulkCommandSchema.parse(await response.json())
        assert.equal(command.outcome, 'applied')
        if (command.outcome === 'applied') assert.deepEqual(command.receipt, proof.receipt)
        const freshResponse = await read(`${base}/${proof.receipt.groupId}`)
        assert.equal(freshResponse.status, 200)
        const fresh = adminOrderBulkGroupSchema.parse(await freshResponse.json())
        assert.equal(fresh.commandId, proof.commandId)
        assert.equal(fresh.payloadHash, proof.receipt.payloadHash)
        assert.equal(fresh.dispatchId, proof.receipt.dispatchId)
        assert.deepEqual(
          fresh.rows.map((row) => ({ orderId: row.orderId, expectedVersion: row.expectedVersion })),
          proof.body.orders
        )
        const row = await database
          .prepare('SELECT dispatch_id,command_id,payload_hash,receipt_json FROM admin_order_bulk_groups WHERE id=?1')
          .bind(proof.receipt.groupId)
          .first<{ dispatch_id: string; command_id: string; payload_hash: string; receipt_json: string }>()
        assert(row)
        assert.equal(row.dispatch_id, proof.receipt.dispatchId)
        assert.equal(row.command_id, proof.commandId)
        assert.equal(row.payload_hash, proof.receipt.payloadHash)
        assert.deepEqual(JSON.parse(row.receipt_json), proof.receipt)
        await input.readCommittedBulk?.(proof)
        durable.committed = proof
      },
      async consumeBulkQueue(message) {
        assert(
          durable.committed &&
            durable.committed.receipt.groupId === message.groupId &&
            durable.committed.receipt.dispatchId === message.dispatchId
        )
        await input.consumeBulkQueue!(message)
      }
    }
  })
  async function pageFor(cookie: string, foreign = false) {
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
      const incoming = route.request(),
        target = new URL(incoming.url())
      let intentionallyHeld = false
      try {
        if (target.origin !== input.origin) {
          bridge.proof.blockedExternal++
          await route.abort('blockedbyclient')
          return
        }
        const headers = await incoming.allHeaders()
        headers['cf-connecting-ip'] = '192.0.2.165'
        headers['accept-encoding'] = 'identity'
        const payload = incoming.postDataBuffer()
        const request = new Request(target, {
          method: incoming.method(),
          headers,
          ...(payload ? { body: Uint8Array.from(payload).buffer } : {}),
          redirect: 'manual'
        })
        let outcome: ForwardResult
        if (foreign) {
          const allowed = allowsOrderOperationsForeignRead(request, {
            origin: input.origin,
            savedViewId,
            groupId: durable.committed?.receipt.groupId,
            commandId: durable.committed?.commandId
          })
          if (!allowed)
            console.error(
              JSON.stringify({
                audit: 'order_operations_foreign_read_boundary',
                ...foreignOrderReadDiagnostic(request)
              })
            )
          assert(allowed, 'Foreign context is read-only and path-bounded')
          outcome = { action: 'fulfill', response: await dispatch(request) }
        } else outcome = await bridge.forward(request)
        if (outcome.action === 'abort') {
          await route.abort('failed')
          return
        }
        const response = outcome.response
        if (!foreign && target.pathname === '/api/admin/orders' && response.status === 200) {
          const body = workbenchPageSchema.parse(await response.clone().json())
          assert.equal(target.searchParams.get('pagination'), 'cursor')
          assert.equal(target.searchParams.get('perPage'), '25')
          assert.equal(new Set(body.items.map((row) => row.id)).size, body.items.length)
          queueReads.push({ query: new URLSearchParams(target.search), body })
          if (queueReads.length > 20) queueReads.shift()
          if (holdNextQueue) {
            holdNextQueue = false
            intentionallyHeld = true
            await new Promise<void>((resolve) => {
              releaseHeld = resolve
              heldObserved = true
            })
          }
        }
        if (!foreign && target.pathname === '/api/auth/logout' && response.ok) revoked = true
        const forwarded = Object.fromEntries(response.headers)
        delete forwarded['content-encoding']
        delete forwarded['content-length']
        await route.fulfill({
          status: response.status,
          headers: forwarded,
          body: Buffer.from(await response.arrayBuffer())
        })
      } catch (error) {
        // A real navigation after logout may cancel the held old-scope GET.
        // Only that intentionally held queue response may be discarded safely.
        if (!(revoked && intentionallyHeld)) transportFailure = error
        await route.abort('failed').catch(() => {})
      }
    })
    const page = await context.newPage()
    page.on('pageerror', () => {
      pageErrors++
    })
    return page
  }
  try {
    const page = await pageFor(fixture.adminCookie)
    await page.goto(input.origin + '/admin/pedidos', { waitUntil: 'networkidle', timeout: 30000 })
    const workbench = page.getByRole('region', { name: 'Banco de preparación de pedidos' })
    await expect(workbench.locator('[data-wb-query]')).toBeEnabled({ timeout: 15000 })
    const originalReads = queueReads.length
    await workbench.locator('[data-wb-query]').fill(fixture.query)
    await workbench.locator('[data-wb-sort]').selectOption('id')
    await workbench.locator('[data-wb-direction]').selectOption('asc')
    assert.equal(queueReads.length, originalReads, 'Draft filters/sort must not fetch')
    async function applyFixture() {
      const response = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname === '/api/admin/orders' &&
          url.searchParams.get('q') === fixture.query &&
          url.searchParams.get('page') === '1'
        )
      })
      await workbench.locator('[data-wb-apply]').click()
      assert.equal((await response).status(), 200)
      await expect(workbench.locator('table tbody tr')).toHaveCount(25)
      return workbenchPageSchema.parse(await (await response).json())
    }
    const first = await applyFixture(),
      canonical = [...fixture.orderIds].sort()
    assert.deepEqual(
      first.items.map((row) => row.id),
      canonical.slice(0, 25)
    )
    assert.equal(first.pagination.total, 26)
    assert.equal(first.pagination.pages, 2)
    assert(first.pagination.nextCursor)
    assert.equal(first.pagination.previousCursor, null)
    await workbench.locator('[data-wb-select-page]').check()
    await expect(workbench.locator('[data-wb-selection-count]')).toContainText('25 pedidos seleccionados')
    await expect(workbench.locator('[data-wb-select-order]:checked')).toHaveCount(25)
    assert.equal(bridge.proof.bulkPosts, 0)
    const next = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/admin/orders' && url.searchParams.get('after') === first.pagination.nextCursor
    })
    await workbench.locator('[data-wb-next]').click()
    assert.equal((await next).status(), 200)
    const second = workbenchPageSchema.parse(await (await next).json())
    assert.deepEqual(
      second.items.map((row) => row.id),
      canonical.slice(25)
    )
    assert(second.pagination.previousCursor)
    await expect(workbench.locator('table tbody tr')).toHaveCount(1)
    await expect(workbench.locator('[data-wb-selection-count]')).toHaveCount(0)
    await expect(workbench.locator('[data-batch-preview]')).toHaveCount(0)
    const previous = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/admin/orders' && url.searchParams.get('before') === second.pagination.previousCursor
    })
    await workbench.locator('[data-wb-previous]').click()
    assert.equal((await previous).status(), 200)
    assert.deepEqual(
      workbenchPageSchema.parse(await (await previous).json()).items.map((row) => row.id),
      canonical.slice(0, 25)
    )
    await expect(workbench.locator('table tbody tr')).toHaveCount(25)
    await workbench.locator(`[data-wb-select-order="${canonical[0]}"]`).check()
    const beforeDraft = queueReads.length
    await workbench.locator('[data-wb-query]').fill(fixture.query + ' draft')
    await expect(workbench.locator('[data-wb-selection-count]')).toHaveCount(0)
    assert.equal(queueReads.length, beforeDraft)
    await workbench.locator('[data-wb-query]').fill(fixture.query)
    for (const column of ['createdAt', 'customer', 'paymentStatus', 'shippingMethod', 'invoiceStatus'])
      await workbench.locator(`[data-wb-column="${column}"]`).uncheck()
    await expect(workbench.locator('thead th')).toHaveText([
      'Selección',
      'Pedido',
      'Total',
      'Estado de preparación',
      'Preparación'
    ])
    await expect(workbench.locator('tbody a[href^="/admin/pedidos/"]')).toHaveCount(25)
    await workbench.locator('[data-views-refresh]').click()
    const viewName = `Synthetic private workbench ${viewport.name}`
    await workbench.locator('[data-views-name]').fill(viewName)
    assert.equal(bridge.proof.viewPosts, 0)
    const viewResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === views && response.request().method() === 'POST'
    )
    await workbench.locator('[data-views-create]').click()
    assert.equal((await viewResponse).status(), 201)
    const saved = adminOrderViewReceiptSchema.parse(await (await viewResponse).json())
    savedViewId = saved.viewId
    await expect(workbench.locator('[data-views-confirmed]')).toBeVisible({ timeout: 15000 })
    assert.equal(bridge.proof.viewPosts, 1)
    assert(bridge.proof.viewDetailGets >= 1)
    assert(bridge.proof.viewListGets >= 2)
    const savedResponse = await read(views + '/' + saved.viewId)
    assert.equal(savedResponse.status, 200)
    const savedDefinition = adminOrderViewDetailSchema.parse(await savedResponse.json()).view.definition
    const savedListResponse = await read(views)
    assert.equal(savedListResponse.status, 200)
    const savedList = adminOrderViewListSchema.parse(await savedListResponse.json())
    assert.deepEqual(savedList.items.find((view) => view.id === saved.viewId)?.definition, savedDefinition)
    assert.deepEqual(savedDefinition.columns, ['total', 'fulfillmentStatus'])
    for (const key of ['q', 'page', 'perPage', 'pagination', 'after', 'before', 'orderIds', 'selection'])
      assert(!(key in savedDefinition))
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
    await expect(workbench.locator('[data-wb-query]')).toBeEnabled({ timeout: 15000 })
    await workbench.locator('[data-views-refresh]').click()
    await expect(workbench.locator('[data-views-select] option[value="' + saved.viewId + '"]').first()).toHaveCount(1)
    await workbench.locator('[data-views-select]').selectOption(saved.viewId)
    await expect(workbench.locator('[data-views-apply]')).toBeEnabled({ timeout: 15000 })
    await workbench.locator('[data-wb-select-page]').check()
    const beforeViewApply = queueReads.length
    const applied = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/admin/orders' && url.searchParams.get('q') === ''
    })
    await workbench.locator('[data-views-apply]').click()
    assert.equal((await applied).status(), 200)
    await expect.poll(() => queueReads.length).toBe(beforeViewApply + 1)
    assert.equal(queueReads.at(-1)!.body.pagination.page, 1)
    await expect(workbench.locator('[data-wb-query]')).toHaveValue('')
    await expect(workbench.locator('[data-wb-selection-count]')).toHaveCount(0)
    await expect(workbench.locator('thead th')).toHaveText([
      'Selección',
      'Pedido',
      'Total',
      'Estado de preparación',
      'Preparación'
    ])
    assert.equal(bridge.proof.bulkPosts, 0)
    await workbench.locator('[data-wb-query]').fill(fixture.query)
    await applyFixture()
    const exportResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/admin/orders/export.csv'
    )
    const exportDownload = page.waitForEvent('download', { timeout: 30000 })
    await workbench.locator('[data-order-export-download]').click()
    const [exported, download] = await Promise.all([exportResponse, exportDownload])
    assert.equal(exported.status(), 200)
    const exportHeaders = await exported.allHeaders()
    const exportMetadata = orderExportMetadataSchema.parse({
      source: exportHeaders[ORDER_EXPORT_HEADERS.source.toLowerCase()],
      rows: Number(exportHeaders[ORDER_EXPORT_HEADERS.rows.toLowerCase()]),
      bytes: Number(exportHeaders[ORDER_EXPORT_HEADERS.bytes.toLowerCase()])
    })
    assert.equal(exportMetadata.rows, 26)
    // Chromium's protocol may decode text/csv and strip its BOM when Playwright
    // reads Response.body(). Inspect the actual user download, never repair or
    // trust the protocol's text representation of the private CSV.
    assert.equal(download.suggestedFilename(), ORDER_EXPORT_FILENAME)
    assert.equal(await download.failure(), null)
    const exportStream = await download.createReadStream()
    assert(exportStream, 'Actual private CSV download stream required')
    const exportChunks: Buffer[] = []
    let exportBytes = 0
    for await (const chunk of exportStream) {
      const bytes = Buffer.from(chunk)
      exportBytes += bytes.byteLength
      assert(exportBytes <= ORDER_EXPORT_MAX_BYTES)
      exportChunks.push(bytes)
    }
    verifyOrderExportCsv(Buffer.concat(exportChunks), exportMetadata)
    await expect(workbench.locator('[data-order-export-success]')).toContainText('26 pedidos')
    await download.delete()
    const exportQuery = new URL(exported.url()).searchParams
    for (const key of ['page', 'perPage', 'pagination', 'after', 'before']) assert(!exportQuery.has(key))
    for (const id of selected) await workbench.locator(`[data-wb-select-order="${id}"]`).check()
    await expect(workbench.locator('[data-wb-selection-count]')).toContainText('3 pedidos seleccionados')
    await workbench.locator('[data-batch-action]').selectOption('picking')
    await workbench.locator('[data-batch-reason]').fill('Synthetic explicit compiled bulk preparation')
    const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === base + '/preview')
    await workbench.locator('[data-batch-preview]').click()
    assert.equal((await previewResponse).status(), 200)
    const preview = adminOrderBulkPreviewSchema.parse(await (await previewResponse).json())
    assert.equal(preview.eligible, 2)
    assert.equal(preview.blocked, 1)
    assert.deepEqual(
      preview.rows
        .filter((row) => row.eligible)
        .map((row) => row.orderId)
        .sort(),
      [...fixture.eligibleOrderIds].sort()
    )
    assert(preview.rows.some((row) => row.orderId === fixture.blockedOrderId && row.reason === 'payment_unconfirmed'))
    await expect(workbench.locator('[data-batch-review]')).toContainText('2 elegibles')
    await expect(workbench.locator('[data-batch-review]')).toContainText('Pago no confirmado')
    await expect(workbench.locator('[data-batch-confirm]')).toBeDisabled()
    await expect(workbench.locator('[data-wb-query]')).toBeDisabled()
    await expect(workbench.locator('[data-views-apply]')).toBeDisabled()
    await expect(workbench.locator('[data-order-export-download]')).toHaveCount(0)
    await workbench.locator('[data-batch-consent]').check()
    await workbench.locator('[data-batch-confirm]').click()
    // The intent container also exists while the POST is still in flight. Wait
    // for confirmed uncertainty and the manual recovery barrier, not mere DOM
    // presence, before inspecting the completed fault-injection proof.
    await expect(workbench.locator('[data-batch-uncertain]')).toContainText(
      'El resultado no está confirmado por completo.',
      { timeout: 15000 }
    )
    await expect(workbench.locator('[data-batch-recover]')).toBeEnabled({ timeout: 15000 })
    // A deliberately lost response is valid only after durable proof succeeds.
    // Surface an earlier bridge failure before its secondary counter assertion.
    if (transportFailure !== null) throw transportFailure
    assert.equal(bulkResponseStatus, 201)
    assert.equal(bridge.proof.bulkPosts, 1)
    assert.equal(bridge.proof.bulkLostResponses, 1)
    assert.equal(bridge.proof.bulkReceiptGets, 0)
    assert.equal(bridge.proof.bulkGroupGets, 0)
    await expect(workbench.locator('[data-wb-select-page]')).toBeDisabled()
    await workbench.locator('[data-batch-recover]').click()
    await expect(workbench.locator('[data-batch-results]')).toBeVisible({ timeout: 15000 })
    await expect(workbench.locator('[data-batch-uncertain]')).toHaveCount(0)
    await expect(workbench.locator('[data-batch-confirm]')).toHaveCount(0)
    assert.equal(bridge.proof.bulkPosts, 1)
    assert.equal(bridge.proof.bulkReceiptGets, 1)
    assert.equal(bridge.proof.bulkGroupGets, 1)
    const committed = durable.committed
    assert(committed)
    const finalResponse = await read(base + '/' + committed.receipt.groupId)
    assert.equal(finalResponse.status, 200)
    const final = adminOrderBulkGroupSchema.parse(await finalResponse.json())
    assert.equal(final.status, 'completed')
    assert.equal(final.remaining, 0)
    assert.deepEqual(
      final.rows
        .filter((row) => row.status === 'applied')
        .map((row) => row.orderId)
        .sort(),
      [...fixture.eligibleOrderIds].sort()
    )
    assert(
      final.rows.some(
        (row) =>
          row.orderId === fixture.blockedOrderId &&
          row.status === 'not_attempted' &&
          row.reason === 'payment_unconfirmed'
      )
    )
    for (const row of final.rows) {
      const commands = await database
        .prepare(
          'SELECT c.id FROM order_fulfillment_commands c JOIN order_fulfillment_audit a ON a.command_id=c.id WHERE c.order_id=?1 AND c.idempotency_key=?2 AND a.response=c.response'
        )
        .bind(row.orderId, row.childKey)
        .all<{ id: string }>()
      assert.equal(commands.success, true)
      assert.equal(commands.results.length, row.status === 'applied' ? 1 : 0)
      if (row.status === 'applied') assert.equal(commands.results[0]!.id, row.receipt!.commandId)
    }
    assert.equal(
      await workbenchEconomicDigest(database, fixture.orderIds),
      before,
      'Bulk preparation must not change orders, money, stock, reservations, fiscal or refund facts'
    )
    const foreign = await pageFor(fixture.otherActorCookie, true)
    await foreign.goto(input.origin + '/admin/pedidos', { waitUntil: 'networkidle', timeout: 30000 })
    const privatePaths = [
      views + '/' + saved.viewId,
      base + '/' + committed.receipt.groupId,
      base + '/commands/' + committed.commandId + '?payloadHash=' + committed.receipt.payloadHash
    ]
    const denied = await foreign.evaluate(
      async (paths) =>
        Promise.all(
          paths.map(async (path) => {
            const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
            return { status: response.status, body: await response.json() }
          })
        ),
      privatePaths
    )
    assert.equal(denied[0]!.status, 404)
    assert.equal(denied[1]!.status, 404)
    assert.equal(denied[2]!.status, 200)
    assert.deepEqual(denied[2]!.body, { source: 'cloudflare', outcome: 'unknown', receipt: null })
    assert(!JSON.stringify(denied).includes(viewName))
    assert.equal(
      await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
      false,
      'Integral workbench overflow'
    )
    await expect(workbench.locator('[data-wb-query]')).toBeEnabled()
    holdNextQueue = true
    await workbench.locator('[data-wb-apply]').click()
    await expect.poll(() => heldObserved, { timeout: 15000 }).toBe(true)
    const logoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/logout')
    await page.locator('header button').filter({ hasText: 'Salir' }).click()
    assert.equal((await logoutResponse).status(), 200)
    const release = releaseHeld as (() => void) | null
    release?.()
    releaseHeld = null
    await page.waitForURL(input.origin + '/', { timeout: 15000 })
    await expect(page.locator('[data-wb-selection-count],[data-batch-results],[data-views-name]')).toHaveCount(0)
    const publicText = await page.locator('body').textContent()
    assert(
      !publicText?.includes(fixture.query) &&
        !publicText?.includes(viewName) &&
        selected.every((id) => !publicText?.includes(id))
    )
    const expired = await read('/api/admin/orders?pagination=cursor')
    assert.equal(expired.status, 401, 'Logout must revoke the actual old session, not merely hide UI')
    assert.equal(bridge.proof.logoutPosts, 1)
    assert.equal(bridge.proof.blockedExternal, 0)
    assert.equal(bridge.proof.blockedWrites, 0)
    assert.equal(pageErrors, 0)
    assert.equal(transportFailure, null)
    assert.equal(
      await workbenchEconomicDigest(database, fixture.orderIds),
      before,
      'Foreign bootstrap and logout must preserve contractual carts, orders, money and stock'
    )
    return {
      requests,
      pageErrors,
      bulkPosts: bridge.proof.bulkPosts,
      bulkLostResponses: bridge.proof.bulkLostResponses,
      bulkReceiptGets: bridge.proof.bulkReceiptGets,
      bulkGroupGets: bridge.proof.bulkGroupGets,
      viewPosts: bridge.proof.viewPosts,
      paginationOrders: 26,
      selectionLimit: 25,
      applied: 2,
      notAttempted: 1,
      foreignDenied: true,
      revocationPurged: true
    }
  } finally {
    const release = releaseHeld as (() => void) | null
    release?.()
    for (const context of contexts) await context.close()
  }
}
export interface NativeOrderOperationsBrowserInput {
  origin: string
  adminCookie: string
  dispatch: (request: Request) => Promise<Response>
  prepareUnpaidOrder: (viewport: 'desktop' | 'mobile') => Promise<{ orderId: string; ownerCookie: string }>
  database?: D1Database
  prepareWorkbench?: (viewport: 'desktop' | 'mobile') => Promise<OrderOperationsWorkbenchFixture>
  consumeBulkQueue?: (message: { groupId: string; dispatchId: string }) => Promise<void>
  readCommittedBulk?: (proof: OrderOperationsBulkProof) => Promise<void>
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}
/** Connect-only private compiled browser. Every viewport requires26 actual
 * matching orders and the caller's compiled queue, never a browser fake/executor. */
export async function auditNativeOrderOperationsBrowser(input: NativeOrderOperationsBrowserInput) {
  isolatedOrigin(input.origin)
  sessionCookie(input.adminCookie)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  const baseResult = {
    syntheticSessionOnly: true,
    providerSubmission: false,
    productionBrowserAcceptance: false
  }
  if (input.browserMode === 'not-run')
    return {
      ...baseResult,
      paginationAcceptance: 'not_run' as const,
      scenarios: 0,
      browserStatus: 'not_run' as const,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      engine: null,
      transport: null,
      requests: null,
      pageErrors: null,
      blockedExternal: null,
      blockedWrites: null,
      cancellationPosts: null,
      annotationPosts: null,
      annotationLostResponses: null,
      annotationReceiptGets: null,
      lostResponses: null,
      receiptGets: null,
      viewports: []
    }
  assert(typeof input.prepareWorkbench === 'function', 'prepareWorkbench callback is required')
  assert(typeof input.consumeBulkQueue === 'function', 'consumeBulkQueue callback is required')
  const browser = await connectRemoteTestBrowser(chromium)
  const workbenchResults: Array<Awaited<ReturnType<typeof runIntegralWorkbench>>> = []
  let requests = 0,
    pageErrors = 0,
    blockedExternal = 0,
    blockedWrites = 0,
    cancellationPosts = 0,
    lostResponses = 0,
    receiptGets = 0,
    annotationPosts = 0,
    annotationLostResponses = 0,
    annotationReceiptGets = 0
  try {
    for (const [index, viewport] of (
      [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ] as const
    ).entries()) {
      const workbenchPrepared = workbenchFixture(await input.prepareWorkbench!(viewport.name))
      const workbenchResult = await runIntegralWorkbench(input, browser, viewport, workbenchPrepared)
      workbenchResults.push(workbenchResult)
      requests += workbenchResult.requests
      pageErrors += workbenchResult.pageErrors
      const prepared = await input.prepareUnpaidOrder(viewport.name)
      assert(UUID.test(prepared.orderId))
      sessionCookie(prepared.ownerCookie)
      const orderId = prepared.orderId
      const privateNote = `Nota administrativa sintética local ${viewport.name}`
      const privateLabel = `Etiqueta privada ${viewport.name}`
      const readAdmin = async (path: string) => {
        requests++
        const response = await input.dispatch(
          new Request(input.origin + path, {
            headers: { cookie: input.adminCookie, 'cf-connecting-ip': '192.0.2.165', 'cache-control': 'no-store' }
          })
        )
        assert.equal(response.status, 200)
        assert.match(response.headers.get('cache-control') ?? '', /no-store/)
        return response.json() as Promise<unknown>
      }
      const sourceBefore = await readAdmin(`/api/admin/orders/${orderId}/detail`)
      const annotationsBridge = createOrderAnnotationsBrowserBridge({
        origin: input.origin,
        orderId,
        adminCookie: input.adminCookie,
        dispatch: input.dispatch,
        async readCommittedAnnotations(proof) {
          const command = orderAnnotationCommandSchema.parse(
            await readAdmin(`/api/admin/orders/${orderId}/annotations/commands/${proof.commandId}`)
          )
          assert.equal(command.outcome, 'applied')
          assert.equal(command.orderId, orderId)
          assert.equal(command.commandId, proof.commandId)
          assert.deepEqual(command.receipt, proof.receipt)
          const current = orderAnnotationsResponseSchema.parse(
            await readAdmin(`/api/admin/orders/${orderId}/annotations?limit=20`)
          )
          assert.equal(current.orderId, orderId)
          assert.equal(current.version, proof.receipt.version)
          assert.deepEqual(current.labels, proof.receipt.labels)
          assert(
            current.notes.some(
              (note) =>
                note.id === proof.receipt.noteId &&
                note.text === proof.body.note &&
                note.createdAt === proof.receipt.createdAt
            )
          )
          assert.deepEqual(
            await readAdmin(`/api/admin/orders/${orderId}/detail`),
            sourceBefore,
            'Annotation must not alter order/payment/inventory snapshot APIs'
          )
        }
      })
      let queueReads = 0,
        listReads = 0,
        lineReads = 0,
        timelineReads = 0,
        transportFailure: unknown = null
      const contexts: BrowserContext[] = []
      const diagnosticResponses: Array<{ path: string; status: number }> = []
      const bridge = createOrderOperationsBrowserBridge({
        origin: input.origin,
        orderId,
        dispatch: input.dispatch,
        async readCommittedCancellation(proof) {
          const read = async (path: string) => {
            requests++
            const response = await input.dispatch(
              new Request(input.origin + path, {
                headers: {
                  cookie: prepared.ownerCookie,
                  'cf-connecting-ip': '192.0.2.165',
                  'cache-control': 'no-store'
                }
              })
            )
            assert.equal(response.status, 200)
            assert.match(response.headers.get('cache-control') ?? '', /no-store/)
            return response.json() as Promise<unknown>
          }
          const receipt = orderCancellationReceiptSchema.parse(
            await read(`/api/orders/${orderId}/cancellation/commands/${proof.commandId}`)
          )
          assert.deepEqual(receipt, proof.receipt)
          const current = orderCancellationEligibilitySchema.parse(await read(`/api/orders/${orderId}/cancellation`))
          assert.equal(current.orderId, orderId)
          assert.equal(current.orderStatus, 'cancelled')
          assert.equal(current.eligible, false)
          assert.equal(current.blocker, 'order_not_awaiting_payment')
        }
      })
      async function pageFor(cookie: string, customer: boolean): Promise<Page> {
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
            if (target.origin !== input.origin) {
              blockedExternal++
              await route.abort('blockedbyclient')
              return
            }
            requests++
            const headers = await incoming.allHeaders()
            headers['cf-connecting-ip'] = '192.0.2.165'
            headers['accept-encoding'] = 'identity'
            const payload = incoming.postDataBuffer()
            const request = new Request(target, {
              method: incoming.method(),
              headers,
              ...(payload ? { body: Uint8Array.from(payload).buffer } : {}),
              redirect: 'manual'
            })
            const outcome: ForwardResult = customer
              ? await bridge.forward(request)
              : await annotationsBridge.forward(request)
            if (outcome.action === 'abort') {
              await route.abort('failed')
              return
            }
            const response = outcome.response
            if (!customer) {
              diagnosticResponses.push({ path: target.pathname, status: response.status })
              if (diagnosticResponses.length > 40) diagnosticResponses.shift()
            }
            if (customer && response.headers.get('content-type')?.includes('application/json')) {
              const data = JSON.stringify(await response.clone().json())
              assert(
                !data.includes(privateNote) && !data.includes(privateLabel),
                'Customer API must not expose private admin annotations'
              )
            }
            if (target.pathname === '/api/admin/orders') queueReads++
            if (target.pathname === '/api/orders') listReads++
            if (target.pathname === `/api/orders/${orderId}/lines`) lineReads++
            if (target.pathname === `/api/orders/${orderId}/timeline`) timelineReads++
            const forwarded = Object.fromEntries(response.headers)
            delete forwarded['content-encoding']
            delete forwarded['content-length']
            // Exact real Worker bytes, NOT a fabricated route/API fixture.
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
        page.on('pageerror', () => {
          pageErrors++
        })
        return page
      }
      try {
        const admin = await pageFor(input.adminCookie, false)
        await admin.goto(input.origin + '/admin/pedidos', { waitUntil: 'networkidle', timeout: 30000 })
        const workbench = admin.getByRole('region', { name: 'Banco de preparación de pedidos' })
        await expect(workbench.locator('[data-wb-query]')).toBeEnabled({ timeout: 15000 })
        const beforeFilter = queueReads
        await workbench.locator('[data-wb-query]').fill(orderId)
        await workbench.locator('[data-wb-sort]').selectOption('id')
        await workbench.locator('[data-wb-direction]').selectOption('asc')
        assert.equal(queueReads, beforeFilter, 'Typing and sorting must not auto-query')
        const applied = admin.waitForResponse((response) => {
          const url = new URL(response.url())
          return (
            url.pathname === '/api/admin/orders' &&
            url.searchParams.get('q') === orderId &&
            url.searchParams.get('sortKey') === 'id' &&
            url.searchParams.get('sortDir') === 'asc'
          )
        })
        await workbench.locator('[data-wb-apply]').click()
        assert.equal((await applied).status(), 200)
        await expect(workbench.locator('[data-wb-open]')).toHaveCount(1)
        await workbench.locator('[data-wb-open]').click()
        await expect(workbench.locator('[data-testid="fulfillment-action"]')).toHaveCount(0)
        await expect(workbench.getByText('Pago capturado no confirmado', { exact: false })).toBeVisible()
        await workbench.locator(`a[href="/admin/pedidos/${orderId}"]`).click()
        await awaitOrderOperationsHistory({
          origin: input.origin,
          orderId,
          viewport: viewport.name,
          responses: diagnosticResponses,
          wait: async () => {
            await expect(admin.getByRole('heading', { name: 'Historial del pedido', exact: true })).toBeVisible({
              timeout: 15000
            })
          },
          url: () => admin.url(),
          count: async (key) => {
            if (key === 'historyHeading')
              return admin.getByRole('heading', { name: 'Historial del pedido', exact: true }).count()
            const selectors = {
              timelineItems: '[data-timeline-item]',
              annotationInputs: '[data-annotations-note]',
              loginInputs: 'input[autocomplete="email"]',
              detailHeading: 'main h1'
            }
            return admin.locator(selectors[key]).count()
          },
          screenshot: async (path) => {
            await mkdir(resolve('test-results/.artifacts/order-operations-browser'), { recursive: true, mode: 0o700 })
            await admin.screenshot({ path: resolve(path), fullPage: true })
          }
        })
        await expect(admin.locator('[data-timeline-item]').filter({ hasText: 'Pedido registrado' })).toBeVisible()
        await expect(admin.locator('[data-annotations-note]')).toBeEnabled({ timeout: 15000 })
        await admin.locator('[data-annotations-note]').fill(privateNote)
        await admin.locator('[data-annotations-labels]').fill(privateLabel)
        assert.equal(annotationsBridge.proof.annotationPosts, 0, 'Editing metadata must never send a command')
        await admin.locator('[data-annotations-labels]').focus()
        await admin.keyboard.press('Tab')
        await expect(admin.locator('[data-annotations-submit]')).toBeFocused()
        const annotationsBefore = annotationsBridge.proof.currentGets
        await admin.keyboard.press('Enter')
        await expect(admin.locator('[data-annotations-unknown]')).toBeVisible({ timeout: 15000 })
        assert.equal(annotationsBridge.proof.annotationPosts, 1)
        assert.equal(annotationsBridge.proof.lostResponses, 1)
        await admin.locator('[data-annotations-check]').focus()
        await admin.keyboard.press('Enter')
        await expect(admin.locator('[data-annotations-confirmed]')).toBeVisible({ timeout: 15000 })
        await expect(admin.getByText(privateNote, { exact: true })).toBeVisible()
        await expect(admin.getByText(privateLabel, { exact: true })).toBeVisible()
        assert.equal(annotationsBridge.proof.annotationPosts, 1, 'Manual metadata recovery must not POST again')
        assert.equal(annotationsBridge.proof.receiptGets, 1)
        assert(annotationsBridge.proof.currentGets > annotationsBefore)
        assert.equal(annotationsBridge.proof.blockedWrites, 0)
        assert.equal(annotationsBridge.proof.blockedExternal, 0)
        assert.equal(
          await admin.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
          false,
          'Workbench/detail overflow'
        )
        assert.equal(transportFailure, null, 'Real transport read failed')
        input.scenario?.(ORDER_OPERATIONS_BROWSER_SCENARIOS[index * 2]!)
        const customer = await pageFor(prepared.ownerCookie, true)
        await customer.goto(input.origin + '/cuenta/pedidos', { waitUntil: 'networkidle', timeout: 30000 })
        await expect(
          customer.locator('[data-annotations-note], [data-annotations-labels], [data-annotations-submit]')
        ).toHaveCount(0)
        const customerText = await customer.locator('body').textContent()
        assert(!customerText?.includes(privateNote) && !customerText?.includes(privateLabel))
        const row = customer.locator('article').filter({ hasText: orderId })
        await expect(row).toHaveCount(1)
        if ((await row.locator('button[aria-expanded]').getAttribute('aria-expanded')) !== 'true')
          await row.locator('button[aria-expanded]').click()
        const reason = row.getByLabel('Motivo de cancelación', { exact: true })
        await expect(reason).toBeEnabled({ timeout: 15000 })
        await reason.fill('Comprobación sintética local de cancelación sin pago')
        assert.equal(bridge.proof.cancellationPosts, 0, 'Reason entry must never dispatch a command')
        await reason.focus()
        await customer.keyboard.press('Tab')
        await expect(row.locator('[data-cancel-confirm]')).toBeFocused()
        await customer.keyboard.press('Space')
        await customer.keyboard.press('Tab')
        await expect(row.locator('[data-cancel-submit]')).toBeFocused()
        const beforeRecovery = { listReads, lineReads, timelineReads }
        await customer.keyboard.press('Enter')
        await expect(row.locator('[data-cancel-unknown]')).toBeVisible({ timeout: 15000 })
        assert.equal(bridge.proof.cancellationPosts, 1)
        assert.equal(bridge.proof.lostResponses, 1)
        await expect(row.locator('button[aria-expanded]')).toBeDisabled()
        await expect(row.getByRole('button', { name: 'Volver a pedir', exact: true })).toBeDisabled()
        await row.locator('[data-cancel-check]').click()
        await expect.poll(() => listReads).toBeGreaterThan(beforeRecovery.listReads)
        await expect.poll(() => lineReads).toBeGreaterThan(beforeRecovery.lineReads)
        await expect(row.getByText('Cancelado', { exact: true })).toBeVisible()
        if ((await row.locator('button[aria-expanded]').getAttribute('aria-expanded')) !== 'true')
          await row.locator('button[aria-expanded]').click()
        await expect(
          row.locator('[data-timeline-item]').filter({ hasText: 'Cancelación del pedido confirmada' })
        ).toBeVisible({ timeout: 15000 })
        assert(timelineReads > beforeRecovery.timelineReads)
        await expect(row.locator('[data-cancel-unknown]')).toHaveCount(0)
        assert.equal(bridge.proof.cancellationPosts, 1, 'GET recovery must never repeat POST')
        assert.equal(bridge.proof.receiptGets, 1)
        assert(bridge.proof.currentCancellationGets >= 2)
        assert.equal(bridge.proof.blockedWrites, 0)
        assert.equal(bridge.proof.blockedExternal, 0)
        assert.equal(transportFailure, null, 'Real durable readback failed')
        const expandedCustomerText = await customer.locator('body').textContent()
        assert(!expandedCustomerText?.includes(privateNote) && !expandedCustomerText?.includes(privateLabel))
        assert.equal(
          await customer.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1),
          false,
          'Customer cancellation overflow'
        )
        input.scenario?.(ORDER_OPERATIONS_BROWSER_SCENARIOS[index * 2 + 1]!)
        cancellationPosts += bridge.proof.cancellationPosts
        lostResponses += bridge.proof.lostResponses
        receiptGets += bridge.proof.receiptGets
        annotationPosts += annotationsBridge.proof.annotationPosts
        annotationLostResponses += annotationsBridge.proof.lostResponses
        annotationReceiptGets += annotationsBridge.proof.receiptGets
        blockedWrites += annotationsBridge.proof.blockedWrites + bridge.proof.blockedWrites
      } finally {
        for (const context of contexts) await context.close()
      }
    }
    assert.equal(pageErrors, 0)
    assert.equal(blockedExternal, 0)
    assert.equal(blockedWrites, 0)
    return {
      ...baseResult,
      paginationAcceptance: 'real_26_order_fixture_passed' as const,
      workbenchResults,
      scenarios: ORDER_OPERATIONS_BROWSER_SCENARIOS.length,
      browserStatus: 'passed' as const,
      reason: null,
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      requests,
      pageErrors,
      blockedExternal,
      blockedWrites,
      cancellationPosts,
      annotationPosts,
      annotationLostResponses,
      annotationReceiptGets,
      lostResponses,
      receiptGets,
      viewports: ['1440x1000', '390x844']
    }
  } finally {
    await browser.close()
  }
}
