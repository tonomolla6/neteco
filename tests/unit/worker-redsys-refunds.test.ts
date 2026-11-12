import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { refundContractSchema, refundPolicyInputSchema, type RefundPolicy } from '../../shared/order-refunds'
import { WorkerRedsysRefundProvider, type WorkerRedsysRefundConfiguration } from '../../workers/refunds/redsys-provider'
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  signMerchantParameters,
  verifyMerchantSignature
} from '../../workers/payments/redsys'
import { hash } from '../../workers/refunds/authority'
import { refundsCreditFixture, CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import { approveRefundPolicy, withdrawFinancialPolicy } from '../../workers/refunds/policies'
import { dispatchD1Refunds, planD1Refund, reconcileD1Refund } from '../../workers/refunds/operations'
import { testUuid } from '../support/deterministic'

const configuration: WorkerRedsysRefundConfiguration = {
  appEnvironment: 'preview',
  environment: 'sandbox',
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: '001',
  currency: '978',
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey
}
const opened: DatabaseSync[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const database of opened.splice(0)) database.close()
})
async function approved(environment: 'sandbox' | 'production' = 'sandbox') {
  const input = refundPolicyInputSchema.parse({
    idempotencyKey: 'governed-refund-policy',
    provider: 'redsys',
    environment,
    mappings: { merchantCode: configuration.merchantCode, terminal: '1', currencyCode: '978' },
    shipping: 'excluded',
    approvalMode: 'same_actor_confirmation',
    maximumRefundCents: 100000,
    evidenceRef: 'offline-protocol-contract',
    reason: 'Documented refund operation under explicit approved policy'
  })
  return {
    ...input,
    id: testUuid(),
    approvedAt: '2026-10-03T10:00:00Z',
    fingerprint: await hash({ scope: 'refund', input })
  }
}
function historicalContract(policy: RefundPolicy) {
  return refundContractSchema.parse({
    schemaVersion: 1,
    refundId: testUuid(),
    orderId: testUuid(),
    returnId: testUuid(),
    returnPublicRef: 'RMA-0123456789ABCDEF01234567',
    returnVersion: 5,
    policyId: policy.id,
    policyFingerprint: policy.fingerprint,
    provider: 'redsys',
    environment: policy.environment,
    validationOnly: false,
    idempotencyKey: 'confirmed-historical-refund',
    reason: 'Historical inspected return without automatic stock replacement',
    evidenceRef: 'captured-authorization-proof',
    createdAt: '2026-10-03T10:01:00Z',
    capture: {
      paymentIntentId: testUuid(),
      merchantOrder: '1234567890',
      providerReference: '1234567890:ABC123',
      capturedCents: 1000,
      currency: 'EUR',
      environment: policy.environment,
      mappings: policy.mappings,
      envelopeHash: 'a'.repeat(64)
    },
    contact: { email: 'historical@example.test', name: 'Historical Customer' },
    sourceHash: 'b'.repeat(64),
    components: [
      {
        component: 'line',
        lineIndex: 0,
        quantity: 1,
        unitOffset: 0,
        sku: 'HISTORICAL-SKU',
        description: 'Historical order line',
        grossCents: 500,
        netCents: 413,
        taxCents: 87,
        taxRateBasisPoints: 2100
      }
    ],
    amountCents: 500,
    currency: 'EUR',
    inventoryEffect: 'none',
    custody: 'non_sellable'
  })
}
function sent(init?: RequestInit) {
  return decodeMerchantParameters(JSON.parse(String(init?.body)).Ds_MerchantParameters)
}
async function reply(init?: RequestInit, changes: Record<string, string> = {}, rawJson?: string) {
  const request = sent(init),
    values = {
      Ds_Amount: String(Number(request.DS_MERCHANT_AMOUNT)),
      Ds_Currency: '978',
      Ds_Order: request.DS_MERCHANT_ORDER!,
      Ds_MerchantCode: request.DS_MERCHANT_MERCHANTCODE!,
      Ds_Terminal: '1',
      Ds_Response: '0900',
      Ds_TransactionType: '3',
      Ds_MerchantData: request.DS_MERCHANT_MERCHANTDATA!,
      Ds_AuthorisationCode: 'REF123',
      Ds_Control_1680100010873: '1680100010873',
      ...changes
    },
    encoded = rawJson ? Buffer.from(rawJson).toString('base64url') : encodeMerchantParameters(values)
  return Response.json({
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_MerchantParameters: encoded,
    Ds_Signature: await signMerchantParameters(encoded, configuration.secretKey, request.DS_MERCHANT_ORDER)
  })
}
async function adapter(fetcher: typeof fetch, policy?: RefundPolicy) {
  const selected = policy ?? (await approved())
  return { policy: selected, provider: await WorkerRedsysRefundProvider.create(configuration, selected, fetcher) }
}

