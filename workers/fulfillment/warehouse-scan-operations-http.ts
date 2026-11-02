import { readJsonBody } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  getWarehouseQueues,
  processBarcodeScan,
  createWarehouseReception,
  reportWarehouseException,
  resolveWarehouseException,
  listWarehousePrinters,
  dispatchWarehousePrintJob,
  getWarehouseOperationalMetrics,
  WarehouseScanError
} from './warehouse-scan-operations'

export interface WarehouseScanHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  now?: () => string
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}

function failure(code: string, status = 500): Response {
  return jsonResponse({ error: { code } }, status)
}

export function ownsWarehouseScanNamespace(pathname: string): boolean {
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/warehouse\/(queues|scan|receptions|exceptions|printers|metrics)(?:[/\\%]|$)/i.test(pathname)) {
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

export async function handleWarehouseScanHttp(
  request: Request,
  deps: WarehouseScanHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsWarehouseScanNamespace(url.pathname)) return null

  const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // CSRF validation
  const origin = request.headers.get('origin')
  if (origin && origin !== deps.origin) {
    return failure('csrf_rejected', 403)
  }

  // Session verification
  if (!deps.sessionCookieConfiguration) {
    return failure('service_unavailable', 503)
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return failure('unauthenticated', 401)
  }

  try {
    const method = request.method
    const pathname = url.pathname

    // Queues: GET /api/admin/warehouse/queues
    if (pathname === '/api/admin/warehouse/queues' && method === 'GET') {
      const queues = await getWarehouseQueues(deps.database, claims, { now })
      return jsonResponse(queues, 200)
    }

    // Process scan: POST /api/admin/warehouse/scan
    if (pathname === '/api/admin/warehouse/scan' && method === 'POST') {
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const result = await processBarcodeScan(deps.database, claims, body, {
        commandId,
        now
      })
      return jsonResponse(result, 200)
    }

    // Create reception: POST /api/admin/warehouse/receptions
    if (pathname === '/api/admin/warehouse/receptions' && method === 'POST') {
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const reception = await createWarehouseReception(deps.database, claims, body, {
        commandId,
        now
      })
      return jsonResponse(reception, 201)
    }

    // Report exception: POST /api/admin/warehouse/exceptions
    if (pathname === '/api/admin/warehouse/exceptions' && method === 'POST') {
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const exception = await reportWarehouseException(deps.database, claims, body, {
        commandId,
        now
      })
      return jsonResponse(exception, 201)
    }

    // Resolve exception: POST /api/admin/warehouse/exceptions/:id/resolve
    const resolveMatch = /^\/api\/admin\/warehouse\/exceptions\/([^/]+)\/resolve$/.exec(pathname)
    if (resolveMatch && method === 'POST') {
      const exceptionId = resolveMatch[1]!
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const resolved = await resolveWarehouseException(deps.database, claims, exceptionId, body, {
        commandId,
        now
      })
      return jsonResponse(resolved, 200)
    }

    // List printers: GET /api/admin/warehouse/printers
    if (pathname === '/api/admin/warehouse/printers' && method === 'GET') {
      const printers = await listWarehousePrinters(deps.database, claims)
      return jsonResponse(printers, 200)
    }

    // Print label: POST /api/admin/warehouse/printers/:id/print
    const printMatch = /^\/api\/admin\/warehouse\/printers\/([^/]+)\/print$/.exec(pathname)
    if (printMatch && method === 'POST') {
      const printerId = printMatch[1]
      const commandId = request.headers.get('X-Command-Id') ?? undefined
      const body = await readJsonBody(request)
      if (body === undefined) return failure('invalid_json', 400)
      const printJob = await dispatchWarehousePrintJob(
        deps.database,
        claims,
        { ...body, printerId },
        { commandId, now }
      )
      return jsonResponse(printJob, 200)
    }

    // Operational metrics: GET /api/admin/warehouse/metrics
    if (pathname === '/api/admin/warehouse/metrics' && method === 'GET') {
      const metrics = await getWarehouseOperationalMetrics(deps.database, claims, { now })
      return jsonResponse(metrics, 200)
    }

    return failure('not_found', 404)
  } catch (error: unknown) {
    if (error instanceof WarehouseScanError) {
      if (error.code === 'unauthenticated') return failure('unauthenticated', 401)
      if (error.code === 'forbidden') return failure('forbidden', 403)
      if (error.code === 'not_found') return failure('not_found', 404)
      return failure(error.code, 400)
    }
    return failure('internal_error', 500)
  }
}
