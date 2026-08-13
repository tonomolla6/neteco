import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const product = await sql.begin(async (transaction) => {
    const [current] = await transaction<{ uuid: string; name: string; status: string }[]>`
      SELECT id AS uuid, name, status FROM products WHERE legacy_id = ${id} FOR UPDATE
    `
    if (!current) return null
    await transaction`
      UPDATE products SET status = 'discontinued', featured = false, updated_at = now()
      WHERE id = ${current.uuid}
    `
    await transaction`UPDATE variants SET status = 'discontinued', updated_at = now() WHERE product_id = ${current.uuid}`
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'product.discontinue', 'product', ${String(id)},
        ${transaction.json({ name: current.name, status: current.status })},
        'Preserve historical order references', ${correlationId}
      )
    `
    return current
  })
  if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
  return { ok: true }
})
