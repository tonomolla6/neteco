import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FiscalPolicy } from '../../shared/fiscal-issuance'
import type { FiscalRuntimeConfiguration, FiscalRuntimeReport } from '../../workers/fiscal/runtime-dispatch'
import type {
  TransactionalEmailDispatchConfig,
  TransactionalEmailDispatchReport,
  TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
import { INVOICE_EMAIL_RENDERER_V1 } from '../../workers/communications/invoice-issued-email'
import { guardedFiscalDatabase } from '../../workers/fiscal/d1-boundary'

/** Entry-point callbacks are supplied by the root native auditor. The helper
 * never constructs a provider/sender, changes config, fakes transport receipts,
 * submits bank traffic or prints a message/recipient. A separately paid local
 * checkout order must be supplied; no synthetic paid UPDATE exists here. */
export async function auditNativeFiscalRuntimeEmail(input: {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  orderId: string
  runFiscal: (config: FiscalRuntimeConfiguration) => Promise<FiscalRuntimeReport>
  runEmails: (config: TransactionalEmailDispatchConfig) => Promise<TransactionalEmailDispatchReport>
  /** Must invoke the actual transport/consumer, not write an inbox row. */
  deliverEmailTransport: (eventId: string) => Promise<void>
  sentMessages: () => readonly Parameters<TransactionalEmailSender['send']>[0][]
  scenario: (name: string) => void
}): Promise<{ scenarios: number }> {
  assert.equal(new URL(input.origin).hostname, 'shop-audit.neteco.test')
  const db = guardedFiscalDatabase(input.database)
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const command = async (path: string, body: unknown) =>
    input.dispatch(
      new Request(`${input.origin}${path}`, {
        method: 'POST',
        headers: {
          cookie: input.adminCookie,
          origin: input.origin,
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.123'
        },
        body: JSON.stringify(body)
      })
    )
  input.scenario('native_governed_fiscal_executor_separate_allowlist_and_local_opt_ins')
  assert.equal(
    await db.prepare('SELECT id FROM fiscal_invoice_intents WHERE order_id=?').bind(input.orderId).first(),
    null
  )
  const approved = await command('/api/admin/fiscal/policies', {
    idempotencyKey: randomUUID(),
    provider: 'local_fake',
    environment: 'local_validation',
    series: 'LOCAL',
    trigger: 'after_payment_capture',
    mappings: {
      companyId: 'SYNTHETIC-LOCAL-ONLY',
      taxes: { '0': 'LOCAL-ZERO', '1000': 'LOCAL-REDUCED', '2100': 'LOCAL-GENERAL' },
      paymentCode: 'LOCAL-CARD'
    },
    reason: 'Synthetic local executor and email validation only',
    evidenceRef: 'synthetic-executor-email-not-provider-acceptance'
  })
  assert.equal(approved.status, 201)
  const { policy } = (await approved.json()) as { policy: FiscalPolicy }
  const request = { idempotencyKey: randomUUID(), eventId: `invoice-evaluation:${input.orderId}`, policyId: policy.id }
  const queued = await command('/api/admin/fiscal/requests', request)
  assert.equal(queued.status, 202)
  const { intentId } = (await queued.json()) as { intentId: string }
  const config: FiscalRuntimeConfiguration = {
    appEnvironment: 'local',
    now: now(),
    policyIds: [policy.id],
    flags: { enabled: true, localValidationEnabled: true }
  }
  assert.equal((await input.runFiscal({ ...config, flags: { enabled: false } })).disabled, true)
  assert.equal((await input.runFiscal({ ...config, policyIds: [] })).disabled, true)
  assert.equal((await input.runFiscal({ ...config, flags: { enabled: true } })).completed, 0)
  assert.equal(
    (
      await db
        .prepare('SELECT status FROM fiscal_issuance_work WHERE intent_id=?')
        .bind(intentId)
        .first<{ status: string }>()
    )?.status,
    'queued'
  )

  input.scenario('native_fiscal_executor_completion_and_replay_without_second_document')
  assert.equal((await input.runFiscal(config)).completed, 1)
  assert.equal((await input.runFiscal({ ...config, now: now() })).completed, 0)
  const event = await db
    .prepare("SELECT id FROM email_outbox_events WHERE source_id=? AND event_type='invoice.issued'")
    .bind(intentId)
    .first<{ id: string }>()
  assert(event)
  const receipt = await db
    .prepare('SELECT code FROM fiscal_provider_receipts WHERE intent_id=?')
    .bind(intentId)
    .first<{ code: string }>()
  assert(receipt)
  await input.deliverEmailTransport(event.id)

  input.scenario('native_invoice_email_own_opt_in_and_durable_versioned_manifest')
  const email: TransactionalEmailDispatchConfig = {
    enabled: true,
    from: 'synthetic-orders@example.test',
    now: now(),
    appEnvironment: 'local',
    invoiceValidationEmailEnabled: true
  }
  await input.runEmails(email)
  assert.equal(
    (
      await db
        .prepare('SELECT status,attempts FROM transactional_email_deliveries WHERE event_id=?')
        .bind(event.id)
        .first<{ status: string; attempts: number }>()
    )?.status,
    'pending'
  )
  const before = input.sentMessages().length
  const delivered = await input.runEmails({ ...email, invoiceEmailEnabled: true, now: now() })
  assert(delivered.sent >= 1)
  const messages = input
    .sentMessages()
    .slice(before)
    .filter((message) => message.subject.includes(receipt.code))
  assert.equal(messages.length, 1)
  const message = messages[0]!
  assert.match(message.subject, /no es una factura fiscal/)
  assert.match(message.text, /prueba sintética local/)
  assert.match(message.text, /no concede acceso adicional/)
  assert.doesNotMatch(JSON.stringify(message), /fiscal\/|https?:\/\/|\?token=|storage_key|24 horas/)
  const manifest = await db
    .prepare('SELECT renderer_version,source_hash,message_hash FROM transactional_email_preparations WHERE event_id=?')
    .bind(event.id)
    .first<{ renderer_version: string; source_hash: string; message_hash: string }>()
  assert.equal(manifest?.renderer_version, INVOICE_EMAIL_RENDERER_V1)
  assert.match(manifest!.source_hash, /^[0-9a-f]{64}$/)
  assert.match(manifest!.message_hash, /^[0-9a-f]{64}$/)

  input.scenario('native_invoice_email_transport_replay_never_resends_sent_work')
  await input.deliverEmailTransport(event.id)
  await input.runEmails({ ...email, invoiceEmailEnabled: true, now: now() })
  assert.equal(input.sentMessages().filter((sent) => sent.subject.includes(receipt.code)).length, 1)
  assert.equal(
    (
      await db
        .prepare('SELECT status FROM transactional_email_deliveries WHERE event_id=?')
        .bind(event.id)
        .first<{ status: string }>()
    )?.status,
    'sent'
  )
  assert.equal(
    (
      await db
        .prepare('SELECT count(*) AS n FROM fiscal_documents WHERE intent_id=?')
        .bind(intentId)
        .first<{ n: number }>()
    )?.n,
    1
  )
  return { scenarios: 4 }
}
