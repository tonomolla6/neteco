export default defineEventHandler(async (event) => {
  const db = useDb()
  const id = getRouterParam(event, 'id')
  const { token } = getQuery(event)

  const order = db
    .prepare(
      `SELECT id, token, user_id AS userId, status, name, company, nif, email, phone, address, zip, city, province,
        notes, shipping_method AS shippingMethod, shipping_cost AS shippingCost, payment_method AS paymentMethod,
        subtotal, tax, total, created_at AS createdAt
       FROM orders WHERE id = ?`
    )
    .get(id) as any
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })

  const session = await getUserSession(event)
  const isOwner = order.userId != null && (session.user as any)?.id === order.userId
  const hasToken = token && token === order.token
  if (!isOwner && !hasToken) {
    throw createError({ statusCode: 403, statusMessage: 'No tienes acceso a este pedido' })
  }

  const items = db
    .prepare('SELECT name, format, sku, price, qty FROM order_items WHERE order_id = ?')
    .all(order.id)

  delete order.token
  return { ...order, items }
})
