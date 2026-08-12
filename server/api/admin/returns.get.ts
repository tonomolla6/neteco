import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const items = await sql`
    SELECT r.public_number AS id, o.public_number AS "orderNumber", r.status, r.reason, r.resolution,
           o.customer_snapshot ->> 'name' AS "customerName", o.customer_snapshot ->> 'email' AS email,
           r.created_at AS "createdAt", r.updated_at AS "updatedAt",
           COALESCE(sum(lines.quantity), 0)::int AS quantity,
           refund.amount_cents AS "refundAmountCents", refund.status AS "refundStatus"
    FROM returns r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN return_lines lines ON lines.return_id = r.id
    LEFT JOIN refunds refund ON refund.return_id = r.id
    GROUP BY r.id, o.id, refund.id
    ORDER BY r.created_at DESC
    LIMIT 200
  `
  return { items }
})
