import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie, verifySessionCookie } from '../../workers/auth/session-cookie'
import { handleOrderAnnotationsHttp } from '../../workers/catalog/order-annotations-http'
import { handleOrderTimelineHttp } from '../../workers/catalog/order-timeline-http'
import { handleOrderExportHttp } from '../../workers/catalog/order-export-http'
import { readD1CustomerOrderLines } from '../../workers/catalog/customer-orders'
import { auditNativeOrderAnnotations } from '../../scripts/lib/audit-native-order-annotations'
const origin = 'https://shop-audit.neteco.test',
  configuration = { password: 'synthetic-annotations-audit-password-32', maxAgeSeconds: 3600 }
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, adminCookie: string, customerCookie: string
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0063_order_annotations.sql', 'utf8'))
  orderId = await f.order({ paid: false, delivered: false })
  adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
  customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => f?.sqlite.close())
async function dispatch(request: Request) {
  const deps = {
    database: f.database,
    sessionCookieConfiguration: configuration,
    origin,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-annotations-audit-pepper-32',
    now: () => utc(),
    appEnvironment: 'local' as const
  }
  for (const handler of [handleOrderAnnotationsHttp, handleOrderTimelineHttp, handleOrderExportHttp]) {
    const response = await handler(request, deps)
    if (response) return response
  }
  if (new URL(request.url).pathname === `/api/orders/${orderId}/lines`) {
    const result = await readD1CustomerOrderLines(
      f.database,
      await verifySessionCookie(request, configuration),
      orderId,
      utc()
    )
    return Response.json(result.outcome === 'found' ? result.detail : { error: { code: result.outcome } }, {
      status: result.outcome === 'found' ? 200 : 401,
      // Match the existing canary customer-lines response, not the separate
      // annotations handler's stricter private header.
      headers: { 'Cache-Control': 'no-store' }
    })
  }
  throw new Error('unexpected_audit_path')
}
function auditDatabase(): D1Database {
  // This adapter intentionally lacks workerd metadata. Measure real SQLite
  // total_changes for each acceptance SELECT instead of faking zero writes.
  const changes = () => Number(f.sqlite.prepare('SELECT total_changes() n').get()!.n)
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        if (key === 'all')
          return async () => {
            const before = changes(),
              result = await target.all()
            return { ...result, meta: { ...result.meta, rows_written: changes() - before } }
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  return new Proxy(f.database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
const input = () => ({ dispatch, database: auditDatabase(), origin, adminCookie, customerCookie, orderId })
it('drives real handlers and verifies append-ledger effects without money/stock changes', async () => {
  const scenario = vi.fn(),
    result = await auditNativeOrderAnnotations({ ...input(), scenario })
  expect(result.productionAcceptance).toBe(false)
  expect(result.providerOperation).toBe(false)
  expect(result.scenarios).toBeGreaterThanOrEqual(9)
  expect(scenario).toHaveBeenCalledTimes(result.scenarios)
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_annotation_commands').get()).toEqual({ n: 3 })
})
it('rejects a foreign origin before HTTP or SQL', async () => {
  const send = vi.fn(dispatch),
    prepare = vi.spyOn(f.database, 'prepare')
  await expect(
    auditNativeOrderAnnotations({ ...input(), origin: 'https://foreign.invalid', dispatch: send })
  ).rejects.toThrow('isolated origin')
  expect(send).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})
it('rejects extra private fields leaking into the customer timeline', async () => {
  await expect(
    auditNativeOrderAnnotations({
      ...input(),
      dispatch: async (req) => {
        const response = await dispatch(req)
        if (new URL(req.url).pathname.endsWith('/timeline')) {
          const value = (await response.json()) as Record<string, unknown>
          return Response.json({ ...value, internalNotes: ['secret'] }, { headers: response.headers })
        }
        return response
      }
    })
  ).rejects.toThrow()
})
it('still requires private no-store for the annotations endpoint', async () => {
  await expect(
    auditNativeOrderAnnotations({
      ...input(),
      dispatch: async (req) => {
        const response = await dispatch(req)
        if (new URL(req.url).pathname.endsWith('/annotations')) {
          const headers = new Headers(response.headers)
          headers.set('Cache-Control', 'no-store')
          return new Response(response.body, { status: response.status, headers })
        }
        return response
      }
    })
  ).rejects.toThrow()
})
it('detects an inventory write injected after a successful annotation POST', async () => {
  await expect(
    auditNativeOrderAnnotations({
      ...input(),
      dispatch: async (req) => {
        const response = await dispatch(req)
        if (req.method === 'POST' && response.status === 200)
          f.sqlite.exec('UPDATE inventory_balances SET physical_quantity=physical_quantity+1')
        return response
      }
    })
  ).rejects.toThrow('money/stock')
})
