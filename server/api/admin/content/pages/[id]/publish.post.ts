import { z } from 'zod'
import { useDatabase } from '../../../../../db/client'

const schema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.publish', { mfa: true })
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [page] = await transaction<{ draft: string | null; published: string | null }[]>`
      SELECT draft_version_id AS draft, published_version_id AS published
      FROM content_pages WHERE id = ${id} FOR UPDATE
    `
    if (!page) return null
    if (!page.draft) throw createError({ statusCode: 409, statusMessage: 'La página no tiene borrador publicable' })
    const [media] = await transaction<{ valid: boolean }[]>`
      SELECT NOT EXISTS (
        SELECT 1
        FROM content_versions version,
             jsonb_array_elements(version.blocks) block
        WHERE version.id = ${page.draft} AND block ->> 'type' = 'image'
          AND NOT EXISTS (
            SELECT 1 FROM media_assets asset
            WHERE asset.id = (block ->> 'assetId')::uuid
              AND asset.rights_status = 'approved' AND asset.quarantine_status = 'clean'
          )
      ) AS valid
    `
    if (!media?.valid) {
      throw createError({
        statusCode: 409,
        statusMessage: 'La publicación contiene una imagen no aprobada o no disponible'
      })
    }
    await transaction`
      UPDATE content_pages SET status = 'published', published_version_id = ${page.draft},
        published_at = now(), updated_at = now() WHERE id = ${id}
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, reason, correlation_id)
      VALUES ('staff', ${authenticated.profile.id}, 'content.publish', 'content', ${id},
        ${transaction.json({ versionId: page.published })}, ${transaction.json({ versionId: page.draft })},
        ${body.reason}, ${correlationId})
    `
    return { id, publishedVersionId: page.draft }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Página no encontrada' })
  return result
})
