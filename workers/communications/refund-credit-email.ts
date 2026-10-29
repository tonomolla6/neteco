import { z } from 'zod'
import { fiscalUuid, fiscalHash } from '../../shared/fiscal-issuance'
import { refundContractSchema, refundReceiptSchema } from '../../shared/order-refunds'
import { creditContractSchema, creditReceiptSchema } from '../../shared/fiscal-credit'
import { checked, hash, parsedJson, guard } from '../refunds/authority'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailRenderer, PreparedTransactionalEmail } from './transactional-email-renderers'

export const REFUND_EMAIL_RENDERER_V1 = 'refund.succeeded.v1'
export const CREDIT_EMAIL_RENDERER_V1 = 'invoice.credit.v1'
const commonSchema = z
  .object({
    source_id: fiscalUuid,
    source_event_id: fiscalUuid,
    order_id: fiscalUuid,
    contract_json: z.string().max(262144),
    contract_fingerprint: fiscalHash,
    receipt_json: z.string().max(16384),
    payload_json: z.string().max(16384),
    generation: z.number().int().min(1),
    completed_at: z.string(),
    checksum: fiscalHash.nullable(),
    size: z.number().int().nullable()
  })
  .strict()
function sourceSql(credit: boolean) {
  return credit
    ? `SELECT e.source_id,e.source_event_id,c.order_id,c.contract_json,c.contract_fingerprint,r.receipt_json,event.payload_json,w.generation,w.completed_at,d.pdf_checksum AS checksum,d.pdf_size AS size
   FROM email_outbox_events e JOIN fiscal_credit_contracts c ON c.id=e.source_id JOIN fiscal_credit_work w ON w.credit_id=c.id AND w.status='completed'
   JOIN fiscal_credit_receipts r ON r.credit_id=c.id JOIN fiscal_credit_documents d ON d.credit_id=c.id AND d.created_at=w.completed_at AND d.storage_key='fiscal/'||c.id||'/'||d.pdf_checksum||'.pdf'
   JOIN order_events event ON event.id=e.source_event_id AND event.order_id=c.order_id AND event.correlation_id=c.id AND event.event_type='invoice.issued'
   WHERE e.id=?1 AND e.event_type='invoice.issued' AND e.source_kind='invoice' AND e.schema_version=1`
    : `SELECT e.source_id,e.source_event_id,c.order_id,c.contract_json,c.contract_fingerprint,r.receipt_json,event.payload_json,w.generation,w.completed_at,NULL AS checksum,NULL AS size
   FROM email_outbox_events e JOIN refund_contracts c ON c.id=e.source_id JOIN refund_work w ON w.refund_id=c.id AND w.status='completed'
   JOIN refund_receipts r ON r.refund_id=c.id AND r.status='succeeded' JOIN refund_credit_obligations obligation ON obligation.refund_id=c.id AND obligation.source_event_id=e.source_event_id
   JOIN order_events event ON event.id=e.source_event_id AND event.order_id=c.order_id AND event.correlation_id=c.id AND event.event_type='refund.succeeded'
   WHERE e.id=?1 AND e.event_type='refund.succeeded.email' AND e.source_kind='refund' AND e.schema_version=1`
}
const plain = (value: string) =>
  Array.from(value, (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)).join('')
