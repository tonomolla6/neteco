import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'support.manage', { mfa: true })
  const publicNumber = getRouterParam(event, 'id') ?? ''
  const sql = useDatabase()
  const [ticket] = await sql<
    Array<{
      uuid: string
      id: string
      category: string
      priority: string
      status: string
      subject: string
      requesterName: string
      requesterEmail: string
      requesterPhone: string | null
      orderNumber: string | null
      productSlug: string | null
      ownerName: string | null
      slaDueAt: string
      nextActionAt: string | null
      createdAt: string
      updatedAt: string
      messages: number
      orderId: string | null
    }>
  >`
    SELECT ticket.id AS uuid, ticket.public_number AS id, ticket.category, ticket.priority,
           ticket.status, ticket.subject,
           COALESCE(ticket.requester_snapshot ->> 'name', 'Sin nombre') AS "requesterName",
           COALESCE(ticket.requester_snapshot ->> 'email', '') AS "requesterEmail",
           ticket.requester_snapshot ->> 'phone' AS "requesterPhone",
           ticket.context_snapshot ->> 'orderNumber' AS "orderNumber",
           ticket.context_snapshot ->> 'productSlug' AS "productSlug",
           owner.email::text AS "ownerName", ticket.sla_due_at AS "slaDueAt",
           ticket.next_action_at AS "nextActionAt", ticket.created_at AS "createdAt",
           ticket.updated_at AS "updatedAt", count(message.id)::int AS messages,
           orders.public_number AS "orderId"
    FROM support_tickets ticket
    LEFT JOIN identities owner ON owner.id = ticket.owner_identity_id
    LEFT JOIN support_ticket_messages message ON message.ticket_id = ticket.id
    LEFT JOIN orders ON orders.id = ticket.order_id
    WHERE ticket.public_number = ${publicNumber}
    GROUP BY ticket.id, owner.id, orders.id
  `
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket no encontrado' })
  const timeline = await sql`
    SELECT message.id, message.author_type AS "authorType", author.email::text AS "authorName",
           message.body, message.private, message.created_at AS "createdAt"
    FROM support_ticket_messages message
    LEFT JOIN identities author ON author.id = message.author_id
    WHERE message.ticket_id = ${ticket.uuid}
    ORDER BY message.created_at, message.id
  `
  const { uuid: _uuid, ...result } = ticket
  return { ...result, timeline }
})
