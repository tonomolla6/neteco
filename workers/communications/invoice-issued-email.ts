import { z } from 'zod'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import {
  fiscalContractSchema,
  fiscalHash,
  fiscalInstant,
  fiscalReceiptSchema,
  fiscalUuid,
  type FiscalReceipt
} from '../../shared/fiscal-issuance'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { readFiscalPolicy, validateFiscalContract } from '../fiscal/issuance'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailSender } from './transactional-email-delivery'

export const INVOICE_EMAIL_RENDERER_V1 = 'invoice.issued.v1'
type EmailMessage = Parameters<TransactionalEmailSender['send']>[0]
export interface InvoiceEmailContext {
  appEnvironment: 'local' | 'preview' | 'production'
  validationEnabled?: boolean
}
export interface PreparedInvoiceEmail {
  message: EmailMessage
  rendererVersion: typeof INVOICE_EMAIL_RENDERER_V1
  sourceHash: string
  messageHash: string
  proof: {
    intentId: string
    contractHash: string
    orderEventId: string
    payload: string
    providerId: string
    code: string
    fiscalStatus: FiscalReceipt['status']
    checksum: string
    size: number
    completedAt: string
  }
}
const sourceSql = `SELECT email.source_event_id,email.source_kind,email.source_id,email.schema_version,
  e.order_id,e.payload_json,i.contract_json,i.contract_fingerprint,i.policy_id,i.provider,i.validation_only,i.amount_gross_cents,i.currency,
  r.provider_invoice_id,r.code,r.fiscal_status,r.amount_gross_cents AS receipt_amount,r.currency AS receipt_currency,r.contract_fingerprint AS receipt_hash,
  d.storage_key,d.pdf_checksum,d.pdf_size,d.created_at AS document_created,w.completed_at,
  EXISTS(SELECT 1 FROM fiscal_issuance_events completed WHERE completed.intent_id=i.id
    AND completed.event_type IN('completed','reconciled') AND completed.generation=w.generation
    AND completed.created_at=w.completed_at) AS completion_confirmed
 FROM email_outbox_events email JOIN fiscal_invoice_intents i ON i.id=email.source_id
 JOIN fiscal_provider_receipts r ON r.intent_id=i.id AND r.provider=i.provider
 JOIN fiscal_documents d ON d.intent_id=i.id AND d.order_id=i.order_id AND d.id=i.id
 JOIN fiscal_issuance_work w ON w.intent_id=i.id AND w.status='completed'
 JOIN order_events e ON e.id=email.source_event_id AND e.order_id=i.order_id AND e.event_type='invoice.issued' AND e.correlation_id=i.id
 WHERE email.id=?1 AND email.event_type='invoice.issued'`
const sourceSchema = z
  .object({
    source_event_id: fiscalUuid,
    source_kind: z.literal('invoice'),
    source_id: fiscalUuid,
    schema_version: z.literal(1),
    order_id: fiscalUuid,
    payload_json: z.string().max(16384),
    contract_json: z.string().max(131072),
    contract_fingerprint: fiscalHash,
    policy_id: fiscalUuid,
    provider: z.enum(['local_fake', 'beply']),
    validation_only: z.union([z.literal(0), z.literal(1)]),
    amount_gross_cents: z.number().int().min(1).max(1_000_000_000),
    currency: z.literal('EUR'),
    provider_invoice_id: fiscalReceiptSchema.shape.providerId,
    code: fiscalReceiptSchema.shape.code,
    fiscal_status: fiscalReceiptSchema.shape.status,
    receipt_amount: z.number().int().min(1).max(1_000_000_000),
    receipt_currency: z.literal('EUR'),
    receipt_hash: fiscalHash,
    storage_key: z.string().max(300),
    pdf_checksum: fiscalHash,
    pdf_size: z.number().int().min(16).max(5242880),
    document_created: fiscalInstant,
    completed_at: fiscalInstant,
    completion_confirmed: z.literal(1)
  })
  .strict()
