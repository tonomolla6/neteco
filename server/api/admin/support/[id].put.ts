import { z } from 'zod'
import { useDatabase } from '../../../db/client'

const schema = z
  .object({
    status: z.enum(['open', 'waiting_customer', 'waiting_provider', 'resolved', 'closed']),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    message: z.string().trim().min(1).max(5000).optional(),
    private: z.boolean().default(false),
    nextActionAt: z.string().datetime().nullable().optional(),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'support.manage', { mfa: true })
  const publicNumber = getRouterParam(event, 'id') ?? ''
  const body = await readValidatedBody(event, schema.parse)
  if (!body.private && body.message === undefined && body.status === 'waiting_customer') {
    throw createError({ statusCode: 400, statusMessage: 'Escribe la respuesta que espera el cliente' })
  }
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [ticket] = await transaction<
      Array<{
        id: string
        status: string
        priority: string
        recipient: string
        requesterName: string
      }>
    >`
      SELECT id, status, priority, COALESCE(requester_snapshot ->> 'email', '') AS recipient,
             COALESCE(requester_snapshot ->> 'name', 'Hola') AS "requesterName"
      FROM support_tickets WHERE public_number = ${publicNumber} FOR UPDATE
    `
    if (!ticket) return null
    await transaction`
      UPDATE support_tickets
      SET status = ${body.status}, priority = ${body.priority},
          owner_identity_id = COALESCE(owner_identity_id, ${authenticated.profile.id}),
          next_action_at = ${body.nextActionAt ? new Date(body.nextActionAt) : null}, updated_at = now()
      WHERE id = ${ticket.id}
    `
    if (body.message) {
      await transaction`
        INSERT INTO support_ticket_messages (ticket_id, author_type, author_id, body, private)
        VALUES (${ticket.id}, 'staff', ${authenticated.profile.id}, ${body.message}, ${body.private})
      `
      if (!body.private) {
        if (!ticket.recipient) throw createError({ statusCode: 409, statusMessage: 'El ticket no tiene email válido' })
        await transaction`
          INSERT INTO outbox_events (
            aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
          ) VALUES (
            'support_ticket', ${ticket.id}, 'support.ticket.reply',
            ${transaction.json({
              recipient: ticket.recipient,
              name: ticket.requesterName,
              ticketNumber: publicNumber,
              replyBody: body.message
            })}, ${correlationId}, ${`support:${ticket.id}:reply:${correlationId}`}
          )
        `
      }
    }
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'support.ticket.update', 'support_ticket', ${publicNumber},
        ${transaction.json({ status: ticket.status, priority: ticket.priority })},
        ${transaction.json({ status: body.status, priority: body.priority, privateMessage: body.private })},
        ${body.reason}, ${correlationId}
      )
    `
    return { id: publicNumber, status: body.status, priority: body.priority }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Ticket no encontrado' })
  return result
})
