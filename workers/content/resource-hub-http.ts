import type { CmsPublicationDependencies } from '../cms/publication-gate'
import { CMS_PUBLIC_HEADERS } from '../cms/public-http'
import { listD1ResourceHub, readD1ResourceHub, ResourceHubError } from './resource-hub'
export function ownsResourceHubNamespace(path: string) {
  let candidate = path
  for (let n = 0; n < 4; n++) {
    if (/^\/api\/resources(?:[/\\%]|$)/i.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return false
    }
  }
  return false
}
export async function handleResourceHubHttp(
  request: Request,
  deps: CmsPublicationDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsResourceHubNamespace(url.pathname)) return null
  const error = (code: string, status: number) =>
    Response.json(
      { error: { code } },
      { status, headers: { ...CMS_PUBLIC_HEADERS, 'x-robots-tag': 'noindex, nofollow, noarchive' } }
    )
  const base = url.pathname === '/api/resources',
    detail = /^\/api\/resources\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname)
  if (!base && !detail) return error('not_found', 404)
  if (request.method !== 'GET')
    return Response.json(
      { error: { code: 'method_not_allowed' } },
      { status: 405, headers: { ...CMS_PUBLIC_HEADERS, Allow: 'GET' } }
    )
  if (url.search.length > 2048) return error('invalid_input', 400)
  const query: Record<string, string> = Object.create(null)
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) return error('invalid_input', 400)
    query[key] = value
  }
  if (!base && Object.keys(query).length) return error('invalid_input', 400)
  try {
    const dto = base ? await listD1ResourceHub(deps, query) : await readD1ResourceHub(deps, detail![1]!)
    return Response.json(dto, {
      headers: { ...CMS_PUBLIC_HEADERS, ...(dto.noindex ? { 'x-robots-tag': 'noindex, follow' } : {}) }
    })
  } catch (e) {
    return e instanceof ResourceHubError && e.code === 'not_found'
      ? error('not_found', 404)
      : e instanceof ResourceHubError && e.code === 'invalid_input'
        ? error('invalid_input', 400)
        : error('content_unavailable', 503)
  }
}