function plain(value: string) {
  return Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character
  ).join('')
}
function euros(value: number) {
  return `${Math.floor(value / 100)},${String(value % 100).padStart(2, '0')} €`
}
/** Retain this implementation unchanged for durable v1 reconstruction. A later
 * renderer gets a new registry version, never replaces v1 silently. No link,
 * bearer token, private object key or guest-expiry promise is rendered. */
export function renderInvoiceIssuedEmailV1(input: {
  orderId: string
  name: string
  code: string
  fiscalStatus: FiscalReceipt['status']
  validationOnly: boolean
  lines: { description: string; sku: string; quantity: number; grossCents: number }[]
  shippingGrossCents: number
  totalGrossCents: number
}): Pick<EmailMessage, 'subject' | 'html' | 'text'> {
  const title = input.validationOnly
    ? `Validación sintética local — no es una factura fiscal (estado simulado: ${input.fiscalStatus === 'issued' ? 'emitido' : 'pendiente fiscal'})`
    : input.fiscalStatus === 'issued'
      ? 'Factura emitida'
      : 'Documento con estado fiscal pendiente'
  const state = input.validationOnly
    ? 'Este documento es una prueba sintética local. No acredita emisión fiscal, pago ni entrega.'
    : input.fiscalStatus === 'issued'
      ? 'El proveedor ha registrado tu factura como emitida. Este aviso no acredita pago ni entrega.'
      : 'El proveedor ha registrado el documento con estado fiscal pendiente. No se confirma la emisión fiscal, el pago ni la entrega.'
  const rows = input.lines.map(
    (line) => `${plain(line.description)} (${plain(line.sku)}) — ${line.quantity} ud. — ${euros(line.grossCents)}`
  )
  const reference = `Pedido: ${input.orderId}\nDocumento: ${plain(input.code)}`
  const access =
    'El PDF permanece privado. Consulta tu pedido con tu acceso vigente o contacta con NETECO; este correo no concede acceso adicional.'
  return {
    subject: `NETECO: ${title} ${plain(input.code)}`,
    text: `Hola ${plain(input.name)},\n\n${title}\n${state}\n${reference}\n\n${rows.join('\n')}\nEnvío: ${euros(input.shippingGrossCents)}\nTotal (IVA incluido): ${euros(input.totalGrossCents)}\n\n${access}`,
    html: `<!doctype html><html lang="es"><body><p>Hola ${escapeEmailHtml(plain(input.name))},</p><h1>${escapeEmailHtml(title)}</h1><p>${escapeEmailHtml(state)}</p><p>Pedido: ${escapeEmailHtml(input.orderId)}<br>Documento: ${escapeEmailHtml(plain(input.code))}</p><ul>${rows.map((row) => `<li>${escapeEmailHtml(row)}</li>`).join('')}</ul><p>Envío: ${euros(input.shippingGrossCents)}</p><p>Total (IVA incluido): ${euros(input.totalGrossCents)}</p><p>${escapeEmailHtml(access)}</p></body></html>`
  }
}
const rendererRegistry = new Map([[INVOICE_EMAIL_RENDERER_V1, renderInvoiceIssuedEmailV1]])
export async function prepareInvoiceIssuedEmail(
  database: D1Database,
  eventId: string,
  from: string,
  context: InvoiceEmailContext
): Promise<
  { invoicePreparation: PreparedInvoiceEmail; message: EmailMessage } | { error: 'invalid_source' | 'source_not_found' }
