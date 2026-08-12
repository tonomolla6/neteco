import { useDatabase } from '../../db/client'
import { requireVerifiedIdentity } from '../../utils/auth-session'

function publicStatus(orderStatus: string, paymentStatus: string, paymentMethod: string) {
  if (paymentStatus === 'captured' || paymentStatus === 'authorized') return 'pagado'
  if (orderStatus === 'cancelled') return 'cancelado'
  return paymentMethod === 'transferencia' ? 'pendiente_transferencia' : 'pendiente_pago'
}

export default defineEventHandler(async (event) => {
  const authenticated = await requireVerifiedIdentity(event)
  const sql = useDatabase()
  const orders = await sql<
    Array<{
      id: string
      orderStatus: string
      paymentStatus: string
      paymentMethod: string
      total: number
      createdAt: Date
      lines: number
    }>
  >`
    SELECT o.public_number AS id, o.order_status AS "orderStatus", o.payment_status AS "paymentStatus",
           o.payment_method AS "paymentMethod", o.total_gross_cents AS total,
           o.created_at AS "createdAt", count(lines.id)::int AS lines
    FROM orders o
    JOIN identities identity ON identity.customer_id = o.customer_id
    LEFT JOIN order_lines lines ON lines.order_id = o.id
    WHERE identity.id = ${authenticated.profile.id}
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 200
  `
  return {
    orders: orders.map((order) => ({
      id: order.id,
      status: publicStatus(order.orderStatus, order.paymentStatus, order.paymentMethod),
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      total: order.total,
      createdAt: order.createdAt.toISOString(),
      lines: order.lines
    }))
  }
})
