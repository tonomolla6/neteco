import { useDatabase } from '../db/client'

interface CategoryRow {
  id: number
  name: string
  slug: string
  parentId: number | null
  sort: number
  directCount: number
}

interface CategoryNode extends Omit<CategoryRow, 'directCount'> {
  count: number
  children: CategoryNode[]
}

export default defineEventHandler(async () => {
  const sql = useDatabase()
  const categories = await sql<CategoryRow[]>`
    SELECT c.legacy_id AS id, c.name, c.slug, parent.legacy_id AS "parentId", c.sort_order AS sort,
           count(p.id)::int AS "directCount"
    FROM categories c
    LEFT JOIN categories parent ON parent.id = c.parent_id
    LEFT JOIN products p ON p.category_id = c.id AND p.status = 'published'
    WHERE c.status = 'published'
    GROUP BY c.id, parent.legacy_id
    ORDER BY c.sort_order, c.name
  `
  const byId = new Map<number, CategoryNode>(
    categories.map((category) => [
      category.id,
      {
        id: category.id,
        name: category.name,
        slug: category.slug,
        parentId: category.parentId,
        sort: category.sort,
        count: 0,
        children: []
      }
    ])
  )
  for (const category of categories) {
    let node = byId.get(category.id)
    while (node) {
      node.count += category.directCount
      node = node.parentId === null ? undefined : byId.get(node.parentId)
    }
  }
  const roots: CategoryNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const flat = [...byId.values()].map(({ children: _children, ...category }) => category)
  return { roots, flat }
})
