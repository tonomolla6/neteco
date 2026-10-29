import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  inventoryLegacyIdSchema,
  inventoryIdempotencyKeySchema,
  inventoryCommandReceiptSchema,
  inventoryVariantSearchInputSchema,
  inventoryReceiptInputSchema,
  inventoryCountProposalInputSchema,
  type InventoryCommandReceipt
} from '../../shared/inventory-commands'
import { verifySessionCookie } from '../auth/session-cookie'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import {
  InventoryCommandError,
  readD1AdminInventoryVariant,
  readD1AdminInventoryVariants,
  parseAdminInventoryCoordinatorCommand,
  type AdminInventoryCoordinatorCommand
} from './admin-inventory'

export type AdminInventoryHttpEnvironment = Pick<
  CloudflareEnv,
  'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'
>
export interface AdminInventoryHttpDependencies {
  coordinate: (command: AdminInventoryCoordinatorCommand) => Promise<InventoryCommandReceipt>
}
export const inventoryCommandErrorCodeSchema = z.enum([
  'invalid_input',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'not_found',
  'version_conflict',
  'idempotency_conflict',
  'warehouse_unavailable',
  'reconciliation_required',
  'insufficient_stock',
  'approval_self',
  'proposal_unavailable',
  'no_change',
  'conflict'
])
export function adminInventoryErrorStatus(code: z.infer<typeof inventoryCommandErrorCodeSchema>) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'invalid_input') return 422
  return 409
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      ...headers
    }
  })
}
const error = (code: string, status: number, headers: Record<string, string> = {}) =>
  json({ error: { code } }, status, headers)
export function ownsAdminInventoryNamespace(pathname: string): boolean {
  let path = pathname
  for (let attempts = 0; attempts < 4; attempts++) {
    if (/^\/api\/admin\/inventory(?:[/\\%]|$)/.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) return false
      path = decoded
    } catch {
      return false
    }
  }
  return false
}
type Route =
  | { kind: 'search' }
  | { kind: 'read'; variantId: string }
  | { kind: 'receipt' | 'count_propose'; variantId: string }
  | { kind: 'count_approve'; variantId: string; countId: string }
