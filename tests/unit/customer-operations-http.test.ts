import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { environment } from '../support/customer-operations-fixture'
import { handleCustomerOperationsHttp } from '../../workers/runtime/customer-operations-http'
import worker from '../../workers/canary'
import { supportFixture, ORIGIN, CONTACT, POLICY } from './d1-support-fixture'
import { refundsCreditFixture, CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { dispatchCustomerFinancialOperations } from '../../workers/runtime/customer-operations-dispatch'
import { executeSupportAdminCommand } from '../../workers/support/operations'

afterEach(() => vi.restoreAllMocks())
const owned = [
  ['/api/admin/refunds/requests', 503],
  ['/api/admin/credits/policies', 503],
  ['/api/orders/10000000-0000-4000-8000-000000000048/refunds', 503],
  ['/api/admin/support', 503],
  ['/api/account/support', 503],
  ['/api/account/satisfaction/support/SOP-000000000000000000000001', 503],
  ['/api/account/satisfaction/delivery/10000000-0000-4000-8000-000000000048', 503],
  ['/api/account/%73atisfaction/support/SOP-000000000000000000000001', 503],
  ['/api/account/satisfaction%2Fdelivery/10000000-0000-4000-8000-000000000048', 503],
  ['/api/support/options', 503],
  ['/api/admin/newsletter', 405],
  ['/api/account/newsletter/preferences', 405],
  ['/api/newsletter/preferences', 405],
  ['/api/newsletter/preferences/access', 501],
  ['/api/webhooks/newsletter', 501],
  ['/%61pi/admin/refunds/requests', 503],
  ['/api/admin/%73upport', 503],
  ['/api/admin/%256eewsletter', 400],
  ['/api/newsletter/preferences%2Faccess', 400]
]
describe('root Worker customer-operation namespaces', () => {
  it('routes satisfaction through the actual Worker with configured privacy, live ownership and support grants', async () => {
    const w = await supportFixture()
    try {
      w.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0068_support_satisfaction.sql', import.meta.url), 'utf8')
      )
      const ticket = await w.ticket()
      await executeSupportAdminCommand(
        w.database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'update',
          expectedVersion: 1,
          reason: 'Revisión de atención sintética',
          state: 'resolved',
          priority: 'normal',
          ownerId: null,
          nextActionAt: null,
          slaDueAt: null,
          resolution: 'Consulta resuelta tras comprobación sintética.'
        },
        { idempotencyKey: crypto.randomUUID() }
      )
      const before = w.economic()
      const env = environment({
        DB: w.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: ORIGIN,
        SUPPORT_ENABLED: 'true',
        SUPPORT_POLICY: JSON.stringify(POLICY),
        NUXT_SESSION_PASSWORD: w.deps.sessionCookieConfiguration!.password
      })
      const send = (path: string, cookie: string, body?: unknown, key = crypto.randomUUID()) =>
        worker.fetch(
          new Request(ORIGIN + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              cookie,
              'cf-connecting-ip': '192.0.2.68',
              ...(body === undefined
                ? {}
                : {
                    origin: ORIGIN,
                    'content-type': 'application/json',
                    'idempotency-key': key
                  })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
          }),
          env
        )
      const path = '/api/account/satisfaction/support/' + ticket.publicRef
      const eligible = await send(path, w.customerCookie)
      expect(eligible.status).toBe(200)
      expect(eligible.headers.get('cache-control')).toBe('private, no-store')
      const state = (await eligible.json()) as { privacy: { policyHash: string } }
      expect(state).toMatchObject({
        source: 'cloudflare',
        eligible: true,
        target: { kind: 'support', id: ticket.publicRef, version: 2 },
        privacy: { noticePath: POLICY.privacyNoticePath }
      })
      const key = crypto.randomUUID()
      const input = {
        score: 5,
        comment: 'Atención útil, valoración sintética privada.',
        privacyAcknowledged: true,
        expectedSourceVersion: 2,
        expectedPolicyHash: state.privacy.policyHash
      }
      const submitted = await send(path, w.customerCookie, input, key)
      expect(submitted.status).toBe(201)
      const receipt = await submitted.json()
      expect(receipt).toMatchObject({ commandId: key, score: 5, inventoryEffect: 'none', economicEffect: 'none' })
      expect(await (await send(path, w.customerCookie, input, key)).json()).toEqual(receipt)
      const overview = await send('/api/admin/support/satisfaction', w.adminCookie)
      expect(overview.status).toBe(200)
      expect(await overview.json()).toMatchObject({
        source: 'cloudflare',
        commentsIncluded: false,
        stats: { count: 1, average: 5 }
      })
      w.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='support.manage'")
      expect((await send('/api/admin/support/satisfaction', w.adminCookie)).status).toBe(403)
      expect(w.economic()).toEqual(before)
    } finally {
      w.sqlite.close()
    }
  })

  it.each([
    { SUPPORT_ENABLED: 'true', AUTH_ENABLED: 'false' },
    { SUPPORT_ENABLED: 'false', AUTH_ENABLED: 'true' }
  ])('keeps satisfaction closed before reading credentials or bodies when %j', async (flags) => {
    const env = environment(flags)
    for (const path of [
      '/api/account/satisfaction/support/SOP-000000000000000000000001',
      '/api/account/satisfaction/delivery/10000000-0000-4000-8000-000000000048',
      '/api/admin/support/satisfaction'
    ]) {
      const request = new Request('https://neteco.invalid' + path, { method: 'POST', body: 'unparsed' })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(request.bodyUsed).toBe(false)
    }
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
    expect(env.ADMIN_EDGE_LIMIT.limit).not.toHaveBeenCalled()
    expect(env.CART_EDGE_LIMIT.limit).not.toHaveBeenCalled()
  })

  it('executes governed HTTP refund and corrective saga once through selected runtime providers, without stock effects or external calls', async () => {
    const w = await refundsCreditFixture(),
      password = 'synthetic-financial-session-cookie-password-0123456789abcdef'
    const cookie = (await issueD1SessionCookie(w.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    const env = environment({
        DB: w.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: ORIGIN,
        NUXT_SESSION_PASSWORD: password,
        REFUNDS_ENABLED: 'true',
        REFUND_DISPATCH_ENABLED: 'true',
        REFUND_LOCAL_VALIDATION_ENABLED: 'true',
        REFUND_POLICY_IDS: JSON.stringify([w.policy.id]),
        CREDIT_DISPATCH_ENABLED: 'true',
        CREDIT_LOCAL_VALIDATION_ENABLED: 'true',
        CREDIT_POLICY_IDS: JSON.stringify([w.creditPolicy.id]),
        MEDIA: {
          put: vi.fn(async (key: string, bytes: Uint8Array) => {
            w.objects.set(key, Uint8Array.from(bytes))
            return { key, size: bytes.length }
          }),
          get: vi.fn(async (key: string) => {
            const bytes = w.objects.get(key)
            return bytes ? { key, size: bytes.length, body: new Response(Uint8Array.from(bytes)).body } : null
          })
        }
      }),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden'))
    const inventory = w.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()
    const movements = w.sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all()
    const post = (path: string, body: unknown) =>
      worker.fetch(
        new Request(ORIGIN + path, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'cf-connecting-ip': '192.0.2.48', 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }),
        env
      )
    try {
      const input = {
        idempotencyKey: 'root-refund-plan',
        policyId: w.policy.id,
        returnPublicRef: w.returnRef,
        expectedReturnVersion: 5,
        reason: REASON,
        evidenceRef: 'synthetic-reviewed-rma',
        lines: [{ lineIndex: 0, quantity: 1 }]
      }
      const planned = await post('/api/admin/refunds/requests', input)
      expect(planned.status).toBe(202)
      const receipt = (await planned.json()) as { id: string; generation: number; contractFingerprint: string }
      expect(await (await post('/api/admin/refunds/requests', input)).json()).toEqual(receipt)
      expect(
        (
          await post(`/api/admin/refunds/${receipt.id}/confirm`, {
            idempotencyKey: 'root-refund-confirm',
            expectedGeneration: receipt.generation,
            contractFingerprint: receipt.contractFingerprint,
            reason: REASON,
            evidenceRef: 'synthetic-explicit-confirmation'
          })
        ).status
      ).toBe(200)
      expect((await dispatchCustomerFinancialOperations(env, utc())).refundsCompleted).toBe(1)
      expect((await dispatchCustomerFinancialOperations(env, utc())).refundsCompleted).toBe(0)
      const queued = await post(`/api/admin/refunds/${receipt.id}/credit`, {
        idempotencyKey: 'root-credit-queue',
        policyId: w.creditPolicy.id,
        reason: REASON,
        evidenceRef: 'synthetic-confirmed-refund-proof'
      })
      expect(queued.status).toBe(202)
      const credit = (await queued.json()) as { id: string }
      expect((await dispatchCustomerFinancialOperations(env, utc())).creditsCompleted).toBe(1)
      expect((await dispatchCustomerFinancialOperations(env, utc())).creditsCompleted).toBe(0)
      const pdf = await worker.fetch(
        new Request(`${ORIGIN}/api/admin/orders/${w.orderId}/credits/${credit.id}/pdf`, {
          headers: { cookie, 'cf-connecting-ip': '192.0.2.48' }
        }),
        env
      )
      expect(pdf.status).toBe(200)
      expect(pdf.headers.get('cache-control')).toContain('no-store')
      expect(pdf.headers.get('content-type')).toBe('application/pdf')
      expect(await pdf.text()).toContain('NOT A FISCAL DOCUMENT')
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_credits').get()?.n).toBe(1)
      expect(w.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()).toEqual(
        inventory
      )
      expect(w.sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all()).toEqual(movements)
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      w.sqlite.close()
    }
  })
  it.each(owned)(
    'claims disabled %s without body reads, D1, sender, provider or legacy fallback',
    async (path, status) => {
      const env = environment(),
        outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden'))
      const request = new Request('https://neteco.invalid' + path, { method: 'POST', body: 'deliberately-unparsed' })
      const response = await worker.fetch(request, env)
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(request.bodyUsed).toBe(false)
      expect(env.DB.prepare).not.toHaveBeenCalled()
      expect(env.DB.batch).not.toHaveBeenCalled()
      expect(env.NEWSLETTER_EMAIL.send).not.toHaveBeenCalled()
      expect(outbound).not.toHaveBeenCalled()
    }
  )
  it('does not claim unrelated catalog, login, RMA or ordinary fiscal routes', async () => {
    for (const path of [
      '/api/products',
      '/api/auth/login',
      '/api/orders/x/returns',
      '/api/admin/fiscal/policies',
      '/api/newsletter/confirm'
    ])
      expect(await handleCustomerOperationsHttp(new Request('https://neteco.invalid' + path), environment())).toBeNull()
  })
  it('fails configuration closed without exposing values or parsing hostile bodies', async () => {
    const env = environment({
        SUPPORT_ENABLED: 'true',
        SUPPORT_POLICY: '{secret-private-fixture',
        AUTH_ORIGIN: ORIGIN
      }),
      request = new Request(ORIGIN + '/api/support/tickets', { method: 'POST', body: 'unparsed' })
    const result = await handleCustomerOperationsHttp(request, env)
    expect(result!.status).toBe(503)
    expect(await result!.text()).not.toContain('secret-private-fixture')
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('requires auth activation and trusted edge observation before refund bodies or SQL', async () => {
    for (const overrides of [{ AUTH_ENABLED: 'false' }, { AUTH_ENABLED: 'true', AUTH_RATE_LIMIT_PEPPER: 'short' }]) {
      const env = environment({ REFUNDS_ENABLED: 'true', ...overrides }),
        request = new Request('https://neteco.invalid/api/admin/refunds/requests', {
          method: 'POST',
          headers: { origin: 'https://neteco.invalid' },
          body: 'unparsed'
        })
      const response = await handleCustomerOperationsHttp(request, env)
      expect(response!.status).toBe(503)
      expect(request.bodyUsed).toBe(false)
      expect(env.DB.prepare).not.toHaveBeenCalled()
    }
  })
  it('rejects an unsealed admin refund command before reading its body', async () => {
    const env = environment({ REFUNDS_ENABLED: 'true', AUTH_ENABLED: 'true' }),
      request = new Request('https://neteco.invalid/api/admin/refunds/requests', {
        method: 'POST',
        headers: { origin: 'https://neteco.invalid', 'cf-connecting-ip': '192.0.2.48' },
        body: 'unparsed'
      })
    expect((await handleCustomerOperationsHttp(request, env))!.status).toBe(401)
    expect(request.bodyUsed).toBe(false)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('creates an actual anonymous support ticket with policy/cookie/quota and no economic changes', async () => {
    const w = await supportFixture(),
      env = environment({
        DB: w.database,
        SUPPORT_ENABLED: 'true',
        SUPPORT_POLICY: JSON.stringify(POLICY),
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: w.deps.sessionCookieConfiguration!.password,
        AUTH_ORIGIN: ORIGIN
      }),
      before = w.economic(),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden'))
    try {
      const options = await worker.fetch(
        new Request(ORIGIN + '/api/support/options', { headers: { 'cf-connecting-ip': '192.0.2.49' } }),
        env
      )
      expect(options.status).toBe(200)
      const cookie = options.headers.get('set-cookie')!.split(';')[0]!
      expect(cookie).toMatch(/^neteco-support-intake-v1=/)
      const request = () =>
        new Request(ORIGIN + '/api/support/tickets', {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'cf-connecting-ip': '192.0.2.49',
            cookie,
            'content-type': 'application/json',
            'idempotency-key': 'root-anonymous-ticket'
          },
          body: JSON.stringify({ ...CONTACT, orderReference: 'DECLARED-NOT-OWNERSHIP' })
        })
      const created = await worker.fetch(request(), env),
        body = (await created.json()) as { publicRef: string }
      expect(created.status).toBe(201)
      const replay = await worker.fetch(request(), env)
      expect(replay.status).toBe(201)
      expect(await replay.json()).toEqual(body)
      expect(w.sqlite.prepare('SELECT customer_id,order_id FROM support_tickets').get()).toEqual({
        customer_id: null,
        order_id: null
      })
      expect(w.sqlite.prepare('SELECT actor_type FROM support_commands').get()?.actor_type).toBe('anonymous')
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM support_tickets').get()?.n).toBe(1)
      expect(w.economic()).toEqual(before)
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      w.sqlite.close()
    }
  })
  it('uses live support permission rather than administration role or body actor claims', async () => {
    const w = await supportFixture(),
      env = environment({
        DB: w.database,
        SUPPORT_ENABLED: 'true',
        SUPPORT_POLICY: JSON.stringify(POLICY),
        AUTH_ENABLED: 'true',
        NUXT_SESSION_PASSWORD: w.deps.sessionCookieConfiguration!.password,
        AUTH_ORIGIN: ORIGIN
      })
    try {
      const request = () =>
        new Request(ORIGIN + '/api/admin/support', {
          headers: { cookie: w.adminCookie, 'cf-connecting-ip': '192.0.2.49' }
        })
      expect((await worker.fetch(request(), env)).status).toBe(200)
      w.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='support.manage'")
      expect((await worker.fetch(request(), env)).status).toBe(403)
      expect(
        (
          await worker.fetch(
            new Request(ORIGIN + '/api/admin/support', {
              headers: { cookie: w.customerCookie, 'cf-connecting-ip': '192.0.2.49' }
            }),
            env
          )
        ).status
      ).toBe(403)
    } finally {
      w.sqlite.close()
    }
  })
})