> {
  database = guardedFiscalDatabase(database)
  const manifest = await database
    .prepare('SELECT renderer_version,source_hash,message_hash FROM transactional_email_preparations WHERE event_id=?1')
    .bind(eventId)
    .first()
  let renderer = rendererRegistry.get(INVOICE_EMAIL_RENDERER_V1)
  if (manifest) {
    const saved = z
      .object({ renderer_version: z.string(), source_hash: fiscalHash, message_hash: fiscalHash })
      .strict()
      .safeParse(manifest)
    if (!saved.success || !(renderer = rendererRegistry.get(saved.data.renderer_version)))
      return { error: 'invalid_source' }
  }
  const raw = await database.prepare(sourceSql).bind(eventId).first()
  if (!raw) return { error: 'source_not_found' }
  const parsed = sourceSchema.safeParse(raw)
  if (!parsed.success) return { error: 'invalid_source' }
  const row = parsed.data
  // Operational D1 read failures remain preparation failures with backoff;
  // they are not converted into missing/invalid fiscal evidence.
  const policy = await readFiscalPolicy(database, row.policy_id, false)
  if (!policy) return { error: 'invalid_source' }
  try {
    const contract = fiscalContractSchema.parse(catalogPolicyOwnJson(JSON.parse(row.contract_json)))
    const payload = z
      .object({
        invoiceId: fiscalUuid,
        provider: z.enum(['local_fake', 'beply']),
        code: fiscalReceiptSchema.shape.code,
        validationOnly: z.boolean()
      })
      .strict()
      .parse(catalogPolicyOwnJson(JSON.parse(row.payload_json)))
    validateFiscalContract(contract, policy)
    if (
      (await sha256Hex(canonicalJson(contract))) !== row.contract_fingerprint ||
      row.receipt_hash !== row.contract_fingerprint ||
      row.receipt_amount !== contract.totalGrossCents ||
      row.amount_gross_cents !== contract.totalGrossCents ||
      contract.orderId !== row.order_id ||
      contract.provider !== row.provider ||
      contract.validationOnly !== Boolean(row.validation_only) ||
      contract.policyId !== row.policy_id ||
      payload.invoiceId !== row.source_id ||
      payload.provider !== row.provider ||
      payload.code !== row.code ||
      payload.validationOnly !== contract.validationOnly ||
      row.storage_key !== `fiscal/${row.source_id}/${row.pdf_checksum}.pdf` ||
      row.completed_at !== row.document_created
    )
      return { error: 'invalid_source' }
    if (
      contract.validationOnly
        ? context.appEnvironment !== 'local' || context.validationEnabled !== true
        : contract.environment !== (context.appEnvironment === 'production' ? 'production' : 'sandbox') ||
          context.appEnvironment === 'local'
    )
      return { error: 'invalid_source' }
    const message = {
      to: contract.customer.email,
      from,
      ...renderer!({
        orderId: contract.orderId,
        name: contract.customer.legalName,
        code: row.code,
        fiscalStatus: row.fiscal_status,
        validationOnly: contract.validationOnly,
        lines: contract.lines,
        shippingGrossCents: contract.shippingGrossCents,
        totalGrossCents: contract.totalGrossCents
      })
    }
    if (
      new TextEncoder().encode(message.subject).byteLength > 1024 ||
      new TextEncoder().encode(message.text).byteLength > 512 * 1024 ||
      new TextEncoder().encode(message.html).byteLength > 1024 * 1024
    )
      return { error: 'invalid_source' }
    const sourceHash = await sha256Hex(canonicalJson(row)),
      messageHash = await sha256Hex(canonicalJson(message))
    if (manifest && (manifest.source_hash !== sourceHash || manifest.message_hash !== messageHash))
      return { error: 'invalid_source' }
    return {
      message,
      invoicePreparation: {
        message,
        rendererVersion: INVOICE_EMAIL_RENDERER_V1,
        sourceHash,
        messageHash,
        proof: {
          intentId: row.source_id,
          contractHash: row.contract_fingerprint,
          orderEventId: row.source_event_id,
          payload: row.payload_json,
          providerId: row.provider_invoice_id,
          code: row.code,
          fiscalStatus: row.fiscal_status,
          checksum: row.pdf_checksum,
          size: row.pdf_size,
          completedAt: row.completed_at
        }
      }
    }
  } catch {
    return { error: 'invalid_source' }
  }
}
/** Manifest+marker+proof guard commit as one batch; no sender sees a message
 * unless this exact version/source/content and current completed facts match. */
