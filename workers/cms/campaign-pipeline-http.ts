import { ZodError } from 'zod'
import { denyUnlessAdmin, serverInstant } from '../release/admin-access'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  getCampaignPipeline,
  listCampaignPipelines,
  publishCampaignNow,
  qaSignoffCampaign,
  renderCampaignPreview,
  rollbackCampaignPublication,
  runCampaignChecks,
  saveCampaignDraft,
  scheduleCampaignPublication
} from './campaign-pipeline'
import { CampaignPipelineError, campaignDocumentSchema } from '../../shared/campaign-pipeline'

export interface CampaignPipelineHttpDependencies {
  database: D1Database
  origin?: string
  now?: () => string
  claimsResolver?: (request: Request) => Promise<VerifiedSessionClaims | null>
  sessionCookieConfiguration?: SessionCookieConfiguration
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive'
}

export function ownsCampaignPipelineNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/cms\/campaign-pipeline(?:\/|$)/.test(value) ||
      /^\/api\/campaign-pipeline(?:\/|$)/.test(value) ||
      /^\/api\/content\/campaign-pipeline(?:\/|$)/.test(value)
    ) {
      return true
    }
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  return false
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: SECURITY_HEADERS
  })
}

function errorResponse(code: string, status: number, message?: string): Response {
  return jsonResponse({ error: { code, message: message ?? code } }, status)
}

async function resolveClaims(
  request: Request,
  deps: CampaignPipelineHttpDependencies
): Promise<VerifiedSessionClaims | null> {
  if (deps.claimsResolver) {
    return deps.claimsResolver(request)
  }
  if (!deps.sessionCookieConfiguration) {
    return null
  }
  return verifySessionCookie(request, deps.sessionCookieConfiguration)
}

export async function handleCampaignPipelineHttp(
  request: Request,
  deps: CampaignPipelineHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCampaignPipelineNamespace(url.pathname)) return null

  const path = url.pathname.replace(/\/$/, '')
  const now = deps.now ? deps.now() : serverInstant()

  try {
    // 1. Preview endpoint (accessible without admin auth, zero deploy)
    if (
      (path === '/api/campaign-pipeline/preview' || path === '/api/content/campaign-pipeline/preview') &&
      request.method === 'POST'
    ) {
      const body = (await request.json().catch(() => null)) as {
        document?: unknown
        previewMode?: boolean
        draftVersion?: number
      } | null
      if (!body?.document) return errorResponse('invalid_json', 400, 'Document payload required')
      const validatedDoc = campaignDocumentSchema.parse(body.document)
      const preview = renderCampaignPreview(validatedDoc, {
        previewMode: body.previewMode ?? true,
        draftVersion: body.draftVersion
      })
      return jsonResponse(preview, 200)
    }

    // 2. Admin routes require authentication
    const claims = await resolveClaims(request, deps)
    if (!claims?.identityId) {
      return errorResponse('unauthenticated', 401, 'Valid session required')
    }

    const denied = await denyUnlessAdmin(deps.database, claims, ['catalog.write', 'administration.manage'], now)
    if (denied) return errorResponse(denied.code, denied.status)

    if (request.method !== 'GET') {
      const origin = request.headers.get('origin')
      if (deps.origin && origin && origin !== deps.origin) {
        return errorResponse('csrf_rejected', 403, 'Cross-origin request rejected')
      }
    }

    if (request.method === 'GET') {
      if (path === '/api/admin/cms/campaign-pipeline') {
        const campaigns = await listCampaignPipelines(deps.database)
        return jsonResponse(campaigns, 200)
      }
      const match = path.match(/^\/api\/admin\/cms\/campaign-pipeline\/([0-9a-f-]{36})$/)
      if (match) {
        const campaign = await getCampaignPipeline(deps.database, match[1])
        return jsonResponse(campaign, 200)
      }
      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      if (!body) return errorResponse('invalid_json', 400, 'Invalid JSON body')

      if (path === '/api/admin/cms/campaign-pipeline/draft') {
        const draft = await saveCampaignDraft(deps.database, body, claims.identityId, now)
        return jsonResponse(draft, 201)
      }

      if (path === '/api/admin/cms/campaign-pipeline/run-checks') {
        const checks = await runCampaignChecks(deps.database, body, claims.identityId, now)
        return jsonResponse(checks, 200)
      }

      if (path === '/api/admin/cms/campaign-pipeline/qa-signoff') {
        const approved = await qaSignoffCampaign(deps.database, body, claims.identityId, now)
        return jsonResponse(approved, 200)
      }

      if (path === '/api/admin/cms/campaign-pipeline/schedule') {
        const scheduled = await scheduleCampaignPublication(deps.database, body, claims.identityId, now)
        return jsonResponse(scheduled, 200)
      }

      if (path === '/api/admin/cms/campaign-pipeline/publish') {
        const published = await publishCampaignNow(deps.database, body, claims.identityId, now)
        return jsonResponse(published, 200)
      }

      if (path === '/api/admin/cms/campaign-pipeline/rollback') {
        const rolledBack = await rollbackCampaignPublication(deps.database, body, claims.identityId, now)
        return jsonResponse(rolledBack, 200)
      }

      return errorResponse('not_found', 404, 'Endpoint not found')
    }

    return errorResponse('method_not_allowed', 405, `Method ${request.method} not allowed`)
  } catch (err: unknown) {
    if (err instanceof CampaignPipelineError) {
      return errorResponse(err.code, err.statusCode, err.message)
    }
    if (err instanceof ZodError) {
      return jsonResponse({ error: { code: 'validation_error', issues: err.issues } }, 400)
    }
    return errorResponse('internal_server_error', 500)
  }
}
