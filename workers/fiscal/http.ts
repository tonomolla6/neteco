import { z } from 'zod'
import {
  fiscalUuid,
  fiscalPolicyInputSchema,
  fiscalReconcileInputSchema,
  fiscalReason,
  type FiscalPolicy,
  type OrdinaryFiscalProvider,
  type PrivateFiscalStorage
} from '../../shared/fiscal-issuance'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { authorizeD1Session } from '../catalog/authorization'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import {
  approveFiscalPolicy,
  withdrawFiscalPolicy,
  queueFiscalInvoice,
  reconcileFiscalInvoice,
  readFiscalPolicy,
  FiscalIssuanceError,
  fiscalClock
} from './issuance'
import { fiscalGuestCookie, readD1FiscalOrder, readPrivateFiscalPdf, type FiscalOrderAccess } from './access'
import { guardedFiscalDatabase } from './d1-boundary'

export interface FiscalHttpDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  appEnvironment: 'local' | 'preview' | 'production'
  storage?: PrivateFiscalStorage
  providerResolver?: (policy: FiscalPolicy) => OrdinaryFiscalProvider | null | Promise<OrdinaryFiscalProvider | null>
  now?: () => string
}
const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...privateHeaders, ...extra } })
}
const error = (code: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { code } }, status, extra)
/** Claim aliases to keep disabled/unknown resources from falling into legacy
 * backends. Only the canonical, unencoded exact route is ever executed. */
