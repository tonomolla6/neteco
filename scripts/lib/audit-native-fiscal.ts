import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dispatchFiscalIssuance, fiscalMappingFingerprint } from '../../workers/fiscal/issuance'
import { PersistentLocalFiscalProvider } from '../../workers/fiscal/local-provider'
import { createFiscalPdfStorage } from '../../workers/runtime/fiscal-pdf-storage'
import type { FiscalOrderView, FiscalPolicy } from '../../shared/fiscal-issuance'

/** Local synthetic invoices exercise D1/R2 and private HTTP, never Beply.
 * A synthetic receipt cannot satisfy provider or legal acceptance. */
export async function auditNativeFiscal(input: {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  bucket: R2Bucket
  origin: string
  adminCookie: string
  guestCookie: string
  outsiderCookie: string
  orderId: string
  scenario: (name: string) => void
}): Promise<{ scenarios: number }> {
  const { dispatch, database, bucket, origin, orderId, scenario } = input
  assert.equal(new URL(origin).hostname, 'shop-audit.neteco.test')
  const request = (path: string, cookie?: string, body?: unknown) =>
    dispatch(
      new Request(`${origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'cf-connecting-ip': '192.0.2.123',
          ...(cookie ? { cookie } : {}),
          ...(body ? { origin, 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      })
    )
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const eventId = `invoice-evaluation:${orderId}`
  scenario('real_native_explicit_synthetic_fiscal_policy_and_paid_intent')
  assert.equal(
    (
      await database
        .prepare('SELECT status FROM fiscal_outbox_delivery WHERE event_id=?')
        .bind(eventId)
        .first<{ status: string }>()
    )?.status,
    'blocked_policy'
  )
  const mappings = {
    companyId: 'SYNTHETIC-LOCAL-ONLY',
    taxes: { '0': 'LOCAL-ZERO', '1000': 'LOCAL-REDUCED', '2100': 'LOCAL-GENERAL' },
    paymentCode: 'LOCAL-CARD'
  }
  const approved = await request('/api/admin/fiscal/policies', input.adminCookie, {
    idempotencyKey: randomUUID(),
    environment: 'local_validation',
    provider: 'local_fake',
    series: 'LOCAL',
    trigger: 'after_payment_capture',
    mappings,
    evidenceRef: 'synthetic-runtime-only-not-beply-acceptance',
    reason: 'Explicit synthetic local protocol validation, not a commercial policy'
  })
  assert.equal(approved.status, 201)
  const { policy } = (await approved.json()) as { policy: FiscalPolicy }
  // Approving a policy alone must not authorize or emit any invoice.
  assert.equal(
    (await database.prepare('SELECT COUNT(*) AS n FROM fiscal_invoice_intents').first<{ n: number }>())?.n,
    0
  )
  const command = { eventId, policyId: policy.id, idempotencyKey: randomUUID() }
  const queued = await request('/api/admin/fiscal/requests', input.adminCookie, command)
  assert.equal(queued.status, 202)
  const intent = (await queued.json()) as { intentId: string }
  assert.match(intent.intentId, /^[0-9a-f-]{36}$/)
  assert.equal((await request('/api/admin/fiscal/requests', input.adminCookie, command)).status, 202)
  const provider = new PersistentLocalFiscalProvider(database, await fiscalMappingFingerprint(mappings))
  const storage = createFiscalPdfStorage(bucket)
  const disabled = await dispatchFiscalIssuance(database, provider, storage, { now: now(), appEnvironment: 'local' })
  assert.equal(disabled.disabled, true)
  assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM fiscal_fake_invoices').first<{ n: number }>())?.n, 0)

  scenario('real_d1_r2_synthetic_invoice_and_durable_obligation_exactly_once')
  const report = await dispatchFiscalIssuance(database, provider, storage, {
    now: now(),
    appEnvironment: 'local',
    allowProviderIssuance: true
  })
  assert.equal(report.completed, 1)
  assert.equal(report.uncertain, 0)
  assert.equal(
    (
      await dispatchFiscalIssuance(database, provider, storage, {
        now: now(),
        appEnvironment: 'local',
        allowProviderIssuance: true
      })
    ).completed,
    0
  )
  for (const table of ['fiscal_fake_invoices', 'fiscal_provider_receipts', 'fiscal_documents'])
    assert.equal((await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n, 1)
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id=? AND event_type='invoice.issued'")
        .bind(orderId)
        .first<{ n: number }>()
    )?.n,
    1
  )
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS n FROM email_outbox_events WHERE source_id=? AND event_type='invoice.issued'")
        .bind(intent.intentId)
        .first<{ n: number }>()
    )?.n,
    1
  )

  scenario('real_native_private_fiscal_pdf_owner_and_unauthorized_isolation')
  const adminView = await request(`/api/admin/orders/${orderId}/fiscal`, input.adminCookie)
  assert.equal(adminView.status, 200)
  const view = (await adminView.json()) as FiscalOrderView
  assert.equal(view.status, 'completed')
  assert.equal(view.validationOnly, true)
  assert.equal(view.pdfAvailable, true)
  const pdf = await request(`/api/orders/${orderId}/invoice`, input.guestCookie)
  assert.equal(pdf.status, 200)
  assert.equal(pdf.headers.get('content-type'), 'application/pdf')
  assert.match(pdf.headers.get('cache-control') ?? '', /private.*no-store/)
  assert.match(pdf.headers.get('x-robots-tag') ?? '', /noindex/)
  assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await pdf.text(), /SYNTHETIC LOCAL VALIDATION ONLY/)
  assert.equal((await request(`/api/orders/${orderId}/invoice`)).status, 401)
  assert.equal((await request(`/api/orders/${orderId}/invoice`, input.outsiderCookie)).status, 404)
  const document = await database
    .prepare('SELECT storage_key FROM fiscal_documents WHERE intent_id=?')
    .bind(intent.intentId)
    .first<{ storage_key: string }>()
  assert(document)
  assert.equal((await request(`/media/${document.storage_key}`)).status, 404)
  return { scenarios: 3 }
}
