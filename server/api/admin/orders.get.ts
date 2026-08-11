export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const items = db
    .prepare(
      `SELECT o.id, o.token, o.status, o.name, o.company, o.email, o.city, o.payment_method AS paymentMethod,
              o.shipping_method AS shippingMethod, o.total, o.created_at AS createdAt,
              (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines
       FROM orders o
       ORDER BY o.created_at DESC
       LIMIT 200`
    )
    .all()
  return { items }
})
