import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addOtherCustomer,
  fakeOneClickProvider,
  payExtFixture,
  redsysConfig,
  signedEnvelope,
  utc
} from './pay-ext-fixture'
import { BUYER_CLAIMS, CUSTOMER } from './d1-returns-fixture'
import {
  captureTokenAfterPayment,
  looksLikeCardNumber,
  ONE_CLICK_CONSENT_VERSION,
  payWithSavedToken,
  startTokenizedPayment,
  type TokenizationDependencies
} from '../../workers/payments/tokenization'
import {
  createBoundOneClickProvider,
  tokenizationGate,
  configuredTokenization
} from '../../workers/payments/tokenization-runtime'
import { decodeMerchantParameters } from '../../workers/payments/redsys'
import { processRedsysNotification } from '../../workers/catalog/payments'
import { requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      sqlite.function('synthetic_tokenization_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_tokenization_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_tokenization_clock()'))
      return database
    }
  }
})

let f: Awaited<ReturnType<typeof payExtFixture>>
let provider: ReturnType<typeof fakeOneClickProvider>
const deps = (): TokenizationDependencies => ({
  database: f.database,
  configuration: redsysConfig,
  provider,
  inventory: { assign: f.inventory.assign },
  now: () => utc()
})
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
  f = await payExtFixture()
  provider = fakeOneClickProvider()
})
afterEach(() => {
  f?.sqlite.close()
  vi.useRealTimers()
})

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const consent = (orderId: string, over: Record<string, unknown> = {}) => ({
  orderId,
  commandId: testUuid(),
  consent: true,
  consentVersion: ONE_CLICK_CONSENT_VERSION,
  ...over
})
async function consentedPayment(identifier = TOKEN) {
  const { orderId, token } = await f.unpaid()
  const started = await startTokenizedPayment(BUYER_CLAIMS, token, consent(orderId), deps())
  const intent = f.sqlite
    .prepare('SELECT merchant_order m, amount_gross_cents a FROM payment_intents WHERE id=?')
    .get(started.paymentIntentId) as { m: string; a: number }
  const envelope = await signedEnvelope(intent.m, intent.a, { extra: { Ds_Merchant_Identifier: identifier } })
  return { orderId, token, started, intent, envelope }
}
async function savedToken() {
  const paid = await consentedPayment()
  await processRedsysNotification(
    f.database,
    paid.envelope,
    redsysConfig,
    { correlationId: 't', now: utc() },
    { assign: f.inventory.assign }
  )
  expect(await captureTokenAfterPayment(paid.envelope, deps())).toBe('created')
  const row = f.sqlite.prepare('SELECT id,version FROM payment_saved_tokens').get() as { id: string; version: number }
  return { ...paid, tokenId: row.id, version: row.version }
}
const oneClick = (tokenId: string, version: number, orderId: string, commandId = testUuid()) => ({
  tokenId,
  expectedVersion: version,
  orderId,
  commandId
})

