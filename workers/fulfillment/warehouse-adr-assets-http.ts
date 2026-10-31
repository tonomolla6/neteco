import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  createWarehouseLotRecord,
  generateAdrTransportDocument,
  generateClpContainerLabel,
  getVariantAdrSpec,
  getWarehouseHandlingInstructions,
  getWarehouseLotRecord,
  upsertVariantAdrSpec,
  WarehouseAdrError
} from './warehouse-adr-assets'

export interface WarehouseAdrAssetsHttpDependencies {
  database: D1Database
  claims?: VerifiedSessionClaims
  now?: string
}

export function ownsWarehouseAdrAssetsNamespace(path: string): boolean {
  return (
    path === '/api/warehouse/operational-assets' ||
    path.startsWith('/api/warehouse/operational-assets/') ||
    path === '/api/admin/warehouse/adr' ||
    path.startsWith('/api/admin/warehouse/adr/')
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

export async function handleWarehouseAdrAssetsHttp(
  request: Request,
  deps: WarehouseAdrAssetsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsWarehouseAdrAssetsNamespace(path)) return null

  try {
    // 1. GET /api/warehouse/operational-assets/variant/[:variantId]
    const variantMatch = path.match(/^\/api\/warehouse\/operational-assets\/variant\/([^/]+)$/)
    if (variantMatch && request.method === 'GET') {
      const variantId = variantMatch[1]!
      const spec = await getVariantAdrSpec(deps.database, variantId)
      if (!spec) return errorResponse('not_found', 404)
      const instructions = await getWarehouseHandlingInstructions(deps.database, variantId, undefined, deps.now)
      return jsonResponse({ spec, instructions }, 200, { 'Cache-Control': 'public, max-age=300' })
    }

    // 2. GET /api/warehouse/operational-assets/lot/[:lotNumber]
    const lotMatch = path.match(/^\/api\/warehouse\/operational-assets\/lot\/([^/]+)$/)
    if (lotMatch && request.method === 'GET') {
      const lotNumber = lotMatch[1]!
      const lot = await getWarehouseLotRecord(deps.database, lotNumber)
      if (!lot) return errorResponse('not_found', 404)
      return jsonResponse(lot, 200, { 'Cache-Control': 'public, max-age=60' })
    }

    // 3. POST /api/warehouse/operational-assets/generate-label
    if (path === '/api/warehouse/operational-assets/generate-label' && request.method === 'POST') {
      const body = (await request.json()) as { variantId: string; lotNumber: string }
      if (!body.variantId || !body.lotNumber) return errorResponse('invalid_input', 400)
      const label = await generateClpContainerLabel(deps.database, body.variantId, body.lotNumber, deps.now)
      return jsonResponse(label, 200)
    }

    // 4. POST /api/warehouse/operational-assets/transport-document
    if (path === '/api/warehouse/operational-assets/transport-document' && request.method === 'POST') {
      if (!deps.claims) return errorResponse('unauthenticated', 401)
      const body = (await request.json()) as never
      const doc = await generateAdrTransportDocument(deps.database, deps.claims, body, deps.now)
      return jsonResponse(doc, 200)
    }

    // 5. Admin endpoints
    if (path.startsWith('/api/admin/warehouse/adr')) {
      if (!deps.claims) return errorResponse('unauthenticated', 401)

      if (path === '/api/admin/warehouse/adr/spec' && request.method === 'POST') {
        const body = (await request.json()) as never
        const spec = await upsertVariantAdrSpec(deps.database, deps.claims, body, deps.now)
        return jsonResponse(spec, 201)
      }

      if (path === '/api/admin/warehouse/adr/lot' && request.method === 'POST') {
        const body = (await request.json()) as never
        const lot = await createWarehouseLotRecord(deps.database, deps.claims, body, deps.now)
        return jsonResponse(lot, 201)
      }
    }

    return errorResponse('not_found', 404)
  } catch (error) {
    if (error instanceof WarehouseAdrError) {
      const statusMap: Record<WarehouseAdrError['code'], number> = {
        invalid_input: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        version_conflict: 409,
        idempotency_conflict: 409,
        qa_quarantine_blocked: 422,
        qa_rejected_blocked: 422,
        internal_error: 500
      }
      return errorResponse(error.code, statusMap[error.code] ?? 500)
    }
    return errorResponse('internal_error', 500)
  }
}
