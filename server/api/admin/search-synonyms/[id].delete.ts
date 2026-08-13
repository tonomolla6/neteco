import { z } from 'zod'
import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const id = getRouterParam(event, 'id')
  if (!id || !z.string().uuid().safeParse(id).success) throw createError({ statusCode: 404 })
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const deleted = await sql.begin(async (transaction) => {
    const [item] = await transaction`
      DELETE FROM search_synonyms WHERE id = ${id}
      RETURNING source_term::text AS "sourceTerm", replacements, active
    `
    if (!item) return false
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'search_synonym.delete', 'search_synonym', ${id},
        ${transaction.json(item)}, ${correlationId}
      )
    `
    return true
  })
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Sinónimo no encontrado' })
  return { ok: true }
})
