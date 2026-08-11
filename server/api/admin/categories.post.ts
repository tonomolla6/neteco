import { z } from 'zod'

const schema = z.object({
  name: z.string().trim().min(2, 'El nombre es demasiado corto'),
  parentId: z.number().int().positive().nullable().optional()
})

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  const db = useDb()

  const parentId = body.parentId ?? null
  if (parentId != null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(parentId)) {
    throw createError({ statusCode: 400, statusMessage: 'La familia superior no existe' })
  }

  const { s } = db
    .prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE parent_id IS ?')
    .get(parentId) as { s: number }
  const slug = ensureUniqueSlug(db, 'categories', slugify(body.name))
  const info = db
    .prepare('INSERT INTO categories (name, slug, parent_id, sort) VALUES (?, ?, ?, ?)')
    .run(body.name, slug, parentId, s)

  return { id: Number(info.lastInsertRowid), slug }
})
