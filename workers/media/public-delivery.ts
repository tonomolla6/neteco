import { MAX_MEDIA_UPLOAD_BYTES } from '../catalog/media'
import { detectMediaType } from '../../shared/media-envelope'
import { eligibleMediaPublicationSql, type EligibleMediaPublicationRow } from './governance'
import { publicMediaInstant } from './public-catalog'

export const PUBLIC_MEDIA_IMAGE_WIDTHS = [64, 128, 256, 400, 640, 800, 1200, 1600] as const
export const PUBLIC_MEDIA_IMAGE_FORMATS = ['avif', 'webp', 'jpeg'] as const

export interface PublicMediaDependencies {
  database: D1Database
  bucket?: Pick<R2Bucket, 'get'>
  images?: Pick<ImagesBinding, 'input'>
  enabled: boolean
  /** Trusted internal clock, not request data. It is read again at final gate. */
  now?: () => string
}

type ImageFormat = (typeof PUBLIC_MEDIA_IMAGE_FORMATS)[number]
type DeliveryRoute =
  { id: string; kind: 'document' } | { id: string; kind: 'image'; width: number; format: ImageFormat }
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ROUTE = new RegExp(`^/media/(${UUID})/(document|image)$`)
const DOCUMENT_ROLES = new Set(['datasheet', 'sds', 'certificate', 'label'])
const SECURITY_HEADERS = {
  'cache-control': 'private, no-store',
  'cdn-cache-control': 'no-store',
  'cloudflare-cdn-cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'accept-ranges': 'none'
}

export class IntegrityError extends Error {}

/** Reserve unsafe aliases as well as the canonical namespace. The byte route
 * never falls through to Nitro/Assets because percent-encoded separators were
 * rejected. Call this handler before either renderer or static asset dispatch.
 */
export function isPublicMediaPath(pathname: string): boolean {
  let candidate = pathname
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (/^\/media(?:[/\\%]|$)/i.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return /^\/media/i.test(candidate)
    }
  }
  return /^\/media(?:[/\\%]|$)/i.test(candidate)
}

function error(request: Request, status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: { code } }), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra }
  })
}

function parseRoute(url: URL): DeliveryRoute | null {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1]!
  if (match[2] === 'document') return url.search ? null : { id, kind: 'document' }
  // No caller-controlled URL, origin, format negotiation or open-ended costs.
  const entries = [...url.searchParams.entries()]
  if (entries.length !== 2 || entries.some(([key]) => key !== 'w' && key !== 'format')) return null
  if (url.searchParams.getAll('w').length !== 1 || url.searchParams.getAll('format').length !== 1) return null
  const width = url.searchParams.get('w')!
  const format = url.searchParams.get('format')!
  if (
    !/^[1-9]\d{1,3}$/.test(width) ||
    !PUBLIC_MEDIA_IMAGE_WIDTHS.some((allowed) => allowed === Number(width)) ||
    !PUBLIC_MEDIA_IMAGE_FORMATS.some((allowed) => allowed === format)
  ) {
    return null
  }
  return { id, kind: 'image', width: Number(width), format: format as ImageFormat }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function ownedBytes(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  expected?: number
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  // One bounded allocation rather than retaining arbitrary numbers of provider
  // chunks. All reads are copied before awaiting the next provider boundary.
  const bytes = new Uint8Array(maximum)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > maximum - length) {
        await reader.cancel().catch(() => undefined)
        throw new IntegrityError('media_object_integrity')
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length || (expected !== undefined && length !== expected)) throw new IntegrityError('media_object_integrity')
  return length === maximum ? bytes : bytes.slice(0, length)
}

async function eligiblePublication(deps: PublicMediaDependencies, id: string) {
  return deps.database
    .prepare(
      `SELECT * FROM (${eligibleMediaPublicationSql(deps.now === undefined ? undefined : '?1')}) eligible WHERE id = ?`
    )
    .bind(deps.now === undefined ? null : publicMediaInstant(deps.now()), id)
    .first<EligibleMediaPublicationRow>()
}

function supportsRoute(row: EligibleMediaPublicationRow, route: DeliveryRoute): boolean {
  return route.kind === 'document'
    ? row.content_type === 'application/pdf' && DOCUMENT_ROLES.has(row.role)
    : (row.content_type === 'image/jpeg' || row.content_type === 'image/png') &&
        (row.role === 'main' || row.role === 'image' || row.role === 'label')
}

function publicationFingerprint(row: EligibleMediaPublicationRow): string {
  return JSON.stringify([
    row.id,
    row.upload_id,
    row.checksum,
    row.object_key,
    row.byte_size,
    row.r2_etag,
    row.version,
    row.scan_receipt_id,
    row.rights_decision_id
  ])
}

async function deliveryEtag(row: EligibleMediaPublicationRow, route: DeliveryRoute): Promise<string> {
  const content = JSON.stringify([
    row.id,
    row.version,
    row.checksum,
    route.kind,
    route.kind === 'image' ? route.width : null,
    route.kind === 'image' ? route.format : null
  ])
  return `"${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))}"`
}

