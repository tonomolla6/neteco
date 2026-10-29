import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { refundsCreditFixture, CLAIMS, BUYER_CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  configuredCreditProvider,
  configuredRefundProvider,
  customerEmailConfiguration,
  customerEmailRenderers,
  type CustomerOperationsEnv
} from '../../workers/runtime/customer-operations-config'
import { dispatchCustomerFinancialOperations } from '../../workers/runtime/customer-operations-dispatch'
import { handleCustomerOperationsHttp } from '../../workers/runtime/customer-operations-http'
import { approveRefundPolicy, approveCreditPolicy, withdrawFinancialPolicy } from '../../workers/refunds/policies'
import { readRefundContract } from '../../workers/refunds/operations'
import { PersistentLocalRefundProvider } from '../../workers/refunds/local-provider'
import { PersistentLocalCreditProvider } from '../../workers/fiscal/local-credit-provider'
import { WorkerRedsysRefundProvider } from '../../workers/refunds/redsys-provider'
import { queueD1CreditNote } from '../../workers/fiscal/credit-notes'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'

type World = Awaited<ReturnType<typeof refundsCreditFixture>>
const ORIGIN = 'https://financial-authority.neteco.test'
const PASSWORD = 'synthetic-financial-audit-cookie-password-0123456789abcdef'
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  vi.restoreAllMocks()
})
async function world() {
  const fixture = await refundsCreditFixture()
  await applyDeliveryPreferencesMigration(fixture.sqlite)
  opened.push(fixture.sqlite)
  return fixture
}
function runtime(w: World, overrides: Record<string, unknown> = {}): CustomerOperationsEnv {
  return environment({
    DB: w.database,
    AUTH_ORIGIN: ORIGIN,
    AUTH_ENABLED: 'true',
    NUXT_SESSION_PASSWORD: PASSWORD,
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
    },
    ...overrides
  })
}
async function cookie(w: World, claims = CLAIMS) {
  return (await issueD1SessionCookie(w.database, claims, { password: PASSWORD, maxAgeSeconds: 3600 }))!.split(';')[0]!
}
function request(path: string, body?: unknown, sealed = '') {
  return new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: sealed,
      origin: ORIGIN,
      'cf-connecting-ip': '192.0.2.148',
      'content-type': 'application/json'
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  })
}
function planInput(w: World) {
  return {
    idempotencyKey: 'financial-authority-original-plan',
    policyId: w.policy.id,
    returnPublicRef: w.returnRef,
    expectedReturnVersion: 5,
    reason: REASON,
    evidenceRef: 'synthetic-reviewed-historical-rma',
    lines: [{ lineIndex: 0, quantity: 1 }]
  }
}
function policyInput(w: World) {
  const { id: _id, fingerprint: _fingerprint, approvedAt: _approvedAt, ...input } = w.policy
  return input
}
async function queued(w: World, quantity = 1) {
  const planned = await w.plan(quantity)
  await w.confirm(planned.id, planned.generation, planned.contractFingerprint)
  return planned
}
async function corrective(w: World, env = runtime(w)) {
  const refund = await queued(w)
  expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ refundsCompleted: 1 })
  const credit = await queueD1CreditNote(w.database, CLAIMS, refund.id, {
    idempotencyKey: 'financial-authority-credit-request',
    policyId: w.creditPolicy.id,
    reason: REASON,
    evidenceRef: 'synthetic-confirmed-refund-and-original'
  })
  expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ creditsCompleted: 1 })
  return { refund, credit, env }
}

