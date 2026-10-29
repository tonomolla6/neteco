import { z } from 'zod'
import { fiscalUuid } from '../../shared/fiscal-issuance'
import type { CreditPolicy, CreditFiscalProvider } from '../../shared/fiscal-credit'
import type { RefundPolicy, GovernedRefundProvider } from '../../shared/order-refunds'
import { supportPolicySchema } from '../../shared/support-operations'
import { PersistentLocalRefundProvider } from '../refunds/local-provider'
import { PersistentLocalCreditProvider } from '../fiscal/local-credit-provider'
import { fiscalMappingFingerprint } from '../fiscal/issuance'
import { hash as financialHash } from '../refunds/authority'
import { WorkerRedsysRefundProvider } from '../refunds/redsys-provider'
import {
  CREDIT_EMAIL_RENDERER_V1,
  REFUND_EMAIL_RENDERER_V1,
  creditIssuedEmailRenderer,
  refundSucceededEmailRenderer
} from '../communications/refund-credit-email'
import { supportEmailRenderers } from '../support/email'
import { orderOperationsEmailRenderers } from '../communications/order-operations-email'
import { orderReturnEmailRenderers } from '../communications/order-return-email'
import { orderPaymentEmailRenderers } from '../communications/order-payment-email'
import type { NewsletterEditorialHttpDependencies } from '../marketing/newsletter-editorial-core'
import type { NewsletterSecrets } from '../marketing/newsletter'
import { PersistentLocalNewsletterSender } from '../marketing/local-newsletter-sender'
import {
  createNewsletterEmailServiceAdapter,
  editorialMailbox,
  type NewsletterEditorialSender
} from '../marketing/newsletter-campaign-transport'
import { configuredBeplyProvider, operationFlag, operationsEnvironment } from './operations-config'

