import { z } from 'zod'
import { cmsPublicPageSchema } from '../../shared/cms-publication'
import { catalogPolicyUuidSchema as uuid } from '../../shared/catalog-publication-policy'
import {
  cmsNow,
  cmsSource,
  cmsVersion,
  cmsDocumentMedia,
  cmsPublishedValiditySql,
  cmsLinksValidSql,
  CmsPublicationError,
  type CmsPublicationDependencies
} from './publication-gate'
import { verifyCmsPreview } from './preview'
export const CMS_PUBLIC_HEADERS = {
  'cache-control': 'private, no-store',
  'cdn-cache-control': 'no-store',
  'cloudflare-cdn-cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}
export async function readCmsPublicPage(deps: CmsPublicationDependencies, slug: string, previewToken?: string) {
  if (!deps.enabled || !/^[a-z0-9][a-z0-9-]{0,159}$/.test(slug)) throw new CmsPublicationError('not_found')
  let ownerId: string,
    pageId: string,
    versionId: string,
    device: 'responsive' | 'desktop' | 'mobile' | null = null
  const preview = previewToken !== undefined ? await verifyCmsPreview(deps, previewToken) : null
  if (preview) {
    ownerId = preview.id
    pageId = preview.pageId
    versionId = preview.versionId
    device = preview.device
  } else {
    const row = await deps.database
      .prepare(
        `SELECT release.id,release.page_id,release.version_id FROM content_publications release
   JOIN content_publication_states head ON head.page_id=release.page_id WHERE release.slug=?1 AND ${cmsPublishedValiditySql('release', 'head', '?2')}`
      )
      .bind(slug, cmsNow(deps))
      .first()
    if (row === null) throw new CmsPublicationError('not_found')
    const release = cmsSource(z.object({ id: uuid, page_id: uuid, version_id: uuid }).strict(), row)
    ownerId = release.id
    pageId = release.page_id
    versionId = release.version_id
  }
  const version = await cmsVersion(deps.database, pageId, versionId)
  if (version.document.slug !== slug) throw new CmsPublicationError('not_found')
  const checkResourceReview = () => {
    const resource = version.document.resourceHub
    if (!preview && resource) {
      const now = cmsNow(deps)
      if (resource.reviewedAt > now || resource.reviewDueAt <= now) throw new CmsPublicationError('not_found')
    }
  }
  checkResourceReview()
  await cmsDocumentMedia(deps, version.document)
  const links = await deps.database
    .prepare('SELECT id,block_id FROM content_media_links WHERE owner_id=? AND version_id=? ORDER BY block_id')
    .bind(ownerId, versionId)
    .all()
  if (links.success !== true) throw new CmsPublicationError('read_unconfirmed')
  const rows = cmsSource(z.array(z.object({ id: uuid, block_id: uuid }).strict()).max(200), links.results)
  const media = Object.fromEntries(
    rows.map((link) => [
      link.block_id,
      `/api/content-media/${link.id}/image?w=1200&format=webp${previewToken === undefined ? '' : `&preview=${encodeURIComponent(previewToken)}`}`
    ])
  )
  const gate = await deps.database
    .prepare(`SELECT ${cmsLinksValidSql('?1', '?2', '?3')} AS valid`)
    .bind(ownerId, versionId, cmsNow(deps))
    .first()
  if (!gate || cmsSource(z.object({ valid: z.union([z.literal(0), z.literal(1)]) }).strict(), gate).valid !== 1)
    throw new CmsPublicationError('not_found')
  if (previewToken !== undefined) await verifyCmsPreview(deps, previewToken)
  else {
    const current = await deps.database
      .prepare(
        `SELECT release.id FROM content_publications release JOIN content_publication_states head ON head.page_id=release.page_id WHERE release.id=?1 AND ${cmsPublishedValiditySql('release', 'head', '?2')}`
      )
      .bind(ownerId, cmsNow(deps))
      .first()
    if (current === null) throw new CmsPublicationError('not_found')
    cmsSource(z.object({ id: z.literal(ownerId) }).strict(), current)
  }
  checkResourceReview()
  return cmsPublicPageSchema.parse({
    source: 'cloudflare',
    pageId,
    title: version.document.title,
    slug,
    status: preview ? 'preview' : 'published',
    blocks: version.document.blocks,
    ...(version.document.promotional ? { promotional: version.document.promotional } : {}),
    ...(version.document.resourceHub ? { resourceHub: version.document.resourceHub } : {}),
    seo: version.document.seo,
    version: version.version,
    preview: preview !== null,
    previewDevice: device,
    previewSegment: preview ? 'default' : null,
    media
  })
}
export function ownsCmsPublicNamespace(pathname: string) {
  let path = pathname
  for (let n = 0; n < 4; n++) {
    if (/^\/api\/content(?:[/\\%]|$)/.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return false
      path = decoded
    } catch {
      return false
    }
  }
  return false
}
export async function handleCmsPublicHttp(
  request: Request,
  deps: CmsPublicationDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCmsPublicNamespace(url.pathname)) return null
  const error = (code: string, status: number) =>
    Response.json(
      { error: { code } },
      { status, headers: { ...CMS_PUBLIC_HEADERS, 'x-robots-tag': 'noindex, nofollow, noarchive' } }
    )
  const match = /^\/api\/content\/([a-z0-9][a-z0-9-]{0,159})$/.exec(url.pathname)
  if (!match) return error('not_found', 404)
  if (request.method !== 'GET') return error('method_not_allowed', 405)
  if ([...url.searchParams.keys()].some((key) => key !== 'preview') || url.searchParams.getAll('preview').length > 1)
    return error('invalid_input', 400)
  try {
    const page = await readCmsPublicPage(
      deps,
      match[1]!,
      url.searchParams.has('preview') ? url.searchParams.get('preview')! : undefined
    )
    return Response.json(page, {
      headers: {
        ...CMS_PUBLIC_HEADERS,
        ...(page.preview || page.seo.noindex ? { 'x-robots-tag': 'noindex, nofollow, noarchive' } : {})
      }
    })
  } catch (error) {
    return error instanceof CmsPublicationError &&
      ['not_found', 'media_blocked', 'media_unavailable'].includes(error.code)
      ? Response.json({ error: { code: 'not_found' } }, { status: 404, headers: CMS_PUBLIC_HEADERS })
      : Response.json({ error: { code: 'content_unavailable' } }, { status: 503, headers: CMS_PUBLIC_HEADERS })
  }
}

