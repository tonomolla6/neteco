import { z } from 'zod'
import { useDatabase } from '../../../db/client'

const schema = z
  .object({
    sourceTerm: z.string().trim().min(2).max(80),
    replacements: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
    active: z.boolean()
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const id = getRouterParam(event, 'id')
  if (!id || !z.string().uuid().safeParse(id).success) throw createError({ statusCode: 404 })
  const body = await readValidatedBody(event, schema.parse)
  const replacements = [...new Set(body.replacements.map((item) => item.toLocaleLowerCase('es-ES')))]
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const updated = await sql.begin(async (transaction) => {
    const [before] = await transaction`
      SELECT source_term::text AS "sourceTerm", replacements, active
      FROM search_synonyms WHERE id = ${id} FOR UPDATE
    `
    if (!before) return false
    await transaction`
      UPDATE search_synonyms SET source_term = ${body.sourceTerm}, replacements = ${replacements},
        active = ${body.active}, updated_by = ${authenticated.profile.id}, updated_at = now()
      WHERE id = ${id}
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'search_synonym.update', 'search_synonym', ${id},
        ${transaction.json(before)}, ${transaction.json({ ...body, replacements })}, ${correlationId}
      )
    `
    return true
  })
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Sinónimo no encontrado' })
  return { ok: true }
})
