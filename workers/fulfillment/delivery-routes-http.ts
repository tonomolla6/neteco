import {
  createDeliveryDriver,
  createDeliveryRoute,
  createDeliveryVehicle,
  getDeliveryRouteById,
  listDeliveryDrivers,
  listDeliveryRoutes,
  listDeliveryVehicles,
  addDeliveryRouteStop,
  reoptimizeDeliveryRoute,
  DeliveryRouteError
} from './delivery-routes'
import type { DatabaseAdapter } from './convenience-points'
import {
  addRouteStopInputSchema,
  createDeliveryRouteInputSchema,
  reoptimizeDeliveryRouteInputSchema
} from '../../shared/delivery-route-planning'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { resolveShippingSession, type AuthenticatedUserSession } from './company-shipping-conditions-http'

export function ownsDeliveryRoutesNamespace(path: string): boolean {
  return (
    path.startsWith('/api/admin/delivery-routes') ||
    path.startsWith('/api/admin/delivery-vehicles') ||
    path.startsWith('/api/admin/delivery-drivers')
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

export interface DeliveryRoutesHttpDependencies {
  database: DatabaseAdapter
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  sessionProvider?: (req: Request) => Promise<AuthenticatedUserSession | null>
}

function checkAdmin(session: AuthenticatedUserSession | null): boolean {
  if (!session) return false
  return (
    Array.isArray(session.roles) &&
    (session.roles.includes('admin') ||
      session.roles.includes('admin-role') ||
      (Array.isArray(session.permissions) && session.permissions.includes('administration.manage')))
  )
}

export async function handleDeliveryRoutesHttp(
  request: Request,
  deps: DeliveryRoutesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsDeliveryRoutesNamespace(path)) return null

  const session = await resolveShippingSession(request, deps)
  if (!session) {
    return jsonResponse({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
  }

  if (!checkAdmin(session)) {
    return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
  }

  // Helper to re-verify authorization before returning response
  const recheckAdmin = async (): Promise<boolean> => {
    const freshSession = await resolveShippingSession(request, deps)
    return freshSession?.identityId === session.identityId && checkAdmin(freshSession)
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !(await recheckAdmin())) {
    return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
  }

  // Vehicles endpoints
  if (path === '/api/admin/delivery-vehicles') {
    if (request.method === 'GET') {
      const vehicles = await listDeliveryVehicles(deps.database)
      if (!(await recheckAdmin())) {
        return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
      }
      return jsonResponse({ vehicles })
    }
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        id: string
        name: string
        registrationPlate: string
        maxWeightGrams: number
        maxParcels: number
        status?: 'active' | 'maintenance' | 'inactive'
      } | null
      if (!body) return jsonResponse({ error: { code: 'invalid_input' } }, 400)
      const vehicle = await createDeliveryVehicle(deps.database, body)
      return jsonResponse({ vehicle }, 201)
    }
    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  // Drivers endpoints
  if (path === '/api/admin/delivery-drivers') {
    if (request.method === 'GET') {
      const drivers = await listDeliveryDrivers(deps.database)
      if (!(await recheckAdmin())) {
        return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
      }
      return jsonResponse({ drivers })
    }
    if (request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as {
        id: string
        identityId?: string | null
        name: string
        phone: string
        licenseNumber: string
        status?: 'active' | 'off_duty'
      } | null
      if (!body) return jsonResponse({ error: { code: 'invalid_input' } }, 400)
      const driver = await createDeliveryDriver(deps.database, body)
      return jsonResponse({ driver }, 201)
    }
    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  // Reoptimize endpoint: /api/admin/delivery-routes/:id/reoptimize
  const reoptMatch = path.match(/^\/api\/admin\/delivery-routes\/([^/]+)\/reoptimize$/)
  if (reoptMatch) {
    if (request.method !== 'POST') return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
    const routeId = reoptMatch[1]!
    const body: unknown = await request.json().catch(() => null)
    const parsed = reoptimizeDeliveryRouteInputSchema.safeParse(body)
    if (!parsed.success) {
      return jsonResponse({ error: { code: 'invalid_input', message: parsed.error.message } }, 400)
    }

    try {
      const result = await reoptimizeDeliveryRoute(deps.database, {
        actorId: session.identityId,
        routeId,
        expectedVersion: parsed.data.expectedVersion,
        commandId: parsed.data.commandId,
        optimizationStrategy: parsed.data.optimizationStrategy
      })
      return jsonResponse(result, 200)
    } catch (error) {
      if (error instanceof DeliveryRouteError) {
        if (error.code === 'version_conflict' || error.code === 'idempotency_conflict') {
          return jsonResponse({ error: { code: error.code, message: error.message } }, 409)
        }
        return jsonResponse({ error: { code: error.code, message: error.message } }, 400)
      }
      return jsonResponse({ error: { code: 'internal' } }, 500)
    }
  }

  // Add stop endpoint: /api/admin/delivery-routes/:id/stops
  const stopsMatch = path.match(/^\/api\/admin\/delivery-routes\/([^/]+)\/stops$/)
  if (stopsMatch) {
    if (request.method !== 'POST') return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
    const routeId = stopsMatch[1]!
    const body: unknown = await request.json().catch(() => null)
    const parsed = addRouteStopInputSchema.safeParse(body)
    if (!parsed.success) {
      return jsonResponse({ error: { code: 'invalid_input', message: parsed.error.message } }, 400)
    }

    try {
      const route = await addDeliveryRouteStop(deps.database, {
        actorId: session.identityId,
        routeId,
        ...parsed.data
      })
      return jsonResponse({ route }, 200)
    } catch (error) {
      if (error instanceof DeliveryRouteError) {
        if (error.code === 'version_conflict' || error.code === 'idempotency_conflict') {
          return jsonResponse({ error: { code: error.code, message: error.message } }, 409)
        }
        return jsonResponse({ error: { code: error.code, message: error.message } }, 400)
      }
      return jsonResponse({ error: { code: 'internal' } }, 500)
    }
  }

  // Route detail endpoint: /api/admin/delivery-routes/:id
  const routeDetailMatch = path.match(/^\/api\/admin\/delivery-routes\/([^/]+)$/)
  if (routeDetailMatch) {
    const routeId = routeDetailMatch[1]!
    if (request.method === 'GET') {
      const route = await getDeliveryRouteById(deps.database, routeId)
      if (!route) return jsonResponse({ error: { code: 'not_found' } }, 404)
      if (!(await recheckAdmin())) {
        return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
      }
      return jsonResponse({ route }, 200)
    }
    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  // Route collection: /api/admin/delivery-routes
  if (path === '/api/admin/delivery-routes') {
    if (request.method === 'GET') {
      const routeDate = url.searchParams.get('routeDate') ?? undefined
      const routeStatus = url.searchParams.get('status') ?? undefined
      const routes = await listDeliveryRoutes(deps.database, { routeDate, status: routeStatus })
      if (!(await recheckAdmin())) {
        return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
      }
      return jsonResponse({ routes }, 200)
    }

    if (request.method === 'POST') {
      const body: unknown = await request.json().catch(() => null)
      const parsed = createDeliveryRouteInputSchema.safeParse(body)
      if (!parsed.success) {
        return jsonResponse({ error: { code: 'invalid_input', message: parsed.error.message } }, 400)
      }

      try {
        const route = await createDeliveryRoute(deps.database, {
          actorId: session.identityId,
          ...parsed.data
        })
        return jsonResponse({ route }, 201)
      } catch (error) {
        if (error instanceof DeliveryRouteError) {
          return jsonResponse({ error: { code: error.code, message: error.message } }, 400)
        }
        return jsonResponse({ error: { code: 'internal' } }, 500)
      }
    }

    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  return null
}