const euros = (cents: number) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')} €`
function registration(credit: boolean): TransactionalEmailRenderer {
  const version = credit ? CREDIT_EMAIL_RENDERER_V1 : REFUND_EMAIL_RENDERER_V1
  return {
    key: version,
    version,
    eventType: credit ? 'invoice.issued' : 'refund.succeeded.email',
    sourceKind: credit ? 'invoice' : 'refund',
    sourcePredicate: credit
      ? 'EXISTS(SELECT 1 FROM fiscal_credit_contracts credit WHERE credit.id=e.source_id)'
      : 'EXISTS(SELECT 1 FROM refund_contracts refund WHERE refund.id=e.source_id)',
    async prepare(database, eventId, from, context) {
      const raw = await database.prepare(sourceSql(credit)).bind(eventId).first()
      if (raw === null) return { error: 'source_not_found' }
      try {
        const row = checked(commonSchema, raw, 'read_unconfirmed'),
          contract = credit
            ? checked(creditContractSchema, parsedJson(row.contract_json))
            : checked(refundContractSchema, parsedJson(row.contract_json))
        if ((await hash(contract)) !== row.contract_fingerprint || contract.orderId !== row.order_id)
          return { error: 'invalid_source' }
        if (
          contract.validationOnly
            ? context.appEnvironment !== 'local' || context.validationEnabled !== true
            : context.appEnvironment === 'local' ||
              contract.environment !== (context.appEnvironment === 'production' ? 'production' : 'sandbox')
        )
          return { error: 'invalid_source' }
        let title: string, name: string, email: string, reference: string
        if (credit && 'creditId' in contract) {
          const receipt = checked(creditReceiptSchema, parsedJson(row.receipt_json)),
            payload = checked(
              z
                .object({
                  invoiceId: fiscalUuid,
                  documentKind: z.literal('credit_note'),
                  refundId: fiscalUuid,
                  sourceInvoiceId: fiscalUuid,
                  provider: z.enum(['local_fake', 'beply']),
                  code: z.string(),
                  validationOnly: z.boolean()
                })
                .strict(),
              parsedJson(row.payload_json)
            )
          if (
            receipt.contractFingerprint !== row.contract_fingerprint ||
            receipt.amountCents !== contract.amountCents ||
            receipt.sourceProviderInvoiceId !== contract.sourceProviderInvoiceId ||
            receipt.validationOnly !== contract.validationOnly ||
            payload.invoiceId !== row.source_id ||
            payload.refundId !== contract.refundId ||
            payload.sourceInvoiceId !== contract.sourceInvoiceId ||
            payload.code !== receipt.code ||
            payload.provider !== contract.provider ||
            payload.validationOnly !== contract.validationOnly ||
            row.checksum === null ||
            row.size === null
          )
            return { error: 'invalid_source' }
          title = contract.validationOnly
            ? `Rectificativa sintética local — no acredita emisión fiscal (estado simulado: ${receipt.status === 'issued' ? 'emitido' : 'pendiente fiscal'})`
            : receipt.status === 'issued'
              ? 'Factura rectificativa registrada como emitida'
              : 'Documento rectificativo con estado fiscal pendiente'
          name = contract.sourceContract.customer.legalName
          email = contract.sourceContract.customer.email
          reference = `Rectificativa: ${plain(receipt.code)}\nFactura original: ${contract.sourceInvoiceId}`
        } else if ('refundId' in contract && 'capture' in contract) {
          const receipt = checked(refundReceiptSchema, parsedJson(row.receipt_json)),
            payload = checked(
              z
                .object({
                  refundId: fiscalUuid,
                  returnId: fiscalUuid,
                  amountCents: z.number().int(),
                  validationOnly: z.boolean()
                })
                .strict(),
              parsedJson(row.payload_json)
            )
          if (
            receipt.status !== 'succeeded' ||
            receipt.contractFingerprint !== row.contract_fingerprint ||
            receipt.amountCents !== contract.amountCents ||
            receipt.merchantOrder !== contract.capture.merchantOrder ||
            receipt.validationOnly !== contract.validationOnly ||
            payload.refundId !== row.source_id ||
            payload.returnId !== contract.returnId ||
            payload.amountCents !== contract.amountCents ||
            payload.validationOnly !== contract.validationOnly
          )
            return { error: 'invalid_source' }
          title = contract.validationOnly
            ? 'Reembolso sintético local — no se ha devuelto dinero'
            : 'Reembolso confirmado por el proveedor'
          name = contract.contact.name
          email = contract.contact.email
          reference = `Reembolso: ${contract.refundId}\nDevolución: ${contract.returnPublicRef}`
        } else return { error: 'invalid_source' }
        const rows = contract.components.map(
            (line) =>
              `${plain(line.description)} (${plain(line.sku)}) — ${line.quantity} ud. — ${euros(line.grossCents)}`
          ),
          access =
            'Los documentos permanecen privados. Consulta tu pedido con tu acceso vigente o contacta con NETECO. Este correo no concede acceso ni modifica la custodia o las existencias.'
        const message = {
          to: email,
          from,
          subject: `NETECO: ${title}`,
          text: `Hola ${plain(name)},\n\n${title}\nPedido: ${contract.orderId}\n${reference}\n\n${rows.join('\n')}\nImporte: ${euros(contract.amountCents)}\n\n${access}`,
          html: `<!doctype html><html lang="es"><body><p>Hola ${escapeEmailHtml(plain(name))},</p><h1>${escapeEmailHtml(title)}</h1><p>Pedido: ${contract.orderId}</p><p>${escapeEmailHtml(reference)}</p><ul>${rows.map((value) => `<li>${escapeEmailHtml(value)}</li>`).join('')}</ul><p>Importe: ${euros(contract.amountCents)}</p><p>${escapeEmailHtml(access)}</p></body></html>`
        }
        return {
          message,
          rendererVersion: version,
          sourceHash: await hash(row),
          messageHash: await hash(message),
          proof: { row }
        } satisfies PreparedTransactionalEmail
      } catch {
        return { error: 'invalid_source' }
      }
    },
    authorityStatements(database, lease, prepared) {
      const row = checked(commonSchema, prepared.proof.row, 'read_unconfirmed'),
        fields = Object.keys(row) as (keyof typeof row)[]
      // The source query is fixed by renderer version; all compared values come
      // from its validated historical evidence, not SQL supplied by a caller.
      const sql = `EXISTS(SELECT 1 FROM (${sourceSql(credit)}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 2}`).join(' AND ')})`
      return [guard(database, sql, [lease.eventId, ...fields.map((field) => row[field])])]
    }
  }
}
/** Preserved v1 implementation. A future renderer requires a distinct key and
 * opt-in; manifest drift cannot silently change a prepared or uncertain email. */
export const refundSucceededEmailRenderer = registration(false)
export const creditIssuedEmailRenderer = registration(true)
