import { createHash } from 'node:crypto'
import { useDatabase } from '../../db/client'
import { contentBlockSchema } from '../../utils/content-schema'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  const preview = String(getQuery(event).preview ?? '')
  const sql = useDatabase()
  const [page] = await sql<
    Array<{
      title: string
      slug: string
      status: string
      blocks: unknown
      seo: unknown
      version: number
      previewDevice: string | null
      previewSegment: string | null
    }>
  >`
    SELECT page.title, page.slug, page.status, version.blocks, version.seo, version.version,
           token.device AS "previewDevice", token.segment AS "previewSegment"
    FROM content_pages page
    LEFT JOIN content_preview_tokens token ON token.page_id = page.id
      AND token.token_hash = ${createHash('sha256').update(preview).digest('hex')}
      AND token.revoked_at IS NULL AND token.expires_at > now()
    JOIN content_versions version ON version.id = CASE
      WHEN ${preview} <> '' THEN token.version_id ELSE page.published_version_id END
    WHERE page.slug = ${slug ?? ''}
      AND ((${preview} = '' AND page.status = 'published') OR (${preview} <> '' AND token.id IS NOT NULL))
    LIMIT 1
  `
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Contenido no encontrado' })
  const blocks = contentBlockSchema.array().parse(page.blocks)
  if (preview) {
    setResponseHeaders(event, { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  } else {
    setResponseHeader(event, 'cache-control', 'public, max-age=60, s-maxage=300')
  }
  return { ...page, blocks, preview: !!preview }
})
