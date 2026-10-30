import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdminAuthority, isUuid, serverNow } from './admin-command-authority'
import {
  activateChannelTransform,
  generateChannelFeed,
  listChannelTransforms,
  publishChannelTransform
} from './channel-feeds'
import { resolveProductHreflang, reviewMarketTranslation } from './seo-international'
import {
  evaluateAdrShipment,
  getHazardInfo,
  getSpecialistValidation,
  listCarrierRestrictions,
  recordSpecialistValidation,
  setCarrierRestriction
} from '../fulfillment/adr-limited-quantity'
import { AdrLqError } from '../../shared/adr-limited-quantity'
import {
  CHANNELS,
  ChannelFeedError,
  reconcileChannelFeed,
  renderChannelFeedXml,
  type FeedChannel
} from '../../shared/channel-feeds'
import { HreflangError } from '../../shared/seo-international'

export interface InternationalFeedsAdrHttpDependencies {
  database: D1Database
  /** Public site origin (also the only origin accepted on mutations). */
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration
  now?: () => string
}

const MAX_BODY_CHARACTERS = 64 * 1024
const FEED_PATH = /^\/api\/feeds\/channels\/([a-z_]{1,40})\.(json|xml)$/
const ADMIN_PREFIXES = [
  '/api/admin/seo-international/',
  '/api/admin/channel-feeds/',
  '/api/admin/adr-limited-quantity/'
]

export function ownsInternationalFeedsAdrNamespace(path: string): boolean {
  return (
    path === '/api/storefront/seo/hreflang' ||
    path.startsWith('/api/feeds/channels/') ||
    path === '/api/storefront/adr/hazard-info' ||
    path === '/api/shipping/adr/evaluate' ||
    ADMIN_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

function respond(body: BodyInit | null, status: number, headers: Record<string, string>): Response {
  return new Response(body, { status, headers })
}

function json(data: unknown, status = 200, cache = 'private, no-store'): Response {
  return respond(JSON.stringify(data), status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache
  })
}
const fail = (code: string, status: number) => json({ error: { code } }, status, 'no-store')

const STATUS: Record<string, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  allocation_exceeded: 409,
  too_large: 413
}

function mapError(error: unknown): Response {
  if (error instanceof HreflangError || error instanceof ChannelFeedError || error instanceof AdrLqError)
    return fail(error.code, STATUS[error.code] ?? 400)
  return fail('internal_server_error', 500)
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_CHARACTERS) throw new BodyError(413, 'too_large')
  try {
    return JSON.parse(text)
  } catch {
    throw new BodyError(400, 'invalid_input')
  }
}

function crossSite(request: Request, origin: string): boolean {
  const header = request.headers.get('origin')
  if (header !== null && header !== origin) return true
  const site = request.headers.get('sec-fetch-site')
  return site === 'cross-site' || site === 'same-site'
}

