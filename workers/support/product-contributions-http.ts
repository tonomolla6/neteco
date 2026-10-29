import type { SessionCookieConfiguration } from '../auth/session-cookie'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBody, supportJson } from './http'
import { SupportError } from './operations'
import { supportUuid } from '../../shared/support-operations'
import {
  ProductContributionError,
  authorizeD1ProductContributionActor,
  submitD1ProductContribution,
  replyD1ProductContribution,
  moderateD1ProductContribution,
  readD1ProductContribution,
  readD1ProductContributions,
  readD1ProductContributionCommand,
  readD1PublicProductContributions
} from './product-contributions'
export interface ProductContributionsHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'limited' | 'unavailable'>
  now?: string
}
export function ownsProductContributionsNamespace(path: string): boolean {
  if (path.length > 4096) return false
  let candidate = path
  for (let round = 0; round < 4; round++) {
    if (
      /^\/api\/(?:account|admin)\/product-contributions(?:[/\\%]|$)/i.test(candidate) ||
      /^\/api\/products\/[^/]+\/contributions(?:[/\\%]|$)/i.test(candidate)
    )
      return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) break
      candidate = decoded
    } catch {
      break
    }
  }
  return false
}
const statuses: Record<string, number> = {
  invalid_input: 422,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  history_unconfirmed: 503,
  service_unavailable: 503,
  limit_exceeded: 409,
  body_too_large: 413
}
const failure = (code: string) => supportJson({ error: { code } }, statuses[code] ?? 503)
export async function handleProductContributionsHttp(
  request: Request,
  deps: ProductContributionsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsProductContributionsNamespace(url.pathname)) return null
  const publicRoute = /^\/api\/products\/([1-9][0-9]{0,15})\/contributions$/.exec(url.pathname)
  const base = /^\/api\/(account|admin)\/product-contributions$/.exec(url.pathname)
  const detail = /^\/api\/(account|admin)\/product-contributions\/([a-f0-9-]{36})$/.exec(url.pathname)
  const write = /^\/api\/(account|admin)\/product-contributions\/([a-f0-9-]{36})\/(reply|commands)$/.exec(url.pathname)
  const command = /^\/api\/(account|admin)\/product-contributions\/commands\/([a-f0-9-]{36})$/.exec(url.pathname)
  const area = (base ?? detail ?? write ?? command)?.[1],
    id = (detail ?? write ?? command)?.[2]
  if (
    (!publicRoute && !base && !detail && !write && !command) ||
    (id && !supportUuid.safeParse(id).success) ||
    (write && ((area === 'account' && write[3] !== 'reply') || (area === 'admin' && write[3] !== 'commands')))
  )
    return failure('not_found')
  const methods = base && area === 'account' ? ['GET', 'POST'] : write ? ['POST'] : ['GET']
  if (!methods.includes(request.method))
    return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: methods.join(', ') })
  try {
    if (
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:' ||
      !deps.rateLimitPepper ||
      typeof deps.edgeGate !== 'function'
    )
      return failure('service_unavailable')
    const mutation = request.method === 'POST'
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (mutation
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const edge = await deps.edgeGate(request)
    if (edge === 'limited') return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    const query: Record<string, string> = Object.create(null)
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key)) return failure('invalid_input')
      query[key] = value
    }
    const options = deps.now === undefined ? {} : { now: deps.now }
    if (publicRoute)
      return supportJson(await readD1PublicProductContributions(deps.database, Number(publicRoute[1]), query, options))
    if (!deps.sessionCookieConfiguration) return failure('service_unavailable')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const audience = area === 'admin' ? 'admin' : 'customer'
    await authorizeD1ProductContributionActor(deps.database, claims, audience, options)
    if (command) {
      if (Object.keys(query).length) return failure('invalid_input')
      const hash = request.headers.get('x-neteco-command-payload-hash') ?? ''
      return supportJson(await readD1ProductContributionCommand(deps.database, claims, audience, id!, hash, options))
    }
    if (detail) {
      if (Object.keys(query).length) return failure('invalid_input')
      return supportJson(await readD1ProductContribution(deps.database, claims, audience, id!, options))
    }
    if (base && request.method === 'GET')
      return supportJson(await readD1ProductContributions(deps.database, claims, audience, query, options))
    if (Object.keys(query).length) return failure('invalid_input')
    const body = await supportBody(request),
      key = request.headers.get('idempotency-key') ?? ''
    if (!supportUuid.safeParse(key).success) return failure('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'product-contributions',
      limit: audience === 'admin' ? 60 : 20,
      windowSeconds: 3600,
      ...(deps.now === undefined ? {} : { now: Math.floor(Date.parse(deps.now) / 1000) })
    })
    if (!quota.allowed)
      return supportJson({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    const commandOptions = { ...options, idempotencyKey: key }
    if (write)
      return supportJson(
        await (audience === 'customer'
          ? replyD1ProductContribution(deps.database, claims, id!, body, commandOptions)
          : moderateD1ProductContribution(deps.database, claims, id!, body, commandOptions)),
        201
      )
    return supportJson(await submitD1ProductContribution(deps.database, claims, body, commandOptions), 201)
  } catch (error) {
    if (error instanceof ProductContributionError) return failure(error.code)
    if (error instanceof SupportError && ['invalid_input', 'body_too_large'].includes(error.code))
      return failure(error.code)
    return failure('service_unavailable')
  }
}
