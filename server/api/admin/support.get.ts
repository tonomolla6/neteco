import { z } from 'zod'
import { useDatabase } from '../../db/client'

const querySchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    status: z.enum(['open', 'waiting_customer', 'waiting_provider', 'resolved', 'closed']).optional(),
    category: z.enum(['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other']).optional()
  })
  .strict()

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'support.manage', { mfa: true })
  const query = querySchema.parse(getQuery(event))
  const sql = useDatabase()
  const items = await sql`
    SELECT ticket.public_number AS id, ticket.category, ticket.priority, ticket.status, ticket.subject,
           COALESCE(ticket.requester_snapshot ->> 'name', 'Sin nombre') AS "requesterName",
           COALESCE(ticket.requester_snapshot ->> 'email', '') AS "requesterEmail",
           ticket.context_snapshot ->> 'orderNumber' AS "orderNumber",
           ticket.context_snapshot ->> 'productSlug' AS "productSlug",
           owner.email::text AS "ownerName", ticket.sla_due_at AS "slaDueAt",
           ticket.next_action_at AS "nextActionAt", ticket.created_at AS "createdAt",
           ticket.updated_at AS "updatedAt", count(message.id)::int AS messages
    FROM support_tickets ticket
    LEFT JOIN identities owner ON owner.id = ticket.owner_identity_id
    LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
    WHERE (${query.q ?? null}::text IS NULL
           OR ticket.public_number ILIKE ${query.q ? `%${query.q}%` : null}
           OR ticket.subject ILIKE ${query.q ? `%${query.q}%` : null})
      AND (${query.status ?? null}::text IS NULL OR ticket.status = ${query.status ?? null})
      AND (${query.category ?? null}::text IS NULL OR ticket.category = ${query.category ?? null})
    GROUP BY ticket.id, owner.id
    ORDER BY
      CASE ticket.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN ticket.status IN ('resolved', 'closed') THEN 1 ELSE 0 END,
      ticket.sla_due_at, ticket.created_at
    LIMIT 300
  `
  return { items }
})