describe('availability gate', () => {
  const ready = {
    DB: {} as D1Database,
    PAYMENT_TOKENIZATION_ENABLED: 'true',
    PAYMENT_TOKENIZATION_BANK_SUPPORT: 'confirmed',
    PAYMENT_TOKENIZATION_PCI_REVIEW: 'reviewed:saq-a-2026-10',
    PAYMENT_TOKEN_REMOVAL_ENABLED: 'true',
    PAYMENT_TOKEN_DELETION: { fetch: async () => new Response() },
    PAYMENT_ONE_CLICK_SERVICE: { fetch: async () => new Response() }
  }
  it('opens only when bank support, PCI review, self-service removal and the service are all present', () => {
    expect(tokenizationGate(ready)).toEqual({ open: true, missing: [] })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['enabled', { PAYMENT_TOKENIZATION_ENABLED: 'false' }],
      ['bank_support', { PAYMENT_TOKENIZATION_BANK_SUPPORT: 'pending' }],
      ['pci_review', { PAYMENT_TOKENIZATION_PCI_REVIEW: 'yes' }],
      ['pci_review', { PAYMENT_TOKENIZATION_PCI_REVIEW: undefined }],
      ['self_service_removal', { PAYMENT_TOKEN_REMOVAL_ENABLED: 'false' }],
      ['self_service_removal', { PAYMENT_TOKEN_DELETION: undefined }],
      ['one_click_service', { PAYMENT_ONE_CLICK_SERVICE: undefined }]
    ]
    for (const [missing, over] of cases) expect(tokenizationGate({ ...ready, ...over }).missing).toContain(missing)
  })
  it('yields no dependencies while closed', () => {
    const inv = { assign: f.inventory.assign }
    expect(
      configuredTokenization({ ...ready, PAYMENT_TOKENIZATION_BANK_SUPPORT: undefined }, redsysConfig, inv, () => utc())
    ).toBeNull()
    expect(configuredTokenization(ready, null, inv, () => utc())).toBeNull()
    expect(configuredTokenization(ready, redsysConfig, inv, () => utc())).not.toBeNull()
  })
  it('validates the one-click service response', async () => {
    const env = await signedEnvelope('1234ABCD', 100)
    const answer = (v: unknown, type = 'application/json') =>
      createBoundOneClickProvider({
        fetch: async () => new Response(JSON.stringify(v), { headers: { 'content-type': type } })
      })
    const input = { idempotencyKey: 'k', merchantOrder: '1234ABCD', amountCents: 100, providerToken: TOKEN }
    expect(await answer(env).charge(input)).toEqual(env)
    await expect(answer({ ...env, extra: 1 }).charge(input)).rejects.toThrow()
    await expect(answer({ ...env, Ds_SignatureVersion: 'X' }).charge(input)).rejects.toThrow()
    await expect(answer(env, 'text/html').charge(input)).rejects.toThrow()
  })
})

