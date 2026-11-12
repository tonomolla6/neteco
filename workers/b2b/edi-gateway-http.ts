import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  registerEdiClient,
  createEdiApiKey,
  authenticateEdiRequest,
  processEdiOrderPlacement,
  getEdiMonitoringSummary
} from './edi-gateway'
import type { EdiContractVersion } from '../../shared/b2b-edi-gateway'

export interface B2bEdiHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...headers
    }
  })
}

function errorResponse(code: string, status = 400, headers: Record<string, string> = {}) {
  return jsonResponse({ error: { code } }, status, headers)
}

export function ownsB2bEdiNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/edi/') || pathname.startsWith('/api/admin/edi/')
}

export async function handleB2bEdiHttp(request: Request, deps: B2bEdiHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsB2bEdiNamespace(pathname)) return null

  const method = request.method

  // Administrative Endpoints
  if (pathname.startsWith('/api/admin/edi/')) {
    if (!deps.sessionCookieConfiguration) {
      return errorResponse('service_unavailable', 503)
    }
    const adminClaims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!adminClaims) {
      return errorResponse('unauthorized', 401)
    }

    const checkAdminAuth = async () => {
      try {
        const auth = await authorizeD1Session(deps.database, adminClaims, 'administration.manage', { requireMfa: true })
        return auth.allowed ? null : errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
      } catch {
        return errorResponse('service_unavailable', 503)
      }
    }

    const denied = await checkAdminAuth()
    if (denied) return denied

    // POST /api/admin/edi/clients
    if (pathname === '/api/admin/edi/clients' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)
      let client
      try {
        client = await registerEdiClient(
          deps.database,
          body as unknown as Parameters<typeof registerEdiClient>[1],
          adminClaims
        )
      } catch {
        return (await checkAdminAuth()) ?? errorResponse('service_unavailable', 503)
      }
      const denied = await checkAdminAuth()
      if (denied) return denied
      return jsonResponse({ ok: true, client }, 201)
    }

    // POST /api/admin/edi/clients/:id/keys
    const keyMatch = pathname.match(/^\/api\/admin\/edi\/clients\/([^/]+)\/keys$/)
    if (keyMatch && method === 'POST') {
      const clientId = keyMatch[1]!
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)
      let key
      try {
        key = await createEdiApiKey(
          deps.database,
          {
            clientId,
            name: String(body.name ?? 'API Key'),
            expiresAt: body.expiresAt ? String(body.expiresAt) : null
          },
          adminClaims
        )
      } catch {
        return (await checkAdminAuth()) ?? errorResponse('service_unavailable', 503)
      }
      const denied = await checkAdminAuth()
      if (denied) return denied
      return jsonResponse({ ok: true, key }, 201)
    }

    // GET /api/admin/edi/clients/:id/monitoring
    const monMatch = pathname.match(/^\/api\/admin\/edi\/clients\/([^/]+)\/monitoring$/)
    if (monMatch && method === 'GET') {
      const clientId = monMatch[1]!
      const monitoring = await getEdiMonitoringSummary(deps.database, clientId)
      const denied = await checkAdminAuth()
      if (denied) return denied
      return jsonResponse({ ok: true, monitoring })
    }

    return errorResponse('not_found', 404)
  }

  // Client EDI Endpoints (/api/edi/v1/...)
  const apiKey = request.headers.get('x-neteco-edi-key')
  const signature = request.headers.get('x-neteco-edi-signature')
  const timestamp = request.headers.get('x-neteco-edi-timestamp')
  const contractVersion = (request.headers.get('x-neteco-edi-version') ?? '2026-10') as EdiContractVersion
  const idempotencyKey = request.headers.get('idempotency-key')

  if (!apiKey || !signature || !timestamp) {
    return errorResponse('edi_credentials_required', 401)
  }

  const rawBody = method === 'POST' || method === 'PUT' ? await request.text() : ''

  const auth = await authenticateEdiRequest(deps.database, {
    apiKey,
    timestamp,
    signature,
    payload: rawBody
  })

  if (!auth.authenticated || !auth.client) {
    return errorResponse(auth.code ?? 'authentication_failed', 401)
  }

  const client = auth.client
  const ediHeaders: Record<string, string> = {
    'x-neteco-edi-environment': client.environment,
    'x-neteco-edi-version': contractVersion
  }

  // GET /api/edi/v1/monitoring
  if (pathname === '/api/edi/v1/monitoring' && method === 'GET') {
    const monitoring = await getEdiMonitoringSummary(deps.database, client.id)
    return jsonResponse({ ok: true, monitoring }, 200, ediHeaders)
  }

  // POST /api/edi/v1/orders
  if (pathname === '/api/edi/v1/orders' && method === 'POST') {
    try {
      const input = JSON.parse(rawBody)
      const order = await processEdiOrderPlacement(deps.database, {
        client,
        contractVersion,
        idempotencyKey,
        input
      })
      return jsonResponse({ ok: true, order }, 200, ediHeaders)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'order_placement_failed'
      if (msg.includes('idempotency_conflict')) {
        return errorResponse('idempotency_conflict', 409, ediHeaders)
      }
      return errorResponse(msg, 400, ediHeaders)
    }
  }

  return errorResponse('not_found', 404, ediHeaders)
}
