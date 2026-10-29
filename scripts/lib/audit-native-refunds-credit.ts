import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  refundCommandReceiptSchema,
  orderRefundsViewSchema,
  refundPolicyInputSchema,
  type RefundPolicyInput
} from '../../shared/order-refunds'
import {
  creditCommandReceiptSchema,
  creditViewSchema,
  creditPolicyInputSchema,
  type CreditPolicyInput
} from '../../shared/fiscal-credit'
import { fiscalUuid } from '../../shared/fiscal-issuance'
import { guardedFiscalDatabase } from '../../workers/fiscal/d1-boundary'
import { canonicalJson } from '../../workers/catalog/inventory'
import type { dispatchD1Refunds } from '../../workers/refunds/operations'
import type { dispatchD1CreditNotes } from '../../workers/fiscal/credit-notes'
import type {
  TransactionalEmailDispatchConfig,
  TransactionalEmailDispatchReport,
  TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'

/** Host callbacks exercise the owned engine against native D1/R2; these are
 * NOT claims that Cron/Queue entrypoints or real bank/Beply/email accepted work. */
export async function auditNativeRefundsCredit(input: {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  customerCookie: string
  orderId: string
  returnPublicRef: string
  returnVersion: number
  /** Explicit synthetic policies. No legal/fiscal configuration inferred. */
  refundPolicy: RefundPolicyInput
  creditPolicy: CreditPolicyInput
  runRefunds: (config: Parameters<typeof dispatchD1Refunds>[2]) => ReturnType<typeof dispatchD1Refunds>
  runCredits: (config: Parameters<typeof dispatchD1CreditNotes>[3]) => ReturnType<typeof dispatchD1CreditNotes>
  deliverEmailTransport: (eventId: string) => Promise<void>
  runEmails: (config: TransactionalEmailDispatchConfig) => Promise<TransactionalEmailDispatchReport>
  sentMessages: () => readonly Parameters<TransactionalEmailSender['send']>[0][]
  scenario: (name: string) => void
}): Promise<{
  scenarios: number
  externalAcceptance: false
  inventoryUnchanged: true
  captureUnchanged: true
  originalInvoiceUnchanged: true
}> {
  const origin = new URL(input.origin)
  assert(
    origin.protocol === 'https:' && origin.origin === input.origin && origin.hostname.endsWith('.test'),
    'native_refunds_local_origin_required'
  )
  fiscalUuid.parse(input.orderId)
  const refundPolicy = refundPolicyInputSchema.parse(input.refundPolicy),
    creditPolicy = creditPolicyInputSchema.parse(input.creditPolicy)
  assert.equal(refundPolicy.provider, 'local_fake')
  assert.equal(refundPolicy.environment, 'local_validation')
  assert.equal(creditPolicy.provider, 'local_fake')
  assert.equal(creditPolicy.environment, 'local_validation')
  const db = guardedFiscalDatabase(input.database),
    now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason = 'Explicit synthetic local financial resolution validation only',
    evidenceRef = 'native-local-only-not-provider-acceptance'
  const historical = await db
    .prepare(
      'SELECT o.shipping_gross_cents,line.quantity,line.gross_cents,o.total_gross_cents FROM orders o JOIN order_lines line ON line.order_id=o.id AND line.line_index=0 WHERE o.id=?1'
    )
    .bind(input.orderId)
    .first<{ shipping_gross_cents: number; quantity: number; gross_cents: number; total_gross_cents: number }>()
  assert(
    historical &&
      historical.shipping_gross_cents === 0 &&
      historical.quantity === 2 &&
      historical.gross_cents === historical.total_gross_cents,
    'native_refunds_two_unit_pickup_contract_required'
  )
  const get = (path: string, cookie = input.customerCookie) =>
    input.dispatch(new Request(`${input.origin}${path}`, { headers: { cookie, 'cf-connecting-ip': '192.0.2.128' } }))
  const command = (path: string, body: unknown) =>
    input.dispatch(
      new Request(`${input.origin}${path}`, {
        method: 'POST',
        headers: {
          cookie: input.adminCookie,
          origin: input.origin,
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.128'
        },
        body: JSON.stringify(body)
      })
    )
  async function value(response: Response, status: number) {
    assert.equal(response.status, status)
    assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/)
    return response.json()
  }
  const unchangedQueries = [
    'SELECT * FROM inventory_balances ORDER BY variant_id,location_id',
    'SELECT * FROM inventory_movements ORDER BY id',
    'SELECT * FROM payment_intents ORDER BY id',
    'SELECT * FROM order_payment_states ORDER BY order_id',
    'SELECT * FROM fiscal_invoice_intents ORDER BY id',
    'SELECT * FROM fiscal_provider_receipts ORDER BY intent_id',
    'SELECT * FROM fiscal_documents ORDER BY id'
  ]
  const before = canonicalJson(await db.batch(unchangedQueries.map((sql) => db.prepare(sql))))
  input.scenario('native_refunds_explicit_governed_policy_and_double_confirmation')
  const refundApproved = (await value(await command('/api/admin/refunds/policies', refundPolicy), 201)) as {
      policy: { id: string }
    },
    creditApproved = (await value(await command('/api/admin/credits/policies', creditPolicy), 201)) as {
      policy: { id: string }
    }
  const refunds = []
  for (let part = 0; part < 2; part++) {
    const body = {
      idempotencyKey: randomUUID(),
      policyId: refundApproved.policy.id,
      returnPublicRef: input.returnPublicRef,
      expectedReturnVersion: input.returnVersion,
      reason,
      evidenceRef,
      lines: [{ lineIndex: 0, quantity: 1 }]
    }
    const planned = refundCommandReceiptSchema.parse(
      await value(await command('/api/admin/refunds/requests', body), 202)
    )
    assert.deepEqual(await value(await command('/api/admin/refunds/requests', body), 202), planned)
    const config = {
      now: now(),
      appEnvironment: 'local' as const,
      policyId: refundApproved.policy.id,
      enabled: true,
      localValidationEnabled: true
    }
    assert.equal((await input.runRefunds({ ...config, enabled: false })).completed, 0)
    assert.equal((await input.runRefunds(config)).completed, 0)
    await value(
      await command(`/api/admin/refunds/${planned.id}/confirm`, {
        idempotencyKey: randomUUID(),
        expectedGeneration: planned.generation,
        contractFingerprint: planned.contractFingerprint,
        reason,
        evidenceRef
      }),
      200
    )
    assert.equal((await input.runRefunds({ ...config, localValidationEnabled: false })).completed, 0)
    assert.equal((await input.runRefunds(config)).completed, 1)
    assert.equal((await input.runRefunds(config)).completed, 0)
    refunds.push(planned)
  }
  input.scenario('native_refunds_partial_then_total_budget_and_durable_corrective_obligations')
  const financial = orderRefundsViewSchema.parse(await value(await get(`/api/orders/${input.orderId}/refunds`), 200))
  assert.equal(financial.confirmedCents, 0)
  assert.equal(financial.simulatedConfirmedCents, financial.capturedCents)
  assert.equal(financial.reservedCents, financial.capturedCents)
  input.scenario('native_corrective_document_governed_source_and_native_private_pdf')
  const issued = []
  for (const refund of refunds) {
    const queued = creditCommandReceiptSchema.parse(
      await value(
        await command(`/api/admin/refunds/${refund.id}/credit`, {
          idempotencyKey: randomUUID(),
          policyId: creditApproved.policy.id,
          reason,
          evidenceRef
        }),
        202
      )
    )
    const config = {
      now: now(),
      appEnvironment: 'local' as const,
      policyId: creditApproved.policy.id,
      enabled: true,
      localValidationEnabled: true
    }
    assert.equal((await input.runCredits({ ...config, enabled: false })).completed, 0)
    assert.equal((await input.runCredits(config)).completed, 1)
    assert.equal((await input.runCredits(config)).completed, 0)
    const view = creditViewSchema.parse(
      await value(await get(`/api/orders/${input.orderId}/credits/${queued.id}`), 200)
    )
    assert.equal(view.workflow, 'completed')
    assert.equal(view.validationOnly, true)
    assert.equal(view.pdfAvailable, true)
    const pdf = await get(`/api/orders/${input.orderId}/credits/${queued.id}/pdf`)
    assert.equal(pdf.status, 200)
    assert.match(pdf.headers.get('cache-control') ?? '', /private.*no-store/)
    assert.match(pdf.headers.get('content-type') ?? '', /^application\/pdf/)
    assert(new TextDecoder().decode(await pdf.arrayBuffer()).includes('SYNTHETIC LOCAL CREDIT'))
    assert.equal((await get(`/api/orders/${input.orderId}/credits/${queued.id}/pdf`, '')).status, 401)
    issued.push(queued)
  }
  input.scenario('native_refund_and_credit_email_opt_ins_manifest_and_synthetic_wording')
  const events = (
    await db
      .prepare(
        "SELECT e.id FROM email_outbox_events e JOIN refund_contracts r ON (r.id=e.source_id OR r.id=(SELECT refund_id FROM fiscal_credit_contracts WHERE id=e.source_id)) WHERE r.order_id=?1 AND e.event_type IN('refund.succeeded.email','invoice.issued')"
      )
      .bind(input.orderId)
      .all<{ id: string }>()
  ).results
  assert.equal(events.length, 4)
  for (const event of events) await input.deliverEmailTransport(event.id)
  const emails = {
    enabled: true,
    from: 'synthetic-financial@example.test',
    now: now(),
    appEnvironment: 'local' as const,
    rendererValidationEnabled: true
  }
  const count = input.sentMessages().length
  await input.runEmails(emails)
  assert.equal(input.sentMessages().length, count)
  assert((await input.runEmails({ ...emails, rendererOptIns: ['refund.succeeded.v1', 'invoice.credit.v1'] })).sent >= 4)
  const messages = input.sentMessages().slice(count)
  assert.equal(messages.filter((message) => message.subject.includes('Reembolso sintético')).length, 2)
  assert.equal(messages.filter((message) => message.subject.includes('Rectificativa sintética')).length, 2)
  for (const message of messages) {
    assert(!message.text.includes('fiscal/'))
    assert(!message.text.includes('token='))
    assert(!message.html.includes('href='))
  }
  assert.equal(canonicalJson(await db.batch(unchangedQueries.map((sql) => db.prepare(sql)))), before)
  return {
    scenarios: 4,
    externalAcceptance: false,
    inventoryUnchanged: true,
    captureUnchanged: true,
    originalInvoiceUnchanged: true
  }
}
