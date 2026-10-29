import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from './email-outbox'
import { escapeEmailHtml } from './order-created-email'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import type { TransactionalEmailRenderer, PreparedTransactionalEmail } from './transactional-email-renderers'
const states = ['picking', 'ready_for_pickup', 'in_transit', 'delivered'] as const
const titles = {
  picking: 'En preparación',
  ready_for_pickup: 'Listo para recoger',
  in_transit: 'Tránsito registrado',
  delivered: 'Entrega registrada',
  cancelled: 'Pedido cancelado'
} as const
const auditFields =
  'actor_id,order_id,location_id,action,input,expected_version,result_version,from_state,to_state,interrupted_state,reason,evidence,source_snapshot,response,created_at'.split(
    ','
  )
const auditProof = `EXISTS(SELECT 1 FROM order_fulfillment_audit a WHERE a.command_id=c.id AND ${auditFields.map((name) => `a.${name} IS c.${name}`).join(' AND ')})`
const fulfillmentProof = `c.to_state IN('picking','ready_for_pickup','in_transit','delivered') AND ${auditProof}
 AND EXISTS(SELECT 1 FROM order_fulfillments f WHERE f.order_id=c.order_id AND f.last_command_id=c.id AND f.version=c.result_version
 AND f.location_id=c.location_id AND f.status=c.to_state AND f.interrupted_state IS c.interrupted_state AND f.updated_at=c.created_at)`
const cancellationProof = `json_extract(c.response_body,'$.kind')='unpaid-order-cancellation'
 AND json_extract(c.response_body,'$.receipt.orderId')=c.order_id AND json_extract(c.response_body,'$.receipt.commandId')=c.command_id
 AND json_extract(c.response_body,'$.receipt.outcome')='cancelled' AND json_extract(c.response_body,'$.receipt.orderStatus')='cancelled'
 AND json_extract(c.response_body,'$.receipt.updatedAt')=c.created_at
 AND EXISTS(SELECT 1 FROM order_events event WHERE event.id='order-cancelled:'||c.order_id||':'||c.command_id
 AND event.order_id=c.order_id AND event.event_type='order.cancelled' AND event.correlation_id=c.command_id AND event.created_at=c.created_at
 AND json_extract(event.payload_json,'$.commandId')=c.command_id AND json_extract(event.payload_json,'$.payloadHash')=c.payload_hash
 AND json_extract(event.payload_json,'$.receipt')=json_extract(c.response_body,'$.receipt'))`
function sourceSql(cancelled: boolean) {
  return cancelled
    ? `SELECT e.source_event_id,c.order_id,c.command_id,0 version,'cancelled' state,c.payload_hash,c.response_body response_json,c.created_at,o.contact_email,o.contact_name,
 c.response_status,c.correlation_id,audited.payload_json audit_json,audited.created_at audit_at,audited.correlation_id audit_correlation
 FROM email_outbox_events e JOIN payment_commands c ON c.command_id=e.source_event_id AND c.order_id=e.source_id JOIN orders o ON o.id=c.order_id
 JOIN order_events audited ON audited.id='order-cancelled:'||c.order_id||':'||c.command_id AND audited.order_id=c.order_id AND audited.event_type='order.cancelled'
 WHERE e.id=?1 AND e.event_type='order.cancelled' AND e.source_kind='order' AND e.schema_version=1 AND e.created_at=c.created_at AND o.status='cancelled' AND ${cancellationProof}`
    : `SELECT e.source_event_id,c.order_id,c.id command_id,c.result_version version,c.to_state state,c.payload_hash,c.response response_json,c.created_at,o.contact_email,o.contact_name
 FROM email_outbox_events e JOIN order_fulfillment_commands c ON c.id=e.source_event_id AND c.order_id=e.source_id JOIN orders o ON o.id=c.order_id
 WHERE e.id=?1 AND e.event_type='order.status.updated' AND e.source_kind='order' AND e.schema_version=1 AND e.created_at=c.created_at AND o.status<>'cancelled' AND ${fulfillmentProof}`
}
const rowSchema = z
  .object({
    source_event_id: z.string().uuid(),
    order_id: z.string().uuid(),
    command_id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    state: z.enum([...states, 'cancelled']),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    response_json: z.string().max(16384),
    created_at: catalogPolicyInstantSchema,
    contact_email: z
      .string()
      .email()
      .max(254)
      .refine((value) => !/[\s]/u.test(value)),
    contact_name: z.string().max(200).nullable()
  })
  .strict()
