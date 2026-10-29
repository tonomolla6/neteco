import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import {
  executeSeoTechnicalCrawl,
  getSeoCrawlRunDetail,
  listSeoCrawlRuns,
  listSeoCrawlIssues,
  listSeoCrawlPages,
  type PageFetcher
} from './crawler'
import {
  recordBotAccessLog,
  getBotCrawlWasteSummary,
  sweepBotLogsRetention,
  getBotRetentionPolicy,
  updateBotRetentionPolicy
} from './bot-logs'
import { answerGroundedAiSearch, curateEditorialGuide, getCuratedGuideBySlug, listCuratedGuides } from './ai-search'
import { TriggerCrawlInputSchema, SeoCrawlerError } from '../../shared/seo-technical-crawler'
import { SeoBotLogError } from '../../shared/seo-bot-logs'
import {
  AiSearchQueryInputSchema,
  SEO_AI_SEARCH_ROBOTS_HEADER,
  SeoAiSearchError
} from '../../shared/seo-semantic-search'

export interface SeoHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration?: SessionCookieConfiguration
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  now?: () => string
  customPageFetcher?: PageFetcher
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': SEO_AI_SEARCH_ROBOTS_HEADER
}

export function ownsSeoNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/seo(?:\/|$)/.test(value) || /^\/api\/search\/ai(?:\/|$)/.test(value)) {
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

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...headers
    }
  })
}

function errorResponse(code: string, status: number, message?: string): Response {
  return jsonResponse({ error: { code, message: message ?? code } }, status)
}

function getIsoNow(deps: SeoHttpDependencies): string {
  return deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function authenticateAdminSession(
  request: Request,
  deps: SeoHttpDependencies
): Promise<{
  allowed: boolean
  identityId?: string
  sessionId?: string
  sessionVersion?: number
  response?: Response
}> {
  if (!deps.sessionCookieConfiguration) {
    return { allowed: false, response: errorResponse('service_unavailable', 503) }
  }

  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) {
    return { allowed: false, response: errorResponse('unauthenticated', 401) }
  }

  const now = getIsoNow(deps)
  const authAdmin = await authorizeD1Session(
    deps.database,
    {
      identityId: claims.identityId,
      sessionId: claims.sessionId,
      sessionVersion: claims.sessionVersion
    },
    'administration.manage',
    { now }
  )

  if (!authAdmin.allowed) {
    const authCatalog = await authorizeD1Session(
      deps.database,
      {
        identityId: claims.identityId,
        sessionId: claims.sessionId,
        sessionVersion: claims.sessionVersion
      },
      'catalog.write',
      { now }
    )
    if (!authCatalog.allowed) {
      return { allowed: false, response: errorResponse('forbidden', 403) }
    }
  }

  return {
    allowed: true,
    identityId: claims.identityId,
    sessionId: claims.sessionId,
    sessionVersion: claims.sessionVersion
  }
}

