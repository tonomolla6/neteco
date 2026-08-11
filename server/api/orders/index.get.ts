export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const db = useDb()
  const orders = db
    .prepare(
      `SELECT o.id, o.status, o.total, o.payment_method AS paymentMethod, o.created_at AS createdAt,
        (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines
       FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC`
    )
    .all((session.user as any).id)
  return { orders }
})