describe('governed Worker Redsys refund protocol, entirely injected/offline', () => {
  it('sends exactly operation 3, captured merchant_order and integer EUR amount using maintained V2 signing', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init)),
      { policy, provider } = await adapter(fetcher),
      contract = historicalContract(policy),
      receipt = await provider.refund(contract),
      [url, init] = fetcher.mock.calls[0]!,
      envelope = JSON.parse(String(init?.body)),
      parameters = sent(init)
    expect(url).toBe('https://sis-t.redsys.es:25443/sis/rest/trataPeticionREST')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(parameters).toEqual({
      DS_MERCHANT_ORDER: contract.capture.merchantOrder,
      DS_MERCHANT_MERCHANTCODE: configuration.merchantCode,
      DS_MERCHANT_TERMINAL: '1',
      DS_MERCHANT_TRANSACTIONTYPE: '3',
      DS_MERCHANT_CURRENCY: '978',
      DS_MERCHANT_AMOUNT: '500',
      DS_MERCHANT_MERCHANTDATA: `NRF1${await hash(contract)}`,
      DS_MERCHANT_AUTHORISATIONCODE: 'ABC123'
    })
    expect(parameters.DS_MERCHANT_ORDER).not.toBe(contract.orderId)
    await expect(
      verifyMerchantSignature(envelope.Ds_MerchantParameters, envelope.Ds_Signature, configuration.secretKey)
    ).resolves.toBe(true)
    expect(receipt).toEqual({
      providerReference: expect.stringMatching(/^redsys-refund:[0-9a-f]{64}$/),
      status: 'succeeded',
      amountCents: 500,
      currency: 'EUR',
      merchantOrder: contract.capture.merchantOrder,
      contractFingerprint: await hash(contract),
      validationOnly: false
    })
    expect(String(init?.body)).not.toContain(contract.contact.email)
    expect(String(init?.body)).not.toContain(configuration.secretKey)
    expect('lookupByExternalKey' in provider).toBe(false)
  })
  it('uses unique captured order without inventing an authorization code or a bank refund reference', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init, { Ds_AuthorisationCode: '' })),
      { provider, policy } = await adapter(fetcher),
      contract = historicalContract(policy)
    contract.capture.providerReference = null
    const receipt = await provider.refund(contract)
    expect(sent(fetcher.mock.calls[0]![1])).not.toHaveProperty('DS_MERCHANT_AUTHORISATIONCODE')
    expect(receipt.providerReference).not.toBe(contract.capture.merchantOrder)
  })
  it('requires explicit compatible app/provider environments, immutable policy/config and injected transport', async () => {
    const policy = await approved(),
      fetcher = vi.fn<typeof fetch>(),
      getter = vi.fn(() => configuration.secretKey),
      poisoned = { ...configuration }
    Object.defineProperty(poisoned, 'secretKey', { get: getter, enumerable: true })
    for (const raw of [
      { ...configuration, appEnvironment: 'local' },
      { ...configuration, appEnvironment: 'production' },
      { ...configuration, environment: 'production' },
      { ...configuration, currency: '840' },
      { ...configuration, merchantCode: '123' },
      { ...configuration, terminal: '000' },
      { ...configuration, secretKey: 'non-ASCII-é' },
      { ...configuration, timeoutMs: 0 },
      { ...configuration, baseUrl: 'https://sis.redsys.es/sis/rest/trataPeticionREST' },
      poisoned,
      Object.assign(Object.create({ inherited: true }), configuration)
    ])
      await expect(
        WorkerRedsysRefundProvider.create(raw as WorkerRedsysRefundConfiguration, policy, fetcher)
      ).rejects.toMatchObject({ code: 'configuration' })
    await expect(
      WorkerRedsysRefundProvider.create(configuration, policy, undefined as unknown as typeof fetch)
    ).rejects.toMatchObject({ code: 'configuration' })
    for (const raw of [
      { ...policy, fingerprint: '0'.repeat(64) },
      { ...policy, mappings: { ...policy.mappings, terminal: '2' } },
      { ...policy, provider: 'local_fake', environment: 'local_validation' },
      { ...policy, approvedAt: undefined },
      { ...policy, unapprovedFlag: true }
    ])
      await expect(
        WorkerRedsysRefundProvider.create(configuration, raw as RefundPolicy, fetcher)
      ).rejects.toMatchObject({ code: 'policy' })
    expect(getter).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const copied = { ...configuration },
      goodFetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init)),
      provider = await WorkerRedsysRefundProvider.create(copied, policy, goodFetcher)
    copied.merchantCode = '111111111'
    policy.mappings.terminal = '2'
    await provider.refund(historicalContract({ ...policy, mappings: { ...policy.mappings, terminal: '1' } }))
    expect(sent(goodFetcher.mock.calls[0]![1]).DS_MERCHANT_MERCHANTCODE).toBe(configuration.merchantCode)
  })
  it('selects the fixed production endpoint only for explicitly production policy, snapshot and app', async () => {
    const policy = await approved('production'),
      fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init)),
      provider = await WorkerRedsysRefundProvider.create(
        { ...configuration, environment: 'production', appEnvironment: 'production' },
        policy,
        fetcher
      )
    await provider.refund(historicalContract(policy))
    expect(fetcher.mock.calls[0]![0]).toBe('https://sis.redsys.es/sis/rest/trataPeticionREST')
  })
  it('rejects source/policy drift, getters, invalid amount/currency and unmanaged shipping before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>(),
      { provider, policy } = await adapter(fetcher),
      base = historicalContract(policy),
      getter = vi.fn(() => 500),
      poisoned = structuredClone(base)
    Object.defineProperty(poisoned, 'amountCents', { get: getter, enumerable: true })
    const invalid = [
      { ...base, amountCents: 500.1 },
      { ...base, amountCents: 0 },
      { ...base, amountCents: 1001 },
      { ...base, currency: 'USD' },
      { ...base, validationOnly: true },
      { ...base, policyId: testUuid() },
      { ...base, policyFingerprint: 'c'.repeat(64) },
      { ...base, capture: { ...base.capture, environment: 'production' } },
      { ...base, capture: { ...base.capture, mappings: { ...base.capture.mappings, terminal: '2' } } },
      { ...base, capture: { ...base.capture, providerReference: 'other-order:ABC123' } },
      { ...base, capture: { ...base.capture, merchantOrder: base.orderId } },
      {
        ...base,
        components: [{ ...base.components[0], component: 'shipping', lineIndex: null, quantity: 1 }]
      },
      poisoned
    ]
    for (const raw of invalid)
      await expect(provider.refund(raw as typeof base)).rejects.toMatchObject({ code: 'request' })
    const lowPolicy = await approved()
    lowPolicy.maximumRefundCents = 499
    const { id: _id, fingerprint: _fingerprint, approvedAt: _at, ...input } = lowPolicy
    lowPolicy.fingerprint = await hash({ scope: 'refund', input })
    const capped = await WorkerRedsysRefundProvider.create(configuration, lowPolicy, fetcher)
    await expect(capped.refund(historicalContract(lowPolicy))).rejects.toMatchObject({ code: 'request' })
    expect(getter).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    ['operation 2 copied from inconsistent official example', { Ds_TransactionType: '2' }],
    ['authorization instead of refund', { Ds_TransactionType: '0', Ds_Response: '0000' }],
    ['cancellation instead of refund', { Ds_TransactionType: '45', Ds_Response: '0400' }],
    ['different captured order', { Ds_Order: '9999999999' }],
    ['different amount', { Ds_Amount: '501' }],
    ['fractional amount', { Ds_Amount: '5.00' }],
    ['different currency', { Ds_Currency: '840' }],
    ['different merchant', { Ds_MerchantCode: '111111111' }],
    ['different terminal', { Ds_Terminal: '2' }],
    ['missing correlation', { Ds_MerchantData: '' }],
    ['different refund correlation', { Ds_MerchantData: `NRF1${'f'.repeat(64)}` }],
    ['not a proven refund success', { Ds_Response: '9998' }],
    ['authorization success code is not refund success', { Ds_Response: '0000' }]
  ])('never confirms ambiguous signed response: %s', async (_label, changes) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init, changes)),
      { provider, policy } = await adapter(fetcher)
    await expect(provider.refund(historicalContract(policy))).rejects.toMatchObject({
      code: 'outcome_unconfirmed',
      possibleAcceptance: true
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('rejects a valid signed old response for an equal-amount second partial refund on the same capture', async () => {
    let prior: Response | undefined
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        prior ??= await reply(init)
        return prior.clone()
      }),
      { policy, provider } = await adapter(fetcher),
      first = historicalContract(policy)
    await provider.refund(first)
    const second = { ...first, refundId: testUuid(), idempotencyKey: 'second-partial' }
    await expect(provider.refund(second)).rejects.toMatchObject({ code: 'outcome_unconfirmed' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sent(fetcher.mock.calls[0]![1]).DS_MERCHANT_MERCHANTDATA).not.toBe(
      sent(fetcher.mock.calls[1]![1]).DS_MERCHANT_MERCHANTDATA
    )
  })
  it('rejects invalid signature/version, ambiguous JSON aliases, duplicate/escaped names and malformed bytes', async () => {
    const policy = await approved(),
      contract = historicalContract(policy)
    const responses: Array<(init?: RequestInit) => Promise<Response>> = [
      async (init) => Response.json({ ...(await (await reply(init)).json()), Ds_Signature: 'invalid' }),
      async (init) => Response.json({ ...(await (await reply(init)).json()), Ds_SignatureVersion: 'HMAC_SHA256_V1' }),
      async (init) => {
        const body = await (await reply(init)).text()
        return new Response(body.replace('{', '{"Ds_SignatureVersion":"HMAC_SHA256_V1",'), {
          headers: { 'Content-Type': 'application/json' }
        })
      },
      async (init) => {
        const response = await reply(init),
          envelope = await response.json(),
          raw = Buffer.from(envelope.Ds_MerchantParameters, 'base64url').toString()
        for (const duplicate of ['"Ds_Amount":"499",', '"DS_AMOUNT":"499",', '"Ds_\\u0041mount":"499",']) {
          const bad = await reply(init, {}, raw.replace('{', `{${duplicate}`))
          const provider = await WorkerRedsysRefundProvider.create(
            configuration,
            policy,
            vi.fn(async () => bad)
          )
          await expect(provider.refund(contract)).rejects.toMatchObject({ code: 'outcome_unconfirmed' })
        }
        return reply(init, {}, raw.replace('"Ds_Amount":"500"', '"Ds_Amount":500'))
      },
      async () => new Response('{"__proto__":"malformed"}', { headers: { 'Content-Type': 'application/json' } }),
      async () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'Content-Type': 'application/json' } })
    ]
    for (const response of responses) {
      const provider = await WorkerRedsysRefundProvider.create(
        configuration,
        policy,
        vi.fn(async (_url, init) => response(init))
      )
      await expect(provider.refund(contract)).rejects.toMatchObject({ code: 'outcome_unconfirmed' })
    }
  })
  it('bounds response streams/status/type and does not read provider error bodies or follow redirects', async () => {
    const policy = await approved(),
      contract = historicalContract(policy),
      cancel = vi.fn()
    for (const response of [
      new Response('private bank error', { status: 502, headers: { 'Content-Type': 'application/json' } }),
      new Response('redirect', { status: 307, headers: { Location: 'https://sis.redsys.es/' } }),
      new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '32769' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': 'invalid' } }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(32769))
          },
          cancel
        }),
        {
          headers: { 'Content-Type': 'application/json' }
        }
      )
    ]) {
      const provider = await WorkerRedsysRefundProvider.create(
        configuration,
        policy,
        vi.fn(async () => response)
      )
      await expect(provider.refund(contract)).rejects.toMatchObject({ code: 'outcome_unconfirmed' })
    }
    expect(cancel).toHaveBeenCalled()
    const sensitive = 'bank accepted but response lost: private details',
      fetcher = vi.fn<typeof fetch>(async () => {
        throw new Error(sensitive)
      }),
      provider = await WorkerRedsysRefundProvider.create(configuration, policy, fetcher)
    await expect(provider.refund(contract)).rejects.toMatchObject({ message: 'redsys_refund_outcome_unconfirmed' })
  })
  it('bounds both ignored transport and never-ending response body without retrying', async () => {
    vi.useFakeTimers()
    for (const bodyWait of [false, true]) {
      const fetcher = vi.fn<typeof fetch>(async () =>
          bodyWait
            ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'application/json' } })
            : new Promise<Response>(() => {})
        ),
        policy = await approved(),
        provider = await WorkerRedsysRefundProvider.create({ ...configuration, timeoutMs: 1000 }, policy, fetcher),
        result = provider.refund(historicalContract(policy)),
        rejection = expect(result).rejects.toMatchObject({ code: 'outcome_unconfirmed' })
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(1001)
      await rejection
      expect(fetcher).toHaveBeenCalledOnce()
      expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    }
  })
})

