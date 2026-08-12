import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const [stats] = await sql<
    Array<{ products: number; variants: number; categories: number; users: number; orders: number; openOrders: number }>
  >`
    SELECT
      (SELECT count(*)::int FROM products) AS products,
      (SELECT count(*)::int FROM variants) AS variants,
      (SELECT count(*)::int FROM categories) AS categories,
      (SELECT count(*)::int FROM identities) AS users,
      (SELECT count(*)::int FROM orders) AS orders,
      (SELECT count(*)::int FROM orders WHERE order_status IN ('awaiting_payment', 'confirmed', 'on_hold')) AS "openOrders"
  `
  return stats
})
