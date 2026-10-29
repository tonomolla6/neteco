import {
  adminSatisfactionQuerySchema,
  adminSatisfactionResponseSchema,
  customerSatisfactionSchema,
  satisfactionCommandResponseSchema,
  satisfactionInputSchema,
  satisfactionIntentHash,
  satisfactionReceiptSchema,
  satisfactionTargetSchema
} from '../../shared/support-satisfaction'
import { supportUuid } from '../../shared/support-operations'
import { verifySessionCookie } from '../auth/session-cookie'
import { GUEST_ORDER_COOKIE } from '../catalog/guest-order-access'
import {
  SatisfactionError,
  readAdminSatisfaction,
  readCustomerSatisfaction,
  readCustomerSatisfactionCommand,
  submitCustomerSatisfaction
} from './satisfaction'
import {
  ownsSupportNamespace,
  supportBody,
  supportBoundary,
  supportFailure,
  supportHttpActor,
  supportHttpError,
  supportJson,
  supportMutationQuota,
  type SupportHttpDependencies
} from './http'

const customerPrefix = '/api/account/satisfaction'
const adminPrefix = '/api/admin/support/satisfaction'
export function ownsCustomerSatisfactionNamespace(path: string) {
  return ownsSupportNamespace(path, customerPrefix)
}

function query(url: URL) {
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) return null
    result[key] = value
  }
  return result
}

function failure(error: unknown) {
  if (!(error instanceof SatisfactionError)) return supportFailure(error)
  const code = error.code
  const status =
    code === 'unauthenticated'
      ? 401
      : ['forbidden', 'email_unverified', 'email_not_verified', 'mfa_required'].includes(code)
        ? 403
        : code === 'not_found'
          ? 404
          : code === 'invalid_input'
            ? 422
            : [
                  'idempotency_conflict',
                  'source_version_conflict',
                  'policy_version_conflict',
                  'source_not_final',
                  'retention_expired',
                  'already_submitted'
                ].includes(code)
              ? 409
              : 503
  return supportHttpError(code, status)
}

/** Private CSAT only. A sealed guest order-view cookie is never a session. */
export async function handleSatisfactionHttp(
  request: Request,
  deps: SupportHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  const customer = ownsCustomerSatisfactionNamespace(url.pathname)
  const admin = ownsSupportNamespace(url.pathname, adminPrefix)
  if (!customer && !admin) return null
  try {
    const match = /^\/api\/account\/satisfaction\/(support|delivery)\/([^/]+)(?:\/commands\/([^/]+))?$/.exec(
      url.pathname
    )
    if (admin ? url.pathname !== adminPrefix : !match) return supportHttpError('invalid_input', 400)
    const recovery = !!match?.[3]
    const allow = admin || recovery ? 'GET' : 'GET, POST'
    if (!allow.split(', ').includes(request.method))
      return supportJson({ error: { code: 'method_not_allowed' } }, 405, { Allow: allow })
    const boundary = await supportBoundary(request, deps, admin ? 'admin' : 'customer')
    if (boundary) return boundary
    const parameters = query(url)
    if (!parameters) return supportHttpError('invalid_input', 400)
    if (admin) {
      if (!adminSatisfactionQuerySchema.safeParse(parameters).success) return supportHttpError('invalid_input', 400)
      const actor = await supportHttpActor(request, deps, 'admin')
      const response = await readAdminSatisfaction(deps.database, actor.claims!, parameters)
      const parsed = adminSatisfactionResponseSchema.safeParse(response)
      return parsed.success ? supportJson(parsed.data) : supportHttpError('service_unavailable', 503)
    }
    if (Object.keys(parameters).length) return supportHttpError('invalid_input', 400)
    const kind = match![1] as 'support' | 'delivery'
    const id = match![2]!
    if (!satisfactionTargetSchema.safeParse({ kind, id, version: 0 }).success)
      return supportHttpError('invalid_input', 400)
    if (!deps.sessionCookieConfiguration) return supportHttpError('service_unavailable', 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims)
      return supportHttpError(
        (request.headers.get('cookie') ?? '')
          .split(';')
          .some((part) => part.trim().startsWith(GUEST_ORDER_COOKIE + '='))
          ? 'guest_verification_required'
          : 'unauthenticated'
      )
    const options = { policy: deps.policy }
    if (recovery) {
      const key = match![3]!
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!supportUuid.safeParse(key).success || !/^[a-f0-9]{64}$/.test(hash))
        return supportHttpError('invalid_input', 422)
      const response = await readCustomerSatisfactionCommand(deps.database, claims, kind, id, key, hash, options)
      const parsed = satisfactionCommandResponseSchema.safeParse(response)
      if (!parsed.success) return supportHttpError('service_unavailable', 503)
      if (parsed.data.outcome === 'applied') {
        const receipt = parsed.data.receipt
        if (
          receipt.commandId !== key ||
          receipt.payloadHash !== hash ||
          receipt.target.kind !== kind ||
          receipt.target.id !== id
        )
          return supportHttpError('service_unavailable', 503)
      }
      return supportJson(parsed.data)
    }
    if (request.method === 'GET') {
      const response = await readCustomerSatisfaction(deps.database, claims, kind, id, options)
      const parsed = customerSatisfactionSchema.safeParse(response)
      return parsed.success && parsed.data.target.kind === kind && parsed.data.target.id === id
        ? supportJson(parsed.data)
        : supportHttpError('service_unavailable', 503)
    }
    const key = request.headers.get('Idempotency-Key') ?? ''
    if (!supportUuid.safeParse(key).success) return supportHttpError('invalid_input', 422)
    // Reuse the current live-customer check and existing 20/hour support quota.
    const actor = await supportHttpActor(request, deps, 'customer')
    const quota = await supportMutationQuota(deps, actor, 'customer')
    if (quota) return quota
    const input = satisfactionInputSchema.safeParse(await supportBody(request))
    if (!input.success) return supportHttpError('invalid_input', 422)
    const hash = await satisfactionIntentHash(kind, id, input.data)
    const response = await submitCustomerSatisfaction(deps.database, claims, kind, id, input.data, {
      ...options,
      idempotencyKey: key
    })
    const parsed = satisfactionReceiptSchema.safeParse(response)
    if (!parsed.success) return supportHttpError('service_unavailable', 503)
    const receipt = parsed.data
    return receipt.commandId === key &&
      receipt.payloadHash === hash &&
      receipt.target.kind === kind &&
      receipt.target.id === id &&
      receipt.target.version === input.data.expectedSourceVersion &&
      receipt.score === input.data.score
      ? supportJson(receipt, 201)
      : supportHttpError('service_unavailable', 503)
  } catch (error) {
    return failure(error)
  }
}
