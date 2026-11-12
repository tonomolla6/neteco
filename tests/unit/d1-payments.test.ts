import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { renderD1CategorySeed, stableUuid } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { assignReservation } from '../../workers/catalog/inventory'
import { getOrderView, placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import {
  initiateRedsysPayment,
  processRedsysNotification,
  recoverAuthorisedPayments
} from '../../workers/catalog/payments'
import {
  encodeMerchantParameters,
  sha256Hex as redsysSha256Hex,
  signMerchantParameters,
  verifyRedsysNotification,
  type RedsysConfiguration
} from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { handlePaymentHttp } from '../../workers/payments/http'
import worker from '../../workers/canary'
import {
  publishFiscalOutbox,
  reconcileFiscalDelivery,
  receiveFiscalEvaluation,
  type FiscalEvaluationMessage
} from '../../workers/catalog/fiscal-outbox'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-08T10:00:00Z'
const config = {
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: '1',
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  merchantName: 'NETECO',
  publicBaseUrl: 'https://shop.example'
}
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

async function world() {
  const sqlite = await openMigratedDatabase()
  // Match D1's runtime expression limit on complete caller SQL envelopes.
  sqlite.limits.exprDepth = 100
  opened.push(sqlite)
  for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed])
    sqlite.exec(await render())
  const database = d1OverSqlite(sqlite)
  sqlite.function('payment_test_clock', () => NOW)
  const prepare = database.prepare.bind(database)
  database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'payment_test_clock()'))
  const publication = await provisionPublicationValidityFixture(database, {
    productIds: [stableUuid('product:1')],
    now: NOW
  })
  const cart = await createCart(database, { correlationId: 'payment-test', now: NOW })
  const common = { cartId: cart.cartId, token: cart.token, correlationId: 'payment-test', now: NOW }
  await setCartLine(database, {
    ...common,
    expectedVersion: 1,
    idempotencyKey: 'add',
    quantity: 1,
    variantId: stableUuid('variant:1:1')
  })
  const shipping = await requestShippingOptions(database, {
    ...common,
    expectedVersion: 2,
    idempotencyKey: 'shipping',
    destination: { city: 'Ontinyent', postalCode: '46870' }
  })
  const quote = await quoteCart(database, { ...common, expectedVersion: 2, idempotencyKey: 'quote' })
  if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('Checkout fixture failed')
  const options = shipping.body.options as Array<{ optionHash: string }>
  const order = await placeOrder(database, {
    ...common,
    expectedVersion: quote.quote.cartVersion,
    idempotencyKey: 'checkout',
    quoteId: quote.quote.quoteId,
    shippingQuoteId: String(shipping.body.shippingQuoteId),
    selectedOptionIndex: 0,
    selectedOptionHash: options[0]!.optionHash,
    consentTos: true,
    consentPrivacy: true,
    contactEmail: 'test@example.com',
    shippingAddress: {
      recipientName: 'Test Buyer',
      line1: 'Carrer Major 1',
      city: 'Ontinyent',
      province: 'Valencia',
      postalCode: '46870',
      countryCode: 'ES',
      phone: '600000000'
    }
  })
  if (order.outcome !== 'order_created') throw new Error('Order fixture failed')
  const input = {
    orderId: String(order.body.id),
    orderToken: String(order.body.orderToken),
    idempotencyKey: 'payment',
    method: 'card' as const,
    correlationId: 'payment-test',
    now: NOW
  }
  return { sqlite, database, input, publication }
}

async function notification(sqlite: DatabaseSync, response: string, intentId?: string) {
  const intent = sqlite
    .prepare('SELECT merchant_order, amount_gross_cents FROM payment_intents WHERE ?1 IS NULL OR id = ?1')
    .get(intentId ?? null)!
  const parameters = encodeMerchantParameters({
    Ds_Order: String(intent.merchant_order),
    Ds_Amount: String(intent.amount_gross_cents),
    Ds_Currency: '978',
    Ds_MerchantCode: config.merchantCode,
    Ds_Terminal: '1',
    Ds_TransactionType: '0',
    Ds_Response: response
  })
  return {
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
  }
}

function withdrawPolicy(sqlite: DatabaseSync, policyId: string) {
  const result = sqlite
    .prepare(
      `INSERT INTO catalog_publication_policy_withdrawals(id,policy_id,actor_id,reason,created_at)
    SELECT ?,id,actor_id,'Synthetic selected payment policy withdrawal',? FROM catalog_publication_policies WHERE id=?`
    )
    .run(testUuid(), NOW, policyId)
  expect(result.changes).toBe(1)
}

function initiationFacts(sqlite: DatabaseSync) {
  return sqlite
    .prepare(
      `SELECT
    (SELECT count(*) FROM payment_intents) AS intents,
    (SELECT count(*) FROM payment_commands) AS commands,
    (SELECT count(*) FROM payment_events) AS events,
    (SELECT count(*) FROM order_payment_states) AS states,
    (SELECT count(*) FROM order_events WHERE event_type='payment_started') AS started,
    (SELECT count(*) FROM orders WHERE id LIKE 'payment-guard:%') AS guards`
    )
    .get()
}
const NO_INITIATION = { intents: 0, commands: 0, events: 0, states: 0, started: 0, guards: 0 }

