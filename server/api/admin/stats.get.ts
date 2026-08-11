export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  return {
    products: n('SELECT COUNT(*) AS c FROM products'),
    variants: n('SELECT COUNT(*) AS c FROM variants'),
    categories: n('SELECT COUNT(*) AS c FROM categories'),
    users: n('SELECT COUNT(*) AS c FROM users'),
    orders: n('SELECT COUNT(*) AS c FROM orders'),
    openOrders: n(
      "SELECT COUNT(*) AS c FROM orders WHERE status IN ('pendiente_pago', 'pendiente_transferencia', 'pagado', 'preparando')"
    )
  }
})
