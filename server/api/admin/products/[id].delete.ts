export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(id)
  if (!info.changes) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  // las variantes caen en cascada; los pedidos históricos conservan su copia de nombre/ref/precio
  return { ok: true }
})
