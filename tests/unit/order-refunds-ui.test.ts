import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import type { OrderRefundsView } from '../../shared/order-refunds'
import type { CreditView } from '../../shared/fiscal-credit'
import {
  parseRefunds,
  parseFinancialSnapshot,
  prepareFinancialIntent,
  parseFinancialReceipt,
  freshIntentAllowed,
  financialAmount,
  integerInput,
  refundLabel,
  creditLabel,
  privateCreditHref,
  financialResponseErrorCode,
  FinancialCommandSession,
  FinancialHttpFailure,
  type FinancialIntent,
  type FinancialSnapshot
} from '../../app/components/refunds/financial-ui'

const ACTOR = '10000000-0000-4000-8000-000000000041',
  OTHER = '10000000-0000-4000-8000-000000000042',
  ORDER = '20000000-0000-4000-8000-000000000041',
  REFUND = '30000000-0000-4000-8000-000000000041',
  CREDIT = '40000000-0000-4000-8000-000000000041',
  POLICY = '50000000-0000-4000-8000-000000000041',
  RMA = 'RMA-0123456789ABCDEF01234567',
  REASON = 'Reviewed historical inspected return, explicit documented decision',
  HASH = 'a'.repeat(64)
function context(): FinancialSnapshot {
  const refunds: OrderRefundsView = {
    source: 'cloudflare',
    orderId: ORDER,
    capturedCents: 1000,
    reservedCents: 500,
    confirmedCents: 0,
    simulatedConfirmedCents: 0,
    currency: 'EUR',
    inventoryEffect: 'none',
    items: [
      {
        source: 'cloudflare',
        id: REFUND,
        orderId: ORDER,
        returnPublicRef: RMA,
        workflow: 'awaiting_confirmation',
        generation: 1,
        contractFingerprint: HASH,
        amountCents: 500,
        creditId: null,
        currency: 'EUR',
        validationOnly: false,
        financialStatus: 'not_submitted',
        correctiveStatus: 'not_due',
        lastErrorCode: null,
        inventoryEffect: 'none',
        custody: 'non_sellable',
        capabilities: { confirm: true, cancel: true, reconcile: false, resend: false },
        components: [
          {
            component: 'line',
            lineIndex: 0,
            quantity: 1,
            unitOffset: 0,
            sku: 'HISTORICAL-SKU',
            description: 'Historical private line',
            grossCents: 500,
            netCents: 413,
            taxCents: 87,
            taxRateBasisPoints: 2100
          }
        ]
      }
    ]
  }
  return { refunds, credits: [] }
}
function queued() {
  const value = context(),
    item = value.refunds.items[0]!
  item.workflow = 'queued'
  item.generation = 2
  item.capabilities.confirm = false
  return value
}
function completed(): FinancialSnapshot {
  const value = context(),
    item = value.refunds.items[0]!
  item.workflow = 'completed'
  item.generation = 4
  item.financialStatus = 'succeeded'
  item.correctiveStatus = 'completed'
  item.creditId = CREDIT
  item.capabilities = { confirm: false, cancel: false, reconcile: false, resend: false }
  value.refunds.confirmedCents = 500
  const credit: CreditView = {
    source: 'cloudflare',
    id: CREDIT,
    refundId: REFUND,
    orderId: ORDER,
    sourceInvoiceId: POLICY,
    workflow: 'completed',
    generation: 4,
    amountCents: 500,
    currency: 'EUR',
    validationOnly: false,
    code: 'RECT-123',
    fiscalStatus: 'issued',
    pdfAvailable: true,
    lastErrorCode: null,
    capabilities: { reconcile: false, resend: false, editOriginal: false }
  }
  value.credits.push(credit)
  return value
}
const confirmBody = () => ({
  idempotencyKey: 'stable-command-key',
  expectedGeneration: 1,
  contractFingerprint: HASH,
  reason: REASON,
  evidenceRef: 'reviewed-proof'
})
const confirmation = () => ({
  source: 'cloudflare',
  id: REFUND,
  action: 'confirmed',
  generation: 2,
  contractFingerprint: HASH,
  validationOnly: false,
  inventoryEffect: 'none'
})
function confirmationIntent() {
  return prepareFinancialIntent('confirm', confirmBody(), {
    operatorId: ACTOR,
    orderId: ORDER,
    snapshot: context(),
    targetId: REFUND
  })
}
function controller() {
  const session = new FinancialCommandSession()
  session.setOwner(`${ACTOR}:${ORDER}`)
  session.prepare(confirmationIntent())
  return session
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
describe('private financial DTO and immutable administrative command helpers', () => {
  it('parses owned Vue sources locally without Nuxt/typegen/component runner', () => {
    for (const component of ['OrderRefundPanel', 'AdminRefundActions']) {
      const filename = new URL(`../../app/components/refunds/${component}.vue`, import.meta.url),
        { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname })
      expect(errors).toEqual([])
      const script = compileScript(descriptor, { id: component })
      const compiled = compileTemplate({
        source: descriptor.template!.content,
        filename: filename.pathname,
        id: component,
        compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] }
      })
      expect(compiled.errors).toEqual([])
    }
  })
  it('accepts exact history, no current price source and integer cents formatting', () => {
    expect(parseFinancialSnapshot(context(), ORDER, 'admin')).toEqual(context())
    expect(financialAmount(500)).toContain('5,00')
    expect(integerInput('999', 1, 999)).toBe(999)
    for (const raw of ['', '1.5', '1e3', '-1', ' 1', '01', '1000']) expect(() => integerInput(raw, 1, 999)).toThrow()
    for (const raw of [-1, 500.1, Number.MAX_SAFE_INTEGER]) expect(() => financialAmount(raw)).toThrow()
  })
  it('rejects wrong order, malformed own JSON/getters/sparse arrays, contradictory outcomes and unauthorized capabilities', () => {
    const poisoned = context(),
      getter = vi.fn(() => 1000)
    Object.defineProperty(poisoned.refunds, 'capturedCents', { get: getter, enumerable: true })
    const invalid = [
      poisoned,
      { ...context(), refunds: { ...context().refunds, orderId: POLICY } },
      { ...context(), refunds: { ...context().refunds, reservedCents: 0 } },
      { ...context(), refunds: { ...context().refunds, items: new Array(1) } },
      {
        ...context(),
        refunds: {
          ...context().refunds,
          items: [...context().refunds.items, ...context().refunds.items],
          reservedCents: 1000
        }
      },
      {
        ...context(),
        refunds: { ...context().refunds, items: [{ ...context().refunds.items[0], financialStatus: 'succeeded' }] }
      },
      {
        ...context(),
        refunds: {
          ...context().refunds,
          items: [{ ...context().refunds.items[0], amountCents: 499 }],
          reservedCents: 499
        }
      },
      { ...context(), credits: [completed().credits[0]] },
      Object.assign(Object.create({ inherited: true }), context())
    ]
    for (const raw of invalid) expect(() => parseFinancialSnapshot(raw, ORDER, 'admin')).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(() => parseRefunds(context().refunds, ORDER, 'customer')).toThrow()
    const customer = context().refunds
    customer.items[0]!.capabilities = { confirm: false, cancel: false, reconcile: false, resend: false }
    expect(parseRefunds(customer, ORDER, 'customer')).toEqual(customer)
  })
  it('binds all credit identities/amounts/validation to owned refund, not a guessable UUID', () => {
    const value = completed()
    expect(parseFinancialSnapshot(value, ORDER, 'admin')).toEqual(value)
    for (const patch of [
      { orderId: POLICY },
      { refundId: POLICY },
      { id: POLICY },
      { amountCents: 501 },
      { validationOnly: true }
    ]) {
      const bad = completed()
      Object.assign(bad.credits[0]!, patch)
      expect(() => parseFinancialSnapshot(bad, ORDER, 'admin')).toThrow()
    }
    const noCredits = { ...completed(), credits: [] }
    expect(() => parseFinancialSnapshot(noCredits, ORDER, 'admin')).toThrow()
  })
  it('never calls queue/uncertain/completed-pending or synthetic results a real issued/refunded document', () => {
    const value = completed(),
      refund = value.refunds.items[0]!,
      credit = value.credits[0]!
    expect(refundLabel(context().refunds.items[0]!)).toContain('Autorización pendiente')
    expect(refundLabel(queued().refunds.items[0]!)).toContain('Ejecución pendiente')
    expect(refundLabel(refund)).toBe('Operación de devolución confirmada')
    refund.validationOnly = true
    expect(refundLabel(refund)).toContain('Sin movimiento bancario')
    credit.fiscalStatus = 'fiscal_pending'
    expect(creditLabel(credit)).toContain('Estado fiscal pendiente')
    expect(creditLabel(credit)).not.toContain('emitida')
    credit.validationOnly = true
    expect(creditLabel(credit)).toContain('simulado pendiente')
    credit.workflow = 'uncertain'
    credit.pdfAvailable = false
    credit.capabilities.reconcile = true
    credit.fiscalStatus = 'issued'
    expect(creditLabel(credit)).toContain('no confirmado')
    expect(creditLabel(credit)).not.toContain('emitida')
    expect(privateCreditHref(credit, 'admin')).toBeNull()
  })
  it('uses only authorized completed DTO private PDF endpoints, no token, storage/object key or external href', () => {
    const value = completed().credits[0]!
    expect(privateCreditHref(value, 'customer')).toBe(`/api/orders/${ORDER}/credits/${CREDIT}/pdf`)
    expect(privateCreditHref(value, 'admin')).toBe(`/api/admin/orders/${ORDER}/credits/${CREDIT}/pdf`)
    expect(privateCreditHref({ ...value, pdfAvailable: false }, 'customer')).toBeNull()
    expect(() => privateCreditHref({ ...value, storageKey: 'private/key.pdf' } as CreditView, 'customer')).toThrow()
  })
  it('prepares exact bodies and same-origin admin routes without header idempotency invented by the UI', () => {
    const intent = confirmationIntent()
    expect(intent.endpoint).toBe(`/api/admin/refunds/${REFUND}/confirm`)
    expect(intent.body).toEqual(confirmBody())
    expect(Object.isFrozen(intent.body)).toBe(true)
    expect(() => {
      intent.body.reason = 'mutated reason'
    }).toThrow()
    expect(parseFinancialReceipt(confirmation(), intent)).toEqual(confirmation())
    for (const patch of [
      { action: 'reconciled' },
      { id: POLICY },
      { generation: 3 },
      { contractFingerprint: 'f'.repeat(64) },
      { validationOnly: true }
    ])
      expect(() => parseFinancialReceipt({ ...confirmation(), ...patch }, intent)).toThrow()
  })
  it('requires explicit policy/RMA/version and permits full maintained quantity bounds, optional compensation/ports only explicit', () => {
    const body = {
        idempotencyKey: 'plan-exact',
        policyId: POLICY,
        returnPublicRef: RMA,
        expectedReturnVersion: 5,
        reason: REASON,
        evidenceRef: 'policy-proof',
        lines: [{ lineIndex: 99, quantity: 999 }]
      },
      intent = prepareFinancialIntent('plan', body, { operatorId: ACTOR, orderId: ORDER, snapshot: context() })
    expect(intent.body).toEqual(body)
    expect(intent.endpoint).toBe('/api/admin/refunds/requests')
    expect(intent.body).not.toHaveProperty('shippingCents')
    expect(() =>
      prepareFinancialIntent(
        'plan',
        { ...body, policyId: '' },
        { operatorId: ACTOR, orderId: ORDER, snapshot: context() }
      )
    ).toThrow()
    const explicit = prepareFinancialIntent(
      'plan',
      { ...body, shippingCents: 110, lines: [{ lineIndex: 0, quantity: 1, amountCents: 200 }] },
      { operatorId: ACTOR, orderId: ORDER, snapshot: context() }
    )
    expect(explicit.body).toMatchObject({ shippingCents: 110, lines: [{ amountCents: 200 }] })
  })
  it('requires capabilities and matching current generation/fingerprint, never permits a bank resend command', () => {
    expect(() =>
      prepareFinancialIntent(
        'confirm',
        { ...confirmBody(), expectedGeneration: 2 },
        { operatorId: ACTOR, orderId: ORDER, snapshot: context(), targetId: REFUND }
      )
    ).toThrow()
    expect(() =>
      prepareFinancialIntent('confirm', confirmBody(), {
        operatorId: ACTOR,
        orderId: ORDER,
        snapshot: queued(),
        targetId: REFUND
      })
    ).toThrow()
    expect(() =>
      prepareFinancialIntent('confirm', confirmBody(), {
        operatorId: 'guest',
        orderId: ORDER,
        snapshot: context(),
        targetId: REFUND
      })
    ).toThrow()
    expect(freshIntentAllowed(confirmationIntent(), queued(), false)).toBe(false)
    expect(freshIntentAllowed(confirmationIntent(), queued(), true)).toBe(true)
    const drift = context()
    drift.refunds.items[0]!.contractFingerprint = 'b'.repeat(64)
    expect(freshIntentAllowed(confirmationIntent(), drift, true)).toBe(false)
  })
  it('queues corrective obligation only after completed refund and reconciles credit through the documented CAS body', () => {
    const done = completed(),
      refund = done.refunds.items[0]!
    refund.creditId = null
    refund.correctiveStatus = 'blocked_policy'
    done.credits = []
    const queue = prepareFinancialIntent(
      'queue_credit',
      { idempotencyKey: 'credit-queue', policyId: POLICY, reason: REASON, evidenceRef: 'explicit-credit-policy' },
      { operatorId: ACTOR, orderId: ORDER, snapshot: done, targetId: REFUND }
    )
    expect(queue.endpoint).toBe(`/api/admin/refunds/${REFUND}/credit`)
    expect(queue.body).not.toHaveProperty('expectedGeneration')
    expect(() =>
      prepareFinancialIntent('queue_credit', queue.body, {
        operatorId: ACTOR,
        orderId: ORDER,
        snapshot: context(),
        targetId: REFUND
      })
    ).toThrow()
    const uncertain = completed()
    uncertain.credits[0]!.workflow = 'uncertain'
    uncertain.credits[0]!.pdfAvailable = false
    uncertain.credits[0]!.capabilities.reconcile = true
    uncertain.refunds.items[0]!.correctiveStatus = 'uncertain'
    const reconcile = prepareFinancialIntent(
      'reconcile_credit',
      { idempotencyKey: 'credit-reconcile', expectedGeneration: 4, reason: REASON, evidenceRef: 'authoritative-proof' },
      { operatorId: ACTOR, orderId: ORDER, snapshot: uncertain, targetId: CREDIT }
    )
    expect(reconcile.endpoint).toBe(`/api/admin/credits/${CREDIT}/reconcile`)
    expect(
      parseFinancialReceipt(
        {
          source: 'cloudflare',
          id: CREDIT,
          refundId: REFUND,
          action: 'reconciled',
          generation: 5,
          contractFingerprint: HASH,
          validationOnly: false
        },
        reconcile
      ).action
    ).toBe('reconciled')
  })
  it('accepts an authoritative pending reconciliation receipt as blocked, not succeeded', () => {
    const value = context(),
      item = value.refunds.items[0]!
    item.workflow = 'pending_provider'
    item.financialStatus = 'pending'
    item.generation = 3
    item.capabilities = { confirm: false, cancel: false, reconcile: true, resend: false }
    const intent = prepareFinancialIntent(
      'reconcile_refund',
      { idempotencyKey: 'pending-proof', expectedGeneration: 3, reason: REASON, evidenceRef: 'provider-pending-proof' },
      { operatorId: ACTOR, orderId: ORDER, snapshot: value, targetId: REFUND }
    )
    expect(parseFinancialReceipt({ ...confirmation(), action: 'blocked', generation: 4 }, intent).action).toBe(
      'blocked'
    )
  })
  it('classifies only bounded own 4xx codes and never executes error getters or treats 5xx as definite failure', () => {
    const getter = vi.fn(() => ({ code: 'version_conflict' })),
      poisoned = {}
    Object.defineProperty(poisoned, 'error', { get: getter, enumerable: true })
    expect(
      financialResponseErrorCode({ response: { status: 409, _data: { error: { code: 'version_conflict' } } } })
    ).toBe('version_conflict')
    expect(
      financialResponseErrorCode({ response: { status: 503, _data: { error: { code: 'invalid_input' } } } })
    ).toBeNull()
    expect(financialResponseErrorCode({ response: { status: 409, _data: poisoned } })).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('financial command session fresh-read fencing and exact unknown-outcome replay', () => {
  it('performs fresh GET→single administrative POST→GET, with no financial success assertion from the command receipt', async () => {
    const session = controller(),
      events: string[] = [],
      read = vi.fn(async () => {
        events.push('GET')
        return events.length === 1 ? context() : queued()
      }),
      post = vi.fn<(intent: FinancialIntent) => Promise<unknown>>(async () => {
        events.push('POST')
        return confirmation()
      })
    const result = await session.send({ read, post, authorized: () => true })
    expect(result.kind).toBe('confirmed')
    expect(events).toEqual(['GET', 'POST', 'GET'])
    expect(session.intent).toBeNull()
    expect(session.ambiguous).toBe(false)
    if (result.kind === 'confirmed') expect(result.latest?.refunds.items[0]?.financialStatus).toBe('not_submitted')
  })
  it('blocks concurrent clicks and known CAS drift before POST; new attempts never silently use a refreshed version', async () => {
    const session = controller(),
      waiting = deferred<unknown>(),
      post = vi.fn(),
      deps = { read: () => waiting.promise, post, authorized: () => true },
      run = session.send(deps)
    expect((await session.send(deps)).kind).toBe('ignored')
    waiting.resolve(queued())
    expect((await run).kind).toBe('stale')
    expect(post).not.toHaveBeenCalled()
    expect(session.intent).toBeNull()
  })
  it('retains exactly body+key after response loss, refreshes before explicit recovery and never auto-replays', async () => {
    const session = controller(),
      before = session.intent!,
      read = vi.fn(async () => context()),
      post = vi.fn<(intent: FinancialIntent) => Promise<unknown>>(async () => {
        throw new Error('simulated response loss')
      })
    expect((await session.send({ read, post, authorized: () => true })).kind).toBe('unknown')
    expect(post).toHaveBeenCalledOnce()
    expect(session.intent).toBe(before)
    expect(session.discard()).toBe(false)
    expect(() => session.prepare(confirmationIntent())).toThrow()
    read.mockResolvedValue(queued())
    post.mockImplementation(async () => confirmation())
    expect((await session.send({ read, post, authorized: () => true })).kind).toBe('confirmed')
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]![0]).toBe(before)
    expect(post.mock.calls[1]![0]).toBe(before)
    expect(post.mock.calls[1]![0].body).toBe(before.body)
  })
  it('keeps ambiguity after malformed receipt or unresolved recovery 409, but releases a first known CAS rejection', async () => {
    const session = controller(),
      intent = session.intent!,
      read = vi.fn(async () => context()),
      post = vi.fn(async () => ({ ...confirmation(), id: POLICY }))
    expect((await session.send({ read, post, authorized: () => true })).kind).toBe('unknown')
    post.mockImplementation(async () => {
      throw new FinancialHttpFailure('version_conflict')
    })
    expect((await session.send({ read, post, authorized: () => true })).kind).toBe('unknown')
    expect(session.intent).toBe(intent)
    const first = controller()
    expect((await first.send({ read, post, authorized: () => true })).kind).toBe('rejected')
    expect(first.intent).toBeNull()
  })
  it.each(['before_post', 'after_post'])(
    'clears PII and rejects late completions after actor change %s',
    async (phase) => {
      const session = controller(),
        waiting = deferred<unknown>(),
        post = vi.fn(async () => (phase === 'after_post' ? waiting.promise : confirmation())),
        read = vi.fn(async () => (phase === 'before_post' ? waiting.promise : context())),
        run = session.send({ read, post, authorized: () => true })
      if (phase === 'after_post') await vi.waitFor(() => expect(post).toHaveBeenCalledOnce())
      session.setOwner(`${OTHER}:${ORDER}`)
      expect(session.intent).toBeNull()
      expect(session.busy).toBe(false)
      expect(session.ambiguous).toBe(false)
      waiting.resolve(phase === 'before_post' ? context() : confirmation())
      expect((await run).kind).toBe('discarded')
      expect(post).toHaveBeenCalledTimes(phase === 'before_post' ? 0 : 1)
    }
  )
  it('never sends when permission is revoked during GET or fresh read is unconfirmed/throws', async () => {
    const session = controller(),
      waiting = deferred<unknown>(),
      post = vi.fn(),
      authorized = vi.fn(() => true),
      run = session.send({ read: () => waiting.promise, post, authorized })
    authorized.mockReturnValue(false)
    waiting.resolve(context())
    expect((await run).kind).toBe('discarded')
    expect(post).not.toHaveBeenCalled()
    const missing = controller()
    expect((await missing.send({ read: async () => null, post, authorized: () => true })).kind).toBe('not_sent')
    expect(missing.intent).not.toBeNull()
    expect(missing.ambiguous).toBe(false)
    expect(
      (
        await missing.send({
          read: async () => context(),
          post,
          authorized: () => {
            throw new Error('auth unknown')
          }
        })
      ).kind
    ).toBe('ignored')
  })
  it('keeps a confirmed historical receipt separate when the subsequent live state cannot be confirmed', async () => {
    const session = controller(),
      read = vi.fn().mockResolvedValueOnce(context()).mockResolvedValueOnce(null)
    const result = await session.send({ read, post: async () => confirmation(), authorized: () => true })
    expect(result).toMatchObject({ kind: 'confirmed', latest: null, receipt: confirmation() })
    expect(session.intent).toBeNull()
  })
})
