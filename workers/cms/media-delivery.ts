import { z } from 'zod'
import { catalogPolicyUuidSchema as uuid } from '../../shared/catalog-publication-policy'
import {
  cmsNow,
  cmsSource,
  cmsEvidence,
  cmsOwnedImage,
  cmsPublishedValiditySql,
  cmsLinksValidSql,
  CmsPublicationError,
  type CmsPublicationDependencies
} from './publication-gate'
import { verifyCmsPreview } from './preview'
import { ownedBytes, PUBLIC_MEDIA_IMAGE_WIDTHS, PUBLIC_MEDIA_IMAGE_FORMATS } from '../media/public-delivery'
import { CMS_PUBLIC_HEADERS } from './public-http'
export async function handleCmsMediaHttp(request: Request, deps: CmsPublicationDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  let decoded = url.pathname
  for (let n = 0; n < 4; n++) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  if (!/^\/api\/content-media(?:[/\\%]|$)/.test(decoded)) return null
  const failure = (status: number) =>
    Response.json({ error: { code: 'media_not_found' } }, { status, headers: CMS_PUBLIC_HEADERS })
  const match = /^\/api\/content-media\/([^/]+)\/image$/.exec(url.pathname)
  if (!match || !uuid.safeParse(match[1]).success) return failure(404)
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405)
  if (!deps.enabled || !deps.images || !deps.bucket) return failure(503)
  if (request.headers.has('range')) return failure(416)
  const query = url.searchParams,
    width = query.get('w'),
    format = query.get('format')
  if (
    [...query.keys()].some((k) => !['w', 'format', 'preview'].includes(k)) ||
    ['w', 'format', 'preview'].some((k) => query.getAll(k).length > 1) ||
    !PUBLIC_MEDIA_IMAGE_WIDTHS.some((w) => String(w) === width) ||
    !PUBLIC_MEDIA_IMAGE_FORMATS.some((f) => f === format)
  )
    return failure(404)
  try {
    const row = await deps.database
      .prepare(
        'SELECT id,owner_id,owner_kind,version_id,upload_id,scan_receipt_id,rights_decision_id FROM content_media_links WHERE id=?'
      )
      .bind(match[1])
      .first()
    if (row === null) return failure(404)
    const link = cmsSource(
      z
        .object({
          id: uuid,
          owner_id: uuid,
          owner_kind: z.enum(['publication', 'preview', 'schedule']),
          version_id: uuid,
          upload_id: uuid,
          scan_receipt_id: uuid,
          rights_decision_id: uuid
        })
        .strict(),
      row
    )
    async function allowed() {
      if (link.owner_kind === 'preview') {
        if (!query.has('preview')) throw new CmsPublicationError('not_found')
        const preview = await verifyCmsPreview(deps, query.get('preview')!)
        if (preview.id !== link.owner_id || preview.versionId !== link.version_id)
          throw new CmsPublicationError('not_found')
      } else if (link.owner_kind === 'publication') {
        if (query.has('preview')) throw new CmsPublicationError('not_found')
        const current = await deps.database
          .prepare(
            `SELECT release.id FROM content_publications release JOIN content_publication_states head ON head.page_id=release.page_id WHERE release.id=?1 AND ${cmsPublishedValiditySql('release', 'head', '?2')}`
          )
          .bind(link.owner_id, cmsNow(deps))
          .first()
        if (current === null) throw new CmsPublicationError('not_found')
        cmsSource(z.object({ id: z.literal(link.owner_id) }).strict(), current)
      } else throw new CmsPublicationError('not_found')
      const valid = await deps.database
        .prepare(`SELECT ${cmsLinksValidSql('?1', '?2', '?3')} AS valid`)
        .bind(link.owner_id, link.version_id, cmsNow(deps))
        .first()
      if (cmsSource(z.object({ valid: z.literal(1) }).strict(), valid).valid !== 1)
        throw new CmsPublicationError('not_found')
    }
    await allowed()
    const evidence = await cmsEvidence(deps, link.upload_id)
    if (evidence.scan_receipt_id !== link.scan_receipt_id || evidence.rights_decision_id !== link.rights_decision_id)
      return failure(404)
    const bytes = await cmsOwnedImage(deps, evidence),
      stream = new Blob([bytes]).stream()
    const outputFormat = format === 'avif' ? 'image/avif' : format === 'webp' ? 'image/webp' : 'image/jpeg'
    const output = await deps.images
      .input(stream)
      .transform({ width: Number(width), fit: 'scale-down' })
      .output({ format: outputFormat })
    const response = output.response(),
      derivative = await ownedBytes(response.body!, 10485760)
    if (response.headers.get('content-type') !== outputFormat) throw new CmsPublicationError('media_blocked')
    await cmsEvidence(deps, link.upload_id)
    await allowed()
    return new Response(request.method === 'HEAD' ? null : derivative, {
      headers: {
        ...CMS_PUBLIC_HEADERS,
        'content-type': response.headers.get('content-type')!,
        'content-length': String(derivative.length),
        'accept-ranges': 'none'
      }
    })
  } catch {
    return failure(404)
  }
}
