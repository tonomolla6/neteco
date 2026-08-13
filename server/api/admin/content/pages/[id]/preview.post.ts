import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { useDatabase } from '../../../../../db/client'

const schema = z
  .object({
    segment: z.string().trim().min(1).max(80).default('default'),
    device: z.enum(['responsive', 'desktop', 'mobile'])
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'catalog.write', { mfa: true })
  const id = z.string().uuid().parse(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  const sql = useDatabase()
  const [page] = await sql<{ slug: string; versionId: string | null }[]>`
    SELECT slug, draft_version_id AS "versionId" FROM content_pages WHERE id = ${id}
  `
  if (!page?.versionId) throw createError({ statusCode: 404, statusMessage: 'Borrador no encontrado' })
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await sql`
    INSERT INTO content_preview_tokens (page_id, version_id, token_hash, segment, device, expires_at, created_by)
    VALUES (${id}, ${page.versionId}, ${tokenHash}, ${body.segment}, ${body.device},
            now() + interval '30 minutes', ${authenticated.profile.id})
  `
  return { url: `/contenido/${page.slug}?preview=${encodeURIComponent(token)}`, expiresInSeconds: 1800 }
})