function conditionalMatch(request: Request, etag: string): boolean {
  const value = request.headers.get('if-none-match')
  if (value === null || value.length > 4096) return false
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim()
    return trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`
  })
}

function attachmentFilename(row: EligibleMediaPublicationRow): string {
  // Bound and sanitize both the ASCII fallback and RFC 5987 display filename.
  // Never use an R2 metadata header or accept caller filenames at delivery.
  const title = Array.from(row.title.normalize('NFKC'))
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '/' || character === '\\'
        ? '-'
        : character
    )
    .join('')
    .slice(0, 120)
    .trim()
  const unicode = `${title || 'document'}.pdf`
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  const encoded = encodeURIComponent(unicode).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii || 'document'}.pdf"; filename*=UTF-8''${encoded}`
}

/** Public technical documents and responsive images only. Invoice/order media
 * has no matching role or route. Every request rechecks D1 and owned R2 bytes;
 * neither shared CDN caching nor raw-original fallbacks bypass withdrawal.
 */
export async function handlePublicMediaHttp(request: Request, deps: PublicMediaDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!isPublicMediaPath(url.pathname)) return null
  const route = parseRoute(url)
  if (!route) return error(request, 404, 'media_not_found')
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return error(request, 405, 'method_not_allowed', { allow: 'GET, HEAD' })
  if (!deps.enabled || !deps.bucket || (route.kind === 'image' && !deps.images))
    return error(request, 503, 'media_unavailable')
  try {
    const row = await eligiblePublication(deps, route.id)
    if (!row || !supportsRoute(row, route)) return error(request, 404, 'media_not_found')
    if (request.headers.has('range')) return error(request, 416, 'range_not_supported')
    if (
      !Number.isSafeInteger(row.byte_size) ||
      row.byte_size < 1 ||
      row.byte_size > MAX_MEDIA_UPLOAD_BYTES ||
      !/^[0-9a-f]{64}$/.test(row.checksum) ||
      row.object_key !== `quarantine/${row.upload_id}/${row.checksum}` ||
      !row.r2_etag
    ) {
      return error(request, 404, 'media_not_found')
    }
    // R2 lookup is only by the eligible row's immutable, server-generated key.
    const object = await deps.bucket.get(row.object_key)
    if (!object) return error(request, 404, 'media_not_found')
    if (
      object.key !== row.object_key ||
      object.size !== row.byte_size ||
      object.etag !== row.r2_etag ||
      !object.checksums.sha256 ||
      hex(object.checksums.sha256) !== row.checksum
    ) {
      await object.body.cancel().catch(() => undefined)
      return error(request, 404, 'media_not_found')
    }
    const original = await ownedBytes(object.body, row.byte_size, row.byte_size)
    if (hex(await crypto.subtle.digest('SHA-256', original)) !== row.checksum)
      return error(request, 404, 'media_not_found')
    try {
      if (detectMediaType(original) !== row.content_type) return error(request, 404, 'media_not_found')
    } catch {
      return error(request, 404, 'media_not_found')
    }
    const etag = await deliveryEtag(row, route)
    const notModified = conditionalMatch(request, etag)
    let body: Uint8Array<ArrayBuffer> = original
    let contentType = 'application/pdf'
    if (route.kind === 'image' && !notModified) {
      // The installed binding's response() has no arguments. Do not cast away
      // types to copy a newer docs signature; replace headers on our response.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(original)
          controller.close()
        }
      })
      const transformed = (
        await deps
          .images!.input(stream)
          .transform({ width: route.width })
          .output({ format: `image/${route.format}` })
      ).response()
      contentType = `image/${route.format}`
      if (!transformed.ok || transformed.headers.get('content-type') !== contentType || !transformed.body) {
        await transformed.body?.cancel()
        return error(request, 503, 'media_unavailable')
      }
      // Complete asynchronous output consumption before the final authority read.
      body = await ownedBytes(transformed.body, MAX_MEDIA_UPLOAD_BYTES)
    } else if (route.kind === 'image') {
      contentType = `image/${route.format}`
    }
    const current = await eligiblePublication(deps, route.id)
    if (!current || !supportsRoute(current, route) || publicationFingerprint(current) !== publicationFingerprint(row))
      return error(request, 404, 'media_not_found')
    const headers = {
      ...SECURITY_HEADERS,
      etag,
      'content-type': contentType,
      ...(route.kind === 'document'
        ? { 'content-disposition': attachmentFilename(row), 'content-security-policy': "default-src 'none'; sandbox" }
        : {})
    }
    if (notModified) return new Response(null, { status: 304, headers })
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { ...headers, 'content-length': String(body.byteLength) }
    })
  } catch (cause) {
    return cause instanceof IntegrityError
      ? error(request, 404, 'media_not_found')
      : error(request, 503, 'media_unavailable')
  }
}
