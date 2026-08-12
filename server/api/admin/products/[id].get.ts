export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))

  const product = db
    .prepare(
      `SELECT id, name, slug, brand, category_id AS categoryId, short_desc AS shortDesc,
              description, usage, badges, visual, featured, active, series, attrs
       FROM products WHERE id = ?`
    )
    .get(id) as any
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })

  product.badges = JSON.parse(product.badges)
  product.visual = JSON.parse(product.visual)
  product.attrs = JSON.parse(product.attrs ?? '[]')
  product.featured = !!product.featured
  product.active = !!product.active
  product.variants = db
    .prepare('SELECT id, format, sku, price, stock, units, unit_label AS unitLabel, color, image FROM variants WHERE product_id = ? ORDER BY id')
    .all(id)

  return product
})
