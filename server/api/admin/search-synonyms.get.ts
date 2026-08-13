import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'catalog.write', { mfa: true })
  const sql = useDatabase()
  const items = await sql`
    SELECT id, source_term::text AS "sourceTerm", replacements, active, updated_at AS "updatedAt"
    FROM search_synonyms ORDER BY lower(source_term::text)
  `
  return { items }
})
