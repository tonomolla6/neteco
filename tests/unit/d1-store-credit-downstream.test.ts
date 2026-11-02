import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { returnsFixture, CUSTOMER, REQUEST } from './d1-returns-fixture'
import { refundsCreditFixture, CLAIMS, BUYER_CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import { applyStoreCreditMigrations, fundStoreCredit } from './d1-store-credit-downstream-fixture'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { requestD1CustomerReturn } from '../../workers/returns/operations'
import { planD1Refund, confirmD1Refund, readRefundContract } from '../../workers/refunds/operations'
import { readD1OrderRefunds } from '../../workers/refunds/access'
import { queueD1CreditNote } from '../../workers/fiscal/credit-notes'
import { reconcileStoreCredit, redeemStoreCredit } from '../../workers/pricing/store-credit'
import { requestPreauthorization } from '../../workers/payments/preauth'
import { decodeMerchantParameters } from '../../workers/payments/redsys'
import { assignReservation, releaseReservation, renewReservation } from '../../workers/catalog/inventory'
import { fakePreauthProvider, redsysConfig } from './pay-ext-fixture'
import { refundProviderRequest } from '../../shared/order-refunds'
import { receiveEmailDispatch, publishEmailOutbox } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { refundSucceededEmailRenderer } from '../../workers/communications/refund-credit-email'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})
const one = <T>(sqlite: DatabaseSync, sql: string, ...args: Array<string | number>) =>
  sqlite.prepare(sql).get(...args) as T
const all = <T>(sqlite: DatabaseSync, sql: string, ...args: Array<string | number>) =>
  sqlite.prepare(sql).all(...args) as T[]
const balance = (sqlite: DatabaseSync) =>
  one<{ balance_cents: number }>(
    sqlite,
    'SELECT balance_cents FROM store_credit_accounts WHERE customer_id=?',
    CUSTOMER
  ).balance_cents

/** Returns fixture + credit migrations; the account holds 500 cents, the order (1000) applies 400. */
async function creditWorld() {
  const f = await returnsFixture()
  opened.push(f.sqlite)
  await applyStoreCreditMigrations(f.sqlite)
  await fundStoreCredit(f.database, CUSTOMER, 500)
  return f
}
/** Refund/credit-note world over an order of 1000 cents: 600 captured by card, 400 store credit. */
async function refundWorld() {
  const f = await refundsCreditFixture({ storeCreditCents: 400 })
  await applyDeliveryPreferencesMigration(f.sqlite)
  opened.push(f.sqlite)
  return f
}

