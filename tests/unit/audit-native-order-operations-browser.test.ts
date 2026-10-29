import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, ACTOR, CLAIMS, REASON, utc } from './d1-fulfillment-fixture'
import {
  createD1AdminOrderBulk,
  previewD1AdminOrderBulk,
  readD1AdminOrderBulk,
  readD1AdminOrderBulkCommand
} from '../../workers/fulfillment/bulk'
import { consumeAdminOrderBulkMessage } from '../../workers/fulfillment/bulk-runtime'
import {
  adminOrderBulkIntentHash,
  type AdminOrderBulkCreateInput,
  type AdminOrderBulkReceipt
} from '../../shared/admin-order-bulk'
import {
  auditNativeOrderOperationsBrowser,
  createOrderOperationsBrowserBridge,
  createOrderAnnotationsBrowserBridge,
  awaitOrderOperationsHistory,
  OrderOperationsBrowserDiagnosticError
} from '../../scripts/lib/audit-native-order-operations-browser'

const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'Dedicated private browser unavailable'
}))
const origin = 'https://shop-audit.neteco.test'
const orderId = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222'
const body = { expectedStatus: 'awaiting_payment', reason: 'Synthetic local cancellation acceptance' }
describe('safe diagnostics captured before browser contexts are closed', () => {
  function diagnostic(overrides: Partial<Parameters<typeof awaitOrderOperationsHistory>[0]> = {}) {
    return {
      origin,
      orderId,
      viewport: 'desktop' as const,
      responses: [{ path: `/api/admin/orders/${orderId}/detail?secret=must-not-leak`, status: 200 }],
      wait: vi.fn(async () => {
        throw new Error('PII cookie private raw message')
      }),
      url: () => origin + `/admin/pedidos/${orderId}?token=must-not-leak`,
      count: vi.fn(async () => 1),
      screenshot: vi.fn(async () => {}),
      ...overrides
    }
  }
  it('captures only approved metadata on failure without exposing message/query/cookies', async () => {
    const input = diagnostic()
    const failure = await awaitOrderOperationsHistory(input).catch((error) => error)
    expect(failure).toBeInstanceOf(OrderOperationsBrowserDiagnosticError)
    expect(failure.safeDiagnostic).toMatchObject({
      stage: 'admin_detail_history_heading',
      viewport: 'desktop',
      pathname: `/admin/pedidos/${orderId}`,
      errorClass: 'Error',
      responses: [{ path: `/api/admin/orders/${orderId}/detail`, status: 200 }],
      counts: { historyHeading: 1, timelineItems: 1, annotationInputs: 1, loginInputs: 1, detailHeading: 1 },
      screenshotPath: 'test-results/.artifacts/order-operations-browser/admin-history-desktop.png',
      captureFailed: false
    })
    expect(JSON.stringify(failure)).not.toMatch(/secret|must-not-leak|PII|cookie|raw message/)
    expect(input.screenshot).toHaveBeenCalledTimes(1)
  })
  it('does not collect or capture anything when the existing assertion passes', async () => {
    const input = diagnostic({ wait: async () => {} })
    await awaitOrderOperationsHistory(input)
    expect(input.count).not.toHaveBeenCalled()
    expect(input.screenshot).not.toHaveBeenCalled()
  })
  it.each(['https://provider.invalid/login?secret=x', origin + '/private-person-name?token=x', 'not a url'])(
    'does not report unknown/external URL %s',
    async (url) => {
      const failure = await awaitOrderOperationsHistory(diagnostic({ url: () => url })).catch((error) => error)
      expect(failure.safeDiagnostic.pathname).toBeNull()
    }
  )
  it('keeps only last20 valid known API paths and integer statuses', async () => {
    const responses = [
      { path: '/private-secret?token=x', status: 200 },
      { path: 'https://provider.invalid/api/admin/capabilities', status: 200 },
      { path: '/api/admin/capabilities', status: 999 },
      ...Array.from({ length: 25 }, (_, i) => ({ path: '/api/admin/capabilities?secret=' + i, status: 200 + i }))
    ]
    const failure = await awaitOrderOperationsHistory(diagnostic({ responses })).catch((error) => error)
    expect(failure.safeDiagnostic.responses).toHaveLength(20)
    expect(failure.safeDiagnostic.responses[0]).toEqual({ path: '/api/admin/capabilities', status: 205 })
    expect(JSON.stringify(failure.safeDiagnostic)).not.toMatch(/secret|provider|token/)
  })
  it('records capture failure safely while preserving failure class and other metadata', async () => {
    const input = diagnostic({
      wait: async () => {
        const error = new Error('private')
        error.name = 'TimeoutError'
        throw error
      },
      screenshot: async () => {
        throw new Error('private filesystem path')
      }
    })
    const failure = await awaitOrderOperationsHistory(input).catch((error) => error)
    expect(failure.safeDiagnostic).toMatchObject({
      errorClass: 'TimeoutError',
      screenshotPath: null,
      captureFailed: true,
      pathname: `/admin/pedidos/${orderId}`
    })
  })
  it('bounds invalid DOM counts and does not expose unknown error class', async () => {
    const failure = await awaitOrderOperationsHistory(
      diagnostic({
        wait: async () => {
          throw { name: 'Secret user name' }
        },
        count: async () => Number.NaN
      })
    ).catch((error) => error)
    expect(failure.safeDiagnostic.errorClass).toBe('Other')
    expect(Object.values(failure.safeDiagnostic.counts)).toEqual([null, null, null, null, null])
    expect(failure.safeDiagnostic.captureFailed).toBe(true)
  })
})
const receipt = () => ({
  source: 'cloudflare',
  orderId,
  commandId: key,
  outcome: 'cancelled',
  orderStatus: 'cancelled',
  inventoryEffect: 'released',
  updatedAt: '2026-10-08T12:00:00Z'
})

