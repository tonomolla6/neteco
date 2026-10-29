import { z } from 'zod'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { AdminCompaniesError, authorizeD1CompanyReview } from '../auth/admin-companies'
import type { VerifiedSessionClaims } from './authorization'
import { B2BCreditError, readD1B2BCustomerTerms, upsertD1B2BCreditTerms } from './b2b-credit'
import { listD1B2BTransferSimulations, reconcileD1B2BTransfer } from './b2b-transfer-reconciliation'
import {
  assignD1CompanyB2BPriceList,
  B2BPricingError,
  unassignD1CompanyB2BPriceList,
  upsertD1B2BPriceList
} from './b2b-pricing'

interface Dependencies {
  database: D1Database
  origin: string
  environment?: string
  session: (request: Request) => Promise<VerifiedSessionClaims | null>
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra
    }
  })
const fail = (code: string, status: number) => json({ error: { code } }, status)
async function body(request: Request): Promise<unknown> {
  const size = request.headers.get('content-length')
  if (size && (!/^\d+$/.test(size) || Number(size) > 65536)) throw new B2BCreditError('invalid_input')
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? ''))
    throw new B2BCreditError('invalid_input')
  const reader = request.body?.getReader()
  if (!reader) throw new B2BCreditError('invalid_input')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    length += chunk.value.length
    if (length > 65536) {
      await reader.cancel()
      throw new B2BCreditError('invalid_input')
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new B2BCreditError('invalid_input')
  }
}
export async function handleB2BHttp(request: Request, deps: Dependencies): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  const admin = path === '/api/admin/b2b',
    account = path === '/api/account/b2b',
    list = path === '/api/admin/b2b/price-lists'
  const company = /^\/api\/admin\/b2b\/companies\/([^/]+)\/(credit|assignment)$/.exec(path)
  const transferList = path === '/api/admin/b2b/transfers'
  const transfer = /^\/api\/admin\/b2b\/transfers\/([^/]+)$/.exec(path)
  if (!admin && !account && !list && !company && !transferList && !transfer) return null
  const method = admin || account || transferList ? 'GET' : 'PUT'
  if (request.method !== method) return json({ error: { code: 'method_not_allowed' } }, 405, { Allow: method })
  if (url.search) return fail('invalid_input', 400)
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin) return fail('unavailable', 503)
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (method === 'PUT' && request.headers.get('origin') !== deps.origin)
    )
      return fail('csrf_rejected', 403)
    const limited = await checkAdministrativeEdgeLimit(
      request,
      deps.edgeLimiter,
      deps.rateLimitPepper,
      'admin-capabilities'
    )
    if (limited !== 'allowed')
      return fail(limited === 'limited' ? 'rate_limited' : 'unavailable', limited === 'limited' ? 429 : 503)
    const claims = await deps.session(request)
    if (!claims) return fail('unauthenticated', 401)
    const options = { now: deps.now }
    if (account) return json({ terms: await readD1B2BCustomerTerms(deps.database, claims, options) })
    await authorizeD1CompanyReview(deps.database, claims, options)
    if (transferList) {
      if (deps.environment !== 'local') return json({ enabled: false, orders: [] })
      return json({
        enabled: true,
        orders: await listD1B2BTransferSimulations(deps.database, claims, {
          environment: deps.environment,
          now: deps.now
        })
      })
    }
    if (admin) {
      const now = deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const [companies, lists] = await deps.database.batch<Record<string, unknown>>([
        deps.database
          .prepare(
            `SELECT c.id,c.legal_name AS legalName,c.status,t.payment_days AS paymentDays,t.credit_limit_cents AS creditLimitCents,t.blocked,t.block_reason AS blockReason,t.version AS creditVersion,
          a.price_list_id AS priceListId,a.version AS assignmentVersion,a.active AS assignmentActive,
          COALESCE((SELECT SUM(open.outstanding_cents) FROM b2b_credit_open_amounts open WHERE open.company_id=c.id AND
            (open.order_id IS NOT NULL OR (open.state IN('reserving','reserved') AND open.reservation_expires_at>?1))),0) AS exposureCents
          FROM companies c LEFT JOIN b2b_credit_terms t ON t.company_id=c.id LEFT JOIN b2b_company_assignments a ON a.company_id=c.id ORDER BY c.legal_name,c.id LIMIT 200`
          )
          .bind(now),
        deps.database
          .prepare(`SELECT l.id,l.code,l.name,l.status,l.version,l.valid_from AS validFrom,l.valid_until AS validUntil,
          (SELECT json_group_array(json_object('variantId',variant_id,'unitGrossCents',unit_gross_cents)) FROM b2b_variant_rules WHERE price_list_id=l.id) AS variantRules,
          (SELECT json_group_array(json_object('categoryId',category_id,'discountBps',discount_basis_points)) FROM b2b_category_rules WHERE price_list_id=l.id) AS categoryRules
          FROM b2b_price_lists l ORDER BY l.name,l.id LIMIT 200`)
      ])
      await authorizeD1CompanyReview(deps.database, claims, options)
      if (!companies || !lists) throw new B2BCreditError('unavailable')
      return json({
        companies: companies.results,
        priceLists: lists.results.map((item) => ({
          ...item,
          variantRules: JSON.parse(String(item.variantRules)),
          categoryRules: JSON.parse(String(item.categoryRules))
        }))
      })
    }
    const key = request.headers.get('idempotency-key')
    if (!z.string().uuid().safeParse(key).success) return fail('invalid_input', 400)
    const payload = await body(request)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-company-review',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return fail('rate_limited', 429)
    const commandOptions = { idempotencyKey: key!, now: deps.now }
    if (transfer)
      return json(
        await reconcileD1B2BTransfer(deps.database, claims, transfer[1]!, payload, {
          ...commandOptions,
          environment: deps.environment ?? ''
        })
      )
    if (list) return json(await upsertD1B2BPriceList(deps.database, claims, payload, commandOptions))
    const id = company![1]!
    if (!z.string().uuid().safeParse(id).success) return fail('invalid_input', 400)
    if (company![2] === 'credit')
      return json(await upsertD1B2BCreditTerms(deps.database, claims, id, payload, commandOptions))
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as { remove?: unknown }).remove === true
    ) {
      const parsed = z
        .object({
          remove: z.literal(true),
          expectedVersion: z.number().int().safe().positive(),
          reason: z.string().trim().min(3).max(500)
        })
        .strict()
        .safeParse(payload)
      if (!parsed.success) return fail('invalid_input', 400)
      return json(
        await unassignD1CompanyB2BPriceList(
          deps.database,
          claims,
          id,
          { expectedVersion: parsed.data.expectedVersion, reason: parsed.data.reason },
          commandOptions
        )
      )
    }
    return json(await assignD1CompanyB2BPriceList(deps.database, claims, id, payload, commandOptions))
  } catch (error) {
    if (error instanceof AdminCompaniesError) {
      const status =
        error.code === 'unauthenticated'
          ? 401
          : error.code === 'invalid_input'
            ? 400
            : error.code === 'conflict'
              ? 409
              : error.code === 'unavailable'
                ? 503
                : 403
      return fail(error.code, status)
    }
    if (error instanceof B2BCreditError || error instanceof B2BPricingError) {
      const status =
        error.code === 'unauthorized'
          ? 401
          : error.code === 'invalid_input'
            ? 400
            : error.code === 'conflict'
              ? 409
              : 503
      return fail(error.code, status)
    }
    return fail('unavailable', 503)
  }
}
