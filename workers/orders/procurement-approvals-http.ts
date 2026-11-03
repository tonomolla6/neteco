import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { orderProcurementAssignSchema, orderProcurementReviewSchema } from '../../shared/order-procurement-approvals'
import {
  assignOrderProcurementDetails,
  reviewOrderProcurementApproval,
  getOrderProcurementDetails,
  exportOrderProcurementCsv,
  getOrderInvoiceProcurementView
} from './procurement-approvals'

export interface ProcurementApprovalsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration
  origin?: string
  claims?: VerifiedSessionClaims
  now?: string
}

export function ownsProcurementApprovalsNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/admin/orders/procurement') || pathname === '/api/orders/procurement/invoice-view'
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
  })
}

function errorResponse(code: string, status: number) {
  return jsonResponse({ error: { code } }, status)
}

async function resolveCallerCustomerId(
  database: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT i.customer_id
       FROM auth_sessions s
       JOIN identities i ON i.id = s.identity_id
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
         AND s.session_version = i.session_version AND s.revoked_at IS NULL
         AND s.created_at <= ?4 AND s.expires_at > ?4 AND i.status IN ('pending', 'active')`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ customer_id: string | null }>()
  return row?.customer_id ?? null
}

export async function handleProcurementApprovalsHttp(
  request: Request,
  deps: ProcurementApprovalsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsProcurementApprovalsNamespace(path)) return null

  const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  let claims = deps.claims
  if (!claims && deps.sessionCookieConfiguration) {
    claims = (await verifySessionCookie(request, deps.sessionCookieConfiguration)) ?? undefined
  }

  // Customer/invoice view endpoint: prevent cross-customer IDOR when order exists
  if (path === '/api/orders/procurement/invoice-view' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId')
    if (!orderId) return errorResponse('invalid_input', 400)

    if (!claims) return errorResponse('unauthenticated', 401)
    const adminAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!adminAuth.allowed && adminAuth.code === 'unauthenticated') return errorResponse('unauthenticated', 401)
    const orderOwner = await deps.database
      .prepare('SELECT customer_id FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ customer_id: string | null }>()

    // Ownership is mandatory: anonymous callers never read order data (401), unknown orders are
    // 404 only after authentication, and non-owner non-admin callers get 403.
    if (!orderOwner) return errorResponse('not_found', 404)
    if (!adminAuth.allowed) {
      const callerCustomerId = await resolveCallerCustomerId(deps.database, claims, now)
      if (!callerCustomerId || callerCustomerId !== orderOwner.customer_id) {
        return errorResponse('forbidden', 403)
      }
    }

    const view = await getOrderInvoiceProcurementView(deps.database, orderId)
    return jsonResponse(view ?? {})
  }

  // Admin routes: require authenticated session with administration.manage permission (before and after)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  }

  if (path === '/api/admin/orders/procurement/export.csv' && request.method === 'GET') {
    const csv = await exportOrderProcurementCsv(deps.database)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="neteco-procurement-orders.csv"',
        'cache-control': 'private, no-store',
        pragma: 'no-cache',
        vary: 'Cookie',
        'x-content-type-options': 'nosniff'
      }
    })
  }

  if (path === '/api/admin/orders/procurement' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId')
    if (!orderId) return errorResponse('invalid_input', 400)
    const details = await getOrderProcurementDetails(deps.database, orderId)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse(details ?? {})
  }

  if (path === '/api/admin/orders/procurement/assign' && request.method === 'POST') {
    try {
      const body = await request.json()
      const parsed = orderProcurementAssignSchema.parse(body)
      const res = await assignOrderProcurementDetails(deps.database, {
        orderId: parsed.orderId,
        purchaseOrderReference: parsed.purchaseOrderReference,
        costCenter: parsed.costCenter,
        approvalThresholdCents: parsed.approvalThresholdCents,
        now
      })
      const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
      if (!freshAuth.allowed) {
        return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
      }
      return jsonResponse(res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code
      if (msg.includes('conflict')) return errorResponse('conflict', 409)
      return errorResponse(code ?? 'invalid_input', 400)
    }
  }

  if (
    (path === '/api/admin/orders/procurement/approve' || path === '/api/admin/orders/procurement/reject') &&
    request.method === 'POST'
  ) {
    try {
      const body = (await request.json()) as Record<string, unknown>
      const action = path.endsWith('/approve') ? 'approve' : 'reject'
      const parsed = orderProcurementReviewSchema.parse({ ...body, action })
      const res = await reviewOrderProcurementApproval(deps.database, {
        orderId: parsed.orderId,
        action: parsed.action,
        expectedVersion: parsed.expectedVersion,
        actorId: claims.identityId,
        rejectionReason: parsed.rejectionReason,
        notes: parsed.notes,
        now
      })
      const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
      if (!freshAuth.allowed) {
        return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
      }
      return jsonResponse(res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code
      if (msg.includes('conflict')) return errorResponse('conflict', 409)
      return errorResponse(code ?? 'invalid_input', 400)
    }
  }

  return errorResponse('not_found', 404)
}