describe('actual D1 capture/policy fencing with offline Redsys REST adapter', () => {
  async function queued() {
    const fixture = await refundsCreditFixture()
    opened.push(fixture.sqlite)
    const { id: _id, fingerprint: _fingerprint, approvedAt: _at, ...input } = fixture.policy,
      policy = await approveRefundPolicy(fixture.database, CLAIMS, {
        ...input,
        idempotencyKey: testUuid(),
        provider: 'redsys',
        environment: 'sandbox',
        evidenceRef: 'signed-offline-capture-rest-protocol'
      }),
      planned = await planD1Refund(fixture.database, CLAIMS, {
        idempotencyKey: testUuid(),
        policyId: policy.id,
        returnPublicRef: fixture.returnRef,
        expectedReturnVersion: 5,
        reason: REASON,
        evidenceRef: 'signed-capture-checked-by-engine',
        lines: [{ lineIndex: 0, quantity: 2 }]
      })
    await fixture.confirm(planned.id, planned.generation, planned.contractFingerprint)
    return { ...fixture, policy, planned }
  }
  it('requires explicit policy allowlist/enable/environment; withdrawal blocks before any bank transport', async () => {
    const f = await queued(),
      fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(init)),
      provider = await WorkerRedsysRefundProvider.create(configuration, f.policy, fetcher),
      base = { now: utc(), appEnvironment: 'preview' as const }
    for (const config of [
      base,
      { ...base, enabled: true },
      { ...base, policyId: f.policy.id },
      { ...base, enabled: true, policyId: f.policy.id, appEnvironment: 'local' as const }
    ])
      expect(await dispatchD1Refunds(f.database, provider, config)).toMatchObject({ completed: 0 })
    await withdrawFinancialPolicy(f.database, CLAIMS, f.policy.id, REASON, 'withdraw-before-rest')
    expect(
      await dispatchD1Refunds(f.database, provider, { ...base, enabled: true, policyId: f.policy.id })
    ).toMatchObject({ completed: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('correlates a real captured D1 snapshot without altering original capture/stock and records corrective obligation', async () => {
    const f = await queued(),
      capture = f.sqlite.prepare('SELECT * FROM order_payment_states').all(),
      stock = f.sqlite.prepare('SELECT * FROM inventory_balances').all(),
      fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        expect(f.sqlite.prepare('SELECT status FROM refund_work WHERE refund_id=?').get(f.planned.id)?.status).toBe(
          'submitting'
        )
        return reply(init)
      }),
      provider = await WorkerRedsysRefundProvider.create(configuration, f.policy, fetcher),
      config = { now: utc(), appEnvironment: 'preview' as const, enabled: true, policyId: f.policy.id }
    expect(await dispatchD1Refunds(f.database, provider, config)).toMatchObject({ completed: 1 })
    expect(await dispatchD1Refunds(f.database, provider, config)).toMatchObject({ completed: 0 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(f.sqlite.prepare('SELECT * FROM order_payment_states').all()).toEqual(capture)
    expect(f.sqlite.prepare('SELECT * FROM inventory_balances').all()).toEqual(stock)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_fake_effects').get()?.n).toBe(0)
  })
  it.each(['lost_response', 'bad_correlation', 'commit_failure'])(
    'holds budget and never repeats ambiguous acceptance: %s',
    async (fault) => {
      const f = await queued(),
        fetcher = vi.fn<typeof fetch>(async (_url, init) => {
          const response = await reply(init, fault === 'bad_correlation' ? { Ds_MerchantData: '' } : {})
          if (fault === 'lost_response') throw new Error('simulated accepted response loss, not a real bank call')
          return response
        }),
        provider = await WorkerRedsysRefundProvider.create(configuration, f.policy, fetcher),
        database =
          fault !== 'commit_failure'
            ? f.database
            : ({
                ...f.database,
                async batch(statements: D1PreparedStatement[]) {
                  if (
                    statements.some((statement) =>
                      (statement as unknown as { sql?: string }).sql?.includes('INSERT INTO refund_receipts')
                    )
                  )
                    throw new Error('synthetic completion commit unavailable')
                  return f.database.batch(statements)
                }
              } as D1Database),
        config = { now: utc(), appEnvironment: 'preview' as const, enabled: true, policyId: f.policy.id }
      expect(await dispatchD1Refunds(database, provider, config)).toMatchObject({ uncertain: 1, completed: 0 })
      expect(await dispatchD1Refunds(f.database, provider, config)).toMatchObject({ completed: 0 })
      expect(f.sqlite.prepare('SELECT status FROM refund_work WHERE refund_id=?').get(f.planned.id)?.status).toBe(
        'uncertain'
      )
      expect(f.sqlite.prepare('SELECT sum(gross_cents) AS n FROM refund_allocations').get()?.n).toBe(1000)
      await expect(
        reconcileD1Refund(
          f.database,
          CLAIMS,
          f.planned.id,
          {
            idempotencyKey: testUuid(),
            expectedGeneration: 3,
            reason: REASON,
            evidenceRef: 'no-authoritative-rest-lookup-configured'
          },
          provider
        )
      ).rejects.toMatchObject({ code: 'lookup_unavailable' })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM refund_credit_obligations').get()?.n).toBe(0)
    }
  )
})
