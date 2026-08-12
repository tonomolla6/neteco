import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

const schema = z.object({
  requestType: z.enum(['export', 'anonymize']),
  idempotencyKey: z.string().uuid()
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const [request] = await sql<
    Array<{ id: string; status: string; requestType: string; dueAt: Date; completedAt: Date | null }>
  >`
    INSERT INTO privacy_requests (
      customer_id, request_type, status, idempotency_key, evidence, completed_at
    ) VALUES (
      ${account.customerId}, ${body.requestType}, ${body.requestType === 'export' ? 'completed' : 'requested'},
      ${body.idempotencyKey},
      ${sql.json(body.requestType === 'export' ? { generatedOnDemand: true } : { authenticated: true })},
      ${body.requestType === 'export' ? new Date() : null}
    )
    ON CONFLICT (customer_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    RETURNING id, status, request_type AS "requestType", due_at AS "dueAt", completed_at AS "completedAt"
  `
  if (!request) throw new Error('Privacy request insert returned no row')
  await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id)
    VALUES (
      'identity', ${account.profile.id}, 'privacy.requested', 'privacy_request', ${request.id},
      ${sql.json({ requestType: request.requestType, status: request.status })},
      ${event.context.correlationId ?? crypto.randomUUID()}
    )
  `
  setResponseStatus(event, 202)
  return request
})
