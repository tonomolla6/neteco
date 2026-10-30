import { handleD1RefundsRequest, ownsRefundsNamespace } from '../refunds/http'
import { handleCommunicationHistoryHttp, ownsCommunicationHistoryNamespace } from '../communications/history-http'
import { handleAdminSupportHttp, ownsAdminSupportNamespace } from '../support/admin-http'
import { handleSupportEscalationsHttp, ownsSupportEscalationsNamespace } from '../support/escalations-http'
import { handleCustomerSupportHttp, ownsCustomerSupportNamespace } from '../support/customer-http'
import { handleSatisfactionHttp, ownsCustomerSatisfactionNamespace } from '../support/satisfaction-http'
import { handleSupportContactHttp, ownsSupportContactNamespace } from '../support/contact-http'
import { handleSupportKnowledgeHttp } from '../support/knowledge-http'
import {
  handleB2bRequestsHttp,
  handleSupportAssistantHttp,
  ownsB2bRequestsNamespace,
  ownsSupportAssistantNamespace
} from '../support/insights-http'
import { ownsSupportNamespace } from '../support/http'
import { handleNewsletterEditorialHttp, ownsNewsletterEditorialNamespace } from '../marketing/newsletter-editorial-http'
import { handleProductWatchRequest, ownsProductWatchNamespace } from '../marketing/product-watch-http'
import { handleCartRecoveryRequest, ownsCartRecoveryNamespace } from '../marketing/cart-recovery-http'
import { handleSalesQuotesHttp, ownsSalesQuotesNamespace } from '../catalog/sales-quotes-http'
import { cartDoName, createCheckoutInventoryGateway } from '../cart-coordinator'
import { CartRecoveryError, readD1CartRecoveryResumeAuthority } from '../marketing/cart-recovery'
import { cartRecoveryReceiptSchema } from '../../shared/cart-recovery'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { z } from 'zod'
import { handleCustomer360Http, ownsCustomer360Namespace } from '../support/customer-360-http'
import { shippingCommercialPolicy } from '../../server/utils/shipping-policy'
import { productWatchHmacKey } from './product-watch'
import {
  handleProductContributionsHttp,
  ownsProductContributionsNamespace
} from '../support/product-contributions-http'
import { checkAdministrativeEdgeLimit } from '../auth/edge-limit'
import { cmsRuntimeDependencies, operationFlag, operationsEnvironment } from './operations-config'
import { createFiscalPdfStorage } from './fiscal-pdf-storage'
import { createSupportChallengeVerifier, createSupportScanVerifier } from './support-adapters'
import { supportChallengeConfigurationSchema } from '../../shared/support-operations'
import {
  configuredRefundProvider,
  configuredCreditProvider,
  configuredSupportPolicy,
  configuredNewsletterEditorial,
  type CustomerOperationsEnv
} from './customer-operations-config'

function unavailable(code = 'service_unavailable', status = 503) {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        Vary: 'Cookie, Authorization',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer'
      }
    }
  )
}

/** Claim every owned namespace even while disabled/misconfigured. Neither an
 * encoded alias nor a legacy Nitro endpoint may bypass the new authorities. */
