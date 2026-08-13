import { z } from 'zod'
import { useDatabase } from '../../db/client'

const schema = z
  .object({
    sourceTerm: z.string().trim().min(2).max(80),
    replacements: z.array(z.string().trim().min(2).max(80)).min(1).max(20)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const body = await readValidatedBody(event, schema.parse)
  const replacements = [...new Set(body.replacements.map((item) => item.toLocaleLowerCase('es-ES')))]
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [item] = await transaction<{ id: string }[]>`
      INSERT INTO search_synonyms (source_term, replacements, created_by, updated_by)
      VALUES (${body.sourceTerm}, ${replacements}, ${authenticated.profile.id}, ${authenticated.profile.id})
      RETURNING id
    `
    if (!item) throw new Error('Synonym insert returned no row')
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id
      ) VALUES (
        'staff', ${authenticated.profile.id}, 'search_synonym.create', 'search_synonym', ${item.id},
        ${transaction.json({ sourceTerm: body.sourceTerm, replacements })}, ${correlationId}
      )
    `
    return item
  })
  setResponseStatus(event, 201)
  return result
})
