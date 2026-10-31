import { describe, expect, it } from 'vitest'
import { placeOrder } from '../../workers/catalog/checkout'
import { initiateRedsysPayment } from '../../workers/catalog/payments'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { decodeMerchantParameters } from '../../workers/payments/redsys'
import { handlePricingHttp } from '../../workers/pricing/pricing-http'
import {
  redeemStoreCredit,
  reconcileStoreCredit,
  freezeStoreCredit,
  voidStoreCreditGrant
} from '../../workers/pricing/store-credit'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import {
  BUYER_CLAIMS,
  CLAIMS,
  CUSTOMER,
  MADRID,
  grantCredit,
  insertAutoRule,
  insertFreeShippingRule,
  order,
  prepare,
  utc,
  wireFixture,
  type WireFixture
} from './d1-checkout-wire-fixture'

const credit = (storeCreditCents: number) => ({ storeCreditCents }) as never
const redsys = {
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  merchantName: 'NETECO',
  bizumEnabled: false,
  publicBaseUrl: 'https://wire.neteco.test'
}
const count = (f: WireFixture, sql: string) => (f.sqlite.prepare(sql).get() as { n: number }).n
const balance = (f: WireFixture) =>
  (
    f.sqlite.prepare('SELECT balance_cents FROM store_credit_accounts WHERE customer_id = ?').get(CUSTOMER) as {
      balance_cents: number
    }
  ).balance_cents
