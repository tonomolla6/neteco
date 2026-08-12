import { z } from 'zod'
import { useDatabase } from '../../../../db/client'
import { requirePermission } from '../../../../utils/auth-session'

const schema = z.object({ reason: z.string().trim().min(3).max(500) })

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'invoices.issue', { mfa: true })
  const publicNumber = String(getRouterParam(event, 'orderId'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [order] = await transaction<{ id: string; paymentStatus: string; invoiceStatus: string }[]>`
      SELECT id, payment_status AS "paymentStatus", invoice_status AS "invoiceStatus"
      FROM orders WHERE public_number = ${publicNumber} FOR UPDATE
    `
    if (!order) return null
    if (!['captured', 'authorized'].includes(order.paymentStatus)) {
      throw createError({ statusCode: 409, statusMessage: 'El pedido aún no es facturable' })
    }
    if (order.invoiceStatus === 'issued' || order.invoiceStatus === 'fiscal_pending') {
      throw createError({ statusCode: 409, statusMessage: 'La factura ya está emitida' })
    }
    const idempotencyKey = `invoice:${order.id}:issue:v1`
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'order', ${order.id}, 'invoice.issue.requested',
        ${transaction.json({ orderId: order.id, orderNumber: publicNumber, retryReason: body.reason })},
        ${correlationId}, ${idempotencyKey}
      ) ON CONFLICT (idempotency_key) DO UPDATE SET
        status = 'pending', attempts = 0, available_at = now(), locked_at = NULL, locked_by = NULL,
        last_error_code = NULL, last_error_message = NULL
    `
    await transaction`UPDATE orders SET invoice_status = 'queued', updated_at = now() WHERE id = ${order.id}`
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, reason, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'invoice.retry', 'order', ${publicNumber},
        ${body.reason}, ${correlationId}
      )
    `
    return { ok: true, status: 'queued' }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  return result
})
