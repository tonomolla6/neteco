import { previewComparisonQuerySchema, templateRegressionCheckSchema } from '../../shared/cms-preview-comparison'
import {
  compareCmsPreviewVersions,
  executeTemplateVisualRegressionCheck,
  PreviewComparisonError
} from './preview-comparison'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'

export interface PreviewHttpDeps {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
}

export function ownsCmsPreviewComparisonNamespace(pathname: string): boolean {
  return (
    pathname === '/api/admin/content/preview-comparison' ||
    pathname === '/api/admin/content/templates/critical-regression'
  )
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })
}

export async function handleCmsPreviewComparisonHttp(
  request: Request,
  deps: PreviewHttpDeps
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCmsPreviewComparisonNamespace(url.pathname)) return null

  // Origin / CSRF checks
  const originHeader = request.headers.get('origin')
  if (originHeader && originHeader !== deps.origin) {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return jsonResponse({ error: { code: 'unauthenticated' } }, 401)
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/admin/content/preview-comparison') {
      const parsed = previewComparisonQuerySchema.safeParse({
        pageId: url.searchParams.get('pageId'),
        baseVersion: url.searchParams.get('baseVersion'),
        compareVersion: url.searchParams.get('compareVersion'),
        breakpoint: url.searchParams.get('breakpoint') ?? 'desktop'
      })

      if (!parsed.success) {
        return jsonResponse({ error: { code: 'invalid_query', details: parsed.error.issues } }, 400)
      }

      const result = await compareCmsPreviewVersions(deps.database, {
        actorId: claims.identityId,
        pageId: parsed.data.pageId,
        baseVersion: parsed.data.baseVersion,
        compareVersion: parsed.data.compareVersion,
        breakpoint: parsed.data.breakpoint
      })

      return jsonResponse(result)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/content/templates/critical-regression') {
      const body: unknown = await request.json().catch(() => null)
      const parsed = templateRegressionCheckSchema.safeParse(body)
      if (!parsed.success) {
        return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
      }

      const result = await executeTemplateVisualRegressionCheck(deps.database, {
        actorId: claims.identityId,
        templateName: parsed.data.templateName,
        breakpoint: parsed.data.breakpoint,
        renderedSelectors: parsed.data.renderedSelectors
      })

      return jsonResponse(result)
    }

    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  } catch (err) {
    if (err instanceof PreviewComparisonError) {
      const status = err.code === 'forbidden' ? 403 : err.code.includes('not_found') ? 404 : 400
      return jsonResponse({ error: { code: err.code } }, status)
    }
    return jsonResponse({ error: { code: 'internal_error' } }, 500)
  }
}