describe('explicit consent at payment start', () => {
  it('requires consent:true and the current consent version, and rejects unknown fields', async () => {
    const { orderId, token } = await f.unpaid()
    for (const bad of [
      { consent: false },
      { consent: undefined },
      { consent: 'true' },
      { consentVersion: 'old' },
      { amountCents: 1 },
      { customerId: CUSTOMER }
    ])
      await expect(startTokenizedPayment(BUYER_CLAIMS, token, consent(orderId, bad), deps())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('records the consent for exactly this payment, asks the bank for a token and uses the order amount', async () => {
    const { orderId, started, intent } = await consentedPayment()
    const params = decodeMerchantParameters(started.redirect.fields.Ds_MerchantParameters)
    expect(params.DS_MERCHANT_IDENTIFIER).toBe('REQUIRED')
    expect(params.DS_MERCHANT_AMOUNT).toBe(String(intent.a))
    expect(
      f.sqlite.prepare('SELECT customer_id,order_id,consent_version FROM payment_token_consent_requests').get()
    ).toMatchObject({
      customer_id: CUSTOMER,
      order_id: orderId,
      consent_version: ONE_CLICK_CONSENT_VERSION
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 0 })
  })
  it('is idempotent per command and rejects the command reused for another order', async () => {
    const { orderId, token } = await f.unpaid()
    const input = consent(orderId)
    const first = await startTokenizedPayment(BUYER_CLAIMS, token, input, deps())
    const second = await startTokenizedPayment(BUYER_CLAIMS, token, input, deps())
    expect(second.paymentIntentId).toBe(first.paymentIntentId)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_consent_requests').get()).toMatchObject({ n: 1 })
    const other = await f.unpaid()
    await expect(
      startTokenizedPayment(BUYER_CLAIMS, other.token, { ...input, orderId: other.orderId }, deps())
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('hides other customers orders, requires a session and a valid order credential', async () => {
    const { orderId, token } = await f.unpaid()
    const other = addOtherCustomer(f.sqlite)
    await expect(startTokenizedPayment(other.claims, token, consent(orderId), deps())).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(startTokenizedPayment(null, token, consent(orderId), deps())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    await expect(startTokenizedPayment(BUYER_CLAIMS, 'b'.repeat(64), consent(orderId), deps())).rejects.toMatchObject({
      code: 'not_found'
    })
    f.sqlite.exec('UPDATE auth_sessions SET revoked_at=created_at')
    await expect(startTokenizedPayment(BUYER_CLAIMS, token, consent(orderId), deps())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_consent_requests').get()).toMatchObject({ n: 0 })
  })
})

describe('token capture', () => {
  it('stores only the bank token, with consent version, source payment and a granted audit event', async () => {
    const { tokenId, started } = await savedToken()
    expect(
      f.sqlite
        .prepare(
          'SELECT status,version,consent_version,source_intent_id,customer_id FROM payment_saved_tokens WHERE id=?'
        )
        .get(tokenId)
    ).toMatchObject({
      status: 'active',
      version: 1,
      consent_version: ONE_CLICK_CONSENT_VERSION,
      source_intent_id: started.paymentIntentId,
      customer_id: CUSTOMER
    })
    expect(
      f.sqlite.prepare('SELECT event,customer_id FROM payment_token_consent_events WHERE token_id=?').all(tokenId)
    ).toEqual([{ event: 'granted', customer_id: CUSTOMER }])
  })
  it('is idempotent on notification redelivery', async () => {
    const { envelope } = await savedToken()
    expect(await captureTokenAfterPayment(envelope, deps())).toBe('duplicate')
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_consent_events').get()).toMatchObject({ n: 1 })
  })
  it('never stores a token for a payment without recorded consent', async () => {
    const { orderId, token } = await f.unpaid()
    const { initiateRedsysPayment } = await import('../../workers/catalog/payments')
    await initiateRedsysPayment(
      f.database,
      { orderId, orderToken: token, method: 'card', now: utc(), correlationId: 'c', idempotencyKey: 'k' },
      redsysConfig
    )
    const intent = f.sqlite.prepare('SELECT merchant_order m, amount_gross_cents a FROM payment_intents').get() as {
      m: string
      a: number
    }
    const envelope = await signedEnvelope(intent.m, intent.a, { extra: { Ds_Merchant_Identifier: TOKEN } })
    await processRedsysNotification(
      f.database,
      envelope,
      redsysConfig,
      { correlationId: 't', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(await captureTokenAfterPayment(envelope, deps())).toBe('skipped')
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 0 })
  })
  it('refuses card-number-looking identifiers, forged signatures, wrong amounts and uncaptured payments', async () => {
    const paid = await consentedPayment('4548812049400004')
    await processRedsysNotification(
      f.database,
      paid.envelope,
      redsysConfig,
      { correlationId: 't', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(await captureTokenAfterPayment(paid.envelope, deps())).toBe('skipped')
    expect(looksLikeCardNumber('4548 8120 4940 0004')).toBe(true)
    expect(looksLikeCardNumber(TOKEN)).toBe(false)
    const good = await signedEnvelope(paid.intent.m, paid.intent.a, { extra: { Ds_Merchant_Identifier: TOKEN } })
    expect(await captureTokenAfterPayment({ ...good, Ds_Signature: 'AAAA' }, deps())).toBe('skipped')
    const wrong = await signedEnvelope(paid.intent.m, paid.intent.a - 1, { extra: { Ds_Merchant_Identifier: TOKEN } })
    expect(await captureTokenAfterPayment(wrong, deps())).toBe('skipped')
    const declined = await signedEnvelope(paid.intent.m, paid.intent.a, {
      response: '0190',
      extra: { Ds_Merchant_Identifier: TOKEN }
    })
    expect(await captureTokenAfterPayment(declined, deps())).toBe('skipped')
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get()).toMatchObject({ n: 0 })
  })
  it('does not capture before the payment itself is captured', async () => {
    const paid = await consentedPayment()
    expect(await captureTokenAfterPayment(paid.envelope, deps())).toBe('skipped')
  })
  it('does not duplicate the same bank token for a customer and caps saved tokens', async () => {
    await savedToken()
    const again = await consentedPayment()
    await processRedsysNotification(
      f.database,
      again.envelope,
      redsysConfig,
      { correlationId: 't', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(await captureTokenAfterPayment(again.envelope, deps())).toBe('skipped')
    for (let i = 0; i < 6; i++) {
      const p = await consentedPayment(`${TOKEN.slice(0, 30)}${String(i).padStart(10, 'x')}`)
      await processRedsysNotification(
        f.database,
        p.envelope,
        redsysConfig,
        { correlationId: 't', now: utc() },
        { assign: f.inventory.assign }
      )
      await captureTokenAfterPayment(p.envelope, deps())
    }
    expect((f.sqlite.prepare('SELECT count(*) n FROM payment_saved_tokens').get() as { n: number }).n).toBe(5)
  })
})

describe('one-click payment', () => {
  it('charges the owners token for the server amount and settles through checkout reconciliation', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    const input = oneClick(tokenId, version, next.orderId)
    const paid = await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())
    expect(paid).toMatchObject({ orderId: next.orderId, outcome: 'paid' })
    const order = f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(next.orderId) as {
      t: number
    }
    expect(paid.amountCents).toBe(order.t)
    expect(
      f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(next.orderId)
    ).toMatchObject({ status: 'paid' })
    expect(provider.seenTokens).toEqual([TOKEN])
    expect(JSON.stringify(paid)).not.toContain(TOKEN)
    expect(f.sqlite.prepare('SELECT status FROM payment_one_click_commands').get()).toMatchObject({ status: 'settled' })
  })
  it('replays idempotently without a second charge and rejects a changed payload', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    const input = oneClick(tokenId, version, next.orderId)
    await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())
    expect(await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())).toMatchObject({ outcome: 'paid' })
    expect(provider.calls).toBe(1)
    const other = await f.unpaid()
    await expect(
      payWithSavedToken(BUYER_CLAIMS, other.token, { ...input, orderId: other.orderId }, deps())
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('allows one charge for concurrent identical commands', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    const input = oneClick(tokenId, version, next.orderId)
    const results = await Promise.allSettled([
      payWithSavedToken(BUYER_CLAIMS, next.token, input, deps()),
      payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())
    ])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    expect(provider.answers.size).toBe(1)
    expect(
      f.sqlite
        .prepare("SELECT count(*) n FROM order_events WHERE event_type='payment_captured' AND order_id=?")
        .get(next.orderId)
    ).toMatchObject({ n: 1 })
  })
  it('lets only one of two different commands pay the same order', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    const results = await Promise.allSettled([
      payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version, next.orderId), deps()),
      payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version, next.orderId), deps())
    ])
    expect(
      results.filter((r) => r.status === 'fulfilled' && (r.value as { outcome: string }).outcome === 'paid')
    ).toHaveLength(1)
    expect(provider.answers.size).toBe(1)
  })
  it('rejects another customers token, an unknown token and a stale version without calling the bank', async () => {
    const { tokenId, version } = await savedToken()
    const other = addOtherCustomer(f.sqlite)
    const mine = await f.unpaid()
    await expect(
      payWithSavedToken(other.claims, mine.token, oneClick(tokenId, version, mine.orderId), deps())
    ).rejects.toMatchObject({ code: 'not_found' })
    // The other customer owns this order, but the token is not theirs.
    const theirs = await f.unpaid(other.claims)
    await expect(
      payWithSavedToken(other.claims, theirs.token, oneClick(tokenId, version, theirs.orderId), deps())
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_one_click_commands').get()).toMatchObject({ n: 0 })
    await expect(
      payWithSavedToken(BUYER_CLAIMS, mine.token, oneClick(testUuid(), 1, mine.orderId), deps())
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      payWithSavedToken(BUYER_CLAIMS, mine.token, oneClick(tokenId, version + 1, mine.orderId), deps())
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      payWithSavedToken(null, mine.token, oneClick(tokenId, version, mine.orderId), deps())
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(provider.calls).toBe(0)
  })
  it('rejects client-supplied amounts or identity and orders the customer does not own', async () => {
    const { tokenId, version } = await savedToken()
    const mine = await f.unpaid()
    for (const extra of [{ amountCents: 1 }, { customerId: CUSTOMER }, { providerToken: TOKEN }])
      await expect(
        payWithSavedToken(BUYER_CLAIMS, mine.token, { ...oneClick(tokenId, version, mine.orderId), ...extra }, deps())
      ).rejects.toMatchObject({ code: 'invalid_input' })
    f.sqlite.exec('UPDATE orders SET customer_id=NULL WHERE customer_id IS NOT NULL AND 0')
    const guest = addOtherCustomer(f.sqlite)
    await expect(
      payWithSavedToken(guest.claims, mine.token, oneClick(tokenId, version, mine.orderId), deps())
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(provider.calls).toBe(0)
  })
  it('reports a bank refusal as declined, keeps the order payable and never retries the same command', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    provider.response = '0190'
    const input = oneClick(tokenId, version, next.orderId)
    expect(await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())).toMatchObject({ outcome: 'declined' })
    expect(
      f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(next.orderId)
    ).not.toMatchObject({ status: 'paid' })
    expect(await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())).toMatchObject({ outcome: 'declined' })
    expect(provider.calls).toBe(1)
  })
  it('stays resumable when the service is unavailable and then charges once with the same key', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    const input = oneClick(tokenId, version, next.orderId)
    provider.failNext = 1
    await expect(payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(f.sqlite.prepare('SELECT status FROM payment_one_click_commands').get()).toMatchObject({ status: 'started' })
    expect(await payWithSavedToken(BUYER_CLAIMS, next.token, input, deps())).toMatchObject({ outcome: 'paid' })
    expect(provider.answers.size).toBe(1)
  })
  it('refuses an answer for a different merchant order', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    provider.wrongOrder = true
    await expect(
      payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version, next.orderId), deps())
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(
      f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(next.orderId)
    ).not.toMatchObject({ status: 'paid' })
  })
  it('cannot pay an already paid or expired order', async () => {
    const { tokenId, version, orderId, token } = await savedToken()
    await expect(
      payWithSavedToken(BUYER_CLAIMS, token, oneClick(tokenId, version, orderId), deps())
    ).rejects.toMatchObject({ code: 'not_payable' })
    expect(provider.calls).toBe(0)
  })
})

