import { z } from 'zod'

const schema = z.object({
  name: z.string().trim().min(2, 'El nombre es demasiado corto'),
  parentId: z.number().int().positive().nullable().optional()
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const db = useDb()
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)

  const current = db.prepare('SELECT id, name, slug, parent_id AS parentId FROM categories WHERE id = ?').get(id) as any
  if (!current) throw createError({ statusCode: 404, statusMessage: 'Familia no encontrada' })

  const parentId = body.parentId === undefined ? current.parentId : body.parentId
  if (parentId != null) {
    // evita colgar una familia de sí misma o de una de sus descendientes
    let cursor: number | null = parentId
    while (cursor != null) {
      if (cursor === id) throw createError({ statusCode: 400, statusMessage: 'Una familia no puede colgar de sí misma' })
      const row = db.prepare('SELECT parent_id AS parentId FROM categories WHERE id = ?').get(cursor) as any
      if (!row) throw createError({ statusCode: 400, statusMessage: 'La familia superior no existe' })
      cursor = row.parentId
    }
  }

  const slug = body.name === current.name ? current.slug : ensureUniqueSlug(db, 'categories', slugify(body.name), id)
  db.prepare('UPDATE categories SET name = ?, slug = ?, parent_id = ? WHERE id = ?').run(body.name, slug, parentId, id)
  return { id, slug }
})
