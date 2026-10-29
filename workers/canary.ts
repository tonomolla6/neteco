import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { listPublishedCategories } from './catalog/categories'
import { listPublishedProducts, type ProductSort } from './catalog/products'
import { getPublishedProductDetail } from './catalog/product-detail'
import { handlePublicSearchHttp } from './catalog/search-http'
import { handleSearchSynonymsHttp, ownsSearchSynonymsNamespace } from './catalog/search-synonyms-http'
import { handleCatalogRelationsHttp, ownsCatalogRelationsNamespace } from './catalog/catalog-relations-http'
import { handleD1SeoRequest, ownsD1SeoNamespace } from './catalog/seo-http'
import { handleEditorialImportHttp, ownsEditorialImportNamespace } from './catalog/editorial-import-http'
import { handleNativeCatalogImportHttp, ownsNativeCatalogImportNamespace } from './catalog/native-import-http'
import { handleCatalogImportJobHttp, ownsCatalogImportJobNamespace } from './catalog/import-job-http'
import { handleCatalogExportHttp, ownsCatalogExportNamespace } from './catalog/catalog-export-http'
import { handleCatalogTypedAttributesHttp, ownsCatalogTypedAttributesNamespace } from './catalog/typed-attribute-http'
import { InvalidTypedAttributeFiltersError } from './catalog/typed-attribute-facets'
import { parseCatalogTypedFilters } from '../shared/catalog-typed-attribute-filters'
import {
  expireExpiredReservations,
  InventoryError,
  isCanonicalInventoryInstant,
  INVENTORY_COORDINATOR_NAME
} from './catalog/inventory'
import { CartError, getCart } from './catalog/cart'
import { handleStorefrontCartHttp } from './catalog/storefront-cart'
import { handleStorefrontShippingHttp } from './catalog/storefront-shipping'
import { handleShippingCalendarsHttp, ownsShippingCalendarsNamespace } from './catalog/shipping-calendar-http'
import { handleStorefrontCheckoutHttp, revokeStorefrontCredentials } from './catalog/storefront-checkout'
import { handleGuestOrderAccessHttp } from './catalog/guest-order-access-http'
import { readD1GuestOrderView, revokeD1GuestOrderAccess } from './catalog/guest-order-access'
import { cartDoName } from './cart-coordinator'
import { shippingCommercialPolicy } from '../server/utils/shipping-policy'
import { compensateStaleAttempts, getOrderView } from './catalog/checkout'
import { listD1CustomerOrders, readD1CustomerOrderLines } from './catalog/customer-orders'
import { handleCustomerFavoritesHttp } from './catalog/customer-favorites-http'
import { handleCustomerCartSnapshotsHttp, ownsCartSnapshotsNamespace } from './catalog/cart-snapshots-http'
import { handleD1AdminOrdersRequest } from './catalog/admin-orders-http'
import { handleOrderTimelineHttp } from './catalog/order-timeline-http'
import { handleOrderCancellationHttp } from './catalog/order-cancellation-http'
import { handleOrderExportHttp } from './catalog/order-export-http'
import { handleOrderAnnotationsHttp } from './catalog/order-annotations-http'
import { handleAdminFulfillmentHttp, ownsAdminFulfillmentNamespace } from './fulfillment/admin-http'
import { handleAdminPackingHttp, ownsAdminPackingNamespace } from './fulfillment/packing-http'
import { handleAdminOrderBulkHttp, ownsAdminOrderBulkNamespace } from './fulfillment/bulk-http'
import {
  consumeAdminOrderBulkMessage,
  dispatchAdminOrderBulkRequests,
  parseAdminOrderBulkMessage
} from './fulfillment/bulk-runtime'
import {
  handleOrderTrackingHttp,
  ownsOrderTrackingNamespace,
  ownsAdminOrderTrackingNamespace
} from './fulfillment/tracking-http'
import { handleCmsDraftHttp, ownsCmsNamespace } from './cms/http'
import { handleCmsPublicHttp, CMS_PUBLIC_HEADERS } from './cms/public-http'
import { handlePromotionalContentHttp, ownsPromotionalContentNamespace } from './cms/promotional-content-http'
import { handleResourceHubHttp, ownsResourceHubNamespace } from './content/resource-hub-http'
import { handleCmsMediaHttp } from './cms/media-delivery'
import { runCmsSchedules } from './cms/schedules'
import { handleAdminReturnsHttp, ownsAdminReturnsNamespace } from './returns/admin-http'
import { handleCustomerReturnsHttp, ownsCustomerReturnsNamespace } from './returns/customer-http'
import { handleD1FiscalRequest, ownsFiscalNamespace } from './fiscal/http'
import { dispatchFiscalRuntime } from './fiscal/runtime-dispatch'
import { createFiscalPdfStorage } from './runtime/fiscal-pdf-storage'
import {
  cmsRuntimeDependencies,
  configuredFiscalProvider,
  fiscalRuntimeConfiguration,
  operationsEnvironment
} from './runtime/operations-config'
import { handleD1AdminCatalogRequest } from './catalog/admin-catalog-http'
import { handleCatalogCategoryHttp, ownsCatalogCategoryNamespace } from './catalog/admin-categories-http'
import { handleCatalogPolicyHttp, ownsCatalogPolicyNamespace } from './catalog/catalog-policy-http'
import {
  handleCatalogDraftAuthoringHttp,
  ownsCatalogDraftAuthoringNamespace
} from './catalog/admin-catalog-authoring-http'
import { createD1CatalogPublicationGate } from './catalog/catalog-publication-gate'
import { handleD1AdminPricingRequest, ownsD1AdminPricingNamespace } from './catalog/admin-pricing-http'
import { handleAdminPromotionsHttp, ownsAdminPromotionsNamespace } from './catalog/admin-promotions-http'
import {
  handleAdminInventoryHttp,
  inventoryCommandErrorCodeSchema,
  ownsAdminInventoryNamespace
} from './catalog/admin-inventory-http'
import { InventoryCommandError } from './catalog/admin-inventory'
import { handleInventoryAlertsHttp, ownsInventoryAlertsNamespace } from './catalog/inventory-alerts-http'
import { sweepD1InventoryAlerts } from './catalog/inventory-alerts'
import {
  handleInventoryCountImportHttp,
  inventoryCountImportErrorCodeSchema,
  ownsInventoryCountImportNamespace
} from './catalog/inventory-count-import-http'
import { InventoryCountImportError } from './catalog/inventory-count-import'
import { inventoryCountImportReceiptSchema } from '../shared/inventory-count-import'
import { inventoryCommandReceiptSchema } from '../shared/inventory-commands'
import { catalogPolicyOwnJson } from '../shared/catalog-publication-policy'
import { verifySessionCookie } from './auth/session-cookie'
import { handlePaymentHttp, paymentInventoryGateway } from './payments/http'
import { recoverAuthorisedPayments, type PaymentRuntimeConfiguration } from './catalog/payments'
import { publishFiscalOutbox, receiveFiscalEvaluation, reconcileFiscalDelivery } from './catalog/fiscal-outbox'
import { reconcileMediaStorage } from './catalog/media'
import { handleMediaUploadHttp } from './media/http'
import { handleMediaGovernanceHttp } from './media/governance-http'
import { handlePublicMediaHttp } from './media/public-delivery'
import { handleAuthenticationHttp } from './auth/http'
import { handleAdminCapabilitiesHttp } from './auth/admin-capabilities'
import { handleAdminInvitationsHttp, ownsAdminInvitationsNamespace } from './auth/admin-invitations-http'
import { handleAdminAuditHttp, ownsAdminAuditNamespace } from './auth/admin-audit-http'
import { handleAdminOrderViewsHttp, ownsAdminOrderViewsNamespace } from './catalog/admin-order-views-http'
import { supportJson } from './support/http'
import { handleAdminActivityHttp } from './auth/admin-activity-http'
import { handleAdminGlobalSearchHttp } from './auth/admin-global-search-http'
import { handleAdminCompaniesHttp } from './auth/admin-companies-http'
import { handleAccountPrivacyHttp } from './auth/account-privacy-http'
import { handleAccountPreferencesHttp } from './auth/account-preferences-http'
import { handleDeliveryPreferencesRequest, ownsDeliveryPreferencesNamespace } from './auth/delivery-preferences-http'
import { handleIdentityLifecycleHttp } from './auth/lifecycle-http'
import { checkAdministrativeEdgeLimit } from './auth/edge-limit'
import { pruneAuthenticationQuotas } from './auth/anonymous-quota'
import { pruneD1MfaEnrollments } from './auth/mfa-enrollment'
import { publishEmailOutbox, receiveEmailDispatch, reconcileEmailOutbox } from './communications/email-outbox'
import { dispatchTransactionalEmails } from './communications/transactional-email-delivery'
import { dispatchIdentityEmailDeliveries } from './communications/identity-email-delivery'
import { dispatchNewsletterConfirmations, pruneNewsletterRequestLimits } from './marketing/newsletter-delivery'
import { dispatchConfiguredProductWatches } from './runtime/product-watch'
import { dispatchConfiguredCartRecoveries } from './runtime/cart-recovery'
import { handleNewsletterHttp } from './marketing/newsletter-http'
import type { NewsletterSecrets } from './marketing/newsletter'
import { handleCustomerOperationsHttp } from './runtime/customer-operations-http'
import { handleConfiguredAnalyticsHttp } from './runtime/analytics-http'
import { handleDemoLoginRequest } from './demo/login'
import { dispatchConfiguredAnalytics } from './runtime/analytics-dispatch'
import {
  dispatchCustomerFinancialOperations,
  dispatchConfiguredNewsletterCampaigns
} from './runtime/customer-operations-dispatch'
import {
  customerEmailConfiguration,
  customerEmailRenderers,
  configuredNewsletterConsentMaintenance
} from './runtime/customer-operations-config'
export { InventoryCoordinator } from './inventory-coordinator'
export { CartCoordinator } from './cart-coordinator'

