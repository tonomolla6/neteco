import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { authorizeD1Session } from './authorization'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  inventoryAlertsQuerySchema,
  inventoryAlertsResponseSchema,
  inventoryAlertPolicyResponseSchema,
  inventoryAlertCommandReceiptSchema,
  inventoryAlertCommandResponseSchema,
  parseInventoryAlertInput,
  inventoryAlertIntentHash,
  type InventoryAlertAction
} from '../../shared/inventory-alerts'
import {
  InventoryAlertsError,
  readD1InventoryAlerts,
  readD1InventoryAlertPolicy,
  executeD1InventoryAlertCommand,
  readD1InventoryAlertCommand
} from './inventory-alerts'

export interface InventoryAlertsHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  edgeLimiter: RateLimit
  rateLimitPepper: string
  now?: () => string
}

// Own only this subnamespace, including encoded/malformed aliases. Other legacy
// inventory routes must remain available to the existing inventory handler.
export function ownsInventoryAlertsNamespace(path: string) {
  let value = path
  for (let depth = 0; depth < 5; depth++) {
    if (
      /^\/api\/admin\/inventory\/alerts(?:[/\\%]|$)/.test(value) ||
      /^\/api\/admin\/inventory\/variants\/[^/]+\/alert-policy(?:[/\\%]|$)/.test(value)
    )
      return true
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
function status(code: string) {
  return code === 'unauthenticated'
    ? 401
    : ['email_unverified', 'mfa_required', 'forbidden'].includes(code)
      ? 403
      : code === 'not_found'
        ? 404
        : code === 'invalid_input'
          ? 400
          : code === 'unavailable'
            ? 503
            : 409
}

export async function handleInventoryAlertsHttp(
  request: Request,
  deps: InventoryAlertsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsInventoryAlertsNamespace(url.pathname)) return null
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
  const error = (code: string, codeStatus = status(code), extra?: Record<string, string>) =>
    json({ error: { code } }, codeStatus, extra)
  const policy = /^\/api\/admin\/inventory\/variants\/([1-9][0-9]*)\/alert-policy$/.exec(url.pathname)
  const ack = /^\/api\/admin\/inventory\/alerts\/([^/]+)\/ack$/.exec(url.pathname)
  const command = /^\/api\/admin\/inventory\/alerts\/commands\/([^/]+)$/.exec(url.pathname)
  const list = url.pathname === '/api/admin/inventory/alerts'
  const evaluate = url.pathname === '/api/admin/inventory/alerts/evaluate'
  if (!list && !evaluate && !policy && !ack && !command) return error('invalid_input')
  const methods = policy ? ['GET', 'PUT'] : ack || evaluate ? ['POST'] : ['GET']
  if (!methods.includes(request.method)) return error('method_not_allowed', 405, { Allow: methods.join(', ') })
  try {
    const configured = new URL(deps.origin)
    if (configured.protocol !== 'https:' || configured.origin !== deps.origin || deps.origin.length > 2000)
      return error('unavailable')
    const write = request.method !== 'GET'
    if (
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (write && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error('csrf_rejected', 403)
    const keys = [...url.searchParams.keys()]
    if (
      (!list && keys.length) ||
      keys.some(
        (key) =>
          !['state', 'kind', 'q', 'page', 'perPage', 'alertId'].includes(key) ||
          url.searchParams.getAll(key).length !== 1
      )
    )
      return error('invalid_input')
    if (
      (policy && (!Number.isSafeInteger(Number(policy[1])) || Number(policy[1]) < 1)) ||
      (ack && !catalogPolicyUuidSchema.safeParse(ack[1]).success) ||
      (command && !catalogPolicyUuidSchema.safeParse(command[1]).success)
    )
      return error('invalid_input')
    const query: Record<string, unknown> = {}
    for (const [key, value] of url.searchParams)
      query[key] = ['page', 'perPage'].includes(key) ? (/^[1-9][0-9]*$/.test(value) ? Number(value) : NaN) : value
    const parsedQuery = inventoryAlertsQuerySchema.safeParse(query)
    if (list && !parsedQuery.success) return error('invalid_input')
    const payloadHash = request.headers.get('x-neteco-command-payload-hash')
    if (command && (!payloadHash || !/^[0-9a-f]{64}$/.test(payloadHash))) return error('invalid_input')
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'admin-inventory')
    if (edge !== 'allowed')
      return error(edge === 'limited' ? 'rate_limited' : 'unavailable', edge === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated')
    const permission = write || command ? 'inventory.write' : 'inventory.read'
    const authorize = () =>
      authorizeD1Session(deps.database, claims, permission, {
        requireMfa: true,
        ...(deps.now ? { now: deps.now() } : {})
      })
    const initial = await authorize()
    if (!initial.allowed) return error(initial.code)
    const options = { now: deps.now }
    let result: unknown
    if (list)
      result = inventoryAlertsResponseSchema.parse(
        await readD1InventoryAlerts(deps.database, claims, parsedQuery.data, options)
      )
    else if (command) {
      const receipt = inventoryAlertCommandResponseSchema.parse(
        await readD1InventoryAlertCommand(deps.database, claims, command[1]!, payloadHash!, options)
      )
      if (
        receipt.outcome === 'applied' &&
        (receipt.receipt.commandId !== command[1] || receipt.receipt.payloadHash !== payloadHash)
      )
        return error('unavailable')
      result = receipt
    } else if (policy && !write) {
      const read = inventoryAlertPolicyResponseSchema.parse(
        await readD1InventoryAlertPolicy(deps.database, claims, Number(policy[1]), options)
      )
      if (read.variantId !== Number(policy[1])) return error('unavailable')
      result = read
    } else {
      const key = request.headers.get('idempotency-key')
      if (
        !catalogPolicyUuidSchema.safeParse(key).success ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
      )
        return error('invalid_input')
      const length = request.headers.get('content-length')
      if (length && (!/^\d+$/.test(length) || Number(length) > 8192)) return error('invalid_input', 413)
      const reader = request.body?.getReader()
      if (!reader) return error('invalid_input')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 8192) {
            await reader.cancel()
            return error('invalid_input', 413)
          }
          chunks.push(next.value)
        }
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      const action: InventoryAlertAction = policy ? 'threshold' : ack ? 'ack' : 'evaluate'
      const targetId = policy ? policy[1]! : ack ? ack[1]! : 'warehouse'
      let input: ReturnType<typeof parseInventoryAlertInput>
      try {
        input = parseInventoryAlertInput(action, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      } catch {
        return error('invalid_input')
      }
      const current = await authorize()
      if (!current.allowed) return error(current.code)
      // Reuse the existing inventory actor quota (60 writes/hour). Edge limits
      // are mandatory for reads and writes; neither read nor recovery uses D1 quota.
      const quota = await consumeIdentityQuota(deps.database, {
        identityId: claims.identityId,
        scope: 'admin-inventory',
        limit: 60,
        windowSeconds: 3600,
        ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
      })
      if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
      const expectedHash = await inventoryAlertIntentHash(action, targetId, input)
      const receipt = inventoryAlertCommandReceiptSchema.parse(
        await executeD1InventoryAlertCommand(deps.database, claims, action, targetId, input, key!, options)
      )
      if (
        receipt.commandId !== key ||
        receipt.action !== action ||
        receipt.targetId !== targetId ||
        receipt.payloadHash !== expectedHash ||
        (action !== 'evaluate' && receipt.version !== ('expectedVersion' in input ? input.expectedVersion + 1 : -1))
      )
        return error('unavailable')
      result = receipt
    }
    const final = await authorize()
    if (!final.allowed) return error(final.code)
    return json(result)
  } catch (cause) {
    if (cause instanceof InventoryAlertsError) return error(cause.code)
    return error('unavailable')
  }
}
