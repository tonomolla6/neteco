import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  createOfficialCertification,
  getBrandCenterView,
  getOfficialCertificationByNumber,
  listOfficialCertifications,
  authorizeBrandPartner,
  upsertBrandAsset,
  BrandCenterError
} from './brand-center'

export interface BrandCenterHttpDependencies {
  database: D1Database
  claims?: VerifiedSessionClaims
  now?: string
}

export function ownsBrandCenterNamespace(path: string): boolean {
  return (
    path === '/api/brand-center' ||
    path.startsWith('/api/brand-center/') ||
    path === '/api/admin/brand-center' ||
    path.startsWith('/api/admin/brand-center/')
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

export async function handleBrandCenterHttp(
  request: Request,
  deps: BrandCenterHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsBrandCenterNamespace(path)) return null

  try {
    // 1. GET /api/brand-center/verify/[:certNumber]
    if (path.startsWith('/api/brand-center/verify/') && request.method === 'GET') {
      const rawNumber = path.slice('/api/brand-center/verify/'.length)
      const certNumber = decodeURIComponent(rawNumber)
      const cert = await getOfficialCertificationByNumber(deps.database, certNumber)
      if (!cert) return errorResponse('not_found', 404)
      return jsonResponse(cert, 200, { 'Cache-Control': 'public, max-age=300' })
    }

    // 2. GET /api/brand-center/certifications
    if (path === '/api/brand-center/certifications' && request.method === 'GET') {
      const list = await listOfficialCertifications(deps.database, deps.now)
      return jsonResponse(list, 200, { 'Cache-Control': 'public, max-age=300' })
    }

    // 3. GET /api/brand-center
    if (path === '/api/brand-center' && request.method === 'GET') {
      const view = await getBrandCenterView(deps.database, deps.now)
      return jsonResponse(view, 200, { 'Cache-Control': 'public, max-age=300' })
    }

    // 4. Admin routes
    if (path.startsWith('/api/admin/brand-center')) {
      if (!deps.claims) return errorResponse('unauthenticated', 401)

      if (path === '/api/admin/brand-center/certifications' && request.method === 'POST') {
        const body = await request.json()
        const created = await createOfficialCertification(deps.database, deps.claims, body, deps.now)
        return jsonResponse(created, 201)
      }

      if (path === '/api/admin/brand-center/partners' && request.method === 'POST') {
        const body = (await request.json()) as never
        const auth = await authorizeBrandPartner(deps.database, deps.claims, body, deps.now)
        return jsonResponse(auth, 201)
      }

      if (path === '/api/admin/brand-center/assets' && request.method === 'POST') {
        const body = (await request.json()) as never
        const asset = await upsertBrandAsset(deps.database, deps.claims, body, deps.now)
        return jsonResponse(asset, 201)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof BrandCenterError) {
      const statusMap: Record<BrandCenterError['code'], number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409,
        unaccredited_claim: 422,
        internal_error: 500
      }
      return errorResponse(error.code, statusMap[error.code] ?? 500)
    }
    return errorResponse('internal_error', 500)
  }
}