export async function handleCustomerOperationsHttp(
  request: Request,
  env: CustomerOperationsEnv
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    knowledge = ownsSupportNamespace(path, '/api/support/knowledge'),
    supportAssistant = ownsSupportAssistantNamespace(path),
    b2bRequests = ownsB2bRequestsNamespace(path),
    refunds = ownsRefundsNamespace(path),
    supportAdmin = ownsAdminSupportNamespace(path),
    supportEscalations = ownsSupportEscalationsNamespace(path),
    supportCustomer = ownsCustomerSupportNamespace(path),
    satisfaction = ownsCustomerSatisfactionNamespace(path),
    supportContact = ownsSupportContactNamespace(path),
    newsletter = ownsNewsletterEditorialNamespace(path),
    salesQuotes = ownsSalesQuotesNamespace(path),
    customer360 = ownsCustomer360Namespace(path),
    productWatch = ownsProductWatchNamespace(path),
    cartRecovery = ownsCartRecoveryNamespace(path),
    productContributions = ownsProductContributionsNamespace(path),
    communicationHistory = ownsCommunicationHistoryNamespace(path)
  if (
    !knowledge &&
    !supportAssistant &&
    !b2bRequests &&
    !refunds &&
    !supportAdmin &&
    !supportEscalations &&
    !supportCustomer &&
    !satisfaction &&
    !supportContact &&
    !newsletter &&
    !salesQuotes &&
    !customer360 &&
    !productWatch &&
    !cartRecovery &&
    !productContributions &&
    !communicationHistory
  )
    return null
  try {
    if (cartRecovery) {
      if (!operationFlag(env.CART_RECOVERY_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      const hmacKey = productWatchHmacKey(env)
      return (
        (await handleCartRecoveryRequest(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          edgeLimiter: env.CART_EDGE_LIMIT,
          // The recovery core domain-separates the existing private marketing key.
          hmacKey,
          resumeGateway: async (claims, input, commandId) => {
            if (!env.CARTS) throw new CartRecoveryError('service_unavailable')
            const authority = await readD1CartRecoveryResumeAuthority(env.DB, claims, input, { hmacKey })
            const response = await env.CARTS.get(env.CARTS.idFromName(cartDoName(authority.cartId))).fetch(
              'https://cart.internal/command',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'cart-recovery-resume',
                  commandId,
                  cartId: authority.cartId,
                  payload: { claims, input }
                })
              }
            )
            const value: unknown = await response.json()
            if (!response.ok) {
              const failure = z
                .object({
                  error: z
                    .object({
                      code: z.enum([
                        'invalid_input',
                        'unauthenticated',
                        'email_unverified',
                        'mfa_required',
                        'not_found',
                        'conflict',
                        'version_conflict',
                        'consent_required',
                        'cart_unavailable'
                      ])
                    })
                    .strict()
                })
                .strict()
                .safeParse(value)
              throw new CartRecoveryError(failure.success ? failure.data.error.code : 'service_unavailable')
            }
            const result = z
              .object({
                receipt: cartRecoveryReceiptSchema,
                cart: z
                  .object({
                    cartId: catalogPolicyUuidSchema,
                    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
                    expiresAt: catalogPolicyInstantSchema
                  })
                  .strict()
              })
              .strict()
              .parse(value)
            if (result.cart.cartId !== authority.cartId) throw new CartRecoveryError('service_unavailable')
            return result
          }
        })) ?? unavailable('not_found', 404)
      )
    }
    if (salesQuotes) {
      if (!operationFlag(env.SALES_QUOTES_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      const administrative = ownsSupportNamespace(path, '/api/admin/sales-quotes')
      return (
        (await handleSalesQuotesHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          inventory: createCheckoutInventoryGateway(env.INVENTORY),
          get freeShippingThresholdCents() {
            return shippingCommercialPolicy({
              APP_ENV: env.APP_ENV,
              FREE_SHIPPING_THRESHOLD_CENTS: env.FREE_SHIPPING_THRESHOLD_CENTS
            } as NodeJS.ProcessEnv).freeShippingThresholdCents
          },
          edgeGate: async (incoming) => {
            const gate = await checkAdministrativeEdgeLimit(
              incoming,
              administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              administrative ? 'admin-sales-quotes' : 'customer-sales-quotes'
            )
            return gate === 'limited' ? 'denied' : gate
          }
        })) ?? unavailable('not_found', 404)
      )
    }
    if (customer360) {
      if (!operationFlag(env.CUSTOMER_360_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleCustomer360Http(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          edgeGate: (incoming) =>
            checkAdministrativeEdgeLimit(
              incoming,
              env.ADMIN_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              'admin-customer-context'
            )
        })) ?? unavailable('not_found', 404)
      )
    }
    if (productWatch) {
      if (!operationFlag(env.PRODUCT_WATCH_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleProductWatchRequest(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          edgeLimiter: env.CART_EDGE_LIMIT,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          hmacKey: productWatchHmacKey(env)
        })) ?? unavailable('not_found', 404)
      )
    }
    if (productContributions) {
      if (!operationFlag(env.PRODUCT_CONTRIBUTIONS_ENABLED)) return unavailable()
      const publicRead = /^\/api\/products\/[1-9]\d*\/contributions$/.test(path)
      if (!publicRead && env.AUTH_ENABLED !== 'true') return unavailable()
      const administrative = ownsSupportNamespace(path, '/api/admin/product-contributions')
      return (
        (await handleProductContributionsHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration:
            env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          edgeGate: (incoming) =>
            checkAdministrativeEdgeLimit(
              incoming,
              administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              administrative ? 'admin-product-contributions' : 'product-contributions'
            )
        })) ?? unavailable('not_found', 404)
      )
    }
    if (communicationHistory) {
      if (env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleCommunicationHistoryHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          edgeGate: async (incoming) => {
            const gate = await checkAdministrativeEdgeLimit(
              incoming,
              env.ADMIN_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              'admin-communication-history'
            )
            return gate === 'limited' ? 'denied' : gate
          }
        })) ?? unavailable('not_found', 404)
      )
    }
    // SUP-012: limited FAQ assistant. Answers only from approved CMS knowledge; same gates as the help centre.
    if (supportAssistant) {
      const cms = cmsRuntimeDependencies(env)
      return (
        (await handleSupportAssistantHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          enabled: cms.enabled,
          sessionCookieConfiguration:
            env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null,
          edgeGate: (incoming) =>
            checkAdministrativeEdgeLimit(incoming, env.CART_EDGE_LIMIT, env.AUTH_RATE_LIMIT_PEPPER, 'support-contact')
        })) ?? unavailable('not_found', 404)
      )
    }
    // SUP-017: B2B requests portal for approved companies (quote, onboarding, documentation, credit, claim).
    if (b2bRequests) {
      if (!operationFlag(env.SUPPORT_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleB2bRequestsHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          edgeGate: (incoming) =>
            checkAdministrativeEdgeLimit(incoming, env.CART_EDGE_LIMIT, env.AUTH_RATE_LIMIT_PEPPER, 'customer-support')
        })) ?? unavailable('not_found', 404)
      )
    }
    // More specific than contact's /api/support namespace; knowledge requires
    // CMS publication, not private ticket configuration or authentication.
    if (knowledge) {
      const cms = cmsRuntimeDependencies(env)
      return (
        (await handleSupportKnowledgeHttp(request, {
          ...cms,
          origin: env.AUTH_ORIGIN,
          feedbackEnabled:
            cms.enabled &&
            !!env.CART_EDGE_LIMIT &&
            typeof env.AUTH_RATE_LIMIT_PEPPER === 'string' &&
            env.AUTH_RATE_LIMIT_PEPPER.length >= 32 &&
            !env.AUTH_RATE_LIMIT_PEPPER.startsWith('local-only-'),
          edgeGate: (incoming) =>
            checkAdministrativeEdgeLimit(incoming, env.CART_EDGE_LIMIT, env.AUTH_RATE_LIMIT_PEPPER, 'support-contact')
        })) ?? unavailable('not_found', 404)
      )
    }
    if (refunds) {
      if (!operationFlag(env.REFUNDS_ENABLED) || env.AUTH_ENABLED !== 'true') return unavailable()
      const administrative = path.startsWith('/api/admin/')
      const edge = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-refunds' : 'customer-refunds'
      )
      if (edge !== 'allowed')
        return unavailable(edge === 'limited' ? 'rate_limited' : 'service_unavailable', edge === 'limited' ? 429 : 503)
      return (
        (await handleD1RefundsRequest(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          appEnvironment: operationsEnvironment(env.APP_ENV),
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          storage: createFiscalPdfStorage(env.MEDIA),
          refundProviderResolver: (policy) => configuredRefundProvider(env, policy, fetch),
          creditProviderResolver: (policy) => configuredCreditProvider(env, policy, fetch)
        })) ?? unavailable('not_found', 404)
      )
    }
    if (supportAdmin || supportEscalations || supportCustomer || satisfaction || supportContact) {
      if (
        !operationFlag(env.SUPPORT_ENABLED) ||
        ((supportAdmin || supportEscalations || supportCustomer || satisfaction) && env.AUTH_ENABLED !== 'true')
      )
        return unavailable()
      const attachments = operationFlag(env.SUPPORT_ATTACHMENTS_ENABLED)
      const challengeInput = supportChallengeConfigurationSchema.safeParse({
        provider: 'turnstile',
        siteKey: env.SUPPORT_TURNSTILE_SITE_KEY,
        action: 'neteco_support'
      })
      const challengeVerifier =
        operationFlag(env.SUPPORT_TURNSTILE_ENABLED) &&
        operationsEnvironment(env.APP_ENV) !== 'local' &&
        challengeInput.success
          ? createSupportChallengeVerifier(env.SUPPORT_TURNSTILE_SECRET, env.AUTH_ORIGIN, fetch)
          : undefined
      const deps = {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration:
          env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null,
        policy: configuredSupportPolicy(env),
        contactPepper: env.AUTH_RATE_LIMIT_PEPPER,
        storage: attachments ? env.MEDIA : undefined,
        scanReceiptVerifier: attachments ? createSupportScanVerifier(env.SUPPORT_SCAN_SECRET) : undefined,
        challengeVerifier,
        challengeConfiguration: challengeVerifier && challengeInput.success ? challengeInput.data : undefined,
        edgeGate: (incoming: Request, area: 'contact' | 'admin' | 'customer' | 'scanner') =>
          checkAdministrativeEdgeLimit(
            incoming,
            area === 'admin' || area === 'scanner' ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
            env.AUTH_RATE_LIMIT_PEPPER,
            area === 'admin'
              ? 'admin-support'
              : area === 'customer'
                ? 'customer-support'
                : area === 'scanner'
                  ? 'support-scanner'
                  : 'support-contact'
          )
      }
      if (supportEscalations)
        return (await handleSupportEscalationsHttp(request, deps)) ?? unavailable('not_found', 404)
      const satisfactionResponse = await handleSatisfactionHttp(request, deps)
      if (satisfactionResponse) return satisfactionResponse
      const response = supportAdmin
        ? await handleAdminSupportHttp(request, deps)
        : supportCustomer
          ? await handleCustomerSupportHttp(request, deps)
          : await handleSupportContactHttp(request, deps)
      return response ?? unavailable('not_found', 404)
    }
    const deps = configuredNewsletterEditorial(env)
    deps.cmsPublication = cmsRuntimeDependencies(env)
    return (await handleNewsletterEditorialHttp(request, deps)) ?? unavailable('not_found', 404)
  } catch {
    // Configuration failures do not leak raw JSON, secret values or provider URLs.
    return unavailable()
  }
}