describe('PRI-018 downstream: an order partly paid with store credit is paid, fulfilled and returnable', () => {
  it('confirms the payment of total minus credit for fulfilment and enqueues the payment email', async () => {
    const f = await creditWorld()
    const id = await f.order({ storeCreditCents: 400, delivered: false })
    expect(one(f.sqlite, 'SELECT total_gross_cents FROM orders WHERE id=?', id)).toEqual({ total_gross_cents: 1000 })
    expect(one(f.sqlite, 'SELECT status,paid_gross_cents FROM order_payment_states WHERE order_id=?', id)).toEqual({
      status: 'paid',
      paid_gross_cents: 600
    })
    // The credit applied to the order is mirrored, atomically, into the order history.
    expect(
      all(
        f.sqlite,
        "SELECT json_extract(payload_json,'$.appliedCents') AS cents FROM order_events WHERE order_id=? AND event_type='store_credit.applied'",
        id
      )
    ).toEqual([{ cents: 400 }])
    expect(
      one(
        f.sqlite,
        "SELECT count(*) AS n FROM email_outbox_events WHERE source_id=? AND event_type='order.confirmed'",
        id
      )
    ).toEqual({ n: 1 })
    await executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      id,
      { action: 'picking', expectedVersion: 0, reason: REASON },
      { idempotencyKey: `${id}:picking` }
    )
    expect(one(f.sqlite, 'SELECT status FROM order_fulfillments WHERE order_id=?', id)).toEqual({ status: 'picking' })
  })

  it('pre-authorises only the amount due and freezes the credit once a pre-authorisation exists', async () => {
    const f = await creditWorld()
    const id = await f.order({ storeCreditCents: 400, paid: false })
    const deps = {
      database: f.database,
      configuration: redsysConfig,
      provider: fakePreauthProvider(),
      inventory: {
        assign: (input: Parameters<typeof assignReservation>[1]) => assignReservation(f.database, input),
        renew: (input: Parameters<typeof renewReservation>[1]) => renewReservation(f.database, input),
        release: (input: Parameters<typeof releaseReservation>[1]) => releaseReservation(f.database, input)
      },
      now: () => utc()
    }
    const request = (expectedAmountCents: number) =>
      requestPreauthorization(
        CLAIMS,
        {
          orderId: id,
          commandId: crypto.randomUUID(),
          reasonCode: 'made_to_order',
          justification: 'Made-to-order dilution needs a hold until the batch is confirmed',
          expectedAmountCents
        },
        deps
      )
    await expect(request(1000)).rejects.toMatchObject({ code: 'conflict' })
    const view = await request(600)
    expect(view).toMatchObject({ orderId: id, amountCents: 600 })
    expect(decodeMerchantParameters(view.redirect!.fields.Ds_MerchantParameters).DS_MERCHANT_AMOUNT).toBe('600')
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: id, amountCents: 50 }, crypto.randomUUID(), utc())
    ).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(balance(f.sqlite)).toBe(100)
  })

  it('refuses post-order credit on orders paid by bank transfer (credit terms) or through a market checkout', async () => {
    const f = await creditWorld()
    const redeem = (orderId: string) =>
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId, amountCents: 100 }, crypto.randomUUID(), utc())
    // Credit-terms order: its order.created evidence carries the bank-transfer instructions for the full total.
    const terms = await f.order({ paid: false })
    f.sqlite.exec('DROP TRIGGER order_events_no_update')
    f.sqlite
      .prepare(
        "UPDATE order_events SET payload_json=json_set(payload_json,'$.paymentMethod','transferencia') WHERE order_id=? AND event_type='order.created'"
      )
      .run(terms)
    await expect(redeem(terms)).rejects.toMatchObject({ code: 'invalid_transition' })
    // Market checkout order (0118 snapshot; only its order id matters here).
    const market = await f.order({ paid: false })
    f.sqlite.exec('CREATE TABLE IF NOT EXISTS order_market_snapshots(order_id TEXT PRIMARY KEY)')
    f.sqlite.prepare('INSERT INTO order_market_snapshots(order_id) VALUES(?)').run(market)
    await expect(redeem(market)).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(balance(f.sqlite)).toBe(500)
    // An ordinary unpaid order still accepts credit before any payment exists.
    const ordinary = await f.order({ paid: false })
    await redeem(ordinary)
    expect(balance(f.sqlite)).toBe(400)
  })

  it('admits a customer return of a delivered order paid partly with store credit', async () => {
    const f = await creditWorld()
    const id = await f.order({ storeCreditCents: 400 })
    const requested = await requestD1CustomerReturn(f.database, BUYER_CLAIMS, id, REQUEST, {
      idempotencyKey: 'rma-credit'
    })
    expect(requested.publicRef).toMatch(/^R/)
  })
})

