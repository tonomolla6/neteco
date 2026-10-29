/**
 * SEC-034: CSP Violation Reporting Endpoint & Aggregation HTTP Handler
 *
 * Privacy & Security specifications:
 * - Rate limiting: bounded requests per minute, returns 429 when exceeded.
 * - Bounded payload size: max 16 KB (16,384 bytes), returns 413 when exceeded.
 * - Strict PII minimization: query strings, credentials, and fragments stripped
 *   from document-uri and blocked-uri. Data/blob URIs truncated without payloads.
 * - Zero IP, User-Agent, or customer identifiers stored.
 * - Aggregated by (directive, blocked_uri, route, disposition) with hit count,
 *   first_seen_at, and last_seen_at.
 */

export interface ParsedViolation {
  directive: string
  blockedUri: string
  route: string
  disposition: 'enforce' | 'report'
  sampleOriginalPolicy: string | null
}

const MAX_PAYLOAD_BYTES = 16_384
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60

// In-memory rate limiter per IP bucket
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>()

export function resetCspRateLimiterForTest(): void {
  rateLimitBuckets.clear()
}

/**
 * Checks whether an incoming path matches the CSP reporting namespace.
 * Performs repeated decodeURIComponent rounds to protect against encoded path bypasses.
 */
export function ownsCspReportNamespace(path: string): boolean {
  let decoded = path
  for (let round = 0; round < 4; round++) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      return false
    }
  }
  const normalized = decoded.toLowerCase().replace(/\/+$/, '')
  return normalized === '/api/security/csp-reports' || normalized === '/api/csp-report'
}

/**
 * Strips sensitive query parameters, tokens, credentials, and fragments from a document URI,
 * returning only a clean, bounded pathname.
 */
export function sanitizeReportPath(rawPathOrUrl: string): string {
  if (!rawPathOrUrl || typeof rawPathOrUrl !== 'string') return '/'
  let path = rawPathOrUrl.trim()
  try {
    if (path.includes('://')) {
      const parsed = new URL(path)
      path = parsed.pathname
    } else {
      // Strip query and fragment
      path = path.split('?')[0]!.split('#')[0]!
    }
  } catch {
    path = path.split('?')[0]!.split('#')[0]!
  }

  if (!path.startsWith('/')) {
    path = `/${path}`
  }

  // Bound length to 256 characters
  return path.slice(0, 256)
}

/**
 * Strips query parameters, credentials, and fragments from blocked URIs.
 * Data and blob URIs are truncated without the payload.
 */
export function sanitizeBlockedUri(rawBlockedUri: string): string {
  if (!rawBlockedUri || typeof rawBlockedUri !== 'string') return 'unknown'
  const trimmed = rawBlockedUri.trim()

  if (trimmed.startsWith('data:')) return 'data:'
  if (trimmed.startsWith('blob:')) return 'blob:'
  if (trimmed === 'eval' || trimmed === 'inline') return trimmed

  try {
    if (trimmed.includes('://')) {
      const parsed = new URL(trimmed)
      // Discard username/password, query, and hash
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 500)
    }
  } catch {
    // Fall back to string splitting
  }

  return trimmed.split('?')[0]!.split('#')[0]!.slice(0, 500)
}

/**
 * Normalizes directive strings (e.g. 'script-src-elem' -> 'script-src').
 */
function normalizeDirective(rawDirective: unknown): string {
  if (typeof rawDirective !== 'string' || !rawDirective.trim()) return 'unknown'
  const directive = rawDirective.trim().toLowerCase().split(/\s+/)[0]!
  if (directive.startsWith('script-src')) return 'script-src'
  if (directive.startsWith('style-src')) return 'style-src'
  if (directive.startsWith('img-src')) return 'img-src'
  if (directive.startsWith('font-src')) return 'font-src'
  if (directive.startsWith('connect-src')) return 'connect-src'
  if (directive.startsWith('frame-src')) return 'frame-src'
  return directive.slice(0, 64)
}

/**
 * Parses both standard legacy csp-report payloads and modern W3C Reporting API arrays.
 */