const cancellationRowSchema = rowSchema.extend({
  response_status: z.literal(200),
  correlation_id: z.string().uuid(),
  audit_json: z.string().max(16384),
  audit_at: catalogPolicyInstantSchema,
  audit_correlation: z.string().uuid()
})
async function prepareCancelled(raw: unknown) {
  const row = cancellationRowSchema.parse(raw)
  // Defer until the producer's module has completed initialization. Reuse its
  // one receipt/audit/hash verifier without a top-level producer/renderer cycle.
  const { validateOrderCancellationProof } = await import('../catalog/order-cancellation')
  await validateOrderCancellationProof(
    {
      responseStatus: row.response_status,
      responseBody: row.response_json,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
      payloadHash: row.payload_hash,
      audit: row.audit_json,
      auditAt: row.audit_at,
      auditCorrelation: row.audit_correlation
    },
    row.order_id,
    row.command_id
  )
}
const hash = (value: unknown) => sha256Hex(canonicalJson(value))
const plain = (value: string) =>
  [...value]
    .map((character) => {
      const code = character.codePointAt(0)!
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
function registration(cancelled: boolean): TransactionalEmailRenderer {
  const version = cancelled ? 'order.operations.cancelled.v1' : 'order.operations.fulfillment.v1'
  return {
    key: version,
    version,
    eventType: cancelled ? 'order.cancelled' : 'order.status.updated',
    sourceKind: 'order',
    sourcePredicate: cancelled
      ? "EXISTS(SELECT 1 FROM payment_commands c WHERE c.order_id=e.source_id AND c.command_id=e.source_event_id AND json_extract(c.response_body,'$.kind')='unpaid-order-cancellation')"
      : 'EXISTS(SELECT 1 FROM order_fulfillment_commands c WHERE c.order_id=e.source_id AND c.id=e.source_event_id)',
    async prepare(database, eventId, from) {
      const raw = await database.prepare(sourceSql(cancelled)).bind(eventId).first()
      if (!raw) return { error: 'source_not_found' }
      try {
        const row = (cancelled ? cancellationRowSchema : rowSchema).parse(raw)
        if (row.source_event_id !== row.command_id || cancelled !== (row.state === 'cancelled'))
          return { error: 'invalid_source' }
        const response = JSON.parse(row.response_json) as Record<string, unknown>
        if (cancelled) {
          await prepareCancelled(row)
        } else if (
          response.source !== 'cloudflare' ||
          response.commandId !== row.command_id ||
          response.orderId !== row.order_id ||
          response.state !== row.state ||
          response.version !== row.version ||
          response.inventoryEffect !== 'none' ||
          response.updated !== true
        )
          return { error: 'invalid_source' }
        const title = titles[row.state],
          greeting = row.contact_name ? `Hola ${plain(row.contact_name)},` : 'Hola,',
          notice = cancelled
            ? 'Este mensaje no acredita devolución de dinero ni una liquidación bancaria.'
            : 'Este mensaje comunica un estado operativo registrado; no acredita un cobro, una liquidación bancaria ni añade seguimiento de transporte.'
        const message = {
          to: row.contact_email,
          from,
          subject: `NETECO: ${title} — ${row.order_id}`,
          text: `${greeting}\n\n${title}\nPedido: ${row.order_id}\nRegistro: ${row.created_at}\n\n${notice}\nConsulta tu pedido con tu acceso vigente o contacta con NETECO.`,
          html: `<!doctype html><html lang="es"><body><p>${escapeEmailHtml(greeting)}</p><h1>${title}</h1><p>Pedido: ${row.order_id}</p><p>Registro: ${row.created_at}</p><p>${notice}</p><p>Consulta tu pedido con tu acceso vigente o contacta con NETECO.</p></body></html>`
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
      const row = (cancelled ? cancellationRowSchema : rowSchema).parse(prepared.proof.row),
        fields = Object.keys(row) as (keyof typeof row)[]
      return [
        database
          .prepare(
            `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(SELECT 1 FROM (${sourceSql(cancelled)}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 2}`).join(' AND ')})`
          )
          .bind(lease.eventId, ...fields.map((field) => row[field]))
      ]
    }
  }
}
export const orderOperationsEmailRenderers: readonly TransactionalEmailRenderer[] = [
  registration(false),
  registration(true)
]
export async function prepareOrderOperationsEmail(
  database: D1Database,
  eventId: string,
  from: string,
  context: { appEnvironment: 'local' | 'preview' | 'production'; validationEnabled: boolean }
): Promise<PreparedTransactionalEmail | { error: 'source_not_found' | 'invalid_source' }> {
  const event = await database
    .prepare('SELECT event_type FROM email_outbox_events WHERE id=?')
    .bind(eventId)
    .first<{ event_type: string }>()
  const renderer = orderOperationsEmailRenderers.find((value) => value.eventType === event?.event_type)
  return renderer ? renderer.prepare(database, eventId, from, context) : { error: 'source_not_found' }
}
/** The ID utility is shared; the statement reads the actual committed clock.
 * This belongs in the domain batch, never after a committed transition. */
export async function prepareOrderOperationsEnqueue(
  database: D1Database,
  input: { orderId: string; commandId: string; kind: 'fulfillment' | 'cancelled'; now: string }
) {
  const cancelled = input.kind === 'cancelled',
    eventType = cancelled ? 'order.cancelled' : 'order.status.updated'
  const { eventId } = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: input.commandId,
    sourceKind: 'order',
    sourceId: input.orderId,
    eventType,
    now: input.now
  })
  return database
    .prepare(
      `INSERT INTO email_outbox_events(id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
 SELECT ?1,?2,?3,'order',?4,1,c.created_at FROM ${cancelled ? 'payment_commands' : 'order_fulfillment_commands'} c JOIN orders o ON o.id=c.order_id
 WHERE c.${cancelled ? 'command_id' : 'id'}=?2 AND c.order_id=?4 AND ${cancelled ? `o.status='cancelled' AND ${cancellationProof}` : `o.status<>'cancelled' AND ${fulfillmentProof}`}
 ON CONFLICT(source_event_id,event_type) DO NOTHING`
    )
    .bind(eventId, input.commandId, eventType, input.orderId)
}
