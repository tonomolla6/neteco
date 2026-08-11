export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))

  const { n: children } = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?').get(id) as { n: number }
  if (children) throw createError({ statusCode: 400, statusMessage: 'La familia tiene subfamilias: muévelas o bórralas antes' })
  const { n: products } = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(id) as { n: number }
  if (products) throw createError({ statusCode: 400, statusMessage: 'La familia tiene productos: muévelos o bórralos antes' })

  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  if (!info.changes) throw createError({ statusCode: 404, statusMessage: 'Familia no encontrada' })
  return { ok: true }
})
