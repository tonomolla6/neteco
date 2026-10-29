import type { DatabaseSync } from 'node:sqlite'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchFiscalRuntime } from '../../workers/fiscal/runtime-dispatch'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import {
  INVOICE_EMAIL_RENDERER_V1,
  renderInvoiceIssuedEmailV1
} from '../../workers/communications/invoice-issued-email'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { fiscalRuntimeWorld, FISCAL_RUNTIME_NOW } from './d1-fiscal-runtime-fixture'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  vi.restoreAllMocks()
})
async function world() {
  const w = await fiscalRuntimeWorld(opened)
  await applyDeliveryPreferencesMigration(w.sqlite)
  await dispatchFiscalRuntime(
    { database: w.database, storage: w.storage, providerResolver: () => w.provider },
    {
      appEnvironment: 'local',
      now: FISCAL_RUNTIME_NOW,
      flags: { enabled: true, localValidationEnabled: true },
      policyIds: [w.policy.id]
    }
  )
  const eventId = String(
    w.sqlite.prepare("SELECT id FROM email_outbox_events WHERE event_type='invoice.issued'").get()!.id
  )
  await publishEmailOutbox(
    w.database,
    {
      send: async (message) => {
        await receiveEmailDispatch(w.database, message, FISCAL_RUNTIME_NOW)
      }
    },
    { now: FISCAL_RUNTIME_NOW }
  )
  // Isolate invoice delivery; order.created's unchanged path is covered by its
  // existing regression suite and the new native mixed-source helper.
  w.sqlite
    .prepare(
      "UPDATE transactional_email_deliveries SET status='sent',finished_at=?,provider_message_id='fixture-order' WHERE event_id<>?"
    )
    .run(FISCAL_RUNTIME_NOW, eventId)
  const sender = { send: vi.fn(async () => ({ messageId: 'synthetic-local-message-1' })) }
  const config = {
    enabled: true,
    from: 'orders@example.invalid',
    now: FISCAL_RUNTIME_NOW,
    appEnvironment: 'local' as const,
    invoiceEmailEnabled: true,
    invoiceValidationEmailEnabled: true
  }
  const state = () => w.sqlite.prepare('SELECT * FROM transactional_email_deliveries WHERE event_id=?').get(eventId)!
  return { ...w, eventId, sender, config, state }
}
describe('invoice.issued delivery from confirmed immutable fiscal evidence', () => {
  it('requires a separate invoice opt-in without consuming its pending work', async () => {
    const w = await world()
    expect(
      await dispatchTransactionalEmails(w.database, w.sender, {
        enabled: true,
        from: w.config.from,
        now: FISCAL_RUNTIME_NOW
      })
    ).toMatchObject({ sent: 0 })
    expect(w.state()).toMatchObject({ status: 'pending', attempts: 0 })
    expect(w.sender.send).not.toHaveBeenCalled()
  })
  it('persists v1 source/content manifest with sending marker, labels synthetic evidence and sends once', async () => {
    const w = await world()
    w.sqlite.exec('UPDATE variants SET price_gross_cents=99000; UPDATE shipping_rates SET net_cents=9000')
    w.sender.send.mockImplementation(async () => {
      expect(w.state().status).toBe('sending')
      expect(
        w.sqlite
          .prepare('SELECT renderer_version FROM transactional_email_preparations WHERE event_id=?')
          .get(w.eventId)
      ).toEqual({ renderer_version: INVOICE_EMAIL_RENDERER_V1 })
      return { messageId: 'synthetic-local-message-1' }
    })
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({ sent: 1 })
    expect(w.sender.send).toHaveBeenCalledTimes(1)
    const message = (w.sender.send.mock.calls[0] as unknown as [Record<string, string>])[0]
    expect(message.subject).toContain('no es una factura fiscal')
    expect(message.text).toContain('prueba sintética local')
    expect(message.text).toContain('no concede acceso adicional')
    expect(message.html).not.toContain('<Buyer>')
    expect(JSON.stringify(message)).not.toMatch(/fiscal\/|https?:\/\/|\?token=|storage_key|24 horas|9000|99000/)
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({ sent: 0 })
    expect(w.sender.send).toHaveBeenCalledTimes(1)
    expect(() => w.sqlite.exec('DELETE FROM transactional_email_preparations')).toThrow('immutable')
    expect(() => w.sqlite.exec("UPDATE transactional_email_preparations SET renderer_version='next'")).toThrow(
      'immutable'
    )
    expect(() =>
      w.sqlite
        .prepare('INSERT OR REPLACE INTO transactional_email_preparations VALUES(?,?,?,?,?)')
        .run(w.eventId, 'replaced', 'a'.repeat(64), 'b'.repeat(64), FISCAL_RUNTIME_NOW)
    ).toThrow('immutable')
  })
  it.each(['preview', 'production'] as const)(
    'blocks synthetic documents outside local (%s)',
    async (appEnvironment) => {
      const w = await world()
      expect(await dispatchTransactionalEmails(w.database, w.sender, { ...w.config, appEnvironment })).toMatchObject({
        sent: 0,
        manualReview: 1
      })
      expect(w.sender.send).not.toHaveBeenCalled()
    }
  )
  it('blocks synthetic email without the separate validation-email opt-in', async () => {
    const w = await world()
    expect(
      await dispatchTransactionalEmails(w.database, w.sender, { ...w.config, invoiceValidationEmailEnabled: false })
    ).toMatchObject({ sent: 0, manualReview: 1 })
    expect(w.sender.send).not.toHaveBeenCalled()
  })
  it.each(['invoice.issued.v999', INVOICE_EMAIL_RENDERER_V1])(
    'blocks unknown renderer or source/message drift (%s) before sender',
    async (version) => {
      const w = await world()
      w.sqlite
        .prepare('INSERT INTO transactional_email_preparations VALUES(?,?,?,?,?)')
        .run(w.eventId, version, 'a'.repeat(64), 'b'.repeat(64), FISCAL_RUNTIME_NOW)
      expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({
        sent: 0,
        manualReview: 1
      })
      expect(w.sender.send).not.toHaveBeenCalled()
    }
  )
  it('quarantines accepted response loss and never sends again after receipt replay', async () => {
    const w = await world()
    w.sender.send.mockRejectedValue(Error('accepted but response lost: private body'))
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({
      sent: 0,
      manualReview: 1
    })
    expect(
      await receiveEmailDispatch(
        w.database,
        { type: 'email.dispatch.requested', version: 1, eventId: w.eventId },
        FISCAL_RUNTIME_NOW
      )
    ).toBe('replayed')
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({ sent: 0 })
    expect(w.sender.send).toHaveBeenCalledTimes(1)
    expect(w.state()).toMatchObject({ status: 'manual_review', last_error_code: 'provider_outcome_unknown' })
  })
  it('durably leaves sent-ack failure in manual review without resetting the obligation', async () => {
    const w = await world()
    w.sqlite.exec(
      "CREATE TRIGGER fail_invoice_email_sent BEFORE UPDATE OF status ON transactional_email_deliveries WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'synthetic ack failed'); END"
    )
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({
      sent: 0,
      manualReview: 1
    })
    expect(w.state()).toMatchObject({ status: 'manual_review', last_error_code: 'provider_ack_failed' })
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({ sent: 0 })
    expect(w.sender.send).toHaveBeenCalledTimes(1)
  })
  it('guards current completed proof inside the manifest+marker batch after preparation awaits', async () => {
    const w = await world()
    const database = {
      ...w.database,
      batch(statements: D1PreparedStatement[]) {
        w.sqlite.exec(
          "UPDATE fiscal_issuance_work SET status='uncertain',generation=generation+1,last_error_code='synthetic-proof-withdrawn'"
        )
        return w.database.batch(statements)
      }
    } as D1Database
    expect(await dispatchTransactionalEmails(database, w.sender, w.config)).toMatchObject({ sent: 0, manualReview: 1 })
    expect(w.sender.send).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM transactional_email_preparations').get()!.n).toBe(0)
  })
  it('keeps an unconfirmed committed marker non-retryable without invoking sender', async () => {
    const w = await world()
    const database = {
      ...w.database,
      async batch(statements: D1PreparedStatement[]) {
        await w.database.batch(statements)
        return [{ success: true }]
      }
    } as unknown as D1Database
    expect(await dispatchTransactionalEmails(database, w.sender, w.config)).toMatchObject({ sent: 0, lostLease: 1 })
    expect(w.state().status).toBe('sending')
    expect(w.sender.send).not.toHaveBeenCalled()
    expect(
      await dispatchTransactionalEmails(w.database, w.sender, {
        ...w.config,
        now: '2026-10-03T09:16:00Z',
        enabled: false
      })
    ).toMatchObject({ manualReview: 1, disabled: true })
  })
  it('uses the live SQL lease clock rather than a frozen scheduled instant after preparation awaits', async () => {
    const w = await world()
    const database = {
      ...w.database,
      batch(statements: D1PreparedStatement[]) {
        w.setClock('2026-10-03T09:01:01Z')
        return w.database.batch(statements)
      }
    } as D1Database
    expect(await dispatchTransactionalEmails(database, w.sender, w.config)).toMatchObject({ sent: 0, manualReview: 1 })
    expect(w.sender.send).not.toHaveBeenCalled()
    expect(w.sqlite.prepare('SELECT count(*) AS n FROM transactional_email_preparations').get()!.n).toBe(0)
  })
  it('does not accept a successful but semantically malformed marker acknowledgement as authority to send', async () => {
    const w = await world()
    const database = {
      ...w.database,
      async batch(statements: D1PreparedStatement[]) {
        const result = await w.database.batch(statements)
        result[1] = { success: true, results: [{}] } as D1Result
        return result
      }
    } as D1Database
    expect(await dispatchTransactionalEmails(database, w.sender, w.config)).toMatchObject({ sent: 0, lostLease: 1 })
    expect(w.state().status).toBe('sending')
    expect(w.sender.send).not.toHaveBeenCalled()
    expect(await dispatchTransactionalEmails(w.database, w.sender, w.config)).toMatchObject({ sent: 0 })
  })
  it('retries an operational historical-policy read outage without inventing missing fiscal evidence', async () => {
    const w = await world()
    const database = {
      ...w.database,
      prepare(sql: string) {
        const statement = w.database.prepare(sql)
        if (!sql.includes('SELECT id,policy_json,fingerprint,approved_at')) return statement
        const broken = {
          ...statement,
          bind: (...args: unknown[]) => {
            statement.bind(...args)
            return broken
          },
          first: async () => {
            throw new Error('synthetic D1 outage, not missing source')
          }
        }
        return broken as D1PreparedStatement
      }
    } as D1Database
    expect(await dispatchTransactionalEmails(database, w.sender, w.config)).toMatchObject({ sent: 0, retryable: 1 })
    expect(w.state()).toMatchObject({ status: 'pending', last_error_code: 'preparation_failed' })
    expect(w.sender.send).not.toHaveBeenCalled()
  })
  it('does not label fiscal_pending as emitted or synthetic evidence as a real invoice', () => {
    const data = {
      orderId: 'synthetic-order',
      name: 'Synthetic Buyer',
      code: 'DOC-1',
      lines: [{ description: 'Old price', sku: 'SKU', quantity: 1, grossCents: 123 }],
      shippingGrossCents: 0,
      totalGrossCents: 123,
      validationOnly: false
    }
    const pending = renderInvoiceIssuedEmailV1({ ...data, fiscalStatus: 'fiscal_pending' })
    expect(pending.subject).toContain('estado fiscal pendiente')
    expect(pending.subject).not.toContain('Factura emitida')
    expect(pending.text).toContain('No se confirma la emisión fiscal')
    const issued = renderInvoiceIssuedEmailV1({ ...data, fiscalStatus: 'issued' })
    expect(issued.subject).toContain('Factura emitida')
    expect(issued.text).not.toContain('prueba sintética')
    const syntheticPending = renderInvoiceIssuedEmailV1({
      ...data,
      validationOnly: true,
      fiscalStatus: 'fiscal_pending'
    })
    expect(syntheticPending.subject).toContain('estado simulado: pendiente fiscal')
    expect(syntheticPending.subject).not.toContain('Factura emitida')
  })
})
