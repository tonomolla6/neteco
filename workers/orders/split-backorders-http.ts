import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  customerSplitPreferencesSchema,
  splitShipmentInputSchema,
  splitBillingReconciliationSchema
} from '../../shared/order-split-backorders'
import {
  setCustomerSplitPreferences,
  getCustomerSplitPreferences,
  createOrderSplitShipments,
  getOrderSplitShipments,
  reconcileSplitBilling,
  getOrderSplitBillingSummary
} from './split-backorders'

export interface SplitBackordersHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration
  origin?: string
  claims?: VerifiedSessionClaims
  now?: string
}

export function ownsSplitBackordersNamespace(pathname: string): boolean {
  return pathname.startsWith('/api/admin/orders/split-') || pathname === '/api/orders/split-preferences'
}

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff'
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
         AND s.revoked_at IS NULL AND s.expires_at > ?4 AND i.status IN ('pending', 'active')`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{ customer_id: string | null }>()
  return row?.customer_id ?? null
}

export async function handleSplitBackordersHttp(
  request: Request,
  deps: SplitBackordersHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSplitBackordersNamespace(path)) return null

  const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  let claims = deps.claims
  if (!claims && deps.sessionCookieConfiguration) {
    claims = (await verifySessionCookie(request, deps.sessionCookieConfiguration)) ?? undefined
  }

  // Customer or checkout route: save/get customer preferences
  if (path === '/api/orders/split-preferences') {
    if (request.method === 'GET') {
      const orderId = url.searchParams.get('orderId')
      if (!orderId) return errorResponse('invalid_input', 400)
      const orderOwner = await deps.database
        .prepare('SELECT customer_id FROM orders WHERE id = ?1')
        .bind(orderId)
        .first<{ customer_id: string | null }>()
      if (orderOwner && claims) {
        const adminAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
        if (!adminAuth.allowed) {
          const callerCustomerId = await resolveCallerCustomerId(deps.database, claims, now)
          if (!callerCustomerId || callerCustomerId !== orderOwner.customer_id) {
            return errorResponse('forbidden', 403)
          }
        }
      }
      const prefs = await getCustomerSplitPreferences(deps.database, orderId)
      return jsonResponse(prefs ?? {})
    }

    if (request.method === 'POST') {
      if (!claims) {
        return errorResponse('unauthenticated', 401)
      }
      try {
        const body = await request.json()
        const parsed = customerSplitPreferencesSchema.parse(body)
        const orderOwner = await deps.database
          .prepare('SELECT customer_id FROM orders WHERE id = ?1')
          .bind(parsed.orderId)
          .first<{ customer_id: string | null }>()
        if (!orderOwner) {
          return errorResponse('not_found', 404)
        }
        const adminAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
        let resolvedCustomerId = parsed.customerId ?? orderOwner.customer_id
        if (!adminAuth.allowed) {
          const callerCustomerId = await resolveCallerCustomerId(deps.database, claims, now)
          if (!callerCustomerId) {
            return errorResponse('unauthenticated', 401)
          }
          if (callerCustomerId !== orderOwner.customer_id) {
            return errorResponse('forbidden', 403)
          }
          resolvedCustomerId = callerCustomerId
        }
        const prefs = await setCustomerSplitPreferences(deps.database, {
          ...parsed,
          customerId: resolvedCustomerId,
          now
        })
        return jsonResponse(prefs)
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code
        return errorResponse(code ?? 'invalid_input', 400)
      }
    }
  }

  // Admin routes: require authenticated session with administration.manage permission (before and after)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  }

  if (path === '/api/admin/orders/split-details' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId')
    if (!orderId) return errorResponse('invalid_input', 400)
    const [preferences, shipments, billing] = await Promise.all([
      getCustomerSplitPreferences(deps.database, orderId),
      getOrderSplitShipments(deps.database, orderId),
      getOrderSplitBillingSummary(deps.database, orderId)
    ])
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse({ preferences, shipments, billing })
  }

  if (path === '/api/admin/orders/split-shipments' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId')
    if (!orderId) return errorResponse('invalid_input', 400)
    const shipments = await getOrderSplitShipments(deps.database, orderId)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse({ shipments })
  }

  if (path === '/api/admin/orders/split-shipments/create' && request.method === 'POST') {
    try {
      const body = await request.json()
      const parsed = splitShipmentInputSchema.parse(body)
      const res = await createOrderSplitShipments(deps.database, {
        ...parsed,
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
      if (msg.includes('conflict')) {
        return errorResponse('conflict', 409)
      }
      if (msg.includes('split_not_accepted')) {
        return errorResponse('split_not_accepted', 400)
      }
      if (msg.includes('quantity_mismatch')) {
        return errorResponse('quantity_mismatch', 400)
      }
      return errorResponse(code ?? 'invalid_input', 400)
    }
  }

  if (path === '/api/admin/orders/split-billing' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId')
    if (!orderId) return errorResponse('invalid_input', 400)
    const summary = await getOrderSplitBillingSummary(deps.database, orderId)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse(summary)
  }

  if (path === '/api/admin/orders/split-billing/reconcile' && request.method === 'POST') {
    try {
      const body = await request.json()
      const parsed = splitBillingReconciliationSchema.parse(body)
      const res = await reconcileSplitBilling(deps.database, {
        ...parsed,
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
      if (msg.includes('conflict')) {
        return errorResponse('conflict', 409)
      }
      return errorResponse(code ?? 'invalid_input', 400)
    }
  }

  return errorResponse('not_found', 404)
}
