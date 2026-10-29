import { verifySessionCookie, type SessionCookieConfiguration } from './session-cookie'
import { deriveAdminAuditIpHash } from './admin-audit-network'
import {
  acknowledgeD1SecurityAnomaly,
  hashSecurityNetworkValue,
  readD1SecurityAnomalies,
  readD1SecurityAnomalyCommand,
  readD1SecurityAnomalyDetail,
  resolveD1SecurityAnomaly,
  SecurityAnomalyError
} from './security-anomalies'

export interface SecurityAnomalyHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  now?: string
}

const PREFIX = '/api/admin/security/anomalies'
const MAX_JSON_BYTES = 4096

function privateHeaders(extra: Record<string, string> = {}) {
  return {
    'Cache-Control': 'private, no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    Vary: 'Cookie, Origin',
    ...extra
  }
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: privateHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extra
    })
  })
}

const errorResponse = (code: string, status: number, extra?: Record<string, string>) =>
  jsonResponse({ error: { code } }, status, extra)

function validOrigin(request: Request, configuredOrigin?: string) {
  const origin = request.headers.get('origin')
  if (!origin || !configuredOrigin) return false
  try {
    return new URL(origin).origin === new URL(configuredOrigin).origin
  } catch {
    return false
  }
}

function validJsonContentType(request: Request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

async function readJsonBody(
  request: Request
): Promise<
  { ok: true; value: unknown } | { ok: false; code: 'payload_too_large' | 'invalid_json'; status: 413 | 400 }
> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    return { ok: false, code: 'payload_too_large', status: 413 }
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0) return { ok: false, code: 'invalid_json', status: 400 }
  if (bytes.byteLength > MAX_JSON_BYTES) {
    return { ok: false, code: 'payload_too_large', status: 413 }
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, code: 'invalid_json', status: 400 }
  }
}

function statusForError(error: SecurityAnomalyError): number {
  switch (error.code) {
    case 'unauthenticated':
      return 401
    case 'email_unverified':
    case 'mfa_required':
    case 'forbidden':
      return 403
    case 'not_found':
      return 404
    case 'idempotency_conflict':
    case 'version_conflict':
    case 'invalid_transition':
      return 409
    case 'invalid_input':
      return 400
    case 'service_unavailable':
      return 503
  }
}

export function ownsSecurityAnomaliesNamespace(path: string) {
  if (path.length > 4096) return false
  for (let round = 0; round < 4; round++) {
    if (/^\/api\/admin\/security\/anomalies(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      break
    }
  }
  return false
}

export async function handleSecurityAnomaliesHttp(
  request: Request,
  deps: SecurityAnomalyHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSecurityAnomaliesNamespace(url.pathname)) return null
  const path = url.pathname
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null

  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return errorResponse('method_not_allowed', 405, { Allow: 'GET, POST' })
  }

  const tail = path === PREFIX ? [] : path.slice(PREFIX.length + 1).split('/')
  const isList = method === 'GET' && tail.length === 0
  const isDetail = method === 'GET' && tail.length === 1 && Boolean(tail[0]) && tail[0] !== 'commands'
  const isCommand = method === 'GET' && tail.length === 2 && tail[0] === 'commands' && Boolean(tail[1])
  const isAcknowledge = method === 'POST' && tail.length === 2 && Boolean(tail[0]) && tail[1] === 'acknowledge'
  const isResolve = method === 'POST' && tail.length === 2 && Boolean(tail[0]) && tail[1] === 'resolve'

  if (!isList && !isDetail && !isCommand && !isAcknowledge && !isResolve) {
    const knownPath =
      tail.length === 0 ||
      (tail.length === 1 && Boolean(tail[0])) ||
      (tail.length === 2 &&
        ((tail[0] === 'commands' && Boolean(tail[1])) ||
          (Boolean(tail[0]) && (tail[1] === 'acknowledge' || tail[1] === 'resolve'))))
    return knownPath
      ? errorResponse('method_not_allowed', 405, { Allow: 'GET, POST' })
      : errorResponse('not_found', 404)
  }

  try {
    if (
      !deps.sessionCookieConfiguration ||
      typeof deps.edgeGate !== 'function' ||
      typeof deps.rateLimitPepper !== 'string' ||
      deps.rateLimitPepper.length < 32 ||
      deps.rateLimitPepper.startsWith('local-only-') ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:'
    )
      return errorResponse('service_unavailable', 503)
  } catch {
    return errorResponse('service_unavailable', 503)
  }
  if (
    url.origin !== deps.origin ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (method === 'POST'
      ? !validOrigin(request, deps.origin)
      : request.headers.has('origin') && !validOrigin(request, deps.origin))
  )
    return errorResponse('invalid_origin', 403)
  if (method === 'POST' && !validJsonContentType(request)) return errorResponse('unsupported_media_type', 415)

  // Edge admission runs exactly once, before cookie parsing or any D1 access.
  const edge = await deps.edgeGate(request)
  if (edge === 'denied') return errorResponse('rate_limited', 429, { 'Retry-After': '60' })
  if (edge !== 'allowed') return errorResponse('service_unavailable', 503)

  const now = deps.now
  let claims
  try {
    claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  } catch {
    return errorResponse('service_unavailable', 503)
  }

  try {
    if (isList) {
      return jsonResponse(
        await readD1SecurityAnomalies(deps.database, claims, Object.fromEntries(url.searchParams.entries()), { now })
      )
    }

    if (isDetail) {
      let signalId: string
      try {
        signalId = decodeURIComponent(tail[0]!)
      } catch {
        return errorResponse('invalid_input', 400)
      }
      return jsonResponse(await readD1SecurityAnomalyDetail(deps.database, claims, signalId, { now }))
    }

    if (isCommand) {
      return jsonResponse(
        await readD1SecurityAnomalyCommand(deps.database, claims, tail[1]!, url.searchParams.get('payloadHash') ?? '', {
          now
        })
      )
    }

    const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? ''
    if (!idempotencyKey) return errorResponse('invalid_input', 400)

    const body = await readJsonBody(request)
    if (!body.ok) return errorResponse(body.code, body.status)

    let signalId: string
    try {
      signalId = decodeURIComponent(tail[0]!)
    } catch {
      return errorResponse('invalid_input', 400)
    }

    const ipHash = await deriveAdminAuditIpHash(request, deps.rateLimitPepper)
    const userAgentHash = await hashSecurityNetworkValue(request.headers.get('user-agent'), deps.rateLimitPepper)

    if (isAcknowledge) {
      return jsonResponse(
        await acknowledgeD1SecurityAnomaly(deps.database, claims, signalId, body.value, {
          now,
          idempotencyKey,
          ipHash,
          userAgentHash
        }),
        201
      )
    }

    return jsonResponse(
      await resolveD1SecurityAnomaly(deps.database, claims, signalId, body.value, {
        now,
        idempotencyKey,
        ipHash,
        userAgentHash
      }),
      201
    )
  } catch (error) {
    if (error instanceof SecurityAnomalyError) {
      return errorResponse(error.code, statusForError(error))
    }
    return errorResponse('service_unavailable', 503)
  }
}
