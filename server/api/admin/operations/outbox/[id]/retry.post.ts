import { z } from 'zod'
import { useDatabase } from '../../../../../db/client'

const schema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'administration.manage', { mfa: true })
  const eventId = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const [requeued] = await sql.begin(async (transaction) => {
    const rows = await transaction<{ eventType: string; status: string }[]>`
      UPDATE outbox_events
      SET status = 'retry', available_at = now(), locked_at = NULL, locked_by = NULL,
          last_error_code = NULL, last_error_message = NULL
      WHERE id = ${eventId} AND status IN ('dead', 'retry')
      RETURNING event_type AS "eventType", status
    `
    const updated = rows[0]
    if (!updated) return []
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'outbox.requeue', 'outbox_event', ${eventId},
        ${transaction.json({ eventType: updated.eventType, status: 'retry' })}, ${body.reason}, ${correlationId}
      )
    `
    return rows
  })
  if (!requeued) throw createError({ statusCode: 409, statusMessage: 'El evento no está en estado reintentable' })
  return { id: eventId, status: 'retry' }
})
