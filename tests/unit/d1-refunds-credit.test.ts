import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import type { DatabaseSync } from 'node:sqlite'
import { refundsCreditFixture, CLAIMS, BUYER_CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import {
  planD1Refund,
  confirmD1Refund,
  cancelD1Refund,
  dispatchD1Refunds,
  reconcileD1Refund,
  readRefundContract
} from '../../workers/refunds/operations'
import { PersistentLocalRefundProvider } from '../../workers/refunds/local-provider'
import { queueD1CreditNote, dispatchD1CreditNotes, reconcileD1CreditNote } from '../../workers/fiscal/credit-notes'
import { readD1OrderRefunds, readD1CreditNote, readPrivateCreditPdf } from '../../workers/refunds/access'
import { withdrawFinancialPolicy, approveRefundPolicy } from '../../workers/refunds/policies'
import { handleD1RefundsRequest, ownsRefundsNamespace } from '../../workers/refunds/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { refundPlanInputSchema, refundProviderRequest } from '../../shared/order-refunds'
import { WorkerBeplyInvoiceProvider } from '../../workers/fiscal/beply-provider'
import { auditNativeRefundsCredit } from '../../scripts/lib/audit-native-refunds-credit'
import { receiveEmailDispatch, publishEmailOutbox } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import {
  refundSucceededEmailRenderer,
  creditIssuedEmailRenderer
} from '../../workers/communications/refund-credit-email'
import { creditProviderRequest } from '../../shared/fiscal-credit'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  vi.restoreAllMocks()
})
async function world(options: Parameters<typeof refundsCreditFixture>[0] = {}) {
  const fixture = await refundsCreditFixture(options)
  await applyDeliveryPreferencesMigration(fixture.sqlite)
  opened.push(fixture.sqlite)
  return fixture
}
const reconcileInput = (generation: number) => ({
  idempotencyKey: crypto.randomUUID(),
  expectedGeneration: generation,
  reason: REASON,
  evidenceRef: 'authoritative-local-evidence'
})
const creditInput = (policyId: string) => ({
  idempotencyKey: crypto.randomUUID(),
  policyId,
  reason: REASON,
  evidenceRef: 'approved-corrective-case'
})
describe('D1 captured refund budgets and linked corrective documents', () => {
  const planInput = (f: Awaited<ReturnType<typeof world>>, overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: crypto.randomUUID(),
    policyId: f.policy.id,
    returnPublicRef: f.returnRef,
    expectedReturnVersion: 5,
    reason: REASON,
    evidenceRef: 'governed-local-case',
    lines: [{ lineIndex: 0, quantity: 1 }],
    ...overrides
  })
  it('completes partial then remaining refund with exact history, durable obligations and no stock/capture mutation', async () => {
    const f = await world(),
      before = f.sqlite.prepare('SELECT * FROM order_payment_states').all(),
      stock = f.sqlite.prepare('SELECT * FROM inventory_balances').all(),
      original = f.sqlite.prepare('SELECT * FROM fiscal_invoice_intents').all()
    const first = await f.completed(),
      second = await f.completed()
    const view = await readD1OrderRefunds(f.database, { kind: 'customer', claims: BUYER_CLAIMS }, f.orderId, {
      appEnvironment: 'local'
    })
    expect(view).toMatchObject({
      capturedCents: 1000,
      reservedCents: 1000,
      confirmedCents: 0,
      simulatedConfirmedCents: 1000,
      inventoryEffect: 'none'
    })
    expect(view.items.map((item) => item.amountCents)).toEqual([500, 500])
    expect(view.items.every((item) => item.financialStatus === 'validation_completed')).toBe(true)
    expect(f.sqlite.prepare('SELECT * FROM order_payment_states').all()).toEqual(before)
    expect(f.sqlite.prepare('SELECT * FROM inventory_balances').all()).toEqual(stock)
    expect(f.sqlite.prepare('SELECT * FROM fiscal_invoice_intents').all()).toEqual(original)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(2)
    const { contract } = await readRefundContract(f.database, first.id)
    expect(refundProviderRequest(contract).orderReference).toBe(contract.capture.merchantOrder)
    expect(refundProviderRequest(contract).orderReference).not.toBe(f.orderId)
    await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
    expect(second.id).not.toBe(first.id)
  })
  it('plans and confirms full refund independently; queue/defaults never mean provider execution', async () => {
    const f = await world(),
      planned = await f.plan(2)
    expect(await f.dispatch()).toMatchObject({ completed: 0 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    for (const config of [
      {},
      { enabled: true },
      { enabled: true, policyId: f.policy.id },
      { enabled: true, policyId: f.policy.id, localValidationEnabled: true, appEnvironment: 'preview' }
    ])
      expect(
        await dispatchD1Refunds(f.database, f.refundProvider, {
          now: utc(),
          appEnvironment: 'local',
          ...config
        } as Parameters<typeof dispatchD1Refunds>[2])
      ).toMatchObject({ completed: 0 })
    expect(await f.dispatch()).toMatchObject({ completed: 1 })
    expect(await f.dispatch()).toMatchObject({ completed: 0 })
  })
  it('replays historical plan, rejects key drift and atomically serializes competing allocations', async () => {
    const f = await world(),
      first = await f.plan(2, 'same-plan')
    expect(await f.plan(2, 'same-plan')).toEqual(first)
    await expect(f.plan(1, 'same-plan')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const f2 = await world(),
      outcomes = await Promise.allSettled([f2.plan(2), f2.plan(2)])
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(f2.sqlite.prepare('SELECT sum(gross_cents) AS n FROM refund_allocations').get()?.n).toBe(1000)
  })
  it('cancels only unsubmitted holds and does not return submitted/ambiguous funds to available budget', async () => {
    const f = await world(),
      planned = await f.plan(2)
    await cancelD1Refund(f.database, CLAIMS, planned.id, reconcileInput(1))
    await f.plan(2)
    expect(f.sqlite.prepare('SELECT status FROM refund_work WHERE refund_id=?').get(planned.id)?.status).toBe(
      'cancelled'
    )
  })
  it('withdrawal blocks before marker/provider call, never grants fiscal policy implicitly', async () => {
    const f = await world(),
      planned = await f.plan()
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    await withdrawFinancialPolicy(f.database, CLAIMS, f.policy.id, REASON, 'withdraw-refund')
    expect(await f.dispatch()).toMatchObject({ completed: 0 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
  })
  it('quarantines accepted response loss; durable fake lookup reconciles once without reissuing', async () => {
    const f = await world(),
      planned = await f.plan(2),
      provider = new PersistentLocalRefundProvider(f.database, f.refundProvider.mappingFingerprint, {
        responseLost: true
      })
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    expect(
      await dispatchD1Refunds(f.database, provider, {
        now: utc(),
        appEnvironment: 'local',
        enabled: true,
        policyId: f.policy.id,
        localValidationEnabled: true
      })
    ).toMatchObject({ uncertain: 1 })
    expect(await f.dispatch()).toMatchObject({ completed: 0 })
    await expect(cancelD1Refund(f.database, CLAIMS, planned.id, reconcileInput(3))).rejects.toMatchObject({
      code: 'cancellation_not_safe'
    })
    await expect(reconcileD1Refund(f.database, CLAIMS, planned.id, reconcileInput(3), undefined)).rejects.toMatchObject(
      { code: 'lookup_unavailable' }
    )
    const result = await reconcileD1Refund(f.database, CLAIMS, planned.id, reconcileInput(4), f.refundProvider)
    expect(result.action).toBe('reconciled')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(1)
  })
  it('keeps a provider pending response reserved with no success/credit/email obligation', async () => {
    const f = await world(),
      planned = await f.plan(2),
      provider = new PersistentLocalRefundProvider(f.database, f.refundProvider.mappingFingerprint, { pending: true })
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    expect(
      await dispatchD1Refunds(f.database, provider, {
        now: utc(),
        appEnvironment: 'local',
        enabled: true,
        policyId: f.policy.id,
        localValidationEnabled: true
      })
    ).toMatchObject({ pending: 1 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(0)
    await expect(
      queueD1CreditNote(f.database, CLAIMS, planned.id, creditInput(f.creditPolicy.id))
    ).rejects.toMatchObject({ code: 'refund_unconfirmed' })
    await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
  })
  it('links exact credit lines to confirmed refund and immutable original, private PDF reauth and no guest URL grant', async () => {
    const f = await world(),
      refund = await f.completed(),
      original = f.sqlite.prepare('SELECT * FROM fiscal_invoice_intents').all(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    expect(
      await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
        now: utc(),
        appEnvironment: 'local',
        policyId: f.creditPolicy.id,
        enabled: true,
        localValidationEnabled: true
      })
    ).toMatchObject({ completed: 1 })
    const view = await readD1CreditNote(f.database, { kind: 'customer', claims: BUYER_CLAIMS }, f.orderId, queued.id, {
      appEnvironment: 'local'
    })
    expect(view).toMatchObject({
      workflow: 'completed',
      validationOnly: true,
      pdfAvailable: true,
      sourceInvoiceId: f.ordinary.intentId,
      amountCents: 500
    })
    expect(
      new TextDecoder().decode(
        await readPrivateCreditPdf(
          f.database,
          { kind: 'customer', claims: BUYER_CLAIMS },
          f.orderId,
          queued.id,
          f.storage,
          { appEnvironment: 'local' }
        )
      )
    ).toContain('SYNTHETIC LOCAL CREDIT')
    await expect(
      readD1CreditNote(f.database, { kind: 'guest', orderId: f.orderId, token: 'a'.repeat(64) }, f.orderId, queued.id, {
        appEnvironment: 'local'
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(f.sqlite.prepare('SELECT * FROM fiscal_invoice_intents').all()).toEqual(original)
    const c = await (await import('../../workers/fiscal/credit-notes')).readCreditContract(f.database, queued.id)
    expect(creditProviderRequest(c.contract).lines[0]?.lineNetCents).toBe(c.contract.components[0]?.netCents)
  })
  it('durably saves corrective receipt before invalid PDF, lookup-free reconciliation uses receipt and never emits twice', async () => {
    const f = await world(),
      refund = await f.completed(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    f.creditProvider.failures.pdfInvalid = true
    expect(
      await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
        now: utc(),
        appEnvironment: 'local',
        policyId: f.creditPolicy.id,
        enabled: true,
        localValidationEnabled: true
      })
    ).toMatchObject({ uncertain: 1 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fiscal_credit_receipts').get()?.n).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fiscal_credit_documents').get()?.n).toBe(0)
    f.creditProvider.failures.pdfInvalid = false
    await reconcileD1CreditNote(f.database, CLAIMS, queued.id, reconcileInput(2), f.creditProvider, f.storage)
    expect(f.sqlite.prepare('SELECT status FROM fiscal_credit_work').get()?.status).toBe('completed')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_credits').get()?.n).toBe(1)
  })
  it('delivers opted-in historical refund/credit notices with durable manifest and unambiguous synthetic wording; ordinary flag alone does not activate them', async () => {
    const f = await world(),
      refund = await f.completed(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    f.creditProvider.failures.pending = true
    await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
      now: utc(),
      appEnvironment: 'local',
      policyId: f.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    })
    const events = f.sqlite
      .prepare('SELECT id FROM email_outbox_events WHERE source_id IN(?,?)')
      .all(refund.id, queued.id)
    await publishEmailOutbox(
      f.database,
      {
        async send(message) {
          if (events.some((event) => event.id === message.eventId))
            expect(await receiveEmailDispatch(f.database, message, utc())).toBe('stored')
        }
      },
      { now: utc() }
    )
    const sender = { send: vi.fn(async () => ({ messageId: 'local-email' })) },
      config = {
        enabled: true,
        from: 'shop@example.invalid',
        now: utc(),
        appEnvironment: 'local' as const,
        invoiceEmailEnabled: true
      }
    await dispatchTransactionalEmails(f.database, sender, config)
    expect(sender.send).not.toHaveBeenCalled()
    expect(
      await dispatchTransactionalEmails(
        f.database,
        sender,
        { ...config, rendererOptIns: ['refund.succeeded.v1', 'invoice.credit.v1'], rendererValidationEnabled: true },
        { renderers: [refundSucceededEmailRenderer, creditIssuedEmailRenderer] }
      )
    ).toMatchObject({ sent: 2 })
    const content = JSON.stringify(sender.send.mock.calls)
    expect(content).toContain('no se ha devuelto dinero')
    expect(content).toContain('no acredita emisión fiscal')
    expect(content).toContain('pendiente fiscal')
    expect(content).not.toContain('fiscal/')
    expect(content).not.toContain('token=')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM transactional_email_preparations').get()?.n).toBe(2)
  })
  it('requires a distinct approver when governed; forged customer or stale confirmation cannot authorize money', async () => {
    const f = await world({ distinctActor: true }),
      planned = await f.plan()
    await expect(
      confirmD1Refund(f.database, CLAIMS, planned.id, {
        ...reconcileInput(1),
        contractFingerprint: planned.contractFingerprint
      })
    ).rejects.toMatchObject({ code: 'distinct_approver_required' })
    await expect(
      planD1Refund(f.database, BUYER_CLAIMS, refundPlanInputSchema.parse(planInput(f)))
    ).rejects.toMatchObject({ code: 'mfa_required' })
    const view = await readD1OrderRefunds(f.database, { kind: 'admin', claims: CLAIMS }, f.orderId, {
      appEnvironment: 'local'
    })
    expect(view.items[0]?.capabilities.confirm).toBe(false)
  })
  it('refunds historical shipping only after explicit governed rule, preserving its 10% tax snapshot', async () => {
    const f = await world({ shipping: true })
    await expect(
      planD1Refund(
        f.database,
        CLAIMS,
        refundPlanInputSchema.parse(planInput(f, { shippingCents: 110, lines: [{ lineIndex: 0, quantity: 2 }] }))
      )
    ).rejects.toMatchObject({ code: 'shipping_not_approved' })
    const { id: _id, fingerprint: _hash, approvedAt: _at, ...base } = f.policy,
      policy = await approveRefundPolicy(f.database, CLAIMS, {
        ...base,
        idempotencyKey: 'explicit-shipping',
        shipping: 'explicit_amount'
      })
    const planned = await planD1Refund(
      f.database,
      CLAIMS,
      refundPlanInputSchema.parse(
        planInput(f, { policyId: policy.id, shippingCents: 110, lines: [{ lineIndex: 0, quantity: 2 }] })
      )
    )
    const { contract } = await readRefundContract(f.database, planned.id)
    expect(contract).toMatchObject({
      amountCents: 1110,
      components: expect.arrayContaining([
        {
          component: 'shipping',
          lineIndex: null,
          quantity: 1,
          unitOffset: 0,
          sku: 'SHIPPING',
          description: 'Rectificación de gastos de envío',
          grossCents: 110,
          netCents: 100,
          taxCents: 10,
          taxRateBasisPoints: 1000
        }
      ])
    })
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    expect(
      await dispatchD1Refunds(f.database, f.refundProvider, {
        now: utc(),
        appEnvironment: 'local',
        policyId: policy.id,
        enabled: true,
        localValidationEnabled: true
      })
    ).toMatchObject({ completed: 1 })
    const queued = await queueD1CreditNote(f.database, CLAIMS, planned.id, creditInput(f.creditPolicy.id)),
      { contract: credit } = await (
        await import('../../workers/fiscal/credit-notes')
      ).readCreditContract(f.database, queued.id)
    expect(creditProviderRequest(credit).shippingNetCents).toBe(0)
    expect(creditProviderRequest(credit).lines.at(-1)).toMatchObject({ lineNetCents: 100, taxRateBasisPoints: 1000 })
  })
  it('keeps lower monetary compensation explicit and balanced, with no fabricated net/tax or unit release', async () => {
    const f = await world(),
      planned = await planD1Refund(
        f.database,
        CLAIMS,
        refundPlanInputSchema.parse(planInput(f, { lines: [{ lineIndex: 0, quantity: 2, amountCents: 777 }] }))
      )
    const { contract } = await readRefundContract(f.database, planned.id)
    expect(contract.amountCents).toBe(777)
    expect(contract.components[0]!.netCents + contract.components[0]!.taxCents).toBe(777)
    await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
  })
  it('rejects same-key policy drift and unknown/over-budget historical lines without partial writes', async () => {
    const f = await world(),
      { id: _id, fingerprint: _hash, approvedAt: _at, ...input } = f.policy
    await expect(approveRefundPolicy(f.database, CLAIMS, { ...input, maximumRefundCents: 500 })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    await expect(
      planD1Refund(
        f.database,
        CLAIMS,
        refundPlanInputSchema.parse(planInput(f, { lines: [{ lineIndex: 1, quantity: 1 }] }))
      )
    ).rejects.toMatchObject({ code: 'line_not_found' })
    await expect(
      planD1Refund(
        f.database,
        CLAIMS,
        refundPlanInputSchema.parse(planInput(f, { lines: [{ lineIndex: 0, quantity: 1, amountCents: 501 }] }))
      )
    ).rejects.toMatchObject({ code: 'amount_unavailable' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_contracts').get()?.n).toBe(0)
  })
  it('serializes same-key plan races to one exact durable receipt', async () => {
    const f = await world(),
      [first, second] = await Promise.all([f.plan(1, 'race-key'), f.plan(1, 'race-key')])
    expect(first).toEqual(second)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_contracts').get()?.n).toBe(1)
  })
  it('rejects owned getters/sparse DTO and malformed D1 envelopes without executing getter or converting to missing', async () => {
    const f = await world(),
      getter = vi.fn(() => crypto.randomUUID()),
      input = planInput(f)
    Object.defineProperty(input, 'idempotencyKey', { get: getter, enumerable: true })
    await expect(planD1Refund(f.database, CLAIMS, input as never)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(getter).not.toHaveBeenCalled()
    const malformed = {
      ...f.database,
      prepare(sql: string) {
        const statement = f.database.prepare(sql)
        return sql.includes('SELECT p.id,p.policy_json')
          ? ({
              ...statement,
              bind() {
                return this
              },
              async first() {
                return undefined
              }
            } as D1PreparedStatement)
          : statement
      }
    }
    await expect(
      planD1Refund(malformed as D1Database, CLAIMS, refundPlanInputSchema.parse(planInput(f)))
    ).rejects.toMatchObject({ code: 'read_unconfirmed' })
    const sparse = new Array(1)
    await expect(planD1Refund(f.database, CLAIMS, { ...planInput(f), lines: sparse } as never)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it.each(['revoked_at', 'expires_at'])(
    'checks live SQL authority after awaited reads and rolls back plan on %s before batch',
    async (column) => {
      const f = await world(),
        wrapped = {
          ...f.database,
          async batch(statements: D1PreparedStatement[]) {
            f.sqlite.prepare(`UPDATE auth_sessions SET ${column}=? WHERE id=?`).run(utc(), CLAIMS.sessionId)
            return f.database.batch(statements)
          }
        } as D1Database
      await expect(planD1Refund(wrapped, CLAIMS, refundPlanInputSchema.parse(planInput(f)))).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_contracts').get()?.n).toBe(0)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_allocations').get()?.n).toBe(0)
    }
  )
  it('quarantines receipt mismatch and accepted plus completion rollback, preserving budget without re-send', async () => {
    for (const badAmount of [true, false]) {
      const f = await world(),
        planned = await f.plan(2),
        provider = new PersistentLocalRefundProvider(f.database, f.refundProvider.mappingFingerprint, { badAmount })
      await f.confirm(planned.id, 1, planned.contractFingerprint)
      const wrapped = badAmount
        ? f.database
        : ({
            ...f.database,
            async batch(statements: D1PreparedStatement[]) {
              if (
                statements.some((s) => (s as unknown as { sql?: string }).sql?.includes('INSERT INTO refund_receipts'))
              )
                throw new Error('synthetic commit unavailable')
              return f.database.batch(statements)
            }
          } as D1Database)
      expect(
        await dispatchD1Refunds(wrapped, provider, {
          now: utc(),
          appEnvironment: 'local',
          policyId: f.policy.id,
          enabled: true,
          localValidationEnabled: true
        })
      ).toMatchObject({ uncertain: 1 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(0)
      expect(await f.dispatch()).toMatchObject({ completed: 0 })
      await reconcileD1Refund(f.database, CLAIMS, planned.id, reconcileInput(3), f.refundProvider)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(1)
    }
  })
  it('prevents stale provider completion after expired lease and fences privileged reconciliation generation', async () => {
    const f = await world(),
      planned = await f.plan(2)
    await f.confirm(planned.id, 1, planned.contractFingerprint)
    let enter!: () => void, finish!: () => void
    const entered = new Promise<void>((resolve) => {
        enter = resolve
      }),
      wait = new Promise<void>((resolve) => {
        finish = resolve
      })
    const provider = {
      name: 'local_fake' as const,
      environment: 'local_validation' as const,
      mappingFingerprint: f.refundProvider.mappingFingerprint,
      async refund(contract: Parameters<typeof f.refundProvider.refund>[0]) {
        const value = await f.refundProvider.refund(contract)
        enter()
        await wait
        return value
      }
    }
    const running = dispatchD1Refunds(f.database, provider, {
      now: utc(),
      appEnvironment: 'local',
      policyId: f.policy.id,
      enabled: true,
      localValidationEnabled: true
    })
    await entered
    expect(await dispatchD1Refunds(f.database, undefined, { now: utc(960000), appEnvironment: 'local' })).toMatchObject(
      { uncertain: 1 }
    )
    finish()
    expect(await running).toMatchObject({ completed: 0, lostLease: 1 })
    await expect(
      reconcileD1Refund(f.database, CLAIMS, planned.id, reconcileInput(2), f.refundProvider)
    ).rejects.toMatchObject({ code: 'reconciliation_not_safe' })
    expect(f.sqlite.prepare('SELECT status FROM refund_work').get()?.status).toBe('uncertain')
  })
  it('does not execute provider metadata/lookup accessors or invent a Beply lookup', async () => {
    const f = await world(),
      getter = vi.fn(() => 'production'),
      provider = {
        name: 'local_fake',
        mappingFingerprint: f.refundProvider.mappingFingerprint,
        refund: f.refundProvider.refund.bind(f.refundProvider)
      }
    Object.defineProperty(provider, 'environment', { get: getter })
    await expect(
      dispatchD1Refunds(f.database, provider as never, {
        now: utc(),
        appEnvironment: 'local',
        policyId: f.policy.id,
        enabled: true,
        localValidationEnabled: true
      })
    ).rejects.toMatchObject({ code: 'provider_configuration_unconfirmed' })
    expect(getter).not.toHaveBeenCalled()
  })
  it('blocks corrective requests for pending original fiscal state, withdrawal and an unconfirmed mapping', async () => {
    const f = await world({ originalPending: true }),
      refund = await f.completed()
    await expect(
      queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    ).rejects.toMatchObject({ code: 'original_invoice_unconfirmed' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fiscal_credit_contracts').get()?.n).toBe(0)
    const f2 = await world(),
      refund2 = await f2.completed(),
      queued = await queueD1CreditNote(f2.database, CLAIMS, refund2.id, creditInput(f2.creditPolicy.id))
    await withdrawFinancialPolicy(f2.database, CLAIMS, f2.creditPolicy.id, REASON, 'withdraw-credit')
    expect(
      await dispatchD1CreditNotes(f2.database, f2.creditProvider, f2.storage, {
        now: utc(),
        appEnvironment: 'local',
        policyId: f2.creditPolicy.id,
        enabled: true,
        localValidationEnabled: true
      })
    ).toMatchObject({ completed: 0 })
    expect(f2.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_credits').get()?.n).toBe(0)
    expect(queued.action).toBe('queued')
  })
  it('reconciles corrective response loss with authoritative local evidence, never a second document', async () => {
    const f = await world(),
      refund = await f.completed(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    f.creditProvider.failures.responseLost = true
    const config = {
      now: utc(),
      appEnvironment: 'local' as const,
      policyId: f.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    }
    expect(await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, config)).toMatchObject({ uncertain: 1 })
    expect(await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, config)).toMatchObject({ completed: 0 })
    await reconcileD1CreditNote(f.database, CLAIMS, queued.id, reconcileInput(2), f.creditProvider, f.storage)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM fiscal_fake_credits').get()?.n).toBe(1)
  })
  it('reauthorizes private PDF after awaited storage and never releases bytes after customer revocation', async () => {
    const f = await world(),
      refund = await f.completed(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id))
    await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
      now: utc(),
      appEnvironment: 'local',
      policyId: f.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    })
    const storage = {
      ...f.storage,
      async get(key: string) {
        const value = await f.storage.get(key)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
        return value
      }
    }
    await expect(
      readPrivateCreditPdf(f.database, { kind: 'customer', claims: BUYER_CLAIMS }, f.orderId, queued.id, storage, {
        appEnvironment: 'local'
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('claims aliases and rejects unauthenticated/CSRF/unknown routes before body or any provider resolution', async () => {
    const f = await world(),
      resolver = vi.fn(),
      deps = {
        database: f.database,
        origin: 'https://refunds-fixture.neteco.test',
        appEnvironment: 'local' as const,
        sessionCookieConfiguration: { password: 'synthetic-financial-cookie-over-32-characters', maxAgeSeconds: 3600 },
        refundProviderResolver: resolver
      }
    const cookie = (await issueD1SessionCookie(f.database, CLAIMS, deps.sessionCookieConfiguration))!.split(';')[0]!
    const bodyRead = vi.fn(),
      request = new Request(`${deps.origin}/api/admin/refunds/requests`, {
        method: 'POST',
        headers: { origin: deps.origin, 'content-type': 'application/json' },
        body: 'invalid'
      })
    Object.defineProperty(request, 'body', { get: bodyRead })
    expect((await handleD1RefundsRequest(request, deps))?.status).toBe(401)
    expect(bodyRead).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
    expect(
      (
        await handleD1RefundsRequest(
          new Request(`${deps.origin}/api/admin/refunds/requests`, {
            method: 'POST',
            headers: { cookie, origin: 'https://outside.invalid' }
          }),
          deps
        )
      )?.status
    ).toBe(403)
    for (const path of [
      '/api/admin/%72efunds/requests',
      '/api/admin/refunds%2frequests',
      '/api/orders/not-an-id/refunds',
      '/api/admin/credits/unknown'
    ]) {
      expect(ownsRefundsNamespace(path)).toBe(true)
      expect((await handleD1RefundsRequest(new Request(deps.origin + path), deps))?.status).toBe(404)
    }
  })
  it('forbids SQL replacement of original financial evidence and resetting irreversible markers', async () => {
    const f = await world(),
      planned = await f.completed()
    expect(() =>
      f.sqlite
        .prepare(
          "INSERT OR REPLACE INTO refund_receipts SELECT refund_id,status,json_set(receipt_json,'$.amountCents',1),recorded_at FROM refund_receipts WHERE refund_id=?"
        )
        .run(planned.id)
    ).toThrow()
    expect(() => f.sqlite.prepare("UPDATE refund_work SET status='queued' WHERE refund_id=?").run(planned.id)).toThrow()
    expect(() =>
      f.sqlite
        .prepare("INSERT OR REPLACE INTO refund_work(refund_id,status,generation) VALUES(?,'awaiting_confirmation',1)")
        .run(planned.id)
    ).toThrow()
  })
  it('Beply corrective port fails closed before fetch while kind/source/signed-total primary protocol remains unverified', async () => {
    const f = await world(),
      refund = await f.completed(),
      queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, creditInput(f.creditPolicy.id)),
      { contract } = await (await import('../../workers/fiscal/credit-notes')).readCreditContract(f.database, queued.id)
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({})),
      provider = await WorkerBeplyInvoiceProvider.create(
        {
          baseUrl: 'https://synthetic.beply.es/api/3',
          token: 'synthetic-injected-never-real',
          environment: 'sandbox',
          invoiceSeries: 'LOCAL',
          correctiveSeries: 'RECTLOCAL',
          companyId: 'SYNTHETIC',
          taxCode0: 'ZERO',
          taxCode10: 'REDUCED',
          taxCode21: 'GENERAL',
          paymentCodeRedsys: 'CARD',
          paymentCodeBankTransfer: 'BANK'
        },
        fetcher
      )
    await expect(
      provider.issueCreditNote({
        ...contract,
        provider: 'beply',
        environment: 'sandbox',
        validationOnly: false,
        sourceContract: { ...contract.sourceContract, provider: 'beply', environment: 'sandbox', validationOnly: false }
      })
    ).rejects.toMatchObject({ code: 'validation' })
    expect(fetcher).not.toHaveBeenCalled()
    expect('lookupByExternalKey' in provider).toBe(false)
  })
  it('prevents unknown preparation version or source drift from reaching the registered sender', async () => {
    const f = await world(),
      refund = await f.completed(),
      event = f.sqlite
        .prepare("SELECT id FROM email_outbox_events WHERE source_id=? AND event_type='refund.succeeded.email'")
        .get(refund.id)!.id as string
    await publishEmailOutbox(
      f.database,
      {
        async send(message) {
          if (message.eventId === event) await receiveEmailDispatch(f.database, message, utc())
        }
      },
      { now: utc() }
    )
    f.sqlite
      .prepare(
        'INSERT INTO transactional_email_preparations(event_id,renderer_version,source_hash,message_hash,prepared_at) VALUES(?,?,?,?,?)'
      )
      .run(event, 'unknown.renderer.v999', 'a'.repeat(64), 'b'.repeat(64), utc())
    const sender = { send: vi.fn(async () => ({ messageId: 'should-never-send' })) }
    expect(
      await dispatchTransactionalEmails(
        f.database,
        sender,
        {
          enabled: true,
          now: utc(),
          from: 'shop@example.invalid',
          appEnvironment: 'local',
          rendererValidationEnabled: true,
          rendererOptIns: ['refund.succeeded.v1']
        },
        { renderers: [refundSucceededEmailRenderer] }
      )
    ).toMatchObject({ manualReview: 1, sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
    expect(
      f.sqlite.prepare('SELECT renderer_version FROM transactional_email_preparations WHERE event_id=?').get(event)
        ?.renderer_version
    ).toBe('unknown.renderer.v999')
  })
  it('runs the complete native-helper HTTP/callback contract over scoped SQLite, without claiming workerd or remote acceptance', async () => {
    const f = await world(),
      origin = 'https://native-financial.neteco.test',
      sessionCookieConfiguration = {
        password: 'synthetic-native-financial-cookie-over-32-characters',
        maxAgeSeconds: 3600
      },
      adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, sessionCookieConfiguration))!.split(';')[0]!,
      customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, sessionCookieConfiguration))!.split(
        ';'
      )[0]!
    const { id: _refundId, fingerprint: _refundHash, approvedAt: _refundAt, ...refundPolicy } = f.policy,
      { id: _creditId, fingerprint: _creditHash, approvedAt: _creditAt, ...creditPolicy } = f.creditPolicy
    const messages: Parameters<NonNullable<Parameters<typeof dispatchTransactionalEmails>[1]>['send']>[0][] = []
    const scenario = vi.fn()
    const result = await auditNativeRefundsCredit({
      database: f.database,
      origin,
      adminCookie,
      customerCookie,
      orderId: f.orderId,
      returnPublicRef: f.returnRef,
      returnVersion: 5,
      refundPolicy,
      creditPolicy,
      scenario,
      async dispatch(request) {
        return (
          (await handleD1RefundsRequest(request, {
            database: f.database,
            origin,
            appEnvironment: 'local',
            sessionCookieConfiguration,
            storage: f.storage
          })) ?? new Response(null, { status: 404 })
        )
      },
      runRefunds: (config) => dispatchD1Refunds(f.database, f.refundProvider, config),
      runCredits: (config) => dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, config),
      async deliverEmailTransport(eventId) {
        await publishEmailOutbox(f.database, { async send() {} }, { now: utc() })
        expect(
          await receiveEmailDispatch(f.database, { type: 'email.dispatch.requested', version: 1, eventId }, utc())
        ).toBe('stored')
      },
      runEmails: (config) =>
        dispatchTransactionalEmails(
          f.database,
          {
            async send(message) {
              messages.push(message)
              return { messageId: `local-${messages.length}` }
            }
          },
          config,
          { renderers: [refundSucceededEmailRenderer, creditIssuedEmailRenderer] }
        ),
      sentMessages: () => messages
    })
    expect(result).toMatchObject({
      scenarios: 4,
      externalAcceptance: false,
      inventoryUnchanged: true,
      captureUnchanged: true,
      originalInvoiceUnchanged: true
    })
    expect(scenario).toHaveBeenCalledTimes(4)
  })
})
