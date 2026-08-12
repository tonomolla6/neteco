export default defineEventHandler((event) => {
  const db = useDb()
  const slug = getRouterParam(event, 'slug')

  const product = db
    .prepare(
      `SELECT id, name, slug, brand, category_id AS categoryId, short_desc AS shortDesc,
              description, usage, badges, visual, image, datasheet, featured, series, attrs
       FROM products WHERE slug = ? AND active = 1`
    )
    .get(slug) as any
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })

  product.badges = JSON.parse(product.badges)
  product.visual = JSON.parse(product.visual)
  product.attrs = JSON.parse(product.attrs ?? '[]')

  const variants = db
    .prepare(
      'SELECT id, format, sku, price, stock, units, unit_label AS unitLabel, color, image FROM variants WHERE product_id = ? ORDER BY id'
    )
    .all(product.id)

  // otros colores/versiones de la misma gama (fichas hermanas cross-enlazadas)
  const siblings = product.series
    ? (
        db
          .prepare('SELECT name, slug, visual, image FROM products WHERE series = ? AND id != ? AND active = 1 ORDER BY name')
          .all(product.series, product.id) as any[]
      ).map((r) => ({ ...r, visual: JSON.parse(r.visual) }))
    : []

  // breadcrumb: de la raíz a la categoría del producto
  const breadcrumb: Array<{ name: string; slug: string }> = []
  let catId: number | null = product.categoryId
  while (catId != null) {
    const cat = db
      .prepare('SELECT id, name, slug, parent_id AS parentId FROM categories WHERE id = ?')
      .get(catId) as any
    if (!cat) break
    breadcrumb.unshift({ name: cat.name, slug: cat.slug })
    catId = cat.parentId
  }

  const related = (
    db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.brand, p.badges, p.visual, p.image,
          (SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) AS minPrice,
          (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS formats
         FROM products p WHERE p.category_id = ? AND p.id != ? AND p.active = 1 LIMIT 4`
      )
      .all(product.categoryId, product.id) as any[]
  ).map((r) => ({ ...r, badges: JSON.parse(r.badges), visual: JSON.parse(r.visual) }))

  return { ...product, variants, siblings, breadcrumb, related }
})
