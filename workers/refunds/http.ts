import { z } from 'zod'
import { fiscalUuid, fiscalReason, type PrivateFiscalStorage } from '../../shared/fiscal-issuance'
import {
  refundPolicyInputSchema,
  refundPlanInputSchema,
  refundConfirmInputSchema,
  refundReconcileInputSchema,
  refundKey,
  type RefundPolicy,
  type GovernedRefundProvider
} from '../../shared/order-refunds'
import {
  creditPolicyInputSchema,
  creditQueueInputSchema,
  type CreditPolicy,
  type CreditFiscalProvider
} from '../../shared/fiscal-credit'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'
import { fiscalGuestCookie, type FiscalOrderAccess } from '../fiscal/access'
import { readReturnsBody, ReturnsHttpError } from '../returns/admin-http'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { approveRefundPolicy, approveCreditPolicy, withdrawFinancialPolicy, readFinancialPolicy } from './policies'
import { planD1Refund, confirmD1Refund, cancelD1Refund, reconcileD1Refund, readRefundContract } from './operations'
import { queueD1CreditNote, reconcileD1CreditNote, readCreditContract } from '../fiscal/credit-notes'
import { readD1OrderRefunds, readD1CreditNote, readPrivateCreditPdf } from './access'
import { clock, admin, RefundError } from './authority'

export interface RefundsHttpDependencies {
  database: D1Database
  origin: string
  appEnvironment: 'local' | 'preview' | 'production'
  sessionCookieConfiguration: SessionCookieConfiguration
  storage?: PrivateFiscalStorage
  refundProviderResolver?: (
    policy: RefundPolicy
  ) => GovernedRefundProvider | null | Promise<GovernedRefundProvider | null>
  creditProviderResolver?: (policy: CreditPolicy) => CreditFiscalProvider | null | Promise<CreditFiscalProvider | null>
  /** Only trusted tests override the live SQL authority clock. */
  now?: () => string
}
const headers = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer'
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers })
function error(code: string, status: number) {
  return json({ error: { code } }, status)
}
export function ownsRefundsNamespace(pathname: string) {
  let path = pathname
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      /^\/api\/admin\/(?:refunds|credits)(?:[/\\%]|$)/.test(path) ||
      /^\/api\/(?:admin\/)?orders\/[^/\\]+\/(?:refunds|credits)(?:[/\\%]|$)/.test(path)
    )
      return true
    try {
      const next = decodeURIComponent(path)
      if (next === path) return false
      path = next
    } catch {
      return false
    }
  }
  return false
}
type Route =
  | { kind: 'approve_refund' | 'approve_credit' | 'plan' }
  | { kind: 'withdraw'; id: string }
  | { kind: 'confirm' | 'cancel' | 'reconcile_refund' | 'queue_credit' | 'reconcile_credit'; id: string }
  | { kind: 'read'; orderId: string; admin: boolean }
  | { kind: 'credit' | 'pdf'; orderId: string; id: string; admin: boolean }