describe('PRI-018 downstream: invoice and refunds of an order partly paid with store credit', () => {
  it('invoices the full order total; store credit is a means of payment, not a discount of the taxable base', async () => {
    const f = await refundWorld()
    expect(one(f.sqlite, 'SELECT amount_gross_cents FROM fiscal_outbox_events WHERE order_id=?', f.orderId)).toEqual({
      amount_gross_cents: 600
    })
    const intent = one<{ amount_gross_cents: number; contract_json: string }>(
      f.sqlite,
      'SELECT amount_gross_cents,contract_json FROM fiscal_invoice_intents WHERE order_id=?',
      f.orderId
    )
    const contract = JSON.parse(intent.contract_json)
    expect(intent.amount_gross_cents).toBe(1000)
    expect(contract).toMatchObject({ totalGrossCents: 1000, storeCreditCents: 400, paymentMethod: 'redsys' })
    expect(
      contract.lines.reduce((sum: number, line: { discountNetCents: number }) => sum + line.discountNetCents, 0)
    ).toBe(0)
    expect(one(f.sqlite, 'SELECT status FROM fiscal_issuance_work WHERE intent_id=?', f.ordinary.intentId)).toEqual({
      status: 'completed'
    })
  })

  it('splits partial refunds by the documented rule, restores the credit share as store credit and never over-refunds the card', async () => {
    const f = await refundWorld()
    expect(balance(f.sqlite)).toBe(100)
    const first = await f.completed(1)
    const { contract } = await readRefundContract(f.database, first.id)
    expect(contract).toMatchObject({
      amountCents: 500,
      capture: { capturedCents: 600 },
      tender: { cardCents: 300, storeCreditCents: 200 }
    })
    expect(refundProviderRequest(contract).amountCents).toBe(300)
    const effect = one<{ receipt_json: string }>(
      f.sqlite,
      'SELECT receipt_json FROM refund_fake_effects WHERE external_key=?',
      contract.idempotencyKey
    )
    expect(JSON.parse(effect.receipt_json).amountCents).toBe(300)
    const grant = one<{ id: string; kind: string; amount_cents: number; remaining_cents: number }>(
      f.sqlite,
      'SELECT id,kind,amount_cents,remaining_cents FROM store_credit_grants WHERE source_ref=?',
      `refund:${first.id}`
    )
    expect(grant).toMatchObject({ kind: 'refund_credit', amount_cents: 200, remaining_cents: 200 })
    expect(
      all(
        f.sqlite,
        'SELECT entry_type,amount_cents,order_ref,command_id FROM store_credit_ledger WHERE grant_id=?',
        grant.id
      )
    ).toEqual([{ entry_type: 'issue', amount_cents: 200, order_ref: null, command_id: first.id }])
    expect(balance(f.sqlite)).toBe(300)

    const second = await f.completed(1)
    expect((await readRefundContract(f.database, second.id)).contract.tender).toEqual({
      cardCents: 300,
      storeCreditCents: 200
    })
    expect(balance(f.sqlite)).toBe(500)
    const card = all<{ receipt_json: string }>(
      f.sqlite,
      "SELECT receipt_json FROM refund_receipts WHERE status='succeeded'"
    ).reduce((sum, row) => sum + JSON.parse(row.receipt_json).amountCents, 0)
    expect(card).toBe(600)
    expect(
      one(
        f.sqlite,
        'SELECT COALESCE(SUM(amount_cents),0) AS cents FROM refund_store_credit_restitutions WHERE order_id=?',
        f.orderId
      )
    ).toEqual({ cents: 400 })
    await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
    expect(
      one(f.sqlite, 'SELECT status,paid_gross_cents FROM order_payment_states WHERE order_id=?', f.orderId)
    ).toEqual({ status: 'paid', paid_gross_cents: 600 })
    const view = await readD1OrderRefunds(f.database, { kind: 'customer', claims: BUYER_CLAIMS }, f.orderId, {
      appEnvironment: 'local'
    })
    expect(view).toMatchObject({ capturedCents: 600, storeCreditCents: 400, reservedCents: 1000 })
    expect(view.items.map((item) => item.tender)).toEqual([
      { cardCents: 300, storeCreditCents: 200 },
      { cardCents: 300, storeCreditCents: 200 }
    ])
    // The corrective invoice (credit note) rectifies the full refunded value, whatever the tender.
    const credit = await queueD1CreditNote(f.database, CLAIMS, first.id, {
      idempotencyKey: crypto.randomUUID(),
      policyId: f.creditPolicy.id,
      reason: REASON,
      evidenceRef: 'approved-corrective-case'
    })
    expect(one(f.sqlite, 'SELECT amount_gross_cents FROM fiscal_credit_contracts WHERE id=?', credit.id)).toEqual({
      amount_gross_cents: 500
    })
  })

  it('notifies the refund with the card and store-credit shares', async () => {
    const f = await refundWorld()
    const refund = await f.completed(1)
    const events = all<{ id: string }>(f.sqlite, 'SELECT id FROM email_outbox_events WHERE source_id=?', refund.id)
    expect(events).toHaveLength(1)
    await publishEmailOutbox(
      f.database,
      {
        async send(message) {
          if (events.some((event) => event.id === message.eventId))
            expect(await receiveEmailDispatch(f.database, message, utc())).toBe('stored')
        }
      },
      { now: utc() }
    )
    const sender = { send: vi.fn(async () => ({ messageId: 'local-email' })) }
    expect(
      await dispatchTransactionalEmails(
        f.database,
        sender,
        {
          enabled: true,
          from: 'shop@example.invalid',
          now: utc(),
          appEnvironment: 'local' as const,
          invoiceEmailEnabled: true,
          rendererOptIns: ['refund.succeeded.v1'],
          rendererValidationEnabled: true
        },
        { renderers: [refundSucceededEmailRenderer] }
      )
    ).toMatchObject({ sent: 1 })
    const content = JSON.stringify(sender.send.mock.calls)
    expect(content).toContain('Importe: 5,00')
    expect(content).toContain('A la tarjeta: 3,00')
    expect(content).toContain('Como saldo en tienda: 2,00')
  })

  it('is idempotent: re-dispatching and replaying never restores credit or refunds the card twice', async () => {
    const f = await refundWorld()
    const key = crypto.randomUUID()
    const planned = await f.plan(1, key)
    expect(await f.plan(1, key)).toEqual(planned)
    await f.confirm(planned.id, planned.generation, planned.contractFingerprint)
    expect((await f.dispatch()).completed).toBe(1)
    expect((await f.dispatch()).completed).toBe(0)
    expect(one(f.sqlite, "SELECT count(*) AS n FROM store_credit_grants WHERE kind='refund_credit'")).toEqual({ n: 1 })
    expect(one(f.sqlite, 'SELECT count(*) AS n FROM refund_fake_effects')).toEqual({ n: 1 })
    expect(balance(f.sqlite)).toBe(300)
  })

  it('completes a refund whose card share rounds to zero as store credit only, without calling the provider', async () => {
    const f = await refundWorld()
    const planned = await planD1Refund(f.database, CLAIMS, {
      idempotencyKey: crypto.randomUUID(),
      policyId: f.policy.id,
      returnPublicRef: f.returnRef,
      expectedReturnVersion: 5,
      reason: REASON,
      evidenceRef: 'governed-local-case',
      lines: [{ lineIndex: 0, quantity: 1, amountCents: 1 }]
    })
    expect((await readRefundContract(f.database, planned.id)).contract.tender).toEqual({
      cardCents: 0,
      storeCreditCents: 1
    })
    await confirmD1Refund(f.database, CLAIMS, planned.id, {
      idempotencyKey: crypto.randomUUID(),
      expectedGeneration: planned.generation,
      contractFingerprint: planned.contractFingerprint,
      reason: REASON,
      evidenceRef: 'confirmed-local-case'
    })
    expect((await f.dispatch()).completed).toBe(1)
    expect(one(f.sqlite, 'SELECT count(*) AS n FROM refund_fake_effects')).toEqual({ n: 0 })
    expect(one(f.sqlite, 'SELECT status FROM refund_work WHERE refund_id=?', planned.id)).toEqual({
      status: 'completed'
    })
    expect(
      JSON.parse(
        one<{ receipt_json: string }>(
          f.sqlite,
          'SELECT receipt_json FROM refund_receipts WHERE refund_id=?',
          planned.id
        ).receipt_json
      )
    ).toMatchObject({ status: 'succeeded', amountCents: 0, providerReference: `store-credit:${planned.id}` })
    expect(balance(f.sqlite)).toBe(101)
  })

  it('the database rejects a concurrent plan that would over-allocate the card or skip the tender split', async () => {
    const f = await refundWorld()
    const planned = await f.plan(1)
    const row = one<Record<string, string | number>>(f.sqlite, 'SELECT * FROM refund_contracts WHERE id=?', planned.id)
    const forge = (changes: Record<string, unknown>, drop?: string) => {
      const id = crypto.randomUUID(),
        json = Object.fromEntries(
          Object.entries({
            ...JSON.parse(String(row.contract_json)),
            refundId: id,
            idempotencyKey: `refund:${id}`,
            ...changes
          }).filter(([key]) => key !== drop)
        )
      return () =>
        f.sqlite
          .prepare(
            'INSERT INTO refund_contracts(id,order_id,payment_intent_id,return_id,return_version,policy_id,planned_by,contract_json,contract_fingerprint,idempotency_key,amount_gross_cents,validation_only,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
          )
          .run(
            id,
            row.order_id!,
            row.payment_intent_id!,
            row.return_id!,
            row.return_version!,
            row.policy_id!,
            row.planned_by!,
            JSON.stringify(json),
            'a'.repeat(64),
            `refund:${id}`,
            json.amountCents,
            row.validation_only!,
            row.created_at!
          )
    }
    // 300 of the 600 captured by card is already held by the first plan.
    expect(forge({ amountCents: 400, tender: { cardCents: 400, storeCreditCents: 0 } })).toThrow(
      /refund_tender_invalid/
    )
    expect(forge({ amountCents: 300, tender: { cardCents: 0, storeCreditCents: 300 } })).toThrow(
      /refund_tender_invalid/
    )
    expect(forge({ amountCents: 300 }, 'tender')).toThrow(/refund_tender_invalid/)
    expect(forge({ amountCents: 300, tender: { cardCents: 100, storeCreditCents: 100 } })).toThrow(
      /refund_tender_invalid/
    )
    expect(() =>
      f.sqlite
        .prepare(
          "INSERT INTO refund_store_credit_restitutions(refund_id,order_id,customer_id,grant_id,command_id,amount_cents,created_at) VALUES(?,?,?,?,?,?,'2026-01-01T00:00:00Z')"
        )
        .run(planned.id, f.orderId, CUSTOMER, crypto.randomUUID(), crypto.randomUUID(), 200)
    ).toThrow()
  })
})
