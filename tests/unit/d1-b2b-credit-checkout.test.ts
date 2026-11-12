import { describe, expect, it } from 'vitest'
import { CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { creditWorld as world } from './d1-b2b-credit-fixture'
import { placeOrder } from '../../workers/catalog/checkout'
import { handleStorefrontCheckoutHttp } from '../../workers/catalog/storefront-checkout'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { reserveInventory, releaseReservation, assignReservation } from '../../workers/catalog/inventory'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { requestD1CustomerReturn, executeD1AdminReturnCommand } from '../../workers/returns/operations'
import { approveRefundPolicy } from '../../workers/refunds/policies'
import { planD1Refund, confirmD1Refund, dispatchD1Refunds } from '../../workers/refunds/operations'
import { PersistentLocalRefundProvider } from '../../workers/refunds/local-provider'
import { hash } from '../../workers/refunds/authority'
import { testUuid } from '../support/deterministic'

describe('credit checkout', () => {
  it.each([-1, 0, 1])('enforces limit at total plus %i cent', async (delta) => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents + delta)
      const result = await placeOrder(f.database, input)
      expect(result.outcome).toBe(delta < 0 ? 'credit_limit_exceeded' : 'order_created')
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_credit_reservations').get()).toMatchObject({
        n: delta < 0 ? 0 : 1
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not allow concurrent checkouts to jointly exceed the limit', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      const results = await Promise.all([placeOrder(f.database, first), placeOrder(f.database, second)])
      expect(results.map((r) => r.outcome).sort()).toEqual(['credit_limit_exceeded', 'order_created'])
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_credit_reservations').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it.each(['pending', 'suspended', 'rejected'])('rejects a company with status %s', async (status) => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      f.sqlite.prepare('UPDATE companies SET status=? WHERE id=?').run(status, 'company')
      const result = await placeOrder(f.database, input)
      expect(result.outcome).toBe('credit_unavailable')
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a manually blocked company', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents, 0, 1)
      const result = await placeOrder(f.database, input)
      expect(result.outcome).toBe('credit_unavailable')
    } finally {
      f.sqlite.close()
    }
  })
  it('replays the same checkout without a second credit reservation', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      const first = await placeOrder(f.database, input)
      const replay = await placeOrder(f.database, input)
      expect(replay).toEqual(first)
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_credit_reservations').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('releases credit when the order is cancelled', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      const result = await placeOrder(f.database, first)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      f.sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(result.body.id as string)
      expect((await placeOrder(f.database, second)).outcome).toBe('order_created')
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a block placed between credit reservation and order commit', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      const texts = new WeakMap<object, string>()
      let blocked = false
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql)
              const bind = statement.bind.bind(statement)
              statement.bind = (...values: unknown[]) => {
                const bound = bind(...values)
                texts.set(bound, sql)
                return bound
              }
              texts.set(statement, sql)
              return statement
            }
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!blocked && statements.some((statement) => texts.get(statement)?.includes('INSERT INTO orders'))) {
                blocked = true
                f.terms(input.expectedTotalGrossCents, 1, 1)
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      expect((await placeOrder(db, input)).outcome).toBe('credit_unavailable')
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('releases exposure for an order recorded as paid', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      const result = await placeOrder(f.database, first)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      f.sqlite
        .prepare("INSERT INTO order_payment_states(order_id,status,paid_gross_cents,updated_at) VALUES(?,'paid',?,?)")
        .run(result.body.id as string, first.expectedTotalGrossCents, f.now)
      expect((await placeOrder(f.database, second)).outcome).toBe('order_created')
    } finally {
      f.sqlite.close()
    }
  })
  it('accepts approved transfer through HTTP and the per-cart coordinator even without Redsys', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      const key = testUuid(),
        origin = 'https://shop.neteco.test'
      const address = {
        recipientName: 'Buyer',
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        region: 'Valencia',
        postalCode: '46870',
        phone: '+34600111222'
      }
      const request = new Request(origin + '/api/orders', {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'idempotency-key': key,
          'CF-Connecting-IP': '192.0.2.10',
          cookie: `neteco-cart-v2=v1.${input.cartId}.${input.token}; neteco-session=present`
        },
        body: JSON.stringify({
          cartId: input.cartId,
          cartVersion: 2,
          quoteId: input.quoteId,
          shippingQuoteId: input.shippingQuoteId,
          optionIndex: input.selectedOptionIndex,
          optionHash: input.selectedOptionHash,
          expectedTotalGrossCents: input.expectedTotalGrossCents,
          customer: { name: 'Buyer', email: 'buyer@example.invalid', phone: '+34600111222' },
          shippingAddress: address,
          billingAddress: address,
          paymentMethod: 'transferencia',
          termsAccepted: true,
          privacyNoticePresented: true,
          marketingConsent: false
        })
      })
      const response = await handleStorefrontCheckoutHttp(request, {
        database: f.database,
        dispatch: async (command) => {
          const result = await handleCartCommand(command, {
            database: f.database,
            getResponse: async () => undefined,
            putResponse: async () => {},
            setAlarm: async () => {}
          })
          return Response.json(result.body, { status: result.status })
        },
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        rateLimitPepper: 'test-credit-pepper-over-32-characters',
        paymentConfiguration: () => null,
        session: async () => BUYER_CLAIMS,
        authenticationEnabled: true,
        now: () => f.now
      })
      expect(response?.status).toBe(201)
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_credit_reservations').get()).toMatchObject({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects unknown coordinator payment methods rather than treating them as immediate', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      const result = await handleCartCommand(
        {
          type: 'checkout',
          cartId: input.cartId,
          commandId: input.idempotencyKey,
          payload: { ...input, paymentMethod: 'unknown' }
        },
        {
          database: f.database,
          getResponse: async () => undefined,
          putResponse: async () => {},
          setAlarm: async () => {}
        }
      )
      expect(result.status).toBe(400)
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('shows the transfer method in the buyer order detail', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents)
      const result = await placeOrder(f.database, input)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      const id = result.body.id as string,
        token = result.body.orderToken as string
      const req = new Request(`https://shop.neteco.test/api/orders/${id}`, {
        headers: { 'CF-Connecting-IP': '192.0.2.10', cookie: `neteco-order-access-v2=v1.${id}.${token}` }
      })
      const response = await handleStorefrontCheckoutHttp(req, {
        database: f.database,
        dispatch: async () => new Response(null, { status: 500 }),
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        rateLimitPepper: 'test-credit-pepper-over-32-characters',
        paymentConfiguration: () => null,
        session: async () => null,
        authenticationEnabled: true,
        now: () => f.now
      })
      expect(response?.status).toBe(200)
      expect(await response?.json()).toMatchObject({ paymentMethod: 'transferencia' })
    } finally {
      f.sqlite.close()
    }
  })
  it('counts a live reservation before its order is created', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      let signal!: () => void, release!: () => void
      const entered = new Promise<void>((resolve) => {
          signal = resolve
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
      const pending = placeOrder(f.database, first, {
        reserve: async (input) => {
          signal()
          await gate
          return reserveInventory(f.database, input)
        },
        release: (input) => releaseReservation(f.database, input)
      })
      await entered
      const blocked = await placeOrder(f.database, second)
      expect(blocked.outcome).toBe('credit_limit_exceeded')
      release()
      expect((await pending).outcome).toBe('order_created')
    } finally {
      f.sqlite.close()
    }
  })
  it('releases exposure through the actual customer cancellation command', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      const result = await placeOrder(f.database, first)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      await cancelD1UnpaidOrder(
        f.database,
        BUYER_CLAIMS,
        result.body.id as string,
        testUuid(),
        { expectedStatus: 'awaiting_payment', reason: 'Cancelación solicitada por el cliente' },
        { audience: 'customer', now: () => f.now }
      )
      expect((await placeOrder(f.database, second)).outcome).toBe('order_created')
    } finally {
      f.sqlite.close()
    }
  })
  it('releases exposure after a verified payment and keeps it released after refund', async () => {
    const f = await world()
    try {
      const first = await f.input(),
        second = await f.input()
      f.terms(first.expectedTotalGrossCents)
      const result = await placeOrder(f.database, first)
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      const config = {
        environment: 'sandbox' as const,
        merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
        terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
        secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
        merchantName: 'NETECO',
        bizumEnabled: false,
        publicBaseUrl: 'https://credit-test.neteco.test'
      }
      await initiateRedsysPayment(
        f.database,
        {
          orderId: result.body.id as string,
          orderToken: result.body.orderToken as string,
          method: 'card',
          now: f.now,
          correlationId: 'credit-test',
          idempotencyKey: 'payment'
        },
        config
      )
      const intent = f.sqlite
        .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
        .get(result.body.id as string) as { merchant_order: string; amount_gross_cents: number }
      const parameters = encodeMerchantParameters({
        Ds_Order: intent.merchant_order,
        Ds_Amount: String(intent.amount_gross_cents),
        Ds_Currency: '978',
        Ds_MerchantCode: config.merchantCode,
        Ds_Terminal: config.terminal,
        Ds_TransactionType: '0',
        Ds_Response: '0000'
      })
      await processRedsysNotification(
        f.database,
        {
          Ds_MerchantParameters: parameters,
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
        },
        config,
        { correlationId: 'credit-test', now: f.now },
        { assign: (payload) => assignReservation(f.database, payload) }
      )
      expect(
        f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(result.body.id as string)
      ).toMatchObject({ status: 'paid' })
      const orderId = result.body.id as string,
        reason = 'Revisión documentada del pedido'
      for (const [version, action] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries())
        await executeD1AdminFulfillmentCommand(
          f.database,
          CLAIMS,
          orderId,
          { action, expectedVersion: version, reason, ...(action === 'delivered' ? { evidence: reason } : {}) },
          { idempotencyKey: testUuid() }
        )
      const returned = await requestD1CustomerReturn(
        f.database,
        BUYER_CLAIMS,
        orderId,
        { expectedVersion: 0, reason, lines: [{ lineIndex: 0, quantity: 1 }] },
        { idempotencyKey: testUuid() }
      )
      for (const input of [
        {
          action: 'approved',
          expectedVersion: 1,
          lines: [{ lineIndex: 0, quantity: 1 }],
          decisionRef: 'documented-manual-case-review'
        },
        { action: 'received', expectedVersion: 2, lines: [{ lineIndex: 0, quantity: 1 }] },
        {
          action: 'inspected',
          expectedVersion: 3,
          lines: [{ lineIndex: 0, quantity: 1, condition: 'opened', disposition: 'non_restockable' }]
        },
        {
          action: 'resolution_ready',
          expectedVersion: 4,
          resolution: reason,
          cost: {
            amountCents: 0,
            currency: 'EUR',
            category: 'handling',
            evidenceRef: 'manual-no-charge',
            description: reason
          }
        }
      ])
        await executeD1AdminReturnCommand(
          f.database,
          CLAIMS,
          returned.publicRef,
          { reason, publicMessage: reason, evidence: reason, ...input },
          { idempotencyKey: testUuid() }
        )
      const mappings = { merchantCode: config.merchantCode, terminal: config.terminal, currencyCode: '978' as const }
      const policy = await approveRefundPolicy(f.database, CLAIMS, {
        idempotencyKey: testUuid(),
        provider: 'local_fake',
        environment: 'local_validation',
        mappings,
        shipping: 'excluded',
        approvalMode: 'same_actor_confirmation',
        maximumRefundCents: 100000,
        evidenceRef: 'synthetic-local-only',
        reason
      })
      const planned = await planD1Refund(f.database, CLAIMS, {
        idempotencyKey: testUuid(),
        policyId: policy.id,
        returnPublicRef: returned.publicRef,
        expectedReturnVersion: 5,
        reason,
        evidenceRef: 'documented-local-case',
        lines: [{ lineIndex: 0, quantity: 1 }]
      })
      await confirmD1Refund(f.database, CLAIMS, planned.id, {
        idempotencyKey: testUuid(),
        expectedGeneration: planned.generation,
        contractFingerprint: planned.contractFingerprint,
        reason,
        evidenceRef: 'confirmed-local-case'
      })
      const provider = new PersistentLocalRefundProvider(f.database, await hash(mappings))
      expect(
        await dispatchD1Refunds(f.database, provider, {
          now: utc(),
          appEnvironment: 'local',
          policyId: policy.id,
          enabled: true,
          localValidationEnabled: true
        })
      ).toMatchObject({ completed: 1 })
      expect(
        f.sqlite.prepare('SELECT outstanding_cents FROM b2b_credit_open_amounts WHERE order_id=?').get(orderId)
      ).toMatchObject({ outstanding_cents: 0 })
      expect((await placeOrder(f.database, second)).outcome).toBe('order_created')
    } finally {
      f.sqlite.close()
    }
  })
  it('does not commit an order if its reserved amount is smaller than its contractual total', async () => {
    const f = await world()
    try {
      const input = await f.input()
      f.terms(input.expectedTotalGrossCents - 1)
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const stmt = target.prepare(sql),
                bind = stmt.bind.bind(stmt)
              if (sql.includes('INSERT INTO b2b_credit_reservations'))
                stmt.bind = (...values: unknown[]) => {
                  values[3] = 1
                  return bind(...values)
                }
              return stmt
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(placeOrder(db, input)).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
})
