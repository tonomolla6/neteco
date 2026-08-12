import { z } from 'zod'
import { useDatabase } from '../../../db/client'
import { slugify } from '../../../utils/slug'

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  parentId: z.number().int().positive().nullable().optional(),
  reason: z.string().trim().min(3).max(500).optional().default('Catalog maintenance')
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [current] = await transaction<Array<{ uuid: string; name: string; slug: string; parentId: number | null }>>`
      SELECT c.id AS uuid, c.name, c.slug, parent.legacy_id AS "parentId"
      FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id
      WHERE c.legacy_id = ${id} FOR UPDATE OF c
    `
    if (!current) return null
    const parentId = body.parentId === undefined ? current.parentId : body.parentId
    let parentUuid: string | null = null
    if (parentId !== null) {
      const cycle = await transaction<{ id: string }[]>`
        WITH RECURSIVE descendants AS (
          SELECT id FROM categories WHERE id = ${current.uuid}
          UNION ALL SELECT child.id FROM categories child JOIN descendants parent ON child.parent_id = parent.id
        )
        SELECT candidate.id
        FROM categories candidate
        WHERE candidate.legacy_id = ${parentId} AND candidate.id NOT IN (SELECT id FROM descendants)
      `
      if (!cycle[0])
        throw createError({ statusCode: 400, statusMessage: 'La familia superior no existe o crearía un ciclo' })
      parentUuid = cycle[0].id
    }
    const baseSlug = slugify(body.name)
    const [updated] = await transaction<{ slug: string }[]>`
      UPDATE categories SET
        name = ${body.name}, parent_id = ${parentUuid},
        slug = CASE
          WHEN name = ${body.name} THEN slug
          WHEN EXISTS (SELECT 1 FROM categories other WHERE other.slug = ${baseSlug} AND other.id <> ${current.uuid})
            THEN ${`${baseSlug}-${id}`}
          ELSE ${baseSlug}
        END,
        updated_at = now()
      WHERE id = ${current.uuid}
      RETURNING slug
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'category.update', 'category', ${String(id)},
        ${transaction.json({ name: current.name, parentId: current.parentId })},
        ${transaction.json({ name: body.name, parentId })}, ${body.reason}, ${correlationId}
      )
    `
    return { id, slug: updated!.slug }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Familia no encontrada' })
  return result
})