export async function handleSeoHttp(request: Request, deps: SeoHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!ownsSeoNamespace(path)) {
    return null
  }

  // 1. PUBLIC STOREFRONT: Grounded AI Search
  if (path === '/api/search/ai') {
    if (request.method !== 'POST') {
      return errorResponse('method_not_allowed', 405)
    }

    try {
      const rawBody = await request.json()
      const parsed = AiSearchQueryInputSchema.safeParse(rawBody)
      if (!parsed.success) {
        return errorResponse('invalid_input', 400, parsed.error.message)
      }

      const answer = await answerGroundedAiSearch(deps.database, {
        query: parsed.data.query,
        limit: parsed.data.limit,
        now: () => getIsoNow(deps)
      })

      return jsonResponse(answer, 200, {
        'x-robots-tag': SEO_AI_SEARCH_ROBOTS_HEADER,
        'cache-control': 'private, no-store'
      })
    } catch (err: unknown) {
      if (err instanceof SeoAiSearchError) {
        return errorResponse(err.code, 400, err.message)
      }
      return errorResponse('internal_error', 500, err instanceof Error ? err.message : 'Error')
    }
  }

  // 2. ADMIN ENDPOINTS: Authenticate session
  const auth = await authenticateAdminSession(request, deps)
  if (!auth.allowed) {
    return auth.response!
  }

  const claims = {
    identityId: auth.identityId!,
    sessionId: auth.sessionId!,
    sessionVersion: auth.sessionVersion!
  }

  try {
    // A. SEO Crawler Endpoints
    if (path === '/api/admin/seo/crawl/run' && request.method === 'POST') {
      const rawBody = await request.json().catch(() => ({}))
      const parsed = TriggerCrawlInputSchema.safeParse(rawBody)
      if (!parsed.success) {
        return errorResponse('invalid_input', 400, parsed.error.message)
      }

      const defaultFetcher: PageFetcher = async (fetchUrl) => {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<html><head><title>Neteco</title><link rel="canonical" href="https://neteco.beply.es${fetchUrl}" /></head><body><h1>Neteco</h1></body></html>`
        }
      }

      const result = await executeSeoTechnicalCrawl(deps.database, {
        ...parsed.data,
        pageFetcher: deps.customPageFetcher ?? defaultFetcher,
        now: () => getIsoNow(deps)
      })

      return jsonResponse(result)
    }

    if (path === '/api/admin/seo/crawl/runs' && request.method === 'GET') {
      const runs = await listSeoCrawlRuns(deps.database)
      return jsonResponse(runs)
    }

    const runDetailMatch = path.match(/^\/api\/admin\/seo\/crawl\/runs\/([0-9a-f-]{36})$/i)
    if (runDetailMatch && request.method === 'GET') {
      const runId = runDetailMatch[1]!
      const detail = await getSeoCrawlRunDetail(deps.database, runId)
      if (!detail) {
        return errorResponse('not_found', 404, 'Crawl run no encontrado')
      }
      return jsonResponse(detail)
    }

    const runPagesMatch = path.match(/^\/api\/admin\/seo\/crawl\/runs\/([0-9a-f-]{36})\/pages$/i)
    if (runPagesMatch && request.method === 'GET') {
      const runId = runPagesMatch[1]!
      const isOrphan = url.searchParams.get('isOrphan') === 'true' ? true : undefined
      const pages = await listSeoCrawlPages(deps.database, runId, { isOrphan })
      return jsonResponse(pages)
    }

    if (path === '/api/admin/seo/crawl/issues' && request.method === 'GET') {
      const runId = url.searchParams.get('runId')
      if (!runId) {
        return errorResponse('missing_run_id', 400, 'Se requiere el parámetro runId')
      }
      const issues = await listSeoCrawlIssues(deps.database, runId)
      return jsonResponse(issues)
    }

    // B. SEO Bot Logs Endpoints
    if (path === '/api/admin/seo/bots/log' && request.method === 'POST') {
      const rawBody = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      const record = await recordBotAccessLog(
        deps.database,
        rawBody as unknown as Parameters<typeof recordBotAccessLog>[1],
        {
          pepper: deps.rateLimitPepper ?? 'default-seo-pepper',
          now: () => getIsoNow(deps)
        }
      )
      return jsonResponse(record)
    }

    if (path === '/api/admin/seo/bots/summary' && request.method === 'GET') {
      const since = url.searchParams.get('since') ?? undefined
      const summary = await getBotCrawlWasteSummary(deps.database, { since })
      return jsonResponse(summary)
    }

    if (path === '/api/admin/seo/bots/retention/policy') {
      if (request.method === 'GET') {
        const policy = await getBotRetentionPolicy(deps.database)
        return jsonResponse(policy)
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        const rawBody = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        const updated = await updateBotRetentionPolicy(
          deps.database,
          rawBody as unknown as Parameters<typeof updateBotRetentionPolicy>[1],
          getIsoNow(deps)
        )
        return jsonResponse(updated)
      }
    }

    if (path === '/api/admin/seo/bots/retention/sweep' && request.method === 'POST') {
      const prunedCount = await sweepBotLogsRetention(deps.database, {
        referenceDate: getIsoNow(deps)
      })
      return jsonResponse({ prunedCount })
    }

    // C. SEO AI Search Curation Endpoints
    if (path === '/api/admin/seo/ai/curate' && request.method === 'POST') {
      const rawBody = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
      const idempotencyKey = request.headers.get('idempotency-key') || crypto.randomUUID()

      const receipt = await curateEditorialGuide(deps.database, claims, rawBody as unknown as CurateGuideInput, {
        idempotencyKey,
        now: () => getIsoNow(deps)
      })
      return jsonResponse(receipt)
    }

    if (path === '/api/admin/seo/ai/curated' && request.method === 'GET') {
      const guides = await listCuratedGuides(deps.database)
      return jsonResponse(guides)
    }

    const curatedSlugMatch = path.match(/^\/api\/admin\/seo\/ai\/curated\/([a-z0-9-]+)$/i)
    if (curatedSlugMatch && request.method === 'GET') {
      const slug = curatedSlugMatch[1]!
      const guide = await getCuratedGuideBySlug(deps.database, slug)
      if (!guide) {
        return errorResponse('not_found', 404, 'Guía editorial no encontrada')
      }
      return jsonResponse(guide)
    }

    return errorResponse('not_found', 404, 'Ruta no encontrada dentro de SEO namespace')
  } catch (err: unknown) {
    if (err instanceof SeoCrawlerError || err instanceof SeoBotLogError || err instanceof SeoAiSearchError) {
      return errorResponse(err.code, 400, err.message)
    }
    return errorResponse('internal_error', 500, err instanceof Error ? err.message : 'Error')
  }
}
