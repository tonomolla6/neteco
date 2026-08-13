import { useDatabase } from '../../../../db/client'
import { contentDocumentSchema } from '../../../../utils/content-schema'
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, contentDocumentSchema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const result = await sql.begin(async (transaction) => {
    const [page] = await transaction<{ draftVersionId: string | null; slug: string }[]>`
      SELECT draft_version_id AS "draftVersionId", slug FROM content_pages WHERE id = ${id} FOR UPDATE
    `
    if (!page) return null
    const [next] = await transaction<{ version: number }[]>`
      SELECT COALESCE(max(version), 0)::int + 1 AS version FROM content_versions WHERE page_id = ${id}
    `
    const [version] = await transaction<{ id: string }[]>`
      INSERT INTO content_versions (page_id, version, blocks, seo, change_summary, based_on_id, created_by)
      VALUES (${id}, ${next!.version}, ${transaction.json(body.blocks)}, ${transaction.json(body.seo)},
              ${body.changeSummary}, ${page.draftVersionId}, ${authenticated.profile.id})
      RETURNING id
    `
    if (page.slug !== body.slug) {
      await transaction`
        INSERT INTO canonical_redirects (source_path, destination_path, resource_type, resource_id,
          created_by, reason)
        VALUES (${`/contenido/${page.slug}`}, ${`/contenido/${body.slug}`}, 'content', ${id},
          ${authenticated.profile.id}, ${body.changeSummary})
        ON CONFLICT (source_path) DO UPDATE SET destination_path = EXCLUDED.destination_path,
          created_by = EXCLUDED.created_by, reason = EXCLUDED.reason, created_at = now()
      `
      await transaction`
        UPDATE canonical_redirects SET destination_path = ${`/contenido/${body.slug}`}
        WHERE destination_path = ${`/contenido/${page.slug}`}
      `
    }
    await transaction`
      UPDATE content_pages SET slug = ${body.slug}, title = ${body.title}, draft_version_id = ${version!.id},
        updated_at = now() WHERE id = ${id}
    `
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        before_redacted, after_redacted, reason, correlation_id)
      VALUES ('staff', ${authenticated.profile.id}, 'content.version.create', 'content', ${id},
        ${transaction.json({ versionId: page.draftVersionId })},
        ${transaction.json({ versionId: version!.id, version: next!.version })}, ${body.changeSummary}, ${correlationId})
    `
    return { id, versionId: version!.id, version: next!.version }
  })
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Página no encontrada' })
  return result
})
