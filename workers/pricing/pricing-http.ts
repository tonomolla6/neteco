import { z } from 'zod'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import {
  createAutoDiscountRule,
  listAutoDiscountRules,
  previewAutoDiscounts,
  setAutoDiscountRuleStatus,
  updateAutoDiscountRule
} from './auto-discounts'
import { PricingError, authorizeAdmin, isoNow, type PricingErrorCode, type VerifiedSessionClaims } from './common'
import {
  createFreeShippingRule,
  listFreeShippingRules,
  setFreeShippingRuleStatus,
  simulateFreeShipping,
  updateFreeShippingRule
} from './free-shipping'
import {
  cancelPaymentSchedule,
  createPaymentSchedule,
  getCustomerPaymentSchedule,
  getScheduleReconciliation,
  recordScheduleEntry
} from './payment-schedules'
import {
  expireDueStoreCredit,
  freezeStoreCredit,
  getStoreCreditSummary,
  issueStoreCredit,
  reconcileStoreCredit,
  redeemStoreCredit,
  restoreStoreCredit,
  voidStoreCreditGrant
} from './store-credit'

export interface PricingHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration | null
  origin?: string
  edgeLimiter?: RateLimit
  rateLimitPepper?: string
  ownDeliveryPrefixes?: readonly string[]
  now?: string | (() => string)
}

const ADMIN = '/api/admin/pricing'
const PUBLIC =
  /^\/api\/(pricing\/auto-discounts\/preview|account\/store-credit(\/redeem)?|account\/payment-schedules\/[^/]+)$/
const MAX_BODY = 65536

function decodedPath(path: string): string {
  let value = path
  for (let i = 0; i < 5; i++) {
    try {
      const next = decodeURIComponent(value)
      if (next === value) break
      value = next
    } catch {
      break
    }
  }
  return value
}
export function ownsPricingNamespace(path: string): boolean {
  const v = decodedPath(path)
  return v === ADMIN || v.startsWith(`${ADMIN}/`) || PUBLIC.test(v)
}

const STATUS: Record<PricingErrorCode | 'csrf_rejected' | 'method_not_allowed' | 'payload_too_large', number> = {
  invalid_input: 400,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  invalid_transition: 409,
  limit_reached: 429,
  insufficient_credit: 422,
  account_frozen: 423,
  overpayment: 422,
  payload_too_large: 413,
  variant_not_available: 422,
  rate_limited: 429,
  service_unavailable: 503
}
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  pragma: 'no-cache',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer'
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS })
const errorResponse = (code: keyof typeof STATUS | 'internal_error') =>
  json({ error: { code } }, code === 'internal_error' ? 500 : STATUS[code])
class TooLarge extends Error {}

async function body(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => fail('invalid_input'))
  if (new TextEncoder().encode(text).length > MAX_BODY) throw new TooLarge()
  try {
    return JSON.parse(text)
  } catch {
    return fail('invalid_input')
  }
}
function fail(code: PricingErrorCode): never {
  throw new PricingError(code)
}
const idemKey = (request: Request) => {
  const k = request.headers.get('idempotency-key')
  if (!k || k.length < 8 || k.length > 128) fail('invalid_input')
  return k
}
const version = z.number().int().min(1)
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) fail('invalid_input')
  return r.data
}
const ruleUpdate = z.object({ expectedVersion: version, rule: z.unknown() }).strict()
const statusBody = z
  .object({ expectedVersion: version, status: z.enum(['draft', 'active', 'paused', 'archived']) })
  .strict()
const versionBody = z.object({ expectedVersion: version }).strict()
const freezeBody = z.object({ expectedVersion: version, freeze: z.unknown() }).strict()
const entryBody = z.object({ expectedVersion: version, entry: z.unknown() }).strict()

export async function handlePricingHttp(request: Request, deps: PricingHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPricingNamespace(url.pathname)) return null
  const path = decodedPath(url.pathname)
  const method = request.method
  const now = typeof deps.now === 'function' ? deps.now() : (deps.now ?? isoNow())
  try {
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.get('origin')
      if (!deps.origin || origin !== deps.origin || request.headers.get('sec-fetch-site') === 'cross-site')
        return errorResponse('csrf_rejected')
    }
    if (!deps.edgeLimiter || !deps.rateLimitPepper) return errorResponse('service_unavailable')
    const admin = path === ADMIN || path.startsWith(`${ADMIN}/`)
    const outcome = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      admin ? 'admin-catalog' : 'storefront-cart'
    )
    if (outcome === 'limited') return errorResponse('rate_limited')
    if (outcome === 'unavailable') return errorResponse('service_unavailable')
    const claims = deps.sessionCookieConfiguration
      ? await verifySessionCookie(request, deps.sessionCookieConfiguration)
      : null
    if (admin) {
      if (!deps.sessionCookieConfiguration) return errorResponse('service_unavailable')
      if (!claims) return errorResponse('unauthenticated')
      await authorizeAdmin(deps.database, claims, now)
      return await adminRoutes(request, deps, claims, path.slice(ADMIN.length + 1).split('/'), method, now)
    }
    return await publicRoutes(request, deps, claims, path, method, now)
  } catch (error) {
    if (error instanceof PricingError) return errorResponse(error.code)
    if (error instanceof TooLarge) return errorResponse('payload_too_large')
    return errorResponse('internal_error')
  }
}

