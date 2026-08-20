export interface CategoryRow {
  id: number
  name: string
  slug: string
  parentId: number | null
  sort: number
  directCount: number
}

export interface CategoryNode extends Omit<CategoryRow, 'directCount'> {
  count: number
  children: CategoryNode[]
}

export interface CategoryResponse {
  roots: CategoryNode[]
  flat: Array<Omit<CategoryNode, 'children'>>
}

export async function listPublishedCategories(database: D1Database): Promise<CategoryResponse> {
  const { results } = await database
    .prepare(
      `WITH RECURSIVE published_categories AS (
         SELECT *
         FROM categories
         WHERE parent_id IS NULL AND status = 'published'
         UNION ALL
         SELECT child.*
         FROM categories child
         JOIN published_categories parent ON parent.id = child.parent_id
         WHERE child.status = 'published'
       )
       SELECT c.legacy_id AS id,
              c.name,
              c.slug,
              parent.legacy_id AS parentId,
              c.sort_order AS sort,
              count(p.id) AS directCount
       FROM published_categories c
       LEFT JOIN published_categories parent ON parent.id = c.parent_id
       LEFT JOIN products p ON p.category_id = c.id AND p.status = 'published'
       GROUP BY c.id, parent.legacy_id
       ORDER BY c.sort_order, c.name`
    )
    .all<CategoryRow>()

  const byId = new Map<number, CategoryNode>(
    results.map((category) => [
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

  for (const category of results) {
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

  return {
    roots,
    flat: [...byId.values()].map(({ children: _children, ...category }) => category)
  }
}
