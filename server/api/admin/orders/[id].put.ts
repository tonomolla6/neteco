import { z } from 'zod'
import { assertTransition, fulfillmentTransitions } from '../../../domain/states'
import type { orderTransitions } from '../../../domain/states'
import { useDatabase } from '../../../db/client'
import { cancelOrderByAdmin } from '../../../services/orders'

const schema = z.object({
  status: z.enum(['pagado', 'preparando', 'enviado', 'entregado', 'cancelado']),
  reason: z.string().trim().min(3).max(500)
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = String(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  if (body.status === 'cancelado') {
    return cancelOrderByAdmin({
      publicNumber: id,
      actorId: administrator.id,
      reason: body.reason,
      correlationId
    })
  }
  const updated = await sql.begin(async (transaction) => {
    const [order] = await transaction<
      Array<{
        id: string
        orderStatus: keyof typeof orderTransitions
        paymentStatus: string
        fulfillmentStatus: keyof typeof fulfillmentTransitions
        inventoryStatus: string
      }>
    >`
      SELECT id, order_status AS "orderStatus", payment_status AS "paymentStatus",
             fulfillment_status AS "fulfillmentStatus", inventory_status AS "inventoryStatus"
      FROM orders WHERE public_number = ${id} FOR UPDATE
    `
    if (!order) return null
    let orderStatus = order.orderStatus
    let fulfillmentStatus = order.fulfillmentStatus
    if (body.status === 'pagado' && !['authorized', 'captured'].includes(order.paymentStatus)) {
      throw createError({ statusCode: 409, statusMessage: 'Un administrador no puede fingir una captura bancaria' })
    }
    if (
      ['preparando', 'enviado', 'entregado'].includes(body.status) &&
      !['captured', 'partially_refunded'].includes(order.paymentStatus)
    ) {
      throw createError({ statusCode: 409, statusMessage: 'El pedido no puede prepararse sin pago capturado' })
    }
    if (body.status === 'preparando') {
      assertTransition(fulfillmentTransitions, fulfillmentStatus, 'picking')
      fulfillmentStatus = 'picking'
    } else if (body.status === 'enviado') {
      if (fulfillmentStatus === 'picking') fulfillmentStatus = 'packed'
      if (fulfillmentStatus === 'packed') fulfillmentStatus = 'in_transit'
      else assertTransition(fulfillmentTransitions, fulfillmentStatus, 'in_transit')
    } else if (body.status === 'entregado') {
      assertTransition(fulfillmentTransitions, fulfillmentStatus, 'delivered')
      fulfillmentStatus = 'delivered'
      if (orderStatus === 'confirmed') orderStatus = 'completed'
    }
    await transaction`
      UPDATE orders
      SET order_status = ${orderStatus}, fulfillment_status = ${fulfillmentStatus},
          delivered_at = CASE
            WHEN ${fulfillmentStatus} = 'delivered' THEN COALESCE(delivered_at, now())
            ELSE delivered_at
          END,
          updated_at = now()
      WHERE id = ${order.id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, actor_id, origin, reason, from_state, to_state,
        public_data, private_data, correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, 'admin.order.transitioned', 'staff', ${administrator.id}, 'admin', ${body.reason},
        ${transaction.json({ order: order.orderStatus, fulfillment: order.fulfillmentStatus })},
        ${transaction.json({ order: orderStatus, fulfillment: fulfillmentStatus })},
        ${transaction.json({})}, ${transaction.json({})}, ${correlationId}, ${`admin:${correlationId}`}
      )
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'order.transition', 'order', ${id},
        ${transaction.json({ order: order.orderStatus, fulfillment: order.fulfillmentStatus })},
        ${transaction.json({ order: orderStatus, fulfillment: fulfillmentStatus })},
        ${body.reason}, ${correlationId}
      )
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'order', ${order.id}, 'order.status.updated',
        ${transaction.json({ orderId: order.id, orderNumber: id, statusLabel: body.status })},
        ${correlationId}, ${`order:${order.id}:status:${fulfillmentStatus}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    return { id, status: body.status, orderStatus, fulfillmentStatus }
  })
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  return updated
})
