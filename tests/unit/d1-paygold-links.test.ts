import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUYER_CLAIMS, CUSTOMER, CLAIMS, returnsFixture, utc } from './d1-returns-fixture'
import { issuePayGoldLink, recoverPayGoldAttempt } from '../../workers/payments/paygold-links'
import { deriveOrderToken } from '../../workers/catalog/checkout'
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, amount: number, expiresAt: string
const quoteId = '68000000-0000-4000-8000-000000000001',
  intentId = '68000000-0000-4000-8000-000000000002',
  key = '68000000-0000-4000-8000-000000000003'
let token: string
const quote = () => ({
  id: quoteId,
  version: 2,
  status: 'converted' as const,
  orderId,
  total: { grossCents: amount },
  validUntil: utc(600000)
})
let start: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>, verify: ReturnType<typeof vi.fn>
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0089_sales_quotes.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  let cartToken = ''
  const original = crypto.getRandomValues.bind(crypto)
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((buffer) => {
    const result = original(buffer)
    if (buffer instanceof Uint8Array && buffer.length === 32 && !cartToken)
      cartToken = Buffer.from(buffer).toString('base64url')
    return result
  })
  try {
    orderId = await f.order({ owned: true, paid: false, delivered: false })
  } finally {
    random.mockRestore()
  }
  if (!cartToken) throw new Error('cart token not captured')
  token = await deriveOrderToken(cartToken, orderId)
  expiresAt = utc(240000)
  const row = f.sqlite.prepare('SELECT total_gross_cents amount FROM orders WHERE id=?').get(orderId) as {
    amount: number
  }
  amount = row.amount
  const now = utc(),
    approvedHash = 'c'.repeat(64),
    snapshot = JSON.stringify({
      id: quoteId,
      version: 2,
      status: 'converted',
      updatedAt: now,
      orderId,
      approvedHash,
      total: { grossCents: amount },
      definition: { validUntil: utc(600000) }
    })
  f.sqlite
    .prepare(
      'INSERT INTO sales_quotes(id,customer_id,current_version,created_by,created_at,updated_at) VALUES(?,?,2,?,?,?)'
    )
    .run(quoteId, CUSTOMER, CLAIMS.identityId, now, now)
  f.sqlite
    .prepare(
      "INSERT INTO sales_quote_versions(quote_id,version,status,snapshot_json,snapshot_hash,actor_id,created_at) VALUES(?,1,'approved',?,?,?,?)"
    )
    .run(
      quoteId,
      JSON.stringify({
        id: quoteId,
        version: 1,
        status: 'approved',
        updatedAt: now,
        approvedHash,
        total: { grossCents: amount }
      }),
      'a'.repeat(64),
      CLAIMS.identityId,
      now
    )
  f.sqlite
    .prepare(
      "INSERT INTO sales_quote_versions(quote_id,version,status,snapshot_json,snapshot_hash,actor_id,created_at) VALUES(?,2,'converted',?,?,?,?)"
    )
    .run(quoteId, snapshot, 'a'.repeat(64), CLAIMS.identityId, now)
  const binding = f.sqlite
    .prepare(
      'SELECT o.cart_id cartId,o.quote_id checkoutQuoteId,a.command_key checkoutKey FROM orders o JOIN checkout_attempts a ON a.id=o.attempt_id WHERE o.id=?'
    )
    .get(orderId) as { cartId: string; checkoutQuoteId: string; checkoutKey: string }
  f.sqlite
    .prepare(
      'INSERT INTO sales_quote_conversions(quote_id,quote_version,approved_hash,customer_id,cart_id,checkout_quote_id,checkout_key,actor_id,session_id,session_version,command_id,payload_hash,input_json,created_at) VALUES(?,1,?,?,?,?,?,?,?,1,?,?,?,?)'
    )
    .run(
      quoteId,
      approvedHash,
      CUSTOMER,
      binding.cartId,
      binding.checkoutQuoteId,
      binding.checkoutKey,
      BUYER_CLAIMS.identityId,
      BUYER_CLAIMS.sessionId,
      key,
      'd'.repeat(64),
      '{}',
      now
    )
  start = vi.fn(async () => {
    const old = f.sqlite.prepare('SELECT id FROM payment_intents WHERE id=?').get(intentId)
    if (!old) {
      const order = f.sqlite.prepare('SELECT reservation_expires_at expires FROM orders WHERE id=?').get(orderId) as {
        expires: string
      }
      f.sqlite
        .prepare(
          `INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,redirect_envelope_hash,expires_at,correlation_id,created_at,updated_at) VALUES(?,?,'redsys','1234ABCD','card','redirect_ready',?,'EUR',?,?,?,'synthetic',?,?)`
        )
        .run(intentId, orderId, amount, 'a'.repeat(64), 'b'.repeat(64), order.expires, utc(), utc())
    }
    return {
      paymentIntentId: intentId,
      redirect: {
        actionUrl: 'https://sis-t.redsys.es:25443/sis/realizarPago',
        method: 'POST',
        fields: { Ds_MerchantParameters: 'synthetic', Ds_Signature: 'synthetic', Ds_SignatureVersion: 'HMAC_SHA512_V2' }
      }
    }
  })
  create = vi.fn(async (_input: { idempotencyKey: string }) => ({
    url: 'https://paygold.example.invalid/synthetic-link',
    expiresAt
  }))
  verify = vi.fn(async () => true)
})
afterEach(() => f?.sqlite.close())
const deps = () => ({
  database: f.database,
  readQuote: async () => quote(),
  start,
  verify,
  provider: { create },
  providerOrigin: 'https://paygold.example.invalid',
  now: () => utc()
})
const input = () => ({ quoteId, expectedVersion: 2, orderId, orderToken: token, commandId: key, expiresAt })
it('issues an expiring link for the exact quote, order, amount and existing checkout intent', async () => {
  const result = await issuePayGoldLink(BUYER_CLAIMS, input(), deps())
  expect(result).toMatchObject({
    quoteId,
    orderId,
    paymentIntentId: intentId,
    amountCents: amount,
    url: 'https://paygold.example.invalid/synthetic-link'
  })
  expect(create).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM paygold_commands').get())).not.toContain(token)
})
it('replays without issuing a second link, while rechecking order access', async () => {
  const first = await issuePayGoldLink(BUYER_CLAIMS, input(), deps())
  expect(await issuePayGoldLink(BUYER_CLAIMS, input(), deps())).toEqual(first)
  expect(create).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledTimes(2)
})
it.each([
  { expectedVersion: 1 },
  { expiresAt: utc(-1000) },
  { expiresAt: utc(900000) },
  { quoteId: 'bad' },
  { orderToken: 'bad' },
  { extra: true }
])('rejects malformed or stale input %#', async (change) => {
  await expect(issuePayGoldLink(BUYER_CLAIMS, { ...input(), ...change }, deps())).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
})
it('rejects another customer or invalid session', async () => {
  await expect(issuePayGoldLink(CLAIMS, input(), deps())).rejects.toThrow()
  expect(create).not.toHaveBeenCalled()
})
it('rejects a changed amount or order after the provider responds', async () => {
  create.mockImplementationOnce(async () => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    return { url: 'https://paygold.example.invalid/synthetic-link', expiresAt }
  })
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_commands').get()).toMatchObject({ n: 0 })
})
it.each([
  'http://paygold.example.invalid/x',
  'https://foreign.invalid/x',
  'https://paygold.example.invalid/x#fragment'
])('rejects unsafe provider URL %s', async (url) => {
  create.mockResolvedValueOnce({ url, expiresAt })
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_commands').get()).toMatchObject({ n: 0 })
})
it('rejects reuse of the command with a different payload', async () => {
  await issuePayGoldLink(BUYER_CLAIMS, input(), deps())
  await expect(issuePayGoldLink(BUYER_CLAIMS, { ...input(), expiresAt: utc(120000) }, deps())).rejects.toThrow()
  expect(create).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledTimes(1)
})
it('never exposes a command conflict before checking the order credential', async () => {
  await issuePayGoldLink(BUYER_CLAIMS, input(), deps())
  verify.mockResolvedValueOnce(false)
  await expect(issuePayGoldLink(BUYER_CLAIMS, { ...input(), expiresAt: utc(120000) }, deps())).rejects.toMatchObject({
    code: 'unauthorized'
  })
})
it('returns one durable receipt for concurrent identical commands', async () => {
  const results = await Promise.all([
    issuePayGoldLink(BUYER_CLAIMS, input(), deps()),
    issuePayGoldLink(BUYER_CLAIMS, input(), deps())
  ])
  expect(results[0]).toEqual(results[1])
  expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_commands').get()).toMatchObject({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_audit').get()).toMatchObject({ n: 1 })
  expect(create.mock.calls.every((call) => call[0].idempotencyKey === `paygold:${key}`)).toBe(true)
})
it('refuses a link when the provider does not attest the exact requested expiration', async () => {
  create.mockResolvedValueOnce({ url: 'https://paygold.example.invalid/synthetic-link', expiresAt: utc(900000) })
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_commands').get()).toMatchObject({ n: 0 })
})
it('checks durable order and quote facts before starting any payment', async () => {
  f.sqlite.exec('DROP TRIGGER sales_quote_version_no_update')
  f.sqlite
    .prepare(
      "UPDATE sales_quote_versions SET snapshot_json=json_set(snapshot_json,'$.total.grossCents',?) WHERE quote_id=?"
    )
    .run(amount + 1, quoteId)
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toMatchObject({ code: 'not_payable' })
  expect(start).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})
