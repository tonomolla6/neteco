import {
  getCompanyShippingConditions,
  setCompanyShippingConditions,
  CompanyShippingConditionsError
} from './company-shipping-conditions'
import type { DatabaseAdapter } from './convenience-points'
import { setCompanyShippingConditionsInputSchema } from '../../shared/company-shipping-conditions'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'

export function ownsCompanyShippingConditionsNamespace(path: string): boolean {
  return (
    (path.startsWith('/api/admin/companies/') && path.endsWith('/shipping-conditions')) ||
    path === '/api/account/company/shipping-conditions'
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

export interface AuthenticatedUserSession {
  identityId: string
  roles: string[]
  permissions: string[]
}

export interface CompanyShippingConditionsHttpDependencies {
  database: DatabaseAdapter
  sessionCookieConfiguration?: SessionCookieConfiguration | null
  sessionProvider?: (req: Request) => Promise<AuthenticatedUserSession | null>
}

async function resolveSession(
  request: Request,
  deps: CompanyShippingConditionsHttpDependencies
): Promise<AuthenticatedUserSession | null> {
  if (deps.sessionProvider) {
    return deps.sessionProvider(request)
  }
  if (!deps.sessionCookieConfiguration) return null

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return null

  let rolesStmt = deps.database.prepare('SELECT role_code FROM identity_roles WHERE identity_id = ?')
  if (typeof rolesStmt.bind === 'function') rolesStmt = rolesStmt.bind(claims.identityId) as typeof rolesStmt
  const rolesResult = typeof rolesStmt.all === 'function' ? await rolesStmt.all(claims.identityId) : []

  const rolesRows = (rolesResult ?? []) as { role_code: string }[] | { results: { role_code: string }[] }
  const roles: string[] = Array.isArray(rolesRows)
    ? rolesRows.map((r) => r.role_code)
    : Array.isArray((rolesRows as { results?: { role_code: string }[] })?.results)
      ? (rolesRows as { results: { role_code: string }[] }).results.map((r) => r.role_code)
      : []

  let permStmt = deps.database.prepare(
    `SELECT granted.permission_code
     FROM identity_roles assigned
     JOIN role_permissions granted ON granted.role_code = assigned.role_code
     WHERE assigned.identity_id = ?`
  )
  if (typeof permStmt.bind === 'function') permStmt = permStmt.bind(claims.identityId) as typeof permStmt
  const permResult = typeof permStmt.all === 'function' ? await permStmt.all(claims.identityId) : []

  const permRows = (permResult ?? []) as { permission_code: string }[] | { results: { permission_code: string }[] }
  const permissions: string[] = Array.isArray(permRows)
    ? permRows.map((r) => r.permission_code)
    : Array.isArray((permRows as { results?: { permission_code: string }[] })?.results)
      ? (permRows as { results: { permission_code: string }[] }).results.map((r) => r.permission_code)
      : []

  return {
    identityId: claims.identityId,
    roles,
    permissions
  }
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

export async function handleCompanyShippingConditionsHttp(
  request: Request,
  deps: CompanyShippingConditionsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsCompanyShippingConditionsNamespace(path)) return null

  const session = await resolveSession(request, deps)
  if (!session) {
    return jsonResponse({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
  }

  // Handle Admin Company Conditions: /api/admin/companies/:id/shipping-conditions
  const adminMatch = path.match(/^\/api\/admin\/companies\/([^/]+)\/shipping-conditions$/)
  if (adminMatch) {
    const companyId = adminMatch[1]!
    if (!checkAdmin(session)) {
      return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
    }

    if (request.method === 'GET') {
      try {
        const conditions = await getCompanyShippingConditions(deps.database, companyId)
        const freshSession = await resolveSession(request, deps)
        if (!checkAdmin(freshSession)) {
          return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
        }
        if (!conditions) {
          return jsonResponse({
            conditions: {
              companyId,
              customMethodsEnabled: true,
              allowedMethods: ['pickup', 'own_delivery', 'parcel'],
              carrierAccountCarrier: null,
              carrierAccountNumber: null,
              warehousePickupAllowed: true,
              freeShippingThresholdCents: null,
              customDeliveryInstructions: null,
              version: 0,
              createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
              updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
            }
          })
        }
        return jsonResponse({ conditions })
      } catch {
        return jsonResponse({ error: { code: 'internal' } }, 500)
      }
    }

    if (request.method === 'PUT') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ error: { code: 'invalid_input', message: 'Malformed JSON' } }, 400)
      }

      const parseResult = setCompanyShippingConditionsInputSchema.safeParse(body)
      if (!parseResult.success) {
        return jsonResponse({ error: { code: 'invalid_input', message: parseResult.error.message } }, 400)
      }

      const input = parseResult.data
      try {
        const updated = await setCompanyShippingConditions(deps.database, {
          actorId: session.identityId,
          companyId,
          allowedMethods: input.allowedMethods,
          customMethodsEnabled: input.customMethodsEnabled,
          carrierAccountCarrier: input.carrierAccountCarrier,
          carrierAccountNumber: input.carrierAccountNumber,
          warehousePickupAllowed: input.warehousePickupAllowed,
          freeShippingThresholdCents: input.freeShippingThresholdCents,
          customDeliveryInstructions: input.customDeliveryInstructions,
          expectedVersion: input.expectedVersion,
          commandId: input.commandId
        })

        const freshSession = await resolveSession(request, deps)
        if (!checkAdmin(freshSession)) {
          return jsonResponse({ error: { code: 'forbidden', message: 'Administrative access required' } }, 403)
        }

        return jsonResponse({ conditions: updated }, 200)
      } catch (error) {
        if (error instanceof CompanyShippingConditionsError) {
          if (error.code === 'version_conflict') {
            return jsonResponse({ error: { code: 'version_conflict', message: error.message } }, 409)
          }
          return jsonResponse({ error: { code: error.code, message: error.message } }, 400)
        }
        return jsonResponse({ error: { code: 'internal' } }, 500)
      }
    }

    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  }

  // Handle Account route: /api/account/company/shipping-conditions
  if (path === '/api/account/company/shipping-conditions' && request.method === 'GET') {
    const identityId = session.identityId
    try {
      let stmt = deps.database.prepare(`
        SELECT c.id FROM companies c
        JOIN customers cust ON cust.id = c.customer_id
        JOIN identities i ON i.customer_id = cust.id
        WHERE i.id = ? AND c.status = 'approved'
        LIMIT 1
      `)
      if (typeof stmt.bind === 'function') stmt = stmt.bind(identityId) as typeof stmt
      const company = (
        typeof stmt.first === 'function'
          ? await stmt.first(identityId)
          : typeof stmt.get === 'function'
            ? stmt.get(identityId)
            : null
      ) as { id: string } | null

      if (!company) {
        return jsonResponse({ error: { code: 'not_found', message: 'No active company found for user' } }, 404)
      }

      const conditions = await getCompanyShippingConditions(deps.database, company.id)
      return jsonResponse({ conditions })
    } catch {
      return jsonResponse({ error: { code: 'internal' } }, 500)
    }
  }

  return null
}