function route(path: string): Route | null {
  if (path === '/api/admin/refunds/policies') return { kind: 'approve_refund' }
  if (path === '/api/admin/credits/policies') return { kind: 'approve_credit' }
  if (path === '/api/admin/refunds/requests') return { kind: 'plan' }
  let found = /^\/api\/admin\/(?:refunds|credits)\/policies\/([^/]+)\/withdraw$/.exec(path)
  if (found && fiscalUuid.safeParse(found[1]).success) return { kind: 'withdraw', id: found[1]! }
  found = /^\/api\/admin\/refunds\/([^/]+)\/(confirm|cancel|reconcile|credit)$/.exec(path)
  if (found && fiscalUuid.safeParse(found[1]).success)
    return {
      kind:
        found[2] === 'reconcile'
          ? 'reconcile_refund'
          : found[2] === 'credit'
            ? 'queue_credit'
            : found[2] === 'confirm'
              ? 'confirm'
              : 'cancel',
      id: found[1]!
    }
  found = /^\/api\/admin\/credits\/([^/]+)\/reconcile$/.exec(path)
  if (found && fiscalUuid.safeParse(found[1]).success) return { kind: 'reconcile_credit', id: found[1]! }
  found = /^\/api\/(admin\/)?orders\/([^/]+)\/refunds$/.exec(path)
  if (found && fiscalUuid.safeParse(found[2]).success) return { kind: 'read', orderId: found[2]!, admin: !!found[1] }
  found = /^\/api\/(admin\/)?orders\/([^/]+)\/credits\/([^/]+)(\/pdf)?$/.exec(path)
  if (found && fiscalUuid.safeParse(found[2]).success && fiscalUuid.safeParse(found[3]).success)
    return { kind: found[4] ? 'pdf' : 'credit', orderId: found[2]!, id: found[3]!, admin: !!found[1] }
  return null
}
function status(code: string) {
  return code === 'unauthenticated'
    ? 401
    : ['forbidden', 'mfa_required', 'email_unverified'].includes(code)
      ? 403
      : code === 'not_found'
        ? 404
        : code === 'invalid_input'
          ? 422
          : ['read_unconfirmed', 'document_unconfirmed', 'reconciliation_unavailable'].includes(code)
            ? 503
            : 409
}
export async function handleD1RefundsRequest(
  request: Request,
  deps: RefundsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsRefundsNamespace(url.pathname)) return null
  const target = route(url.pathname)
  if (!target) return error('not_found', 404)
  const method = ['read', 'credit', 'pdf'].includes(target.kind) ? 'GET' : 'POST'
  if (request.method !== method) return new Response(null, { status: 405, headers: { ...headers, Allow: method } })
  if (url.search) return error('invalid_input', 400)
  try {
    z.enum(['local', 'preview', 'production']).parse(deps.appEnvironment)
    const origin = new URL(deps.origin)
    if (origin.protocol !== 'https:' || origin.origin !== deps.origin) return error('service_unavailable', 503)
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      (method === 'POST' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const database = guardedFiscalDatabase(deps.database),
      options = deps.now ? { now: deps.now() } : {},
      now = clock(options),
      claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if ('admin' in target) {
      const access: FiscalOrderAccess | null = target.admin
        ? claims
          ? { kind: 'admin', claims }
          : null
        : claims
          ? { kind: 'customer', claims }
          : fiscalGuestCookie(request)
      if (!access) return error('unauthenticated', 401)
      if (target.kind === 'read')
        return json(
          await readD1OrderRefunds(database, access, target.orderId, {
            ...options,
            appEnvironment: deps.appEnvironment
          })
        )
      if (target.kind === 'credit')
        return json(
          await readD1CreditNote(database, access, target.orderId, target.id, {
            ...options,
            appEnvironment: deps.appEnvironment
          })
        )
      if (target.kind === 'pdf') {
        if (!deps.storage) return error('service_unavailable', 503)
        const bytes = await readPrivateCreditPdf(database, access, target.orderId, target.id, deps.storage, {
            ...options,
            appEnvironment: deps.appEnvironment
          }),
          owned = new Uint8Array(bytes.byteLength)
        owned.set(bytes)
        return new Response(owned.buffer, {
          headers: {
            ...headers,
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="rectificativa.pdf"',
            'Content-Length': String(bytes.byteLength)
          }
        })
      }
    }
    if (!claims) return error('unauthenticated', 401)
    await admin(database, claims, now) // Must happen BEFORE consuming the body.
    const body = await readReturnsBody(request)
    if (target.kind === 'approve_refund')
      return json(
        { policy: await approveRefundPolicy(database, claims, refundPolicyInputSchema.parse(body), options) },
        201
      )
    if (target.kind === 'approve_credit')
      return json(
        { policy: await approveCreditPolicy(database, claims, creditPolicyInputSchema.parse(body), options) },
        201
      )
    if (target.kind === 'plan')
      return json(await planD1Refund(database, claims, refundPlanInputSchema.parse(body), options), 202)
    if (target.kind === 'withdraw') {
      const input = z.object({ reason: fiscalReason, idempotencyKey: refundKey }).strict().parse(body)
      return json(
        await withdrawFinancialPolicy(database, claims, target.id, input.reason, input.idempotencyKey, options)
      )
    }
    if (target.kind === 'confirm')
      return json(await confirmD1Refund(database, claims, target.id, refundConfirmInputSchema.parse(body), options))
    if (target.kind === 'cancel')
      return json(await cancelD1Refund(database, claims, target.id, refundReconcileInputSchema.parse(body), options))
    if (target.kind === 'queue_credit')
      return json(
        await queueD1CreditNote(database, claims, target.id, creditQueueInputSchema.parse(body), options),
        202
      )
    if (target.kind === 'reconcile_refund') {
      const input = refundReconcileInputSchema.parse(body),
        { contract } = await readRefundContract(database, target.id),
        policy = await readFinancialPolicy(database, contract.policyId, 'refund', false)
      if (!policy) return error('service_unavailable', 503)
      if (
        policy.environment !==
        (deps.appEnvironment === 'local'
          ? 'local_validation'
          : deps.appEnvironment === 'production'
            ? 'production'
            : 'sandbox')
      )
        return error('provider_configuration_unconfirmed', 409)
      const provider = (await deps.refundProviderResolver?.(policy)) ?? undefined
      return json(await reconcileD1Refund(database, claims, target.id, input, provider, options))
    }
    if (target.kind === 'reconcile_credit') {
      const input = refundReconcileInputSchema.parse(body),
        { contract } = await readCreditContract(database, target.id),
        policy = await readFinancialPolicy(database, contract.policyId, 'credit', false)
      if (!policy) return error('service_unavailable', 503)
      if (
        policy.environment !==
        (deps.appEnvironment === 'local'
          ? 'local_validation'
          : deps.appEnvironment === 'production'
            ? 'production'
            : 'sandbox')
      )
        return error('provider_configuration_unconfirmed', 409)
      const provider = (await deps.creditProviderResolver?.(policy)) ?? undefined
      return json(await reconcileD1CreditNote(database, claims, target.id, input, provider, deps.storage, options))
    }
    return error('not_found', 404)
  } catch (caught) {
    if (caught instanceof RefundError) return error(caught.code, status(caught.code))
    if (caught instanceof ReturnsHttpError) return error(caught.code, caught.status)
    if (caught instanceof z.ZodError) return error('invalid_input', 422)
    if (
      caught instanceof Error &&
      'code' in caught &&
      typeof caught.code === 'string' &&
      ['unauthenticated', 'forbidden', 'mfa_required', 'email_unverified', 'not_found'].includes(caught.code)
    )
      return error(caught.code, status(caught.code))
    return error('service_unavailable', 503)
  }
}
