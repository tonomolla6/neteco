import {
  listConveniencePoints,
  getConveniencePointById,
  ConveniencePointsError,
  type DatabaseAdapter
} from './convenience-points'
import type { ConveniencePointNetwork } from '../../shared/shipping-convenience-points'

export function ownsConveniencePointsNamespace(path: string): boolean {
  return path === '/api/shipping/convenience-points' || path.startsWith('/api/shipping/convenience-points/')
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

export async function handleConveniencePointsHttp(
  request: Request,
  deps: { database: DatabaseAdapter }
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsConveniencePointsNamespace(path)) return null

  if (request.method !== 'GET') {
    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  // Check if requesting specific ID: /api/shipping/convenience-points/:id
  const idPrefix = '/api/shipping/convenience-points/'
  if (path.startsWith(idPrefix) && path.length > idPrefix.length) {
    const id = path.slice(idPrefix.length)
    try {
      const point = await getConveniencePointById(deps.database, id)
      if (!point) {
        return jsonResponse({ error: { code: 'not_found' } }, 404)
      }
      return jsonResponse(point, 200)
    } catch {
      return jsonResponse({ error: { code: 'internal' } }, 500)
    }
  }

  // Query by postalCode
  const postalCode = url.searchParams.get('postalCode')
  if (!postalCode || !/^\d{5}$/.test(postalCode)) {
    return jsonResponse(
      { error: { code: 'invalid_input', message: 'Valid 5-digit postalCode query parameter is required' } },
      400
    )
  }

  const networkParam = url.searchParams.get('network')
  const network =
    networkParam && ['inpost', 'correos', 'seur', 'gls'].includes(networkParam)
      ? (networkParam as ConveniencePointNetwork)
      : undefined

  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined

  try {
    const points = await listConveniencePoints(deps.database, {
      postalCode,
      network,
      limit: Number.isFinite(limit) ? limit : undefined
    })

    return jsonResponse({
      points,
      total: points.length,
      postalCode
    })
  } catch (error) {
    if (error instanceof ConveniencePointsError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, 400)
    }
    return jsonResponse({ error: { code: 'internal' } }, 500)
  }
}
