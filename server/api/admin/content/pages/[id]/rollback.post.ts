import { z } from 'zod'
import { useDatabase } from '../../../../../db/client'
import type { ContentBlock } from '../../../../../utils/content-schema'

const schema = z.object({ versionId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }).strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.publish', { mfa: true })
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [page] = await transaction<{ draft: string | null }[]>`
      SELECT draft_version_id AS draft FROM content_pages WHERE id = ${id} FOR UPDATE
    `
    const [source] = await transaction<
      { blocks: ContentBlock[]; seo: { title: string; description: string; noindex: boolean } }[]
    >`
      SELECT blocks, seo FROM content_versions WHERE id = ${body.versionId} AND page_id = ${id}
    `
    if (!page || !source) return null
    const [next] = await transaction<{ version: number }[]>`
      SELECT max(version)::int + 1 AS version FROM content_versions WHERE page_id = ${id}
    `
    const [restored] = await transaction<{ id: string }[]>`
      INSERT INTO content_versions (page_id, version, blocks, seo, change_summary, based_on_id, created_by)
      VALUES (${id}, ${next!.version}, ${transaction.json(source.blocks)}, ${transaction.json(source.seo)},
              ${body.reason}, ${body.versionId}, ${authenticated.profile.id}) RETURNING id
    `
    await transaction`
      UPDATE content_pages SET draft_version_id = ${restored!.id}, status = 'draft', updated_at = now() WHERE id = ${id}
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, reason, correlation_id)
      VALUES ('staff', ${authenticated.profile.id}, 'content.rollback', 'content', ${id},
        ${transaction.json({ versionId: page.draft })},
        ${transaction.json({ restoredFrom: body.versionId, versionId: restored!.id })}, ${body.reason}, ${correlationId})
    `
    return { id, versionId: restored!.id, version: next!.version }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Página o versión no encontrada' })
  return result
})