export function parseCspReportPayload(payload: unknown): ParsedViolation[] {
  const violations: ParsedViolation[] = []
  if (!payload || typeof payload !== 'object') return violations

  // Format 1: Reporting API array: [ { type: 'csp-violation', body: { ... } } ]
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue
      const body = (item as { body?: Record<string, unknown> }).body ?? item
      const directive = normalizeDirective(
        body.effectiveDirective ?? body.violatedDirective ?? body['effective-directive'] ?? body['violated-directive']
      )
      const blockedUri = sanitizeBlockedUri(String(body.blockedURL ?? body.blockedURI ?? body['blocked-uri'] ?? ''))
      const route = sanitizeReportPath(String(body.documentURL ?? body.documentURI ?? body['document-uri'] ?? ''))
      const disposition = String(body.disposition ?? 'report').toLowerCase() === 'enforce' ? 'enforce' : 'report'
      const sampleOriginalPolicy = typeof body.originalPolicy === 'string' ? body.originalPolicy.slice(0, 500) : null

      violations.push({
        directive,
        blockedUri,
        route,
        disposition,
        sampleOriginalPolicy
      })
    }
    return violations
  }

  // Format 2: Legacy csp-report wrapper: { "csp-report": { ... } }
  const obj = payload as Record<string, unknown>
  const report = (obj['csp-report'] ?? obj) as Record<string, unknown>
  if (typeof report === 'object' && report !== null) {
    const directive = normalizeDirective(
      report['effective-directive'] ??
        report['violated-directive'] ??
        report.effectiveDirective ??
        report.violatedDirective
    )
    const blockedUri = sanitizeBlockedUri(String(report['blocked-uri'] ?? report.blockedURL ?? report.blockedURI ?? ''))
    const route = sanitizeReportPath(String(report['document-uri'] ?? report.documentURL ?? report.documentURI ?? ''))
    const disposition = String(report.disposition ?? 'report').toLowerCase() === 'enforce' ? 'enforce' : 'report'
    const sampleOriginalPolicy =
      typeof report['original-policy'] === 'string'
        ? (report['original-policy'] as string).slice(0, 500)
        : typeof report.originalPolicy === 'string'
          ? (report.originalPolicy as string).slice(0, 500)
          : null

    violations.push({
      directive,
      blockedUri,
      route,
      disposition,
      sampleOriginalPolicy
    })
  }

  return violations
}

/**
 * Checks in-memory rate limiting per client IP.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const bucket = rateLimitBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(ip, { count: 1, windowStart: now })
    return true
  }
  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false
  }
  bucket.count++
  return true
}

function errorResponse(code: string, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers
      }
    }
  )
}

/**
 * Handles incoming HTTP requests for the CSP violation reporting endpoint.
 */
export async function handleCspReportHttp(request: Request, env: CloudflareEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCspReportNamespace(url.pathname)) {
    return null
  }

  if (request.method !== 'POST' && request.method !== 'GET') {
    return new Response(null, {
      status: 405,
      headers: {
        allow: 'GET, POST',
        'cache-control': 'no-store'
      }
    })
  }

  // GET: retrieve aggregated violations
  if (request.method === 'GET') {
    if (!env.DB) {
      return Response.json({ items: [], total: 0 }, { headers: { 'cache-control': 'private, no-store' } })
    }

    const directiveFilter = url.searchParams.get('directive')
    const routeFilter = url.searchParams.get('route')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100)

    try {
      let query =
        'SELECT directive, blocked_uri, route, disposition, count, first_seen_at, last_seen_at FROM csp_violation_aggregates'
      const conditions: string[] = []
      const params: unknown[] = []

      if (directiveFilter) {
        conditions.push('directive = ?')
        params.push(directiveFilter)
      }
      if (routeFilter) {
        conditions.push('route = ?')
        params.push(routeFilter)
      }
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`
      }
      query += ' ORDER BY last_seen_at DESC LIMIT ?'
      params.push(limit)

      const stmt = env.DB.prepare(query).bind(...params)
      const { results } = await stmt.all()

      return Response.json(
        { items: results ?? [], total: results?.length ?? 0 },
        { headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json' } }
      )
    } catch {
      return errorResponse('database_unavailable', 503)
    }
  }

  // POST: Report Ingestion
  const clientIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'

  if (!checkRateLimit(clientIp)) {
    return errorResponse('rate_limited', 429, { 'retry-after': '60' })
  }

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return errorResponse('payload_too_large', 413)
  }

  const contentType = (request.headers.get('content-type') || '').toLowerCase().split(';')[0]!.trim()
  const validContentTypes = ['application/csp-report', 'application/reports+json', 'application/json']
  if (!validContentTypes.includes(contentType)) {
    return errorResponse('unsupported_media_type', 415)
  }

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return errorResponse('read_error', 400)
  }

  if (rawBody.length > MAX_PAYLOAD_BYTES) {
    return errorResponse('payload_too_large', 413)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody)
  } catch {
    return errorResponse('invalid_json', 400)
  }

  const violations = parseCspReportPayload(parsedJson)
  if (violations.length === 0) {
    return errorResponse('invalid_csp_report', 400)
  }

  // If DB is available, aggregate in D1
  if (env.DB) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const upsertSql = `
      INSERT INTO csp_violation_aggregates (
        directive, blocked_uri, route, disposition, count, first_seen_at, last_seen_at, sample_original_policy
      ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6)
      ON CONFLICT (directive, blocked_uri, route, disposition) DO UPDATE SET
        count = count + 1,
        last_seen_at = excluded.last_seen_at,
        sample_original_policy = COALESCE(excluded.sample_original_policy, csp_violation_aggregates.sample_original_policy)
    `
    try {
      const statements = violations.map((v) =>
        env.DB.prepare(upsertSql).bind(
          v.directive,
          v.blockedUri,
          v.route,
          v.disposition,
          nowIso,
          v.sampleOriginalPolicy
        )
      )
      await env.DB.batch(statements)
    } catch {
      // D1 failure should not expose internal errors to external callers
    }
  }

  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store'
    }
  })
}
