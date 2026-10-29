import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { inspectCanaryBindings } from '../../workers/canary'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { fiscalRuntimeWorld } from './d1-fiscal-runtime-fixture'
import { CLAIMS, fulfillmentFixture } from './d1-fulfillment-fixture'

afterEach(() => vi.restoreAllMocks())

const policyNamespaceAliases = [
  '/api/admin/catalog/%70olicies',
  '/api/admin/catalog/policies%2Fbad%2Fwithdraw',
  '/api/admin/%70roducts/101/publication-policy',
  '/api/admin/products/101/%69dentifier-exceptions',
  '/api/admin/catalog/%2570olicies'
]

function bindings(options: { d1Ok?: boolean; categories?: unknown[]; categoryError?: Error } = {}) {
  const first = vi.fn().mockResolvedValue(options.d1Ok === false ? null : { ok: 1 })
  const all = options.categoryError
    ? vi.fn().mockRejectedValue(options.categoryError)
    : vi.fn().mockResolvedValue({ results: options.categories ?? [] })
  return {
    APP_ENV: 'canary',
    DB: { prepare: vi.fn(() => ({ first, all })) },
    CACHE: { get: vi.fn(), put: vi.fn() },
    MEDIA: { get: vi.fn(), put: vi.fn() },
    ASYNC_JOBS: { send: vi.fn() },
    CATALOG_WORKFLOW: { create: vi.fn(), get: vi.fn() },
    COORDINATOR: { idFromName: vi.fn(), get: vi.fn() },
    INVENTORY: { idFromName: vi.fn(), get: vi.fn() },
    CARTS: { idFromName: vi.fn(), get: vi.fn() },
    CART_EDGE_LIMIT: { limit: vi.fn() }
  } as unknown as CloudflareEnv
}

