import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { contingencyToggleSchema } from '../../shared/payment-contingency'
import {
  getContingencyRoutingRule,
  toggleContingencyRouting,
  recordUnifiedPaymentSettlement,
  listUnifiedPaymentReconciliations
} from './contingency-routing'
import { type AlternativeMarketPaymentProvider, ALTERNATIVE_PROVIDER_NAME } from './alternative-contingency-provider'
import { orderStoreCreditSql } from '../pricing/order-store-credit-sql'

export interface PaymentContingencyHttpDependencies {
  database: D1Database
  sessionCookieConfiguration?: SessionCookieConfiguration
  origin?: string
  claims?: VerifiedSessionClaims
  alternativeProvider?: AlternativeMarketPaymentProvider
  now?: string
}

export function ownsPaymentContingencyNamespace(pathname: string): boolean {
  return (
    pathname.startsWith('/api/admin/payments/contingency') ||
    pathname.startsWith('/api/admin/payments/unified-reconciliation') ||
    pathname === '/api/payments/alternative/webhook'
  )
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

export async function handlePaymentContingencyHttp(
  request: Request,
  deps: PaymentContingencyHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsPaymentContingencyNamespace(path)) return null

  const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Public Webhook from Alternative Provider
  if (path === '/api/payments/alternative/webhook' && request.method === 'POST') {
    // Fail closed: without a provider configured from Worker secrets there is no trusted key.
    const provider = deps.alternativeProvider
    if (!provider) return errorResponse('service_unavailable', 503)
    try {
      const payload = (await request.json()) as Record<string, string>
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return errorResponse('invalid_input', 400)
      }
      const verified = await provider.verifyNotification(payload)

      // Verify order existence and expected server-side gross amount: the amount due after the
      // store credit applied to the order (PRI-018), never the order total.
      const orderRow = await deps.database
        .prepare(
          `SELECT total_gross_cents - ${orderStoreCreditSql('orders.id')} AS total_gross_cents, currency FROM orders WHERE id = ?1`
        )
        .bind(verified.orderReference)
        .first<{ total_gross_cents: number; currency: string }>()

      if (!orderRow) {
        return errorResponse('order_not_found', 404)
      }

      const amountMatches =
        verified.amountCents === orderRow.total_gross_cents && verified.currency === orderRow.currency
      const settlementStatus = verified.status === 'captured' && amountMatches ? 'settled' : 'discrepancy'

      // Unify reconciliation
      const rec = await recordUnifiedPaymentSettlement(deps.database, {
        intentId: payload.intent_id ?? `intent-${verified.providerEventId}`,
        orderId: verified.orderReference,
        provider: ALTERNATIVE_PROVIDER_NAME,
        providerReference: verified.providerReference ?? verified.providerEventId,
        amountCents: verified.amountCents,
        currency: 'EUR',
        status: settlementStatus,
        payloadHash: verified.payloadHash,
        settledAt: now,
        now
      })

      return jsonResponse({ outcome: 'received', status: rec.status, providerEventId: verified.providerEventId })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('invalid_signature') || msg.includes('missing_signature')) {
        return errorResponse('invalid_signature', 400)
      }
      if (msg.includes('conflict')) {
        return errorResponse('conflict', 409)
      }
      return errorResponse('invalid_input', 400)
    }
  }

  // Admin routes: require authenticated session with administration.manage permission (before and after)
  let claims = deps.claims
  if (!claims && deps.sessionCookieConfiguration) {
    claims = (await verifySessionCookie(request, deps.sessionCookieConfiguration)) ?? undefined
  }

  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const auth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    return errorResponse(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
  }

  if (path === '/api/admin/payments/contingency/status' && request.method === 'GET') {
    const market = url.searchParams.get('market') ?? 'ES'
    const rule = await getContingencyRoutingRule(deps.database, market)
    const routes = rule ? [rule] : []
    const reconciliations = await listUnifiedPaymentReconciliations(deps.database)
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse({ routes, reconciliations })
  }

  if (path === '/api/admin/payments/contingency/toggle' && request.method === 'POST') {
    try {
      const body = await request.json()
      const parsed = contingencyToggleSchema.parse(body)
      const updated = await toggleContingencyRouting(deps.database, {
        ...parsed,
        actorId: claims.identityId,
        now
      })
      const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
      if (!freshAuth.allowed) {
        return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
      }
      return jsonResponse(updated)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code
      if (msg.includes('conflict')) return errorResponse('conflict', 409)
      return errorResponse(code ?? 'invalid_input', 400)
    }
  }

  if (path === '/api/admin/payments/unified-reconciliation' && request.method === 'GET') {
    const orderId = url.searchParams.get('orderId') ?? undefined
    const items = await listUnifiedPaymentReconciliations(deps.database, { orderId })
    const freshAuth = await authorizeD1Session(deps.database, claims, 'administration.manage', { now })
    if (!freshAuth.allowed) {
      return errorResponse(freshAuth.code, freshAuth.code === 'unauthenticated' ? 401 : 403)
    }
    return jsonResponse({ items })
  }

  return errorResponse('not_found', 404)
}
