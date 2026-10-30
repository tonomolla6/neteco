import { updateRoleDashboardInputSchema, saveRoleSavedViewInputSchema } from '../../shared/role-dashboard-config'
import {
  getRoleDashboardConfig,
  updateRoleDashboardConfig,
  saveRoleSavedView,
  listRoleSavedViews,
  archiveRoleSavedView,
  RoleDashboardError
} from './role-dashboard'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'

export interface RoleDashboardHttpDeps {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
}

export function ownsRoleDashboardNamespace(pathname: string): boolean {
  return (
    pathname === '/api/admin/dashboard/config' ||
    pathname === '/api/admin/dashboard/role-config' ||
    pathname.startsWith('/api/admin/dashboard/views')
  )
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  })
}

export async function handleRoleDashboardHttp(request: Request, deps: RoleDashboardHttpDeps): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsRoleDashboardNamespace(url.pathname)) return null

  // Origin / CSRF checks
  const originHeader = request.headers.get('origin')
  if (originHeader && originHeader !== deps.origin) {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return jsonResponse({ error: { code: 'csrf_rejected' } }, 403)
  }

  // Session verification
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return jsonResponse({ error: { code: 'unauthenticated' } }, 401)
  }

  try {
    // 1. GET config
    if (request.method === 'GET' && url.pathname === '/api/admin/dashboard/config') {
      const roleCode = url.searchParams.get('role') ?? 'admin'
      const config = await getRoleDashboardConfig(deps.database, {
        actorId: claims.identityId,
        roleCode
      })
      return jsonResponse(config)
    }

    // 2. PUT role-config
    if (request.method === 'PUT' && url.pathname === '/api/admin/dashboard/role-config') {
      const body: unknown = await request.json().catch(() => null)
      const parsed = updateRoleDashboardInputSchema.safeParse(body)
      if (!parsed.success) {
        return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
      }

      const updated = await updateRoleDashboardConfig(deps.database, {
        commandId: parsed.data.commandId,
        actorId: claims.identityId,
        roleCode: parsed.data.roleCode,
        expectedVersion: parsed.data.expectedVersion,
        widgets: parsed.data.widgets,
        columnPreferences: parsed.data.columnPreferences
      })
      return jsonResponse(updated)
    }

    // 3. GET views
    if (request.method === 'GET' && url.pathname === '/api/admin/dashboard/views') {
      const viewType = (url.searchParams.get('viewType') ?? 'orders') as
        'orders' | 'catalog' | 'campaigns' | 'inventory' | 'alerts'
      const roleCode = url.searchParams.get('role') ?? 'admin'
      const views = await listRoleSavedViews(deps.database, {
        actorId: claims.identityId,
        roleCode,
        viewType
      })
      return jsonResponse({ views })
    }

    // 4. POST views
    if (request.method === 'POST' && url.pathname === '/api/admin/dashboard/views') {
      const body: unknown = await request.json().catch(() => null)
      const parsed = saveRoleSavedViewInputSchema.safeParse(body)
      if (!parsed.success) {
        return jsonResponse({ error: { code: 'invalid_body', details: parsed.error.issues } }, 400)
      }

      const saved = await saveRoleSavedView(deps.database, {
        commandId: parsed.data.commandId,
        actorId: claims.identityId,
        viewId: parsed.data.viewId,
        roleCode: parsed.data.roleCode,
        viewType: parsed.data.viewType,
        name: parsed.data.name,
        scope: parsed.data.scope,
        isDefault: parsed.data.isDefault,
        definition: parsed.data.definition,
        expectedVersion: parsed.data.expectedVersion
      })
      return jsonResponse(saved, 201)
    }

    // 5. DELETE view
    const viewMatch = /^\/api\/admin\/dashboard\/views\/([0-9a-f-]+)$/.exec(url.pathname)
    if (request.method === 'DELETE' && viewMatch?.[1]) {
      const viewId = viewMatch[1]
      const expectedVersion = Number(url.searchParams.get('expectedVersion') ?? '1')
      const commandId = url.searchParams.get('commandId') ?? crypto.randomUUID()

      const res = await archiveRoleSavedView(deps.database, {
        commandId,
        actorId: claims.identityId,
        viewId,
        expectedVersion
      })
      return jsonResponse(res)
    }

    return jsonResponse({ error: { code: 'method_not_allowed' } }, 405)
  } catch (err) {
    if (err instanceof RoleDashboardError) {
      const status =
        err.code === 'forbidden'
          ? 403
          : err.code === 'dashboard_version_conflict' || err.code === 'view_version_conflict'
            ? 409
            : 400
      return jsonResponse({ error: { code: err.code } }, status)
    }
    return jsonResponse({ error: { code: 'internal_error' } }, 500)
  }
}
