export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const q = getQuery(event)

  const where: string[] = []
  const params: any[] = []

  if (q.q) {
    const like = `%${String(q.q).trim()}%`
    where.push(
      '(p.name LIKE ? OR p.brand LIKE ? OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.sku LIKE ?))'
    )
    params.push(like, like, like)
  }
  if (q.category) {
    where.push('p.category_id = ?')
    params.push(Number(q.category))
  }
  if (q.active === '1' || q.active === '0') {
    where.push('p.active = ?')
    params.push(Number(q.active))
  }

  const items = (
    db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.brand, p.featured, p.active, p.series, p.visual,
          p.category_id AS categoryId, c.name AS categoryName,
          (SELECT MIN(v.price) FROM variants v WHERE v.product_id = p.id) AS minPrice,
          (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS formats
         FROM products p JOIN categories c ON c.id = p.category_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY p.name COLLATE NOCASE
         LIMIT 500`
      )
      .all(...params) as any[]
  ).map((r) => ({ ...r, visual: JSON.parse(r.visual) }))

  return { items }
})