describe('independent mounted financial authority audit — synthetic SQLite only', () => {
  it('acknowledges invalid financial Queue commands and stores/replays email transport without executing money, documents or sender', async () => {
    const w = await world(),
      refund = await w.completed(),
      env = runtime(w),
      provider = vi.spyOn(PersistentLocalRefundProvider.prototype, 'refund'),
      creditProvider = vi.spyOn(PersistentLocalCreditProvider.prototype, 'issueCreditNote'),
      prepare = vi.spyOn(w.database, 'prepare'),
      senderAccess = vi.fn(() => {
        throw new Error('unexpected_sender_binding_access')
      }),
      invalid = {
        body: { type: 'refund.execute.requested', refundId: refund.id, amountCents: 999999 },
        ack: vi.fn(),
        retry: vi.fn()
      }
    Object.defineProperty(env, 'EMAIL', { get: senderAccess })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await worker.queue({ messages: [invalid] } as unknown as MessageBatch, env)
    expect(invalid.ack).toHaveBeenCalledTimes(1)
    expect(invalid.retry).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    const event = w.sqlite.prepare('SELECT id FROM email_outbox_events WHERE source_id=?').get(refund.id)
    let observed = 0
    await publishEmailOutbox(
      w.database,
      {
        async send(body) {
          if (body.eventId !== event?.id) return
          const delivered = { body, ack: vi.fn(), retry: vi.fn() }
          await worker.queue({ messages: [delivered] } as unknown as MessageBatch, env)
          await worker.queue({ messages: [delivered] } as unknown as MessageBatch, env)
          expect(delivered.ack).toHaveBeenCalledTimes(2)
          expect(delivered.retry).not.toHaveBeenCalled()
          observed++
        }
      },
      { now: utc() }
    )
    expect(observed).toBe(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM email_dispatch_inbox').get()?.n).toBe(1)
    expect(w.sqlite.prepare('SELECT status,attempts FROM transactional_email_deliveries').all()).toEqual([
      { status: 'pending', attempts: 0 }
    ])
    expect(provider).not.toHaveBeenCalled()
    expect(creditProvider).not.toHaveBeenCalled()
    expect(senderAccess).not.toHaveBeenCalled()
    expect(env.MEDIA.get).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
  })

  it('keeps real queued and interrupted markers untouched when financial gates are OFF or policies unselected', async () => {
    const w = await world(),
      refund = await queued(w),
      at = utc(-120000)
    // Only a synthetic interrupted local marker, not evidence of a bank call.
    w.sqlite
      .prepare(
        "UPDATE refund_work SET status='submitting',generation=generation+1,lease_token=?,lease_until=?,submitted_at=? WHERE refund_id=?"
      )
      .run(crypto.randomUUID(), at, at, refund.id)
    const before = w.sqlite.prepare('SELECT * FROM refund_work').all(),
      prepare = vi.spyOn(w.database, 'prepare'),
      provider = vi.spyOn(PersistentLocalRefundProvider.prototype, 'refund'),
      creditProvider = vi.spyOn(PersistentLocalCreditProvider.prototype, 'issueCreditNote'),
      env = runtime(w),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden'))
    for (const patch of [
      { REFUNDS_ENABLED: 'false' },
      { REFUND_DISPATCH_ENABLED: 'false', CREDIT_DISPATCH_ENABLED: 'false' },
      { REFUND_POLICY_IDS: '[]', CREDIT_POLICY_IDS: '[]' }
    ]) {
      await dispatchCustomerFinancialOperations({ ...env, ...patch }, utc())
      expect(prepare).not.toHaveBeenCalled()
      expect(w.sqlite.prepare('SELECT * FROM refund_work').all()).toEqual(before)
    }
    expect(provider).not.toHaveBeenCalled()
    expect(creditProvider).not.toHaveBeenCalled()
    expect(env.MEDIA.get).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
    expect(outbound).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'expired', 'mfa'])(
    'mounted root rejects current %s authority loss before reading any replay or hostile body',
    async (loss) => {
      const w = await world(),
        sealed = await cookie(w),
        env = runtime(w),
        original = request('/api/admin/refunds/requests', planInput(w), sealed)
      expect((await worker.fetch(original, env)).status).toBe(202)
      const commands = w.sqlite.prepare('SELECT count(*) AS n FROM financial_commands').get()
      if (loss === 'revoked')
        w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
      if (loss === 'expired')
        w.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
      if (loss === 'mfa') w.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
      const prepare = vi.spyOn(w.database, 'prepare'),
        incoming = request('/api/admin/refunds/requests', 'private-unparsed-replay-body', sealed),
        response = await worker.fetch(incoming, env)
      expect(response.status).toBe(loss === 'mfa' ? 403 : 401)
      expect(incoming.bodyUsed).toBe(false)
      expect(prepare.mock.calls.some(([sql]) => sql.includes('FROM financial_commands'))).toBe(false)
      expect(await response.text()).not.toContain('private-unparsed-replay-body')
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM financial_commands').get()).toEqual(commands)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
    }
  )

  it('does not release a private persisted replay after revocation during its awaited read', async () => {
    const w = await world(),
      sealed = await cookie(w),
      input = planInput(w)
    expect((await worker.fetch(request('/api/admin/refunds/requests', input, sealed), runtime(w))).status).toBe(202)
    const rawPrepare = w.database.prepare.bind(w.database)
    let revoked = false
    const database = {
      ...w.database,
      prepare(sql: string) {
        const statement = rawPrepare(sql)
        if (!sql.includes('FROM financial_commands')) return statement
        const wrapped = {
          ...statement,
          bind(...bindings: unknown[]) {
            statement.bind(...bindings)
            return wrapped
          },
          async first() {
            const result = await statement.first()
            w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
            revoked = true
            return result
          }
        }
        return wrapped as D1PreparedStatement
      }
    } as D1Database
    const response = await worker.fetch(
      request('/api/admin/refunds/requests', input, sealed),
      runtime(w, { DB: database })
    )
    expect(revoked).toBe(true)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_contracts').get()?.n).toBe(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
  })

  it('uses separate HMAC ingress scopes and rejects quota before SQL, body or private storage', async () => {
    const adminLimit = vi.fn(async () => ({ success: false })),
      customerLimit = vi.fn(async () => ({ success: false })),
      env = environment({
        AUTH_ORIGIN: ORIGIN,
        AUTH_ENABLED: 'true',
        REFUNDS_ENABLED: 'true',
        ADMIN_EDGE_LIMIT: { limit: adminLimit },
        CART_EDGE_LIMIT: { limit: customerLimit }
      })
    for (const path of ['/api/admin/refunds/requests', '/api/orders/10000000-0000-4000-8000-000000000048/refunds']) {
      const incoming = request(path, 'private-unparsed-rate-limited-body'),
        response = await handleCustomerOperationsHttp(incoming, env)
      expect(response!.status).toBe(429)
      expect(incoming.bodyUsed).toBe(false)
    }
    expect(adminLimit).toHaveBeenCalledTimes(1)
    expect(customerLimit).toHaveBeenCalledTimes(1)
    expect(adminLimit.mock.calls[0]).not.toEqual(customerLimit.mock.calls[0])
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.DB.batch).not.toHaveBeenCalled()
    expect(env.MEDIA.get).not.toHaveBeenCalled()
    expect(env.MEDIA.put).not.toHaveBeenCalled()
  })

  it('does not derive dispatch authority from other approved policies or queue corrective issuance automatically', async () => {
    const w = await world(),
      refund = await queued(w),
      other = await approveRefundPolicy(w.database, CLAIMS, {
        ...policyInput(w),
        idempotencyKey: 'financial-authority-other-approved-policy'
      }),
      env = runtime(w, { REFUND_POLICY_IDS: JSON.stringify([other.id]) })
    expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ refundsCompleted: 0 })
    expect(w.sqlite.prepare('SELECT status,submitted_at FROM refund_work WHERE refund_id=?').get(refund.id)).toEqual({
      status: 'queued',
      submitted_at: null
    })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
    expect(
      await dispatchCustomerFinancialOperations({ ...env, REFUND_POLICY_IDS: JSON.stringify([w.policy.id]) }, utc())
    ).toMatchObject({ refundsCompleted: 1, creditsCompleted: 0 })
    expect(w.sqlite.prepare('SELECT status FROM refund_credit_obligations').get()).toEqual({ status: 'blocked_policy' })
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_credit_contracts').get()?.n).toBe(0)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_credits').get()?.n).toBe(0)
  })

  it('checks current withdrawal before selecting a provider for an already confirmed refund', async () => {
    const w = await world(),
      refund = await queued(w)
    await withdrawFinancialPolicy(w.database, CLAIMS, w.policy.id, REASON, 'financial-authority-withdraw')
    const provider = vi.spyOn(PersistentLocalRefundProvider.prototype, 'refund')
    expect(await dispatchCustomerFinancialOperations(runtime(w), utc())).toMatchObject({ refundsCompleted: 0 })
    expect(provider).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT status,submitted_at FROM refund_work WHERE refund_id=?').get(refund.id)).toEqual({
      status: 'queued',
      submitted_at: null
    })
  })

  it('does not turn local validation into preview/production execution or activate it without its separate opt-in', async () => {
    const w = await world(),
      refund = await queued(w),
      provider = vi.spyOn(PersistentLocalRefundProvider.prototype, 'refund')
    for (const patch of [
      { APP_ENV: 'preview' },
      { APP_ENV: 'production' },
      { REFUND_LOCAL_VALIDATION_ENABLED: 'false' }
    ]) {
      expect(await dispatchCustomerFinancialOperations(runtime(w, patch), utc())).toMatchObject({ refundsCompleted: 0 })
      expect(w.sqlite.prepare('SELECT status,submitted_at FROM refund_work WHERE refund_id=?').get(refund.id)).toEqual({
        status: 'queued',
        submitted_at: null
      })
    }
    expect(provider).not.toHaveBeenCalled()
  })

  it('injects fetch as the actual third real-factory argument without submitting unselected historical intents', async () => {
    const w = await world(),
      original = await queued(w),
      policy = await approveRefundPolicy(w.database, CLAIMS, {
        ...policyInput(w),
        idempotencyKey: 'financial-authority-real-adapter-offline',
        provider: 'redsys',
        environment: 'sandbox'
      }),
      outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('outbound_forbidden')),
      create = vi.spyOn(WorkerRedsysRefundProvider, 'create'),
      env = runtime(w, {
        APP_ENV: 'preview',
        REFUND_POLICY_IDS: JSON.stringify([policy.id]),
        CREDIT_POLICY_IDS: '[]',
        REDSYS_ENABLED: 'true',
        REDSYS_ENVIRONMENT: 'sandbox',
        REDSYS_MERCHANT_CODE: policy.mappings.merchantCode,
        REDSYS_TERMINAL: policy.mappings.terminal,
        REDSYS_SECRET_KEY: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey
      })
    expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ refundsCompleted: 0 })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[1]).toEqual(policy)
    expect(create.mock.calls[0]?.[2]).toBe(globalThis.fetch)
    expect(await configuredRefundProvider(env, { ...policy, fingerprint: '0'.repeat(64) }, globalThis.fetch)).toBeNull()
    expect(w.sqlite.prepare('SELECT status FROM refund_work WHERE refund_id=?').get(original.id)).toEqual({
      status: 'queued'
    })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('binds the mounted refund to the original signed merchant order and bounded historical cents, not client payment claims', async () => {
    const w = await world(),
      env = runtime(w),
      sealed = await cookie(w),
      input = planInput(w)
    const rejected = await worker.fetch(
      request('/api/admin/refunds/requests', { ...input, merchantOrder: '9999CLIENT', amountCents: 999999 }, sealed),
      env
    )
    expect(rejected.status).toBe(422)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_contracts').get()?.n).toBe(0)
    const result = await worker.fetch(
      request(
        '/api/admin/refunds/requests',
        { ...input, lines: [{ lineIndex: 0, quantity: 1, amountCents: 100 }] },
        sealed
      ),
      env
    )
    expect(result.status).toBe(202)
    const receipt = (await result.json()) as { id: string },
      { contract } = await readRefundContract(w.database, receipt.id),
      capture = w.sqlite
        .prepare("SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE status='captured'")
        .get()
    expect(contract.capture.merchantOrder).toBe(capture?.merchant_order)
    expect(contract.capture.merchantOrder).not.toBe(w.orderId)
    expect(contract.capture.capturedCents).toBe(capture?.amount_gross_cents)
    expect(contract.amountCents).toBe(100)
    expect(contract.components.reduce((sum, line) => sum + line.netCents + line.taxCents, 0)).toBe(100)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
  })

  it('quarantines a persistent local accepted response loss across mounted dispatch without automatic resend or budget release', async () => {
    const w = await world(),
      refund = await queued(w, 2),
      originalRefund = PersistentLocalRefundProvider.prototype.refund,
      provider = vi.spyOn(PersistentLocalRefundProvider.prototype, 'refund').mockImplementation(async function (
        this: PersistentLocalRefundProvider,
        contract
      ) {
        await originalRefund.call(this, contract)
        throw new Error('synthetic-accepted-reply-lost-private-data')
      }),
      env = runtime(w)
    expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ uncertain: 1, refundsCompleted: 0 })
    expect(await dispatchCustomerFinancialOperations(env, utc())).toMatchObject({ refundsCompleted: 0 })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(1)
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(0)
    const response = await worker.fetch(
      request(`/api/orders/${w.orderId}/refunds`, undefined, await cookie(w, BUYER_CLAIMS)),
      env
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      reservedCents: 1000,
      confirmedCents: 0,
      simulatedConfirmedCents: 0,
      items: [{ id: refund.id, workflow: 'uncertain', financialStatus: 'uncertain', lastErrorCode: null }]
    })
    await expect(w.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
  })

  it('protects mounted corrective PDF from guessed URLs and revokes bytes after awaited R2 access', async () => {
    const w = await world(),
      { credit, env } = await corrective(w),
      path = `/api/orders/${w.orderId}/credits/${credit.id}/pdf`,
      sealed = await cookie(w, BUYER_CLAIMS)
    // Completion already read back its newly written private object. Observe
    // only the following unauthorized HTTP requests and awaited download.
    vi.mocked(env.MEDIA.get).mockClear()
    expect((await worker.fetch(request(path), env)).status).toBe(401)
    expect((await worker.fetch(request(path + '?token=guessable-not-an-access-grant'), env)).status).toBe(400)
    expect(env.MEDIA.get).not.toHaveBeenCalled()
    const get = env.MEDIA.get.bind(env.MEDIA)
    env.MEDIA.get = vi.fn(async (key: string) => {
      const object = await get(key)
      w.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
      return object
    }) as typeof env.MEDIA.get
    const response = await worker.fetch(request(path, undefined, sealed), env)
    expect(env.MEDIA.get).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toContain('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-type')).not.toBe('application/pdf')
    expect(await response.text()).not.toContain('%PDF')
  })

  it('enables only the registered historical financial notices and preserves pending/synthetic semantics without granting PDF access', async () => {
    const w = await world(),
      originalIssue = PersistentLocalCreditProvider.prototype.issueCreditNote
    vi.spyOn(PersistentLocalCreditProvider.prototype, 'issueCreditNote').mockImplementation(function (
      this: PersistentLocalCreditProvider,
      contract
    ) {
      this.failures.pending = true
      return originalIssue.call(this, contract)
    })
    const { refund, credit, env } = await corrective(w),
      events = w.sqlite.prepare('SELECT id FROM email_outbox_events WHERE source_id IN(?,?)').all(refund.id, credit.id)
    await publishEmailOutbox(
      w.database,
      {
        async send(message) {
          if (events.some((event) => event.id === message.eventId))
            expect(await receiveEmailDispatch(w.database, message, utc())).toBe('stored')
        }
      },
      { now: utc() }
    )
    const sender = { send: vi.fn(async () => ({ messageId: 'synthetic-local-email-ack' })) },
      config = {
        enabled: true,
        from: 'shop@example.invalid',
        now: utc(),
        appEnvironment: 'local' as const,
        invoiceEmailEnabled: true,
        ...customerEmailConfiguration(env)
      }
    expect(
      await dispatchTransactionalEmails(w.database, sender, config, { renderers: customerEmailRenderers })
    ).toMatchObject({ sent: 0 })
    expect(w.sqlite.prepare('SELECT status,attempts FROM transactional_email_deliveries').all()).toEqual([
      { status: 'pending', attempts: 0 },
      { status: 'pending', attempts: 0 }
    ])
    expect(
      await dispatchTransactionalEmails(
        w.database,
        sender,
        {
          ...config,
          ...customerEmailConfiguration({
            ...env,
            TRANSACTIONAL_EMAIL_RENDERER_KEYS: JSON.stringify(['refund.succeeded.v1', 'invoice.credit.v1']),
            TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED: 'true'
          })
        },
        { renderers: customerEmailRenderers }
      )
    ).toMatchObject({ sent: 2 })
    const content = JSON.stringify(sender.send.mock.calls)
    expect(content).toContain('no se ha devuelto dinero')
    expect(content).toContain('no acredita emisión fiscal')
    expect(content).toContain('pendiente fiscal')
    expect(content).not.toContain('fiscal/')
    expect(content).not.toContain('token=')
    expect(content).not.toContain('/pdf')
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM transactional_email_preparations').get()?.n).toBe(2)
  })

  it('constructs only exact tenant/mapping/series/environment corrective providers offline, never production tenant in preview/local', async () => {
    const w = await world(),
      { id: _id, fingerprint: _fingerprint, approvedAt: _approvedAt, ...creditInput } = w.creditPolicy,
      policy = await approveCreditPolicy(w.database, CLAIMS, {
        ...creditInput,
        idempotencyKey: 'financial-authority-corrective-real-offline',
        provider: 'beply',
        environment: 'sandbox'
      }),
      fetcher = vi.fn(async () => {
        throw new Error('outbound_forbidden')
      }),
      env = runtime(w, {
        APP_ENV: 'preview',
        BEPLY_ENABLED: 'true',
        BEPLY_ENVIRONMENT: 'sandbox',
        BEPLY_API_TOKEN: 'synthetic-no-real-secret',
        BEPLY_BASE_URL: 'https://synthetic.beply.es/api/3',
        BEPLY_INVOICE_SERIES: 'LOCAL',
        BEPLY_CORRECTIVE_SERIES: policy.series,
        BEPLY_COMPANY_ID: policy.mappings.companyId,
        BEPLY_TAX_CODE_0: policy.mappings.taxes['0'],
        BEPLY_TAX_CODE_10: policy.mappings.taxes['1000'],
        BEPLY_TAX_CODE_21: policy.mappings.taxes['2100'],
        BEPLY_PAYMENT_CODE_REDSYS: policy.mappings.paymentCode,
        BEPLY_PAYMENT_CODE_BANK_TRANSFER: 'SYNTHETIC-BANK'
      })
    expect((await configuredCreditProvider(env, policy, fetcher))?.name).toBe('beply')
    for (const patch of [
      { APP_ENV: 'local' },
      { APP_ENV: 'production' },
      { BEPLY_ENABLED: 'false' },
      { BEPLY_BASE_URL: 'https://neteco.beply.es/api/3' },
      { BEPLY_BASE_URL: 'https://NETECO.BEPLY.ES:443/api/3' },
      { BEPLY_TAX_CODE_21: 'UNAPPROVED-MAPPING' },
      { BEPLY_CORRECTIVE_SERIES: 'UNAPPROVED' }
    ])
      expect(await configuredCreditProvider({ ...env, ...patch }, policy, fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM fiscal_credit_contracts').get()?.n).toBe(0)
  })
})
