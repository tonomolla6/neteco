import { useDatabase } from '../../../db/client'

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'catalog.write', { mfa: true })
  const sql = useDatabase()
  const pages = await sql`
    SELECT page.id, page.slug, page.title, page.status,
           draft.version AS "draftVersion", published.version AS "publishedVersion",
           page.updated_at AS "updatedAt", page.published_at AS "publishedAt",
           page.scheduled_publish_at AS "scheduledPublishAt",
           page.scheduled_unpublish_at AS "scheduledUnpublishAt"
    FROM content_pages page
    LEFT JOIN content_versions draft ON draft.id = page.draft_version_id
    LEFT JOIN content_versions published ON published.id = page.published_version_id
    ORDER BY lower(page.title)
  `
  return { pages }
})
