import { readFile } from 'node:fs/promises'
import { assignReservation, releaseReservation, renewReservation } from '../../workers/catalog/inventory'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { BUYER_CLAIMS, returnsFixture, utc } from './d1-returns-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'

export const ORIGIN = 'https://returns-fixture.neteco.test'
export const redsysConfig = {
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  merchantName: 'NETECO',
  bizumEnabled: false,
  publicBaseUrl: ORIGIN
}

/** Fixture with migration 0126 applied and helpers for unpaid orders owned by the synthetic buyer. */
export async function payExtFixture() {
  const f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  f.sqlite.exec('PRAGMA foreign_keys=ON')
  async function unpaid(owner: typeof BUYER_CLAIMS | null = BUYER_CLAIMS): Promise<{ orderId: string; token: string }> {
    const cart = await createCart(f.database, { correlationId: 'pay-ext', now: utc() })
    const common = { cartId: cart.cartId, token: cart.token, correlationId: 'pay-ext' }
    await setCartLine(f.database, {
      ...common,
      variantId: 'v-1-1',
      quantity: 2,
      expectedVersion: 1,
      idempotencyKey: 'add',
      now: utc()
    })
    const shipping = await requestShippingOptions(f.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      destination: { city: 'Ontinyent', postalCode: '46870' },
      now: utc()
    })
    const quote = await quoteCart(f.database, { ...common, expectedVersion: 2, idempotencyKey: 'quote', now: utc() })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('pay_ext_quote_failed')
    const option = (
      shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    ).find((item) => item.methodCode === 'pickup')!
    const placed = await placeOrder(f.database, {
      ...common,
      expectedVersion: 2,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId as string,
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'buyer@example.invalid',
      contactName: 'Original buyer',
      contactPhone: '+34600111222',
      shippingAddress: {
        recipientName: 'Original buyer',
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '+34600111222'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'checkout',
      now: utc(),
      ownerSession: owner
    })
    if (placed.outcome !== 'order_created') throw new Error('pay_ext_checkout_failed')
    const body = placed.body as { id: string; orderToken: string }
    return { orderId: body.id, token: body.orderToken }
  }
  const inventory = {
    assign: (input: Parameters<typeof assignReservation>[1]) => assignReservation(f.database, input),
    renew: (input: Parameters<typeof renewReservation>[1]) => renewReservation(f.database, input),
    release: (input: Parameters<typeof releaseReservation>[1]) => releaseReservation(f.database, input)
  }
  return { ...f, unpaid, inventory }
}

export async function signedEnvelope(
  merchantOrder: string,
  amountCents: number,
  options: { type?: string; response?: string; extra?: Record<string, string> } = {}
) {
  const parameters = encodeMerchantParameters({
    Ds_Order: merchantOrder,
    Ds_Amount: String(amountCents),
    Ds_Currency: '978',
    Ds_MerchantCode: redsysConfig.merchantCode,
    Ds_Terminal: redsysConfig.terminal,
    Ds_TransactionType: options.type ?? '0',
    Ds_Response: options.response ?? '0000',
    ...(options.extra ?? {})
  })
  return {
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, redsysConfig.secretKey)
  }
}
export { utc }

/** Deterministic local provider: idempotent per key, counts real side effects, never touches the network. */
export function fakePreauthProvider() {
  const state = {
    captures: new Map<string, { outcome: 'captured' | 'rejected'; providerReference?: string }>(),
    cancels: new Map<string, { outcome: 'cancelled' | 'rejected' }>(),
    captureCalls: 0,
    cancelCalls: 0,
    failNextCapture: 0,
    failNextCancel: 0,
    rejectCapture: false,
    rejectCancel: false,
    onCapture: undefined as undefined | (() => Promise<void> | void)
  }
  return Object.assign(state, {
    async capture(input: { idempotencyKey: string; amountCents: number }) {
      state.captureCalls += 1
      await state.onCapture?.()
      if (state.failNextCapture > 0) {
        state.failNextCapture -= 1
        throw new Error('provider unavailable')
      }
      const previous = state.captures.get(input.idempotencyKey)
      if (previous) return previous
      const result = state.rejectCapture
        ? ({ outcome: 'rejected' } as const)
        : ({ outcome: 'captured', providerReference: `cap:${input.idempotencyKey}`.slice(0, 100) } as const)
      state.captures.set(input.idempotencyKey, result)
      return result
    },
    async cancel(input: { idempotencyKey: string }) {
      state.cancelCalls += 1
      if (state.failNextCancel > 0) {
        state.failNextCancel -= 1
        throw new Error('provider unavailable')
      }
      const previous = state.cancels.get(input.idempotencyKey)
      if (previous) return previous
      const result = state.rejectCancel ? ({ outcome: 'rejected' } as const) : ({ outcome: 'cancelled' } as const)
      state.cancels.set(input.idempotencyKey, result)
      return result
    }
  })
}

/** Deterministic one-click acquirer: signs an ordinary Redsys answer; idempotent per key; no network. */
export function fakeOneClickProvider() {
  const state = {
    calls: 0,
    answers: new Map<string, Awaited<ReturnType<typeof signedEnvelope>>>(),
    response: '0000',
    failNext: 0,
    wrongOrder: false,
    seenTokens: [] as string[]
  }
  return Object.assign(state, {
    async charge(input: { idempotencyKey: string; merchantOrder: string; amountCents: number; providerToken: string }) {
      state.calls += 1
      state.seenTokens.push(input.providerToken)
      if (state.failNext > 0) {
        state.failNext -= 1
        throw new Error('provider unavailable')
      }
      const previous = state.answers.get(input.idempotencyKey)
      if (previous) return previous
      const answer = await signedEnvelope(state.wrongOrder ? '9999ZZZZ' : input.merchantOrder, input.amountCents, {
        response: state.response
      })
      state.answers.set(input.idempotencyKey, answer)
      return answer
    }
  })
}

/** Creates a second, unrelated active customer with a verified session. */
export function addOtherCustomer(sqlite: { exec(sql: string): void }) {
  const claims = {
    identityId: '10000000-0000-4000-8000-0000000000b2',
    sessionId: '20000000-0000-4000-8000-0000000000b2',
    sessionVersion: 1
  }
  const customer = '30000000-0000-4000-8000-0000000000b2'
  const past = utc(-60000)
  sqlite.exec(`
    INSERT INTO customers(id,name,created_at,updated_at) VALUES('${customer}','Other customer','${past}','${past}');
    INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at)
      VALUES('${claims.identityId}','other@example.invalid','synthetic','${past}','active','${customer}','${past}','${past}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${claims.sessionId}','${claims.identityId}',1,0,'${past}','${utc(3_600_000)}');`)
  return { claims, customer }
}
