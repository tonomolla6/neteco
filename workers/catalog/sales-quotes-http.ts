import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { z } from 'zod'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { supportBytes } from '../support/http'
import { SupportError } from '../support/operations'
import { credentials } from './storefront-cart'
import { activeOrderCustomerId } from './customer-orders'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  salesQuoteConvertInputSchema,
  salesQuoteReceiptSchema,
  salesQuoteCommandSchema,
  type SalesQuoteAction
} from '../../shared/sales-quotes'
import {
  SalesQuoteError,
  authorizeD1SalesQuoteAdmin,
  executeD1SalesQuoteCommand,
  readD1AdminSalesQuote,
  readD1CustomerSalesQuote,
  listD1SalesQuotes,
  readD1SalesQuoteCommand,
  convertD1SalesQuote,
  prepareD1SalesQuoteShipping
} from './sales-quotes'
import type { CheckoutInventoryGateway } from './checkout'

export interface SalesQuotesHttpDependencies {
  database: D1Database
  origin: string
  sessionCookieConfiguration: SessionCookieConfiguration | null
  rateLimitPepper: string
  edgeGate: (request: Request) => Promise<'allowed' | 'denied' | 'unavailable'>
  /** Canonical InventoryCoordinator bridge supplied by the runtime; never HTTP input. */
  inventory: CheckoutInventoryGateway
  now?: string
  freeShippingThresholdCents?: number | null
}
export function ownsSalesQuotesNamespace(path: string) {
  if (path.length > 4096) return false
  let value = path
  for (let attempt = 0; attempt < 4; attempt++) {
    if (/^\/api\/(?:admin|account)\/sales-quotes(?:[/\\%]|$)/i.test(value)) return true
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
const statuses: Record<string, number> = {
  invalid_input: 422,
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  quote_expired: 409,
  quote_not_approved: 409,
  quote_changed: 409,
  history_unconfirmed: 503,
  service_unavailable: 503,
  body_too_large: 413
}
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extra
    }
  })
const failure = (code: string, status = statuses[code] ?? 503) => json({ error: { code } }, status)
async function body(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new SalesQuoteError('invalid_input')
  const bytes = await supportBytes(request, 131072)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}
