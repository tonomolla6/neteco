import type { AccountPreferencesHttpDependencies } from '../auth/account-preferences-http'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { verifySessionCookie } from '../auth/session-cookie'
import { authorizeD1AccountPreferences, AccountPreferencesError } from '../auth/account-preferences'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { consumeIdentityQuota } from '../auth/identity-quota'
import { credentials, setCartCookie } from '../catalog/storefront-cart'
import { catalogPolicyUuidSchema as uuid } from '../../shared/catalog-publication-policy'
import {
  cartRecoveryPreferenceInputSchema,
  cartRecoveryAssociationInputSchema,
  cartRecoveryResolveInputSchema,
  cartRecoveryResumeInputSchema,
  cartRecoveryReceiptSchema,
  cartRecoveryIntentHash,
  type CartRecoveryResumeInput
} from '../../shared/cart-recovery'
import {
  CartRecoveryError,
  readD1CartRecoveryPreferences,
  updateD1CartRecoveryPreferences,
  associateD1CartRecovery,
  readD1CartRecoveryCommand,
  resolveD1CartRecovery,
  readD1CartRecoveryResumeGrant,
  type ResumeRecoveryResult
} from './cart-recovery'
export interface CartRecoveryHttpDependencies extends AccountPreferencesHttpDependencies {
  hmacKey: Uint8Array
  /** Mandatory for resume: real CartDO serializes the private grant, never caches it. */
  resumeGateway?: (
    claims: VerifiedSessionClaims,
    input: CartRecoveryResumeInput,
    idempotencyKey: string
  ) => Promise<ResumeRecoveryResult>
}
export function ownsCartRecoveryNamespace(path: string): boolean {
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/account\/cart-recovery(?:[/\\%]|$)/i.test(path)) return true
    try {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    } catch {
      return false
    }
  }
  return false
}
export async function handleCartRecoveryRequest(
  request: Request,
  deps: CartRecoveryHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsCartRecoveryNamespace(url.pathname)) return null
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
  const error = (code: string, status: number, extra: Record<string, string> = {}) =>
    json({ error: { code } }, status, extra)
  const match = /^\/api\/account\/cart-recovery\/(preferences|associations|resolve|resume|commands\/([^/]+))$/.exec(
    url.pathname
  )
  if (!match || url.searchParams.size) return error('invalid_input', 400)
  const route = match[1],
    commandId = match[2],
    methods = commandId ? 'GET' : route === 'preferences' ? 'GET, PUT' : 'POST'
  if (!methods.split(', ').includes(request.method)) return error('method_not_allowed', 405, { Allow: methods })
  if (commandId && !uuid.safeParse(commandId).success) return error('invalid_input', 400)
  try {
    const configured = new URL(deps.origin)
    if (
      configured.protocol !== 'https:' ||
      configured.origin !== deps.origin ||
      !(deps.hmacKey instanceof Uint8Array) ||
      deps.hmacKey.length < 32 ||
      deps.hmacKey.length > 128
    )
      return error('service_unavailable', 503)
    if (
      url.origin !== deps.origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== deps.origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.method !== 'GET' && request.headers.get('origin') !== deps.origin)
    )
      return error('csrf_rejected', 403)
    const edge = await checkAdministrativeEdgeLimit(request, deps.edgeLimiter, deps.rateLimitPepper, 'authentication')
    if (edge !== 'allowed')
      return error(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
    const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
    if (!claims) return error('unauthenticated', 401)
    const options = { ...(deps.now ? { now: deps.now } : {}), hmacKey: deps.hmacKey }
    if (commandId) {
      const hash = request.headers.get('X-Neteco-Command-Payload-Hash') ?? ''
      if (!/^[a-f0-9]{64}$/.test(hash)) return error('invalid_input', 400)
      const result = await readD1CartRecoveryCommand(deps.database, claims, commandId, hash, options)
      if (result.outcome === 'applied' && result.receipt.action === 'resume') {
        const cart = await readD1CartRecoveryResumeGrant(deps.database, claims, commandId, hash, options)
        if (!cart) return error('not_found', 404)
        return json(result, 200, {
          'Set-Cookie': setCartCookie(cart, deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
        })
      }
      return json(result)
    }
    if (request.method === 'GET') return json(await readD1CartRecoveryPreferences(deps.database, claims, options))
    await authorizeD1AccountPreferences(deps.database, claims, options)
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
      return error('invalid_input', 400)
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return error('invalid_input', 413)
    const reader = request.body?.getReader()
    if (!reader) return error('invalid_input', 400)
    const bytes = new Uint8Array(2048)
    let length = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        if (part.value.length > 2048 - length) {
          await reader.cancel().catch(() => undefined)
          return error('invalid_input', 413)
        }
        bytes.set(part.value, length)
        length += part.value.length
      }
    } finally {
      reader.releaseLock()
    }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    } catch {
      return error('invalid_input', 400)
    }
    const schema =
      route === 'preferences'
        ? cartRecoveryPreferenceInputSchema
        : route === 'associations'
          ? cartRecoveryAssociationInputSchema
          : route === 'resume'
            ? cartRecoveryResumeInputSchema
            : cartRecoveryResolveInputSchema
    const input = schema.safeParse(raw)
    if (!input.success) return error('invalid_input', 400)
    if (route === 'resolve') return json(await resolveD1CartRecovery(deps.database, claims, input.data, options))
    const key = request.headers.get('Idempotency-Key')
    if (!uuid.safeParse(key).success) return error('invalid_input', 400)
    const cart = route === 'associations' ? credentials(request) : null
    if (route === 'associations' && (!cart || request.headers.get('X-Neteco-Cart-Id') !== cart.cartId))
      return error('unauthenticated', 401)
    if (route === 'resume' && !deps.resumeGateway) return error('service_unavailable', 503)
    const quota = await consumeIdentityQuota(deps.database, {
      identityId: claims.identityId,
      scope: 'account-preferences',
      limit: 60,
      windowSeconds: 3600,
      ...(deps.now ? { now: Math.floor(Date.parse(deps.now()) / 1000) } : {})
    })
    if (!quota.allowed) return error('rate_limited', 429, { 'Retry-After': String(quota.retryAfter) })
    if (route === 'resume') {
      const resumeInput = cartRecoveryResumeInputSchema.parse(input.data),
        expectedHash = await cartRecoveryIntentHash('resume', resumeInput)
      const resumed = await deps.resumeGateway!(claims, resumeInput, key!)
      const receipt = cartRecoveryReceiptSchema.parse(resumed.receipt)
      if (
        receipt.action !== 'resume' ||
        receipt.commandId !== key ||
        receipt.payloadHash !== expectedHash ||
        receipt.associationId !== resumeInput.id ||
        receipt.cartVersion !== resumeInput.expectedCartVersion + 1
      )
        throw new Error('unconfirmed_recovery_receipt')
      return json(receipt, 201, {
        'Set-Cookie': setCartCookie(resumed.cart, deps.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
      })
    }
    return json(
      route === 'preferences'
        ? await updateD1CartRecoveryPreferences(deps.database, claims, input.data, key!, options)
        : await associateD1CartRecovery(deps.database, claims, cart!, input.data, key!, options),
      201
    )
  } catch (cause) {
    if (cause instanceof CartRecoveryError || cause instanceof AccountPreferencesError) {
      const code = cause.code,
        status =
          code === 'unauthenticated'
            ? 401
            : code === 'email_unverified' || code === 'mfa_required'
              ? 403
              : code === 'invalid_input'
                ? 400
                : code === 'not_found'
                  ? 404
                  : ['conflict', 'version_conflict', 'consent_required', 'cart_unavailable'].includes(code)
                    ? 409
                    : 503
      return error(status === 503 ? 'service_unavailable' : code, status)
    }
    return error('service_unavailable', 503)
  }
}
