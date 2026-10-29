import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from './email-outbox'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailRenderer } from './transactional-email-renderers'

const version = 'order.payment.confirmed.v1'
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const proof = `p.status='captured' AND p.currency='EUR' AND p.amount_gross_cents=o.total_gross_cents AND o.status<>'cancelled'
 AND EXISTS(SELECT 1 FROM order_payment_states s WHERE s.order_id=o.id AND s.active_intent_id=p.id AND s.status='paid' AND s.paid_gross_cents=p.amount_gross_cents AND s.response_code=p.response_code AND s.provider_reference IS p.provider_reference)
 AND EXISTS(SELECT 1 FROM payment_fulfilment_claims claim WHERE claim.order_id=o.id AND claim.payment_intent_id=p.id)
 AND EXISTS(SELECT 1 FROM inventory_reservations r WHERE r.id=o.reservation_id AND r.status='assigned')
 AND EXISTS(SELECT 1 FROM order_events a WHERE a.id='order-event:'||c.provider_event_id AND a.order_id=o.id AND a.event_type='payment_captured' AND a.created_at=c.created_at AND a.correlation_id=c.correlation_id
 AND json_extract(a.payload_json,'$.amountGrossCents')=p.amount_gross_cents AND json_extract(a.payload_json,'$.intentId')=p.id AND json_extract(a.payload_json,'$.provider')='redsys')`
const capturedJoin = `FROM payment_intents p JOIN orders o ON o.id=p.order_id JOIN payment_events c ON c.payment_intent_id=p.id AND c.order_id=o.id AND c.event_type='captured' AND c.provider_event_id='intent:'||p.id||':local:captured' AND c.response_code=p.response_code AND c.provider_reference IS p.provider_reference`
const authorizationSql = `SELECT a.payload_json FROM order_events a JOIN payment_events verified ON a.id='order-event:'||verified.provider_event_id||':authorised'
 AND verified.payment_intent_id=p.id AND verified.order_id=o.id AND verified.event_type='provider_authorised'
 AND verified.correlation_id=a.correlation_id AND verified.created_at=a.created_at
 WHERE a.order_id=o.id AND a.event_type='payment_provider_authorised' AND json_extract(a.payload_json,'$.intentId')=p.id
 AND json_extract(a.payload_json,'$.captureSource.payloadHash')=verified.payload_hash
 AND json_extract(a.payload_json,'$.captureSource.verifiedAt')=verified.created_at
 AND json_extract(a.payload_json,'$.responseCode')=verified.response_code
 AND json_type(a.payload_json,'$.captureSource')='object' ORDER BY a.created_at,a.id LIMIT 1`
const sourceSql = `SELECT p.id intent_id,o.id order_id,p.amount_gross_cents amount,p.currency,c.id capture_id,c.payload_hash,c.response_code,c.provider_reference,c.correlation_id,c.created_at,o.contact_email,o.contact_name,(${authorizationSql}) authorization_json,
 (SELECT payload_json FROM order_events a WHERE a.id='order-event:'||c.provider_event_id AND a.order_id=o.id AND a.event_type='payment_captured') capture_json
 ${capturedJoin} JOIN email_outbox_events e ON e.source_event_id=p.id AND e.source_id=o.id AND e.event_type='order.confirmed' AND e.source_kind='order' AND e.schema_version=1 AND e.created_at=c.created_at
 WHERE e.id=?1 AND ${proof}`
const rowSchema = z
  .object({
    intent_id: z.string().uuid(),
    order_id: z.string().uuid(),
    amount: z.number().int().positive(),
    currency: z.literal('EUR'),
    capture_id: z.string().max(200),
    payload_hash: hashSchema,
    response_code: z.string().regex(/^\d{4}$/),
    provider_reference: z.string().max(100).nullable(),
    correlation_id: z.string().min(1).max(200),
    created_at: catalogPolicyInstantSchema,
    contact_email: z
      .string()
      .email()
      .max(254)
      .refine((value) => !/[\s]/u.test(value)),
    contact_name: z.string().max(200).nullable(),
    authorization_json: z.string().nullable(),
    capture_json: z.string()
  })
  .strict()
const authorizationSchema = z
  .object({
    intentId: z.string().uuid(),
    responseCode: z.string().regex(/^\d{4}$/),
    captureSource: z
      .object({
        schemaVersion: z.literal(1),
        provider: z.literal('redsys'),
        bankEnvironment: z.enum(['sandbox', 'production']),
        payloadHash: hashSchema,
        signatureFingerprint: hashSchema,
        verifiedAt: catalogPolicyInstantSchema
      })
      .strict()
  })
  .strict()
