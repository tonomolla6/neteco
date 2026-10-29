import { describe, expect, it, vi } from 'vitest'
import { environment } from '../support/customer-operations-fixture'
import { handleCustomerOperationsHttp } from '../../workers/runtime/customer-operations-http'
import worker from '../../workers/canary'
import { customer360Fixture, utc } from './customer-360-fixture'
import { salesQuoteReceiptSchema } from '../../shared/sales-quotes'
import { customer360Schema } from '../../shared/customer-360'

const paths = [
  '/api/admin/sales-quotes',
  '/api/account/sales-quotes',
  '/api/admin/%73ales-quotes',
  '/api/account/%2573ales-quotes',
  '/api/admin/SALES-QUOTES/unknown',
  '/api/admin/customer-context',
  '/api/admin/%63ustomer-context',
  '/api/admin/%2563ustomer-context/unknown',
  '/API/admin/customer-context'
]

describe('configured commercial and customer context authorities', () => {
  it('serves canonical quote and customer-context leaves through the actual Worker and denies revoked grants', async () => {
    const f = await customer360Fixture()
    try {
      f.fullAccess()
      const env = environment({
        DB: f.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: f.deps.origin,
        NUXT_SESSION_PASSWORD: f.deps.sessionCookieConfiguration!.password,
        SALES_QUOTES_ENABLED: 'true',
        CUSTOMER_360_ENABLED: 'true',
        FREE_SHIPPING_THRESHOLD_CENTS: '0',
        INVENTORY: { idFromName: vi.fn(), get: vi.fn() }
      })
      const request = (path: string, body?: unknown) =>
        new Request(env.AUTH_ORIGIN + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            cookie: f.adminCookie,
            origin: env.AUTH_ORIGIN,
            'cf-connecting-ip': '192.0.2.90',
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID()
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
      const response = await worker.fetch(
        request('/api/admin/sales-quotes', {
          customerId: f.customerId,
          lines: [{ variantId: 'v-1-1', quantity: 2 }],
          destination: { city: 'Ontinyent', postalCode: '46870' },
          shippingMethod: 'pickup',
          validUntil: utc(1800000),
          reason: 'Presupuesto sintético con revisión comercial explícita.'
        }),
        env
      )
      expect(response.status).toBe(201)
      const receipt = salesQuoteReceiptSchema.parse(await response.json())
      expect(receipt).toMatchObject({ action: 'create', version: 1, orderId: null })
      const context = await worker.fetch(request('/api/admin/customer-context/' + f.customerId), env)
      expect(context.status).toBe(200)
      expect(customer360Schema.parse(await context.json()).customer.id).toBe(f.customerId)
      expect(context.headers.get('cache-control')).toBe('private, no-store')
      expect(env.INVENTORY.get).not.toHaveBeenCalled()
      f.sqlite.exec(
        "DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage'"
      )
      expect((await worker.fetch(request('/api/admin/sales-quotes/' + receipt.quoteId), env)).status).toBe(403)
      f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='support.manage'")
      expect((await worker.fetch(request('/api/admin/customer-context/' + f.customerId), env)).status).toBe(403)
      expect(f.sqlite.prepare('SELECT count(*) n FROM sales_quote_versions').get()).toEqual({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })

  it.each(paths)('claims disabled %s without reading bodies, sessions, D1 or Durable Objects', async (path) => {
    const env = environment({ AUTH_ENABLED: 'true', INVENTORY: { idFromName: vi.fn(), get: vi.fn() } })
    const request = new Request(env.AUTH_ORIGIN + path, { method: 'POST', body: 'not-parsed' })
    const response = await handleCustomerOperationsHttp(request, env)
    expect(response, 'owned routes must never fall through to legacy Nitro').not.toBeNull()
    expect(response!.status).toBe(503)
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
    expect(env.INVENTORY.get).not.toHaveBeenCalled()
    expect(env.ADMIN_EDGE_LIMIT.limit).not.toHaveBeenCalled()
    expect(env.CART_EDGE_LIMIT.limit).not.toHaveBeenCalled()
  })

  it.each(['/api/admin/sales-quotes', '/api/account/sales-quotes', '/api/admin/customer-context'])(
    'keeps %s closed with authentication OFF even if the feature is enabled',
    async (path) => {
      const env = environment({ SALES_QUOTES_ENABLED: 'true', CUSTOMER_360_ENABLED: 'true' })
      const request = new Request(env.AUTH_ORIGIN + path, { method: 'POST', body: 'not-parsed' })
      const response = await handleCustomerOperationsHttp(request, env)
      expect(response).not.toBeNull()
      expect(response!.status).toBe(503)
      expect(request.bodyUsed).toBe(false)
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
  )

  it.each(['/api/admin/sales-quotes', '/api/account/sales-quotes', '/api/admin/customer-context'])(
    'enforces the correct live edge gate before sessions and D1 for enabled %s',
    async (path) => {
      const env = environment({
        AUTH_ENABLED: 'true',
        SALES_QUOTES_ENABLED: 'true',
        CUSTOMER_360_ENABLED: 'true',
        INVENTORY: { idFromName: vi.fn(), get: vi.fn() },
        ADMIN_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: false })) },
        CART_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: false })) }
      })
      const response = await handleCustomerOperationsHttp(
        new Request(env.AUTH_ORIGIN + path, {
          headers: { cookie: 'not-parsed', 'cf-connecting-ip': '192.0.2.90' }
        }),
        env
      )
      expect(response!.status).toBe(429)
      expect(env.DB.prepare).not.toHaveBeenCalled()
      expect(env.INVENTORY.get).not.toHaveBeenCalled()
      const administrative = path.startsWith('/api/admin/')
      expect(env.ADMIN_EDGE_LIMIT.limit).toHaveBeenCalledTimes(administrative ? 1 : 0)
      expect(env.CART_EDGE_LIMIT.limit).toHaveBeenCalledTimes(administrative ? 0 : 1)
    }
  )

  it.each(['/api/admin/sales-quotes-extra', '/api/account/sales-quotes-extra', '/api/admin/customer-context-extra'])(
    'does not claim unrelated %s',
    async (path) => {
      expect(await handleCustomerOperationsHttp(new Request('https://neteco.invalid' + path), environment())).toBeNull()
    }
  )
})
