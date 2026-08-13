import { z } from 'zod'
import { useDatabase } from '../../db/client'
import { slugify } from '../../utils/slug'

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  parentId: z.number().int().positive().nullable().optional()
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [parent] = body.parentId
      ? await transaction<{ id: string }[]>`
          SELECT id FROM categories WHERE legacy_id = ${body.parentId} FOR UPDATE
        `
      : [undefined]
    if (body.parentId && !parent) {
      throw createError({ statusCode: 400, statusMessage: 'La familia superior no existe' })
    }
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:catalog:category-legacy-id'))`
    const [next] = await transaction<{ legacyId: number; sort: number }[]>`
      SELECT greatest(COALESCE(max(legacy_id), 999), 999)::int + 1 AS "legacyId",
             COALESCE(max(sort_order), 0)::int + 1 AS sort
      FROM categories
    `
    if (!next) throw new Error('Could not allocate category identifier')
    const baseSlug = slugify(body.name)
    const [category] = await transaction<{ id: string; slug: string }[]>`
      INSERT INTO categories (legacy_id, parent_id, name, slug, status, sort_order)
      VALUES (
        ${next.legacyId}, ${parent?.id ?? null}, ${body.name},
        CASE WHEN EXISTS (SELECT 1 FROM categories WHERE slug = ${baseSlug})
             THEN ${`${baseSlug}-${next.legacyId}`} ELSE ${baseSlug} END,
        'published', ${next.sort}
      ) RETURNING id, slug
    `
    if (!category) throw new Error('Category insert returned no row')
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'category.create', 'category', ${String(next.legacyId)},
        ${transaction.json({ name: body.name, parentId: body.parentId ?? null })}, ${correlationId}
      )
    `
    return { id: next.legacyId, slug: category.slug }
  })
  setResponseStatus(event, 201)
  return result
})
