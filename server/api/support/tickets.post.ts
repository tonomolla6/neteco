import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../db/client'

const schema = z
  .object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(32).optional().default(''),
    category: z.enum(['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other']),
    subject: z.string().trim().min(5).max(200),
    message: z.string().trim().min(10).max(5000),
    orderNumber: z.string().trim().max(32).optional().default(''),
    productSlug: z.string().trim().max(180).optional().default(''),
    privacyAcknowledged: z.literal(true),
    website: z.string().max(0).optional().default('')
  })
  .strict()

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const publicNumber = `SOP-${randomBytes(6).toString('hex').toUpperCase()}`
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const normalizedEmail = body.email.toLowerCase()
  const [ticket] = await sql.begin(async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO support_tickets (
        public_number, category, priority, status, subject, requester_snapshot,
        context_snapshot, sla_due_at
      ) VALUES (
        ${publicNumber}, ${body.category}, 'normal', 'open', ${body.subject},
        ${transaction.json({ name: body.name, email: normalizedEmail, phone: body.phone || null })},
        ${transaction.json({ orderNumber: body.orderNumber || null, productSlug: body.productSlug || null })},
        now() + interval '1 day'
      ) RETURNING id
    `
    const created = rows[0]
    if (!created) throw new Error('Support ticket insert returned no row')
    await transaction`
      INSERT INTO support_ticket_messages (ticket_id, author_type, body)
      VALUES (${created.id}, 'customer', ${body.message})
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'support_ticket', ${created.id}, 'support.ticket.received',
        ${transaction.json({ recipient: normalizedEmail, name: body.name, ticketNumber: publicNumber })},
        ${correlationId}, ${`support:${created.id}:received`}
      )
    `
    return rows
  })
  if (!ticket) throw new Error('Support transaction returned no ticket')
  setResponseStatus(event, 201)
  return { id: publicNumber, status: 'open' }
})
