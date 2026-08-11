export default defineEventHandler((event) => {
  const { q } = getQuery(event)
  const term = String(q ?? '').trim()
  if (term.length < 2) return { items: [] }

  const db = useDb()
  const like = `%${term}%`
  const items = (
    db
      .prepare(
        `SELECT p.name, p.slug, p.brand, p.visual, p.image,
          (SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) AS minPrice
         FROM products p
         WHERE p.active = 1 AND (p.name LIKE ? OR p.brand LIKE ? OR p.short_desc LIKE ?
            OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku LIKE ?))
         ORDER BY p.featured DESC, p.name LIMIT 8`
      )
      .all(like, like, like, like) as any[]
  ).map((r) => ({ ...r, visual: JSON.parse(r.visual) }))

  return { items }
})
