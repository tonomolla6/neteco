import { initiateRedsysPayment, PaymentError, type PaymentRuntimeConfiguration } from '../catalog/payments'
import { decodeMerchantParameters, encodeMerchantParameters, signMerchantParameters } from './redsys'
import { resolveWalletPayment, type WalletResolution } from './wallet-capabilities'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const METHODS = ['apple_pay', 'google_pay'] as const
type WalletMethod = (typeof METHODS)[number]
const APPLE_FILE = '/.well-known/apple-developer-merchantid-domain-association'

export interface WalletHttpDependencies {
  database: D1Database
  configuration: () => PaymentRuntimeConfiguration | null
  /** Trusted bank/domain/terminal approval evidence; never taken from a request. */
  evidence: () => unknown[]
  appleDomainAssociation: () => string | null
  now: () => string
}

/** Evidence is configuration: it comes from the Worker environment, never the client. */
export function walletEvidenceFromEnv(env: { WALLET_PAYMENTS_ENABLED?: unknown; WALLET_EVIDENCE_JSON?: unknown }) {
  if (env.WALLET_PAYMENTS_ENABLED !== 'true' || typeof env.WALLET_EVIDENCE_JSON !== 'string') return []
  if (env.WALLET_EVIDENCE_JSON.length > 4096) return []
  try {
    const parsed: unknown = JSON.parse(env.WALLET_EVIDENCE_JSON)
    return Array.isArray(parsed) && parsed.length <= 4 ? parsed : []
  } catch {
    return []
  }
}

export function walletAppleAssociationFromEnv(env: {
  WALLET_PAYMENTS_ENABLED?: unknown
  APPLE_PAY_DOMAIN_ASSOCIATION?: unknown
}) {
  const value = env.APPLE_PAY_DOMAIN_ASSOCIATION
  return env.WALLET_PAYMENTS_ENABLED === 'true' && typeof value === 'string' && value.length > 0 && value.length <= 8192
    ? value
    : null
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
  })
}

function resolveFor(
  deps: WalletHttpDependencies,
  configuration: PaymentRuntimeConfiguration,
  method: WalletMethod,
  deviceAvailable: boolean
): WalletResolution {
  let origin: string
  try {
    origin = new URL(configuration.publicBaseUrl).origin
  } catch {
    return { method: 'redirect' }
  }
  const candidates = deps.evidence().filter((item) => (item as { method?: unknown } | null)?.method === method)
  // Several entries for one method are ambiguous approvals: fail closed.
  if (candidates.length !== 1) return { method: 'redirect' }
  return resolveWalletPayment({
    method,
    evidence: candidates[0],
    deviceAvailable,
    origin,
    terminal: configuration.terminal.padStart(3, '0'),
    environment: configuration.environment,
    now: deps.now()
  })
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new PaymentError('invalid_input', 'type')
  const declared = Number(request.headers.get('content-length'))
  if (declared > 2048) throw new PaymentError('invalid_input', 'size')
  const text = await request.text()
  if (text.length > 2048) throw new PaymentError('invalid_input', 'size')
  try {
    return JSON.parse(text)
  } catch {
    throw new PaymentError('invalid_input', 'json')
  }
}

/** Returns null for unrelated routes. */
export async function handleWalletHttp(request: Request, deps: WalletHttpDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const start = path.match(/^\/api\/orders\/([^/]+)\/wallet-payment-intents$/)
  const isCapabilities = path === '/api/payments/wallet-capabilities'
  const isApple = path === APPLE_FILE
  if (!start && !isCapabilities && !isApple) return null
  if (isCapabilities || isApple) {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return json({ error: { code: 'method_not_allowed' } }, 405, { allow: 'GET, HEAD' })
    if (isApple) {
      const proof = deps.appleDomainAssociation()
      if (!proof) return json({ error: { code: 'not_found' } }, 404)
      return new Response(request.method === 'HEAD' ? null : proof, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' }
      })
    }
    const configuration = deps.configuration()
    const wallets = { apple_pay: false, google_pay: false }
    if (configuration)
      for (const method of METHODS) wallets[method] = resolveFor(deps, configuration, method, true).method === method
    return json({ wallets, fallback: 'redirect' }, 200)
  }
  if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed' } }, 405, { allow: 'POST' })
  try {
    const orderToken = request.headers.get('authorization')?.match(/^Order ([A-Za-z0-9_-]{43,86})$/)?.[1]
    if (!UUID.test(start![1]!) || !orderToken) return json({ error: { code: 'unauthorized' } }, 401)
    const configuration = deps.configuration()
    if (!configuration) return json({ error: { code: 'payments_unavailable' } }, 503)
    const body = await readJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PaymentError('invalid_input', 'body')
    const { method, deviceAvailable, ...rest } = body as Record<string, unknown>
    if (Object.keys(rest).length || !METHODS.includes(method as WalletMethod) || typeof deviceAvailable !== 'boolean')
      throw new PaymentError('invalid_input', 'body')
    const resolution = resolveFor(deps, configuration, method as WalletMethod, deviceAvailable)
    const now = deps.now()
    // The amount, ownership and idempotency all come from the ordinary checkout path.
    const result = await initiateRedsysPayment(
      deps.database,
      {
        orderId: start![1]!,
        orderToken,
        method: 'card',
        now,
        correlationId: crypto.randomUUID(),
        idempotencyKey: request.headers.get('idempotency-key') ?? ''
      },
      configuration
    )
    const responseBody = { ...result.body } as Record<string, unknown>
    const redirect = responseBody.redirect as { fields: Record<string, string> } | undefined
    if (resolution.method !== 'redirect' && resolution.payMethod && redirect) {
      const parameters = decodeMerchantParameters(redirect.fields.Ds_MerchantParameters!)
      parameters.DS_MERCHANT_PAYMETHODS = resolution.payMethod
      const encoded = encodeMerchantParameters(parameters)
      responseBody.redirect = {
        ...redirect,
        fields: {
          ...redirect.fields,
          Ds_MerchantParameters: encoded,
          Ds_Signature: await signMerchantParameters(encoded, configuration.secretKey, parameters.DS_MERCHANT_ORDER)
        }
      }
    }
    if (typeof responseBody.paymentIntentId === 'string')
      await deps.database
        .prepare(
          `INSERT OR IGNORE INTO payment_wallet_selections(payment_intent_id,order_id,requested_method,resolved_method,created_at)
           SELECT id,order_id,?2,?3,?4 FROM payment_intents WHERE id=?1`
        )
        .bind(responseBody.paymentIntentId, method, resolution.method, now)
        .run()
    responseBody.wallet = { requested: method, resolved: resolution.method, fallback: 'redirect' }
    return json(responseBody, result.status)
  } catch (error) {
    if (error instanceof PaymentError && error.code !== 'infrastructure') {
      const status = error.code === 'unauthorized' ? 401 : error.code === 'invalid_input' ? 400 : 409
      return json({ error: { code: error.code } }, status)
    }
    return json({ error: { code: 'internal' } }, 500)
  }
}
