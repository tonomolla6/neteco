import { readJsonBody, serverInstant } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  authorizeCatalog,
  createSupplier,
  upsertSupplierOffering,
  selectAndRecordSourcingDecision,
  listSupplierOfferings,
  listSourcingDecisions,
  SupplierSourcingError
} from './supplier-sourcing'

export interface SupplierSourcingHttpDependencies {
  database: D1Database
  origin?: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer'
    }
  })
}

function failure(code: string, status = 500): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsSupplierSourcingNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/supplier-sourcing(?:[/\\%]|$)/i.test(pathname)) {
      return true
    }
    try {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    } catch {
      break
    }
  }
  return false
}

export async function handleSupplierSourcingHttp(
  request: Request,
  deps: SupplierSourcingHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSupplierSourcingNamespace(url.pathname)) return null

  const claims = deps.sessionCookieConfiguration
    ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
    : null
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  const now = deps.now ? deps.now() : serverInstant()

  try {
    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-sourcing/supplier') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await createSupplier(deps.database, claims, body, { now })
      return jsonResponse(result, 201)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-sourcing/offering') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await upsertSupplierOffering(deps.database, claims, body, { now })
      return jsonResponse(result, 200)
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/supplier-sourcing/decision') {
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await selectAndRecordSourcingDecision(deps.database, claims, body, { now })
      return jsonResponse(result, 201)
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/supplier-sourcing/offerings') {
      await authorizeCatalog(deps.database, claims, now)
      const variantId = url.searchParams.get('variantId')
      if (!variantId) {
        return failure('missing_variant_id', 400)
      }
      const result = await listSupplierOfferings(deps.database, variantId)
      return jsonResponse(result, 200)
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/supplier-sourcing/decisions') {
      await authorizeCatalog(deps.database, claims, now)
      const variantId = url.searchParams.get('variantId')
      if (!variantId) {
        return failure('missing_variant_id', 400)
      }
      const result = await listSourcingDecisions(deps.database, variantId)
      return jsonResponse(result, 200)
    }

    return failure('not_found', 404)
  } catch (err: unknown) {
    if (err instanceof SupplierSourcingError) {
      const statusMap: Record<string, number> = {
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        no_suppliers_found: 404,
        invalid_cost: 400
      }
      return failure(err.code, statusMap[err.code] || 400)
    }
    if (err instanceof Error && err.name === 'ZodError') {
      return failure('invalid_input', 400)
    }
    return failure('internal_error', 500)
  }
}
