import { z } from 'zod'
import {
  returnCommandReceiptSchema,
  returnRequestInputSchema,
  returnTransitionInputSchema
} from '../../shared/order-returns'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { prepareEmailOutboxEnqueue } from './email-outbox'
import { escapeEmailHtml } from './order-created-email'
import type { TransactionalEmailRenderer, PreparedTransactionalEmail } from './transactional-email-renderers'
const states = ['requested', 'approved', 'rejected', 'received', 'inspected', 'resolution_ready'] as const
const titles: Record<(typeof states)[number], string> = {
  requested: 'Solicitud de devolución registrada',
  approved: 'Solicitud de devolución admitida',
  rejected: 'Solicitud de devolución rechazada',
  received: 'Recepción de devolución registrada',
  inspected: 'Inspección de devolución registrada',
  resolution_ready: 'Resolución de devolución preparada'
}
const proof = `EXISTS(SELECT 1 FROM order_return_events a WHERE a.command_id=c.id AND ${['return_id', 'actor_id', 'actor_type', 'order_id', 'action', 'input', 'response', 'public_message', 'created_at'].map((field) => `a.${field} IS c.${field}`).join(' AND ')} AND a.version=c.result_version)
 AND EXISTS(SELECT 1 FROM order_returns r WHERE r.id=c.return_id AND r.order_id=c.order_id AND r.public_ref=c.public_ref AND r.last_command_id=c.id AND r.version=c.result_version AND r.state=c.to_state AND r.updated_at=c.created_at)`
const rowSchema = z
  .object({
    command_id: z.string().uuid(),
    return_id: z.string().uuid(),
    public_ref: z.string(),
    order_id: z.string().uuid(),
    action: z.enum(states),
    version: z.number().int().positive(),
    input: z.string(),
    response: z.string(),
    public_message: z.string().max(500),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: catalogPolicyInstantSchema,
    contact_email: z
      .string()
      .email()
      .max(254)
      .refine((value) => !/[\s]/u.test(value)),
    contact_name: z.string().max(200).nullable()
  })
  .strict()
function sourceSql(requested: boolean) {
  return `SELECT c.id command_id,c.return_id,c.public_ref,c.order_id,c.action,c.result_version version,c.input,c.response,c.public_message,c.payload_hash,c.created_at,o.contact_email,o.contact_name
 FROM email_outbox_events e JOIN order_return_commands c ON c.id=e.source_event_id AND c.return_id=e.source_id JOIN orders o ON o.id=c.order_id
 WHERE e.id=?1 AND e.source_kind='return' AND e.event_type='${requested ? 'return.requested' : 'return.status.updated'}' AND e.schema_version=1 AND e.created_at=c.created_at
 AND c.action${requested ? "='requested'" : "<>'requested'"} AND c.action=c.to_state AND ${proof}`
}
const hash = (value: unknown) => sha256Hex(canonicalJson(value))
const plain = (value: string) =>
  [...value]
    .map((character) => (character.codePointAt(0)! < 32 || character.codePointAt(0) === 127 ? ' ' : character))
    .join('')
function registration(requested: boolean): TransactionalEmailRenderer {
  const version = requested ? 'order.return.requested.v1' : 'order.return.status.v1'
  return {
    key: version,
    version,
    eventType: requested ? 'return.requested' : 'return.status.updated',
    sourceKind: 'return',
    sourcePredicate:
      'EXISTS(SELECT 1 FROM order_return_commands c WHERE c.id=e.source_event_id AND c.return_id=e.source_id)',
    async prepare(database, eventId, from) {
      const raw = await database.prepare(sourceSql(requested)).bind(eventId).first()
      if (!raw) return { error: 'source_not_found' }
      try {
        const row = rowSchema.parse(raw),
          input = (requested ? returnRequestInputSchema : returnTransitionInputSchema).parse(JSON.parse(row.input)),
          receipt = returnCommandReceiptSchema.parse(JSON.parse(row.response))
        if (
          receipt.commandId !== row.command_id ||
          receipt.returnId !== row.return_id ||
          receipt.publicRef !== row.public_ref ||
          receipt.orderId !== row.order_id ||
          receipt.action !== row.action ||
          receipt.version !== row.version ||
          (await hash(
            requested
              ? { orderId: row.order_id, input, kind: 'request' }
              : { publicRef: row.public_ref, input, kind: 'transition' }
          )) !== row.payload_hash ||
          (!requested &&
            (!('action' in input) ||
              input.action !== row.action ||
              !('publicMessage' in input) ||
              input.publicMessage !== row.public_message))
        )
          return { error: 'invalid_source' }
        const title = titles[row.action],
          greeting = row.contact_name ? `Hola ${plain(row.contact_name)},` : 'Hola,',
          notice =
            'Este registro no confirma un reembolso ni una autorización económica y no repone existencias. Consulta la resolución vigente con tu acceso autorizado.'
        const text = `${greeting}\n\n${title}\nReferencia: ${row.public_ref}\nRegistro: ${row.created_at}\n${plain(row.public_message)}\n\n${notice}`
        const message = {
          to: row.contact_email,
          from,
          subject: `NETECO: ${title} — ${row.public_ref}`,
          text,
          html: `<!doctype html><html lang="es"><body><p>${escapeEmailHtml(greeting)}</p><h1>${title}</h1><p>Referencia: ${escapeEmailHtml(row.public_ref)}</p><p>Registro: ${row.created_at}</p><p>${escapeEmailHtml(row.public_message)}</p><p>${notice}</p></body></html>`
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
            `INSERT INTO transactional_email_preparation_guards(id,passed) SELECT 0,0 WHERE NOT EXISTS(SELECT 1 FROM (${sourceSql(requested)}) confirmed WHERE ${fields.map((field, index) => `confirmed.${field} IS ?${index + 2}`).join(' AND ')})`
          )
          .bind(lease.eventId, ...fields.map((field) => row[field]))
      ]
    }
  }
}
export const orderReturnEmailRenderers: readonly TransactionalEmailRenderer[] = [
  registration(true),
  registration(false)
]
export async function prepareOrderReturnEmail(
  database: D1Database,
  eventId: string,
  from: string,
  context: { appEnvironment: 'local' | 'preview' | 'production'; validationEnabled: boolean }
): Promise<PreparedTransactionalEmail | { error: 'invalid_source' | 'source_not_found' }> {
  const event = await database
    .prepare('SELECT event_type FROM email_outbox_events WHERE id=?')
    .bind(eventId)
    .first<{ event_type: string }>()
  const renderer = orderReturnEmailRenderers.find((item) => item.eventType === event?.event_type)
  return renderer ? renderer.prepare(database, eventId, from, context) : { error: 'source_not_found' }
}
export async function prepareOrderReturnEnqueue(
  database: D1Database,
  input: { returnId: string; commandId: string; requested: boolean; now: string }
) {
  const eventType = input.requested ? 'return.requested' : 'return.status.updated'
  const { eventId } = await prepareEmailOutboxEnqueue(database, {
    sourceEventId: input.commandId,
    sourceKind: 'return',
    sourceId: input.returnId,
    eventType,
    now: input.now
  })
  return database
    .prepare(
      `INSERT INTO email_outbox_events(id,source_event_id,event_type,source_kind,source_id,schema_version,created_at)
 SELECT ?1,c.id,?3,'return',c.return_id,1,c.created_at FROM order_return_commands c WHERE c.id=?2 AND c.return_id=?4 AND ${proof}
 ON CONFLICT(source_event_id,event_type) DO NOTHING`
    )
    .bind(eventId, input.commandId, eventType, input.returnId)
}
