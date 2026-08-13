import { useDatabase } from '../../../db/client'
import { contentDocumentSchema } from '../../../utils/content-schema'

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const body = await readValidatedBody(event, contentDocumentSchema.parse)
  const sql = useDatabase()
  const correlationId = event.context.correlationId ?? crypto.randomUUID()
  const page = await sql.begin(async (transaction) => {
    const [created] = await transaction<{ id: string }[]>`
      INSERT INTO content_pages (slug, title, created_by)
      VALUES (${body.slug}, ${body.title}, ${authenticated.profile.id}) RETURNING id
    `
    if (!created) throw new Error('Content page insert returned no row')
    const [version] = await transaction<{ id: string }[]>`
      INSERT INTO content_versions (page_id, version, blocks, seo, change_summary, created_by)
      VALUES (${created.id}, 1, ${transaction.json(body.blocks)}, ${transaction.json(body.seo)},
              ${body.changeSummary}, ${authenticated.profile.id})
      RETURNING id
    `
    await transaction`UPDATE content_pages SET draft_version_id = ${version!.id} WHERE id = ${created.id}`
    await transaction`
      INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
        after_redacted, reason, correlation_id)
      VALUES ('staff', ${authenticated.profile.id}, 'content.create', 'content', ${created.id},
        ${transaction.json({ slug: body.slug, version: 1 })}, ${body.changeSummary}, ${correlationId})
    `
    return { id: created.id, version: 1 }
  })
  setResponseStatus(event, 201)
  return page
})