const CART_BODY_LIMIT_BYTES = 4096
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cartErrorResponse(error: unknown): Response {
  if (error instanceof CartError)
    return noStoreJson(
      { error: { code: error.code } },
      error.code === 'invalid_input'
        ? 400
        : error.code === 'unauthorized'
          ? 401
          : error.code === 'empty_cart' || error.code === 'variant_not_available'
            ? 422
            : 409
    )
  return noStoreJson({ error: { code: 'internal' } }, 500)
}

function noStoreJson(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

async function runConfiguredFiscalRuntime(env: CloudflareEnv) {
  return dispatchFiscalRuntime(
    {
      database: env.DB,
      storage: createFiscalPdfStorage(env.MEDIA),
      providerResolver: (policy) => configuredFiscalProvider(env, policy, fetch)
    },
    fiscalRuntimeConfiguration(env, serverNow())
  )
}

function bearerCartToken(request: Request): string | null {
  const match = (request.headers.get('authorization') ?? '').match(/^Cart ([A-Za-z0-9_-]{43,86})$/)
  return match ? match[1]! : null
}

function hasSessionCookie(request: Request): boolean {
  return /(?:^|;)\s*neteco-session=/.test(request.headers.get('cookie') ?? '')
}

async function customerSession(request: Request, env: CloudflareEnv) {
  if (env.AUTH_ENABLED !== 'true') return null
  return verifySessionCookie(request, { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 })
}

function paymentConfiguration(env: CloudflareEnv): PaymentRuntimeConfiguration | null {
  if (
    env.REDSYS_ENABLED !== 'true' ||
    !env.REDSYS_SECRET_KEY ||
    !env.REDSYS_MERCHANT_CODE ||
    !env.REDSYS_TERMINAL ||
    !['sandbox', 'production'].includes(env.REDSYS_ENVIRONMENT)
  )
    return null
  let publicUrl: URL
  try {
    publicUrl = new URL(env.PAYMENT_PUBLIC_BASE_URL)
  } catch {
    return null
  }
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.hostname.endsWith('.invalid') ||
    !/^\d{9}$/.test(env.REDSYS_MERCHANT_CODE) ||
    !/^\d{1,3}$/.test(env.REDSYS_TERMINAL) ||
    !/^[\x20-\x7e]+$/.test(env.REDSYS_SECRET_KEY) ||
    env.REDSYS_SECRET_KEY.startsWith('local-only-') ||
    (env.REDSYS_ENVIRONMENT === 'production' && env.REDSYS_MERCHANT_CODE === '999008881')
  )
    return null
  return {
    environment: env.REDSYS_ENVIRONMENT as 'sandbox' | 'production',
    merchantCode: env.REDSYS_MERCHANT_CODE,
    terminal: env.REDSYS_TERMINAL,
    secretKey: env.REDSYS_SECRET_KEY,
    merchantName: 'NETECO',
    bizumEnabled: env.REDSYS_BIZUM_ENABLED === 'true',
    publicBaseUrl: env.PAYMENT_PUBLIC_BASE_URL
  }
}

async function readLimitedJson(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > CART_BODY_LIMIT_BYTES) return null
  if (!request.body) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > CART_BODY_LIMIT_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (!raw.length) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function serverNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function newsletterConfiguration(
  env: CloudflareEnv
): { secrets: NewsletterSecrets; publicOrigin: string; from: string } | null {
  if (env.NEWSLETTER_ENABLED !== 'true' || typeof env.NEWSLETTER_HMAC_KEY !== 'string') return null
  const encoded = env.NEWSLETTER_HMAC_KEY
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || /^A{43}$/.test(encoded)) return null
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='), (char) =>
      char.charCodeAt(0)
    )
    if (bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null
    const origin = new URL(env.NEWSLETTER_PUBLIC_ORIGIN)
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== env.NEWSLETTER_PUBLIC_ORIGIN ||
      origin.hostname.endsWith('.invalid')
    )
      return null
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(env.NEWSLETTER_EMAIL_FROM)) return null
    if (typeof env.NEWSLETTER_EMAIL?.send !== 'function') return null
    return { secrets: { hmacKey: bytes }, publicOrigin: origin.origin, from: env.NEWSLETTER_EMAIL_FROM }
  } catch {
    return null
  }
}

async function dispatchCartCommand(env: CloudflareEnv, command: Record<string, unknown>): Promise<Response> {
  const cartId = typeof command.cartId === 'string' ? command.cartId : `create:${crypto.randomUUID()}`
  const stub = env.CARTS.get(env.CARTS.idFromName(cartDoName(cartId)))
  const response = await stub.fetch(
    new Request('https://cart-coordinator.invalid/command', {
      method: 'POST',
      body: JSON.stringify(command)
    })
  )
  return noStoreJson(await response.json(), response.status)
}

const QUEUE_MESSAGE_VERSION = 1

interface ExpiryQueueMessage {
  version: number
  type: string
  messageId: string
  correlationId: string
  /** Canonical UTC instant this delivery was scheduled for; stale values are ignored by the SQL gate. */
  before: string
}