/** Only genuinely published historical slugs redirect. Draft reservations and
 * preview bearers are never forwarded into another release or query string. */
export async function resolveCmsPublicRedirect(
  request: Request,
  deps: CmsPublicationDependencies
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/contenido\/([a-z0-9][a-z0-9-]{0,159})$/.exec(url.pathname)
  if (!deps.enabled || !match || url.searchParams.has('preview')) return null
  const raw = await deps.database
    .prepare(
      `SELECT release.slug FROM content_publications old
 JOIN content_publication_states head ON head.page_id=old.page_id JOIN content_publications release ON release.id=head.publication_id
 WHERE old.slug=?1 AND release.slug<>?1 AND ${cmsPublishedValiditySql('release', 'head', '?2')} LIMIT 1`
    )
    .bind(match[1], cmsNow(deps))
    .first()
  if (raw === null) return null
  const target = cmsSource(z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/) }).strict(), raw)
  await readCmsPublicPage(deps, target.slug)
  return new Response(null, { status: 301, headers: { ...CMS_PUBLIC_HEADERS, location: `/contenido/${target.slug}` } })
}
export async function listCmsSitemapPages(
  deps: CmsPublicationDependencies,
  options: { limit?: number; offset?: number } = {}
) {
  if (!deps.enabled) return []
  const limit = options.limit ?? 1000,
    offset = options.offset ?? 0
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 50000
  )
    throw new Error('invalid_cms_sitemap_pagination')
  const rows = await deps.database
    .prepare(
      `SELECT release.slug,release.published_at AS publishedAt FROM content_publications release
 JOIN content_publication_states head ON head.page_id=release.page_id JOIN content_versions version ON version.id=release.version_id
 WHERE ${cmsPublishedValiditySql('release', 'head', '?1')} AND json_extract(version.document,'$.seo.noindex')=0
 ORDER BY release.slug LIMIT ?2 OFFSET ?3`
    )
    .bind(cmsNow(deps), limit, offset)
    .all()
  if (rows.success !== true) throw new CmsPublicationError('read_unconfirmed')
  return cmsSource(
    z
      .array(
        z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/), publishedAt: z.string().datetime() }).strict()
      )
      .max(limit),
    rows.results
  )
}