function routeAt(path: string): Route | null {
  if (path === '/api/admin/inventory/variants') return { kind: 'search' }
  const match = /^\/api\/admin\/inventory\/variants\/([^/]+)(?:\/(receipts|counts)(?:\/([^/]+)\/(approve))?)?$/.exec(
    path
  )
  if (!match || !inventoryLegacyIdSchema.safeParse(match[1]).success) return null
  if (!match[2]) return { kind: 'read', variantId: match[1]! }
  if (match[3])
    return match[2] === 'counts' && catalogPolicyUuidSchema.safeParse(match[3]).success
      ? { kind: 'count_approve', variantId: match[1]!, countId: match[3] }
      : null
  return { kind: match[2] === 'receipts' ? 'receipt' : 'count_propose', variantId: match[1]! }
}
class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length'),
    limit = 64 * 1024
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit))
    throw new HttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new HttpError('json_required', 415)
  if (!request.body) throw new HttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(limit)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new HttpError('invalid_json', 400)
      if (next.value.byteLength > limit - length) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError('body_too_large', 413)
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (!length) throw new HttpError('missing_body', 400)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown
  } catch {
    throw new HttpError('invalid_json', 400)
  }
}
function pageAt(url: URL, search = false) {
  if (
    [...url.searchParams.keys()].some(
      (key) => !(search ? ['q', 'page', 'perPage'] : ['page', 'perPage']).includes(key)
    ) ||
    [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new HttpError('invalid_input', 400)
  const page = url.searchParams.get('page') ?? '1',
    perPage = url.searchParams.get('perPage') ?? '25'
  if (
    !inventoryLegacyIdSchema.safeParse(page).success ||
    !inventoryLegacyIdSchema.safeParse(perPage).success ||
    Number(page) > 1_000_000 ||
    Number(perPage) > (search ? 25 : 50)
  )
    throw new HttpError('invalid_input', 400)
  return { page: Number(page), perPage: Number(perPage) }
}
/** This private API never calls the DO publicly or falls back to an uncoordinated
 * write. The principal supplies the existing global coordinator's internal call. */
export async function handleAdminInventoryHttp(
  request: Request,
  env: AdminInventoryHttpEnvironment,
  dependencies: AdminInventoryHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsAdminInventoryNamespace(url.pathname)) return null
  try {
    const configured = new URL(env.AUTH_ORIGIN)
    if (configured.protocol !== 'https:' || configured.origin !== env.AUTH_ORIGIN || env.AUTH_ORIGIN.length > 2000)
      throw new Error('invalid_inventory_origin')
    const route = routeAt(url.pathname),
      write = request.method !== 'GET'
    if (
      (write
        ? request.headers.get('origin') !== env.AUTH_ORIGIN
        : request.headers.has('origin') && request.headers.get('origin') !== env.AUTH_ORIGIN) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    if (!route) return error('invalid_input', 400)
    const readonly = route.kind === 'read' || route.kind === 'search'
    const method = readonly ? 'GET' : 'POST'
    if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
    const pagination = readonly ? pageAt(url, route.kind === 'search') : null
    const search =
      route.kind === 'search'
        ? inventoryVariantSearchInputSchema.safeParse({ q: url.searchParams.get('q') ?? '', ...pagination })
        : null
    if (search && !search.success) return error('invalid_input', 400)
    if (!readonly && url.searchParams.size) return error('invalid_input', 400)
    if (env.AUTH_ENABLED !== 'true') return error('service_unavailable', 503)
    const claims = await verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
    if (!claims) return error('unauthenticated', 401)
    const auth = await authorizeD1Session(env.DB, claims, readonly ? 'inventory.read' : 'inventory.write', {
      requireMfa: true
    })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)
    if (route.kind === 'search') {
      if (!search?.success) throw new Error('inventory_search_query_invalid')
      return json(await readD1AdminInventoryVariants(env.DB, claims, search.data))
    }
    if (route.kind === 'read')
      return json(await readD1AdminInventoryVariant(env.DB, claims, route.variantId, pagination!))
    const key = inventoryIdempotencyKeySchema.safeParse(request.headers.get('idempotency-key'))
    if (!key.success) return error('invalid_idempotency_key', 400)
    const quota = await consumeIdentityQuota(env.DB, {
      identityId: claims.identityId,
      scope: 'admin-inventory',
      limit: 60,
      windowSeconds: 3600
    })
    const headers = { 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': String(quota.remaining) }
    if (!quota.allowed) return error('rate_limited', 429, { ...headers, 'Retry-After': String(quota.retryAfter) })
    const command = parseAdminInventoryCoordinatorCommand({
      type: 'admin_inventory',
      claims,
      action: route.kind,
      target: { variantId: route.variantId, ...(route.kind === 'count_approve' ? { countId: route.countId } : {}) },
      input: await body(request),
      idempotencyKey: key.data
    })
    // Auth may be revoked while the body stream is arriving. Never send a newly
    // unauthorized intent to the coordinator, even though D1 also guards it.
    const fresh = await authorizeD1Session(env.DB, claims, 'inventory.write', { requireMfa: true })
    if (!fresh.allowed) return error(fresh.code, fresh.code === 'unauthenticated' ? 401 : 403)
    const result = inventoryCommandReceiptSchema.safeParse(catalogPolicyOwnJson(await dependencies.coordinate(command)))
    if (
      !result.success ||
      result.data.action !== route.kind ||
      result.data.variantId !== Number(route.variantId) ||
      (route.kind === 'count_approve' && result.data.proposalId !== route.countId)
    )
      throw new Error('inventory_coordinator_receipt_invalid')
    if (
      route.kind === 'receipt' &&
      result.data.physicalDelta !== inventoryReceiptInputSchema.parse(command.input).quantity
    )
      throw new Error('inventory_coordinator_receipt_invalid')
    if (
      route.kind === 'count_propose' &&
      result.data.physicalQuantity + result.data.proposedPhysicalDelta! !==
        inventoryCountProposalInputSchema.parse(command.input).countedPhysicalQuantity
    )
      throw new Error('inventory_coordinator_receipt_invalid')
    const authorizedReturn = await authorizeD1Session(env.DB, claims, 'inventory.write', { requireMfa: true })
    if (!authorizedReturn.allowed)
      return error(authorizedReturn.code, authorizedReturn.code === 'unauthenticated' ? 401 : 403)
    // The engine returns the persisted object. Validation must not reorder it.
    return json(result.data, 200, headers)
  } catch (failure) {
    if (failure instanceof HttpError) return error(failure.code, failure.status)
    if (failure instanceof InventoryCommandError) return error(failure.code, adminInventoryErrorStatus(failure.code))
    return error('service_unavailable', 503)
  }
}