/** Optional secrets are injected as secrets, never copied to public vars. */
export type CustomerOperationsEnv = CloudflareEnv & {
  CART_RECOVERY_ENABLED?: unknown
  CART_RECOVERY_DELIVERY_ENABLED?: unknown
  CART_RECOVERY_POLICY?: unknown
  CART_RECOVERY_ALLOWED_RECIPIENTS?: unknown
  SALES_QUOTES_ENABLED?: unknown
  CUSTOMER_360_ENABLED?: unknown
  PRODUCT_WATCH_ENABLED?: unknown
  PRODUCT_WATCH_DELIVERY_ENABLED?: unknown
  PRODUCT_WATCH_ALLOWED_RECIPIENTS?: unknown
  PRODUCT_CONTRIBUTIONS_ENABLED?: unknown
  REFUNDS_ENABLED?: unknown
  REFUND_DISPATCH_ENABLED?: unknown
  REFUND_LOCAL_VALIDATION_ENABLED?: unknown
  REFUND_POLICY_IDS?: unknown
  CREDIT_DISPATCH_ENABLED?: unknown
  CREDIT_LOCAL_VALIDATION_ENABLED?: unknown
  CREDIT_POLICY_IDS?: unknown
  SUPPORT_ENABLED?: unknown
  SUPPORT_POLICY?: unknown
  SUPPORT_ATTACHMENTS_ENABLED?: unknown
  SUPPORT_SCAN_SECRET?: unknown
  SUPPORT_TURNSTILE_ENABLED?: unknown
  SUPPORT_TURNSTILE_SITE_KEY?: unknown
  SUPPORT_TURNSTILE_SECRET?: unknown
  NEWSLETTER_EDITORIAL_ENABLED?: unknown
  NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED?: unknown
  NEWSLETTER_LOCAL_VALIDATION_ENABLED?: unknown
  NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS?: unknown
  NEWSLETTER_FEEDBACK_ENABLED?: unknown
  NEWSLETTER_FEEDBACK_SECRET?: unknown
  TRANSACTIONAL_EMAIL_RENDERER_KEYS?: unknown
  TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED?: unknown
}
const invalid = () => new Error('operations_configuration_invalid')
function parseJson(value: unknown, fallback: unknown) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 4096) throw invalid()
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw invalid()
  }
}
function policyIds(value: unknown): string[] {
  const result = z.array(fiscalUuid).max(10).safeParse(parseJson(value, []))
  if (!result.success || new Set(result.data).size !== result.data.length) throw invalid()
  return result.data
}
export function financialRuntimeConfiguration(env: CustomerOperationsEnv) {
  return {
    appEnvironment: operationsEnvironment(env.APP_ENV),
    enabled: operationFlag(env.REFUNDS_ENABLED),
    refunds: {
      enabled: operationFlag(env.REFUND_DISPATCH_ENABLED),
      localValidationEnabled: operationFlag(env.REFUND_LOCAL_VALIDATION_ENABLED),
      policyIds: policyIds(env.REFUND_POLICY_IDS)
    },
    credits: {
      enabled: operationFlag(env.CREDIT_DISPATCH_ENABLED),
      localValidationEnabled: operationFlag(env.CREDIT_LOCAL_VALIDATION_ENABLED),
      policyIds: policyIds(env.CREDIT_POLICY_IDS)
    }
  }
}
export async function configuredRefundProvider(
  env: CustomerOperationsEnv,
  policy: RefundPolicy,
  fetcher: typeof fetch
): Promise<GovernedRefundProvider | null> {
  const environment = operationsEnvironment(env.APP_ENV)
  if (
    policy.provider === 'local_fake' &&
    policy.environment === 'local_validation' &&
    environment === 'local' &&
    operationFlag(env.REFUND_LOCAL_VALIDATION_ENABLED)
  )
    return new PersistentLocalRefundProvider(env.DB, await financialHash(policy.mappings))
  if (
    policy.provider !== 'redsys' ||
    environment === 'local' ||
    !operationFlag(env.REDSYS_ENABLED) ||
    policy.environment !== (environment === 'preview' ? 'sandbox' : 'production') ||
    env.REDSYS_ENVIRONMENT !== policy.environment ||
    typeof env.REDSYS_SECRET_KEY !== 'string' ||
    env.REDSYS_SECRET_KEY.startsWith('local-only-') ||
    (environment === 'production' && env.REDSYS_MERCHANT_CODE === '999008881')
  )
    return null
  try {
    return await WorkerRedsysRefundProvider.create(
      {
        appEnvironment: environment,
        environment: policy.environment,
        merchantCode: env.REDSYS_MERCHANT_CODE,
        terminal: env.REDSYS_TERMINAL,
        secretKey: env.REDSYS_SECRET_KEY,
        currency: '978'
      },
      policy,
      fetcher
    )
  } catch {
    return null
  }
}
export async function configuredCreditProvider(
  env: CustomerOperationsEnv,
  policy: CreditPolicy,
  fetcher: typeof fetch
): Promise<CreditFiscalProvider | null> {
  const environment = operationsEnvironment(env.APP_ENV)
  if (policy.provider === 'local_fake')
    return environment === 'local' &&
      policy.environment === 'local_validation' &&
      operationFlag(env.CREDIT_LOCAL_VALIDATION_ENABLED)
      ? new PersistentLocalCreditProvider(env.DB, await fiscalMappingFingerprint(policy.mappings))
      : null
  // The existing Beply port refuses corrective issuance before I/O until the
  // primary response contract proves kind, original document and signed total.
  return configuredBeplyProvider(env, policy, 'corrective', fetcher)
}
export function configuredSupportPolicy(env: CustomerOperationsEnv) {
  const value = parseJson(env.SUPPORT_POLICY, null)
  if (value === null) return null
  const result = supportPolicySchema.safeParse(value)
  if (!result.success) throw invalid()
  return result.data
}

export const customerEmailRenderers = Object.freeze([
  refundSucceededEmailRenderer,
  creditIssuedEmailRenderer,
  ...supportEmailRenderers,
  ...orderOperationsEmailRenderers,
  ...orderReturnEmailRenderers,
  ...orderPaymentEmailRenderers
])
export function customerEmailConfiguration(env: CustomerOperationsEnv) {
  const keys = z
    .array(
      z.enum([
        REFUND_EMAIL_RENDERER_V1,
        CREDIT_EMAIL_RENDERER_V1,
        'support.ticket.received.v1',
        'support.ticket.reply.v1',
        'order.operations.fulfillment.v1',
        'order.operations.cancelled.v1',
        'order.return.requested.v1',
        'order.return.status.v1',
        'order.payment.confirmed.v1'
      ])
    )
    .max(9)
    .safeParse(parseJson(env.TRANSACTIONAL_EMAIL_RENDERER_KEYS, []))
  if (!keys.success || new Set(keys.data).size !== keys.data.length) throw invalid()
  return {
    rendererOptIns: keys.data,
    rendererValidationEnabled: operationFlag(env.TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED)
  }
}

