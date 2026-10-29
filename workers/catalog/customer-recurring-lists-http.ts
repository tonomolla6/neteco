import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createRecurringList,
  getRecurringList,
  listCustomerRecurringLists,
  updateRecurringList,
  deleteRecurringList,
  inviteCollaborator,
  removeCollaborator,
  setRecurringListItem,
  removeRecurringListItem,
  revalidateRecurringListAssortment,
  recordListReplenishment
} from './customer-recurring-lists'

export interface CustomerRecurringListsHttpDependencies {
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

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

export function ownsCustomerRecurringListsNamespace(pathname: string): boolean {
  return pathname === '/api/account/recurring-lists' || pathname.startsWith('/api/account/recurring-lists/')
}

export async function handleCustomerRecurringListsHttp(
  request: Request,
  deps: CustomerRecurringListsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const pathname = url.pathname

  if (!ownsCustomerRecurringListsNamespace(pathname)) return null

  if (!deps.sessionCookieConfiguration) {
    return errorResponse('service_unavailable', 503)
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return errorResponse('unauthenticated', 401)
  }

  // Find customer_id for this identity
  const identity = await deps.database
    .prepare(`SELECT customer_id FROM identities WHERE id = ? AND status = 'active'`)
    .bind(claims.identityId)
    .first<{ customer_id: string }>()

  if (!identity || !identity.customer_id) {
    return errorResponse('customer_profile_required', 403)
  }

  const customerId = identity.customer_id
  const method = request.method

  try {
    // 1. GET /api/account/recurring-lists
    if (pathname === '/api/account/recurring-lists' && method === 'GET') {
      const lists = await listCustomerRecurringLists(deps.database, customerId, claims.identityId)
      return jsonResponse({ lists })
    }

    // 2. POST /api/account/recurring-lists
    if (pathname === '/api/account/recurring-lists' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)

      const list = await createRecurringList(deps.database, {
        customerId,
        ownerIdentityId: claims.identityId,
        name: String(body.name ?? ''),
        description: body.description ? String(body.description) : null,
        frequency: body.frequency as any,
        frequencyDays: typeof body.frequencyDays === 'number' ? body.frequencyDays : null,
        nextSuggestedDate: body.nextSuggestedDate ? String(body.nextSuggestedDate) : null
      })
      return jsonResponse({ ok: true, list }, 201)
    }

    // Pattern matching for /api/account/recurring-lists/:id/...
    const subPath = pathname.slice('/api/account/recurring-lists/'.length)
    const segments = subPath.split('/')
    const listId = segments[0]

    if (!listId) return errorResponse('invalid_path', 400)

    // Check list existence and access
    const list = await getRecurringList(deps.database, listId, claims.identityId)
    if (!list) {
      // Check if it exists at all to differentiate 404 from 403
      const exists = await deps.database
        .prepare(`SELECT customer_id FROM customer_recurring_lists WHERE id = ?`)
        .bind(listId)
        .first<{ customer_id: string }>()
      if (!exists) return errorResponse('not_found', 404)
      return errorResponse('forbidden', 403)
    }

    // GET /api/account/recurring-lists/:id
    if (segments.length === 1 && method === 'GET') {
      return jsonResponse({ list })
    }

    // PATCH /api/account/recurring-lists/:id
    if (segments.length === 1 && method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)

      const updated = await updateRecurringList(deps.database, {
        listId,
        requesterIdentityId: claims.identityId,
        name: body.name ? String(body.name) : undefined,
        description: body.description !== undefined ? (body.description ? String(body.description) : null) : undefined,
        frequency: body.frequency as any,
        frequencyDays: typeof body.frequencyDays === 'number' ? body.frequencyDays : undefined,
        nextSuggestedDate: body.nextSuggestedDate ? String(body.nextSuggestedDate) : undefined,
        status: body.status as any,
        expectedVersion: Number(body.expectedVersion)
      })
      return jsonResponse({ ok: true, list: updated })
    }

    // DELETE /api/account/recurring-lists/:id
    if (segments.length === 1 && method === 'DELETE') {
      await deleteRecurringList(deps.database, { listId, requesterIdentityId: claims.identityId })
      return jsonResponse({ ok: true })
    }

    // /api/account/recurring-lists/:id/revalidate
    if (segments.length === 2 && segments[1] === 'revalidate' && method === 'GET') {
      const report = await revalidateRecurringListAssortment(deps.database, {
        listId,
        customerId
      })
      return jsonResponse({ report })
    }

    // /api/account/recurring-lists/:id/replenish
    if (segments.length === 2 && segments[1] === 'replenish' && method === 'POST') {
      const replenished = await recordListReplenishment(deps.database, {
        listId,
        requesterIdentityId: claims.identityId
      })
      return jsonResponse({ ok: true, replenished })
    }

    // /api/account/recurring-lists/:id/collaborators
    if (segments.length === 2 && segments[1] === 'collaborators' && method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)

      const collab = await inviteCollaborator(deps.database, {
        listId,
        requesterIdentityId: claims.identityId,
        email: String(body.email ?? ''),
        role: body.role as any
      })
      return jsonResponse({ ok: true, collaborator: collab })
    }

    // DELETE /api/account/recurring-lists/:id/collaborators/:identityId
    if (segments.length === 3 && segments[1] === 'collaborators' && method === 'DELETE') {
      const collaboratorIdentityId = segments[2]
      await removeCollaborator(deps.database, {
        listId,
        requesterIdentityId: claims.identityId,
        collaboratorIdentityId
      })
      return jsonResponse({ ok: true })
    }

    // /api/account/recurring-lists/:id/items
    if (segments.length === 2 && segments[1] === 'items' && method === 'PUT') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body) return errorResponse('invalid_body', 400)

      const item = await setRecurringListItem(deps.database, {
        listId,
        requesterIdentityId: claims.identityId,
        variantId: String(body.variantId ?? ''),
        quantity: Number(body.quantity),
        expectedUnitGrossCents: typeof body.expectedUnitGrossCents === 'number' ? body.expectedUnitGrossCents : null
      })
      return jsonResponse({ ok: true, item })
    }

    // DELETE /api/account/recurring-lists/:id/items/:variantId
    if (segments.length === 3 && segments[1] === 'items' && method === 'DELETE') {
      const variantId = segments[2]
      await removeRecurringListItem(deps.database, {
        listId,
        requesterIdentityId: claims.identityId,
        variantId
      })
      return jsonResponse({ ok: true })
    }

    return errorResponse('not_found', 404)
  } catch (err: any) {
    const message = err?.message ?? 'internal_error'
    if (message.includes('unauthorized') || message.includes('forbidden')) {
      return errorResponse('forbidden', 403)
    }
    if (message.includes('version_conflict')) {
      return errorResponse('version_conflict', 409)
    }
    return errorResponse(message, 400)
  }
}
