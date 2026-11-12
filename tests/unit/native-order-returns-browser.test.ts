import { beforeEach, expect, it, vi } from 'vitest'

import { readFile, readdir } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerReturnsHttp } from '../../workers/returns/customer-http'
import { handleAdminReturnsHttp } from '../../workers/returns/admin-http'
import {
  auditNativeOrderReturnsBrowser,
  createOrderReturnsBrowserBridge,
  readOrderReturnsDomainDigest,
  ensureOrderReturnsRowExpanded,
  navigateCustomerOrderReturns,
  requireOrderReturnsLostResponse,
  OrderReturnsBrowserDiagnosticError
} from '../../scripts/lib/audit-native-order-returns-browser'
import { returnsFixture, BUYER_CLAIMS, CLAIMS, utc } from './d1-returns-fixture'
import {
  requestD1CustomerReturn,
  executeD1AdminReturnCommand,
  readD1CustomerReturns
} from '../../workers/returns/operations'
import { testUuid } from '../support/deterministic'

it.each([true, false])(
  'opens the returns panel once without closing an already expanded order: initial=%s',
  async (initial) => {
    let expanded = initial
    const control = {
      getAttribute: vi.fn(async () => String(expanded)),
      click: vi.fn(async () => {
        expanded = !expanded
      })
    }
    await ensureOrderReturnsRowExpanded(control)
    expect(expanded).toBe(true)
    expect(control.click).toHaveBeenCalledTimes(initial ? 0 : 1)
  }
)

const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'Private browser explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test',
  orderId = '11111111-1111-4111-8111-111111111111'
const returnId = '22222222-2222-4222-8222-222222222222',
  publicRef = `RMA-${'A'.repeat(24)}`
