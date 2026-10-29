import type { CmsPublicationDependencies } from './publication-gate'
import { readD1PromotionalContent, PromotionalContentError } from './promotional-content'
import { CMS_PUBLIC_HEADERS } from './public-http'

export function ownsPromotionalContentNamespace(pathname: string) {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/promotional-content(?:[/\\%]|$)/i.test(path)) return true
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
export async function handlePromotionalContentHttp(
  request: Request,
  deps: CmsPublicationDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPromotionalContentNamespace(url.pathname)) return null
  const fail = (code: string, status: number, extra: Record<string, string> = {}) =>
    Response.json(
      { error: { code } },
      { status, headers: { ...CMS_PUBLIC_HEADERS, 'x-robots-tag': 'noindex, nofollow', ...extra } }
    )
  if (url.pathname !== '/api/promotional-content') return fail('not_found', 404)
  if (request.method !== 'GET') return fail('method_not_allowed', 405, { allow: 'GET' })
  const allowed = ['placement', 'path', 'categorySlug', 'productSlug']
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
    return fail('invalid_input', 400)
  try {
    const response = await readD1PromotionalContent(deps, Object.fromEntries(url.searchParams))
    return Response.json(response, { headers: CMS_PUBLIC_HEADERS })
  } catch (error) {
    return error instanceof PromotionalContentError && error.code === 'invalid_input'
      ? fail('invalid_input', 400)
      : fail('content_unavailable', 503)
  }
}
