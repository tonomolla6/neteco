import { z } from 'zod'
import { useDatabase } from '../../../../db/client'

const schema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3).max(500).default('Publication status update')
})

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const [product] = await sql<{ uuid: string; previous: string }[]>`
    UPDATE products SET status = ${body.active ? 'published' : 'hidden'},
      published_at = CASE WHEN ${body.active} THEN COALESCE(published_at, now()) ELSE published_at END,
      updated_at = now()
    WHERE legacy_id = ${id}
    RETURNING id AS uuid, status AS previous
  `
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  await sql`
    INSERT INTO audit_log (
      actor_type, actor_id, action, resource_type, resource_id, after_redacted, reason, correlation_id
    ) VALUES (
      'staff', ${administrator.id}, 'product.publication.update', 'product', ${String(id)},
      ${sql.json({ active: body.active })}, ${body.reason}, ${correlationId}
    )
  `
  return { id, active: body.active }
})