describe('D1 payment lifecycle', () => {
  function authorisations(sqlite: DatabaseSync) {
    return sqlite
      .prepare("SELECT id, payload_json FROM order_events WHERE event_type='payment_provider_authorised' ORDER BY id")
      .all() as Array<{ id: string; payload_json: string }>
  }

  function captureProofs(sqlite: DatabaseSync) {
    return authorisations(sqlite)
      .map((row) => JSON.parse(row.payload_json) as { captureSource?: Record<string, unknown> })
      .flatMap((payload) => (payload.captureSource ? [payload.captureSource] : []))
  }

  it('attests the first verified bank environment without storing a signature or merchant secret', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelope = await notification(sqlite, '0000')
    const verified = await verifyRedsysNotification(config, envelope)
    await processRedsysNotification(database, envelope, config, { now: NOW, correlationId: 'source-proof' })
    expect(captureProofs(sqlite)).toEqual([
      {
        schemaVersion: 1,
        provider: 'redsys',
        bankEnvironment: 'sandbox',
        payloadHash: verified.payloadHash,
        signatureFingerprint: await redsysSha256Hex(envelope.Ds_Signature),
        verifiedAt: NOW
      }
    ])
    expect(authorisations(sqlite)[0]?.id).toBe(`order-event:${verified.providerEventId}:authorised`)
    const stored = JSON.stringify(authorisations(sqlite))
    for (const privateValue of [envelope.Ds_Signature, config.secretKey, 'test@example.com', 'Carrer Major 1']) {
      expect(stored).not.toContain(privateValue)
    }
  })

  it('freezes the bank configuration before asynchronous verification, not the later caller configuration', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelope = await notification(sqlite, '0000')
    const mutableConfiguration: RedsysConfiguration = { ...config }
    const result = processRedsysNotification(database, envelope, mutableConfiguration, {
      now: NOW,
      correlationId: 'source-config-race'
    })
    mutableConfiguration.environment = 'production'
    expect(await result).toEqual({ outcome: 'captured' })
    expect(captureProofs(sqlite)).toHaveLength(1)
    expect(captureProofs(sqlite)[0]?.bankEnvironment).toBe('sandbox')
  })

  it('cannot reclassify a sandbox capture on replay or on a different successful callback', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const firstEnvelope = await notification(sqlite, '0000')
    await processRedsysNotification(database, firstEnvelope, config, { now: NOW, correlationId: 'first-source' })
    const original = authorisations(sqlite)[0]
    const originalProofs = captureProofs(sqlite)
    // Synthetic configuration change only: no provider connection is performed.
    const changedConfiguration = { ...config, environment: 'production' as const }
    for (const envelope of [firstEnvelope, await notification(sqlite, '0001')]) {
      expect(
        await processRedsysNotification(database, envelope, changedConfiguration, {
          now: '2026-09-08T10:00:01Z',
          correlationId: 'source-must-stay-sandbox'
        })
      ).toEqual({ outcome: 'captured' })
    }
    expect(authorisations(sqlite)).toContainEqual(original)
    expect(captureProofs(sqlite)).toEqual(originalProofs)
    expect(sqlite.prepare("SELECT count(*) AS n FROM payment_events WHERE event_type='captured'").get()).toEqual({
      n: 1
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='allocate'").get()
    ).toEqual({ n: 1 })
  })

  it('never backfills legacy authorisation evidence from a later verified callback', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const intent = sqlite.prepare('SELECT id FROM payment_intents').get()!
    const legacy = JSON.stringify({ intentId: intent.id, responseCode: '0000' })
    sqlite
      .prepare(
        `INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at)
         VALUES ('legacy-authorisation',?,'payment_provider_authorised',?,'synthetic-legacy-fixture',?)`
      )
      .run(input.orderId, legacy, NOW)
    expect(
      await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
        now: NOW,
        correlationId: 'legacy-callback'
      })
    ).toEqual({ outcome: 'captured' })
    expect(captureProofs(sqlite)).toEqual([])
    expect(sqlite.prepare("SELECT payload_json FROM order_events WHERE id='legacy-authorisation'").get()).toEqual({
      payload_json: legacy
    })
  })

  it('records only one first-source proof when distinct successful callbacks race', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelopes = await Promise.all([notification(sqlite, '0000'), notification(sqlite, '0001')])
    const results = await Promise.all(
      envelopes.map((envelope, index) =>
        processRedsysNotification(database, envelope, config, { now: NOW, correlationId: `source-race-${index}` })
      )
    )
    expect(results).toEqual([{ outcome: 'captured' }, { outcome: 'captured' }])
    expect(authorisations(sqlite)).toHaveLength(2)
    expect(captureProofs(sqlite)).toHaveLength(1)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='allocate'").get()
    ).toEqual({ n: 1 })
  })

  it('preserves the original bank proof during local recovery despite a different recovered-capture payload hash', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await expect(
      processRedsysNotification(
        database,
        await notification(sqlite, '0000'),
        config,
        { now: NOW, correlationId: 'source-recovery' },
        {
          assign: async () => {
            throw new Error('synthetic inventory outage')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'infrastructure' })
    const original = authorisations(sqlite)
    expect(captureProofs(sqlite)).toHaveLength(1)
    expect(await recoverAuthorisedPayments(database, { now: '2026-09-08T10:01:01Z' })).toEqual({
      recovered: 1,
      manualReview: 0,
      retryable: 0
    })
    expect(authorisations(sqlite)).toEqual(original)
    const events = sqlite.prepare('SELECT event_type,payload_hash FROM payment_events').all()
    expect(events.find((event) => event.event_type === 'provider_authorised')?.payload_hash).toBe(
      captureProofs(sqlite)[0]?.payloadHash
    )
    expect(events.find((event) => event.event_type === 'captured')?.payload_hash).not.toBe(
      captureProofs(sqlite)[0]?.payloadHash
    )
  })

  it('creates no source proof for invalid, declined or amount-mismatched notifications', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const invalid = await notification(sqlite, '0000')
    invalid.Ds_Signature = 'invalid-synthetic-signature'
    await expect(
      processRedsysNotification(database, invalid, config, { now: NOW, correlationId: 'invalid-source' })
    ).rejects.toMatchObject({ code: 'invalid_notification' })
    expect(
      await processRedsysNotification(database, await notification(sqlite, '0101'), config, {
        now: NOW,
        correlationId: 'declined-source'
      })
    ).toEqual({ outcome: 'failed' })
    const intent = sqlite.prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents').get()!
    const parameters = encodeMerchantParameters({
      Ds_Order: String(intent.merchant_order),
      Ds_Amount: String(Number(intent.amount_gross_cents) + 1),
      Ds_Currency: '978',
      Ds_MerchantCode: config.merchantCode,
      Ds_Terminal: '1',
      Ds_TransactionType: '0',
      Ds_Response: '0000'
    })
    expect(
      await processRedsysNotification(
        database,
        {
          Ds_MerchantParameters: parameters,
          Ds_SignatureVersion: 'HMAC_SHA512_V2',
          Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
        },
        config,
        { now: NOW, correlationId: 'mismatched-source' }
      )
    ).toEqual({ outcome: 'mismatch' })
    expect(captureProofs(sqlite)).toEqual([])
  })

  it('does not create a payment intent, command or event when the order policy was withdrawn before initiation', async () => {
    const { sqlite, database, input, publication } = await world()
    const order = sqlite.prepare('SELECT * FROM orders WHERE id=?').get(input.orderId)
    const lines = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(input.orderId)
    withdrawPolicy(sqlite, publication.policyId)
    await expect(initiateRedsysPayment(database, input, config)).rejects.toMatchObject({ code: 'not_payable' })
    expect(initiationFacts(sqlite)).toEqual(NO_INITIATION)
    expect(sqlite.prepare('SELECT * FROM orders WHERE id=?').get(input.orderId)).toEqual(order)
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(input.orderId)).toEqual(lines)
    expect(sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'reserved' })
  })

  it('never returns a cached redirect after its governing policy was withdrawn', async () => {
    const { sqlite, database, input, publication } = await world()
    const created = await initiateRedsysPayment(database, input, config)
    expect(created.status).toBe(201)
    expect(await initiateRedsysPayment(database, input, config)).toEqual(created)
    const intents = sqlite.prepare('SELECT * FROM payment_intents').all()
    const commands = sqlite.prepare('SELECT * FROM payment_commands').all()
    const facts = initiationFacts(sqlite)
    withdrawPolicy(sqlite, publication.policyId)
    await expect(initiateRedsysPayment(database, input, config)).rejects.toMatchObject({ code: 'not_payable' })
    expect(initiationFacts(sqlite)).toEqual(facts)
    expect(sqlite.prepare('SELECT * FROM payment_intents').all()).toEqual(intents)
    expect(sqlite.prepare('SELECT * FROM payment_commands').all()).toEqual(commands)
  })

  it.each(['policy_withdrawal', 'tax_expiry'] as const)(
    'rolls back every new initiation artifact when %s occurs just before its atomic batch',
    async (change) => {
      const { sqlite, database, input, publication } = await world()
      let batches = 0
      const raced = new Proxy(database, {
        get(target, property) {
          if (property !== 'batch') return Reflect.get(target, property)
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            batches += 1
            if (change === 'policy_withdrawal') withdrawPolicy(sqlite, publication.policyId)
            else
              sqlite
                .prepare(`UPDATE tax_classes SET valid_until='2020-01-02T00:00:00Z' WHERE id=?`)
                .run(stableUuid('tax:es-general-21'))
            return target.batch(statements)
          }
        }
      })
      await expect(initiateRedsysPayment(raced, input, config)).rejects.toMatchObject({ code: 'not_payable' })
      expect(batches).toBe(1)
      expect(initiationFacts(sqlite)).toEqual(NO_INITIATION)
      expect(sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'reserved' })
    }
  )

  it.each(['order_cancelled', 'reservation_released', 'reservation_expired', 'reservation_time_elapsed'] as const)(
    'does not return a bank redirect when %s wins immediately before the initiation batch',
    async (change) => {
      const { sqlite, database, input } = await world()
      const raced = new Proxy(database, {
        get(target, property) {
          if (property !== 'batch') return Reflect.get(target, property)
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            if (change === 'order_cancelled')
              sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(input.orderId)
            else if (change === 'reservation_time_elapsed')
              sqlite.function('payment_test_clock', () => '2026-09-08T10:31:00Z')
            else
              sqlite
                .prepare(
                  `UPDATE inventory_reservations SET status=?1,released_at=?2,expired_at=?3
                   WHERE id=(SELECT reservation_id FROM orders WHERE id=?4)`
                )
                .run(
                  change === 'reservation_released' ? 'released' : 'expired',
                  change === 'reservation_released' ? NOW : null,
                  change === 'reservation_expired' ? NOW : null,
                  input.orderId
                )
            return target.batch(statements)
          }
        }
      })
      await expect(initiateRedsysPayment(raced, input, config)).rejects.toMatchObject({ code: 'not_payable' })
      expect(initiationFacts(sqlite)).toEqual(NO_INITIATION)
    }
  )

  it('reconciles a valid bank success even after the policy has been withdrawn and never allocates twice', async () => {
    const { sqlite, database, input, publication } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelope = await notification(sqlite, '0000')
    withdrawPolicy(sqlite, publication.policyId)
    for (const correlationId of ['withdrawn-policy-capture', 'withdrawn-policy-duplicate']) {
      expect(await processRedsysNotification(database, envelope, config, { now: NOW, correlationId })).toEqual({
        outcome: 'captured'
      })
    }
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()).toEqual({ status: 'paid' })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM payment_events WHERE event_type='provider_authorised'").get()
    ).toEqual({ n: 1 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM payment_events WHERE event_type='captured'").get()).toEqual({
      n: 1
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='allocate'").get()
    ).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM fiscal_outbox_events').get()).toEqual({ n: 1 })
  })

  it('recovers an already-authorised payment after withdrawal without applying the initiation-only publication gate', async () => {
    const { sqlite, database, input, publication } = await world()
    await initiateRedsysPayment(database, input, config)
    await expect(
      processRedsysNotification(
        database,
        await notification(sqlite, '0000'),
        config,
        { now: NOW, correlationId: 'authorised-before-withdrawal' },
        {
          assign: async () => {
            throw new Error('synthetic temporary inventory outage')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'infrastructure' })
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()).toEqual({ status: 'provider_authorised' })
    withdrawPolicy(sqlite, publication.policyId)
    // Existing recovery retry backoff must elapse; publication withdrawal does
    // not bypass that operational clock or discard the authorised money.
    expect(await recoverAuthorisedPayments(database, { now: '2026-09-08T10:01:01Z' })).toEqual({
      recovered: 1,
      manualReview: 0,
      retryable: 0
    })
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()).toEqual({ status: 'paid' })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='allocate'").get()
    ).toEqual({ n: 1 })
  })

  it.each(['query', 'batch'] as const)(
    'preserves private HTTP500 for a %s provider outage instead of returning a publication business conflict',
    async (failure) => {
      const { sqlite, database, input } = await world()
      const unavailable = new Proxy(database, {
        get(target, property) {
          if (failure === 'query' && property === 'prepare')
            return (sql: string) => {
              if (sql.includes('FROM order_lines line') && sql.includes('AS valid'))
                throw new Error(
                  'D1_ERROR: synthetic unavailable CHECK constraint failed private_table customer@example.invalid'
                )
              return target.prepare(sql)
            }
          if (failure === 'batch' && property === 'batch')
            return async () => {
              throw new Error(
                'D1_ERROR: synthetic unavailable CHECK constraint failed private_table customer@example.invalid'
              )
            }
          return Reflect.get(target, property)
        }
      })
      const response = await handlePaymentHttp(
        new Request(`https://shop.example/api/orders/${input.orderId}/payment-intents`, {
          method: 'POST',
          headers: {
            authorization: `Order ${input.orderToken}`,
            'content-type': 'application/json',
            'idempotency-key': 'provider-outage'
          },
          body: JSON.stringify({ method: 'card' })
        }),
        {
          database: unavailable,
          configuration: () => config,
          now: () => NOW,
          inventory: { assign: (operation) => assignReservation(database, operation) }
        }
      )
      expect(response?.status).toBe(500)
      expect(response?.headers.get('cache-control')).toBe('no-store')
      expect(await response?.json()).toEqual({ error: { code: 'internal' } })
      expect(initiationFacts(sqlite)).toEqual(NO_INITIATION)
    }
  )

  it('returns private HTTP500 when publication withdrawal coincides with a provider batch outage mentioning CHECK', async () => {
    const { sqlite, database, input, publication } = await world()
    let batches = 0
    const unavailable = new Proxy(database, {
      get(target, property) {
        if (property === 'batch')
          return async () => {
            batches += 1
            withdrawPolicy(sqlite, publication.policyId)
            // Independently committed evidence drift does not mean that this
            // unexecuted batch failed a SQLite constraint.
            throw new Error('D1_ERROR: provider unavailable; CHECK constraint failed private_table')
          }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const response = await handlePaymentHttp(
      new Request(`https://shop.example/api/orders/${input.orderId}/payment-intents`, {
        method: 'POST',
        headers: {
          authorization: `Order ${input.orderToken}`,
          'content-type': 'application/json',
          'idempotency-key': 'provider-outage-with-drift'
        },
        body: JSON.stringify({ method: 'card' })
      }),
      {
        database: unavailable,
        configuration: () => config,
        now: () => NOW,
        inventory: { assign: (operation) => assignReservation(database, operation) }
      }
    )
    expect(batches).toBe(1)
    expect(response?.status).toBe(500)
    expect(response?.headers.get('cache-control')).toBe('no-store')
    expect(await response?.json()).toEqual({ error: { code: 'internal' } })
    expect(initiationFacts(sqlite)).toEqual(NO_INITIATION)
    expect(sqlite.prepare('SELECT status FROM inventory_reservations').get()).toEqual({ status: 'reserved' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_publication_policy_withdrawals').get()).toEqual({ n: 1 })
  })

  it.each([
    ['card', 'already_paid'],
    ['bizum', 'conflict']
  ] as const)(
    'revalidates a captured same-key catch winner for %s as %s without returning a redirect',
    async (method, code) => {
      const { sqlite, database, input } = await world()
      // Both supported methods must reach the contested batch; this is a
      // local test terminal, not a production enablement change.
      const raceConfig = { ...config, bizumEnabled: true }
      let batches = 0
      let afterWinner = initiationFacts(sqlite)
      let winnerIntents = sqlite.prepare('SELECT * FROM payment_intents').all()
      let winnerCommands = sqlite.prepare('SELECT * FROM payment_commands').all()
      const raced = new Proxy(database, {
        get(target, property) {
          if (property === 'batch')
            return async () => {
              batches += 1
              const winner = await initiateRedsysPayment(database, input, raceConfig)
              expect(winner.status).toBe(201)
              expect(
                await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
                  now: NOW,
                  correlationId: 'same-key-winner-captured'
                })
              ).toEqual({ outcome: 'captured' })
              afterWinner = initiationFacts(sqlite)
              winnerIntents = sqlite.prepare('SELECT * FROM payment_intents').all()
              winnerCommands = sqlite.prepare('SELECT * FROM payment_commands').all()
              throw new Error(
                'D1_ERROR: UNIQUE constraint failed: payment_commands.order_id, payment_commands.command_id: SQLITE_CONSTRAINT'
              )
            }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(initiateRedsysPayment(raced, { ...input, method }, raceConfig)).rejects.toMatchObject({ code })
      expect(batches).toBe(1)
      expect(initiationFacts(sqlite)).toEqual(afterWinner)
      expect(sqlite.prepare('SELECT * FROM payment_intents').all()).toEqual(winnerIntents)
      expect(sqlite.prepare('SELECT * FROM payment_commands').all()).toEqual(winnerCommands)
      expect(sqlite.prepare('SELECT status FROM order_payment_states').get()).toEqual({ status: 'paid' })
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type='allocate'").get()
      ).toEqual({ n: 1 })
    }
  )

  it('stops missing-receipt retries at ten attempts but records a late valid delivery', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'retry-bound'
    })
    sqlite.exec("UPDATE fiscal_outbox_delivery SET status = 'ready', attempts = 9")
    let sent: FiscalEvaluationMessage | undefined
    await publishFiscalOutbox(
      database,
      {
        send: async (message) => {
          sent = message
        }
      },
      { now: NOW }
    )
    expect(await reconcileFiscalDelivery(database, { now: '2026-09-08T10:10:00Z' })).toEqual({
      requeued: 0,
      manualReview: 1
    })
    expect(
      await publishFiscalOutbox(
        database,
        {
          send: async () => {
            throw new Error('must not send')
          }
        },
        { now: '2026-09-08T11:00:00Z' }
      )
    ).toMatchObject({ published: 0, retryable: 0 })
    expect(await receiveFiscalEvaluation(database, sent, '2026-09-08T11:01:00Z')).toBe('stored')
    expect(sqlite.prepare('SELECT status FROM fiscal_evaluation_inbox').get()!.status).toBe('blocked_policy')
  })

  it('requeues missing fiscal receipts after grace without bypassing policy or duplicating received work', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'receipt-loss'
    })
    expect(await reconcileFiscalDelivery(database, { now: '2026-09-08T10:20:00Z' })).toEqual({
      requeued: 0,
      manualReview: 0
    })
    expect(sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()!.status).toBe('blocked_policy')
    sqlite.exec("UPDATE fiscal_outbox_delivery SET status = 'ready'")
    const messages: FiscalEvaluationMessage[] = []
    const queue = {
      send: async (message: FiscalEvaluationMessage) => {
        messages.push(message)
      }
    }
    await publishFiscalOutbox(database, queue, { now: NOW })
    expect(await reconcileFiscalDelivery(database, { now: '2026-09-08T10:09:59Z' })).toEqual({
      requeued: 0,
      manualReview: 0
    })
    expect(await reconcileFiscalDelivery(database, { now: '2026-09-08T10:10:00Z' })).toEqual({
      requeued: 1,
      manualReview: 0
    })
    await publishFiscalOutbox(database, queue, { now: '2026-09-08T10:10:00Z' })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(messages[1])
    expect(await receiveFiscalEvaluation(database, messages[1], '2026-09-08T10:11:00Z')).toBe('stored')
    expect(await reconcileFiscalDelivery(database, { now: '2026-09-08T11:00:00Z' })).toEqual({
      requeued: 0,
      manualReview: 0
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM fiscal_evaluation_inbox').get()!.n).toBe(1)
  })

  it('routes scheduled fiscal publication and duplicate queue delivery into one durable policy-blocked job', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'fiscal'
    })
    const body: FiscalEvaluationMessage = {
      type: 'invoice.evaluate.requested',
      version: 1,
      eventId: `invoice-evaluation:${input.orderId}`
    }
    expect(await receiveFiscalEvaluation(database, body, NOW)).toBe('not_ready')
    expect(await receiveFiscalEvaluation(database, { ...body, amount: 1 }, NOW)).toBe('invalid')
    sqlite.exec("UPDATE fiscal_outbox_delivery SET status = 'ready'")
    const sent: unknown[] = []
    const env = {
      APP_ENV: 'local',
      FISCAL_ISSUANCE_ENABLED: 'false',
      FISCAL_LOCAL_VALIDATION_ENABLED: 'false',
      FISCAL_POLICY_IDS: '[]',
      DB: database,
      ASYNC_JOBS: {
        send: async (message: unknown) => {
          sent.push(message)
        }
      }
    } as unknown as CloudflareEnv
    await worker.scheduled({ scheduledTime: Date.parse(NOW) } as ScheduledController, env)
    const emailEvents = sqlite
      .prepare('SELECT id,event_type,source_event_id FROM email_outbox_events ORDER BY created_at,id')
      .all()
    expect(emailEvents).toHaveLength(2)
    expect(emailEvents.filter((event) => event.event_type === 'order.created')).toHaveLength(1)
    const intent = sqlite.prepare('SELECT id FROM payment_intents WHERE order_id=?').get(input.orderId)!
    expect(emailEvents.filter((event) => event.event_type === 'order.confirmed')).toEqual([
      { id: expect.stringMatching(/^email:[0-9a-f]{64}$/), event_type: 'order.confirmed', source_event_id: intent.id }
    ])
    expect(sent).toEqual([
      body,
      ...emailEvents.map((event) => ({ type: 'email.dispatch.requested', version: 1, eventId: event.id }))
    ])
    let acked = 0
    let retried = 0
    const message = () => ({
      body,
      ack: () => {
        acked++
      },
      retry: () => {
        retried++
      }
    })
    await worker.queue({ messages: [message(), message()] } as unknown as MessageBatch, env)
    expect(acked).toBe(2)
    expect(retried).toBe(0)
    expect(sqlite.prepare('SELECT count(*) AS n FROM fiscal_evaluation_inbox').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT order_id, status FROM fiscal_evaluation_inbox').get()).toMatchObject({
      order_id: input.orderId,
      status: 'blocked_policy'
    })
    sqlite.exec(`CREATE TRIGGER fail_fiscal_receipt BEFORE INSERT ON fiscal_evaluation_inbox
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;`)
    await worker.queue({ messages: [message()] } as unknown as MessageBatch, env)
    expect(acked).toBe(2)
    expect(retried).toBe(1)
    expect(await receiveFiscalEvaluation(database, { ...body, version: 2 }, NOW)).toBe('invalid')
  })

  it('publishes only policy-ready fiscal events and retries transport failure without PII', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'outbox'
    })
    const messages: FiscalEvaluationMessage[] = []
    const queue = {
      send: async (message: FiscalEvaluationMessage) => {
        messages.push(message)
      }
    }
    expect(await publishFiscalOutbox(database, queue, { now: NOW })).toMatchObject({ published: 0 })
    expect(messages).toHaveLength(0)
    // Test-only approval; no production policy is inferred by the publisher.
    sqlite.exec("UPDATE fiscal_outbox_delivery SET status = 'ready'")
    expect(
      await publishFiscalOutbox(
        database,
        {
          send: async () => {
            throw new Error('sensitive provider details')
          }
        },
        { now: NOW }
      )
    ).toMatchObject({ retryable: 1 })
    expect(
      sqlite.prepare('SELECT status, available_at, last_error_code FROM fiscal_outbox_delivery').get()
    ).toMatchObject({ status: 'ready', available_at: '2026-09-08T10:00:30Z', last_error_code: 'queue_send_failed' })
    await publishFiscalOutbox(database, queue, { now: NOW })
    expect(messages).toHaveLength(0)
    await Promise.all([1, 2].map(() => publishFiscalOutbox(database, queue, { now: '2026-09-08T10:00:30Z' })))
    expect(messages).toEqual([
      { type: 'invoice.evaluate.requested', version: 1, eventId: `invoice-evaluation:${input.orderId}` }
    ])
    expect(sqlite.prepare('SELECT status FROM fiscal_outbox_delivery').get()!.status).toBe('published')
  })

  it('fences a stalled publisher after another publisher recovers its expired lease', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'outbox'
    })
    sqlite.exec("UPDATE fiscal_outbox_delivery SET status = 'ready'")
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const messages: FiscalEvaluationMessage[] = []
    const first = publishFiscalOutbox(
      database,
      {
        send: async (message) => {
          messages.push(message)
          entered()
          await paused
        }
      },
      { now: NOW }
    )
    let result: Awaited<typeof first>
    try {
      await started
      expect(
        await publishFiscalOutbox(
          database,
          {
            send: async (message) => {
              messages.push(message)
            }
          },
          { now: '2026-09-08T10:01:01Z' }
        )
      ).toMatchObject({ published: 1 })
    } finally {
      release()
      result = await first
    }
    expect(result).toMatchObject({ published: 0, lostLease: 1 })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual(messages[1])
    expect(sqlite.prepare('SELECT status, attempts FROM fiscal_outbox_delivery').get()).toMatchObject({
      status: 'published',
      attempts: 2
    })
  })

  it('commits one blocked fiscal evaluation with payment and recovers an outbox write failure', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    sqlite.exec(`CREATE TRIGGER reject_fiscal_event BEFORE INSERT ON fiscal_outbox_events
      BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;`)
    const envelope = await notification(sqlite, '0000')
    await expect(
      processRedsysNotification(database, envelope, config, { now: NOW, correlationId: 'outbox-failure' })
    ).rejects.toThrow('injected outbox failure')
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('provider_authorised')
    expect(sqlite.prepare('SELECT count(*) AS n FROM fiscal_outbox_events').get()!.n).toBe(0)
    expect(sqlite.prepare('SELECT status FROM payment_recovery_jobs').get()!.status).toBe('pending')
    sqlite.exec('DROP TRIGGER reject_fiscal_event')
    expect(await recoverAuthorisedPayments(database, { now: NOW })).toMatchObject({ recovered: 1 })
    await processRedsysNotification(database, envelope, config, { now: NOW, correlationId: 'outbox-replay' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM fiscal_outbox_events').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT status, attempts FROM fiscal_outbox_delivery').get()).toMatchObject({
      status: 'blocked_policy',
      attempts: 0
    })
    expect(sqlite.prepare('SELECT order_id, event_type FROM fiscal_outbox_events').get()).toMatchObject({
      order_id: input.orderId,
      event_type: 'invoice.evaluate.requested'
    })
    expect(() => sqlite.exec('DELETE FROM fiscal_outbox_events')).toThrow('immutable')
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(1)
  })

  it.each([
    { event: 'captured', recoveryAt: NOW, recovered: 1, manualReview: 0, allocations: 1 },
    { event: 'stock_exception', recoveryAt: '2026-09-08T10:31:00Z', recovered: 0, manualReview: 1, allocations: 0 }
  ])('emits one local $event event when recovery overtakes a callback in flight', async (scenario) => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const callback = processRedsysNotification(
      database,
      await notification(sqlite, '0000'),
      config,
      { now: NOW, correlationId: 'callback-in-flight' },
      {
        assign: async (operation) => {
          entered()
          await paused
          return assignReservation(database, operation)
        }
      }
    )
    try {
      await started
      expect(await recoverAuthorisedPayments(database, { now: scenario.recoveryAt })).toEqual({
        recovered: scenario.recovered,
        manualReview: scenario.manualReview,
        retryable: 0
      })
    } finally {
      release()
      await callback
    }
    expect(sqlite.prepare('SELECT count(*) AS n FROM payment_events WHERE event_type = ?').get(scenario.event)!.n).toBe(
      1
    )
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM order_events WHERE event_type = ?').get(`payment_${scenario.event}`)!.n
    ).toBe(1)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(scenario.allocations)
  })

  it('preserves a late successful callback after a declined attempt has been retried', async () => {
    const { sqlite, database, input } = await world()
    const first = await initiateRedsysPayment(database, input, config)
    const lateSuccess = await notification(sqlite, '0000')
    await processRedsysNotification(database, await notification(sqlite, '0101'), config, {
      now: NOW,
      correlationId: 'first-declined'
    })
    const second = await initiateRedsysPayment(database, { ...input, idempotencyKey: 'retry-payment' }, config)
    expect(second.body.paymentIntentId).not.toBe(first.body.paymentIntentId)

    // A bank success cannot be discarded merely because a newer local attempt
    // exists. This promise must resolve and leave durable evidence for recovery.
    await processRedsysNotification(database, lateSuccess, config, {
      now: NOW,
      correlationId: 'late-first-success'
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM payment_events WHERE event_type = 'provider_authorised'").get()!.n
    ).toBe(1)
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(1)
    expect(sqlite.prepare('SELECT status, active_intent_id FROM order_payment_states').get()).toMatchObject({
      status: 'paid',
      active_intent_id: first.body.paymentIntentId
    })
    const secondSuccess = await notification(sqlite, '0000', String(second.body.paymentIntentId))
    for (let replay = 0; replay < 2; replay++) {
      expect(
        await processRedsysNotification(database, secondSuccess, config, {
          now: NOW,
          correlationId: `second-success-${replay}`
        })
      ).toEqual({ outcome: 'manual_review' })
    }
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM payment_events WHERE event_type = 'provider_authorised'").get()!.n
    ).toBe(2)
    expect(
      sqlite
        .prepare('SELECT status, last_error_code FROM payment_recovery_jobs WHERE payment_intent_id = ?')
        .get(String(second.body.paymentIntentId))
    ).toMatchObject({ status: 'manual_review', last_error_code: 'duplicate_provider_capture' })
    expect(await recoverAuthorisedPayments(database, { now: '2026-09-08T10:01:01Z' })).toEqual({
      recovered: 0,
      retryable: 0,
      manualReview: 0
    })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(1)
    await expect(
      initiateRedsysPayment(database, { ...input, idempotencyKey: 'third-payment' }, config)
    ).rejects.toMatchObject({ code: 'already_paid' })
  })

  it('elects one fulfilment winner for competing successful callbacks', async () => {
    const { sqlite, database, input } = await world()
    const first = await initiateRedsysPayment(database, input, config)
    const firstSuccess = await notification(sqlite, '0000')
    await processRedsysNotification(database, await notification(sqlite, '0101'), config, {
      now: NOW,
      correlationId: 'decline'
    })
    const second = await initiateRedsysPayment(database, { ...input, idempotencyKey: 'retry' }, config)
    const secondSuccess = await notification(sqlite, '0000', String(second.body.paymentIntentId))
    let assignments = 0
    const inventory = {
      assign: async (operation: Parameters<typeof assignReservation>[1]) => {
        assignments++
        return assignReservation(database, operation)
      }
    }
    const outcomes = await Promise.all(
      [firstSuccess, secondSuccess].map((envelope, index) =>
        processRedsysNotification(
          database,
          envelope,
          config,
          { now: NOW, correlationId: `competing-${index}` },
          inventory
        )
      )
    )
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(['captured', 'manual_review'])
    expect(assignments).toBe(1)
    const claim = sqlite.prepare('SELECT payment_intent_id FROM payment_fulfilment_claims').get()!
    expect([first.body.paymentIntentId, second.body.paymentIntentId]).toContain(claim.payment_intent_id)
    expect(sqlite.prepare('SELECT active_intent_id, status FROM order_payment_states').get()).toMatchObject({
      active_intent_id: claim.payment_intent_id,
      status: 'paid'
    })
    expect(() => sqlite.exec('DELETE FROM payment_fulfilment_claims')).toThrow('immutable')
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM payment_recovery_jobs WHERE status = 'manual_review'").get()!.n
    ).toBe(1)
  })

  it('rolls back a new redirect if a successful callback wins after initiation reads', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const success = await notification(sqlite, '0000')
    await processRedsysNotification(database, await notification(sqlite, '0101'), config, {
      now: NOW,
      correlationId: 'decline'
    })
    let interrupted = false
    const interleaved = new Proxy(database, {
      get(target, property) {
        if (property !== 'batch') return Reflect.get(target, property)
        return async (statements: D1PreparedStatement[]) => {
          interrupted = true
          await processRedsysNotification(database, success, config, { now: NOW, correlationId: 'before-new-batch' })
          return database.batch(statements)
        }
      }
    })
    await expect(
      initiateRedsysPayment(interleaved, { ...input, idempotencyKey: 'racing-retry' }, config)
    ).rejects.toMatchObject({ code: 'already_paid' })
    expect(interrupted).toBe(true)
    expect(sqlite.prepare('SELECT count(*) AS n FROM payment_intents').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM payment_commands').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('paid')
  })

  it('recovers a persisted capture through the scheduled handler and inventory binding', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await expect(
      processRedsysNotification(
        database,
        await notification(sqlite, '0000'),
        config,
        { now: NOW, correlationId: 'scheduled-capture' },
        {
          assign: async () => {
            throw new Error('temporary outage')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'infrastructure' })
    let assignments = 0
    const env = {
      APP_ENV: 'local',
      FISCAL_ISSUANCE_ENABLED: 'false',
      FISCAL_LOCAL_VALIDATION_ENABLED: 'false',
      FISCAL_POLICY_IDS: '[]',
      DB: database,
      INVENTORY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            assignments += 1
            const command = (await request.json()) as { payload: Parameters<typeof assignReservation>[1] }
            return Response.json(await assignReservation(database, command.payload))
          }
        })
      }
    } as unknown as CloudflareEnv
    const event = { scheduledTime: Date.parse('2026-09-08T10:01:01Z') } as ScheduledController
    await worker.scheduled(event, env)
    await worker.scheduled(event, env)
    expect(assignments).toBe(1)
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('paid')
  })

  it('accepts an authenticated HTTP initiation and signed form callback', async () => {
    const { database, sqlite, input } = await world()
    const deps = {
      database,
      configuration: () => config,
      now: () => NOW,
      inventory: {
        assign: (operation: Parameters<typeof assignReservation>[1]) => assignReservation(database, operation)
      }
    }
    const start = await handlePaymentHttp(
      new Request(`https://shop.example/api/orders/${input.orderId}/payment-intents`, {
        method: 'POST',
        headers: {
          authorization: `Order ${input.orderToken}`,
          'content-type': 'application/json',
          'idempotency-key': 'http-payment'
        },
        body: JSON.stringify({ method: 'card' })
      }),
      deps
    )
    expect(start?.status).toBe(201)
    expect(start?.headers.get('cache-control')).toBe('no-store')
    const envelope = await notification(sqlite, '0000')
    const response = await handlePaymentHttp(
      new Request('https://shop.example/api/payments/redsys/notification', {
        method: 'POST',
        body: new URLSearchParams(envelope)
      }),
      deps
    )
    expect(response?.status).toBe(200)
    expect(await response?.text()).toBe('OK')
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('paid')
    const malformed = await handlePaymentHttp(
      new Request('https://shop.example/api/payments/redsys/notification', {
        method: 'POST',
        body: new URLSearchParams([...Object.entries(envelope), ['Ds_Signature', envelope.Ds_Signature]])
      }),
      deps
    )
    expect(malformed?.status).toBe(400)
    const unauthorized = await handlePaymentHttp(
      new Request(`https://shop.example/api/orders/${input.orderId}/payment-intents`, {
        method: 'POST',
        body: '{}'
      }),
      deps
    )
    expect(unauthorized?.status).toBe(401)
  })

  it('exposes persisted payment facts only to the order owner', async () => {
    const { database, sqlite, input } = await world()
    const access = { orderId: input.orderId, token: input.orderToken, now: NOW }
    expect((await getOrderView(database, access))?.payment).toEqual({ status: 'awaiting_payment', paidGrossCents: 0 })
    await initiateRedsysPayment(database, input, config)
    expect((await getOrderView(database, access))?.payment.status).toBe('processing')
    await processRedsysNotification(database, await notification(sqlite, '0000'), config, {
      now: NOW,
      correlationId: 'paid-view'
    })
    const view = await getOrderView(database, access)
    expect(view?.payment.status).toBe('paid')
    expect(view?.payment.paidGrossCents).toBeGreaterThan(0)
    expect(JSON.stringify(view)).not.toContain('secretKey')
    expect(await getOrderView(database, { ...access, token: 'incorrect' })).toBeNull()
  })

  it('keeps an expired reservation in manual review after duplicate successful callbacks', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelope = await notification(sqlite, '0000')
    for (const correlationId of ['late-capture', 'late-duplicate']) {
      await expect(
        processRedsysNotification(database, envelope, config, {
          now: '2026-09-08T11:00:00Z',
          correlationId
        })
      ).resolves.toEqual({ outcome: 'stock_exception' })
      expect(sqlite.prepare('SELECT status FROM payment_recovery_jobs').get()!.status).toBe('manual_review')
    }
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(0)
    await expect(
      initiateRedsysPayment(database, { ...input, idempotencyKey: 'second-charge' }, config)
    ).rejects.toMatchObject({ code: 'already_paid' })
  })

  it('captures once and recovers a lost inventory response without another stock decrement', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    const envelope = await notification(sqlite, '0000')
    await expect(
      processRedsysNotification(
        database,
        envelope,
        config,
        { now: NOW, correlationId: 'capture' },
        {
          assign: async (operation) => {
            await assignReservation(database, operation)
            throw new Error('Inventory response lost after commit')
          }
        }
      )
    ).rejects.toMatchObject({ code: 'infrastructure' })
    expect(sqlite.prepare('SELECT status FROM payment_intents').get()!.status).toBe('provider_authorised')
    const recovered = await recoverAuthorisedPayments(database, { now: '2026-09-08T10:01:01Z' })
    expect(recovered).toEqual({ recovered: 1, manualReview: 0, retryable: 0 })
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('paid')
    const movements = sqlite
      .prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'")
      .get()!.n
    expect(movements).toBe(1)
    await expect(
      processRedsysNotification(database, envelope, config, { now: '2026-09-08T10:02:00Z', correlationId: 'duplicate' })
    ).resolves.toEqual({ outcome: 'captured' })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'allocate'").get()!.n
    ).toBe(movements)
  })

  it('authenticates before returning a persisted redirect replay', async () => {
    const { database, input } = await world()
    const first = await initiateRedsysPayment(database, input, config)
    expect(await initiateRedsysPayment(database, input, config)).toEqual(first)
    await expect(initiateRedsysPayment(database, { ...input, orderToken: 'incorrect' }, config)).rejects.toMatchObject({
      code: 'unauthorized'
    })
    await expect(initiateRedsysPayment(database, { ...input, method: 'bizum' }, config)).rejects.toMatchObject({
      code: 'conflict'
    })
  })

  it('does not resurrect a declined attempt when an older pending callback arrives', async () => {
    const { sqlite, database, input } = await world()
    await initiateRedsysPayment(database, input, config)
    await processRedsysNotification(database, await notification(sqlite, '0101'), config, {
      now: NOW,
      correlationId: 'decline'
    })
    await processRedsysNotification(database, await notification(sqlite, '9998'), config, {
      now: NOW,
      correlationId: 'late-pending'
    })
    expect(sqlite.prepare('SELECT status FROM payment_intents').get()!.status).toBe('failed')
    expect(sqlite.prepare('SELECT status FROM order_payment_states').get()!.status).toBe('failed')
  })
})
