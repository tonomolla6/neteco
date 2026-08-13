import { useDatabase } from '../../../../db/client'
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'catalog.write', { mfa: true })
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const sql = useDatabase()
  const [page] = await sql`
    SELECT page.id, page.slug, page.title, page.status, page.draft_version_id AS "draftVersionId",
           page.published_version_id AS "publishedVersionId", page.updated_at AS "updatedAt"
    FROM content_pages page WHERE page.id = ${id}
  `
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Página no encontrada' })
  const versions = await sql`
    SELECT version.id, version.version, version.blocks, version.seo, version.change_summary AS "changeSummary",
           version.based_on_id AS "basedOnId", version.created_at AS "createdAt",
           COALESCE(identity.email::text, identity.id::text) AS author
    FROM content_versions version
    LEFT JOIN identities identity ON identity.id = version.created_by
    WHERE version.page_id = ${id}
    ORDER BY version.version DESC
  `
  return { ...page, versions }
})
