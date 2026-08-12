import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const [product] = await sql<{ uuid: string; name: string }[]>`
    UPDATE products SET status = 'discontinued', featured = false, updated_at = now()
    WHERE legacy_id = ${id}
    RETURNING id AS uuid, name
  `
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  await sql.begin(async (transaction) => {
    await transaction`UPDATE variants SET status = 'discontinued', updated_at = now() WHERE product_id = ${product.uuid}`
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'product.discontinue', 'product', ${String(id)},
        ${transaction.json({ name: product.name })}, 'Preserve historical order references', ${correlationId}
      )
    `
  })
  return { ok: true }
})