describe('Cloudflare canary', () => {
  it('acknowledges a permanently malformed fiscal message without waking issuance or querying D1', async () => {
    const env = bindings(),
      ack = vi.fn(),
      retry = vi.fn()
    env.FISCAL_ISSUANCE_ENABLED = 'true'
    env.FISCAL_LOCAL_VALIDATION_ENABLED = 'true'
    env.FISCAL_POLICY_IDS = '["10000000-0000-4000-8000-000000000043"]'
    await worker.queue(
      {
        messages: [{ body: { type: 'invoice.evaluate.requested', version: 2, eventId: 'x' }, ack, retry }]
      } as unknown as MessageBatch,
      env
    )
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('keeps replayed fiscal transport governed and emits the explicitly selected local validation intent only once', async () => {
    const opened: Parameters<typeof fiscalRuntimeWorld>[0] = []
    const w = await fiscalRuntimeWorld(opened)
    const env = bindings()
    env.DB = w.database
    env.APP_ENV = 'local'
    const ack = vi.fn(),
      retry = vi.fn(),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_traffic_forbidden')),
      put = vi.fn(async (key: string, bytes: Uint8Array) => ({ key, size: bytes.length }))
    env.MEDIA = { ...env.MEDIA, put } as unknown as R2Bucket
    const receive = () =>
      worker.queue(
        {
          messages: [
            {
              body: {
                type: 'invoice.evaluate.requested',
                version: 1,
                eventId: `invoice-evaluation:${w.order.orderId}`
              },
              ack,
              retry
            }
          ]
        } as unknown as MessageBatch,
        env
      )
    const remainsQueued = () => {
      expect(w.sqlite.prepare('SELECT status,attempts FROM fiscal_issuance_work').get()).toEqual({
        status: 'queued',
        attempts: 0
      })
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()?.n).toBe(0)
      expect(put).not.toHaveBeenCalled()
    }
    try {
      env.FISCAL_POLICY_IDS = JSON.stringify([w.policy.id])
      env.FISCAL_LOCAL_VALIDATION_ENABLED = 'true'
      await receive() // An approved/selected policy does not enable issuance.
      remainsQueued()
      env.FISCAL_ISSUANCE_ENABLED = 'false'
      await receive()
      remainsQueued()
      env.FISCAL_ISSUANCE_ENABLED = 'true'
      for (const selection of [undefined, '[]', '["10000000-0000-4000-8000-000000000043"]']) {
        env.FISCAL_POLICY_IDS = selection
        await receive()
        remainsQueued()
      }
      env.FISCAL_POLICY_IDS = JSON.stringify([w.policy.id])
      env.FISCAL_LOCAL_VALIDATION_ENABLED = undefined
      await receive()
      remainsQueued()
      env.FISCAL_LOCAL_VALIDATION_ENABLED = 'true'
      for (const environment of ['preview', 'production']) {
        env.APP_ENV = environment
        await receive()
        remainsQueued()
      }
      env.APP_ENV = 'local'
      await receive()
      await receive()
      expect(ack).toHaveBeenCalledTimes(10)
      expect(retry).not.toHaveBeenCalled()
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_documents').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT status FROM fiscal_issuance_work').get()?.status).toBe('completed')
      expect(
        w.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE event_type='invoice.issued'").get()?.n
      ).toBe(1)
      expect(put).toHaveBeenCalledOnce()
      expect(put.mock.calls[0]?.[0]).toMatch(/^fiscal\/[0-9a-f-]{36}\/[0-9a-f]{64}\.pdf$/)
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      for (const database of opened) database.close()
    }
  })

  it('keeps a potentially accepted invoice uncertain on an unconfirmed private R2 write and never reissues on replay', async () => {
    const opened: Parameters<typeof fiscalRuntimeWorld>[0] = []
    const w = await fiscalRuntimeWorld(opened)
    const env = bindings(),
      ack = vi.fn(),
      retry = vi.fn(),
      put = vi.fn(async () => undefined),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_traffic_forbidden'))
    env.DB = w.database
    env.APP_ENV = 'local'
    env.FISCAL_ISSUANCE_ENABLED = 'true'
    env.FISCAL_LOCAL_VALIDATION_ENABLED = 'true'
    env.FISCAL_POLICY_IDS = JSON.stringify([w.policy.id])
    env.MEDIA = { ...env.MEDIA, put } as unknown as R2Bucket
    const batch = {
      messages: [
        {
          body: { type: 'invoice.evaluate.requested', version: 1, eventId: `invoice-evaluation:${w.order.orderId}` },
          ack,
          retry
        }
      ]
    } as unknown as MessageBatch
    try {
      await worker.queue(batch, env)
      const uncertain = w.sqlite.prepare('SELECT status,generation,attempts FROM fiscal_issuance_work').get()
      expect(uncertain?.status).toBe('uncertain')
      await worker.queue(batch, env)
      expect(w.sqlite.prepare('SELECT status,generation,attempts FROM fiscal_issuance_work').get()).toEqual(uncertain)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_provider_receipts').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_documents').get()?.n).toBe(0)
      expect(
        w.sqlite.prepare("SELECT count(*) AS n FROM email_outbox_events WHERE event_type='invoice.issued'").get()?.n
      ).toBe(0)
      expect(put).toHaveBeenCalledOnce()
      expect(ack).toHaveBeenCalledTimes(2)
      expect(retry).not.toHaveBeenCalled()
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      for (const database of opened) database.close()
    }
  })

  it('does not grant fiscal authority from warehouse preparation or an unowned transport wakeup', async () => {
    const w = await fulfillmentFixture()
    const env = bindings(),
      ack = vi.fn(),
      retry = vi.fn(),
      password = 'synthetic-canary-fulfillment-cookie-at-least-32-characters',
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_traffic_forbidden'))
    try {
      const id = await w.order()
      env.DB = w.database
      env.APP_ENV = 'local'
      env.AUTH_ENABLED = 'true'
      env.AUTH_ORIGIN = 'https://neteco.invalid'
      env.NUXT_SESSION_PASSWORD = password
      env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
      env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) }
      env.FISCAL_ISSUANCE_ENABLED = 'true'
      env.FISCAL_LOCAL_VALIDATION_ENABLED = 'true'
      env.FISCAL_POLICY_IDS = '["10000000-0000-4000-8000-000000000043"]'
      const cookie = (await issueD1SessionCookie(w.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
      const response = await worker.fetch(
        new Request(`${env.AUTH_ORIGIN}/api/admin/orders/${id}/fulfillment/transitions`, {
          method: 'POST',
          headers: {
            cookie,
            origin: env.AUTH_ORIGIN,
            'cf-connecting-ip': '192.0.2.1',
            'content-type': 'application/json',
            'idempotency-key': 'synthetic-preparation'
          },
          body: JSON.stringify({ action: 'picking', expectedVersion: 0, reason: 'Synthetic warehouse preparation' })
        }),
        env
      )
      expect(response.status).toBe(200)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_outbox_events').get()?.n).toBe(0)
      await worker.queue(
        {
          messages: [
            {
              body: { type: 'invoice.evaluate.requested', version: 1, eventId: `invoice-evaluation:${id}` },
              ack,
              retry
            }
          ]
        } as unknown as MessageBatch,
        env
      )
      expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 })
      expect(ack).not.toHaveBeenCalled()
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_evaluation_inbox').get()?.n).toBe(0)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_invoice_intents').get()?.n).toBe(0)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_invoices').get()?.n).toBe(0)
      expect(env.MEDIA.get).not.toHaveBeenCalled()
      expect(env.MEDIA.put).not.toHaveBeenCalled()
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      w.sqlite.close()
    }
  })
  it.each(['local', 'preview', 'preprod', 'preproduction', 'canary', 'production'])(
    'reaches the private fiscal handler in the supported %s environment without enabling issuance',
    async (environment) => {
      const env = bindings()
      env.APP_ENV = environment
      env.AUTH_ENABLED = 'true'
      env.AUTH_ORIGIN = 'https://neteco.invalid'
      env.NUXT_SESSION_PASSWORD = 'test-only-session-configuration-with-more-than-32-characters'
      env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
      env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) }
      const response = await worker.fetch(
        new Request('https://neteco.invalid/api/admin/orders/80000000-0000-4000-8000-000000000001/fiscal', {
          headers: { 'cf-connecting-ip': '192.0.2.1' }
        }),
        env
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(env.DB.prepare).not.toHaveBeenCalled()
      expect(env.MEDIA.get).not.toHaveBeenCalled()
      expect(env.MEDIA.put).not.toHaveBeenCalled()
    }
  )

  it('runs scheduled recovery against all migrations without contacting disabled email providers', async () => {
    const database = await openMigratedDatabase()
    const env = bindings()
    env.DB = d1OverSqlite(database)
    const send = vi.fn()
    env.EMAIL = { send } as unknown as SendEmail
    env.NEWSLETTER_EMAIL = { send } as unknown as SendEmail
    env.TRANSACTIONAL_EMAIL_ENABLED = 'false'
    env.AUTH_EMAIL_ENABLED = 'false'
    env.NEWSLETTER_ENABLED = 'false'
    try {
      await worker.scheduled({ scheduledTime: Date.now() } as ScheduledController, env)
      expect(send).not.toHaveBeenCalled()
      expect(database.prepare('SELECT count(*) AS n FROM transactional_email_deliveries').get()?.n).toBe(0)
      expect(database.prepare('SELECT count(*) AS n FROM identity_lifecycle_deliveries').get()?.n).toBe(0)
    } finally {
      database.close()
    }
  })

  it('fails closed on private favorites and administrative reads while authentication is disabled', async () => {
    const env = bindings()
    for (const path of [
      '/api/account/favorites',
      '/api/admin/orders',
      '/api/admin/stats',
      '/api/admin/operations',
      '/api/admin/prices',
      '/api/admin/prices/example',
      '/api/admin/catalog/policies',
      '/api/admin/catalog/policies/example/withdraw',
      '/api/admin/products/1/publication-policy',
      '/api/admin/products/1/identifier-exceptions',
      ...policyNamespaceAliases
    ]) {
      const response = await worker.fetch(new Request(`https://neteco.invalid${path}`), env)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe(
        path.startsWith('/api/admin/prices') ? 'private, no-store' : 'no-store'
      )
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('blocks administrative reads on edge denial before checking sessions or D1', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    const response = await worker.fetch(
      new Request('https://neteco.invalid/api/admin/orders', {
        headers: { 'cf-connecting-ip': '192.0.2.1' }
      }),
      env
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('owns new operational namespaces while authentication is disabled, before reading bodies or D1', async () => {
    const env = bindings()
    const id = '80000000-0000-4000-8000-000000000001'
    for (const path of [
      '/api/admin/content/pages',
      '/api/admin/content/pages/unsupported/publish',
      `/api/admin/orders/${id}/fulfillment`,
      `/api/admin/orders/${id}/fulfillment/transitions`,
      `/api/admin/orders/${id}/packing`,
      `/api/admin/orders/${id}/packing/commands`,
      `/api/admin/orders/${id}/packing/commands/${id}`,
      `/api/admin/orders/${id}/%70acking`,
      `/api/admin/orders/${id}/packing%2Fcommands`,
      '/api/admin/fiscal/policies',
      `/api/admin/orders/${id}/fiscal`,
      `/api/orders/${id}/invoice`,
      '/api/admin/returns',
      '/api/admin/returns/RMA-synthetic',
      '/api/%61dmin/returns',
      '/api/admin/%2572eturns',
      `/api/orders/${id}/returns`,
      `/api/orders/${id}/%72eturns`,
      `/api/orders/${id}/%2572eturns`
    ]) {
      const request = new Request(`https://neteco.invalid${path}`, { method: 'POST', body: 'untrusted' })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('owns tracking for customers and administrators before auth, cookies, bodies or D1', async () => {
    const id = '80000000-0000-4000-8000-000000000001'
    for (const administrative of [false, true]) {
      const env = bindings()
      const limit = vi.fn().mockResolvedValue({ success: false })
      env.ADMIN_EDGE_LIMIT = { limit: vi.fn() }
      env.AUTH_EDGE_LIMIT = { limit: vi.fn() }
      env.AUTH_RATE_LIMIT_PEPPER = 'local-tracking-edge-test-pepper-more-than-32'
      if (administrative) env.ADMIN_EDGE_LIMIT = { limit }
      else env.AUTH_EDGE_LIMIT = { limit }
      for (const segment of ['tracking', '%74racking', '%2574racking', 'TRACKING', 'tracking%2Funsupported']) {
        const path = `/api/${administrative ? 'admin/' : ''}orders/${id}/${segment}`
        const disabled = new Request(`https://neteco.invalid${path}`, { method: 'POST', body: 'untrusted' })
        expect((await worker.fetch(disabled, env)).status).toBe(503)
        expect(disabled.bodyUsed).toBe(false)
        env.AUTH_ENABLED = 'true'
        const limited = new Request(`https://neteco.invalid${path}`, {
          method: 'POST',
          headers: { 'cf-connecting-ip': '192.0.2.1', cookie: 'neteco-session=untrusted' },
          body: 'untrusted'
        })
        expect((await worker.fetch(limited, env)).status).toBe(429)
        expect(limited.bodyUsed).toBe(false)
        env.AUTH_ENABLED = 'false'
      }
      expect(limit).toHaveBeenCalledTimes(5)
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
  })

  it('keeps encoded administrative tracking aliases on the administrative edge gate', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'local-tracking-edge-test-pepper-more-than-32'
    const limit = vi.fn().mockResolvedValue({ success: false })
    env.ADMIN_EDGE_LIMIT = { limit }
    env.AUTH_EDGE_LIMIT = { limit: vi.fn() }
    const id = '80000000-0000-4000-8000-000000000001'
    for (const prefix of ['%61dmin/orders', 'admin/%6frders', '%2561dmin/orders', 'ADMIN/orders']) {
      const response = await worker.fetch(
        new Request(`https://neteco.invalid/api/${prefix}/${id}/tracking`, {
          headers: { 'cf-connecting-ip': '192.0.2.1', cookie: 'neteco-session=untrusted' }
        }),
        env
      )
      expect(response.status).toBe(429)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect(limit).toHaveBeenCalledTimes(4)
    expect(env.AUTH_EDGE_LIMIT.limit).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('limits new administrative workflows before reading cookies, commands or D1', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    const id = '80000000-0000-4000-8000-000000000001'
    for (const path of [
      '/api/admin/content/pages',
      `/api/admin/orders/${id}/fulfillment/transitions`,
      `/api/admin/orders/${id}/packing/commands`,
      `/api/admin/orders/${id}/%70acking/commands`,
      '/api/admin/fiscal/requests',
      '/api/admin/returns',
      '/api/%61dmin/returns',
      '/api/admin/%2572eturns'
    ]) {
      const request = new Request(`https://neteco.invalid${path}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1' },
        body: 'untrusted'
      })
      expect((await worker.fetch(request, env)).status).toBe(429)
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('uses the customer edge gate for canonical and encoded returns before cookie, body or D1 reads', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) }
    env.CART_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    const id = '80000000-0000-4000-8000-000000000001'
    for (const segment of ['returns', '%72eturns', '%2572eturns']) {
      const request = new Request(`https://neteco.invalid/api/orders/${id}/${segment}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1', cookie: 'neteco-session=untrusted' },
        body: 'untrusted'
      })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(429)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.CART_EDGE_LIMIT.limit).toHaveBeenCalledTimes(3)
    expect(env.ADMIN_EDGE_LIMIT.limit).not.toHaveBeenCalled()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('blocks price namespace requests before sessions, D1 or bodies when edge limits deny access', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    for (const path of ['/api/admin/prices', '/api/admin/prices/example']) {
      const request = new Request(`https://neteco.invalid${path}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1' },
        body: 'untrusted'
      })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(429)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('blocks catalog policy namespaces before cookie, D1 and body reads on edge denial', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    for (const path of [
      '/api/admin/catalog/policies',
      '/api/admin/catalog/policies/example/withdraw',
      '/api/admin/products/1/publication-policy',
      '/api/admin/products/1/identifier-exceptions',
      '/api/admin/products/1/identifier-exceptions/example/withdraw',
      ...policyNamespaceAliases
    ]) {
      const request = new Request(`https://neteco.invalid${path}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1' },
        body: 'untrusted'
      })
      expect((await worker.fetch(request, env)).status).toBe(429)
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('reserves encoded policy aliases at ingress but never accepts them as canonical routes', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_ORIGIN = 'https://neteco.invalid'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) }
    for (const path of policyNamespaceAliases) {
      const request = new Request(`https://neteco.invalid${path}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1', origin: env.AUTH_ORIGIN },
        body: 'untrusted'
      })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.ADMIN_EDGE_LIMIT.limit).toHaveBeenCalledTimes(policyNamespaceAliases.length)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('requires a signed session for price reads without querying D1', async () => {
    const env = bindings()
    env.AUTH_ENABLED = 'true'
    env.AUTH_ORIGIN = 'https://neteco.invalid'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.NUXT_SESSION_PASSWORD = 'test-only-session-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: true })) }
    const response = await worker.fetch(
      new Request('https://neteco.invalid/api/admin/prices', { headers: { 'cf-connecting-ip': '192.0.2.1' } }),
      env
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('keeps price writes disabled without consuming bodies while authentication is disabled', async () => {
    const env = bindings()
    const request = new Request('https://neteco.invalid/api/admin/prices', { method: 'POST', body: 'untrusted' })
    expect((await worker.fetch(request, env)).status).toBe(503)
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('keeps newsletter delivery disabled without consuming a body or writing D1', async () => {
    const env = bindings()
    const request = new Request('https://neteco.invalid/api/newsletter/subscribe', {
      method: 'POST',
      body: 'untrusted'
    })
    const response = await worker.fetch(request, env)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: 'newsletter_unavailable' } })
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('keeps authentication disabled without reading bodies or invoking D1', async () => {
    const env = bindings()
    for (const path of [
      '/api/auth/login',
      '/api/auth/mfa/complete',
      '/api/auth/logout',
      '/api/auth/register',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/verify-email',
      '/api/account/email-change'
    ]) {
      const request = new Request(`https://neteco.invalid${path}`, { method: 'POST', body: 'untrusted' })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: {
          code: ['/api/auth/login', '/api/auth/mfa/complete', '/api/auth/logout'].includes(path)
            ? 'authentication_unavailable'
            : 'identity_lifecycle_unavailable'
        }
      })
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('blocks native edge-limit denials before cookie verification, D1 or body reads', async () => {
    const env = bindings()
    env.MEDIA_ADMIN_ENABLED = 'true'
    env.MEDIA_ADMIN_ORIGIN = 'https://neteco.invalid'
    env.NUXT_SESSION_PASSWORD = 'test-only-session-secret-with-at-least-32-characters'
    env.AUTH_RATE_LIMIT_PEPPER = 'test-only-edge-secret-with-at-least-32-characters'
    env.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    const request = new Request('https://neteco.invalid/api/admin/media', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '192.0.2.1' },
      body: 'untrusted'
    })
    const response = await worker.fetch(request, env)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })
  it('keeps administrative uploads disabled without explicitly configured access', async () => {
    const env = bindings()
    const request = new Request('https://canary.neteco.invalid/api/admin/media', { method: 'POST', body: 'untrusted' })
    const response = await worker.fetch(request, env)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: 'media_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  })
  it('reports every required binding without mutating queues, KV, R2 or Durable Objects', async () => {
    const env = bindings()
    const result = await inspectCanaryBindings(env)

    expect(result.ok).toBe(true)
    expect(result.checks).toEqual({
      d1: { ok: true },
      durableObjects: { ok: true },
      inventory: { ok: true },
      carts: { ok: true },
      cartRateLimit: { ok: true },
      kv: { ok: true },
      queues: { ok: true },
      r2: { ok: true },
      workflows: { ok: true }
    })
    expect(env.ASYNC_JOBS.send).not.toHaveBeenCalled()
    expect(env.CACHE.put).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(env.COORDINATOR.get).not.toHaveBeenCalled()
    expect(env.CARTS.get).not.toHaveBeenCalled()
    expect(env.CATALOG_WORKFLOW.create).not.toHaveBeenCalled()
  })

  it('returns 503 and no-store when the D1 probe fails', async () => {
    const response = await worker.fetch(new Request('https://canary.neteco.invalid/health'), bindings({ d1Ok: false }))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ ok: false, checks: { d1: { ok: false } } })
  })

  it('does not expose routes other than the health probe', async () => {
    const response = await worker.fetch(new Request('https://canary.neteco.invalid/'), bindings())
    expect(response.status).toBe(404)
  })

  it('serves categories from D1 with an explicit public cache policy', async () => {
    const response = await worker.fetch(
      new Request('https://canary.neteco.invalid/api/categories'),
      bindings({
        categories: [
          {
            id: 7,
            name: 'Productos químicos',
            slug: 'productos-quimicos',
            parentId: null,
            sort: 7,
            directCount: 0
          }
        ]
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300')
    await expect(response.json()).resolves.toMatchObject({ roots: [{ id: 7, count: 0 }] })
  })

  it('turns a D1 catalog failure into a generic, private 503 response', async () => {
    const response = await worker.fetch(
      new Request('https://canary.neteco.invalid/api/categories'),
      bindings({ categoryError: new Error('sensitive D1 detail') })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'catalog_unavailable' })
  })
})
