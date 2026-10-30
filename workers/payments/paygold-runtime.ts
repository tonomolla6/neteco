import type { PaymentRuntimeConfiguration } from '../catalog/payments'
import { initiateRedsysPayment } from '../catalog/payments'
import { getOrderView } from '../catalog/checkout'
import { readD1CustomerSalesQuote } from '../catalog/sales-quotes'
import { issuePayGoldLink, recoverPayGoldAttempt, PayGoldError, type PayGoldDependencies } from './paygold-links'
import { createBoundPayGoldProvider } from './paygold-provider'
import { issueDraftPayGoldLink } from './paygold-draft-links'
export interface PayGoldRuntime {
  DB: D1Database
  PAYGOLD_ENABLED?: unknown
  PAYGOLD_PROVIDER_ORIGIN?: unknown
  PAYGOLD_SERVICE?: { fetch(request: Request): Promise<Response> }
}
/** All values are trusted runtime bindings; no bank capability comes from HTTP. */
function payGoldDependencies(
  env: PayGoldRuntime,
  configuration: PaymentRuntimeConfiguration | null,
  now: () => string
): PayGoldDependencies | null {
  if (
    env.PAYGOLD_ENABLED !== 'true' ||
    !configuration ||
    typeof env.PAYGOLD_PROVIDER_ORIGIN !== 'string' ||
    !env.PAYGOLD_SERVICE ||
    typeof env.PAYGOLD_SERVICE.fetch !== 'function'
  )
    return null
  const origin = env.PAYGOLD_PROVIDER_ORIGIN
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null
  } catch {
    return null
  }
  const provider = createBoundPayGoldProvider(env.PAYGOLD_SERVICE)
  const dependencies: PayGoldDependencies = {
    database: env.DB,
    provider,
    providerOrigin: origin,
    now,
    readQuote: (claims, id) => readD1CustomerSalesQuote(env.DB, claims, id, { now: now() }),
    verify: async (input) =>
      Boolean(await getOrderView(env.DB, { orderId: input.orderId, token: input.orderToken, now: input.now })),
    async start(input) {
      const result = await initiateRedsysPayment(
        env.DB,
        { ...input, method: 'card', correlationId: `paygold:${input.idempotencyKey}` },
        configuration
      )
      if (result.status !== 201 || typeof result.body.paymentIntentId !== 'string' || !result.body.redirect)
        throw new PayGoldError('unavailable')
      return {
        paymentIntentId: result.body.paymentIntentId,
        redirect: result.body.redirect as Awaited<ReturnType<PayGoldDependencies['start']>>['redirect']
      }
    }
  }
  return dependencies
}
export function configuredPayGoldIssue(
  env: PayGoldRuntime,
  configuration: PaymentRuntimeConfiguration | null,
  now: () => string
) {
  const dependencies = payGoldDependencies(env, configuration, now)
  if (!dependencies) return null
  return Object.assign(
    (claims: Parameters<typeof issuePayGoldLink>[0], input: Parameters<typeof issuePayGoldLink>[1]) =>
      issuePayGoldLink(claims, input, dependencies),
    {
      recover: (
        claims: Parameters<typeof recoverPayGoldAttempt>[0],
        input: Parameters<typeof recoverPayGoldAttempt>[1]
      ) => recoverPayGoldAttempt(claims, input, dependencies)
    }
  )
}

/** PAY-020: the same trusted bindings and checkout path, bound to a converted draft order instead of a quote. */
export function configuredPayGoldDraftIssue(
  env: PayGoldRuntime,
  configuration: PaymentRuntimeConfiguration | null,
  now: () => string
) {
  const dependencies = payGoldDependencies(env, configuration, now)
  if (!dependencies) return null
  return (claims: Parameters<typeof issueDraftPayGoldLink>[0], input: Parameters<typeof issueDraftPayGoldLink>[1]) =>
    issueDraftPayGoldLink(claims, input, dependencies)
}