export async function handleInternationalFeedsAdrHttp(
  request: Request,
  deps: InternationalFeedsAdrHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!ownsInternationalFeedsAdrNamespace(path)) return null
  const method = request.method
  const siteOrigin = deps.origin.replace(/\/$/, '')

  try {
    // ---- Public, read-only ----
    if (path === '/api/storefront/seo/hreflang') {
      if (method !== 'GET') return fail('method_not_allowed', 405)
      const result = await resolveProductHreflang(deps.database, {
        origin: siteOrigin,
        slug: url.searchParams.get('slug') ?? undefined,
        productId: url.searchParams.get('productId') ?? undefined,
        market: url.searchParams.get('market') ?? undefined
      })
      return json(result, 200, 'public, max-age=300')
    }

    if (path === '/api/storefront/adr/hazard-info') {
      if (method !== 'GET') return fail('method_not_allowed', 405)
      return json(await getHazardInfo(deps.database, url.searchParams.get('variantId')), 200, 'public, max-age=300')
    }

    if (path.startsWith('/api/feeds/channels/')) {
      if (method !== 'GET') return fail('method_not_allowed', 405)
      const match = FEED_PATH.exec(path)
      if (!match || !(CHANNELS as readonly string[]).includes(match[1]!)) return fail('not_found', 404)
      const feed = await generateChannelFeed(deps.database, match[1] as FeedChannel, {
        origin: siteOrigin,
        now: deps.now
      })
      return match[2] === 'xml'
        ? respond(renderChannelFeedXml(feed), 200, {
            'content-type': 'application/xml; charset=utf-8',
            'cache-control': 'public, max-age=60'
          })
        : json(feed, 200, 'public, max-age=60')
    }

    if (path === '/api/shipping/adr/evaluate') {
      if (method !== 'POST') return fail('method_not_allowed', 405)
      if (crossSite(request, siteOrigin)) return fail('forbidden', 403)
      return json(await evaluateAdrShipment(deps.database, await readJson(request)), 200)
    }

    // ---- Administrative ----
    if (crossSite(request, siteOrigin) && method !== 'GET') return fail('forbidden', 403)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return fail('unauthenticated', 401)
    const authority = await checkAdminAuthority(deps.database, claims, serverNow(deps.now))
    if (!authority.ok) return fail(authority.code, STATUS[authority.code]!)
    const commandId = request.headers.get('idempotency-key') ?? ''
    const mutating = method !== 'GET'
    const fixed = { now: deps.now }
    const needKey = () => {
      if (!isUuid(commandId)) throw new BodyError(400, 'invalid_input')
      return commandId
    }

    const channelRoute = /^\/api\/admin\/channel-feeds\/([a-z_]{1,40})(?:\/(versions|activate|reconcile))?$/.exec(path)
    if (channelRoute) {
      const [, channel, action] = channelRoute
      if (!action) {
        if (method !== 'GET') return fail('method_not_allowed', 405)
        return json(await listChannelTransforms(deps.database, channel))
      }
      if (method !== 'POST') return fail('method_not_allowed', 405)
      const body = await readJson(request)
      if (action === 'versions')
        return json(await publishChannelTransform(deps.database, claims, needKey(), channel, body, fixed))
      if (action === 'activate')
        return json(await activateChannelTransform(deps.database, claims, needKey(), channel, body, fixed))
      const rows = (body as { rows?: unknown } | null)?.rows
      const feed = await generateChannelFeed(deps.database, channel, { origin: siteOrigin, now: deps.now })
      return json(reconcileChannelFeed(feed.items, rows))
    }

    const review = /^\/api\/admin\/seo-international\/translation-reviews\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (review) {
      if (method !== 'POST') return fail('method_not_allowed', 405)
      const body = await readJson(request)
      return json(await reviewMarketTranslation(deps.database, claims, needKey(), review[1]!, body, fixed))
    }

    if (path === '/api/admin/adr-limited-quantity/carrier-restrictions') {
      if (method === 'GET') return json(await listCarrierRestrictions(deps.database, url.searchParams.get('carrier')))
      if (!mutating || method !== 'POST') return fail('method_not_allowed', 405)
      const body = await readJson(request)
      return json(await setCarrierRestriction(deps.database, claims, needKey(), body, fixed))
    }

    if (path === '/api/admin/adr-limited-quantity/specialist-validations') {
      if (method === 'GET') {
        const variantId = url.searchParams.get('variantId')
        if (!variantId || variantId.length > 64) return fail('invalid_input', 400)
        const latest = await getSpecialistValidation(deps.database, variantId)
        return latest ? json(latest) : fail('not_found', 404)
      }
      if (method !== 'POST') return fail('method_not_allowed', 405)
      const body = await readJson(request)
      return json(await recordSpecialistValidation(deps.database, claims, needKey(), body, fixed))
    }

    return fail('not_found', 404)
  } catch (error) {
    if (error instanceof BodyError) return fail(error.code, error.status)
    return mapError(error)
  }
}
