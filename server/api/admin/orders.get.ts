import { useDatabase } from '../../db/client'
import { publicOrderStatus } from '../../utils/order-status'

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
      shipmentId: string | null
      trackingNumber: string | null
      shipmentStatus: string | null
    }>
  >`
    SELECT o.public_number AS id, o.order_status AS "orderStatus", o.payment_status AS "paymentStatus",
           o.fulfillment_status AS "fulfillmentStatus", o.inventory_status AS "inventoryStatus",
           o.invoice_status AS "invoiceStatus", o.customer_snapshot ->> 'name' AS name,
           o.customer_snapshot ->> 'company' AS company, o.customer_snapshot ->> 'email' AS email,
           o.shipping_snapshot ->> 'city' AS city, o.payment_method AS "paymentMethod",
           o.shipping_method AS "shippingMethod", o.total_gross_cents AS total,
           o.created_at AS "createdAt", count(lines.id)::int AS lines,
           shipment.id AS "shipmentId", shipment.tracking_number AS "trackingNumber",
           shipment.status AS "shipmentStatus"
    FROM orders o
    LEFT JOIN order_lines lines ON lines.order_id = o.id
    LEFT JOIN LATERAL (
      SELECT created.id, created.tracking_number, created.status
      FROM fulfillments fulfillment
      JOIN shipments created ON created.fulfillment_id = fulfillment.id
      WHERE fulfillment.order_id = o.id
      ORDER BY created.created_at DESC LIMIT 1
    ) shipment ON true
    GROUP BY o.id, shipment.id, shipment.tracking_number, shipment.status
    ORDER BY o.created_at DESC
    LIMIT 200
  `
  return {
    items: items.map((order) => ({
      ...order,
      status: publicOrderStatus(order),
      createdAt: order.createdAt.toISOString()
    }))
  }
})
