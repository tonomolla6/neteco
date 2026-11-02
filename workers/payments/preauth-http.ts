import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import {
  cancelPreauthorization,
  capturePreauthorization,
  listOrderPreauthorizations,
  PREAUTH_NOTIFICATION_PATH,
  PreauthError,
  processPreauthNotification,
  readPreauthorization,
  requestPreauthorization,
  type PreauthDependencies
} from './preauth'

const ADMIN_BASE = '/api/admin/payments/preauthorizations'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function ownsPreauthNamespace(pathname: string): boolean {
  let path = pathname
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/admin\/payments\/preauthorizations(?:[/\\%]|$)/i.test(path)) return true
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
export const isPreauthNotificationPath = (pathname: string) => pathname === PREAUTH_NOTIFICATION_PATH

export interface PreauthHttpDependencies {
  /** null when the feature is off or the provider binding is absent: nothing is reachable. */
  preauth: PreauthDependencies | null
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
}

const headers = {
  'cache-control': 'private, no-store',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer'
}
const respond = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...headers, ...extra } })
const fail = (code: string, status: number, extra: Record<string, string> = {}) =>
  respond({ error: { code } }, status, extra)
const STATUS: Record<PreauthError['code'], number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_payable: 422,
  unavailable: 503
}

/** Returns null for unrelated routes. The signed bank notification is public; every other route is admin-only. */
export async function handlePreauthHttp(request: Request, deps: PreauthHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (isPreauthNotificationPath(url.pathname)) return handleNotification(request, deps)
  if (!ownsPreauthNamespace(url.pathname)) return null
  const rest = url.pathname.slice(ADMIN_BASE.length)
  const action = new RegExp(`^/(${UUID})/(capture|cancel)$`, 'i').exec(rest)
  const one = new RegExp(`^/(${UUID})$`, 'i').exec(rest)
  const collection = rest === ''
  if (!collection && !action && !one) return fail('not_found', 404)
  const mutating = collection ? request.method === 'POST' : Boolean(action)
  const allowed = action ? ['POST'] : collection ? ['GET', 'POST'] : ['GET']
  if (!allowed.includes(request.method)) return fail('method_not_allowed', 405, { allow: allowed.join(', ') })
  try {
    if (!deps.preauth || !deps.sessionCookieConfiguration) return fail('service_unavailable', 503)
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      configured.username ||
      configured.password
    )
      return fail('service_unavailable', 503)
    if (url.origin !== deps.origin) return fail('forbidden', 403)
    const origin = request.headers.get('origin')
    // Mutations must prove a same-origin browser context; reads may omit Origin but never contradict it.
    if (
      (origin !== null && origin !== deps.origin) ||
      (mutating && origin !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return fail('forbidden', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated', 401)
    if (deps.edgeLimiter && deps.rateLimitPepper) {
      const edge = await checkAdministrativeEdgeLimit(
        request,
        deps.edgeLimiter,
        deps.rateLimitPepper,
        'admin-payment-preauth'
      )
      if (edge !== 'allowed')
        return fail(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
    }
    if (!mutating) {
      if (one) return respond(await readPreauthorization(claims, one[1]!, deps.preauth))
      const keys = [...url.searchParams.keys()]
      const orderId = url.searchParams.get('orderId')
      if (keys.length !== 1 || keys[0] !== 'orderId' || !orderId) return fail('invalid_input', 400)
      return respond(await listOrderPreauthorizations(claims, orderId, deps.preauth))
    }
    if (url.search) return fail('invalid_input', 400)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return fail('invalid_input', 415)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 4096)))
    } catch (error) {
      return fail('invalid_input', error instanceof SupportError && error.code === 'body_too_large' ? 413 : 400)
    }
    const key = request.headers.get('idempotency-key')
    if (key !== null && key !== (body as { commandId?: unknown } | null)?.commandId) return fail('invalid_input', 400)
    if (collection) return respond(await requestPreauthorization(claims, body, deps.preauth), 201)
    const result =
      action![2] === 'capture'
        ? await capturePreauthorization(claims, action![1]!, body, deps.preauth)
        : await cancelPreauthorization(claims, action![1]!, body, deps.preauth)
    return respond(result)
  } catch (error) {
    if (error instanceof PreauthError) return fail(error.code, STATUS[error.code])
    return fail('unavailable', 503)
  }
}

async function handleNotification(request: Request, deps: PreauthHttpDependencies): Promise<Response> {
  const plain = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const error = (code: string, status: number) => Response.json({ error: { code } }, { status, headers: plain })
  if (request.method !== 'POST') return error('method_not_allowed', 405)
  if (!deps.preauth) return error('payments_unavailable', 503)
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
    return error('invalid_notification', 400)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await supportBytes(request, 32768))
  } catch {
    return error('invalid_notification', 400)
  }
  const form = new URLSearchParams(text)
  const fields = ['Ds_MerchantParameters', 'Ds_SignatureVersion', 'Ds_Signature'] as const
  if (
    [...form.keys()].some((key) => !fields.includes(key as (typeof fields)[number])) ||
    fields.some((key) => form.getAll(key).length !== 1)
  )
    return error('invalid_notification', 400)
  try {
    const result = await processPreauthNotification(
      {
        Ds_MerchantParameters: form.get('Ds_MerchantParameters')!,
        Ds_SignatureVersion: form.get('Ds_SignatureVersion')!,
        Ds_Signature: form.get('Ds_Signature')!
      },
      deps.preauth
    )
    if (result.outcome === 'mismatch') return error('invalid_notification', 422)
    // Unfinished local work must be retried by the bank: do not acknowledge it.
    if (result.outcome === 'unavailable') return error('unavailable', 503)
    return new Response('OK', { headers: { ...plain, 'content-type': 'text/plain; charset=utf-8' } })
  } catch (caught) {
    if (caught instanceof PreauthError && (caught.code === 'invalid_input' || caught.code === 'not_found'))
      return error('invalid_notification', 400)
    return error('internal', 500)
  }
}