/** Edge is mandatory and invoked once before cookies/D1. Writes share a 60/h identity quota. */
export async function handleSalesQuotesHttp(
  request: Request,
  deps: SalesQuotesHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsSalesQuotesNamespace(url.pathname)) return null
  const match =
    /^\/api\/(admin|account)\/sales-quotes(?:\/(commands\/)?([a-f0-9-]{36})(?:\/(commands|convert|shipping-options))?)?$/.exec(
      url.pathname
    )
  if (!match || (match[3] && !catalogPolicyUuidSchema.safeParse(match[3]).success)) return failure('invalid_input', 400)
  const audience = match[1] === 'admin' ? 'admin' : 'customer',
    command = !!match[2],
    id = match[3],
    actionRoute = match[4],
    list = !id,
    converting = actionRoute === 'convert',
    preparingShipping = actionRoute === 'shipping-options',
    writing = request.method === 'POST'
  if (
    (command && actionRoute) ||
    ((converting || preparingShipping) && audience !== 'customer') ||
    (actionRoute === 'commands' && audience !== 'admin')
  )
    return failure('not_found')
  const allowed = list && audience === 'admin' ? 'GET, POST' : actionRoute ? 'POST' : 'GET'
  if (!allowed.split(', ').includes(request.method))
    return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: allowed })
  try {
    if (typeof deps.edgeGate !== 'function') return failure('service_unavailable')
    const edge = await deps.edgeGate(request)
    if (edge === 'denied') return json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '60' })
    if (edge !== 'allowed') return failure('service_unavailable')
    if (
      !deps.sessionCookieConfiguration ||
      typeof deps.rateLimitPepper !== 'string' ||
      deps.rateLimitPepper.length < 32 ||
      deps.rateLimitPepper.startsWith('local-only-') ||
      new URL(deps.origin).origin !== deps.origin ||
      new URL(deps.origin).protocol !== 'https:'
    )
      return failure('service_unavailable')
    if (
      url.origin !== deps.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (writing
        ? request.headers.get('origin') !== deps.origin
        : request.headers.has('origin') && request.headers.get('origin') !== deps.origin)
    )
      return failure('forbidden')
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return failure('unauthenticated')
    const options = { now: deps.now, freeShippingThresholdCents: deps.freeShippingThresholdCents }
    if (audience === 'admin') await authorizeD1SalesQuoteAdmin(deps.database, claims, options)
    else if (
      !(await activeOrderCustomerId(
        deps.database,
        claims,
        deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      ))
    )
      return failure('unauthenticated')
    for (const name of url.searchParams.keys())
      if (writing || !list || name !== 'page' || url.searchParams.getAll(name).length !== 1)
        return failure('invalid_input', 400)
    if (!writing) {
      if (command) {
        const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
        if (!/^[a-f0-9]{64}$/.test(hash)) return failure('invalid_input', 400)
        const result = salesQuoteCommandSchema.parse(
          await readD1SalesQuoteCommand(deps.database, claims, id!, hash, options)
        )
        if (result.outcome === 'applied' && (result.receipt.commandId !== id || result.receipt.payloadHash !== hash))
          return failure('history_unconfirmed')
        return json(result)
      }
      if (list) {
        const value = url.searchParams.get('page') ?? '1'
        if (!/^[1-9]\d{0,5}$/.test(value)) return failure('invalid_input', 400)
        return json(await listD1SalesQuotes(deps.database, claims, audience, Number(value), options))
      }
      return json(
        audience === 'admin'
          ? await readD1AdminSalesQuote(deps.database, claims, id!, options)
          : await readD1CustomerSalesQuote(deps.database, claims, id!, options)
      )
    }
    const key = request.headers.get('Idempotency-Key')
    if (!catalogPolicyUuidSchema.safeParse(key).success) return failure('invalid_input', 400)
    const raw = await body(request)
    if (raw === undefined) return failure('invalid_input', 400)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'sales-quotes',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now) / 1000) } : {})
    })
    if (!quota.allowed)
      return json({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': String(quota.retryAfter) })
    if (preparingShipping) {
      const parsed = z
        .object({ expectedVersion: z.number().int().positive(), approvedHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .safeParse(raw)
      if (!parsed.success) return failure('invalid_input')
      const cart = credentials(request)
      if (!cart) return failure('unauthenticated')
      return json(
        await prepareD1SalesQuoteShipping(deps.database, claims, id!, parsed.data, cart, {
          ...options,
          idempotencyKey: key!
        })
      )
    }
    if (converting) {
      const parsed = salesQuoteConvertInputSchema.safeParse(raw),
        cart = credentials(request)
      if (!parsed.success) return failure('invalid_input')
      if (!cart) return failure('unauthenticated')
      const receipt = await convertD1SalesQuote(
        deps.database,
        claims,
        id!,
        {
          ...parsed.data,
          checkout: {
            ...parsed.data.checkout,
            ...cart,
            ownerSession: claims,
            idempotencyKey: key!,
            correlationId: `sales-quote:${key}`,
            now: deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
          }
        },
        { ...options, inventory: deps.inventory, idempotencyKey: key! }
      )
      return json(salesQuoteReceiptSchema.parse(receipt), 201)
    }
    let action: SalesQuoteAction = 'create',
      input = raw
    if (!list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('invalid_input')
      const { action: candidate, ...rest } = raw as Record<string, unknown>
      if (!['revise', 'review', 'approve', 'revoke'].includes(String(candidate))) return failure('invalid_input')
      action = candidate as SalesQuoteAction
      input = rest
    }
    return json(
      salesQuoteReceiptSchema.parse(
        await executeD1SalesQuoteCommand(deps.database, claims, action, id ?? null, input, {
          ...options,
          idempotencyKey: key!
        })
      ),
      201
    )
  } catch (error) {
    if (error instanceof SalesQuoteError || error instanceof SupportError) return failure(error.code)
    return failure('service_unavailable')
  }
}
