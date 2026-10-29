import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import {
  executeMarketCatalogCommand,
  listActiveMarkets,
  readProductMarketConfigs,
  resolveProductForMarket
} from './market-catalog'
import {
  configureInternationalShippingPolicy,
  evaluateInternationalShipping,
  readInternationalShippingPolicy
} from '../fulfillment/international-shipping'
import {
  blockLotExpedition,
  evaluateOrderExpeditionEligibility,
  locateLotAffectedCustomers,
  locateLotAffectedStock,
  unblockLotExpedition
} from './catalog-lot-recall'
import {
  CatalogLotRecallError,
  InternationalShippingError,
  MarketCatalogError
} from '../../shared/catalog-markets'

export interface MarketCatalogHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
}

export function ownsMarketCatalogNamespace(pathname: string): boolean {
  return (
    pathname === '/api/storefront/markets' ||
    pathname === '/api/storefront/products/market' ||
    pathname === '/api/shipping/international-restrictions' ||
    pathname.startsWith('/api/admin/market-catalog') ||
    pathname.startsWith('/api/admin/international-shipping') ||
    pathname.startsWith('/api/admin/catalog-lots/expedition')
  )
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  })
}

function errorResponse(code: string, status = 400): Response {
  return jsonResponse({ error: { code } }, status)
}

export async function handleMarketCatalogHttp(
  request: Request,
  deps: MarketCatalogHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsMarketCatalogNamespace(pathname)) return null

  // 1. Public storefront endpoints
  if (pathname === '/api/storefront/markets' && request.method === 'GET') {
    const markets = await listActiveMarkets(deps.database)
    return jsonResponse(markets, 200, { 'Cache-Control': 'public, max-age=300' })
  }

  if (pathname === '/api/storefront/products/market' && request.method === 'GET') {
    const marketCode = url.searchParams.get('market')
    const slug = url.searchParams.get('slug')
    const productId = url.searchParams.get('productId')
    if (!marketCode || (!slug && !productId)) {
      return errorResponse('invalid_input', 400)
    }
    const resolved = await resolveProductForMarket(deps.database, {
      marketCode,
      slug: slug ?? undefined,
      productId: productId ?? undefined
    })
    if (!resolved) return errorResponse('not_found', 404)
    return jsonResponse(resolved, 200, { 'Cache-Control': 'public, max-age=60' })
  }

  if (pathname === '/api/shipping/international-restrictions' && request.method === 'GET') {
    const marketCode = url.searchParams.get('market')
    const declaredValueStr = url.searchParams.get('declaredValue')
    if (!marketCode) return errorResponse('invalid_input', 400)

    const declaredValueCents = declaredValueStr ? Number(declaredValueStr) : 0
    const evalResult = await evaluateInternationalShipping(deps.database, {
      marketCode,
      declaredValueCents: Number.isSafeInteger(declaredValueCents) ? declaredValueCents : 0,
      items: []
    })
    return jsonResponse(evalResult, 200)
  }

  // 2. Admin endpoints security & auth checks
  const originHeader = request.headers.get('origin')
  const secFetchSite = request.headers.get('sec-fetch-site')
  if (request.method !== 'GET') {
    if (originHeader && originHeader !== deps.origin) {
      return errorResponse('forbidden', 403)
    }
    if (secFetchSite === 'cross-site') {
      return errorResponse('forbidden', 403)
    }
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  const commandId = request.headers.get('idempotency-key') ?? crypto.randomUUID()

  try {
    // Admin Market Catalog
    if (pathname.startsWith('/api/admin/market-catalog/products/')) {
      const productId = pathname.slice('/api/admin/market-catalog/products/'.length)
      if (request.method === 'GET') {
        const configs = await readProductMarketConfigs(deps.database, productId)
        return jsonResponse(configs)
      }
      if (request.method === 'POST') {
        const body = await request.json()
        const result = await executeMarketCatalogCommand(
          deps.database,
          claims,
          productId,
          commandId,
          body,
          { now: deps.now }
        )
        return jsonResponse(result)
      }
    }

    // Admin International Shipping
    if (pathname.startsWith('/api/admin/international-shipping/')) {
      const marketCode = pathname.slice('/api/admin/international-shipping/'.length).toUpperCase()
      if (request.method === 'GET') {
        const policy = await readInternationalShippingPolicy(deps.database, marketCode)
        if (!policy) return errorResponse('not_found', 404)
        return jsonResponse(policy)
      }
      if (request.method === 'POST') {
        const body = await request.json()
        const result = await configureInternationalShippingPolicy(
          deps.database,
          claims,
          commandId,
          { ...body, marketCode },
          { now: deps.now }
        )
        return jsonResponse(result)
      }
    }

    // Admin Lot Expedition
    if (pathname.startsWith('/api/admin/catalog-lots/expedition/locate-stock/')) {
      const lotId = pathname.slice('/api/admin/catalog-lots/expedition/locate-stock/'.length)
      const stock = await locateLotAffectedStock(deps.database, lotId)
      return jsonResponse(stock)
    }

    if (pathname.startsWith('/api/admin/catalog-lots/expedition/locate-customers/')) {
      const lotId = pathname.slice('/api/admin/catalog-lots/expedition/locate-customers/'.length)
      const customers = await locateLotAffectedCustomers(deps.database, lotId)
      return jsonResponse(customers)
    }

    if (pathname === '/api/admin/catalog-lots/expedition/block' && request.method === 'POST') {
      const body = await request.json()
      const result = await blockLotExpedition(deps.database, claims, commandId, body, { now: deps.now })
      return jsonResponse(result)
    }

    if (pathname === '/api/admin/catalog-lots/expedition/unblock' && request.method === 'POST') {
      const body = await request.json()
      const result = await unblockLotExpedition(deps.database, claims, commandId, body, { now: deps.now })
      return jsonResponse(result)
    }

    if (pathname.startsWith('/api/admin/catalog-lots/expedition/check-order/')) {
      const orderId = pathname.slice('/api/admin/catalog-lots/expedition/check-order/'.length)
      const eligibility = await evaluateOrderExpeditionEligibility(deps.database, orderId, { now: deps.now })
      return jsonResponse(eligibility)
    }

    return errorResponse('not_found', 404)
  } catch (error: any) {
    if (error instanceof MarketCatalogError || error instanceof InternationalShippingError || error instanceof CatalogLotRecallError) {
      if (error.code === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (error.code === 'forbidden') return errorResponse('forbidden', 403)
      if (error.code === 'not_found') return errorResponse('not_found', 404)
      if (error.code === 'conflict') return errorResponse('conflict', 409)
      return errorResponse(error.code, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
