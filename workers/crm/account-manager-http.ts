import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  assignCustomerAccountManager,
  readCustomerAccountManager,
  readCustomerVisibleAccountManager,
  createCustomerCommercialNote,
  listCustomerCommercialNotes,
  createCustomerOpportunity,
  updateCustomerOpportunityStage,
  listCustomerOpportunities,
  scheduleCustomerCalendarEvent,
  updateCustomerCalendarEventStatus,
  listCustomerCalendarEvents,
  listMyCustomerCalendarEvents
} from './account-manager'

export interface CrmHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin: string
  edgeGate?: (request: Request, area: string) => Promise<'allowed' | 'limited' | 'denied'>
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function errorResponse(code: string, status = 400) {
  return jsonResponse({ error: { code } }, status)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'service_unavailable'
}

export function ownsCustomerAccountManagerNamespace(pathname: string): boolean {
  return (
    pathname.startsWith('/api/admin/crm/') ||
    pathname === '/api/customer/account-manager' ||
    pathname === '/api/customer/calendar-events'
  )
}

export async function handleCustomerAccountManagerHttp(
  request: Request,
  deps: CrmHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsCustomerAccountManagerNamespace(path)) return null

  if (deps.edgeGate) {
    const gate = await deps.edgeGate(request, path.startsWith('/api/admin/') ? 'admin' : 'customer')
    if (gate !== 'allowed') {
      return errorResponse(gate === 'limited' ? 'rate_limited' : 'service_unavailable', gate === 'limited' ? 429 : 503)
    }
  }

  const method = request.method
  const claims = deps.sessionCookieConfiguration
    ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
    : null

  // 1. Customer visible contact view: GET /api/customer/account-manager
  if (path === '/api/customer/account-manager' && method === 'GET') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const identityRow = await deps.database
      .prepare('SELECT customer_id FROM identities WHERE id = ?1')
      .bind(claims.identityId)
      .first<{ customer_id: string | null }>()
    if (!identityRow?.customer_id) return errorResponse('unauthenticated', 401)

    const visibleManager = await readCustomerVisibleAccountManager(deps.database, identityRow.customer_id)
    return jsonResponse(visibleManager)
  }

  // 2. Customer calendar appointments: GET /api/customer/calendar-events
  if (path === '/api/customer/calendar-events' && method === 'GET') {
    if (!claims) return errorResponse('unauthenticated', 401)
    const identityRow = await deps.database
      .prepare('SELECT customer_id FROM identities WHERE id = ?1')
      .bind(claims.identityId)
      .first<{ customer_id: string | null }>()
    if (!identityRow?.customer_id) return errorResponse('unauthenticated', 401)

    const events = await listMyCustomerCalendarEvents(deps.database, identityRow.customer_id)
    return jsonResponse({ events })
  }

  // All other /api/admin/crm/... endpoints require admin authentication
  if (!claims) return errorResponse('unauthenticated', 401)

  // 3. Admin Account Manager Assignment: /api/admin/crm/customers/:id/account-manager
  const assignMatch = path.match(/^\/api\/admin\/crm\/customers\/([^/]+)\/account-manager$/)
  if (assignMatch) {
    const customerId = assignMatch[1]!
    if (method === 'GET') {
      try {
        const manager = await readCustomerAccountManager(deps.database, claims, customerId)
        return jsonResponse({ manager })
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        return errorResponse('service_unavailable', 500)
      }
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }
      try {
        const assignment = await assignCustomerAccountManager(deps.database, claims, customerId, body)
        return jsonResponse({ assignment }, 200)
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        if (msg === 'invalid_input') return errorResponse('invalid_input', 400)
        return errorResponse(msg, 400)
      }
    }
  }

  // 4. Admin Commercial Notes: /api/admin/crm/customers/:id/notes
  const notesMatch = path.match(/^\/api\/admin\/crm\/customers\/([^/]+)\/notes$/)
  if (notesMatch) {
    const customerId = notesMatch[1]!
    if (method === 'GET') {
      try {
        const notes = await listCustomerCommercialNotes(deps.database, claims, customerId)
        return jsonResponse({ notes })
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        return errorResponse('service_unavailable', 500)
      }
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }
      try {
        const note = await createCustomerCommercialNote(deps.database, claims, customerId, body)
        return jsonResponse({ note }, 201)
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        if (msg === 'invalid_input') return errorResponse('invalid_input', 400)
        return errorResponse(msg, 400)
      }
    }
  }

  // 5. Admin Opportunities: /api/admin/crm/customers/:id/opportunities
  const oppMatch = path.match(/^\/api\/admin\/crm\/customers\/([^/]+)\/opportunities$/)
  if (oppMatch) {
    const customerId = oppMatch[1]!
    if (method === 'GET') {
      try {
        const opportunities = await listCustomerOpportunities(deps.database, claims, customerId)
        return jsonResponse({ opportunities })
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        return errorResponse('service_unavailable', 500)
      }
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }
      try {
        const opportunity = await createCustomerOpportunity(deps.database, claims, customerId, body)
        return jsonResponse({ opportunity }, 201)
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        if (msg === 'invalid_input') return errorResponse('invalid_input', 400)
        return errorResponse(msg, 400)
      }
    }
  }

  // 6. Admin Opportunity Stage: /api/admin/crm/opportunities/:id/stage
  const oppStageMatch = path.match(/^\/api\/admin\/crm\/opportunities\/([^/]+)\/stage$/)
  if (oppStageMatch && method === 'POST') {
    const oppId = oppStageMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }
    try {
      const opportunity = await updateCustomerOpportunityStage(deps.database, claims, oppId, body)
      return jsonResponse({ opportunity }, 200)
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'version_conflict') return errorResponse('version_conflict', 409)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  // 7. Admin Calendar Events: /api/admin/crm/customers/:id/calendar-events
  const calMatch = path.match(/^\/api\/admin\/crm\/customers\/([^/]+)\/calendar-events$/)
  if (calMatch) {
    const customerId = calMatch[1]!
    if (method === 'GET') {
      try {
        const events = await listCustomerCalendarEvents(deps.database, claims, customerId)
        return jsonResponse({ events })
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        return errorResponse('service_unavailable', 500)
      }
    }
    if (method === 'POST') {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('invalid_input', 400)
      }
      try {
        const event = await scheduleCustomerCalendarEvent(deps.database, claims, customerId, body)
        return jsonResponse({ event }, 201)
      } catch (err: unknown) {
        const msg = getErrorMessage(err)
        if (msg === 'forbidden') return errorResponse('forbidden', 403)
        if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
        if (msg === 'consent_required') return errorResponse('consent_required', 400)
        if (msg === 'invalid_input') return errorResponse('invalid_input', 400)
        return errorResponse(msg, 400)
      }
    }
  }

  // 8. Admin Calendar Event Status: /api/admin/crm/calendar-events/:id/status
  const calStatusMatch = path.match(/^\/api\/admin\/crm\/calendar-events\/([^/]+)\/status$/)
  if (calStatusMatch && method === 'POST') {
    const eventId = calStatusMatch[1]!
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse('invalid_input', 400)
    }
    try {
      const event = await updateCustomerCalendarEventStatus(deps.database, claims, eventId, body)
      return jsonResponse({ event }, 200)
    } catch (err: unknown) {
      const msg = getErrorMessage(err)
      if (msg === 'forbidden') return errorResponse('forbidden', 403)
      if (msg === 'unauthenticated') return errorResponse('unauthenticated', 401)
      if (msg === 'not_found') return errorResponse('not_found', 404)
      return errorResponse(msg, 400)
    }
  }

  return null
}