async function publicRoutes(
  request: Request,
  deps: PricingHttpDependencies,
  claims: VerifiedSessionClaims | null,
  path: string,
  method: string,
  now: string
): Promise<Response> {
  const db = deps.database
  if (path === '/api/pricing/auto-discounts/preview') {
    if (method !== 'POST') return errorResponse('method_not_allowed')
    return json(await previewAutoDiscounts(db, claims, await body(request), now))
  }
  if (!claims) return errorResponse('unauthenticated')
  if (path === '/api/account/store-credit') {
    if (method !== 'GET') return errorResponse('method_not_allowed')
    return json(await getStoreCreditSummary(db, claims, now))
  }
  if (path === '/api/account/store-credit/redeem') {
    if (method !== 'POST') return errorResponse('method_not_allowed')
    const receipt = await redeemStoreCredit(db, claims, await body(request), idemKey(request), now)
    return json({ result: receipt.result })
  }
  if (method !== 'GET') return errorResponse('method_not_allowed')
  return json(await getCustomerPaymentSchedule(db, claims, path.split('/')[3]!, now))
}

async function adminRoutes(
  request: Request,
  deps: PricingHttpDependencies,
  claims: VerifiedSessionClaims,
  seg: string[],
  method: string,
  now: string
): Promise<Response> {
  const db = deps.database
  const [area, id, leaf] = seg
  // Authorization is live again after the work, before the answer leaves.
  const send = async (status: number, data: unknown) => {
    await authorizeAdmin(db, claims, now)
    return json(data, status)
  }
  const rules =
    (
      list: typeof listAutoDiscountRules,
      create: typeof createAutoDiscountRule,
      update: typeof updateAutoDiscountRule,
      status: typeof setAutoDiscountRuleStatus
    ) =>
    async () => {
      if (seg.length === 1 && method === 'GET') return send(200, { rules: await list(db, claims, now) })
      if (seg.length === 1 && method === 'POST')
        return send(201, await create(db, claims, await body(request), idemKey(request), now))
      if (seg.length === 2 && method === 'PUT') {
        const b = parse(ruleUpdate, await body(request))
        return send(200, await update(db, claims, id!, b.rule, b.expectedVersion, idemKey(request), now))
      }
      if (seg.length === 3 && leaf === 'status' && method === 'POST') {
        const b = parse(statusBody, await body(request))
        return send(200, await status(db, claims, id!, b.status, b.expectedVersion, idemKey(request), now))
      }
      return errorResponse('not_found')
    }
  if (area === 'auto-discounts')
    return rules(listAutoDiscountRules, createAutoDiscountRule, updateAutoDiscountRule, setAutoDiscountRuleStatus)()
  if (area === 'free-shipping-rules')
    return rules(
      listFreeShippingRules as unknown as typeof listAutoDiscountRules,
      createFreeShippingRule,
      updateFreeShippingRule,
      setFreeShippingRuleStatus as unknown as typeof setAutoDiscountRuleStatus
    )()
  if (area === 'free-shipping' && id === 'simulate' && method === 'POST')
    return send(
      200,
      await simulateFreeShipping(db, claims, await body(request), now, {
        ownDeliveryPrefixes: deps.ownDeliveryPrefixes ?? []
      })
    )

  if (area === 'store-credit') {
    if (id === 'issue' && method === 'POST')
      return send(201, await issueStoreCredit(db, claims, await body(request), idemKey(request), now))
    if (id === 'expire' && method === 'POST')
      return send(200, await expireDueStoreCredit(db, claims, idemKey(request), now))
    if (id === 'void' && method === 'POST')
      return send(200, await voidStoreCreditGrant(db, claims, await body(request), idemKey(request), now))
    if (id === 'restore' && method === 'POST')
      return send(200, await restoreStoreCredit(db, claims, await body(request), idemKey(request), now))
    if (id === 'freeze' && method === 'POST') {
      const b = parse(freezeBody, await body(request))
      return send(200, await freezeStoreCredit(db, claims, b.freeze, b.expectedVersion, idemKey(request), now))
    }
    if (id && leaf === 'reconcile' && method === 'GET')
      return send(200, await reconcileStoreCredit(db, claims, id, now))
  }
  if (area === 'payment-schedules') {
    if (seg.length === 1 && method === 'POST')
      return send(201, await createPaymentSchedule(db, claims, await body(request), idemKey(request), now))
    if (seg.length === 2 && method === 'GET') return send(200, await getScheduleReconciliation(db, claims, id!, now))
    if (seg.length === 3 && leaf === 'entries' && method === 'POST') {
      const b = parse(entryBody, await body(request))
      return send(200, await recordScheduleEntry(db, claims, id!, b.entry, b.expectedVersion, idemKey(request), now))
    }
    if (seg.length === 3 && leaf === 'cancel' && method === 'POST') {
      const b = parse(versionBody, await body(request))
      return send(200, await cancelPaymentSchedule(db, claims, id!, b.expectedVersion, idemKey(request), now))
    }
  }
  return errorResponse('not_found')
}
