import { useDatabase } from '../../db/client'
import { requireVerifiedIdentity } from '../../utils/auth-session'
import { publicOrderStatus } from '../../utils/order-status'

export default defineEventHandler(async (event) => {
  const authenticated = await requireVerifiedIdentity(event)
  const sql = useDatabase()
  const orders = await sql<
    Array<{
      id: string
      orderStatus: string
      paymentStatus: string
      paymentMethod: string
      fulfillmentStatus: string
      total: number
      createdAt: Date
      lines: number
    }>
  >`
    SELECT o.public_number AS id, o.order_status AS "orderStatus", o.payment_status AS "paymentStatus",
           o.payment_method AS "paymentMethod", o.fulfillment_status AS "fulfillmentStatus",
           o.total_gross_cents AS total,
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
      status: publicOrderStatus(order),
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      total: order.total,
      createdAt: order.createdAt.toISOString(),
      lines: order.lines
    }))
  }
})
