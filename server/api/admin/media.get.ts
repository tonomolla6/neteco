import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'catalog.write', { mfa: true })
  const sql = useDatabase()
  const items = await sql`
    SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size AS bytes,
           width, height, owner_name AS "ownerName", license, authorized_at AS "authorizedAt",
           rights_status AS "rightsStatus", quarantine_status AS "quarantineStatus",
           alt_text AS "altText", source_url AS "sourceUrl", created_at AS "createdAt"
    FROM media_assets ORDER BY created_at DESC LIMIT 300
  `
  return { items }
})