const reconciled = async (f: WireFixture) =>
  (await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent

async function created(f: WireFixture, cents: number, tag?: string) {
  const p = await prepare(f, tag ? { tag } : {})
  const result = await order(f, p, 'pickup', credit(cents))
  if (result.outcome !== 'order_created') throw new Error(`${result.outcome} ${JSON.stringify(result)}`)
  return { p, result, id: String(result.body.id), token: String(result.body.orderToken) }
}

describe('PRI-018 store credit redeemed atomically at order placement', () => {
  it('spends FIFO by expiry inside the order transaction and keeps the order total contractual', async () => {
    const f = await wireFixture()
    try {
      const late = await grantCredit(f, 500, 90)
      const early = await grantCredit(f, 300, 40)
      const { result, id } = await created(f, 400)
      expect(result.body).toMatchObject({ totalGrossCents: 1000, storeCreditCents: 400, amountDueCents: 600 })
      const ledger = f.sqlite
        .prepare(
          "SELECT grant_id, amount_cents, order_ref FROM store_credit_ledger WHERE entry_type = 'redeem' ORDER BY id"
        )
        .all()
      expect(ledger).toEqual([
        { grant_id: early, amount_cents: -300, order_ref: id },
        { grant_id: late, amount_cents: -100, order_ref: id }
      ])
      expect(balance(f)).toBe(400)
      expect(await reconciled(f)).toBe(true)
      expect(
        f.sqlite.prepare("SELECT actor_id, domain, action FROM pricing_commands WHERE action = 'redeem'").get()
      ).toEqual({ actor_id: BUYER_CLAIMS.identityId, domain: 'store_credit', action: 'redeem' })
      expect(
        count(
          f,
          "SELECT count(*) n FROM pricing_audit WHERE domain = 'store_credit' AND action = 'redeem' AND outcome = 'applied'"
        )
      ).toBe(1)
      const snapshot = JSON.parse(
        (f.sqlite.prepare('SELECT snapshot_json FROM order_pricing_snapshots').get() as { snapshot_json: string })
          .snapshot_json
      )
      expect(snapshot.storeCredit).toMatchObject({
        totalCents: 400,
        allocations: [
          { grantId: early, cents: 300 },
          { grantId: late, cents: 100 }
        ]
      })
      expect(snapshot.totals).toMatchObject({ orderTotalGrossCents: 1000, storeCreditCents: 400, amountDueCents: 600 })
    } finally {
      f.sqlite.close()
    }
  })

  it('charges only the amount due when the payment is initiated', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const { id, token } = await created(f, 400)
      await initiateRedsysPayment(
        f.database,
        {
          orderId: id,
          orderToken: token,
          method: 'card',
          now: utc(),
          correlationId: 'wire-pay',
          idempotencyKey: 'pay-wire'
        },
        redsys
      )
      const intent = f.sqlite.prepare('SELECT amount_gross_cents FROM payment_intents WHERE order_id = ?').get(id)
      expect(intent).toEqual({ amount_gross_cents: 600 })
      const command = f.sqlite.prepare('SELECT response_body FROM payment_commands WHERE order_id = ?').get(id) as {
        response_body: string
      }
      const fields = JSON.parse(command.response_body).redirect.fields as Record<string, string>
      expect(decodeMerchantParameters(fields.Ds_MerchantParameters!).DS_MERCHANT_AMOUNT).toBe('600')
    } finally {
      f.sqlite.close()
    }
  })

  it('is idempotent: replaying the same command never spends the credit twice', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const first = await created(f, 400, 'idem')
      const again = await order(f, first.p, 'pickup', credit(400))
      if (again.outcome !== 'order_created') throw new Error(again.outcome)
      expect(again.body.id).toBe(first.id)
      expect(balance(f)).toBe(100)
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'redeem'")).toBe(1)
      expect(count(f, 'SELECT count(*) n FROM orders')).toBe(1)
      await expect(order(f, first.p, 'pickup', credit(399))).rejects.toThrow(/different (checkout )?payload/)
      expect(balance(f)).toBe(100)
    } finally {
      f.sqlite.close()
    }
  })

  it('rejects insufficient, voided and frozen credit before reserving stock or creating an order', async () => {
    const f = await wireFixture()
    try {
      const grant = await grantCredit(f, 300)
      const insufficient = await order(f, await prepare(f), 'pickup', credit(301))
      expect(insufficient).toMatchObject({ outcome: 'revalidation_required', reason: 'store_credit_unavailable' })
      await freezeStoreCredit(
        f.database,
        CLAIMS,
        { customerId: CUSTOMER, frozen: true, reason: 'Congelado por revision antifraude' },
        (f.sqlite.prepare('SELECT version FROM store_credit_accounts').get() as { version: number }).version,
        crypto.randomUUID(),
        utc()
      )
      const frozen = await order(f, await prepare(f), 'pickup', credit(100))
      expect(frozen).toMatchObject({ outcome: 'revalidation_required', reason: 'store_credit_unavailable' })
      await freezeStoreCredit(
        f.database,
        CLAIMS,
        { customerId: CUSTOMER, frozen: false, reason: 'Revision antifraude cerrada sin hallazgos' },
        (f.sqlite.prepare('SELECT version FROM store_credit_accounts').get() as { version: number }).version,
        crypto.randomUUID(),
        utc()
      )
      await voidStoreCreditGrant(
        f.database,
        CLAIMS,
        { grantId: grant, reason: 'Anulado por error de emision' },
        crypto.randomUUID(),
        utc()
      )
      const voided = await order(f, await prepare(f), 'pickup', credit(100))
      expect(voided).toMatchObject({ outcome: 'revalidation_required', reason: 'store_credit_unavailable' })
      expect(count(f, 'SELECT count(*) n FROM orders')).toBe(0)
      expect(count(f, "SELECT count(*) n FROM inventory_reservations WHERE status = 'reserved'")).toBe(0)
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'redeem'")).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })

  it('validates the amount: positive integer, signed in, below the order total, not with credit terms', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 5000)
      const p = await prepare(f)
      for (const bad of [0, -5, 1.5, Number.NaN, 1000, 1001])
        await expect(order(f, p, 'pickup', credit(bad))).rejects.toThrow(/storeCreditCents|invalid|payable/i)
      const guest = await prepare(f, { owner: false })
      await expect(order(f, guest, 'pickup', credit(100))).rejects.toThrow(/signed-in|storeCreditCents/i)
      const terms = await prepare(f)
      await expect(order(f, terms, 'pickup', { ...credit(100), paymentMethod: 'credit' })).rejects.toThrow(
        /credit terms|storeCreditCents/i
      )
      expect(count(f, 'SELECT count(*) n FROM orders')).toBe(0)
      const edge = await order(f, await prepare(f), 'pickup', credit(999))
      if (edge.outcome !== 'order_created') throw new Error(edge.outcome)
      expect(edge.body).toMatchObject({ storeCreditCents: 999, amountDueCents: 1 })
    } finally {
      f.sqlite.close()
    }
  })

  it('lets exactly one of two concurrent checkouts spend a balance that covers only one', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const [a, b] = [await prepare(f, { tag: 'race-a' }), await prepare(f, { tag: 'race-b' })]
      const results = await Promise.all([order(f, a, 'pickup', credit(400)), order(f, b, 'pickup', credit(400))])
      expect(results.map((r) => r.outcome).sort()).toEqual(['order_created', 'revalidation_required'])
      expect(balance(f)).toBe(100)
      expect(count(f, 'SELECT count(*) n FROM orders')).toBe(1)
      expect(count(f, "SELECT count(*) n FROM inventory_reservations WHERE status = 'reserved'")).toBe(1)
      expect(await reconciled(f)).toBe(true)
    } finally {
      f.sqlite.close()
    }
  })

  it('compensates on cancellation in the same transaction and never restores twice', async () => {
    const f = await wireFixture()
    try {
      const grant = await grantCredit(f, 500)
      const { id } = await created(f, 400)
      expect(balance(f)).toBe(100)
      const commandId = crypto.randomUUID()
      const input = {
        expectedStatus: 'awaiting_payment' as const,
        reason: 'Cancelacion solicitada expresamente por el comprador.'
      }
      const receipt = await cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, id, commandId, input, {
        audience: 'customer',
        now: () => utc()
      })
      expect(receipt.outcome).toBe('cancelled')
      expect(balance(f)).toBe(500)
      expect(f.sqlite.prepare('SELECT remaining_cents FROM store_credit_grants WHERE id = ?').get(grant)).toEqual({
        remaining_cents: 500
      })
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'restore'")).toBe(1)
      expect(
        count(
          f,
          `SELECT COALESCE(SUM(amount_cents), 0) n FROM store_credit_ledger WHERE order_ref = '${id}' AND entry_type IN ('redeem','restore')`
        )
      ).toBe(0)
      expect(await reconciled(f)).toBe(true)
      await cancelD1UnpaidOrder(f.database, BUYER_CLAIMS, id, commandId, input, {
        audience: 'customer',
        now: () => utc()
      })
      expect(balance(f)).toBe(500)
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'restore'")).toBe(1)
    } finally {
      f.sqlite.close()
    }
  })

  it('cancelling an order without store credit leaves the credit ledger untouched', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const p = await prepare(f)
      const plain = await order(f, p)
      if (plain.outcome !== 'order_created') throw new Error(plain.outcome)
      await cancelD1UnpaidOrder(
        f.database,
        BUYER_CLAIMS,
        String(plain.body.id),
        crypto.randomUUID(),
        { expectedStatus: 'awaiting_payment', reason: 'Cancelacion solicitada expresamente por el comprador.' },
        { audience: 'customer', now: () => utc() }
      )
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type <> 'issue'")).toBe(0)
      expect(balance(f)).toBe(500)
    } finally {
      f.sqlite.close()
    }
  })

  it('the post-order redeem endpoint reduces the amount due and is refused once a payment exists', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const p = await prepare(f)
      const plain = await order(f, p)
      if (plain.outcome !== 'order_created') throw new Error(plain.outcome)
      const id = String(plain.body.id)
      await redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: id, amountCents: 200 }, crypto.randomUUID(), utc())
      await initiateRedsysPayment(
        f.database,
        {
          orderId: id,
          orderToken: String(plain.body.orderToken),
          method: 'card',
          now: utc(),
          correlationId: 'wire-pay2',
          idempotencyKey: 'pay-wire-2'
        },
        redsys
      )
      expect(f.sqlite.prepare('SELECT amount_gross_cents FROM payment_intents WHERE order_id = ?').get(id)).toEqual({
        amount_gross_cents: 800
      })
      await expect(
        redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: id, amountCents: 100 }, crypto.randomUUID(), utc())
      ).rejects.toMatchObject({ code: 'invalid_transition' })
      expect(balance(f)).toBe(300)
    } finally {
      f.sqlite.close()
    }
  })

  it('records every rule in one reproducible snapshot: automatic discount, free shipping and credit', async () => {
    const f = await wireFixture()
    try {
      const auto = insertAutoRule(f, { basis_points: 1000 })
      const free = insertFreeShippingRule(f, { threshold_gross_cents: 1500, min_margin_basis_points: 0 })
      await grantCredit(f, 500)
      const p = await prepare(f, {
        lines: [{ variantId: 'v-1-1', quantity: 4 }],
        address: MADRID,
        expectedTotalGrossCents: 1800
      })
      const placed = await order(f, p, 'parcel', credit(500))
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      expect(placed.body).toMatchObject({
        totalGrossCents: 1800,
        shippingGrossCents: 0,
        storeCreditCents: 500,
        amountDueCents: 1300
      })
      const snapshot = JSON.parse(
        (f.sqlite.prepare('SELECT snapshot_json FROM order_pricing_snapshots').get() as { snapshot_json: string })
          .snapshot_json
      )
      expect(snapshot.autoDiscounts.rules[0]).toMatchObject({ ruleId: auto.id, version: 1, discountGrossCents: 200 })
      expect(snapshot.freeShipping).toMatchObject({ ruleId: free.id, ruleVersion: 1, free: true })
      expect(snapshot.storeCredit.totalCents).toBe(500)
      const t = snapshot.totals
      expect(t.goodsGrossCents + t.shippingGrossCents).toBe(t.orderTotalGrossCents)
      expect(t.orderTotalGrossCents - t.storeCreditCents).toBe(t.amountDueCents)
      expect(snapshot.precedence.at(-1)).toBe('store_credit')
      // Totals reproduce from the stored lines, never from the client.
      const lines = f.sqlite.prepare('SELECT sum(gross_cents) g FROM order_lines').get() as { g: number }
      expect(lines.g + snapshot.shipping.grossCents).toBe(1800)
    } finally {
      f.sqlite.close()
    }
  })

  it('when STORE_CREDIT_REDEMPTION_ENABLED is disabled (default and explicit false), charges the full total and consumes zero credit', async () => {
    const f = await wireFixture()
    try {
      await grantCredit(f, 500)
      const p = await prepare(f, { tag: 'flag-off-default' })
      const pickup = p.options.find((o) => o.methodCode === 'pickup')!
      const placed = await placeOrder(f.database, {
        ...p.base,
        selectedOptionIndex: pickup.optionIndex,
        selectedOptionHash: pickup.optionHash,
        storeCreditCents: 400
      })
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      expect(placed.body.totalGrossCents).toBe(1000)
      expect(placed.body.storeCreditCents).toBeUndefined()
      expect(placed.body.amountDueCents).toBeUndefined()
      expect(balance(f)).toBe(500)
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'redeem'")).toBe(0)

      const orderId = String(placed.body.id)
      const orderToken = String(placed.body.orderToken)

      // Post-order redeem endpoint also responds 503 feature_disabled by default and when explicitly 'false'
      const origin = 'https://wire.neteco.test'
      const cookieConfig = { password: 'p'.repeat(40), maxAgeSeconds: 3600 }
      const buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, cookieConfig))!.split(';')[0]!
      const makeRedeemRequest = (idempotencyKey: string) =>
        new Request(`${origin}/api/account/store-credit/redeem`, {
          method: 'POST',
          headers: {
            origin,
            cookie: buyerCookie,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
            'cf-connecting-ip': '192.0.2.1'
          },
          body: JSON.stringify({ orderId, amountCents: 200 })
        })
      const baseDeps = {
        database: f.database,
        sessionCookieConfiguration: cookieConfig,
        origin,
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        rateLimitPepper: 'synthetic-rate-limit-pepper-over-32'
      }
      const resDefault = await handlePricingHttp(makeRedeemRequest('redeem-disabled-1'), baseDeps)
      expect(resDefault?.status).toBe(503)
      expect(await resDefault?.json()).toEqual({ error: { code: 'feature_disabled' } })

      const resExplicitFalse = await handlePricingHttp(makeRedeemRequest('redeem-disabled-2'), {
        ...baseDeps,
        STORE_CREDIT_REDEMPTION_ENABLED: 'false'
      })
      expect(resExplicitFalse?.status).toBe(503)
      expect(await resExplicitFalse?.json()).toEqual({ error: { code: 'feature_disabled' } })

      expect(balance(f)).toBe(500)
      expect(count(f, "SELECT count(*) n FROM store_credit_ledger WHERE entry_type = 'redeem'")).toBe(0)

      await initiateRedsysPayment(
        f.database,
        {
          orderId,
          orderToken,
          method: 'card',
          now: utc(),
          correlationId: 'wire-pay-disabled',
          idempotencyKey: 'pay-wire-disabled'
        },
        redsys
      )
      const intent = f.sqlite.prepare('SELECT amount_gross_cents FROM payment_intents WHERE order_id = ?').get(orderId)
      expect(intent).toEqual({ amount_gross_cents: 1000 })
      const command = f.sqlite
        .prepare('SELECT response_body FROM payment_commands WHERE order_id = ?')
        .get(orderId) as { response_body: string }
      const fields = JSON.parse(command.response_body).redirect.fields as Record<string, string>
      expect(decodeMerchantParameters(fields.Ds_MerchantParameters!).DS_MERCHANT_AMOUNT).toBe('1000')
    } finally {
      f.sqlite.close()
    }
  })
})