it.each([true, false])('reaches the dedicated returns page through real order links: expanded=%s', async (initial) => {
  let expanded = initial,
    pathname = '/cuenta/pedidos'
  const visits: string[] = []
  const panel = { visible: true }
  const row = {
    getByRole: (role: string, options: { name: string }) => {
      if (role !== 'link' || options.name !== 'Ver pedido completo' || !expanded)
        throw new Error('The account row contains no return panel')
      return {
        click: async () => {
          pathname = `/pedido/${orderId}`
          visits.push(pathname)
        }
      }
    }
  }
  const page = {
    getByRole: (role: string, options: { name: string }) => {
      if (pathname === `/pedido/${orderId}` && role === 'link' && options.name === 'Solicitar devolución')
        return {
          click: async () => {
            pathname = `/devoluciones?pedido=${orderId}`
            visits.push(pathname)
          }
        }
      if (
        pathname === `/devoluciones?pedido=${orderId}` &&
        role === 'region' &&
        options.name === 'Solicitudes de devolución del pedido'
      )
        return panel
      throw new Error('Return controls exist only on the dedicated returns page')
    },
    waitForURL: async (expected: (url: URL) => boolean) => {
      expect(expected(new URL(pathname, origin))).toBe(true)
    }
  }
  const control = {
    getAttribute: async () => String(expanded),
    click: vi.fn(async () => {
      expanded = !expanded
    })
  }
  await ensureOrderReturnsRowExpanded(control)
  const result = await navigateCustomerOrderReturns(
    row as unknown as Parameters<typeof navigateCustomerOrderReturns>[0],
    page as unknown as Parameters<typeof navigateCustomerOrderReturns>[1],
    orderId
  )
  expect(result).toBe(panel)
  expect(visits).toEqual([`/pedido/${orderId}`, `/devoluciones?pedido=${orderId}`])
  expect(control.click).toHaveBeenCalledTimes(initial ? 0 : 1)
})
const requestBody = {
  expectedVersion: 0,
  reason: 'Synthetic customer return request',
  lines: [{ lineIndex: 0, quantity: 1 }]
}
const transition = (action: 'approved' | 'received') => ({
  action,
  expectedVersion: action === 'approved' ? 1 : 2,
  reason: 'Private synthetic custody reason',
  publicMessage: 'Custody recorded without economic effects',
  evidence: 'Private synthetic document evidence',
  lines: [{ lineIndex: 0, quantity: 1 }],
  ...(action === 'approved' ? { decisionRef: 'synthetic-decision' } : {})
})
function receipt(action: 'requested' | 'approved' | 'received') {
  const version = action === 'requested' ? 1 : action === 'approved' ? 2 : 3
  return {
    source: 'cloudflare',
    commandId: `${version}0000000-0000-4000-8000-000000000000`,
    returnId,
    publicRef,
    orderId,
    action,
    state: action,
    version,
    orderVersion: version,
    inventoryEffect: 'none',
    custody: 'non_sellable',
    updated: true
  }
}
function command(
  action: 'requested' | 'approved' | 'received',
  key: string = action,
  body: unknown = action === 'requested' ? requestBody : transition(action)
) {
  return new Request(
    origin + (action === 'requested' ? `/api/orders/${orderId}/returns` : `/api/admin/returns/${publicRef}`),
    {
      method: action === 'requested' ? 'POST' : 'PUT',
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  )
}
function fixture() {
  const dispatch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as { action?: 'approved' | 'received' }
      return Response.json(receipt(body.action ?? 'requested'), { status: body.action ? 200 : 201 })
    }),
    readCommitted = vi.fn(async () => undefined)
  return {
    dispatch,
    readCommitted,
    bridge: createOrderReturnsBrowserBridge({ origin, orderId, dispatch, readCommitted })
  }
}
async function ready() {
  const f = fixture()
  expect((await f.bridge.forward(command('requested'))).action).toBe('fulfill')
  expect((await f.bridge.forward(command('approved'))).action).toBe('fulfill')
  return f
}
beforeEach(() => connection.mockReset())
it('NOTRUN performs no connection, fixture preparation, dispatch, or database access', async () => {
  const dispatch = vi.fn(),
    prepareDeliveredOrder = vi.fn(),
    scenario = vi.fn(),
    batch = vi.fn()
  const report = await auditNativeOrderReturnsBrowser({
    origin,
    adminCookie: 'neteco-session=synthetic',
    dispatch,
    database: { batch } as unknown as D1Database,
    prepareDeliveredOrder,
    scenario,
    browserMode: 'not-run'
  })
  expect(report).toMatchObject({
    scenarios: 0,
    browserStatus: 'not_run',
    productionBrowserAcceptance: false,
    providerSubmission: false
  })
  for (const call of [connection, dispatch, prepareDeliveredOrder, scenario, batch]) expect(call).not.toHaveBeenCalled()
})
it('drops only a real received200 after independent durable proof; exact replay returns the same receipt', async () => {
  const f = await ready()
  expect(await f.bridge.forward(command('received'))).toEqual({ action: 'abort', reason: 'lost_return_response' })
  expect(f.readCommitted).toHaveBeenLastCalledWith(
    expect.objectContaining({ key: 'received', body: transition('received'), receipt: receipt('received') })
  )
  const replay = await f.bridge.forward(command('received'))
  expect(replay.action).toBe('fulfill')
  if (replay.action === 'fulfill') expect(await replay.response.json()).toEqual(receipt('received'))
  expect(f.dispatch).toHaveBeenCalledTimes(4)
  expect(f.bridge.proof).toMatchObject({ requestPosts: 1, transitionPuts: 3, lostResponses: 1, replayPuts: 1 })
})
it.each(['key', 'body'])('rejects changed replay %s before dispatch', async (mode) => {
  const f = await ready()
  await f.bridge.forward(command('received'))
  await expect(
    f.bridge.forward(
      command(
        'received',
        mode === 'key' ? 'different' : 'received',
        mode === 'body' ? { ...transition('received'), evidence: 'Changed private evidence' } : transition('received')
      )
    )
  ).rejects.toThrow()
  expect(f.dispatch).toHaveBeenCalledTimes(3)
})
it('cannot claim loss if independent committed readback fails', async () => {
  const f = await ready()
  f.readCommitted.mockRejectedValueOnce(new Error('unconfirmed durable state'))
  await expect(f.bridge.forward(command('received'))).rejects.toThrow('unconfirmed durable state')
  expect(f.bridge.proof.lostResponses).toBe(0)
})
it('reports the original readback failure before the missing response-loss assertion without leaking private evidence', () => {
  const cause = new Error('synthetic private SQL/cookie/evidence must never be serialized')
  const diagnostic = { stage: 'committed_readback', action: 'received', status: 200 } as const
  let failure: unknown
  try {
    requireOrderReturnsLostResponse({ lostResponses: 0 }, cause, diagnostic)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(OrderReturnsBrowserDiagnosticError)
  const error = failure as OrderReturnsBrowserDiagnosticError
  expect(error.cause).toBe(cause)
  expect(error.safeDiagnostic).toEqual(diagnostic)
  expect(JSON.stringify(error.safeDiagnostic)).not.toContain('private')
  expect(error.message).not.toContain('private')
})
it('reports an actual rejected command status rather than inventing a lost successful response', () => {
  const diagnostic = { stage: 'command_response', action: 'received', status: 429 } as const
  expect(() => requireOrderReturnsLostResponse({ lostResponses: 0 }, null, diagnostic)).toThrow(
    OrderReturnsBrowserDiagnosticError
  )
})
it('does not drop an actual non200 received response or claim a commit', async () => {
  const f = await ready()
  f.dispatch.mockResolvedValueOnce(Response.json({ error: { code: 'rate_limited' } }, { status: 429 }))
  const result = await f.bridge.forward(command('received'))
  expect(result.action).toBe('fulfill')
  expect(f.bridge.proof.lostResponses).toBe(0)
  expect(f.readCommitted).toHaveBeenCalledTimes(2)
})
it('rejects receipt with a different order before injecting any response loss', async () => {
  const f = await ready()
  f.dispatch.mockResolvedValueOnce(Response.json({ ...receipt('received'), orderId: returnId }))
  await expect(f.bridge.forward(command('received'))).rejects.toThrow()
  expect(f.bridge.proof.lostResponses).toBe(0)
})
it.each(['external', 'unrelated', 'admin-before-request', 'invalid-request'])(
  'blocks %s without dispatch',
  async (kind) => {
    const f = fixture()
    const request =
      kind === 'external'
        ? new Request('https://provider.invalid/')
        : kind === 'unrelated'
          ? new Request(origin + '/api/payments', { method: 'POST' })
          : kind === 'admin-before-request'
            ? command('approved')
            : command('requested', 'requested', { ...requestBody, lines: [] })
    if (kind === 'external' || kind === 'unrelated') expect((await f.bridge.forward(request)).action).toBe('abort')
    else await expect(f.bridge.forward(request)).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
  }
)
it('rejects a third recovery write after an exact acknowledged replay', async () => {
  const f = await ready()
  await f.bridge.forward(command('received'))
  await f.bridge.forward(command('received'))
  await expect(f.bridge.forward(command('received'))).rejects.toThrow()
  expect(f.dispatch).toHaveBeenCalledTimes(4)
})
it('uses a genuinely owned paid/delivered fixture and real D1 commands: lost receipt + exact replay leaves one non-sellable custody event', async () => {
  const f = await returnsFixture()
  try {
    const id = await f.order(),
      customerPath = `/api/orders/${id}/returns`
    const baseline = await readD1CustomerReturns(f.database, BUYER_CLAIMS, id, { page: 1, perPage: 25, now: utc() })
    expect(baseline.readiness.ready && baseline.capabilities.returnRequest).toBe(true)
    expect(baseline.version).toBe(0)
    // The adapter lacks platform metadata. Supply only measured SQLite writes,
    // not manufactured business rows or authority.
    const snapshotDatabase = {
      prepare: f.database.prepare.bind(f.database),
      batch: async (statements: D1PreparedStatement[]) => {
        const before = (f.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n
        const rows = await f.database.batch(statements)
        const after = (f.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n
        expect(after).toBe(before)
        return rows.map((row) => ({ ...row, meta: { ...row.meta, rows_written: after - before } }))
      }
    } as unknown as D1Database
    const before = await readOrderReturnsDomainDigest(snapshotDatabase, id)
    let ref = ''
    const bridge = createOrderReturnsBrowserBridge({
      origin,
      orderId: id,
      async dispatch(request) {
        const key = request.headers.get('idempotency-key')!
        const value = await request.json()
        const result =
          request.method === 'POST'
            ? await requestD1CustomerReturn(f.database, BUYER_CLAIMS, id, value, { idempotencyKey: key, now: utc() })
            : await executeD1AdminReturnCommand(f.database, CLAIMS, ref, value, { idempotencyKey: key, now: utc() })
        ref = result.publicRef
        return Response.json(result, { status: request.method === 'POST' ? 201 : 200 })
      },
      async readCommitted(proof) {
        const row = f.sqlite
          .prepare('SELECT input,response,idempotency_key FROM order_return_commands WHERE id=?')
          .get(proof.receipt.commandId) as { input: string; response: string; idempotency_key: string }
        expect(JSON.parse(row.input)).toEqual(proof.body)
        expect(JSON.parse(row.response)).toEqual(proof.receipt)
        expect(row.idempotency_key).toBe(proof.key)
        const current = await readD1CustomerReturns(f.database, BUYER_CLAIMS, id, { page: 1, perPage: 25, now: utc() })
        expect(current.version).toBe(proof.receipt.orderVersion)
        expect(JSON.stringify(current)).not.toContain('Private synthetic')
      }
    })
    const send = (action: 'requested' | 'approved' | 'received') =>
      bridge.forward(
        new Request(origin + (action === 'requested' ? customerPath : `/api/admin/returns/${ref}`), {
          method: action === 'requested' ? 'POST' : 'PUT',
          headers: { 'idempotency-key': action, 'content-type': 'application/json' },
          body: JSON.stringify(action === 'requested' ? requestBody : transition(action))
        })
      )
    await send('requested')
    await send('approved')
    expect((await send('received')).action).toBe('abort')
    expect((await send('received')).action).toBe('fulfill')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_return_commands WHERE order_id=?').get(id)).toEqual({
      n: 3
    })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM order_return_events WHERE order_id=?').get(id)).toEqual({ n: 3 })
    expect(await readOrderReturnsDomainDigest(snapshotDatabase, id)).toBe(before)
  } finally {
    f.sqlite.close()
  }
})
it('reproduces browser requested approved received through real HTTP and independent custody readback before losing 200', async () => {
  const f = await returnsFixture()
  try {
    for (const file of (await readdir('db/d1/migrations'))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) > 62 && Number(file.slice(0, 4)) <= 75)
      .sort())
      await f.database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => f.database.prepare(sql))
      )
    const id = await f.order(),
      password = 'synthetic-rma-browser-http-password-over32'
    const env = { DB: f.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    const ownerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, {
      password,
      maxAgeSeconds: 3600
    }))!.split(';')[0]!
    const adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!
    const statuses: { action: string; status: number; code: string | null }[] = []
    const read = async (path: string, cookie: string) => {
      const request = new Request(origin + path, { headers: { Cookie: cookie } })
      const response = (await handleCustomerReturnsHttp(request, env)) ?? (await handleAdminReturnsHttp(request, env))!
      expect(response.status).toBe(200)
      return response.json()
    }
    let ref = ''
    const bridge = createOrderReturnsBrowserBridge({
      origin,
      orderId: id,
      async dispatch(request) {
        const value = (await request.clone().json()) as { action?: string }
        const response =
          (await handleCustomerReturnsHttp(request, env)) ?? (await handleAdminReturnsHttp(request, env))!
        const json = (await response.clone().json()) as { publicRef?: string; error?: { code?: string } }
        if (json.publicRef) ref = json.publicRef
        statuses.push({ action: value.action ?? 'requested', status: response.status, code: json.error?.code ?? null })
        return response
      },
      async readCommitted(proof) {
        const row = f.sqlite
          .prepare(
            `SELECT c.input,c.response,c.action,c.result_version,
          (SELECT count(*) FROM order_return_events e WHERE e.command_id=c.id AND e.input=c.input AND e.response=c.response) audits
          FROM order_return_commands c WHERE c.id=? AND c.order_id=? AND c.idempotency_key=?`
          )
          .get(proof.receipt.commandId, id, proof.key) as {
          input: string
          response: string
          action: string
          result_version: number
          audits: number
        }
        expect(row).toBeTruthy()
        expect(row.audits).toBe(1)
        expect(JSON.parse(row.input)).toEqual(proof.body)
        expect(JSON.parse(row.response)).toEqual(proof.receipt)
        expect(row.action).toBe(proof.receipt.action)
        expect(row.result_version).toBe(proof.receipt.version)
        const customer = (await read(`/api/orders/${id}/returns`, ownerCookie)) as {
          version: number
          returns: { id: string; state: string }[]
        }
        expect(customer.version).toBe(proof.receipt.orderVersion)
        expect(customer.returns.find((value) => value.id === proof.receipt.returnId)?.state).toBe(proof.receipt.state)
        if (proof.receipt.action !== 'requested') {
          const admin = (await read(`/api/admin/returns/${proof.receipt.publicRef}`, adminCookie)) as {
            version: number
            state: string
          }
          expect(admin.version).toBe(proof.receipt.version)
          expect(admin.state).toBe(proof.receipt.state)
        }
      }
    })
    const send = (action: 'requested' | 'approved' | 'received', key: string) =>
      bridge.forward(
        new Request(origin + (action === 'requested' ? `/api/orders/${id}/returns` : `/api/admin/returns/${ref}`), {
          method: action === 'requested' ? 'POST' : 'PUT',
          headers: {
            Origin: origin,
            Cookie: action === 'requested' ? ownerCookie : adminCookie,
            'Content-Type': 'application/json',
            'Idempotency-Key': key
          },
          body: JSON.stringify(
            action === 'requested'
              ? { ...requestBody, reason: 'Solicitud sintética local de revisión del producto recibido' }
              : {
                  ...transition(action),
                  reason: 'Private synthetic custody desktop',
                  publicMessage: 'Recepción física registrada, sin efectos económicos.',
                  evidence: 'Private synthetic document desktop',
                  ...(action === 'approved' ? { decisionRef: 'Synthetic documented local decision' } : {})
                }
          )
        })
      )
    expect((await send('requested', testUuid())).action).toBe('fulfill')
    expect((await send('approved', testUuid())).action).toBe('fulfill')
    const key = testUuid(),
      received = await send('received', key)
    expect(statuses).toEqual([
      { action: 'requested', status: 201, code: null },
      { action: 'approved', status: 200, code: null },
      { action: 'received', status: 200, code: null }
    ])
    expect(received).toEqual({ action: 'abort', reason: 'lost_return_response' })
    expect(bridge.proof.lostResponses).toBe(1)
    expect((await send('received', key)).action).toBe('fulfill')
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM order_return_commands WHERE order_id=? AND action='received'").get(id)?.n
    ).toBe(1)
  } finally {
    f.sqlite.close()
  }
})