describe('revocation', () => {
  it('withdraws consent atomically with the removal request, audits it and blocks one-click', async () => {
    const { tokenId, version } = await savedToken()
    await requestPaymentTokenRemoval(
      f.database,
      BUYER_CLAIMS,
      { tokenId, commandId: testUuid(), expectedVersion: version },
      { now: () => utc() }
    )
    expect(
      f.sqlite
        .prepare('SELECT event FROM payment_token_consent_events WHERE token_id=? ORDER BY event')
        .all(tokenId)
        .map((r) => r.event)
    ).toEqual(['granted', 'revoked'])
    const next = await f.unpaid()
    await expect(
      payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version + 1, next.orderId), deps())
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(provider.calls).toBe(0)
  })
  it('cannot record a second consent event of the same kind for a token', async () => {
    const { tokenId } = await savedToken()
    expect(() =>
      f.sqlite
        .prepare(
          "INSERT INTO payment_token_consent_events(token_id,event,customer_id,consent_version,created_at) VALUES(?,'granted',?,'v',?)"
        )
        .run(tokenId, CUSTOMER, utc())
    ).toThrow()
  })
})

describe('data protection invariants', () => {
  it('keeps consent evidence append-only and one-click transitions forward-only', async () => {
    const { tokenId, version } = await savedToken()
    expect(() => f.sqlite.exec("UPDATE payment_token_consent_events SET event='revoked'")).toThrow(/append_only/)
    expect(() => f.sqlite.exec('DELETE FROM payment_token_consent_events')).toThrow(/append_only/)
    expect(() => f.sqlite.exec('DELETE FROM payment_token_consent_requests')).toThrow(/append_only/)
    const next = await f.unpaid()
    await payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version, next.orderId), deps())
    expect(() => f.sqlite.exec("UPDATE payment_one_click_commands SET status='started'")).toThrow(
      /invalid_one_click_transition/
    )
    expect(() => f.sqlite.exec('DELETE FROM payment_one_click_commands')).toThrow(/append_only/)
  })
  it('contains no card-number-shaped value in any payment extension table', async () => {
    const { tokenId, version } = await savedToken()
    const next = await f.unpaid()
    await payWithSavedToken(BUYER_CLAIMS, next.token, oneClick(tokenId, version, next.orderId), deps())
    for (const table of [
      'payment_saved_tokens',
      'payment_token_consent_requests',
      'payment_token_consent_events',
      'payment_one_click_commands',
      'payment_events',
      'order_events'
    ])
      expect(JSON.stringify(f.sqlite.prepare(`SELECT * FROM ${table}`).all())).not.toMatch(/\b\d{13,19}\b/)
  })
})