function parseExpiryMessage(
  body: unknown
): { ok: true; message: ExpiryQueueMessage } | { ok: false; permanent: boolean } {
  if (typeof body !== 'object' || body === null) return { ok: false, permanent: true }
  const raw = body as Record<string, unknown>
  if (raw.version !== QUEUE_MESSAGE_VERSION) return { ok: false, permanent: true }
  if (raw.type !== 'inventory.expire') return { ok: false, permanent: true }
  for (const key of ['messageId', 'correlationId'] as const)
    if (
      typeof raw[key] !== 'string' ||
      !(raw[key] as string).length ||
      (raw[key] as string).length > 200 ||
      [...(raw[key] as string)].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return { ok: false, permanent: true }
  if (!isCanonicalInventoryInstant(raw.before)) return { ok: false, permanent: true }
  return {
    ok: true,
    message: {
      before: raw.before as string,
      correlationId: raw.correlationId as string,
      messageId: raw.messageId as string,
      type: raw.type as string,
      version: QUEUE_MESSAGE_VERSION
    }
  }
}

export interface CanaryCheck {
  ok: boolean
  detail?: string
}

export interface CanaryHealth {
  ok: boolean
  service: 'neteco-cloudflare-canary'
  checks: {
    d1: CanaryCheck
    durableObjects: CanaryCheck
    inventory: CanaryCheck
    carts: CanaryCheck
    cartRateLimit: CanaryCheck
    kv: CanaryCheck
    queues: CanaryCheck
    r2: CanaryCheck
    workflows: CanaryCheck
  }
}

function bindingCheck(value: unknown, methods: string[]): CanaryCheck {
  const binding = value as Record<string, unknown> | undefined
  const ok = !!binding && methods.every((method) => typeof binding[method] === 'function')
  return ok ? { ok } : { ok, detail: 'binding_missing_or_invalid' }
}

export async function inspectCanaryBindings(env: CloudflareEnv): Promise<CanaryHealth> {
  let d1: CanaryCheck
  try {
    const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    d1 = result?.ok === 1 ? { ok: true } : { ok: false, detail: 'probe_failed' }
  } catch {
    d1 = { ok: false, detail: 'probe_failed' }
  }

  const checks = {
    d1,
    durableObjects: bindingCheck(env.COORDINATOR, ['idFromName', 'get']),
    inventory: bindingCheck(env.INVENTORY, ['idFromName', 'get']),
    carts: bindingCheck(env.CARTS, ['idFromName', 'get']),
    cartRateLimit: bindingCheck(env.CART_EDGE_LIMIT, ['limit']),
    kv: bindingCheck(env.CACHE, ['get', 'put']),
    queues: bindingCheck(env.ASYNC_JOBS, ['send']),
    r2: bindingCheck(env.MEDIA, ['get', 'put']),
    workflows: bindingCheck(env.CATALOG_WORKFLOW, ['create', 'get'])
  }

  return {
    ok: Object.values(checks).every((check) => check.ok),
    service: 'neteco-cloudflare-canary',
    checks
  }
}

export class CanaryCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: CloudflareEnv
  ) {}

  fetch(): Response {
    return Response.json({ ok: true, id: this.state.id.toString(), environment: this.env.APP_ENV })
  }
}

export class CanaryWorkflow extends WorkflowEntrypoint<CloudflareEnv, { correlationId: string }> {
  override async run(event: WorkflowEvent<{ correlationId: string }>, step: WorkflowStep) {
    return step.do('validate platform bindings', async () => ({
      ok: true,
      correlationId: event.payload.correlationId,
      environment: this.env.APP_ENV
    }))
  }
}

