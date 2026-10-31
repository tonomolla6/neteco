import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  createDownloadableTemplate,
  getDownloadableTemplateBySlug,
  listDownloadableTemplates,
  publishDownloadableTemplate,
  updateDownloadableTemplate,
  generateTemplateAccessiblePdf,
  DownloadableTemplateError
} from './downloadable-templates'

export interface DownloadableTemplatesHttpDependencies {
  database: D1Database
  claims?: VerifiedSessionClaims
  now?: string
}

export function ownsDownloadableTemplatesNamespace(path: string): boolean {
  return (
    path === '/api/templates' ||
    path.startsWith('/api/templates/') ||
    path === '/api/admin/templates' ||
    path.startsWith('/api/admin/templates/')
  )
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...extraHeaders
    }
  })
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code } }, status)
}

export async function handleDownloadableTemplatesHttp(
  request: Request,
  deps: DownloadableTemplatesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsDownloadableTemplatesNamespace(path)) return null

  try {
    // 1. GET /api/templates/[:slug]/pdf
    const pdfMatch = path.match(/^\/api\/templates\/([a-z0-9-]+)\/pdf$/)
    if (pdfMatch && request.method === 'GET') {
      const slug = pdfMatch[1]!
      const template = await getDownloadableTemplateBySlug(deps.database, slug)
      if (!template) return errorResponse('not_found', 404)

      const pdfBytes = await generateTemplateAccessiblePdf(template)
      return new Response(pdfBytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${template.slug}.pdf"`,
          'Content-Length': pdfBytes.length.toString(),
          'Cache-Control': 'public, max-age=3600'
        }
      })
    }

    // 2. GET /api/templates/[:slug]
    const detailMatch = path.match(/^\/api\/templates\/([a-z0-9-]+)$/)
    if (detailMatch && request.method === 'GET') {
      const slug = detailMatch[1]!
      const template = await getDownloadableTemplateBySlug(deps.database, slug)
      if (!template) return errorResponse('not_found', 404)
      return jsonResponse(template, 200, {
        'Cache-Control': 'public, max-age=300'
      })
    }

    // 3. GET /api/templates
    if (path === '/api/templates' && request.method === 'GET') {
      const query = {
        q: url.searchParams.get('q') ?? '',
        category: url.searchParams.get('category') || undefined,
        type: url.searchParams.get('type') || undefined,
        page: url.searchParams.get('page') ?? '1',
        perPage: url.searchParams.get('perPage') ?? '20'
      }
      const list = await listDownloadableTemplates(deps.database, query)
      return jsonResponse(list, 200)
    }

    // 4. Admin endpoints
    if (path.startsWith('/api/admin/templates')) {
      if (!deps.claims) return errorResponse('unauthenticated', 401)

      if (path === '/api/admin/templates' && request.method === 'POST') {
        const body = (await request.json()) as never
        const created = await createDownloadableTemplate(deps.database, deps.claims, body, deps.now)
        return jsonResponse(created, 201)
      }

      if (path === '/api/admin/templates/publish' && request.method === 'POST') {
        const body = (await request.json()) as never
        const published = await publishDownloadableTemplate(deps.database, deps.claims, body, deps.now)
        return jsonResponse(published, 200)
      }

      if (path === '/api/admin/templates' && request.method === 'PUT') {
        const body = (await request.json()) as never
        const updated = await updateDownloadableTemplate(deps.database, deps.claims, body, deps.now)
        return jsonResponse(updated, 200)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof DownloadableTemplateError) {
      const statusMap: Record<DownloadableTemplateError['code'], number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409,
        internal_error: 500
      }
      return errorResponse(error.code, statusMap[error.code] ?? 500)
    }
    return errorResponse('internal_error', 500)
  }
}