const capturedSchema = z
  .object({ amountGrossCents: z.number().int().positive(), intentId: z.string().uuid(), provider: z.literal('redsys') })
  .strict()
const hash = (value: unknown) => sha256Hex(canonicalJson(value))
const plain = (value: string) =>
  [...value]
    .map((character) => (character.codePointAt(0)! < 32 || character.codePointAt(0) === 127 ? ' ' : character))
    .join('')
const renderer: TransactionalEmailRenderer = {
  key: version,
  version,
  eventType: 'order.confirmed',
  sourceKind: 'order',
  sourcePredicate: 'EXISTS(SELECT 1 FROM payment_intents p WHERE p.id=e.source_event_id AND p.order_id=e.source_id)',
  async prepare(database, eventId, from, context) {
    const raw = await database.prepare(sourceSql).bind(eventId).first()
    if (!raw) return { error: 'source_not_found' }
    try {
      const row = rowSchema.parse(raw),
        authorization = authorizationSchema.parse(JSON.parse(row.authorization_json ?? 'null')),
        captured = capturedSchema.parse(JSON.parse(row.capture_json))
      if (
        authorization.intentId !== row.intent_id ||
        captured.intentId !== row.intent_id ||
        captured.amountGrossCents !== row.amount ||
        authorization.captureSource.verifiedAt > row.created_at ||
        Number(row.response_code) >= 100 ||
        Number(authorization.responseCode) >= 100 ||
        (context.appEnvironment !== 'local' && authorization.captureSource.bankEnvironment === 'sandbox')
      )
        return { error: 'invalid_source' }
      const greeting = row.contact_name ? `Hola ${plain(row.contact_name)},` : 'Hola,',
        local = context.appEnvironment === 'local' || authorization.captureSource.bankEnvironment === 'sandbox',
        notice = `${local ? 'Validación local o sandbox, no acredita un cobro real. ' : ''}Este mensaje comunica una captura registrada internamente; no acredita una liquidación bancaria ni confirma el envío.`,
        amount = `${Math.floor(row.amount / 100)},${String(row.amount % 100).padStart(2, '0')} €`
      const message = {
        to: row.contact_email,
        from,
        subject: `NETECO: Captura registrada — ${row.order_id}`,
        text: `${greeting}\n\nCaptura registrada\nPedido: ${row.order_id}\nImporte registrado: ${amount}\nRegistro: ${row.created_at}\n\n${notice}`,
        html: `<!doctype html><html lang="es"><body><p>${escapeEmailHtml(greeting)}</p><h1>Captura registrada</h1><p>Pedido: ${row.order_id}</p><p>Importe registrado: ${amount}</p><p>Registro: ${row.created_at}</p><p>${notice}</p></body></html>`
      }
      return {
        message,
        rendererVersion: version,
        sourceHash: await hash(row),
        messageHash: await hash(message),
        proof: { row }
      }
    } catch {
      return { error: 'invalid_source' }
    }
  },
  authorityStatements(database, lease, prepared) {
    const row = rowSchema.parse(prepared.proof.row),
      fields = Object.keys(row) as (keyof typeof row)[]
    return [
      database
        .prepare(
          `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(SELECT 1 FROM (${sourceSql}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 2}`).join(' AND ')})`
        )
        .bind(lease.eventId, ...fields.map((field) => row[field]))
    ]
  }
}
export const orderPaymentEmailRenderers: readonly TransactionalEmailRenderer[] = [renderer]
export const prepareOrderPaymentEmail: TransactionalEmailRenderer['prepare'] = (...args) => renderer.prepare(...args)
export async function prepareOrderPaymentEnqueue(
  database: D1Database,
  input: { orderId: string; intentId: string; now: string }
) {
  const { eventId } = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: input.intentId,
    sourceKind: 'order',
    sourceId: input.orderId,
    eventType: 'order.confirmed',
    now: input.now
  })
  return database
    .prepare(
      `INSERT INTO email_outbox_events(id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
 SELECT ?1,p.id,'order.confirmed','order',o.id,1,c.created_at ${capturedJoin} WHERE p.id=?2 AND o.id=?3 AND ${proof} ON CONFLICT(source_event_id,event_type) DO NOTHING`
    )
    .bind(eventId, input.intentId, input.orderId)
}