export default {
  async scheduled(event: ScheduledController, env: CloudflareEnv): Promise<void> {
    const now = new Date(event.scheduledTime).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const failures: Array<{ stage: string; cause: unknown }> = []
    // A failed subsystem must not starve unrelated committed obligations. Keep
    // dependency chains inside one stage, run bounded stages sequentially, and
    // reject the invocation after all independent work has had its opportunity.
    const stage = async (name: string, action: () => Promise<void>) => {
      try {
        await action()
      } catch (cause) {
        failures.push({ stage: name, cause })
        // Exception text may contain credentials or private provider payloads.
        console.log(JSON.stringify({ event: 'scheduled.stage.failed', stage: name }))
      }
    }
    if (env.AUTH_ENABLED === 'true') {
      await stage('auth.quotas', async () => {
        await pruneAuthenticationQuotas(env.DB)
      })
      await stage('auth.mfa', async () => {
        await pruneD1MfaEnrollments(env.DB, now)
      })
      await stage('orders.bulk-fulfillment', async () => {
        const result = await dispatchAdminOrderBulkRequests(env.DB, env.ASYNC_JOBS, {
          enabled: true,
          now,
          limit: 5
        })
        console.log(JSON.stringify({ event: 'orders.bulk-fulfillment.dispatch', ...result }))
      })
    }
    await stage('payments.recovery', async () => {
      const result = await recoverAuthorisedPayments(env.DB, { now, limit: 25 }, paymentInventoryGateway(env))
      console.log(JSON.stringify({ event: 'payments.recovery', ...result }))
    })
    await stage('fiscal.outbox', async () => {
      const fiscalReceipts = await reconcileFiscalDelivery(env.DB, { now, limit: 25 })
      console.log(JSON.stringify({ event: 'fiscal.outbox.reconcile', ...fiscalReceipts }))
      const fiscal = await publishFiscalOutbox(
        env.DB,
        {
          send: async (message) => {
            await env.ASYNC_JOBS.send(message)
          }
        },
        { now, limit: 25 }
      )
      console.log(JSON.stringify({ event: 'fiscal.outbox.publish', ...fiscal }))
    })
    await stage('fiscal.runtime', async () => {
      const issuance = await runConfiguredFiscalRuntime(env)
      console.log(JSON.stringify({ event: 'fiscal.runtime.dispatch', ...issuance }))
    })
    await stage('financial.operations', async () => {
      const financialOperations = await dispatchCustomerFinancialOperations(env, serverNow())
      console.log(JSON.stringify({ event: 'financial.operations.dispatch', ...financialOperations }))
    })
    if (env.AUTH_ENABLED === 'true' && env.INVENTORY_ALERTS_ENABLED === 'true') {
      await stage('inventory.alerts', async () => {
        const { processed, opened, updated, resolved } = await sweepD1InventoryAlerts(
          env.DB,
          { limit: 100 },
          { now: () => now }
        )
        console.log(JSON.stringify({ event: 'inventory.alerts.evaluate', processed, opened, updated, resolved }))
      })
    }
    await stage('cms.schedules', async () => {
      const cms = await runCmsSchedules(cmsRuntimeDependencies(env), { limit: 25 })
      console.log(JSON.stringify({ event: 'cms.schedule.dispatch', ...cms }))
    })
    await stage('media.reconciliation', async () => {
      const media = await reconcileMediaStorage(env.DB, env.MEDIA, { now, limit: 25 })
      console.log(JSON.stringify({ event: 'media.storage.reconcile', ...media }))
    })
    await stage('email.outbox', async () => {
      const emailReceipts = await reconcileEmailOutbox(env.DB, { now, limit: 25 })
      console.log(JSON.stringify({ event: 'email.outbox.reconcile', ...emailReceipts }))
      const emailPublished = await publishEmailOutbox(
        env.DB,
        {
          send: async (message) => {
            await env.ASYNC_JOBS.send(message)
          }
        },
        { now, limit: 25 }
      )
      console.log(JSON.stringify({ event: 'email.outbox.publish', ...emailPublished }))
    })
    await stage('email.transactional', async () => {
      const transactional = await dispatchTransactionalEmails(
        env.DB,
        env.EMAIL,
        {
          enabled: env.TRANSACTIONAL_EMAIL_ENABLED === 'true',
          from: env.TRANSACTIONAL_EMAIL_FROM,
          now: serverNow(),
          limit: 25,
          appEnvironment: operationsEnvironment(env.APP_ENV),
          invoiceEmailEnabled: env.INVOICE_EMAIL_ENABLED === 'true',
          invoiceValidationEmailEnabled: env.INVOICE_VALIDATION_EMAIL_ENABLED === 'true',
          ...(env.AUTH_ENABLED === 'true'
            ? {
                guestOrderLinks: {
                  publicOrigin: env.AUTH_ORIGIN,
                  sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
                }
              }
            : {}),
          ...customerEmailConfiguration(env)
        },
        { renderers: customerEmailRenderers }
      )
      console.log(JSON.stringify({ event: 'email.transactional.dispatch', ...transactional }))
    })
    await stage('email.identity', async () => {
      const identityEmail = await dispatchIdentityEmailDeliveries(env.DB, env.EMAIL, {
        enabled: env.AUTH_ENABLED === 'true' && env.AUTH_EMAIL_ENABLED === 'true',
        from: env.AUTH_EMAIL_FROM,
        publicOrigin: env.AUTH_ORIGIN,
        encryptionKey: env.AUTH_ENCRYPTION_KEY,
        tokenPepper: env.AUTH_TOKEN_PEPPER,
        now: serverNow(),
        limit: 25
      })
      console.log(JSON.stringify({ event: 'email.identity.dispatch', ...identityEmail }))
    })
    await stage('newsletter.confirmation', async () => {
      const newsletter = newsletterConfiguration(env)
      if (newsletter) {
        const newsletterNow = Math.floor(Date.now() / 1000)
        await pruneNewsletterRequestLimits(env.DB, newsletterNow)
        const deliveries = await dispatchNewsletterConfirmations(env.DB, env.NEWSLETTER_EMAIL, {
          ...newsletter,
          now: newsletterNow
        })
        console.log(JSON.stringify({ event: 'newsletter.confirmation.dispatch', ...deliveries }))
      }
    })
    await stage('newsletter.campaign', async () => {
      const campaigns = await dispatchConfiguredNewsletterCampaigns(env)
      console.log(JSON.stringify({ event: 'newsletter.campaign.dispatch', ...campaigns }))
    })
    await stage('product-watches', async () => {
      const result = await dispatchConfiguredProductWatches(env, now)
      console.log(JSON.stringify({ event: 'product-watch.dispatch', ...result }))
    })
    await stage('cart-recovery', async () => {
      const result = await dispatchConfiguredCartRecoveries(env, now)
      console.log(JSON.stringify({ event: 'cart-recovery.dispatch', ...result }))
    })
    await stage('analytics.maintenance', async () => {
      const analytics = await dispatchConfiguredAnalytics(env, serverNow)
      console.log(JSON.stringify({ event: 'analytics.maintenance.dispatch', ...analytics }))
    })
    if (failures.length)
      throw new AggregateError(
        failures.map(({ cause }) => cause),
        `scheduled_jobs_failed:${failures.map(({ stage }) => stage).join(',')}`
      )
  },

  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const demoLogin = await handleDemoLoginRequest(request, env)
    if (demoLogin) return demoLogin
    const analytics = await handleConfiguredAnalyticsHttp(request, env)
    if (analytics) return analytics
    const customerOperations = await handleCustomerOperationsHttp(request, env)
    if (customerOperations) return customerOperations
    const cmsDependencies = cmsRuntimeDependencies(env)
    if (ownsResourceHubNamespace(new URL(request.url).pathname)) {
      if (/^\/api\/resources(?:\/|$)/.test(new URL(request.url).pathname) && env.CMS_PUBLICATION_ENABLED !== 'true') {
        return Response.json({ error: { code: 'content_unavailable' } }, { status: 503, headers: CMS_PUBLIC_HEADERS })
      }
      const resourceHub = await handleResourceHubHttp(request, cmsDependencies)
      if (resourceHub) return resourceHub
    }
    if (ownsPromotionalContentNamespace(new URL(request.url).pathname)) {
      if (new URL(request.url).pathname === '/api/promotional-content' && !cmsDependencies.enabled)
        return Response.json(
          { error: { code: 'content_unavailable' } },
          {
            status: 503,
            headers: CMS_PUBLIC_HEADERS
          }
        )
      const promotional = await handlePromotionalContentHttp(request, cmsDependencies)
      if (promotional) return promotional
    }
    const cmsMedia = await handleCmsMediaHttp(request, cmsDependencies)
    if (cmsMedia) return cmsMedia
    const publicContent = await handleCmsPublicHttp(request, cmsDependencies)
    if (publicContent) return publicContent
    const publicMedia = await handlePublicMediaHttp(request, {
      database: env.DB,
      bucket: env.MEDIA,
      images: env.IMAGES,
      enabled: env.MEDIA_PUBLIC_ENABLED === 'true'
    })
    if (publicMedia) return publicMedia
    if (ownsD1SeoNamespace(new URL(request.url).pathname, cmsDependencies.enabled === true)) {
      let environment: 'local' | 'preview' | 'production'
      try {
        // The historical audit label applies only to public SEO metadata. It
        // does not authorize the fiscal factory or any other native operation.
        environment = env.APP_ENV === 'audit' ? 'local' : operationsEnvironment(env.APP_ENV)
      } catch {
        return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      }
      const seo = await handleD1SeoRequest(request, {
        database: env.DB,
        origin: env.PUBLIC_SITE_ORIGIN,
        environment: environment === 'preview' ? 'preprod' : environment,
        cmsPublication: cmsDependencies
      })
      if (seo) return seo
    }
    const search = await handlePublicSearchHttp(request, { database: env.DB })
    if (search) return search
    if (ownsCartSnapshotsNamespace(new URL(request.url).pathname)) {
      // Both private saves and public capabilities require the configured
      // identity boundary. Never fall through to a legacy account/cart API.
      if (env.AUTH_ENABLED !== 'true')
        return Response.json(
          { error: { code: 'service_unavailable' } },
          {
            status: 503,
            headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', vary: 'Cookie' }
          }
        )
      const snapshot = await handleCustomerCartSnapshotsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (snapshot) return snapshot
      return noStoreJson({ error: { code: 'not_found' } }, 404)
    }
    const favorites = await handleCustomerFavoritesHttp(request, {
      database: env.DB,
      edgeLimiter: env.AUTH_EDGE_LIMIT,
      configuration: () =>
        env.AUTH_ENABLED === 'true'
          ? {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600,
              origin: env.AUTH_ORIGIN,
              tokenPepper: env.AUTH_TOKEN_PEPPER
            }
          : null
    })
    if (favorites) return favorites
    const path = new URL(request.url).pathname
    if (ownsAdminOrderViewsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return supportJson({ error: { code: 'service_unavailable' } }, 503)
      return (
        (await handleAdminOrderViewsHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          edgeGate: async (incoming) => {
            const result = await checkAdministrativeEdgeLimit(
              incoming,
              env.ADMIN_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              'administrative-order-views'
            )
            return result === 'limited' ? 'denied' : result
          }
        })) ?? supportJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsAdminAuditNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return supportJson({ error: { code: 'service_unavailable' } }, 503)
      return (
        (await handleAdminAuditHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          edgeGate: async (incoming) => {
            const result = await checkAdministrativeEdgeLimit(
              incoming,
              env.ADMIN_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              'admin-audit'
            )
            return result === 'limited' ? 'denied' : result
          }
        })) ?? supportJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsAdminInvitationsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return supportJson({ error: { code: 'service_unavailable' } }, 503)
      return (
        (await handleAdminInvitationsHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          edgeGate: async (incoming) => {
            const result = await checkAdministrativeEdgeLimit(
              incoming,
              env.ADMIN_EDGE_LIMIT,
              env.AUTH_RATE_LIMIT_PEPPER,
              'admin-invitations'
            )
            return result === 'limited' ? 'denied' : result
          }
        })) ?? supportJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsShippingCalendarsNamespace(path)) {
      const privateFailure = (code: string, status: number) =>
        Response.json(
          { error: { code } },
          {
            status,
            headers: {
              'Cache-Control': 'private, no-store',
              Pragma: 'no-cache',
              Vary: 'Cookie',
              'Referrer-Policy': 'no-referrer',
              'X-Content-Type-Options': 'nosniff',
              'X-Robots-Tag': 'noindex, nofollow, noarchive'
            }
          }
        )
      if (env.AUTH_ENABLED !== 'true') return privateFailure('service_unavailable', 503)
      return (
        (await handleShippingCalendarsHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          edgeLimiter: env.ADMIN_EDGE_LIMIT,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
        })) ?? privateFailure('not_found', 404)
      )
    }
    const privacyNamespace = path === '/api/account/privacy' || path.startsWith('/api/account/privacy/')
    const preferencesNamespace = path === '/api/account/preferences' || path.startsWith('/api/account/preferences/')
    const deliveryPreferencesNamespace = ownsDeliveryPreferencesNamespace(path)
    if (privacyNamespace || preferencesNamespace || deliveryPreferencesNamespace) {
      const privateResponse = (code: string, status: number) => {
        const response = noStoreJson({ error: { code } }, status)
        response.headers.set('Cache-Control', 'private, no-store')
        response.headers.set('Vary', 'Cookie')
        return response
      }
      if (env.AUTH_ENABLED !== 'true') return privateResponse('service_unavailable', 503)
      const dependencies = {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      }
      const settings = deliveryPreferencesNamespace
        ? await handleDeliveryPreferencesRequest(request, {
            ...dependencies,
            edgeLimiter: env.AUTH_EDGE_LIMIT,
            rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
          })
        : privacyNamespace
          ? await handleAccountPrivacyHttp(request, dependencies)
          : await handleAccountPreferencesHttp(request, {
              ...dependencies,
              edgeLimiter: env.AUTH_EDGE_LIMIT,
              rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
            })
      return settings ?? privateResponse('not_found', 404)
    }
    if (path === '/api/admin/companies' || path.startsWith('/api/admin/companies/')) {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        denied.headers.set('Vary', 'Cookie')
        return denied
      }
      const companies = await handleAdminCompaniesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (companies) return companies
      const missing = noStoreJson({ error: { code: 'not_found' } }, 404)
      missing.headers.set('Cache-Control', 'private, no-store')
      missing.headers.set('Vary', 'Cookie')
      return missing
    }
    if (/^\/api\/admin\/orders\/[^/]+\/annotations(?:\/commands\/[^/]+)?$/.test(path)) {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        return denied
      }
      const annotations = await handleOrderAnnotationsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (annotations) return annotations
    }
    if (path === '/api/admin/orders/export.csv') {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        return denied
      }
      const orderExport = await handleOrderExportHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (orderExport) return orderExport
    }
    if (/^\/api\/(admin\/)?orders\/[^/]+\/cancellation(?:\/commands\/[^/]+)?$/.test(path)) {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        return denied
      }
      const cancellation = await handleOrderCancellationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: path.startsWith('/api/admin/') ? env.ADMIN_EDGE_LIMIT : env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (cancellation) return cancellation
    }
    if (ownsOrderTrackingNamespace(path)) {
      const rejectTracking = (code: string, status: number) => {
        const response = noStoreJson({ error: { code } }, status)
        response.headers.set('Cache-Control', 'private, no-store')
        response.headers.set('Vary', 'Cookie')
        response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
        response.headers.set('Referrer-Policy', 'no-referrer')
        return response
      }
      if (env.AUTH_ENABLED !== 'true') return rejectTracking('service_unavailable', 503)
      const administrative = ownsAdminOrderTrackingNamespace(path)
      const edgeLimiter = administrative ? env.ADMIN_EDGE_LIMIT : env.AUTH_EDGE_LIMIT
      const limited = await checkAdministrativeEdgeLimit(
        request,
        edgeLimiter,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-fulfillment' : 'customer-refunds'
      )
      if (limited !== 'allowed')
        return rejectTracking(
          limited === 'limited' ? 'rate_limited' : 'service_unavailable',
          limited === 'limited' ? 429 : 503
        )
      const tracking = await handleOrderTrackingHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      return tracking ?? rejectTracking('invalid_input', 400)
    }
    if (/^\/api\/(admin\/)?orders\/[^/]+\/timeline$/.test(path)) {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        return denied
      }
      let appEnvironment: 'local' | 'preview' | 'production'
      try {
        appEnvironment = operationsEnvironment(env.APP_ENV)
      } catch {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        return denied
      }
      const timeline = await handleOrderTimelineHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: path.startsWith('/api/admin/') ? env.ADMIN_EDGE_LIMIT : env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        appEnvironment
      })
      if (timeline) return timeline
    }
    if (path === '/api/admin/global-search') {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const search = await handleAdminGlobalSearchHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (search) return search
    }
    if (path === '/api/admin/activity') {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const activity = await handleAdminActivityHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (activity) return activity
    }
    if (path === '/api/admin/capabilities') {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-capabilities'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const capabilities = await handleAdminCapabilitiesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      })
      if (capabilities) return capabilities
    }
    if (ownsCatalogRelationsNamespace(path)) {
      const administrative = path.toLowerCase().startsWith('/api/admin/')
      if (administrative && env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        denied.headers.set('Referrer-Policy', 'no-referrer')
        denied.headers.set('Vary', 'Cookie')
        return denied
      }
      const relations = await handleCatalogRelationsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (relations) return relations
      return noStoreJson({ error: { code: 'not_found' } }, 404)
    }
    if (
      ['/api/admin/products', '/api/admin/categories'].includes(path) ||
      path.startsWith('/api/admin/products/') ||
      path.startsWith('/api/admin/categories/') ||
      ownsCatalogCategoryNamespace(path) ||
      ownsCatalogPolicyNamespace(path) ||
      ownsCatalogDraftAuthoringNamespace(path) ||
      ownsEditorialImportNamespace(path) ||
      ownsNativeCatalogImportNamespace(path) ||
      ownsCatalogImportJobNamespace(path) ||
      ownsCatalogExportNamespace(path) ||
      ownsCatalogTypedAttributesNamespace(path) ||
      ownsSearchSynonymsNamespace(path)
    ) {
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        if (ownsCatalogTypedAttributesNamespace(path)) denied.headers.set('cache-control', 'private, no-store')
        return denied
      }
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-catalog'
      )
      if (limited !== 'allowed') {
        const denied = noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
        if (ownsCatalogTypedAttributesNamespace(path)) denied.headers.set('cache-control', 'private, no-store')
        return denied
      }
      const synonyms = await handleSearchSynonymsHttp(request, env)
      if (synonyms) return synonyms
      const typedAttributes = await handleCatalogTypedAttributesHttp(request, env)
      if (typedAttributes) return typedAttributes
      const editorial = await handleEditorialImportHttp(request, env)
      if (editorial) return editorial
      const nativeImport = await handleNativeCatalogImportHttp(request, env)
      if (nativeImport) return nativeImport
      const importJob = await handleCatalogImportJobHttp(request, env)
      if (importJob) return importJob
      const snapshot = await handleCatalogExportHttp(request, env)
      if (snapshot) return snapshot
      const policy = await handleCatalogPolicyHttp(request, env)
      if (policy) return policy
      const authoring = await handleCatalogDraftAuthoringHttp(request, env)
      if (authoring) return authoring
      const categoryCommand = await handleCatalogCategoryHttp(request, env)
      if (categoryCommand) return categoryCommand
      const catalog = await handleD1AdminCatalogRequest(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        publicationGate: createD1CatalogPublicationGate({
          bucket: env.MEDIA,
          enabled: env.MEDIA_PUBLIC_ENABLED === 'true' && env.MEDIA_ADMIN_ENABLED === 'true'
        })
      })
      if (catalog) return catalog
    }
    if (ownsD1AdminPricingNamespace(path) || ownsAdminPromotionsNamespace(path)) {
      const privateFailure = (code: string, status: number) =>
        Response.json(
          { error: { code } },
          { status, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } }
        )
      if (env.AUTH_ENABLED !== 'true') return privateFailure('service_unavailable', 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-pricing'
      )
      if (limited !== 'allowed')
        return privateFailure(
          limited === 'limited' ? 'rate_limited' : 'service_unavailable',
          limited === 'limited' ? 429 : 503
        )
      const promotions = await handleAdminPromotionsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        ...(path === '/api/admin/promotions/basket-preview'
          ? {
              freeShippingThresholdCents: shippingCommercialPolicy({
                APP_ENV: env.APP_ENV,
                FREE_SHIPPING_THRESHOLD_CENTS: env.FREE_SHIPPING_THRESHOLD_CENTS
              } as NodeJS.ProcessEnv).freeShippingThresholdCents
            }
          : {})
      })
      if (promotions) return promotions
      const pricing = await handleD1AdminPricingRequest(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      })
      if (pricing) return pricing
    }
    if (ownsInventoryAlertsNamespace(path)) {
      const unavailable = () =>
        Response.json(
          { error: { code: 'service_unavailable' } },
          {
            status: 503,
            headers: {
              'cache-control': 'private, no-store',
              pragma: 'no-cache',
              vary: 'Cookie',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'x-robots-tag': 'noindex, nofollow, noarchive'
            }
          }
        )
      if (env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleInventoryAlertsHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          edgeLimiter: env.ADMIN_EDGE_LIMIT,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
        })) ?? unavailable()
      )
    }
    if (ownsInventoryCountImportNamespace(path)) {
      const unavailable = () =>
        Response.json(
          { error: { code: 'service_unavailable' } },
          {
            status: 503,
            headers: {
              'cache-control': 'private, no-store',
              pragma: 'no-cache',
              vary: 'Cookie',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'x-robots-tag': 'noindex, nofollow, noarchive'
            }
          }
        )
      if (env.AUTH_ENABLED !== 'true') return unavailable()
      return (
        (await handleInventoryCountImportHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          edgeLimiter: env.ADMIN_EDGE_LIMIT,
          rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
          coordinate: async (command) => {
            const stub = env.INVENTORY.get(env.INVENTORY.idFromName(INVENTORY_COORDINATOR_NAME))
            const response = await stub.fetch('https://inventory.internal/command', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(command)
            })
            const payload: unknown = catalogPolicyOwnJson(await response.json())
            if (!response.ok) {
              const code = inventoryCountImportErrorCodeSchema.safeParse(
                payload &&
                  typeof payload === 'object' &&
                  'error' in payload &&
                  payload.error &&
                  typeof payload.error === 'object' &&
                  'code' in payload.error
                  ? payload.error.code
                  : undefined
              )
              if (code.success) throw new InventoryCountImportError(code.data)
              throw new Error('inventory_count_coordinator_unavailable')
            }
            const receipt = inventoryCountImportReceiptSchema.safeParse(payload)
            if (!receipt.success) throw new Error('inventory_count_coordinator_receipt_invalid')
            return receipt.data
          }
        })) ?? unavailable()
      )
    }
    if (ownsAdminInventoryNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-inventory'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const inventory = await handleAdminInventoryHttp(request, env, {
        coordinate: async (command) => {
          const stub = env.INVENTORY.get(env.INVENTORY.idFromName(INVENTORY_COORDINATOR_NAME))
          const response = await stub.fetch('https://inventory.internal/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(command)
          })
          // The response is bounded by our own internal coordinator: either a
          // short domain code or a validated receipt, never provider content.
          const payload: unknown = catalogPolicyOwnJson(await response.json())
          if (!response.ok) {
            const code = inventoryCommandErrorCodeSchema.safeParse(
              payload &&
                typeof payload === 'object' &&
                'error' in payload &&
                payload.error &&
                typeof payload.error === 'object' &&
                'code' in payload.error
                ? payload.error.code
                : undefined
            )
            if (code.success) throw new InventoryCommandError(code.data)
            throw new Error('inventory_coordinator_unavailable')
          }
          const receipt = inventoryCommandReceiptSchema.safeParse(payload)
          if (!receipt.success) throw new Error('inventory_coordinator_receipt_invalid')
          return receipt.data
        }
      })
      if (inventory) return inventory
    }
    if (ownsCmsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-cms'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const content = await handleCmsDraftHttp(request, env, { publication: cmsDependencies })
      if (content) return content
    }
    if (ownsAdminReturnsNamespace(path) || ownsCustomerReturnsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const administrative = ownsAdminReturnsNamespace(path)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-returns' : 'customer-returns'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const response = administrative
        ? await handleAdminReturnsHttp(request, env)
        : await handleCustomerReturnsHttp(request, env)
      if (response) return response
    }
    if (ownsAdminOrderBulkNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const bulk = await handleAdminOrderBulkHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        edgeGate: async (incoming) => {
          const result = await checkAdministrativeEdgeLimit(
            incoming,
            env.ADMIN_EDGE_LIMIT,
            env.AUTH_RATE_LIMIT_PEPPER,
            'admin-fulfillment'
          )
          return result === 'limited' ? 'denied' : result
        }
      })
      return bulk ?? noStoreJson({ error: { code: 'not_found' } }, 404)
    }
    if (ownsAdminPackingNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-fulfillment'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const packing = await handleAdminPackingHttp(request, env)
      if (packing) return packing
    }
    if (ownsAdminFulfillmentNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-fulfillment'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const fulfillment = await handleAdminFulfillmentHttp(request, env)
      if (fulfillment) return fulfillment
    }
    if (ownsFiscalNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const administrative = path.startsWith('/api/admin/')
      const limited = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-fiscal' : 'storefront-fiscal'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      let appEnvironment: 'local' | 'preview' | 'production'
      try {
        appEnvironment = operationsEnvironment(env.APP_ENV)
      } catch {
        return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      }
      const fiscal = await handleD1FiscalRequest(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        appEnvironment,
        storage: createFiscalPdfStorage(env.MEDIA),
        // Adapter construction does not enable dispatch or blind retries.
        // Real credentials and provider configuration are never inferred.
        providerResolver: (policy) => configuredFiscalProvider(env, policy, fetch)
      })
      if (fiscal) return fiscal
    }
    if (
      ['/api/admin/orders', '/api/admin/stats', '/api/admin/operations'].includes(path) ||
      /^\/api\/admin\/orders\/[^/]+\/detail$/.test(path)
    ) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-orders'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const administration = await handleD1AdminOrdersRequest(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      })
      if (administration) return administration
    }
    const newsletterResponse = await handleNewsletterHttp(request, {
      database: env.DB,
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      configuration: () => newsletterConfiguration(env),
      unsubscribeConfiguration: () => configuredNewsletterConsentMaintenance(env)
    })
    if (newsletterResponse) return newsletterResponse
    const storefrontCartResponse = await handleStorefrontCartHttp(request, {
      database: env.DB,
      dispatch: (command) => dispatchCartCommand(env, command),
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
    })
    if (storefrontCartResponse) return storefrontCartResponse
    const storefrontShippingResponse = await handleStorefrontShippingHttp(request, {
      database: env.DB,
      dispatch: (command) => dispatchCartCommand(env, command),
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      session: (incoming) => customerSession(incoming, env),
      authenticationEnabled: env.AUTH_ENABLED === 'true'
    })
    if (storefrontShippingResponse) return storefrontShippingResponse
    if (/^\/api\/orders\/[^/]+\/access$/.test(new URL(request.url).pathname)) {
      if (env.AUTH_ENABLED !== 'true')
        return Response.json(
          { error: { code: 'service_unavailable' } },
          {
            status: 503,
            headers: { 'cache-control': 'private, no-store', vary: 'Cookie', 'referrer-policy': 'no-referrer' }
          }
        )
      const response = await handleGuestOrderAccessHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
      })
      if (response) return response
    }
    const storefrontCheckoutResponse = await handleStorefrontCheckoutHttp(request, {
      database: env.DB,
      dispatch: (command) => dispatchCartCommand(env, command),
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      paymentConfiguration: () => paymentConfiguration(env),
      session: (incoming) => customerSession(incoming, env),
      authenticationEnabled: env.AUTH_ENABLED === 'true',
      ...(env.AUTH_ENABLED === 'true'
        ? {
            readGuestOrder: (incoming: Request, orderId: string) =>
              readD1GuestOrderView(env.DB, incoming, orderId, {
                password: env.NUXT_SESSION_PASSWORD,
                maxAgeSeconds: 3600
              })
          }
        : {})
    })
    if (storefrontCheckoutResponse) return storefrontCheckoutResponse
    const lifecycleResponse = await handleIdentityLifecycleHttp(request, {
      database: env.DB,
      edgeLimiter: env.AUTH_EDGE_LIMIT,
      configuration: () =>
        env.AUTH_ENABLED === 'true'
          ? {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600,
              origin: env.AUTH_ORIGIN,
              tokenPepper: env.AUTH_TOKEN_PEPPER,
              encryptionKey: env.AUTH_ENCRYPTION_KEY,
              newsletterSecrets: newsletterConfiguration(env)?.secrets
            }
          : null
    })
    if (lifecycleResponse) return lifecycleResponse
    const authenticationResponse = await handleAuthenticationHttp(request, {
      database: env.DB,
      edgeLimiter: env.AUTH_EDGE_LIMIT,
      configuration: () =>
        env.AUTH_ENABLED === 'true'
          ? {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600,
              origin: env.AUTH_ORIGIN,
              tokenPepper: env.AUTH_TOKEN_PEPPER,
              encryptionKey: env.AUTH_ENCRYPTION_KEY
            }
          : null
    })
    if (authenticationResponse) {
      if (
        new URL(request.url).pathname === '/api/auth/logout' &&
        request.method === 'POST' &&
        authenticationResponse.ok
      ) {
        try {
          const headers = new Headers(authenticationResponse.headers)
          for (const cookie of await revokeStorefrontCredentials(env.DB, request, serverNow()))
            headers.append('set-cookie', cookie)
          headers.append(
            'set-cookie',
            await revokeD1GuestOrderAccess(env.DB, request, {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600
            })
          )
          return new Response(authenticationResponse.body, { status: authenticationResponse.status, headers })
        } catch {
          return noStoreJson({ error: { code: 'internal' } }, 500)
        }
      }
      return authenticationResponse
    }
    const mediaGovernance = await handleMediaGovernanceHttp(request, {
      database: env.DB,
      edgeLimiter: env.ADMIN_EDGE_LIMIT,
      configuration: () =>
        env.MEDIA_ADMIN_ENABLED === 'true' && env.NUXT_SESSION_PASSWORD
          ? {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600,
              origin: env.MEDIA_ADMIN_ORIGIN,
              rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
            }
          : null,
      scanSecret: () => env.MEDIA_SCAN_SECRET || null
    })
    if (mediaGovernance) return mediaGovernance
    const mediaResponse = await handleMediaUploadHttp(request, {
      database: env.DB,
      bucket: env.MEDIA,
      edgeLimiter: env.ADMIN_EDGE_LIMIT,
      configuration: () =>
        env.MEDIA_ADMIN_ENABLED === 'true' && env.NUXT_SESSION_PASSWORD
          ? {
              password: env.NUXT_SESSION_PASSWORD,
              maxAgeSeconds: 3600,
              origin: env.MEDIA_ADMIN_ORIGIN,
              rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
            }
          : null
    })
    if (mediaResponse) return mediaResponse
    const url = new URL(request.url)
    const paymentResponse = await handlePaymentHttp(request, {
      database: env.DB,
      now: serverNow,
      inventory: paymentInventoryGateway(env),
      configuration: () => paymentConfiguration(env)
    })
    if (paymentResponse) return paymentResponse
    if (request.method === 'GET' && url.pathname === '/api/categories') {
      try {
        return Response.json(await listPublishedCategories(env.DB), {
          headers: { 'cache-control': 'public, max-age=60, stale-while-revalidate=300' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/products') {
      const typed = url.searchParams.get('typed') ?? undefined
      if (url.searchParams.getAll('typed').length > 1 || !parseCatalogTypedFilters(typed).success)
        return Response.json(
          { error: 'invalid_typed_filters' },
          { status: 400, headers: { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' } }
        )
      try {
        const page = Math.max(Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1)
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '24', 10) || 24, 1), 100)
        const requestedSort = url.searchParams.get('sort') ?? 'default'
        const sort: ProductSort = ['name', 'price_asc', 'price_desc'].includes(requestedSort)
          ? (requestedSort as ProductSort)
          : 'default'
        const result = await listPublishedProducts(env.DB, {
          typed,
          category: url.searchParams.get('category')?.slice(0, 180) || undefined,
          search: url.searchParams.get('q')?.trim().slice(0, 160) || undefined,
          brand: url.searchParams.get('brand') ?? undefined,
          badge: url.searchParams.get('badge') ?? undefined,
          envase: url.searchParams.get('envase') ?? undefined,
          talla: url.searchParams.get('talla') ?? undefined,
          capacidad: url.searchParams.get('capacidad') ?? undefined,
          color: url.searchParams.get('color') ?? undefined,
          medida: url.searchParams.get('medida') ?? undefined,
          acabado: url.searchParams.get('acabado') ?? undefined,
          priceMin: url.searchParams.get('price_min') ?? undefined,
          priceMax: url.searchParams.get('price_max') ?? undefined,
          featured: url.searchParams.has('featured'),
          facets: url.searchParams.has('facets'),
          page,
          limit,
          sort
        })
        if (!result) {
          return Response.json(
            { error: 'category_not_found' },
            { status: 404, headers: { 'cache-control': 'no-store' } }
          )
        }
        return Response.json(result, {
          headers: { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' }
        })
      } catch (failure) {
        if (failure instanceof InvalidTypedAttributeFiltersError)
          return Response.json(
            { error: 'invalid_typed_filters' },
            { status: 400, headers: { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' } }
          )
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    const productDetailPath = /^\/api\/products\/([a-z0-9][a-z0-9-]{0,179})$/.exec(url.pathname)
    if (request.method === 'GET' && productDetailPath) {
      try {
        const product = await getPublishedProductDetail(env.DB, productDetailPath[1]!)
        if (!product)
          return Response.json(
            { error: 'product_not_found' },
            { status: 404, headers: { 'cache-control': 'no-store' } }
          )
        return Response.json(product, {
          headers: { 'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store' }
        })
      } catch {
        return Response.json(
          { error: 'catalog_unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        )
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/carts') {
      try {
        const edge = await checkAdministrativeEdgeLimit(
          request,
          env.CART_EDGE_LIMIT,
          env.AUTH_RATE_LIMIT_PEPPER,
          'storefront-cart'
        )
        if (edge === 'unavailable') return noStoreJson({ error: { code: 'abuse_control_unavailable' } }, 503)
        if (edge === 'limited') return noStoreJson({ error: { code: 'rate_limited' } }, 429)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const cartId = crypto.randomUUID()
        const correlationId =
          typeof body.correlationId === 'string'
            ? body.correlationId
            : (request.headers.get('x-correlation-id') ?? 'api')
        return await dispatchCartCommand(env, {
          cartId,
          commandId: crypto.randomUUID(),
          payload: { correlationId: correlationId.slice(0, 200), now: serverNow() },
          type: 'create'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const cartRoute =
      url.pathname.match(/^\/api\/carts\/([0-9a-f-]{36})$/) ?? url.pathname.match(/^\/api\/carts\/([^/]+)$/)
    if (request.method === 'GET' && cartRoute) {
      try {
        if (!UUID_PATTERN.test(cartRoute[1]!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const view = await getCart(env.DB, { cartId: cartRoute[1]!, now: serverNow(), token })
        return noStoreJson(view, 200)
      } catch (error) {
        return cartErrorResponse(error)
      }
    }
    const itemRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/items\/([^/]+)$/)
    if (request.method === 'PUT' && itemRoute) {
      try {
        const [, cartId, variantIdRaw] = itemRoute
        if (!UUID_PATTERN.test(cartId!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (!UUID_PATTERN.test(variantIdRaw!)) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const expectedVersion = body.expectedVersion
        const quantity = body.quantity
        if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity))
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion,
            idempotencyKey,
            now: serverNow(),
            quantity,
            token,
            variantId: variantIdRaw!
          },
          type: 'mutate'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const quoteRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/quote$/)
    if (request.method === 'POST' && quoteRoute) {
      try {
        const cartId = quoteRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const expectedVersion = body.expectedVersion
        if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (body.couponCode !== undefined && body.couponCode !== null && typeof body.couponCode !== 'string')
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (body.couponCode && hasSessionCookie(request) && env.AUTH_ENABLED !== 'true')
          return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        const ownerSession = body.couponCode && hasSessionCookie(request) ? await customerSession(request, env) : null
        if (body.couponCode && hasSessionCookie(request) && !ownerSession)
          return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion,
            idempotencyKey,
            now: serverNow(),
            token,
            ...(body.couponCode === undefined ? {} : { couponCode: body.couponCode, ownerSession })
          },
          type: 'quote'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const shippingRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/shipping-options$/)
    if (request.method === 'POST' && shippingRoute) {
      try {
        const cartId = shippingRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion))
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            cartId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            destination: body.destination ?? null,
            expectedVersion: body.expectedVersion,
            idempotencyKey,
            now: serverNow(),
            token
          },
          type: 'shipping-options'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const orderRoute = url.pathname.match(/^\/api\/carts\/([^/]+)\/orders$/)
    if (request.method === 'POST' && orderRoute) {
      try {
        const cartId = orderRoute[1]!
        if (!UUID_PATTERN.test(cartId)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const token = bearerCartToken(request)
        if (!token) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const idempotencyKey = request.headers.get('idempotency-key')
        if (!idempotencyKey || idempotencyKey.length > 200)
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        const body = await readLimitedJson(request)
        if (!body) return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (
          typeof body.expectedVersion !== 'number' ||
          !Number.isSafeInteger(body.expectedVersion) ||
          typeof body.selectedOptionIndex !== 'number' ||
          !Number.isSafeInteger(body.selectedOptionIndex)
        )
          return noStoreJson({ error: { code: 'invalid_input' } }, 400)
        if (hasSessionCookie(request) && env.AUTH_ENABLED !== 'true')
          return noStoreJson({ error: { code: 'authentication_unavailable' } }, 503)
        const ownerSession = hasSessionCookie(request) ? await customerSession(request, env) : null
        if (hasSessionCookie(request) && !ownerSession) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        return await dispatchCartCommand(env, {
          cartId,
          commandId: idempotencyKey,
          payload: {
            consentPrivacy: body.consentPrivacy === true,
            consentTos: body.consentTos === true,
            contactEmail: String(body.contactEmail ?? ''),
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            buyerCompanyName: body.buyerCompanyName,
            buyerTaxId: body.buyerTaxId,
            correlationId: String(request.headers.get('x-correlation-id') ?? 'api').slice(0, 200),
            expectedVersion: body.expectedVersion,
            idempotencyKey,
            now: serverNow(),
            billingAddress: body.billingAddress ?? null,
            quoteId: String(body.quoteId ?? ''),
            selectedOptionHash: String(body.selectedOptionHash ?? ''),
            selectedOptionIndex: body.selectedOptionIndex,
            expectedTotalGrossCents: body.expectedTotalGrossCents,
            shippingAddress: body.shippingAddress ?? null,
            shippingQuoteId: String(body.shippingQuoteId ?? ''),
            token,
            ownerSession
          },
          type: 'checkout'
        })
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/orders') {
      try {
        const claims = await customerSession(request, env)
        const result = await listD1CustomerOrders(env.DB, claims, serverNow())
        return result ? noStoreJson(result, 200) : noStoreJson({ error: { code: 'unauthenticated' } }, 401)
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const customerOrderLinesRoute = url.pathname.match(/^\/api\/orders\/([^/]+)\/lines$/)
    if (request.method === 'GET' && customerOrderLinesRoute) {
      try {
        const claims = await customerSession(request, env)
        const result = await readD1CustomerOrderLines(env.DB, claims, customerOrderLinesRoute[1]!, serverNow())
        if (result.outcome === 'unauthenticated') return noStoreJson({ error: { code: 'unauthenticated' } }, 401)
        if (result.outcome === 'not_found') return noStoreJson({ error: { code: 'not_found' } }, 404)
        return noStoreJson(result.detail, 200)
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    const orderGetRoute = url.pathname.match(/^\/api\/orders\/([^/]+)$/)
    if (request.method === 'GET' && orderGetRoute) {
      try {
        if (!UUID_PATTERN.test(orderGetRoute[1]!)) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const match = (request.headers.get('authorization') ?? '').match(/^Order ([A-Za-z0-9_-]{43,86})$/)
        if (!match) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        const view = await getOrderView(env.DB, {
          orderId: orderGetRoute[1]!,
          token: match[1]!,
          now: serverNow()
        })
        // Unknown id and wrong token are indistinguishable.
        if (!view) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
        return noStoreJson(view, 200)
      } catch {
        return noStoreJson({ error: { code: 'internal' } }, 500)
      }
    }
    if (request.method !== 'GET' || url.pathname !== '/health') {
      return Response.json({ error: { code: 'not_found' } }, { status: 404 })
    }

    const health = await inspectCanaryBindings(env)
    return Response.json(health, {
      status: health.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' }
    })
  },

  async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
    const processedInBatch = new Set<string>()
    let bulkProcessed = 0
    await Promise.all(
      batch.messages.map(async (message) => {
        if (
          message.body &&
          typeof message.body === 'object' &&
          'type' in message.body &&
          message.body.type === 'admin.order-bulk.requested'
        ) {
          const parsed = parseAdminOrderBulkMessage(message.body)
          if (!parsed) {
            message.ack()
            return
          }
          try {
            if (bulkProcessed >= 1) {
              if (env.AUTH_ENABLED !== 'true') {
                message.retry({ delaySeconds: 60 })
                return
              }
              // Fresh continuation messages do not spend the transient retry
              // budget merely because another group occupied this invocation.
              // Acknowledge only after the obligation has been republished.
              await env.ASYNC_JOBS.send(parsed)
              message.ack()
              return
            }
            bulkProcessed++
            const result = await consumeAdminOrderBulkMessage(env.DB, parsed, {
              enabled: env.AUTH_ENABLED === 'true',
              now: serverNow(),
              queue: env.ASYNC_JOBS
            })
            if (result === 'completed' || result === 'requeued' || result === 'invalid') message.ack()
            else message.retry({ delaySeconds: 60 })
          } catch {
            message.retry({ delaySeconds: 60 })
          }
          return
        }
        if (
          message.body &&
          typeof message.body === 'object' &&
          'type' in message.body &&
          message.body.type === 'invoice.evaluate.requested'
        ) {
          try {
            const receipt = await receiveFiscalEvaluation(env.DB, message.body, serverNow())
            if (receipt === 'not_ready') message.retry({ delaySeconds: 60 })
            else if (receipt === 'invalid') message.ack()
            else {
              await runConfiguredFiscalRuntime(env)
              message.ack()
            }
          } catch {
            message.retry({ delaySeconds: 60 })
          }
          return
        }
        if (
          message.body &&
          typeof message.body === 'object' &&
          'type' in message.body &&
          message.body.type === 'email.dispatch.requested'
        ) {
          try {
            const receipt = await receiveEmailDispatch(env.DB, message.body, serverNow())
            if (receipt === 'not_ready') message.retry({ delaySeconds: 60 })
            else message.ack()
          } catch {
            message.retry({ delaySeconds: 60 })
          }
          return
        }
        const parsed = parseExpiryMessage(message.body)
        // Permanent malformations are acknowledged without retry loops; the
        // dead-letter queue plus max_retries bound everything transient.
        if (!parsed.ok) {
          console.log(JSON.stringify({ event: 'inventory.queue.permanent_skip' }))
          message.ack()
          return
        }
        if (processedInBatch.has(parsed.message.messageId)) {
          message.ack() // duplicate inside the same delivery batch: at-least-once, process once
          return
        }
        processedInBatch.add(parsed.message.messageId)
        try {
          await expireExpiredReservations(env.DB, {
            at: parsed.message.before,
            correlationId: parsed.message.correlationId
          })
          await compensateStaleAttempts(env.DB, { at: parsed.message.before })
          message.ack()
        } catch (error) {
          if (error instanceof InventoryError && error.code === 'invalid_input') {
            console.log(
              JSON.stringify({ event: 'inventory.queue.permanent_reject', messageId: parsed.message.messageId })
            )
            message.ack()
            return
          }
          console.log(
            JSON.stringify({
              event: 'inventory.queue.retry',
              messageId: parsed.message.messageId,
              attempt: message.attempts
            })
          )
          message.retry({ delaySeconds: Math.min(30 * 2 ** message.attempts, 300) })
        }
      })
    )
  }
} satisfies ExportedHandler<CloudflareEnv>
