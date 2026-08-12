import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [category] = await transaction<{ id: string; name: string }[]>`
      SELECT id, name FROM categories WHERE legacy_id = ${id} FOR UPDATE
    `
    if (!category) return false
    const [usage] = await transaction<{ children: number; products: number }[]>`
      SELECT
        (SELECT count(*)::int FROM categories WHERE parent_id = ${category.id}) AS children,
        (SELECT count(*)::int FROM products WHERE category_id = ${category.id}) AS products
    `
    if (usage?.children) throw createError({ statusCode: 409, statusMessage: 'La familia tiene subfamilias' })
    if (usage?.products) throw createError({ statusCode: 409, statusMessage: 'La familia tiene productos' })
    await transaction`DELETE FROM categories WHERE id = ${category.id}`
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${administrator.id}, 'category.delete', 'category', ${String(id)},
        ${transaction.json({ name: category.name })}, 'Empty category removal', ${correlationId}
      )
    `
    return true
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Familia no encontrada' })
  return { ok: true }
})
