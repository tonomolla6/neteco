import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { beplyOrdersWorld } from './beply-orders-fixture'
import { FISCAL_RUNTIME_NOW as NOW, fiscalRuntimeClaims as claims } from './d1-fiscal-runtime-fixture'
import { dispatchConfiguredBeplyOrders } from '../../workers/integrations/beply-orders-runtime'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const origin = 'https://beply-orders.example.invalid'
const password = 'synthetic-beply-cookie-key-longer-than-32'
const opened: DatabaseSync[] = []
const deny = vi.fn(() => {
  throw new Error('D1 must not be touched')
})
const settings = {
  APP_ENV: 'preview',
  AUTH_ENABLED: 'true',
  AUTH_ORIGIN: origin,
  NUXT_SESSION_PASSWORD: password,
  AUTH_RATE_LIMIT_PEPPER: 'synthetic-beply-rate-pepper-more-than-32',
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  BEPLY_ORDERS_ENABLED: 'true',
  BEPLY_SUPPORT_FILE_ID: '501',
  BEPLY_BASE_URL: 'https://sandbox.beply.es/api/3',
  BEPLY_API_TOKEN: 'synthetic',
  BEPLY_ORDER_SERIES: 'NE',
  BEPLY_COMPANY_ID: '1',
  BEPLY_PAYMENT_CODE_REDSYS: 'CARD',
  BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'TRANSFER',
  BEPLY_PAYMENT_CODE_CREDIT: 'CREDIT',
  BEPLY_TAX_CODE_0: 'IVA0',
  BEPLY_TAX_CODE_10: 'IVA10',
  BEPLY_TAX_CODE_21: 'IVA21'
}
const env = (database: D1Database) => ({ ...settings, DB: database }) as unknown as CloudflareEnv
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  deny.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const db of opened.splice(0)) db.close()
})
const id = '10000000-0000-4000-8000-000000000010'
function message(orderId: string) {
  return {
    id: 'synthetic-message',
    timestamp: new Date(NOW),
    body: { type: 'beply.order.sync', schemaVersion: 1, orderId },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn()
  }
}
async function deliver(environment: CloudflareEnv, entry: ReturnType<typeof message>) {
  await worker.queue(
    { queue: 'synthetic-beply', messages: [entry], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch,
    environment
  )
}

function offlineTransport(amount: number) {
  let document: Record<string, unknown> | null = null
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://sandbox.beply.es') throw new Error('unexpected outbound target')
    if (url.pathname.endsWith('/variantes')) return Response.json([{ referencia: 'SKU-1-1' }])
    if (url.pathname.endsWith('/settings/default')) return Response.json({ name: 'default', properties: '{}' })
    if (url.pathname.endsWith('/clientes')) return Response.json({ codcliente: 'synthetic' })
    if (url.pathname.endsWith('/contactos'))
      return Response.json({ ok: 'created', data: Object.fromEntries(init!.body as URLSearchParams) })
    if (url.pathname.endsWith('/crearPedidoCliente')) {
      const form = init!.body as URLSearchParams
      document = {
        idpedido: 71,
        codigo: 'PED71',
        numero2: form.get('numero2'),
        coddivisa: 'EUR',
        total: (amount / 100).toFixed(2),
        editable: true,
        observaciones: form.get('observaciones')
      }
      return Response.json(document)
    }
    if (url.pathname.endsWith('/pedidoclientes')) return Response.json(document ? [document] : [])
    if (url.pathname.endsWith('/pedidoclientes/71')) return Response.json(document)
    if (url.pathname.endsWith('/lineapedidoclientes')) return Response.json([{ idpedido: 71, cantidad: 1, servido: 0 }])
    if (url.pathname.endsWith('/doctransformations')) return Response.json([])
    throw new Error('unexpected API contract')
  })
}

describe('Beply entry points through actual canary', () => {
  it('owns customer/admin endpoints before legacy routing and requires a session without D1 reads', async () => {
    const database = { prepare: deny, batch: deny } as unknown as D1Database
    for (const prefix of ['', 'admin/']) {
      const response = await worker.fetch(
        new Request(`${origin}/api/${prefix}orders/${id}/beply`, { headers: { 'cf-connecting-ip': '192.0.2.71' } }),
        env(database)
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    }
    expect(deny).not.toHaveBeenCalled()
  })
  it('runs edge limiting before any order or session read', async () => {
    const database = { prepare: deny, batch: deny } as unknown as D1Database
    const environment = {
      ...env(database),
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: false }) }
    } as CloudflareEnv
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/api/admin/orders/${id}/beply`, { headers: { 'cf-connecting-ip': '192.0.2.71' } }),
          environment
        )
      ).status
    ).toBe(429)
    expect(deny).not.toHaveBeenCalled()
  })
  it('reads a real D1 order with a sealed admin session and rejects a revoked session', async () => {
    const w = await beplyOrdersWorld(opened),
      environment = env(w.database)
    const cookie = await issueD1SessionCookie(w.database, claims, { password, maxAgeSeconds: 3600 })
    const request = () =>
      new Request(`${origin}/api/admin/orders/${w.order.orderId}/beply`, {
        headers: { Cookie: cookie!.split(';')[0]!, 'cf-connecting-ip': '192.0.2.71' }
      })
    const response = await worker.fetch(request(), environment)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ orderId: w.order.orderId, audience: 'admin', status: 'pending' })
    w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, claims.sessionId)
    expect((await worker.fetch(request(), environment)).status).toBe(401)
  })
  it('consumes durable paid-order work through the real queue branch and actual sandbox adapter with offline transport', async () => {
    const w = await beplyOrdersWorld(opened),
      environment = env(w.database)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(offlineTransport(w.order.amount))
    const first = message(w.order.orderId)
    await deliver(environment, first)
    expect(w.row()).toMatchObject({ status: 'synced', provider_order_id: '71', synced_version: 1 })
    expect(first.ack).toHaveBeenCalledOnce()
    expect(first.retry).not.toHaveBeenCalled()
    await deliver(environment, message(w.order.orderId))
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/crearPedidoCliente'))).toHaveLength(1)
  })
  it('publishes and consumes the scheduled obligation with the same configured sandbox adapter', async () => {
    const w = await beplyOrdersWorld(opened),
      queue = { send: vi.fn().mockResolvedValue(undefined) },
      fetcher = offlineTransport(w.order.amount)
    const report = await dispatchConfiguredBeplyOrders({ database: w.database, queue, fetcher }, settings, {
      now: NOW,
      limit: 1
    })
    expect(report).toMatchObject({ disabled: false, published: 1, completed: 1, manualReview: 0 })
    expect(queue.send).toHaveBeenCalledWith({ type: 'beply.order.sync', schemaVersion: 1, orderId: w.order.orderId })
    expect(w.row()).toMatchObject({ status: 'synced', provider_order_id: '71' })
  })
})