export function ownsFiscalNamespace(pathname: string): boolean {
  let path = pathname
  for (let index = 0; index < 5; index++) {
    if (
      /^\/api\/admin\/fiscal(?:[/\\%]|$)/.test(path) ||
      /^\/api\/(?:admin\/)?orders\/[^/\\]+\/(?:fiscal|invoice)(?:[/\\%]|$)/.test(path)
    )
      return true
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
const keySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const queueSchema = z
  .object({
    eventId: z.string().regex(/^invoice-evaluation:[0-9a-f-]{36}$/),
    policyId: fiscalUuid,
    idempotencyKey: keySchema
  })
  .strict()
const withdrawSchema = z.object({ reason: fiscalReason, idempotencyKey: keySchema }).strict()
type Route =
  | { kind: 'admin_read' | 'customer_read' | 'pdf'; orderId: string }
  | { kind: 'approve' | 'queue' }
  | { kind: 'withdraw'; policyId: string }
  | { kind: 'reconcile'; intentId: string }
function route(path: string): Route | null {
  if (path === '/api/admin/fiscal/policies') return { kind: 'approve' }
  if (path === '/api/admin/fiscal/requests') return { kind: 'queue' }
  let match = /^\/api\/admin\/fiscal\/policies\/([^/]+)\/withdraw$/.exec(path)
  if (match && fiscalUuid.safeParse(match[1]).success) return { kind: 'withdraw', policyId: match[1]! }
  match = /^\/api\/admin\/fiscal\/intents\/([^/]+)\/reconcile$/.exec(path)
  if (match && fiscalUuid.safeParse(match[1]).success) return { kind: 'reconcile', intentId: match[1]! }
  match = /^\/api\/(admin\/)?orders\/([^/]+)\/(fiscal|invoice)$/.exec(path)
  if (!match || !fiscalUuid.safeParse(match[2]).success || (match[1] && match[3] === 'invoice')) return null
  return { kind: match[1] ? 'admin_read' : match[3] === 'invoice' ? 'pdf' : 'customer_read', orderId: match[2]! }
}
class FiscalHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code)
  }
}
async function body(request: Request): Promise<unknown> {
  const limit = 16384,
    declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new FiscalHttpError('body_too_large', 413)
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    throw new FiscalHttpError('json_required', 415)
  if (!request.body) throw new FiscalHttpError('missing_body', 400)
  const reader = request.body.getReader(),
    bytes = new Uint8Array(limit)
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.length > limit - length) {
        await reader.cancel().catch(() => {})
        throw new FiscalHttpError('body_too_large', 413)
      }
      bytes.set(part.value, length)
      length += part.value.length
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return catalogPolicyOwnJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
  } catch {
    throw new FiscalHttpError('invalid_json', 400)
  }
}
function statusFor(code: string): number {
  if (code === 'unauthenticated') return 401
  if (['forbidden', 'email_unverified', 'mfa_required'].includes(code)) return 403
  if (code === 'not_found') return 404
  if (code === 'invalid_input' || code === 'invalid_instant') return 422
  if (
    [
      'intent_conflict',
      'version_conflict',
      'idempotency_conflict',
      'blocked_policy',
      'order_not_facturable',
      'shipping_snapshot_ambiguous',
      'shipping_snapshot_invalid',
      'tax_mapping_missing',
      'snapshot_exceeds_provider_limits',
      'provider_configuration_mismatch'
    ].includes(code)
  )
    return 409
  return 503
}
export async function handleD1FiscalRequest(request: Request, deps: FiscalHttpDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsFiscalNamespace(url.pathname)) return null
  const target = route(url.pathname)
  if (!target) return error('not_found', 404)
  const method = ['admin_read', 'customer_read', 'pdf'].includes(target.kind) ? 'GET' : 'POST'
  if (request.method !== method) return error('method_not_allowed', 405, { Allow: method })
  if (url.search !== '') return error('invalid_input', 400)
  try {
    deps = { ...deps, database: guardedFiscalDatabase(deps.database) }
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin || deps.origin.length > 2000)
      throw new FiscalHttpError('service_unavailable', 503)
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const now = fiscalClock(deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (target.kind === 'customer_read' || target.kind === 'pdf') {
      const access: FiscalOrderAccess | null = claims ? { kind: 'customer', claims } : fiscalGuestCookie(request)
      if (!access) return error('unauthenticated', 401)
      if (target.kind === 'customer_read')
        return json(
          await readD1FiscalOrder(deps.database, access, target.orderId, {
            now: now(),
            appEnvironment: deps.appEnvironment
          })
        )
      if (!deps.storage) return error('service_unavailable', 503)
      const bytes = await readPrivateFiscalPdf(deps.database, access, target.orderId, deps.storage, {
        now: now(),
        appEnvironment: deps.appEnvironment
      })
      const owned = new Uint8Array(bytes.byteLength)
      owned.set(bytes)
      return new Response(owned.buffer, {
        headers: {
          ...privateHeaders,
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="factura.pdf"',
          'Content-Length': String(bytes.byteLength)
        }
      })
    }
    if (!claims) return error('unauthenticated', 401)
    const authority = await authorizeD1Session(deps.database, claims, 'administration.manage', {
      now: now(),
      requireMfa: true
    })
    if (!authority.allowed) return error(authority.code, statusFor(authority.code))
    if (target.kind === 'admin_read')
      return json(
        await readD1FiscalOrder(deps.database, { kind: 'admin', claims }, target.orderId, {
          now: now(),
          appEnvironment: deps.appEnvironment
        })
      )
    const raw = await body(request)
    if (target.kind === 'approve')
      return json(
        {
          policy: await approveFiscalPolicy(deps.database, claims, fiscalPolicyInputSchema.parse(raw), { now: now() })
        },
        201
      )
    if (target.kind === 'queue')
      return json(await queueFiscalInvoice(deps.database, claims, { ...queueSchema.parse(raw), now: now() }), 202)
    if (target.kind === 'withdraw') {
      const input = withdrawSchema.parse(raw)
      await withdrawFiscalPolicy(deps.database, claims, target.policyId, input.reason, {
        now: now(),
        idempotencyKey: input.idempotencyKey
      })
      return json({ withdrawn: true })
    }
    if (target.kind !== 'reconcile') return error('not_found', 404)
    const input = fiscalReconcileInputSchema.parse(raw)
    const intent = await deps.database
      .prepare('SELECT policy_id FROM fiscal_invoice_intents WHERE id=?1')
      .bind(target.intentId)
      .first<{ policy_id: string }>()
    if (intent === null) return error('not_found', 404)
    if (!intent || !fiscalUuid.safeParse(intent.policy_id).success) throw new FiscalIssuanceError('read_unconfirmed')
    const policy = await readFiscalPolicy(deps.database, intent.policy_id, false)
    if (!policy || !deps.providerResolver || !deps.storage) return error('service_unavailable', 503)
    if (policy.provider === 'local_fake' && deps.appEnvironment !== 'local')
      return error('provider_configuration_mismatch', 409)
    const provider = await deps.providerResolver(policy)
    if (!provider) return error('service_unavailable', 503)
    return json(
      await reconcileFiscalInvoice(deps.database, claims, target.intentId, input, provider, deps.storage, {
        now: now(),
        appEnvironment: deps.appEnvironment
      })
    )
  } catch (caught) {
    if (caught instanceof FiscalHttpError) return error(caught.code, caught.status)
    if (caught instanceof FiscalIssuanceError) return error(caught.code, statusFor(caught.code))
    if (caught instanceof z.ZodError) return error('invalid_input', 422)
    return error('service_unavailable', 503)
  }
}