export function invoiceEmailSendingStatements(
  database: D1Database,
  eventId: string,
  token: string,
  now: string,
  until: string,
  prepared: PreparedInvoiceEmail
): D1PreparedStatement[] {
  const p = prepared.proof
  const params = [
    eventId,
    token,
    now,
    until,
    prepared.rendererVersion,
    prepared.sourceHash,
    prepared.messageHash,
    p.intentId,
    p.contractHash,
    p.orderEventId,
    p.payload,
    p.providerId,
    p.code,
    p.fiscalStatus,
    p.checksum,
    p.size,
    p.completedAt
  ]
  const proof = `EXISTS(SELECT 1 FROM email_outbox_events email JOIN fiscal_invoice_intents i ON i.id=email.source_id
    JOIN fiscal_provider_receipts r ON r.intent_id=i.id JOIN fiscal_documents d ON d.intent_id=i.id
    JOIN fiscal_issuance_work w ON w.intent_id=i.id JOIN order_events e ON e.id=email.source_event_id
    WHERE email.id=?1 AND email.event_type='invoice.issued' AND email.source_kind='invoice' AND email.schema_version=1
    AND i.id=?8 AND i.contract_fingerprint=?9 AND r.contract_fingerprint=?9 AND r.provider=i.provider AND r.amount_gross_cents=i.amount_gross_cents AND r.currency=i.currency
    AND e.id=?10 AND e.order_id=i.order_id AND e.event_type='invoice.issued' AND e.payload_json=?11 AND e.correlation_id=i.id
    AND r.provider_invoice_id=?12 AND r.code=?13 AND r.fiscal_status=?14 AND d.id=i.id AND d.order_id=i.order_id
    AND d.pdf_checksum=?15 AND d.pdf_size=?16 AND d.storage_key='fiscal/'||i.id||'/'||?15||'.pdf'
    AND w.status='completed' AND w.completed_at=?17 AND d.created_at=?17
    AND EXISTS(SELECT 1 FROM fiscal_issuance_events completed WHERE completed.intent_id=i.id
      AND completed.event_type IN('completed','reconciled') AND completed.generation=w.generation AND completed.created_at=?17))`
  // The runtime clock, not the caller's frozen scheduled instant, fences a
  // preparation that expires during an awaited read/hash. Test adapters replace
  // SQLite 'now' explicitly; HTTP/scheduled production SQL never does.
  const lease =
    "event_id=?1 AND status='leased' AND lease_token=?2 AND lease_until>?3 AND lease_until>strftime('%Y-%m-%dT%H:%M:%SZ','now')"
  const manifest =
    'EXISTS(SELECT 1 FROM transactional_email_preparations m WHERE m.event_id=?1 AND m.renderer_version=?5 AND m.source_hash=?6 AND m.message_hash=?7)'
  return [
    database
      .prepare(
        `INSERT INTO transactional_email_preparations(event_id,renderer_version,source_hash,message_hash,prepared_at)
      SELECT ?1,?5,?6,?7,?3 WHERE EXISTS(SELECT 1 FROM transactional_email_deliveries WHERE ${lease}) AND ${proof}
      AND NOT EXISTS(SELECT 1 FROM transactional_email_preparations WHERE event_id=?1)
      ON CONFLICT(event_id) DO NOTHING`
      )
      .bind(...params),
    database
      .prepare(
        `UPDATE transactional_email_deliveries SET status='sending',sending_at=?3,lease_until=?4,last_error_code=NULL
      WHERE ${lease} AND ${manifest} AND ${proof} RETURNING event_id`
      )
      .bind(...params),
    database
      .prepare(
        `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT(
      EXISTS(SELECT 1 FROM transactional_email_deliveries WHERE event_id=?1 AND status='sending' AND lease_token=?2 AND lease_until=?4)
      AND ${manifest} AND ${proof})`
      )
      .bind(...params)
  ]
}
