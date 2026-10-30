import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORIGIN, payExtFixture, redsysConfig, signedEnvelope, utc } from './pay-ext-fixture'
import { handleWalletHttp, walletEvidenceFromEnv } from '../../workers/payments/wallet-http'
import { decodeMerchantParameters } from '../../workers/payments/redsys'
import { processRedsysNotification } from '../../workers/catalog/payments'

let f: Awaited<ReturnType<typeof payExtFixture>>
beforeEach(async () => {
  f = await payExtFixture()
})
afterEach(() => f?.sqlite.close())

const evidence = (method: string, over: Record<string, unknown> = {}) => ({
  method,
  approved: true,
  bankSupported: true,
  domainVerified: true,
  terminalEnabled: true,
  origin: ORIGIN,
  terminal: '001',
  environment: 'sandbox',
  validUntil: utc(3_600_000),
  ...over
})
const deps = (over: Record<string, unknown> = {}) => ({
  database: f.database,
  configuration: () => redsysConfig,
  evidence: () => [evidence('apple_pay'), evidence('google_pay', { payMethod: 'xpay' })],
  appleDomainAssociation: () => 'apple-domain-proof',
  now: () => utc(),
  ...over
})
const start = (
  orderId: string,
  token: string,
  body: unknown,
  key = 'wallet-key-1',
  headers: Record<string, string> = {}
) =>
  new Request(`${ORIGIN}/api/orders/${orderId}/wallet-payment-intents`, {
    method: 'POST',
    headers: {
      authorization: `Order ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      ...headers
    },
    body: JSON.stringify(body)
  })

describe('PAY-019 capability discovery', () => {
  it('publishes only approved wallets and never exposes evidence', async () => {
    const res = (await handleWalletHttp(new Request(`${ORIGIN}/api/payments/wallet-capabilities`), deps()))!
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const body = await res.json()
    expect(body).toEqual({ wallets: { apple_pay: true, google_pay: true }, fallback: 'redirect' })
  })
  it('is closed without evidence, with expired evidence, or without payment configuration', async () => {
    for (const d of [
      deps({ evidence: () => [] }),
      deps({ evidence: () => [evidence('apple_pay', { validUntil: utc(-1000) })] }),
      deps({ configuration: () => null }),
      deps({ evidence: () => [evidence('apple_pay', { origin: 'https://evil.example' })] })
    ]) {
      const body = await (await handleWalletHttp(new Request(`${ORIGIN}/api/payments/wallet-capabilities`), d))!.json()
      expect(body.wallets).toEqual({ apple_pay: false, google_pay: false })
    }
  })
  it('serves the Apple domain verification file only when configured', async () => {
    const path = `${ORIGIN}/.well-known/apple-developer-merchantid-domain-association`
    const ok = (await handleWalletHttp(new Request(path), deps()))!
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('apple-domain-proof')
    expect((await handleWalletHttp(new Request(path), deps({ appleDomainAssociation: () => null })))!.status).toBe(404)
  })
  it('ignores unrelated routes and rejects unsafe methods', async () => {
    expect(await handleWalletHttp(new Request(`${ORIGIN}/api/other`), deps())).toBeNull()
    const res = (await handleWalletHttp(
      new Request(`${ORIGIN}/api/payments/wallet-capabilities`, { method: 'POST' }),
      deps()
    ))!
    expect(res.status).toBe(405)
  })
  it('parses evidence from the trusted environment only', () => {
    expect(walletEvidenceFromEnv({ WALLET_PAYMENTS_ENABLED: 'false', WALLET_EVIDENCE_JSON: '[{}]' })).toEqual([])
    expect(walletEvidenceFromEnv({ WALLET_PAYMENTS_ENABLED: 'true', WALLET_EVIDENCE_JSON: '{bad' })).toEqual([])
    expect(walletEvidenceFromEnv({ WALLET_PAYMENTS_ENABLED: 'true', WALLET_EVIDENCE_JSON: '[1,2,3,4,5]' })).toEqual([])
    expect(walletEvidenceFromEnv({ WALLET_PAYMENTS_ENABLED: 'true', WALLET_EVIDENCE_JSON: '[{"a":1}]' })).toEqual([
      { a: 1 }
    ])
  })
})

describe('PAY-019 wallet payment start', () => {
  it('starts an ordinary Redsys intent for the server amount and records the resolved wallet', async () => {
    const { orderId, token } = await f.unpaid()
    const res = (await handleWalletHttp(
      start(orderId, token, { method: 'google_pay', deviceAvailable: true }),
      deps()
    ))!
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.wallet).toEqual({ requested: 'google_pay', resolved: 'google_pay', fallback: 'redirect' })
    const params = decodeMerchantParameters(body.redirect.fields.Ds_MerchantParameters)
    expect(params.DS_MERCHANT_PAYMETHODS).toBe('xpay')
    expect(params.DS_MERCHANT_TRANSACTIONTYPE).toBe('0')
    const intent = f.sqlite.prepare('SELECT * FROM payment_intents WHERE order_id=?').get(orderId) as Record<
      string,
      unknown
    >
    const order = f.sqlite.prepare('SELECT total_gross_cents FROM orders WHERE id=?').get(orderId) as Record<
      string,
      unknown
    >
    expect(params.DS_MERCHANT_AMOUNT).toBe(String(order.total_gross_cents))
    expect(intent.method).toBe('card')
    expect(f.sqlite.prepare('SELECT resolved_method FROM payment_wallet_selections').get()).toMatchObject({
      resolved_method: 'google_pay'
    })
  })
  it('reconciles through the unchanged checkout notification path', async () => {
    const { orderId, token } = await f.unpaid()
    await handleWalletHttp(start(orderId, token, { method: 'google_pay', deviceAvailable: true }), deps())
    const intent = f.sqlite.prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents').get() as {
      merchant_order: string
      amount_gross_cents: number
    }
    const result = await processRedsysNotification(
      f.database,
      await signedEnvelope(intent.merchant_order, intent.amount_gross_cents),
      redsysConfig,
      { correlationId: 'wallet-test', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(result.outcome).toBe('captured')
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(orderId)).toMatchObject({
      status: 'paid'
    })
  })
  it('falls back to plain Redirect when the device cannot use the wallet or evidence is missing', async () => {
    const { orderId, token } = await f.unpaid()
    const res = (await handleWalletHttp(
      start(orderId, token, { method: 'apple_pay', deviceAvailable: false }),
      deps()
    ))!
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.wallet).toEqual({ requested: 'apple_pay', resolved: 'redirect', fallback: 'redirect' })
    expect(f.sqlite.prepare('SELECT resolved_method FROM payment_wallet_selections').get()).toMatchObject({
      resolved_method: 'redirect'
    })
  })
  it('never adds a pay-method hint for a wallet whose approval carries none', async () => {
    const { orderId, token } = await f.unpaid()
    const body = await (await handleWalletHttp(
      start(orderId, token, { method: 'apple_pay', deviceAvailable: true }),
      deps()
    ))!.json()
    expect(body.wallet.resolved).toBe('apple_pay')
    expect(decodeMerchantParameters(body.redirect.fields.Ds_MerchantParameters).DS_MERCHANT_PAYMETHODS).toBeUndefined()
  })
  it('replays the same idempotency key without creating a second intent or selection', async () => {
    const { orderId, token } = await f.unpaid()
    const req = () => start(orderId, token, { method: 'google_pay', deviceAvailable: true })
    const first = await (await handleWalletHttp(req(), deps()))!.json()
    const second = await (await handleWalletHttp(req(), deps()))!.json()
    expect(second.paymentIntentId).toBe(first.paymentIntentId)
    expect(second.redirect).toEqual(first.redirect)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_wallet_selections').get()).toMatchObject({ n: 1 })
  })
  it('rejects a missing or wrong order token and mismatched order', async () => {
    const { orderId } = await f.unpaid()
    const res = (await handleWalletHttp(
      start(orderId, 'b'.repeat(64), { method: 'apple_pay', deviceAvailable: true }),
      deps()
    ))!
    expect(res.status).toBe(401)
    const none = (await handleWalletHttp(
      new Request(`${ORIGIN}/api/orders/${orderId}/wallet-payment-intents`, { method: 'POST', body: '{}' }),
      deps()
    ))!
    expect(none.status).toBe(401)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('rejects amount, identity or unknown fields supplied by the client', async () => {
    const { orderId, token } = await f.unpaid()
    for (const extra of [{ amountCents: 1 }, { customerId: 'x' }, { orderId }, { origin: 'https://evil.example' }]) {
      const res = (await handleWalletHttp(
        start(orderId, token, { method: 'apple_pay', deviceAvailable: true, ...extra }),
        deps()
      ))!
      expect(res.status).toBe(400)
    }
    for (const body of [{ method: 'card', deviceAvailable: true }, { method: 'apple_pay' }, 'x', null]) {
      expect((await handleWalletHttp(start(orderId, token, body), deps()))!.status).toBe(400)
    }
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('requires a JSON content type and an idempotency key', async () => {
    const { orderId, token } = await f.unpaid()
    const wrongType = start(orderId, token, { method: 'apple_pay', deviceAvailable: true }, 'k', {
      'content-type': 'text/plain'
    })
    expect((await handleWalletHttp(wrongType, deps()))!.status).toBe(400)
    const noKey = start(orderId, token, { method: 'apple_pay', deviceAvailable: true }, '')
    expect((await handleWalletHttp(noKey, deps()))!.status).toBe(400)
  })
  it('is unavailable when payments are not configured', async () => {
    const { orderId, token } = await f.unpaid()
    const res = (await handleWalletHttp(
      start(orderId, token, { method: 'apple_pay', deviceAvailable: true }),
      deps({ configuration: () => null })
    ))!
    expect(res.status).toBe(503)
  })
  it('does not start when a pre-authorisation owns the order', async () => {
    const { orderId, token } = await f.unpaid()
    f.sqlite.exec(
      `INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) SELECT '40000000-0000-4000-8000-0000000000aa','x@example.invalid','x','active',created_at,created_at FROM orders WHERE id='${orderId}'`
    )
    f.sqlite
      .prepare(
        `INSERT INTO payment_preauths(id,order_id,merchant_order,amount_cents,reason_code,justification,requested_by,status,version,redirect_expires_at,created_at,updated_at)
         VALUES('p1',?,'1111ABCDEFGH',100,'made_to_order','Made to order item needs confirmation','40000000-0000-4000-8000-0000000000aa','requested',1,?,?,?)`
      )
      .run(orderId, utc(60000), utc(), utc())
    const res = (await handleWalletHttp(start(orderId, token, { method: 'apple_pay', deviceAvailable: true }), deps()))!
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
})