it('does not start a charge without immutable approved quote conversion bound to the order', async () => {
  f.sqlite.exec('DROP TRIGGER sales_quote_conversion_no_delete; DELETE FROM sales_quote_conversions')
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toMatchObject({ code: 'not_payable' })
  expect(start).not.toHaveBeenCalled()
})
it('recovers the same durable command after an uncertain provider response', async () => {
  create.mockRejectedValueOnce(new Error('uncertain'))
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  const recovered = await recoverPayGoldAttempt(BUYER_CLAIMS, { quoteId, orderId, orderToken: token }, deps())
  expect(recovered).toEqual({ quoteId, orderId, expectedVersion: 2, commandId: key, expiresAt })
  await expect(issuePayGoldLink(BUYER_CLAIMS, { ...recovered, orderToken: token }, deps())).resolves.toMatchObject({
    quoteId,
    orderId,
    amountCents: amount
  })
  expect(create.mock.calls.every((call) => call[0].idempotencyKey === `paygold:${key}`)).toBe(true)
})
it('requires live ownership and order credentials before recovering a pending command', async () => {
  create.mockRejectedValueOnce(new Error('uncertain'))
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  verify.mockResolvedValueOnce(false)
  await expect(recoverPayGoldAttempt(BUYER_CLAIMS, { quoteId, orderId, orderToken: token }, deps())).rejects.toThrow()
  await expect(recoverPayGoldAttempt(CLAIMS, { quoteId, orderId, orderToken: token }, deps())).rejects.toThrow()
})
it('does not start a second command for an order with an uncertain link', async () => {
  create.mockRejectedValueOnce(new Error('uncertain'))
  await expect(issuePayGoldLink(BUYER_CLAIMS, input(), deps())).rejects.toThrow()
  await expect(
    issuePayGoldLink(BUYER_CLAIMS, { ...input(), commandId: '68000000-0000-4000-8000-000000000099' }, deps())
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(start).toHaveBeenCalledTimes(1)
})