describe('private admin annotation response-loss boundary inside existing journeys', () => {
  const path = `/api/admin/orders/${orderId}/annotations`
  const annotationBody = {
    expectedVersion: 0,
    note: 'Private synthetic local operations note',
    labels: ['Synthetic local label']
  }
  const annotationReceipt = () => ({
    source: 'cloudflare',
    orderId,
    commandId: key,
    version: 1,
    noteId: '33333333-3333-4333-8333-333333333333',
    labels: annotationBody.labels,
    createdAt: '2026-10-08T12:00:00Z'
  })
  const command = (
    payload: unknown = annotationBody,
    commandId = key,
    target = path,
    cookie = 'neteco-session=synthetic-admin'
  ) =>
    new Request(origin + target, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': commandId },
      body: JSON.stringify(payload)
    })
  function annotations() {
    const events: string[] = []
    const dispatch = vi.fn(async () => {
      events.push('dispatch')
      return Response.json(annotationReceipt())
    })
    const readCommittedAnnotations = vi.fn(async () => {
      events.push('receipt+fresh-state')
    })
    return {
      dispatch,
      events,
      readCommittedAnnotations,
      bridge: createOrderAnnotationsBrowserBridge({
        origin,
        orderId,
        adminCookie: 'neteco-session=synthetic-admin',
        dispatch,
        readCommittedAnnotations
      })
    }
  }
  it('drops real 200 only after exact durable receipt and current annotation readback', async () => {
    const f = annotations()
    expect(await f.bridge.forward(command())).toEqual({ action: 'abort', reason: 'lost_annotations_response' })
    expect(f.events).toEqual(['dispatch', 'receipt+fresh-state'])
    expect(f.bridge.proof).toMatchObject({ annotationPosts: 1, lostResponses: 1 })
    expect(f.readCommittedAnnotations).toHaveBeenCalledWith({
      orderId,
      commandId: key,
      body: annotationBody,
      receipt: annotationReceipt()
    })
  })
  it('claims one command before awaits and never dispatches a concurrent second POST', async () => {
    const f = annotations(),
      results = await Promise.allSettled([f.bridge.forward(command()), f.bridge.forward(command())])
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...annotationReceipt(), orderId: '44444444-4444-4444-8444-444444444444' },
    { ...annotationReceipt(), commandId: '44444444-4444-4444-8444-444444444444' },
    { ...annotationReceipt(), version: 2 },
    { ...annotationReceipt(), labels: [] },
    { ...annotationReceipt(), noteId: null },
    { ...annotationReceipt(), secret: 'private' }
  ])('rejects mismatched receipt before hiding response %#', async (receipt) => {
    const f = annotations()
    f.dispatch.mockResolvedValueOnce(Response.json(receipt))
    await expect(f.bridge.forward(command())).rejects.toThrow()
    expect(f.readCommittedAnnotations).not.toHaveBeenCalled()
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it('does not hide a success if real readback fails', async () => {
    const f = annotations()
    f.readCommittedAnnotations.mockRejectedValueOnce(new Error('not durable'))
    await expect(f.bridge.forward(command())).rejects.toThrow('not durable')
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it('forwards rejection unchanged without inventing a successful annotation', async () => {
    const f = annotations()
    f.dispatch.mockResolvedValueOnce(Response.json({ error: { code: 'conflict' } }, { status: 409 }))
    expect((await f.bridge.forward(command())).action).toBe('fulfill')
    expect(f.readCommittedAnnotations).not.toHaveBeenCalled()
  })
  it.each([
    { ...annotationBody, secret: 'private' },
    { ...annotationBody, expectedVersion: -1 },
    { expectedVersion: 0 },
    { ...annotationBody, labels: ['duplicate', 'duplicate'] }
  ])('rejects invalid body before dispatch %#', async (body) => {
    const f = annotations()
    await expect(f.bridge.forward(command(body))).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it.each([
    ['bad-key', path, 'neteco-session=synthetic-admin'],
    [key, path, 'neteco-session=wrong-owner']
  ])('rejects invalid key or changed admin credential %#', async (id, target, cookie) => {
    const f = annotations()
    await expect(f.bridge.forward(command(annotationBody, id, target, cookie))).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('blocks all other writes, external destinations and query-bearing commands', async () => {
    const f = annotations()
    for (const incoming of [
      command(annotationBody, key, path + '?extra=1'),
      command(annotationBody, key, `/api/admin/orders/44444444-4444-4444-8444-444444444444/annotations`),
      request('/api/cart/items'),
      request('/api/checkout/pay'),
      new Request('https://provider.invalid')
    ])
      expect((await f.bridge.forward(incoming)).action).toBe('abort')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.bridge.proof).toMatchObject({ blockedWrites: 4, blockedExternal: 1 })
  })
  it('manual GET uses original command key and real dispatch, never a second POST', async () => {
    const f = annotations()
    await f.bridge.forward(command())
    for (const target of [path + '/commands/' + key, path + '?limit=20'])
      expect((await f.bridge.forward(new Request(origin + target))).action).toBe('fulfill')
    expect(f.bridge.proof).toMatchObject({ annotationPosts: 1, receiptGets: 1, currentGets: 1 })
    await expect(f.bridge.forward(command())).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    await expect(
      f.bridge.forward(new Request(origin + path + '/commands/44444444-4444-4444-8444-444444444444'))
    ).rejects.toThrow()
  })
})
function request(path = `/api/orders/${orderId}/cancellation`, payload: unknown = body, commandId = key) {
  return new Request(origin + path, {
    method: 'POST',
    headers: {
      origin,
      cookie: 'neteco-session=synthetic-sealed-owner',
      'content-type': 'application/json',
      'idempotency-key': commandId
    },
    body: JSON.stringify(payload)
  })
}
function fixture() {
  const events: string[] = []
  const dispatch = vi.fn(async () => {
    events.push('dispatch')
    return Response.json(receipt())
  })
  const readCommittedCancellation = vi.fn(async () => {
    events.push('durable-readback')
  })
  return {
    events,
    dispatch,
    readCommittedCancellation,
    bridge: createOrderOperationsBrowserBridge({ origin, orderId, dispatch, readCommittedCancellation })
  }
}
beforeEach(() => connection.mockReset())
describe('real compiled order operations browser boundary', () => {
  it('admits only one concurrent POST before asynchronous body parsing or dispatch', async () => {
    const f = fixture()
    const results = await Promise.allSettled([f.bridge.forward(request()), f.bridge.forward(request())])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('reports NOTRUN with zero browser connections, setup callbacks, dispatches or acceptance scenarios', async () => {
    const dispatch = vi.fn(),
      prepareUnpaidOrder = vi.fn(),
      scenario = vi.fn()
    const result = await auditNativeOrderOperationsBrowser({
      origin,
      adminCookie: 'neteco-session=synthetic-sealed-admin',
      dispatch,
      prepareUnpaidOrder,
      scenario,
      browserMode: 'not-run'
    })
    expect(result).toMatchObject({
      browserStatus: 'not_run',
      scenarios: 0,
      requests: null,
      pageErrors: null,
      annotationPosts: null,
      annotationLostResponses: null,
      annotationReceiptGets: null,
      viewports: [],
      syntheticSessionOnly: true,
      providerSubmission: false,
      productionBrowserAcceptance: false
    })
    expect(connection).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(prepareUnpaidOrder).not.toHaveBeenCalled()
    expect(scenario).not.toHaveBeenCalled()
  })
  it.each(['https://production.invalid', 'http://shop-audit.neteco.test', 'https://shop-audit.neteco.test/path'])(
    'rejects non-isolated origin %s before any browser connection',
    async (unsafe) => {
      await expect(
        auditNativeOrderOperationsBrowser({
          origin: unsafe,
          adminCookie: 'neteco-session=synthetic',
          dispatch: vi.fn(),
          prepareUnpaidOrder: vi.fn(),
          browserMode: 'not-run'
        })
      ).rejects.toThrow()
      expect(connection).not.toHaveBeenCalled()
    }
  )
  it.each(['', 'neteco-session=sealed; other=private', 'neteco-session=sealed\r\nprivate'])(
    'rejects invalid credential boundary before NOTRUN: %#',
    async (adminCookie) => {
      await expect(
        auditNativeOrderOperationsBrowser({
          origin,
          adminCookie,
          dispatch: vi.fn(),
          prepareUnpaidOrder: vi.fn(),
          browserMode: 'not-run'
        })
      ).rejects.toThrow()
      expect(connection).not.toHaveBeenCalled()
    }
  )
  it('loses only the real successful response after matching receipt and durable readback', async () => {
    const f = fixture()
    expect(await f.bridge.forward(request())).toEqual({ action: 'abort', reason: 'lost_cancellation_response' })
    expect(f.events).toEqual(['dispatch', 'durable-readback'])
    expect(f.bridge.proof).toMatchObject({ cancellationPosts: 1, lostResponses: 1, receiptGets: 0 })
    expect(f.readCommittedCancellation).toHaveBeenCalledWith(
      expect.objectContaining({ orderId, commandId: key, body, receipt: receipt() })
    )
  })
  it('does not manufacture commitment from an unsuccessful Worker response', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce(Response.json({ error: { code: 'conflict' } }, { status: 409 }))
    const result = await f.bridge.forward(request())
    expect(result.action).toBe('fulfill')
    expect(f.readCommittedCancellation).not.toHaveBeenCalled()
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it.each([
    { ...receipt(), orderId: '33333333-3333-4333-8333-333333333333' },
    { ...receipt(), commandId: '33333333-3333-4333-8333-333333333333' },
    { source: 'cloudflare', orderId, commandId: key, outcome: 'unknown' }
  ])('rejects success without exact committed receipt: %#', async (invalid) => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce(Response.json(invalid))
    await expect(f.bridge.forward(request())).rejects.toThrow()
    expect(f.readCommittedCancellation).not.toHaveBeenCalled()
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it('does not hide a response if the durable proof fails', async () => {
    const f = fixture()
    f.readCommittedCancellation.mockRejectedValueOnce(new Error('not committed'))
    await expect(f.bridge.forward(request())).rejects.toThrow('not committed')
    expect(f.bridge.proof.lostResponses).toBe(0)
  })
  it('refuses a second POST before dispatch even with the same body and key', async () => {
    const f = fixture()
    await f.bridge.forward(request())
    await expect(f.bridge.forward(request())).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { payload: { ...body, expectedStatus: 'cancelled' }, commandId: key },
    { payload: { ...body, reason: 'short' }, commandId: key },
    { payload: { ...body, token: 'private' }, commandId: key },
    { payload: body, commandId: 'not-a-uuid' }
  ])('rejects malformed cancellation before dispatch: %#', async (invalid) => {
    const f = fixture()
    await expect(f.bridge.forward(request(undefined, invalid.payload, invalid.commandId))).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('blocks external traffic and all unrelated commands, including admin cancellation', async () => {
    const f = fixture()
    for (const incoming of [
      new Request('https://provider.invalid/pay'),
      request('/api/cart/items'),
      request(`/api/admin/orders/${orderId}/cancellation`),
      request('/api/checkout/pay')
    ])
      expect((await f.bridge.forward(incoming)).action).toBe('abort')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.bridge.proof).toMatchObject({ blockedExternal: 1, blockedWrites: 3 })
  })
  it('forwards manual receipt and current-state reads through dispatch, never as fixtures', async () => {
    const f = fixture()
    await f.bridge.forward(request())
    for (const path of [`/api/orders/${orderId}/cancellation/commands/${key}`, `/api/orders/${orderId}/cancellation`])
      expect((await f.bridge.forward(new Request(origin + path))).action).toBe('fulfill')
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    expect(f.bridge.proof).toMatchObject({ receiptGets: 1, currentCancellationGets: 1 })
  })
})

describe('integral compiled workbench contract, without fabricated browser DOM or Worker DTOs', () => {
  const adminCookie = 'neteco-session=synthetic-sealed-admin'
  const otherActorCookie = 'neteco-session=synthetic-other-actor'
  const orderIds = Array.from(
    { length: 26 },
    (_, index) => `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  )
  const metadata = () => ({
    adminCookie,
    otherActorCookie,
    orderIds: [...orderIds],
    query: 'Synthetic bounded workbench fixture',
    eligibleOrderIds: orderIds.slice(0, 2),
    blockedOrderId: orderIds[2]!
  })
  it('leaves integral pagination uncredited in NOTRUN and never calls setup, queue, dispatch, connection or scenario', async () => {
    const input = {
      origin,
      adminCookie,
      browserMode: 'not-run' as const,
      dispatch: vi.fn(),
      prepareUnpaidOrder: vi.fn(),
      prepareWorkbench: vi.fn(),
      consumeBulkQueue: vi.fn(),
      scenario: vi.fn()
    }
    const result = await auditNativeOrderOperationsBrowser(input)
    expect(result).toMatchObject({
      browserStatus: 'not_run',
      scenarios: 0,
      paginationAcceptance: 'not_run',
      viewports: []
    })
    for (const callback of [
      input.dispatch,
      input.prepareUnpaidOrder,
      input.prepareWorkbench,
      input.consumeBulkQueue,
      input.scenario,
      connection
    ])
      expect(callback).not.toHaveBeenCalled()
  })
  it('requires the real workbench preparation and queue callbacks before connecting in required mode', async () => {
    const input = {
      origin,
      adminCookie,
      browserMode: 'required' as const,
      dispatch: vi.fn(),
      prepareUnpaidOrder: vi.fn()
    }
    await expect(auditNativeOrderOperationsBrowser(input)).rejects.toThrow(/prepareWorkbench|consumeBulkQueue/)
    expect(connection).not.toHaveBeenCalled()
    expect(input.dispatch).not.toHaveBeenCalled()
    expect(input.prepareUnpaidOrder).not.toHaveBeenCalled()
  })
  it.each(['only25', 'duplicate', 'unknown-eligible', 'same-actor'] as const)(
    'rejects invalid26-order workbench fixture %s before any page or API request',
    async (mode) => {
      const prepared = metadata()
      if (mode === 'only25') prepared.orderIds.pop()
      if (mode === 'duplicate') prepared.orderIds[25] = prepared.orderIds[0]!
      if (mode === 'unknown-eligible') prepared.eligibleOrderIds[0] = '99999999-9999-4999-8999-999999999999'
      if (mode === 'same-actor') prepared.otherActorCookie = prepared.adminCookie
      const browser = { newContext: vi.fn(), close: vi.fn() }
      connection.mockResolvedValueOnce(browser)
      const input = {
        origin,
        adminCookie,
        browserMode: 'required' as const,
        dispatch: vi.fn(),
        prepareUnpaidOrder: vi.fn(async () => ({ orderId, ownerCookie: 'neteco-session=synthetic-sealed-owner' })),
        prepareWorkbench: vi.fn(async () => prepared),
        consumeBulkQueue: vi.fn()
      }
      await expect(auditNativeOrderOperationsBrowser(input)).rejects.toThrow(/workbench_fixture/)
      expect(input.prepareWorkbench).toHaveBeenCalledExactlyOnceWith('desktop')
      expect(browser.newContext).not.toHaveBeenCalled()
      expect(input.dispatch).not.toHaveBeenCalled()
      expect(input.consumeBulkQueue).not.toHaveBeenCalled()
      expect(browser.close).toHaveBeenCalledTimes(1)
    }
  )

  async function realBulkBridge() {
    const f = await fulfillmentFixture()
    try {
      f.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0086_admin_order_bulk.sql', import.meta.url), 'utf8')
      )
      f.sqlite
        .prepare(
          "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-bridge-only','[]',?,?)"
        )
        .run(ACTOR, utc(-60000), utc(-60000))
      const paid = await f.order(),
        unpaid = await f.order('pickup', false),
        events: string[] = []
      const preview = await previewD1AdminOrderBulk(f.database, CLAIMS, {
        action: 'picking',
        orderIds: [paid, unpaid],
        reason: REASON
      })
      const input: AdminOrderBulkCreateInput = {
        action: preview.action,
        orders: preview.rows.map(({ orderId, expectedVersion }) => ({ orderId, expectedVersion })),
        reason: REASON,
        previewHash: preview.previewHash
      }
      const hash = await adminOrderBulkIntentHash(input),
        base = '/api/admin/orders/bulk-fulfillment'
      let committed: AdminOrderBulkReceipt | null = null
      const dispatch = vi.fn(async (request: Request) => {
        const url = new URL(request.url)
        if (request.method === 'POST' && url.pathname === base + '/preview')
          return Response.json(await previewD1AdminOrderBulk(f.database, CLAIMS, await request.json()))
        if (request.method === 'POST' && url.pathname === base + '/commands') {
          events.push('actual-d1-commit')
          committed = await createD1AdminOrderBulk(f.database, CLAIMS, await request.json(), {
            idempotencyKey: request.headers.get('idempotency-key')!
          })
          return Response.json(committed, { status: 201 })
        }
        if (request.method === 'GET' && url.pathname === base + '/commands/' + key)
          return Response.json(
            await readD1AdminOrderBulkCommand(f.database, CLAIMS, key, url.searchParams.get('payloadHash')!)
          )
        if (request.method === 'GET' && committed && url.pathname === base + '/' + committed.groupId)
          return Response.json(await readD1AdminOrderBulk(f.database, CLAIMS, committed.groupId))
        throw new Error('unexpected-bridge-dispatch')
      })
      const readCommittedBulk = vi.fn(
        async (proof: { commandId: string; body: AdminOrderBulkCreateInput; receipt: AdminOrderBulkReceipt }) => {
          const durable = await readD1AdminOrderBulkCommand(
            f.database,
            CLAIMS,
            proof.commandId,
            await adminOrderBulkIntentHash(proof.body)
          )
          expect(durable).toEqual({ source: 'cloudflare', outcome: 'applied', receipt: proof.receipt })
          const group = await readD1AdminOrderBulk(f.database, CLAIMS, proof.receipt.groupId)
          expect(group.commandId).toBe(proof.commandId)
          expect(group.rows.map((row) => row.orderId)).toEqual(input.orders.map((row) => row.orderId))
          expect(
            f.sqlite.prepare('SELECT count(*) AS n FROM admin_order_bulk_groups WHERE id=?').get(proof.receipt.groupId)
              ?.n
          ).toBe(1)
          events.push('independent-durable-readback')
        }
      )
      const consumeBulkQueue = vi.fn(async (message: { groupId: string; dispatchId: string }) => {
        events.push('actual-queue-consumer')
        expect(
          await consumeAdminOrderBulkMessage(
            f.database,
            { type: 'admin.order-bulk.requested', ...message },
            { enabled: true }
          )
        ).toBe('completed')
      })
      const bridgeInput = {
        origin,
        orderId,
        dispatch,
        readCommittedCancellation: vi.fn(),
        bulk: { adminCookie, orderIds: [paid, unpaid], readCommittedBulk, consumeBulkQueue }
      }
      const command = () =>
        new Request(origin + base + '/commands', {
          method: 'POST',
          headers: { origin, cookie: adminCookie, 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify(input)
        })
      const review = () =>
        new Request(origin + base + '/preview', {
          method: 'POST',
          headers: { origin, cookie: adminCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ action: input.action, orderIds: [paid, unpaid], reason: REASON })
        })
      const digest = () =>
        Object.fromEntries(
          [
            'orders',
            'order_lines',
            'order_payment_states',
            'payment_intents',
            'inventory_balances',
            'inventory_movements',
            'inventory_reservations',
            'inventory_reservation_lines'
          ].map((table) => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
        )
      return {
        f,
        input,
        hash,
        base,
        paid,
        events,
        dispatch,
        readCommittedBulk,
        consumeBulkQueue,
        command,
        review,
        digest,
        bridge: createOrderOperationsBrowserBridge(bridgeInput),
        committed: () => committed!
      }
    } catch (error) {
      f.sqlite.close()
      throw error
    }
  }
  it('drops bulk201 only after actual D1 commitment, independent receipt/group proof and the real queue callback', async () => {
    const f = await realBulkBridge()
    try {
      const before = f.digest()
      expect((await f.bridge.forward(f.review())).action).toBe('fulfill')
      expect(await f.bridge.forward(f.command())).toEqual({ action: 'abort', reason: 'lost_bulk_response' })
      expect(f.events).toEqual(['actual-d1-commit', 'independent-durable-readback', 'actual-queue-consumer'])
      for (const path of [f.base + '/commands/' + key + '?payloadHash=' + f.hash, f.base + '/' + f.committed().groupId])
        expect((await f.bridge.forward(new Request(origin + path, { headers: { cookie: adminCookie } }))).action).toBe(
          'fulfill'
        )
      const group = await readD1AdminOrderBulk(f.f.database, CLAIMS, f.committed().groupId)
      expect(group).toMatchObject({ status: 'completed', selected: 2, completed: 2, remaining: 0 })
      expect(group.rows.map((row) => row.status)).toEqual(['applied', 'not_attempted'])
      expect(
        f.f.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands WHERE order_id=?').get(f.paid)?.n
      ).toBe(1)
      expect(f.digest()).toEqual(before)
      await expect(f.bridge.forward(f.command())).rejects.toThrow()
      expect(
        f.dispatch.mock.calls.filter(
          ([request]) => request.method === 'POST' && new URL(request.url).pathname === f.base + '/commands'
        )
      ).toHaveLength(1)
      expect(f.consumeBulkQueue).toHaveBeenCalledExactlyOnceWith({
        groupId: f.committed().groupId,
        dispatchId: f.committed().dispatchId
      })
    } finally {
      f.f.sqlite.close()
    }
  })
  it('never invokes the queue or claims response loss when independent durable proof fails', async () => {
    const f = await realBulkBridge()
    try {
      f.readCommittedBulk.mockRejectedValueOnce(new Error('durable proof unavailable'))
      expect((await f.bridge.forward(f.review())).action).toBe('fulfill')
      await expect(f.bridge.forward(f.command())).rejects.toThrow('durable proof unavailable')
      expect(f.consumeBulkQueue).not.toHaveBeenCalled()
      expect(f.f.sqlite.prepare('SELECT count(*) AS n FROM order_fulfillment_commands').get()?.n).toBe(0)
    } finally {
      f.f.sqlite.close()
    }
  })
})