export function configuredNewsletterEditorial(
  env: CustomerOperationsEnv,
  secrets?: NewsletterSecrets,
  localSenderFactory?: () => NewsletterEditorialSender | undefined
): NewsletterEditorialHttpDependencies {
  const environment = operationsEnvironment(env.APP_ENV),
    enabled = operationFlag(env.NEWSLETTER_EDITORIAL_ENABLED),
    delivery =
      operationFlag(env.NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED) && configuredNewsletterConsentMaintenance(env) !== null
  const localValidation = environment === 'local' && operationFlag(env.NEWSLETTER_LOCAL_VALIDATION_ENABLED)
  const allowed = z
    .array(z.string().max(254))
    .max(100)
    .safeParse(parseJson(env.NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS, []))
  if (
    !allowed.success ||
    allowed.data.some((email) => !editorialMailbox(email)) ||
    new Set(allowed.data).size !== allowed.data.length
  )
    throw invalid()
  const feedbackEnabled = operationFlag(env.NEWSLETTER_FEEDBACK_ENABLED)
  const realBinding = enabled && delivery && environment !== 'local' ? env.NEWSLETTER_EMAIL : undefined
  let feedback: NewsletterEditorialHttpDependencies['feedback']
  if (enabled && feedbackEnabled) {
    if (typeof env.NEWSLETTER_FEEDBACK_SECRET !== 'string') throw invalid()
    const bytes = new TextEncoder().encode(env.NEWSLETTER_FEEDBACK_SECRET)
    if (bytes.length < 32 || bytes.length > 128 || env.NEWSLETTER_FEEDBACK_SECRET.startsWith('local-only-'))
      throw invalid()
    feedback = { secret: bytes, provider: environment === 'local' ? 'local-fake' : 'cloudflare-email' }
  }
  return {
    database: env.DB,
    enabled,
    publicOrigin: env.NEWSLETTER_PUBLIC_ORIGIN,
    newsletterSecrets: secrets ?? configuredEditorialSecrets(env.NEWSLETTER_HMAC_KEY),
    session: env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : undefined,
    edgeLimiter: env.CART_EDGE_LIMIT,
    rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
    feedback,
    transport: {
      mode: enabled && delivery ? (environment === 'local' ? 'local-fake' : 'cloudflare-email') : 'disabled',
      environment: environment === 'preview' ? 'preprod' : environment,
      externalEnabled: enabled && delivery && environment !== 'local',
      from: env.NEWSLETTER_EMAIL_FROM,
      allowedRecipients: allowed.data,
      // No binding lookup/construction while OFF and no real binding in local.
      senderFactory:
        enabled && delivery
          ? environment === 'local'
            ? (localSenderFactory ?? (localValidation ? () => new PersistentLocalNewsletterSender(env.DB) : undefined))
            : typeof realBinding?.send === 'function'
              ? () => createNewsletterEmailServiceAdapter(realBinding)
              : undefined
          : undefined
    }
  }
}

/** Existing marketing signing key, never a token or email-derived fallback. */
export function configuredEditorialSecrets(raw: unknown): NewsletterSecrets | undefined {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw) || /^A{43}$/.test(raw)) return undefined
  try {
    const bytes = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/') + '='), (value) =>
      value.charCodeAt(0)
    )
    return bytes.length === 32 && bytes.some((byte) => byte !== 0) ? { hmacKey: bytes } : undefined
  } catch {
    return undefined
  }
}

/** Stopping acquisition/delivery must not disable an existing signed opt-out.
 * This port needs only the existing marketing key, origin and D1, not a sender. */
export function configuredNewsletterConsentMaintenance(env: CustomerOperationsEnv) {
  const secrets = configuredEditorialSecrets(env.NEWSLETTER_HMAC_KEY)
  if (!secrets || typeof env.NEWSLETTER_PUBLIC_ORIGIN !== 'string') return null
  try {
    const origin = new URL(env.NEWSLETTER_PUBLIC_ORIGIN)
    return origin.protocol === 'https:' && origin.origin === env.NEWSLETTER_PUBLIC_ORIGIN
      ? { secrets, publicOrigin: origin.origin }
      : null
  } catch {
    return null
  }
}
