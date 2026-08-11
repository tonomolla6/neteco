interface CatRow {
  id: number
  name: string
  slug: string
  parentId: number | null
  sort: number
}

export default defineEventHandler(() => {
  const db = useDb()
  const cats = db
    .prepare('SELECT id, name, slug, parent_id AS parentId, sort FROM categories ORDER BY sort')
    .all() as CatRow[]
  const counts = db
    .prepare('SELECT category_id AS id, COUNT(*) AS n FROM products WHERE active = 1 GROUP BY category_id')
    .all() as Array<{ id: number; n: number }>

  const byId = new Map(cats.map((c) => [c.id, { ...c, count: 0, children: [] as any[] }]))
  // los productos cuentan también en todos los ancestros de su categoría
  for (const { id, n } of counts) {
    let node = byId.get(id)
    while (node) {
      node.count += n
      node = node.parentId != null ? byId.get(node.parentId) : undefined
    }
  }

  const roots: any[] = []
  for (const node of byId.values()) {
    if (node.parentId != null && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node)
    else roots.push(node)
  }

  const flat = [...byId.values()].map(({ children, ...c }) => c)
  return { roots, flat }
})
