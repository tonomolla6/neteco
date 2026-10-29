import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import * as checkout from '../../workers/catalog/checkout'
import { returnsFixture, utc } from './d1-returns-fixture'
import {
  initiateRedsysPayment,
  processRedsysNotification,
  recoverAuthorisedPayments
} from '../../workers/catalog/payments'
import { assignReservation } from '../../workers/catalog/inventory'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { prepareOrderPaymentEmail, orderPaymentEmailRenderers } from '../../workers/communications/order-payment-email'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
let f: Awaited<ReturnType<typeof returnsFixture>>,
  orderId: string,
  envelope: { Ds_MerchantParameters: string; Ds_SignatureVersion: string; Ds_Signature: string }
const from = 'payments@example.invalid',
  context = { appEnvironment: 'local' as const, validationEnabled: false }
const config = {
  environment: 'sandbox' as const,
  merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
  terminal: '1',
  secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
  merchantName: 'NETECO',
  publicBaseUrl: 'https://returns-fixture.neteco.test'
}
beforeEach(async () => {
  f = await returnsFixture()
  await applyDeliveryPreferencesMigration(f.sqlite)
  const placed = vi.spyOn(checkout, 'placeOrder')
  orderId = await f.order({ paid: false, delivered: false })
  const result = await placed.mock.results[0]!.value
  placed.mockRestore()
  if (result.outcome !== 'order_created') throw new Error('payment-fixture-failed')
  await initiateRedsysPayment(
    f.database,
    {
      orderId,
      orderToken: String(result.body.orderToken),
      method: 'card',
      idempotencyKey: 'payment-email',
      correlationId: 'payment-email',
      now: utc()
    },
    config
  )
  const intent = f.sqlite
    .prepare('SELECT id,merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
    .get(orderId) as { id: string; merchant_order: string; amount_gross_cents: number }
  const parameters = encodeMerchantParameters({
    Ds_Order: intent.merchant_order,
    Ds_Amount: String(intent.amount_gross_cents),
    Ds_Currency: '978',
    Ds_MerchantCode: config.merchantCode,
    Ds_Terminal: config.terminal,
    Ds_TransactionType: '0',
    Ds_Response: '0000'
  })
  envelope = {
    Ds_MerchantParameters: parameters,
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
  }
})
afterEach(() => {
  f?.sqlite.close()
  vi.restoreAllMocks()
})
const capture = () =>
  processRedsysNotification(f.database, envelope, config, { now: utc(), correlationId: 'payment-email' })
function event() {
  const row = f.sqlite.prepare("SELECT id FROM email_outbox_events WHERE event_type='order.confirmed'").get() as
    { id: string } | undefined
  expect(row).toBeDefined()
  return row!.id
}
it('renders only verified captured/assigned payment with sandbox notice and no bank settlement assertion', async () => {
  expect(await capture()).toEqual({ outcome: 'captured' })
  const id = event(),
    prepared = await prepareOrderPaymentEmail(f.database, id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  expect(prepared.message.to).toBe('buyer@example.invalid')
  expect(prepared.message.text).toContain(orderId)
  expect(prepared.message.text).toContain('Captura registrada')
  expect(prepared.message.text).toContain('Validación local o sandbox')
  expect(prepared.message.text).toContain('no acredita una liquidación bancaria')
  expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM email_outbox_events WHERE id=?').get(id))).not.toContain(
    'buyer@'
  )
  expect(prepared.message.text).not.toContain(envelope.Ds_Signature)
})
it('competing callback/recovery and exact replay produce one capture event and one email metadata', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((r) => {
      entered = r
    }),
    blocked = new Promise<void>((r) => {
      release = r
    })
  const first = processRedsysNotification(
    f.database,
    envelope,
    config,
    { now: utc(), correlationId: 'first-executor' },
    {
      assign: async (input) => {
        entered()
        await blocked
        return assignReservation(f.database, input)
      }
    }
  )
  await started
  expect(await recoverAuthorisedPayments(f.database, { now: utc() })).toMatchObject({ recovered: 1 })
  release()
  expect(await first).toEqual({ outcome: 'captured' })
  await capture()
  expect(
    f.sqlite.prepare("SELECT count(*) n FROM email_outbox_events WHERE event_type='order.confirmed'").get()
  ).toEqual({ n: 1 })
  expect(f.sqlite.prepare("SELECT count(*) n FROM payment_events WHERE event_type='captured'").get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_movements WHERE movement_type='allocate'").get()).toEqual({
    n: 1
  })
  expect('error' in (await prepareOrderPaymentEmail(f.database, event(), from, context))).toBe(false)
})
it('assignment failure produces no email and recovery enqueues only once after actual assignment', async () => {
  await expect(
    processRedsysNotification(
      f.database,
      envelope,
      config,
      { now: utc(), correlationId: 'failed-assignment' },
      {
        assign: async () => {
          throw new Error('synthetic-offline')
        }
      }
    )
  ).rejects.toThrow()
  expect(
    f.sqlite.prepare("SELECT count(*) n FROM email_outbox_events WHERE event_type='order.confirmed'").get()
  ).toEqual({ n: 0 })
  await recoverAuthorisedPayments(f.database, { now: utc(61000) })
  event()
})
it('email insert failure rolls back captured/paid/audit and recovery completes without double stock assignment', async () => {
  f.sqlite.exec(
    "CREATE TRIGGER reject_payment_email BEFORE INSERT ON email_outbox_events WHEN NEW.event_type='order.confirmed' BEGIN SELECT RAISE(ABORT,'synthetic-outbox-failure'); END"
  )
  await expect(capture()).rejects.toThrow()
  expect(f.sqlite.prepare("SELECT count(*) n FROM payment_events WHERE event_type='captured'").get()).toEqual({ n: 0 })
  expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(orderId)).toEqual({
    status: 'provider_authorised'
  })
  f.sqlite.exec('DROP TRIGGER reject_payment_email')
  await recoverAuthorisedPayments(f.database, { now: utc() })
  event()
  expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_movements WHERE movement_type='allocate'").get()).toEqual({
    n: 1
  })
})
it('OFF leaves pending; explicit local opt-in sends once and never resends after acknowledgement loss', async () => {
  await capture()
  const id = event()
  await publishEmailOutbox(
    f.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(f.database, message, utc())
      }
    },
    { now: utc(), limit: 100 }
  )
  const sender = {
      send: vi.fn<TransactionalEmailSender['send']>(async (message) => {
        if (message.subject.includes('Captura registrada')) throw new Error('synthetic-lost-ack')
        return { messageId: 'local-other' }
      })
    },
    options = { enabled: true, from, now: utc(), appEnvironment: 'local' as const }
  await dispatchTransactionalEmails(f.database, sender, options, { renderers: orderPaymentEmailRenderers })
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(id)).toEqual({
    status: 'pending'
  })
  await dispatchTransactionalEmails(
    f.database,
    sender,
    { ...options, rendererOptIns: orderPaymentEmailRenderers.map((r) => r.key) },
    { renderers: orderPaymentEmailRenderers }
  )
  await dispatchTransactionalEmails(
    f.database,
    sender,
    { ...options, rendererOptIns: orderPaymentEmailRenderers.map((r) => r.key) },
    { renderers: orderPaymentEmailRenderers }
  )
  expect(sender.send.mock.calls.filter(([message]) => message.subject.includes('Captura registrada'))).toHaveLength(1)
  expect(f.sqlite.prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?').get(id)).toEqual({
    status: 'manual_review'
  })
})
it('superseded paid state cannot pass prepared final authority guard', async () => {
  await capture()
  const id = event(),
    prepared = await prepareOrderPaymentEmail(f.database, id, from, context)
  if ('error' in prepared) throw new Error(prepared.error)
  f.sqlite.prepare("UPDATE order_payment_states SET status='cancelled' WHERE order_id=?").run(orderId)
  expect(await prepareOrderPaymentEmail(f.database, id, from, context)).toEqual({ error: 'source_not_found' })
  await expect(
    f.database.batch(
      orderPaymentEmailRenderers[0]!.authorityStatements(
        f.database,
        { eventId: id, leaseToken: crypto.randomUUID(), sendingAt: utc(), leaseUntil: utc(60000) },
        prepared
      )
    )
  ).rejects.toThrow()
})
it('sandbox capture is never rendered as production truth', async () => {
  await capture()
  expect(
    await prepareOrderPaymentEmail(f.database, event(), from, { ...context, appEnvironment: 'production' })
  ).toEqual({ error: 'invalid_source' })
})
it.each(['authorization_json', 'capture_json', 'amount', 'payload_hash'])(
  'tampered source field %s fails proof or final source fence',
  async (field) => {
    await capture()
    const id = event()
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
          if (key === 'first')
            return async () => {
              const raw = await target.first<Record<string, unknown>>()
              if (!raw?.intent_id) return raw
              return {
                ...raw,
                [field]:
                  field === 'authorization_json'
                    ? null
                    : field === 'capture_json'
                      ? JSON.stringify({
                          amountGrossCents: raw.amount,
                          intentId: raw.intent_id,
                          provider: 'redsys',
                          privateNote: 'unexpected'
                        })
                      : field === 'amount'
                        ? Number(raw.amount) + 1
                        : '0'.repeat(64)
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    const corrupted = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const prepared = await prepareOrderPaymentEmail(corrupted, id, from, context)
    if (field === 'authorization_json' || field === 'capture_json' || field === 'amount')
      expect(prepared).toEqual({ error: 'invalid_source' })
    else {
      if ('error' in prepared) throw new Error(prepared.error)
      await expect(
        f.database.batch(
          orderPaymentEmailRenderers[0]!.authorityStatements(
            f.database,
            { eventId: id, leaseToken: crypto.randomUUID(), sendingAt: utc(), leaseUntil: utc(60000) },
            prepared
          )
        )
      ).rejects.toThrow()
    }
  }
)
