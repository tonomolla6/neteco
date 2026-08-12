import { useDatabase } from '../../db/client'

function legacyStatus(orderStatus: string, paymentStatus: string, fulfillmentStatus: string, paymentMethod: string) {
  if (orderStatus === 'cancelled') return 'cancelado'
  if (fulfillmentStatus === 'delivered') return 'entregado'
  if (fulfillmentStatus === 'in_transit') return 'enviado'
  if (['picking', 'packed', 'ready_for_pickup'].includes(fulfillmentStatus)) return 'preparando'
  if (['authorized', 'captured'].includes(paymentStatus)) return 'pagado'
  return paymentMethod === 'transferencia' ? 'pendiente_transferencia' : 'pendiente_pago'
}

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const items = await sql<
    Array<{
      id: string
      orderStatus: string
      paymentStatus: string
      fulfillmentStatus: string
      inventoryStatus: string
      invoiceStatus: string
      name: string
      company: string | null
      email: string
      city: string
      paymentMethod: string
      shippingMethod: string
      total: number
      createdAt: Date
      lines: number
    }>
  >`
    SELECT o.public_number AS id, o.order_status AS "orderStatus", o.payment_status AS "paymentStatus",
           o.fulfillment_status AS "fulfillmentStatus", o.inventory_status AS "inventoryStatus",
           o.invoice_status AS "invoiceStatus", o.customer_snapshot ->> 'name' AS name,
           o.customer_snapshot ->> 'company' AS company, o.customer_snapshot ->> 'email' AS email,
           o.shipping_snapshot ->> 'city' AS city, o.payment_method AS "paymentMethod",
           o.shipping_method AS "shippingMethod", o.total_gross_cents AS total,
           o.created_at AS "createdAt", count(lines.id)::int AS lines
    FROM orders o
    LEFT JOIN order_lines lines ON lines.order_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 200
  `
  return {
    items: items.map((order) => ({
      ...order,
      status: legacyStatus(order.orderStatus, order.paymentStatus, order.fulfillmentStatus, order.paymentMethod),
      createdAt: order.createdAt.toISOString()
    }))
  }
})
