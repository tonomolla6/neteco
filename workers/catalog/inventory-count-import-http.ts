import { z } from 'zod'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  inventoryCountImportPreviewInputSchema,
  inventoryCountImportProposalInputSchema,
  inventoryCountImportApprovalInputSchema,
  inventoryCountImportPreviewSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportCommandSchema,
  inventoryCountImportListQuerySchema,
  inventoryCountImportListSchema,
  inventoryCountImportIntentHash,
  type InventoryCountImportReceipt
} from '../../shared/inventory-count-import'
import {
  InventoryCountImportError,
  previewD1InventoryCountImport,
  readD1InventoryCountImport,
  readD1InventoryCountImports,
  readD1InventoryCountImportCommand
} from './inventory-count-import'

export interface InventoryCountImportCoordinatorCommand {
  type: 'inventory_count_import'
  claims: VerifiedSessionClaims
  action: 'propose' | 'approve'
  targetId: string | null
  input: unknown
  idempotencyKey: string
}
export interface InventoryCountImportHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  coordinate: (command: InventoryCountImportCoordinatorCommand) => Promise<InventoryCountImportReceipt>
  now?: () => string
}
export function ownsInventoryCountImportNamespace(path: string) {
  let decoded = path
  for (let depth = 0; depth < 5; depth++) {
    if (/^\/api\/admin\/inventory\/count-imports(?:[/\\%]|$)/i.test(decoded)) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return false
}
class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function readBody(request: Request): Promise<unknown> {
  const limit = 128 * 1024,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit))
    throw new BoundaryError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new BoundaryError('json_required', 415)
  const reader = request.body?.getReader()
  if (!reader) throw new BoundaryError('invalid_input', 400)
  const bytes = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) throw new BoundaryError('invalid_input', 400)
      if (size + next.value.length > limit) {
        void reader.cancel().catch(() => undefined)
        throw new BoundaryError('body_too_large', 413)
      }
      bytes.set(next.value, size)
      size += next.value.length
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } catch {
    throw new BoundaryError('invalid_input', 400)
  }
}
export const inventoryCountImportErrorCodeSchema = z.enum([
  'invalid_input',
  'unauthenticated',
  'email_unverified',
  'mfa_required',
  'forbidden',
  'not_found',
  'preview_conflict',
  'approval_self',
  'version_conflict',
  'idempotency_conflict',
  'no_change',
  'source_unavailable',
  'reconciliation_required',
  'warehouse_unavailable',
  'insufficient_stock',
  'service_unavailable'
])
export function inventoryCountImportErrorStatus(code: z.infer<typeof inventoryCountImportErrorCodeSchema>) {
  if (code === 'unauthenticated') return 401
  if (['email_unverified', 'mfa_required', 'forbidden'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'invalid_input') return 400
  if (
    [
      'version_conflict',
      'idempotency_conflict',
      'approval_self',
      'no_change',
      'preview_conflict',
      'warehouse_unavailable',
      'reconciliation_required',
      'insufficient_stock'
    ].includes(code)
  )
    return 409
  return 503
}
export async function handleInventoryCountImportHttp(
  request: Request,
  deps: InventoryCountImportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsInventoryCountImportNamespace(url.pathname)) return null
  const json = (value: unknown, code = 200, extra: Record<string, string> = {}) =>
    Response.json(value, {
      status: code,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        ...extra
      }
    })
  const error = (code: string, httpStatus = 503, extra?: Record<string, string>) =>
    json({ error: { code } }, httpStatus, extra)
  const domainError = (code: unknown) => {
    const parsed = inventoryCountImportErrorCodeSchema.safeParse(code)
    return parsed.success
      ? error(parsed.data, inventoryCountImportErrorStatus(parsed.data))
      : error('service_unavailable')
  }
  const base = '/api/admin/inventory/count-imports'
  const collection = url.pathname === base,
    preview = url.pathname === base + '/preview'
  const command = /^\/api\/admin\/inventory\/count-imports\/commands\/([^/]+)$/.exec(url.pathname)
  const item = /^\/api\/admin\/inventory\/count-imports\/([^/]+)(\/approve)?$/.exec(url.pathname)
  if (!collection && !preview && !command && !item) return error('not_found', 404)
  if (
    (command && !catalogPolicyUuidSchema.safeParse(command[1]).success) ||
    (item && !preview && !catalogPolicyUuidSchema.safeParse(item[1]).success)
  )
    return error('not_found', 404)
  const methods = collection ? ['GET', 'POST'] : preview || item?.[2] ? ['POST'] : ['GET']
  if (!methods.includes(request.method)) return error('method_not_allowed', 405, { Allow: methods.join(', ') })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || url.origin !== deps.origin)
      return error('service_unavailable')
    const write = request.method === 'POST',
      list = collection && !write
    if (
      (write && request.headers.get('origin') !== deps.origin) ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (!list || !['page', 'perPage'].includes(key) || key in query || !/^[1-9][0-9]*$/.test(value))
        return error('invalid_input', 400)
      query[key] = value
    }
    const parsedQuery = inventoryCountImportListQuerySchema.safeParse(query)
    if (list && !parsedQuery.success) return error('invalid_input', 400)
    const hash = request.headers.get('x-neteco-command-payload-hash')
    if (command && (!hash || !/^[0-9a-f]{64}$/.test(hash))) return error('invalid_input', 400)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return domainError('unauthenticated')
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-inventory')
    if (edge !== 'allowed')
      return error(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
    const mutation = !preview && write
    const authorize = () =>
      authorizeD1Session(deps.database, claims, mutation || command ? 'inventory.write' : 'inventory.read', {
        requireMfa: true,
        ...(deps.now ? { now: deps.now() } : {})
      })
    const initial = await authorize()
    if (!initial.allowed) return domainError(initial.code)
    const options = deps.now ? { now: deps.now() } : {}
    if (list)
      return json(
        inventoryCountImportListSchema.parse(
          await readD1InventoryCountImports(deps.database, claims, parsedQuery.data, options)
        )
      )
    if (command) {
      const result = inventoryCountImportCommandSchema.parse(
        await readD1InventoryCountImportCommand(deps.database, claims, command[1]!, hash!, options)
      )
      if (
        result.outcome === 'applied' &&
        (result.receipt.commandId !== command[1] || result.receipt.payloadHash !== hash)
      )
        return error('service_unavailable')
      return json(result)
    }
    if (item && !write) {
      const result = inventoryCountImportSnapshotSchema.parse(
        await readD1InventoryCountImport(deps.database, claims, item[1]!, options)
      )
      if (result.importId !== item[1]) return error('service_unavailable')
      return json(result)
    }
    const raw = await readBody(request)
    if (preview) {
      const parsed = inventoryCountImportPreviewInputSchema.safeParse(raw)
      if (!parsed.success) return error('invalid_input', 400)
      return json(
        inventoryCountImportPreviewSchema.parse(
          await previewD1InventoryCountImport(deps.database, claims, parsed.data, options)
        )
      )
    }
    const key = request.headers.get('idempotency-key')
    if (!catalogPolicyUuidSchema.safeParse(key).success) return error('invalid_input', 400)
    const action = collection ? 'propose' : 'approve',
      targetId = collection ? null : item![1]!
    const parsed = (
      collection ? inventoryCountImportProposalInputSchema : inventoryCountImportApprovalInputSchema
    ).safeParse(raw)
    if (!parsed.success) return error('invalid_input', 400)
    const current = await authorize()
    if (!current.allowed) return domainError(current.code)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'admin-inventory',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    const expectedHash = await inventoryCountImportIntentHash(action, targetId, parsed.data)
    const receipt = inventoryCountImportReceiptSchema.parse(
      await deps.coordinate({
        type: 'inventory_count_import',
        claims,
        action,
        targetId,
        input: parsed.data,
        idempotencyKey: key!
      })
    )
    if (
      receipt.commandId !== key ||
      receipt.payloadHash !== expectedHash ||
      receipt.action !== action ||
      (targetId !== null && receipt.importId !== targetId)
    )
      return error('service_unavailable')
    // The core/coordinator release is the final live atomic authority. Never
    // await another DB read after its approved snapshot/receipt.
    return json(receipt, 201)
  } catch (cause) {
    if (cause instanceof BoundaryError) return error(cause.code, cause.status)
    if (cause instanceof InventoryCountImportError) return domainError(cause.code)
    return error('service_unavailable')
  }
}
