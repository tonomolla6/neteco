import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const sql = useDatabase()
  const flags = await sql`
    SELECT key, description, owner, enabled, targeting, expires_at AS "expiresAt",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM feature_flags ORDER BY key
  `
  return { flags }
})
