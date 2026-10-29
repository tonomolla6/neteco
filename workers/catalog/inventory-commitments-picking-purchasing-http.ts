import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  inventoryOpsActionSchema,
  type InventoryOpsErrorCode
} from '../../shared/inventory-commitments-picking-purchasing'
import { authorizeD1Session } from './authorization'
import {
  InventoryOpsError,
  executeInventoryOpsCommand,
  listCommitments,
  listPickLocations,
  listPickStock,
  listPurchaseOrders,
  planPick,
  readPickConsistency,
  readPurchaseOrder
} from './inventory-commitments-picking-purchasing'

export interface InventoryOpsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}

const NAMESPACE = /^\/api\/admin\/inventory\/(?:commitments|pick-locations|purchase-orders|operations)(?:[/\\%]|$)/

export function ownsInventoryOpsNamespace(path: string): boolean {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (NAMESPACE.test(value)) return true
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

const statusByCode: Partial<Record<InventoryOpsErrorCode, number>> = {
  unauthenticated: 401,
  email_unverified: 403,
  mfa_required: 403,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_input: 400,
  rate_limited: 429,
  unavailable: 503
}
const statusFor = (code: string) => statusByCode[code as InventoryOpsErrorCode] ?? 409

const commandBodySchema = z
  .object({
    action: inventoryOpsActionSchema,
    targetId: catalogPolicyUuidSchema,
    input: z.record(z.string(), z.unknown())
  })
  .strict()
const commitmentStatus = z.enum(['active', 'fulfilled', 'released', 'expired'])
const poStatus = z.enum(['draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled'])
const optionalUuid = catalogPolicyUuidSchema.optional()

export async function handleInventoryOpsHttp(
  request: Request,
  deps: InventoryOpsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsInventoryOpsNamespace(url.pathname)) return null
  const json = (body: unknown, code = 200, extra: Record<string, string> = {}) =>
    Response.json(body, {
      status: code,
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
  const error = (code: string, extra?: Record<string, string>) => json({ error: { code } }, statusFor(code), extra)

  try {
    const isWrite = request.method !== 'GET'
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (isWrite && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected')
    if (request.method !== 'GET' && request.method !== 'POST') return error('method_not_allowed')

    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-inventory')
    if (edge !== 'allowed') return error(edge === 'limited' ? 'rate_limited' : 'unavailable')

    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated')
    const permission = isWrite ? 'inventory.write' : 'inventory.read'
    const authorize = () =>
      authorizeD1Session(deps.database, claims, permission, {
        requireMfa: true,
        ...(deps.now ? { now: deps.now() } : {})
      })
    const initial = await authorize()
    if (!initial.allowed) return error(initial.code)

    const path = url.pathname
    const now = deps.now ? deps.now() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    // Live authorization is re-checked after the data was read, before anything is returned.
    const respond = async (body: unknown) => {
      const final = await authorize()
      return final.allowed ? json(body) : error(final.code)
    }
    const query = <T extends z.ZodType>(schema: T, raw: Record<string, string | undefined>) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new InventoryOpsError('invalid_input')
      return parsed.data as z.infer<T>
    }
    const param = (name: string) => url.searchParams.get(name) ?? undefined

    if (request.method === 'GET') {
      if (path === '/api/admin/inventory/commitments') {
        const filter = query(
          z.object({ variantId: optionalUuid, customerId: optionalUuid, status: commitmentStatus.optional() }).strict(),
          { variantId: param('variantId'), customerId: param('customerId'), status: param('status') }
        )
        return respond({ items: await listCommitments(deps.database, filter, now) })
      }
      if (path === '/api/admin/inventory/pick-locations')
        return respond({ items: await listPickLocations(deps.database) })
      if (path === '/api/admin/inventory/pick-locations/stock') {
        const { variantId } = query(z.object({ variantId: catalogPolicyUuidSchema }), { variantId: param('variantId') })
        return respond({ items: await listPickStock(deps.database, variantId) })
      }
      if (path === '/api/admin/inventory/pick-locations/plan') {
        const parsed = query(
          z.object({ variantId: catalogPolicyUuidSchema, quantity: z.coerce.number().int().min(1).max(1_000_000) }),
          { variantId: param('variantId'), quantity: param('quantity') }
        )
        return respond(await planPick(deps.database, parsed.variantId, parsed.quantity))
      }
      if (path === '/api/admin/inventory/pick-locations/consistency') {
        const { variantId } = query(z.object({ variantId: optionalUuid }), { variantId: param('variantId') })
        return respond(await readPickConsistency(deps.database, variantId))
      }
      if (path === '/api/admin/inventory/purchase-orders') {
        const filter = query(z.object({ status: poStatus.optional(), supplierId: optionalUuid }), {
          status: param('status'),
          supplierId: param('supplierId')
        })
        return respond({ items: await listPurchaseOrders(deps.database, filter) })
      }
      const detail = /^\/api\/admin\/inventory\/purchase-orders\/([0-9a-f-]{36})$/.exec(path)
      if (detail) {
        const order = await readPurchaseOrder(deps.database, detail[1]!)
        if (!order) return error('not_found')
        return respond(order)
      }
      return error('not_found')
    }

    if (path !== '/api/admin/inventory/operations/commands') return error('method_not_allowed')
    const key = request.headers.get('idempotency-key')
    if (!key || !catalogPolicyUuidSchema.safeParse(key).success) return error('invalid_input')
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-inventory',
      limit: 120,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', { 'Retry-After': String(quota.retryAfter) })
    const body = commandBodySchema.safeParse(await request.json().catch(() => null))
    if (!body.success) return error('invalid_input')
    const receipt = await executeInventoryOpsCommand(
      deps.database,
      claims,
      body.data.action,
      body.data.targetId,
      body.data.input,
      key,
      { now: () => now }
    )
    return respond(receipt)
  } catch (cause) {
    if (cause instanceof InventoryOpsError) return error(cause.code)
    return error('unavailable')
  }
}
