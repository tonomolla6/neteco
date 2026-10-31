import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { splitDemoSql as splitSqlQuery } from './lib/d1-demo-sql'
import { issueD1SessionCookie } from '../workers/auth/session-cookie'
import {
  cartSnapshotCommandSchema,
  cartSnapshotIntentHash,
  cartSnapshotListSchema,
  cartSnapshotResponseSchema,
  cartSnapshotRevokeReceiptSchema,
  sharedCartResolveResponseSchema
} from '../shared/cart-snapshots'
import { inventoryAlertPolicyResponseSchema, inventoryAlertsResponseSchema } from '../shared/inventory-alerts'
import {
  auditNativeInventoryAlertsBrowser,
  INVENTORY_ALERTS_BROWSER_SCENARIOS
} from './lib/audit-native-inventory-alerts-browser'
import { auditNativeSatisfactionBrowser, SATISFACTION_BROWSER_SCENARIOS } from './lib/audit-native-satisfaction-browser'
import { customerSatisfactionSchema } from '../shared/support-satisfaction'
import { auditNativeOrderPackingBrowser, PACKING_BROWSER_SCENARIOS } from './lib/audit-native-order-packing-browser'
import { auditNativePromotionsBrowser, PROMOTIONS_BROWSER_SCENARIOS } from './lib/audit-native-promotions-browser'
import {
  auditNativeCartSnapshotsBrowser,
  CART_SNAPSHOTS_BROWSER_SCENARIOS
} from './lib/audit-native-cart-snapshots-browser'
import {
  auditNativeCatalogRelationsBrowser,
  CATALOG_RELATIONS_BROWSER_SCENARIOS
} from './lib/audit-native-catalog-relations-browser'
import {
  adminCatalogRelationsSchema,
  catalogRelationsReceiptSchema,
  catalogRelationsCommandSchema,
  catalogRelationsIntentHash,
  publicCatalogRelationsSchema
} from '../shared/catalog-relations'
import { promotionBasketPreviewResponseSchema } from '../shared/promotion-basket-preview'
import { auditNativeInventoryCountImport } from './lib/audit-native-inventory-count-import'
import {
  auditNativeInventoryCountImportBrowser,
  INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS,
  InventoryCountImportBrowserError
} from './lib/audit-native-inventory-count-import-browser'
import { createCart, quoteCart, setCartLine } from '../workers/catalog/cart'
import { adminOrderFulfillmentSchema, fulfillmentCommandReceiptSchema } from '../shared/order-fulfillment'
import { adminOrderPackingSchema } from '../shared/order-packing'
import { hashWorkerPassword } from '../workers/auth/password'
import { releaseReservation, reserveInventory } from '../workers/catalog/inventory'
import { decryptSecret } from '../server/utils/secrets'
import { safeMediaFilename } from '../shared/media-envelope'
import {
  catalogPolicyReceiptSchema,
  type CatalogPolicyReceipt,
  type CatalogPoliciesView,
  type ProductPublicationPolicyView
} from '../shared/catalog-publication-policy'
import { renderD1CategorySeed } from './lib/d1-category-seed'
import { renderD1ProductSeed } from './lib/d1-product-seed'
import { renderD1InventorySeed } from './lib/d1-inventory-seed'
import { renderD1ShippingSeed } from './lib/d1-shipping-seed'
import { auditNativeCheckoutPayment } from './lib/audit-native-checkout-payment'
import { encodeMerchantParameters, signMerchantParameters } from '../workers/payments/redsys'
import {
  adminOrderBulkCommandSchema,
  adminOrderBulkGroupSchema,
  adminOrderBulkIntentHash
} from '../shared/admin-order-bulk'
import { auditNativeCheckoutRecoveryBrowser } from './lib/audit-native-checkout-recovery-browser'
import {
  auditNativeCartAddRecoveryBrowser,
  CART_ADD_RECOVERY_BROWSER_SCENARIOS
} from './lib/audit-native-cart-add-recovery-browser'
import { auditNativeFulfillment } from './lib/audit-native-fulfillment'
import { auditNativeFiscal } from './lib/audit-native-fiscal'
import { auditNativeCmsDrafts } from './lib/audit-native-cms-drafts'
import { auditNativeCmsPublication } from './lib/audit-native-cms-publication'
import { auditNativeReturns } from './lib/audit-native-returns'
import { auditNativeFiscalRuntimeEmail } from './lib/audit-native-fiscal-runtime-email'
import { auditNativeRefundsCredit } from './lib/audit-native-refunds-credit'
import { auditNativeSupport } from './lib/audit-native-support'
import { auditNativeSupportMacros } from './lib/audit-native-support-macros'
import { auditNativeAdminGlobalSearch } from './lib/audit-native-admin-global-search'
import { auditNativeOrderTimeline } from './lib/audit-native-order-timeline'
import { auditNativeOrderCancellation, createNativeUnpaidOrder } from './lib/audit-native-order-cancellation'
import { prepareNativeAuditAdminMfa } from './lib/audit-native-admin-mfa'
import { auditNativeOrderExport, ORDER_EXPORT_NATIVE_SCENARIOS } from './lib/audit-native-order-export'
import { auditNativeOrderAnnotations, ORDER_ANNOTATIONS_NATIVE_SCENARIOS } from './lib/audit-native-order-annotations'
import { auditNativeOrderEmails, ORDER_EMAILS_NATIVE_SCENARIOS } from './lib/audit-native-order-emails'
import {
  auditNativeOrderOperationsBrowser,
  ORDER_OPERATIONS_BROWSER_SCENARIOS,
  OrderOperationsBrowserDiagnosticError
} from './lib/audit-native-order-operations-browser'
import {
  auditNativeOrderReturnsBrowser,
  OrderReturnsBrowserDiagnosticError,
  ORDER_RETURNS_BROWSER_SCENARIOS
} from './lib/audit-native-order-returns-browser'
import {
  auditNativeCompanyReviewBrowser,
  COMPANY_REVIEW_BROWSER_SCENARIOS
} from './lib/audit-native-company-review-browser'
import {
  auditNativeAccountSettingsBrowser,
  ACCOUNT_SETTINGS_BROWSER_SCENARIOS
} from './lib/audit-native-account-settings-browser'
import { auditNativeQuickOrderBrowser, QUICK_ORDER_BROWSER_SCENARIOS } from './lib/audit-native-quick-order-browser'
import { auditNativeGuestOrderBrowser, GUEST_ORDER_BROWSER_SCENARIOS } from './lib/audit-native-guest-order-browser'
import { customerOrderReturnsSchema } from '../shared/order-returns'
import { adminCapabilitiesSchema, canNavigateAdmin } from '../shared/admin-navigation'
import { adminActivityResponseSchema, ADMIN_ACTIVITY_DESTINATIONS } from '../shared/admin-activity'
import {
  searchSynonymPreviewSchema,
  searchSynonymReceiptSchema,
  searchSynonymListSchema
} from '../shared/search-synonyms'
import { cmsCommandReceiptSchema } from '../shared/cms-commands'
import { cmsPublicationReceiptSchema } from '../shared/cms-publication'
import { supportKnowledgeListSchema, supportKnowledgeFeedbackReceiptSchema } from '../shared/support-knowledge'
import { auditNativeNewsletterEditorial } from './lib/audit-native-newsletter-editorial'
import { auditNativeAnalytics } from './lib/audit-native-analytics'
import { auditNativeAnalyticsBrowser } from './lib/audit-native-analytics-browser'
import {
  auditNativeAdminNavigationBrowser,
  ADMIN_NAVIGATION_BROWSER_SCENARIOS
} from './lib/audit-native-admin-navigation-browser'
import { auditNativeEditorialImport } from './lib/audit-native-editorial-import'
import { auditNativeCatalogExport } from './lib/audit-native-catalog-export'
import { auditNativeCatalogImport } from './lib/audit-native-catalog-import'
import { auditNativeCatalogImportBrowser } from './lib/audit-native-catalog-import-browser'
import { auditNativeTypedAttributes } from './lib/audit-native-typed-attributes'
import { analyticsMeasurementPolicySchema } from '../shared/analytics-measurement'
import { configuredAnalyticsMeasurement, type AnalyticsRuntimeEnv } from '../workers/runtime/analytics-config'
import { projectAnalyticsCommerceFacts } from '../workers/analytics/commerce-projection'
import { dispatchAnalyticsRetention } from '../workers/analytics/retention'
import { dispatchFiscalRuntime } from '../workers/fiscal/runtime-dispatch'
import { readFiscalPolicy } from '../workers/fiscal/issuance'
import { dispatchD1Refunds } from '../workers/refunds/operations'
import { dispatchD1CreditNotes } from '../workers/fiscal/credit-notes'
import { readFinancialPolicy } from '../workers/refunds/policies'
import { capturedSource } from '../workers/refunds/source'
import {
  configuredRefundProvider,
  configuredCreditProvider,
  customerEmailRenderers,
  type CustomerOperationsEnv
} from '../workers/runtime/customer-operations-config'
import { SUPPORT_SCAN_AUDIENCE } from '../workers/runtime/support-adapters'
import { fiscalContractSchema } from '../shared/fiscal-issuance'
import { refundPolicyInputSchema } from '../shared/order-refunds'
import { creditPolicyInputSchema } from '../shared/fiscal-credit'
import { supportPolicySchema, supportReceiptSchema, supportCustomerTicketSchema } from '../shared/support-operations'
import { configuredFiscalProvider } from '../workers/runtime/operations-config'
import { createFiscalPdfStorage } from '../workers/runtime/fiscal-pdf-storage'
import {
  publishEmailOutbox,
  receiveEmailDispatch,
  type EmailDispatchMessage
} from '../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../workers/communications/transactional-email-delivery'
import { validateQuantity } from '../server/domain/money'
import { REDSYS_OFFICIAL_CONTRACT } from '../tests/fixtures/redsys-official'
import { provisionPublicationValidityFixture } from '../tests/support/publication-validity-fixture'
import { listPublishedProducts } from '../workers/catalog/products'
import { isD1CheckConstraintFailure } from '../workers/runtime/d1-errors'
import { publicationValidityExpression } from '../workers/catalog/publication-validity'
import { eligibleMediaEvidenceSql } from '../workers/media/evidence-sql'
import { eligibleMediaPublicationSql } from '../workers/media/governance'
import { catalogDraftAuthoringReceiptSchema } from '../shared/catalog-draft-authoring'
import { catalogCategoryReceiptSchema } from '../shared/catalog-category-commands'
import { catalogPriceListSchema, catalogPriceReceiptSchema } from '../shared/catalog-price-commands'
import {
  adminInventoryVariantSchema,
  adminInventoryVariantSearchSchema,
  inventoryCommandReceiptSchema
} from '../shared/inventory-commands'
import {
  catalogDraftAuthoringOptionsSchema,
  catalogDraftAuthoringSnapshotSchema
} from '../shared/catalog-draft-authoring-options'

/** Pure CLI gate. Unknown or repeated options never start workerd or a browser. */
export function parseNativeShopAuditOptions(args: string[]): { browserMode: 'required' | 'not-run' } {
  if (args.length === 0) return { browserMode: 'required' }
  if (args.length === 1 && args[0] === '--without-browser') return { browserMode: 'not-run' }
  throw new Error('Invalid audit options. Only --without-browser is supported; browser checks are required by default.')
}

/** Private audit transport only: dispatches into the unchanged compiled SHOP
 * Queue handler inside workerd, without a Node Fetcher proxy or core imports. */
export function nativeShopRuntimeOptions(
  shopOptions: Parameters<typeof convertV4MiniflareOptions>[0],
  secret: string
): ReturnType<typeof convertV4MiniflareOptions> {
  assert(!('workers' in shopOptions))
  assert(typeof shopOptions.name === 'string' && shopOptions.name.length > 0)
  assert(typeof secret === 'string' && secret.length >= 32 && secret.length <= 200)
  // Miniflare's assets proxy has no Queue handler. Use the identical compiled
  // module as a private plain-worker receiver, sharing the original bindings;
  // HTTP/assets and all durable class identities stay on the original worker.
  const queueWorkerName = shopOptions.assets ? `${shopOptions.name}-audit-queue` : shopOptions.name
  const queueOptions = shopOptions.assets
    ? {
        ...shopOptions,
        name: queueWorkerName,
        assets: undefined,
        routes: undefined,
        queueConsumers: undefined,
        unsafeDirectSockets: undefined,
        durableObjects: Object.fromEntries(
          Object.entries(shopOptions.durableObjects ?? {}).map(([name, binding]) => [
            name,
            typeof binding === 'string'
              ? { className: binding, scriptName: shopOptions.name }
              : { ...binding, scriptName: binding.scriptName ?? shopOptions.name }
          ])
        ),
        workflows: Object.fromEntries(
          Object.entries(shopOptions.workflows ?? {}).map(([name, binding]) => [
            name,
            { ...binding, scriptName: binding.scriptName ?? shopOptions.name }
          ])
        )
      }
    : shopOptions
  return convertV4MiniflareOptions({
    rootPath: shopOptions.rootPath,
    log: shopOptions.log,
    resourcePersistencePath: shopOptions.resourcePersistencePath,
    resourceTmpPath: shopOptions.resourceTmpPath,
    cf: shopOptions.cf,
    telemetry: shopOptions.telemetry,
    workers: [
      shopOptions,
      ...(queueOptions === shopOptions ? [] : [queueOptions]),
      {
        name: 'neteco-audit-bulk-transport',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['service_binding_extra_handlers'],
        serviceBindings: { SHOP: queueWorkerName },
        bindings: { TRANSPORT_SECRET: secret },
        routes: ['https://bulk-transport.neteco.test/*'],
        outboundService: () => new Response('Outbound forbidden', { status: 503 }),
        script: `export default { async fetch(request,env) {
        const response=(status,body)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','referrer-policy':'no-referrer'}});
        const url=new URL(request.url);
        if(url.origin!=='https://bulk-transport.neteco.test'||url.pathname!=='/consume'||url.search)return response(404,{error:'not_found'});
        if(request.method!=='POST')return response(405,{error:'method_not_allowed'});
        if(request.headers.get('x-neteco-audit-transport')!==env.TRANSPORT_SECRET)return response(401,{error:'unauthorized'});
        if(Number(request.headers.get('content-length'))>4096)return response(413,{error:'body_too_large'});
        if(!/^application\\/json(?:\\s*;|$)/i.test(request.headers.get('content-type')||''))return response(400,{error:'invalid_input'});
        let body;
        try {
          const reader=request.body?.getReader();if(!reader)return response(400,{error:'invalid_input'});
          const chunks=[];let size=0;
          for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();return response(413,{error:'body_too_large'});}chunks.push(part.value);}
          const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
          body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        } catch {return response(400,{error:'invalid_input'});}
        const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==3||body.type!=='admin.order-bulk.requested'||typeof body.groupId!=='string'||!uuid.test(body.groupId)||typeof body.dispatchId!=='string'||!uuid.test(body.dispatchId))return response(400,{error:'invalid_input'});
        try {
          const result=await env.SHOP.queue('shop-audit-jobs',[{id:crypto.randomUUID(),timestamp:new Date(),body,attempts:1}]);
          if(!result||typeof result.outcome!=='string'||typeof result.ackAll!=='boolean'||!result.retryBatch||typeof result.retryBatch.retry!=='boolean'||!Array.isArray(result.retryMessages)||!Array.isArray(result.explicitAcks))return response(503,{error:'unconfirmed_transport'});
          return response(200,{outcome:result.outcome==='ok'?'ok':'exception',ackAll:result.ackAll,retryBatch:result.retryBatch.retry,retryMessages:result.retryMessages.length,explicitAcks:result.explicitAcks.length});
        } catch {return response(503,{error:'transport_unavailable'});}
      }};`
      }
    ]
  })
}

/** Real workerd + real D1 + the generated Nitro renderer. No deployment, remote
 * binding, shared .wrangler state, persistent account or delivery provider. */
const origin = 'https://shop-audit.neteco.test'
const scriptPath = resolve('.wrangler/shop-bundle/shop.js')
const assetsDirectory = resolve('.output-cloudflare/public')
const cookieConfiguration = { password: randomBytes(48).toString('base64url'), maxAgeSeconds: 3600 }
const lifecycleEncryptionKey = randomBytes(32).toString('base64')
const mediaScanSecret = randomBytes(48).toString('base64url')
// Dedicated disposable sealing authority, never reused as a session/scan key.
const cmsPreviewSecret = randomBytes(48).toString('base64url')
const supportScanSecret = randomBytes(48).toString('base64url')
const newsletterHmacKey = randomBytes(32)
const newsletterFeedbackSecret = randomBytes(48).toString('base64url')
const queueTransportSecret = randomBytes(48).toString('base64url')
let scenario = 'build_artifacts'
let completed = 0
let outgoingRequests = 0
let runtime: Miniflare | undefined
let temporaryDirectory: string | undefined
let nativeBrowserMode: 'required' | 'not-run' = 'required'

try {
  scenario = 'cli_options'
  nativeBrowserMode = parseNativeShopAuditOptions(process.argv.slice(2)).browserMode
  scenario = 'build_artifacts'
  await Promise.all([access(scriptPath), access(assetsDirectory)])
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'neteco-shop-workerd-audit-'))
  scenario = 'workerd_start'
  const auditOptions: Parameters<typeof convertV4MiniflareOptions>[0] = {
    name: 'neteco-shop-local-audit',
    rootPath: process.cwd(),
    scriptPath,
    modules: true,
    compatibilityDate: '2026-08-15',
    compatibilityFlags: ['nodejs_compat'],
    log: new NoOpLog(),
    resourcePersistencePath: temporaryDirectory,
    resourceTmpPath: join(temporaryDirectory, 'runtime-tmp'),
    cf: false,
    telemetry: { enabled: false },
    bindings: {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      ANALYTICS_ENABLED: 'false',
      ANALYTICS_PROJECTION_ENABLED: 'false',
      ANALYTICS_RETENTION_ENABLED: 'false',
      ANALYTICS_POLICY: 'null',
      AUTH_EMAIL_ENABLED: 'false',
      AUTH_EMAIL_FROM: 'orders@neteco.es',
      AUTH_ORIGIN: origin,
      PUBLIC_SITE_ORIGIN: origin,
      AUTH_TOKEN_PEPPER: randomBytes(48).toString('base64url'),
      AUTH_RATE_LIMIT_PEPPER: randomBytes(48).toString('base64url'),
      AUTH_ENCRYPTION_KEY: lifecycleEncryptionKey,
      NUXT_SESSION_PASSWORD: cookieConfiguration.password,
      MEDIA_ADMIN_ENABLED: 'true',
      MEDIA_ADMIN_ORIGIN: origin,
      MEDIA_PUBLIC_ENABLED: 'true',
      MEDIA_SCAN_SECRET: mediaScanSecret,
      CMS_PUBLICATION_ENABLED: 'true',
      CMS_PREVIEW_ENABLED: 'true',
      CMS_PREVIEW_SECRET: cmsPreviewSecret,
      // HTTP can select the strictly local fake adapter, but the actual
      // scheduled/Queue executor and all email providers remain disabled.
      FISCAL_LOCAL_VALIDATION_ENABLED: 'true',
      FISCAL_ISSUANCE_ENABLED: 'false',
      FISCAL_POLICY_IDS: '[]',
      BEPLY_ENABLED: 'false',
      // Published, non-secret sandbox vectors; all outbound fetch is rejected.
      // This only signs local callbacks, never submits a bank transaction.
      REDSYS_ENABLED: 'true',
      REDSYS_ENVIRONMENT: 'sandbox',
      REDSYS_SECRET_KEY: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
      REDSYS_MERCHANT_CODE: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      REDSYS_TERMINAL: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      REDSYS_BIZUM_ENABLED: 'false',
      PAYMENT_PUBLIC_BASE_URL: origin,
      NEWSLETTER_ENABLED: 'false',
      // New namespaces are tested OFF before a later disposable-only reload.
      // No shared vars, production flags or actual provider credentials change.
      REFUNDS_ENABLED: 'false',
      REFUND_DISPATCH_ENABLED: 'false',
      REFUND_LOCAL_VALIDATION_ENABLED: 'false',
      REFUND_POLICY_IDS: '[]',
      CREDIT_DISPATCH_ENABLED: 'false',
      CREDIT_LOCAL_VALIDATION_ENABLED: 'false',
      CREDIT_POLICY_IDS: '[]',
      SUPPORT_ENABLED: 'false',
      SUPPORT_ATTACHMENTS_ENABLED: 'false',
      SUPPORT_TURNSTILE_ENABLED: 'false',
      NEWSLETTER_EDITORIAL_ENABLED: 'false',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'false',
      NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'false',
      NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '[]',
      NEWSLETTER_FEEDBACK_ENABLED: 'false',
      TRANSACTIONAL_EMAIL_RENDERER_KEYS: '[]',
      TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED: 'false',
      TRANSACTIONAL_EMAIL_ENABLED: 'false',
      INVOICE_EMAIL_ENABLED: 'false',
      INVOICE_VALIDATION_EMAIL_ENABLED: 'false',
      FREE_SHIPPING_THRESHOLD_CENTS: '15000',
      NUXT_PUBLIC_BASE_URL: origin
    },
    d1Databases: { DB: '00000000-0000-0000-0000-000000000000' },
    kvNamespaces: { CACHE: 'shop-audit-cache' },
    r2Buckets: { MEDIA: 'shop-audit-media' },
    // Miniflare uses its installed local decoder, not the remote Images API.
    images: { binding: 'IMAGES' },
    queueProducers: { ASYNC_JOBS: 'shop-audit-jobs' },
    durableObjects: {
      COORDINATOR: { className: 'CanaryCoordinator', useSQLite: true },
      INVENTORY: { className: 'InventoryCoordinator', useSQLite: true },
      CARTS: { className: 'CartCoordinator', useSQLite: true }
    },
    workflows: { CATALOG_WORKFLOW: { className: 'CanaryWorkflow', name: 'shop-audit-catalog' } },
    ratelimits: {
      AUTH_EDGE_LIMIT: { namespace_id: '990001', simple: { limit: 10000, period: 60 } },
      ADMIN_EDGE_LIMIT: { namespace_id: '990002', simple: { limit: 10000, period: 60 } },
      CART_EDGE_LIMIT: { namespace_id: '990003', simple: { limit: 10000, period: 60 } },
      ANALYTICS_EDGE_LIMIT: { namespace_id: '990004', simple: { limit: 10000, period: 60 } }
    },
    assets: {
      directory: assetsDirectory,
      binding: 'ASSETS',
      run_worker_first: true,
      // Miniflare v5's V4 adapter does not infer this from scriptPath. Without
      // it, its asset router returns 500 before invoking the actual Worker.
      routerConfig: { has_user_worker: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' }
    },
    outboundService: () => {
      outgoingRequests++
      return new Response('External network is disabled in this audit', { status: 503 })
    }
  }
  runtime = new Miniflare(nativeShopRuntimeOptions(auditOptions, queueTransportSecret))
  await runtime.ready
  let localBindings = await runtime.getBindings<Pick<CloudflareEnv, 'DB' | 'MEDIA' | 'IMAGES'>>()
  let database = localBindings.DB

  async function applySql(sql: string) {
    const statements = splitSqlQuery(sql).filter(
      (statement) => !/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;?\s*$/i.test(statement)
    )
    // The maintained Wrangler parser preserves trigger bodies, literals and
    // comments; splitting at semicolons would silently destroy this schema.
    for (let index = 0; index < statements.length; index += 75) {
      const results = await database.batch(
        statements.slice(index, index + 75).map((statement) => database.prepare(statement))
      )
      assert(
        results.every((result) => result.success),
        'SQL initialization failed'
      )
    }
  }

  scenario = 'all_migrations'
  const migrationsDirectory = resolve('db/d1/migrations')
  const migrations = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  assert(migrations.length > 0)
  assert(migrations.includes('0035_catalog_product_status.sql'))
  assert(migrations.includes('0036_catalog_publication_policy.sql'))
  assert(migrations.includes('0037_catalog_policy_commands.sql'))
  assert(migrations.includes('0038_catalog_draft_authoring.sql'))
  assert(migrations.includes('0039_catalog_price_commands.sql'))
  assert(migrations.includes('0040_catalog_category_commands.sql'))
  assert(migrations.includes('0041_admin_inventory_commands.sql'))
  assert(migrations.includes('0042_fiscal_issuance.sql'))
  assert(migrations.includes('0043_order_fulfillment.sql'))
  assert(migrations.includes('0044_cms_draft_commands.sql'))
  assert(migrations.includes('0045_cms_publication.sql'))
  assert(migrations.includes('0046_order_returns.sql'))
  assert(migrations.includes('0047_fiscal_runtime_email_manifest.sql'))
  assert(migrations.includes('0048_order_refunds_credit_notes.sql'))
  assert(migrations.includes('0049_support_operations.sql'))
  assert(migrations.includes('0050_newsletter_editorial.sql'))
  assert(migrations.includes('0051_newsletter_local_validation.sql'))
  assert(migrations.includes('0052_analytics_measurement.sql'))
  assert(migrations.includes('0053_catalog_editorial_import.sql'))
  assert(migrations.includes('0054_catalog_native_import.sql'))
  assert(migrations.includes('0055_catalog_import_jobs.sql'))
  assert(migrations.includes('0056_catalog_color_pattern.sql'))
  assert(migrations.includes('0057_catalog_import_job_commands.sql'))
  assert(migrations.includes('0058_catalog_typed_attributes.sql'))
  assert(migrations.includes('0059_catalog_typed_attribute_values.sql'))
  assert(migrations.includes('0060_support_macros.sql'))
  assert(migrations.includes('0061_search_synonyms.sql'))
  assert(migrations.includes('0091_search_merchandising_rules.sql'))
  assert(migrations.includes('0062_support_knowledge_feedback.sql'))
  assert(migrations.includes('0063_order_annotations.sql'))
  assert(migrations.includes('0064_company_admin_review.sql'))
  assert(migrations.includes('0065_account_privacy.sql'))
  assert(migrations.includes('0066_account_preferences.sql'))
  assert(migrations.includes('0067_inventory_alerts.sql'))
  assert(migrations.includes('0068_support_satisfaction.sql'))
  assert(migrations.includes('0069_order_packing.sql'))
  assert(migrations.includes('0070_delivery_preferences.sql'))
  assert(migrations.includes('0071_account_security_notices.sql'))
  assert(migrations.includes('0072_promotions.sql'))
  assert(migrations.includes('0073_promotion_admin_commands.sql'))
  assert(migrations.includes('0074_order_purchase_reference.sql'))
  assert(migrations.includes('0075_cart_snapshots.sql'))
  assert(migrations.includes('0076_catalog_relations.sql'))
  assert(migrations.includes('0077_inventory_count_imports.sql'))
  assert(migrations.includes('0078_shipping_calendars.sql'))
  assert(migrations.includes('0079_support_escalations.sql'))
  assert(migrations.includes('0080_communication_history_commands.sql'))
  assert(migrations.includes('0081_promotional_analytics.sql'))
  assert(migrations.includes('0082_admin_invitations.sql'))
  assert(migrations.includes('0083_admin_bootstrap.sql'))
  assert(migrations.includes('0084_admin_audit.sql'))
  assert(migrations.includes('0085_admin_order_views.sql'))
  assert(migrations.includes('0086_admin_order_bulk.sql'))
  assert(migrations.includes('0087_product_watch.sql'))
  assert(migrations.includes('0088_product_contributions.sql'))
  assert(migrations.includes('0089_sales_quotes.sql'))
  assert(migrations.includes('0090_cart_recovery.sql'))
  assert(migrations.includes('0097_carrier_resilience.sql'))
  assert(migrations.includes('0098_delivery_surveys.sql'))
  assert(migrations.includes('0099_analytics_cohorts.sql'))
  assert(migrations.includes('0100_csp_violation_reports.sql'))
  assert(migrations.includes('0102_support_live_chat_and_account_managers.sql'))
  assert(migrations.includes('0103_payment_funnel.sql'))
  assert(migrations.includes('0104_semantic_search_and_rerank.sql'))
  assert(migrations.includes('0106_inventory_lots_costing_forecast.sql'))
  assert(migrations.includes('0107_marketing_automations.sql'))
  assert(migrations.includes('0108_b2b_shared_lists_edi_scoring.sql'))
  assert(migrations.includes('0109_shipping_convenience_conditions_routes.sql'))
  assert(migrations.includes('0110_rca_copilot_audiences.sql'))
  assert(migrations.includes('0111_experiments_ab_testing.sql'))
  assert(migrations.includes('0112_bundles_referrals_events.sql'))
  assert(migrations.includes('0113_product_reviews_qa_and_media_guides.sql'))
  assert(migrations.includes('0114_security_keys_devices_abuse.sql'))
  assert(migrations.includes('0115_growth_offers.sql'))
  assert(migrations.includes('0116_observability_sre_capacity_slo.sql'))
  assert(migrations.includes('0117_seo_technical_bot_logs_ai_search.sql'))
  assert(migrations.includes('0119_ai_assistant_enrichment.sql'))
  assert(migrations.includes('0120_market_catalog_international_shipping.sql'))
  assert(migrations.includes('0122_operational_alerts_send_time_warehouse_telemetry.sql'))
  assert(migrations.includes('0123_seo_b2b_metrics_cost_to_serve.sql'))
  assert(migrations.includes('0124_ugc_reviews_customer_success_cases.sql'))
  assert(migrations.includes('0125_learning_campaigns_recurring_incentives.sql'))
  assert(migrations.includes('0127_predictive_personalization_campaign_eval.sql'))
  assert(migrations.includes('0128_aiops_third_party_b2b_cache_edge_personalization.sql'))
  assert(migrations.includes('0129_delivery_app_carrier_manifests_packing_optimizer.sql'))
  assert(migrations.includes('0130_connector_marketplace.sql'))
  assert(migrations.includes('0131_preview_diff_role_dashboards_campaign_manager.sql'))
  assert(migrations.includes('0132_editorial_seo_commercial_warehouse_scan.sql'))
  assert(migrations.includes('0133_supplier_feed_editorial_sourcing_draft_orders.sql'))
  assert(migrations.includes('0134_release_gates_progressive_rollout_policy_campaigns.sql'))
  assert(migrations.includes('0135_multichannel_orchestration_notification_center.sql'))
  assert(migrations.includes('0136_account_lifecycle_preference_center_impersonation.sql'))
  assert(migrations.includes('0137_crm_automation_metrics_and_anomaly_detection.sql'))
  assert(migrations.includes('0138_integration_sandbox_faults_webhooks.sql'))
  assert(migrations.includes('0139_inventory_commitments_picking_purchasing.sql'))
  assert(migrations.includes('0140_reorder_barcode_cycle_counts.sql'))
  assert(migrations.includes('0141_templates_brand_warehouse_adr.sql'))
  assert(migrations.includes('0142_browse_recovery_welcome_coupon_recommendations.sql'))
  assert(migrations.includes('0143_seasonal_sector_campaigns.sql'))
  assert(migrations.includes('0144_game_day_and_marketing_automation_observability.sql'))
  assert(migrations.includes('0148_pricing_auto_discounts_credit_deposits.sql'))
  assert(migrations.includes('0149_category_merchandising_promo_fraud.sql'))
  assert(migrations.includes('0150_search_gap_programme.sql'))
  assert(migrations.includes('0151_content_governance.sql'))
  assert(migrations.includes('0152_international_seo_channel_feeds_adr_lq.sql'))
  assert(migrations.includes('0153_support_assistant_insights_b2b_portal.sql'))
  assert(migrations.length >= 117, 'Native shop audit requires the complete migration set')
  for (const migration of migrations) {
    scenario = `migration_${migration.replace(/\.sql$/, '')}`
    await applySql(await readFile(join(migrationsDirectory, migration), 'utf8'))
  }
  completed++

  scenario = 'real_d1_check_constraint_classification'
  let constraintError: unknown
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO carts(id,token_hash,status,version,expires_at,correlation_id,created_at,updated_at)
          VALUES ('audit-impossible-cart',?,'guard-impossible',1,'2026-01-02T00:00:00Z',
            'synthetic-constraint-audit','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`
        )
        .bind('0'.repeat(64))
    ])
  } catch (error) {
    constraintError = error
  }
  assert(isD1CheckConstraintFailure(constraintError))
  assert.equal(
    (await database.prepare("SELECT count(*) AS n FROM carts WHERE id='audit-impossible-cart'").first<{ n: number }>())
      ?.n,
    0
  )
  completed++

  scenario = 'deterministic_catalog_inventory_shipping_seeds'
  for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed]) {
    await applySql(render())
  }
  completed++

  const fetch = (path: string, cookie?: string, navigationHeaders: Record<string, string> = {}) =>
    runtime!.dispatchFetch(`${origin}${path}`, {
      headers: { 'cf-connecting-ip': '192.0.2.123', ...(cookie ? { cookie } : {}), ...navigationHeaders },
      redirect: 'manual'
    })
  async function json<T>(path: string, cookie?: string): Promise<T> {
    const response = await fetch(path, cookie)
    if (response.status !== 200 && !cookie && completed < 4) {
      const body = await response.clone().text()
      const code = body.includes('Fetch for user worker without having a user worker binding')
        ? 'asset_router_missing_user_worker'
        : 'unexpected_startup_response'
      console.error(JSON.stringify({ audit: 'cloudflare-shop-local', diagnostic: code, status: response.status }))
    }
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/i)
    return response.json() as Promise<T>
  }
  const post = (path: string, body: Record<string, unknown>, cookie?: string) =>
    runtime!.dispatchFetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'cf-connecting-ip': '192.0.2.123',
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify(body),
      redirect: 'manual'
    })
  const adminOperation = (path: string, method: string, body: unknown, cookie: string, key: string) =>
    runtime!.dispatchFetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.123'
      },
      body: JSON.stringify(body),
      redirect: 'manual'
    })
  function renderedMarkup(body: string) {
    // A name only present in Nuxt's JSON hydration payload is not SSR evidence.
    return body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  }
  async function html(path: string, text: string, cookie?: string, navigationHeaders?: Record<string, string>) {
    const response = await fetch(path, cookie, navigationHeaders)
    if (response.status !== 200)
      console.error(
        JSON.stringify({
          audit: 'cloudflare-shop-local',
          diagnostic: 'unexpected_ssr_status',
          scenario,
          status: response.status
        })
      )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/i)
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    assert.match(response.headers.get('vary') ?? '', /cookie/i)
    const body = await response.text()
    if (!renderedMarkup(body).includes(text))
      console.error(
        JSON.stringify({
          audit: 'cloudflare-shop-local',
          diagnostic: 'expected_ssr_content_missing',
          scenario,
          hydrationOnly: body.includes(text),
          errorPage: body.includes('nuxt-error-page')
        })
      )
    assert(renderedMarkup(body).includes(text))
    assert(!body.includes('nuxt-error-page'))
    if (cookie) {
      assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/)
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    }
    return body
  }

  scenario = 'seed_is_not_publication_authority'
  for (const [boundary, statement] of [
    [
      'private_evidence',
      database.prepare(eligibleMediaEvidenceSql()).bind(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'))
    ],
    [
      'current_validity',
      database.prepare(`SELECT ${publicationValidityExpression('p')} AS valid FROM products p LIMIT 1`)
    ],
    ['public_media', database.prepare(eligibleMediaPublicationSql()).bind(null)]
  ] as const) {
    scenario = `seed_publication_boundary_${boundary}`
    try {
      await statement.all()
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      const diagnostic =
        [
          'expression tree is too large',
          'parser stack overflow',
          'no such column',
          'no such table',
          'syntax error',
          'wrong number',
          'incorrect number'
        ].find((code) => message.includes(code)) ?? 'unknown_query_failure'
      const maximumDepth = message.match(/maximum depth (\d+)/)?.[1]
      console.error(JSON.stringify({ audit: 'cloudflare-shop-local', boundary, diagnostic, maximumDepth }))
      throw error
    }
  }
  scenario = 'seed_is_not_publication_authority'
  try {
    const direct = await listPublishedProducts(database, { page: 1, limit: 24, sort: 'default' })
    assert.equal(direct?.total, 0)
  } catch (error) {
    const messages = [error, error instanceof Error ? error.cause : undefined]
      .filter((item): item is Error => item instanceof Error)
      .map((item) => item.message.toLowerCase())
    const diagnostic =
      [
        'parser stack overflow',
        'expression tree is too large',
        'too many',
        'no such column',
        'no such table',
        'ambiguous',
        'syntax error',
        'not authorized',
        'd1_error'
      ].find((code) => messages.some((message) => message.includes(code))) ?? 'unknown_d1_read_failure'
    console.error(JSON.stringify({ audit: 'cloudflare-shop-local', diagnostic }))
    throw error
  }
  const unapprovedSeed = await json<{ items: unknown[]; total: number }>('/api/products')
  assert.equal(unapprovedSeed.total, 0)
  assert.deepEqual(unapprovedSeed.items, [])
  completed++

  scenario = 'explicit_disposable_catalog_authority_and_owned_r2_original'
  // Seed data is not legal acceptance. Explicit synthetic reviewer/scanner
  // fixtures exist only in this disposable local audit, with genuinely owned
  // R2 bytes; they never enter generated demo seeds or deployed resources.
  const fixtureProducts = (
    await database.prepare("SELECT id FROM products WHERE status='published' ORDER BY id").all<{ id: string }>()
  ).results
  assert.equal(fixtureProducts.length, 20)
  const bootstrapNow = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const bootstrapExpiry = new Date(Date.parse(bootstrapNow) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const bootstrapEvidence = await provisionPublicationValidityFixture(database, {
    productIds: fixtureProducts.map((product) => product.id),
    now: bootstrapNow,
    media: false
  })
  const bootstrapPolicy = await database
    .prepare('SELECT actor_id FROM catalog_publication_policies WHERE id=?')
    .bind(bootstrapEvidence.policyId)
    .first<{ actor_id: string }>()
  assert(bootstrapPolicy)
  const { default: bootstrapSharp } = await import('sharp')
  const bootstrapImage = await bootstrapSharp({
    create: {
      width: 600,
      height: 600,
      channels: 3,
      background: '#009ac9'
    }
  })
    .png()
    .toBuffer()
  const bootstrapHash = createHash('sha256').update(bootstrapImage).digest('hex')
  const bootstrapUploadId = randomUUID(),
    bootstrapScanId = randomUUID(),
    bootstrapRightsId = randomUUID()
  const bootstrapKey = `quarantine/${bootstrapUploadId}/${bootstrapHash}`
  const bootstrapObject = await localBindings.MEDIA.put(bootstrapKey, bootstrapImage)
  assert(bootstrapObject)
  await database.batch([
    database
      .prepare(
        `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,
      filename,content_type,byte_size,width,height,alt,rights_owner,rights_license,rights_source,
      storage_status,r2_etag,created_at,stored_at)
      VALUES (?,?,?,?,?,?,'disposable-audit.png','image/png',?,600,600,'Synthetic disposable catalog image',
        'Local synthetic owner','Synthetic audit only, not legal acceptance','Local disposable audit',
        'quarantined',?,?,?)`
      )
      .bind(
        bootstrapUploadId,
        bootstrapPolicy.actor_id,
        bootstrapUploadId,
        bootstrapHash,
        bootstrapHash,
        bootstrapKey,
        bootstrapImage.byteLength,
        bootstrapObject.etag,
        bootstrapNow,
        bootstrapNow
      ),
    database
      .prepare(
        `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,
      scanner_version,scanned_at,expires_at,received_at,payload_hash)
      VALUES (?,?,?,?,?,'clean','Synthetic audit, not a production antivirus',?,?,?,?)`
      )
      .bind(
        bootstrapScanId,
        bootstrapUploadId,
        bootstrapHash,
        bootstrapKey,
        bootstrapImage.byteLength,
        bootstrapNow,
        bootstrapExpiry,
        bootstrapNow,
        bootstrapHash
      ),
    database
      .prepare(
        `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,
      evidence_reference,rights_owner,rights_license,created_at,idempotency_key,payload_hash)
      VALUES (?,?,'approved','Synthetic local-only reviewer fixture',?,?,'Local disposable audit',
        'Local synthetic owner','Synthetic audit only, not legal acceptance',?,?,?)`
      )
      .bind(
        bootstrapRightsId,
        bootstrapUploadId,
        bootstrapPolicy.actor_id,
        bootstrapNow.slice(0, 10),
        bootstrapNow,
        bootstrapRightsId,
        bootstrapHash
      ),
    ...fixtureProducts.map((product) => {
      const id = randomUUID()
      return database
        .prepare(
          `INSERT INTO product_media_publications(id,product_id,upload_id,role,title,alt,language,version,
        valid_from,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
        VALUES (?,?,?,'main','Synthetic audit image','Synthetic disposable catalog image','es','synthetic-audit',?,?,?,?,?,?,?)`
        )
        .bind(
          id,
          product.id,
          bootstrapUploadId,
          bootstrapNow,
          bootstrapScanId,
          bootstrapRightsId,
          bootstrapPolicy.actor_id,
          bootstrapNow,
          id,
          bootstrapHash
        )
    })
  ])
  completed++

  scenario = 'd1_catalog_categories'
  const categories = await json<{ roots: unknown[] }>('/api/categories')
  assert(categories.roots.length > 0)
  completed++

  scenario = 'd1_catalog_products'
  const products = await json<{ items: Array<{ slug: string; name: string }> }>('/api/products')
  assert(products.items.length > 0)
  const firstProduct = products.items[0]!
  completed++

  scenario = 'real_d1_fifty_value_multiselects_without_parameter_overflow'
  const filterBrand = await database
    .prepare('SELECT b.name FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.slug=?')
    .bind(firstProduct.slug)
    .first<{ name: string }>()
  assert(filterBrand)
  const candidates = Array.from({ length: 49 }, (_, index) => `SyntheticAbsent${index}`)
  const fiftyBrands = [...candidates, filterBrand.name].join(',')
  const selectedByFiftieth = await json<{ items: Array<{ slug: string }>; total: number }>(
    `/api/products?${new URLSearchParams({ brand: fiftyBrands, limit: '50' })}`
  )
  assert(selectedByFiftieth.total > 0)
  assert(selectedByFiftieth.items.some((product) => product.slug === firstProduct.slug))
  const fifty = Array.from(
    { length: 50 },
    (_, index) => `Absent${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`
  )
  const combinedFilters = new URLSearchParams({
    brand: fifty.join(','),
    badge: fifty.join(','),
    envase: fifty.join(','),
    talla: fifty.join(','),
    capacidad: fifty.map((name) => `1-${name}`).join(','),
    color: fifty.join(','),
    medida: fifty.join('|'),
    acabado: fifty.join(','),
    facets: '1'
  })
  const emptyCombined = await json<{ items: unknown[]; total: number }>(`/api/products?${combinedFilters}`)
  assert.equal(emptyCombined.total, 0)
  assert.deepEqual(emptyCombined.items, [])
  completed++

  scenario = 'continuous_policy_expiry_denies_catalog_seo_and_media'
  const temporalProduct = await database
    .prepare('SELECT id FROM products WHERE slug=?')
    .bind(firstProduct.slug)
    .first<{ id: string }>()
  assert(temporalProduct)
  const temporalImage = await database
    .prepare("SELECT id FROM product_media_publications WHERE product_id=? AND role='main' LIMIT 1")
    .bind(temporalProduct.id)
    .first<{ id: string }>()
  assert(temporalImage)
  await provisionPublicationValidityFixture(database, {
    productIds: [temporalProduct.id],
    now: '2026-01-01T00:00:00Z',
    validUntil: '2026-08-26T00:00:00Z',
    media: false
  })
  assert.equal((await fetch(`/api/products/${firstProduct.slug}`)).status, 404)
  const currentList = await json<{ items: Array<{ slug: string }>; total: number }>('/api/products?limit=100')
  assert.equal(currentList.total, 19)
  assert(!currentList.items.some((product) => product.slug === firstProduct.slug))
  assert(!(await (await fetch('/sitemaps/products.xml')).text()).includes(`/producto/${firstProduct.slug}`))
  const expiredBytes = await fetch(`/media/${temporalImage.id}/image?w=400&format=jpeg`)
  assert.equal(expiredBytes.status, 404)
  assert.match(expiredBytes.headers.get('cache-control') ?? '', /no-store/)
  // Restoring the explicitly reviewed fixture appends a new immutable
  // assignment; it never deletes the failed historical policy or its record.
  await database
    .prepare(
      `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
    VALUES (?,?,?,?,'Synthetic local-only restored reviewed fixture',?)`
    )
    .bind(randomUUID(), temporalProduct.id, bootstrapEvidence.policyId, bootstrapPolicy.actor_id, bootstrapNow)
    .run()
  assert.equal((await fetch(`/api/products/${firstProduct.slug}`)).status, 200)
  assert.equal((await json<{ total: number }>('/api/products')).total, 20)
  completed++

  scenario = 'real_home_ssr_from_d1'
  // All first-page products need not be featured; read the home subset directly
  // from authoritative D1 API, then require at least one actual product in SSR.
  const featured = await json<{ items: Array<{ name: string }> }>('/api/products?featured=1&limit=4')
  const featuredName = featured.items[0]?.name ?? firstProduct.name
  const home = await html('/', featuredName)
  completed++

  scenario = 'real_catalog_ssr_from_d1'
  await html('/catalogo', firstProduct.name)
  completed++

  scenario = 'real_product_detail_ssr_from_d1'
  await html(`/producto/${firstProduct.slug}`, firstProduct.name)
  completed++

  scenario = 'generated_css_and_js_assets'
  const paths = [...home.matchAll(/(?:href|src)=["'](\/_nuxt\/[^"']+\.(?:css|js)(?:\?[^"']*)?)["']/g)].map(
    (match) => match[1]!
  )
  const css = paths.find((path) => /\.css(?:\?|$)/.test(path))
  const js = paths.find((path) => /\.js(?:\?|$)/.test(path))
  assert(css && js)
  for (const [path, mime] of [
    [css, /text\/css/i],
    [js, /(?:javascript|ecmascript)/i]
  ] as const) {
    const response = await fetch(path)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', mime)
    assert((await response.arrayBuffer()).byteLength > 0)
  }
  completed++

  scenario = 'd1_public_search'
  const query = firstProduct.name.split(/\s+/)[0]!
  const search = await json<{ items: Array<{ slug: string }> }>(`/api/search?q=${encodeURIComponent(query)}`)
  assert(search.items.some((item) => item.slug === firstProduct.slug))
  completed++

  scenario = 'd1_seo_ingress_nonproduction'
  const robots = await fetch('/robots.txt')
  assert.equal(robots.status, 200)
  assert.match(robots.headers.get('content-type') ?? '', /text\/plain/)
  assert.match(robots.headers.get('x-robots-tag') ?? '', /noindex/)
  assert((await robots.text()).includes('Disallow: /'))
  const sitemap = await fetch('/sitemap.xml')
  assert.equal(sitemap.status, 200)
  assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/)
  assert.match(sitemap.headers.get('cache-control') ?? '', /no-store/)
  const sitemapBody = await sitemap.text()
  assert(sitemapBody.includes(`${origin}/sitemaps/products.xml`))
  assert(!sitemapBody.includes('<html'))
  const productSitemap = await fetch('/sitemaps/products.xml')
  assert.equal(productSitemap.status, 200)
  assert((await productSitemap.text()).includes(`${origin}/producto/${firstProduct.slug}`))
  completed++

  scenario = 'no_legacy_api_fallback'
  // Owned OFF routes must still be claimed by the native router. A renderer,
  // legacy support endpoint or 404 fallback must not bypass the feature gate.
  for (const path of [
    '/api/support',
    '/api/support/options',
    '/api/admin/support',
    '/api/account/support',
    '/api/admin/refunds',
    '/api/analytics/events',
    '/api/admin/analytics',
    '/api/admin/analytics/reconciliation'
  ]) {
    const disabled = await fetch(path)
    assert.equal(disabled.status, 503)
    assert.match(disabled.headers.get('content-type') ?? '', /^application\/json/i)
    assert.match(disabled.headers.get('cache-control') ?? '', /private.*no-store/)
    assert.deepEqual(await disabled.json(), { error: { code: 'service_unavailable' } })
  }
  completed++

  // Tokens are decrypted only in this isolated synthetic fixture to exercise
  // the confirmation link. They never enter logs, reports or external calls.
  const registeredEmail = `${randomUUID()}@example.invalid`
  const registrationPassword = 'Local-Audit-Password-123'
  const resetPassword = 'Local-Audit-Recovery-456'
  const sessionCookie = (response: { headers: { getSetCookie(): string[] } }) => {
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('neteco-session='))
    assert(cookie)
    return cookie.split(';')[0]!
  }
  async function lifecycleToken(email: string, purpose: string) {
    const row = await database
      .prepare(
        `SELECT token_envelope FROM identity_lifecycle_tokens t
         JOIN identities i ON i.id = t.identity_id
         WHERE i.email = ?1 AND t.purpose = ?2 AND t.used_at IS NULL AND t.revoked_at IS NULL
         ORDER BY t.created_at DESC, t.id DESC LIMIT 1`
      )
      .bind(email, purpose)
      .first<{ token_envelope: string }>()
    assert(row)
    const token = decryptSecret(row.token_envelope, lifecycleEncryptionKey)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    return token
  }

  scenario = 'real_d1_account_registration_non_enumerating'
  const registrationBody = {
    name: 'Lifecycle Audit Customer',
    email: registeredEmail,
    password: registrationPassword,
    termsAccepted: true,
    newsletter: false
  }
  const registered = await post('/api/auth/register', registrationBody)
  assert.equal(registered.status, 202)
  assert.match(registered.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(registered.headers.getSetCookie().length, 0)
  const duplicateRegistration = await post('/api/auth/register', registrationBody)
  assert.equal(duplicateRegistration.status, 202)
  assert.equal(duplicateRegistration.headers.getSetCookie().length, 0)
  assert.equal(await registered.text(), await duplicateRegistration.text())
  const pendingLogin = await post('/api/auth/login', { email: registeredEmail, password: registrationPassword })
  assert.equal(pendingLogin.status, 200)
  const registeredCookie = sessionCookie(pendingLogin)
  const pendingSession = await json<{ user: { emailVerified: boolean; roles: string[] } }>(
    '/api/_auth/session',
    registeredCookie
  )
  assert.equal(pendingSession.user.emailVerified, false)
  assert.deepEqual(pendingSession.user.roles, ['customer'])
  await html('/cuenta', 'Lifecycle Audit Customer', registeredCookie)
  completed++

  scenario = 'real_d1_email_verification_single_use'
  const verificationToken = await lifecycleToken(registeredEmail, 'verify_email')
  const verified = await post('/api/auth/verify-email', { token: verificationToken })
  assert.equal(verified.status, 200)
  assert.equal(verified.headers.getSetCookie().length, 0)
  const verifiedSession = await json<{ user: { emailVerified: boolean } }>('/api/_auth/session', registeredCookie)
  assert.equal(verifiedSession.user.emailVerified, true)
  const reusedVerification = await post('/api/auth/verify-email', { token: verificationToken })
  assert.equal(reusedVerification.status, 400)
  completed++

  scenario = 'real_d1_forgot_password_generic_and_reset_revocation'
  const forgot = await post('/api/auth/forgot-password', { email: registeredEmail })
  const unknownForgot = await post('/api/auth/forgot-password', { email: `${randomUUID()}@example.invalid` })
  assert.equal(forgot.status, 202)
  assert.equal(unknownForgot.status, 202)
  assert.equal(await forgot.text(), await unknownForgot.text())
  const resetToken = await lifecycleToken(registeredEmail, 'password_reset')
  const reset = await post('/api/auth/reset-password', { token: resetToken, password: resetPassword })
  assert.equal(reset.status, 200)
  assert.deepEqual(await json('/api/_auth/session', registeredCookie), {})
  const reusedReset = await post('/api/auth/reset-password', { token: resetToken, password: resetPassword })
  assert.equal(reusedReset.status, 400)
  completed++

  scenario = 'real_d1_email_change_reauthenticated_and_versioned'
  const login = await post('/api/auth/login', { email: registeredEmail, password: resetPassword })
  assert.equal(login.status, 200)
  const newSessionCookie = sessionCookie(login)
  const changedEmail = `${randomUUID()}@example.invalid`
  const emailChange = await post(
    '/api/account/email-change',
    { email: changedEmail, currentPassword: resetPassword },
    newSessionCookie
  )
  assert.equal(emailChange.status, 202)
  const emailChangeToken = await lifecycleToken(registeredEmail, 'email_change')
  const confirmedChange = await post('/api/auth/verify-email', { token: emailChangeToken }, newSessionCookie)
  assert.equal(confirmedChange.status, 200)
  assert.deepEqual(await json('/api/_auth/session', newSessionCookie), {})
  const storedIdentity = await database
    .prepare('SELECT id FROM identities WHERE email = ?')
    .bind(changedEmail)
    .first<{ id: string }>()
  assert(storedIdentity)
  const deliveries = await database
    .prepare('SELECT count(*) AS n FROM identity_lifecycle_deliveries')
    .first<{ n: number }>()
  assert(deliveries && deliveries.n >= 3)
  completed++

  scenario = 'real_d1_recovery_before_verification_remains_verifiable'
  const unverifiedEmail = `${randomUUID()}@example.invalid`
  const unverifiedRegistration = await post('/api/auth/register', { ...registrationBody, email: unverifiedEmail })
  assert.equal(unverifiedRegistration.status, 202)
  assert.equal(unverifiedRegistration.headers.getSetCookie().length, 0)
  const supersededVerification = await lifecycleToken(unverifiedEmail, 'verify_email')
  const pendingForgot = await post('/api/auth/forgot-password', { email: unverifiedEmail })
  assert.equal(pendingForgot.status, 202)
  const pendingResetToken = await lifecycleToken(unverifiedEmail, 'password_reset')
  const pendingReset = await post('/api/auth/reset-password', { token: pendingResetToken, password: resetPassword })
  assert.equal(pendingReset.status, 200)
  const freshVerification = await lifecycleToken(unverifiedEmail, 'verify_email')
  assert.notEqual(freshVerification, supersededVerification)
  const pendingIdentity = await database
    .prepare('SELECT status, session_version AS version, email_verified_at AS verified FROM identities WHERE email = ?')
    .bind(unverifiedEmail)
    .first<{ status: string; version: number; verified: string | null }>()
  assert.deepEqual(pendingIdentity, { status: 'pending', version: 2, verified: null })
  assert.equal((await post('/api/auth/verify-email', { token: supersededVerification })).status, 400)
  assert.equal((await post('/api/auth/verify-email', { token: freshVerification })).status, 200)
  const recoveredLogin = await post('/api/auth/login', { email: unverifiedEmail, password: resetPassword })
  assert.equal(recoveredLogin.status, 200)
  const recoveredSession = await json<{ user: { emailVerified: boolean } }>(
    '/api/_auth/session',
    sessionCookie(recoveredLogin)
  )
  assert.equal(recoveredSession.user.emailVerified, true)
  completed++

  scenario = 'ephemeral_identity_session_fixtures'
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expires = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await database.batch([
    database.prepare(
      "INSERT INTO roles(code,name,description) VALUES ('customer','Audit customer','Ephemeral only'), ('admin','Audit admin','Ephemeral only'), ('warehouse','Audit warehouse','Ephemeral only') ON CONFLICT(code) DO NOTHING"
    ),
    database.prepare(
      "INSERT INTO permissions(code,resource,action,description) VALUES ('administration.manage','administration','manage','Ephemeral only'), ('catalog.write','catalog','write','Ephemeral only'), ('catalog.publish','catalog','publish','Ephemeral only'), ('inventory.read','inventory','read','Ephemeral only'), ('inventory.write','inventory','write','Ephemeral only')"
    ),
    database.prepare(
      "INSERT INTO role_permissions(role_code,permission_code) VALUES ('admin','administration.manage'), ('admin','catalog.write'), ('admin','catalog.publish'), ('warehouse','inventory.read'), ('warehouse','inventory.write')"
    )
  ])
  async function identity(role: 'customer' | 'admin' | 'warehouse', mfa: boolean) {
    const customerId = randomUUID()
    const identityId = randomUUID()
    const sessionId = randomUUID()
    const name =
      role === 'admin'
        ? 'Audit Administrative Reader'
        : role === 'warehouse'
          ? 'Audit Warehouse Operator'
          : 'Audit Customer Reader'
    await database.batch([
      database
        .prepare("INSERT INTO customers(id,name,status,created_at,updated_at) VALUES (?, ?, 'active', ?, ?)")
        .bind(customerId, name, now, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,customer_id,created_at,updated_at) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)"
        )
        .bind(identityId, `${identityId}@example.invalid`, 'unusable-audit-fixture', now, customerId, now, now),
      database
        .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, ?, ?)')
        .bind(identityId, role, now),
      database
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at,last_seen_at) VALUES (?, ?, 1, ?, ?, ?, ?)'
        )
        .bind(sessionId, identityId, Number(mfa), now, expires, now)
    ])
    const issued = await issueD1SessionCookie(
      database,
      { identityId, sessionId, sessionVersion: 1 },
      cookieConfiguration
    )
    assert(issued)
    return { name, identityId, sessionId, cookie: issued.split(';')[0]! }
  }
  const customer = await identity('customer', false)
  const administrator = await identity('admin', true)
  await prepareNativeAuditAdminMfa(database, administrator.identityId, now)
  const unverifiedAdministrator = await identity('admin', false)
  const inventoryOperator = await identity('warehouse', true)
  const inventoryApprover = await identity('warehouse', true)
  completed++

  scenario = 'real_admin_d1_catalog_private_reads_and_closed_full_crud'
  const editorial = await json<{
    items: Array<{ id: number; uuid: string; name: string }>
    capabilities: { productUpdate: boolean }
  }>('/api/admin/products', administrator.cookie)
  assert(editorial.items.length > 0)
  assert.match(editorial.items[0]!.uuid, /^[0-9a-f-]{36}$/)
  const editorialDetail = await json<{ uuid: string; variants: Array<{ uuid: string }> }>(
    `/api/admin/products/${editorial.items[0]!.id}`,
    administrator.cookie
  )
  assert.equal(editorialDetail.uuid, editorial.items[0]!.uuid)
  assert(editorialDetail.variants.every((variant) => /^[0-9a-f-]{36}$/.test(variant.uuid)))
  assert.equal(editorial.capabilities.productUpdate, false)
  assert.equal((await fetch('/api/admin/products', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/products', unverifiedAdministrator.cookie)).status, 403)
  await html('/admin/productos', editorial.items[0]!.name, administrator.cookie)
  await html(`/admin/productos/${editorial.items[0]!.id}`, 'Catálogo D1', administrator.cookie)
  completed++

  scenario = 'real_admin_category_private_tree_and_governed_editor_ssr'
  const privateCategoryId = randomUUID()
  const privateChildCategoryId = randomUUID()
  const privateCategoryName = 'Familia borrador de auditoría aislada'
  const privateChildName = 'Subfamilia oculta de auditoría aislada'
  const privateProductId = randomUUID()
  await database.batch([
    database
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES (?, 900001, ?, 'isolated-private-root', 'draft', -2)"
      )
      .bind(privateCategoryId, privateCategoryName),
    database
      .prepare(
        "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,sort_order) VALUES (?, 900002, ?, ?, 'isolated-private-child', 'hidden', -1)"
      )
      .bind(privateChildCategoryId, privateCategoryId, privateChildName),
    database
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES (?, 900001, ?, 'Producto privado de auditoría', 'isolated-private-product', 'draft')"
      )
      .bind(privateProductId, privateChildCategoryId)
  ])
  type AuditCategory = {
    id: number
    name: string
    count: number
    status: string
    parentId: number | null
    children: AuditCategory[]
  }
  const privateCategories = await json<{
    source: string
    roots: AuditCategory[]
    flat: AuditCategory[]
    capabilities: {
      categoriesRead: boolean
      categoryCreate: boolean
      categoryUpdate: boolean
      categoryDelete: boolean
    }
  }>('/api/admin/categories', administrator.cookie)
  assert.equal(privateCategories.source, 'cloudflare')
  assert.equal(privateCategories.capabilities.categoriesRead, true)
  assert.equal(privateCategories.capabilities.categoryCreate, true)
  assert.equal(privateCategories.capabilities.categoryUpdate, true)
  assert.equal(privateCategories.capabilities.categoryDelete, true)
  const privateRoot = privateCategories.roots.find((category) => category.id === 900001)
  assert(privateRoot)
  assert.equal(privateRoot.status, 'draft')
  assert.equal(privateRoot.count, 1)
  assert.equal(privateRoot.children.length, 1)
  assert.equal(privateRoot.children[0]!.parentId, privateRoot.id)
  assert.equal(privateRoot.children[0]!.status, 'hidden')
  assert.equal(privateRoot.children[0]!.count, 1)
  // Public caches/consumers must never receive private editorial categories.
  const publicCategoriesAfterDraft = await json<{ roots: AuditCategory[]; flat: AuditCategory[] }>('/api/categories')
  assert(!JSON.stringify(publicCategoriesAfterDraft).includes(privateCategoryName))
  assert(!JSON.stringify(publicCategoriesAfterDraft).includes(privateChildName))
  assert.equal((await fetch('/api/admin/categories')).status, 401)
  assert.equal((await fetch('/api/admin/categories', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/categories', unverifiedAdministrator.cookie)).status, 403)
  const categoryMarkup = renderedMarkup(await html('/admin/categorias', privateCategoryName, administrator.cookie))
  assert(categoryMarkup.includes(privateChildName))
  assert(categoryMarkup.includes('Borrador'))
  assert(categoryMarkup.includes('Oculto'))
  const privateRootMarkup = /<li\b[^>]*data-category-id="900001"[^>]*>([\s\S]*?)<\/li>/.exec(categoryMarkup)?.[1]
  assert(privateRootMarkup)
  // Both levels refer to the same single product: the rendered root must not
  // add the child's already-cumulative count a second time.
  assert.match(privateRootMarkup.replace(/<[^>]+>/g, ' '), /\b1\s+producto\b/)
  assert(!/\b2\s+productos\b/.test(privateRootMarkup.replace(/<[^>]+>/g, ' ')))
  assert(categoryMarkup.includes('Nueva familia'))
  const rejectedCategoryWrite = await post('/api/admin/categories', { name: 'No guardar' }, administrator.cookie)
  assert.equal(rejectedCategoryWrite.status, 400)
  assert.deepEqual(await rejectedCategoryWrite.json(), { error: { code: 'invalid_idempotency_key' } })
  for (const method of ['PUT', 'DELETE']) {
    const rejected = await runtime.dispatchFetch(`${origin}/api/admin/categories/900001`, {
      method,
      headers: { origin, cookie: administrator.cookie, 'cf-connecting-ip': '192.0.2.123' }
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(await rejected.json(), { error: { code: 'invalid_idempotency_key' } })
  }
  assert.equal(
    (
      await database
        .prepare('SELECT name FROM categories WHERE id = ?')
        .bind(privateCategoryId)
        .first<{ name: string }>()
    )?.name,
    privateCategoryName
  )
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'No guardar'").first<{ n: number }>())
      ?.n,
    0
  )
  // This scenario owns only an isolated ephemeral database. Restore its catalog
  // before the following media/inventory scenarios observe the seed.
  await database.batch([
    database.prepare('DELETE FROM products WHERE id = ?').bind(privateProductId),
    database.prepare('DELETE FROM categories WHERE id = ?').bind(privateChildCategoryId),
    database.prepare('DELETE FROM categories WHERE id = ?').bind(privateCategoryId)
  ])
  completed++

  scenario = 'real_d1_category_editorial_crud_exact_replay_and_tombstone'
  const categoryBody = {
    name: 'Familia sintética de auditoría local',
    parentId: null,
    expectedVersion: 0,
    reason: 'Synthetic local editorial decision'
  }
  const categoryKey = randomUUID()
  const categoryCreatedResponse = await adminOperation(
    '/api/admin/categories',
    'POST',
    categoryBody,
    administrator.cookie,
    categoryKey
  )
  assert.equal(categoryCreatedResponse.status, 201)
  const categoryCreatedText = await categoryCreatedResponse.text()
  const categoryCreated = catalogCategoryReceiptSchema.parse(JSON.parse(categoryCreatedText))
  assert.equal(categoryCreated.status, 'draft')
  assert.equal(categoryCreated.categoryVersion, 1)
  assert(categoryCreated.categoryId > 900002, 'Deleted editorial identities must not be reused')
  const categoryReplay = await adminOperation(
    '/api/admin/categories',
    'POST',
    categoryBody,
    administrator.cookie,
    categoryKey
  )
  assert.equal(categoryReplay.status, 201)
  assert.equal(await categoryReplay.text(), categoryCreatedText)
  const categoryConflict = await adminOperation(
    '/api/admin/categories',
    'POST',
    { ...categoryBody, name: 'Different synthetic intent' },
    administrator.cookie,
    categoryKey
  )
  assert.equal(categoryConflict.status, 409)
  assert.deepEqual(await categoryConflict.json(), { error: { code: 'idempotency_conflict' } })
  const categoryDeleted = await adminOperation(
    `/api/admin/categories/${categoryCreated.categoryId}`,
    'DELETE',
    { expectedVersion: 1, reason: 'Retire empty synthetic category' },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(categoryDeleted.status, 200)
  assert.equal(catalogCategoryReceiptSchema.parse(await categoryDeleted.json()).status, 'discontinued')
  const categoryTombstone = await database
    .prepare('SELECT legacy_id,status,category_version FROM categories WHERE id=?')
    .bind(categoryCreated.categoryUuid)
    .first<{ legacy_id: number; status: string; category_version: number }>()
  assert.deepEqual(categoryTombstone, {
    legacy_id: categoryCreated.categoryId,
    status: 'discontinued',
    category_version: 2
  })
  completed++

  scenario = 'real_d1_published_category_rename_direct_redirect_and_restore'
  const originalCategory = await database
    .prepare(
      "SELECT id,legacy_id,name,slug,category_version FROM categories WHERE status='published' AND parent_id IS NULL AND legacy_id IS NOT NULL ORDER BY legacy_id LIMIT 1"
    )
    .first<{ id: string; legacy_id: number; name: string; slug: string; category_version: number }>()
  assert(originalCategory)
  const rename = await adminOperation(
    `/api/admin/categories/${originalCategory.legacy_id}`,
    'PUT',
    {
      name: `${originalCategory.name} auditoria local`,
      expectedVersion: originalCategory.category_version,
      reason: 'Synthetic local URL migration'
    },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(rename.status, 200)
  const renamed = catalogCategoryReceiptSchema.parse(await rename.json())
  assert.notEqual(renamed.slug, originalCategory.slug)
  assert.equal(renamed.status, 'published')
  for (const method of ['GET', 'HEAD']) {
    const redirect = await runtime.dispatchFetch(
      `${origin}/categoria/${originalCategory.slug}?utm_source=local-audit`,
      { method, redirect: 'manual' }
    )
    assert.equal(redirect.status, 301)
    assert.equal(redirect.headers.get('location'), `/categoria/${renamed.slug}?utm_source=local-audit`)
    assert.match(redirect.headers.get('cache-control') ?? '', /no-store/)
    if (method === 'HEAD') assert.equal(await redirect.text(), '')
  }
  const restored = await adminOperation(
    `/api/admin/categories/${originalCategory.legacy_id}`,
    'PUT',
    {
      name: originalCategory.name,
      expectedVersion: renamed.categoryVersion,
      reason: 'Restore synthetic local seed label'
    },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(restored.status, 200)
  assert.equal(catalogCategoryReceiptSchema.parse(await restored.json()).slug, originalCategory.slug)
  const reverseRedirect = await fetch(`/categoria/${renamed.slug}`)
  assert.equal(reverseRedirect.status, 301)
  assert.equal(reverseRedirect.headers.get('location'), `/categoria/${originalCategory.slug}`)
  completed++

  scenario = 'real_admin_draft_metadata_atomic_write_replay_and_ssr'
  const metadataProductId = randomUUID()
  const metadataLegacyId = 900010
  const metadataCategory = await database
    .prepare('SELECT category_id AS id FROM products WHERE id = ?')
    .bind(editorial.items[0]!.uuid)
    .first<{ id: string }>()
  assert(metadataCategory)
  const metadataAttributes = {
    visual: { type: 'botella', color: '#123456', protectedExtra: 'retain-visual-extra' },
    image: '/private-synthetic-metadata-only-image',
    imageRights: { owner: 'Synthetic owner', license: 'Synthetic audit only' },
    protectedExtra: { source: 'isolated-fixture' }
  }
  await database
    .prepare(
      `INSERT INTO products(id,legacy_id,category_id,name,slug,status,short_description,description,attributes)
      VALUES (?, ?, ?, 'Borrador de catálogo de auditoría aislada', 'isolated-metadata-draft', 'draft',
      'Descripción breve de prueba', 'Descripción contractual de prueba', ?)`
    )
    .bind(metadataProductId, metadataLegacyId, metadataCategory.id, JSON.stringify(metadataAttributes))
    .run()
  const metadataPath = `/api/admin/products/${metadataLegacyId}`
  const metadataDetail = await json<{
    catalogVersion: number
    capabilities: { productUpdate: boolean; productMetadataUpdate: boolean }
  }>(metadataPath, administrator.cookie)
  assert.equal(metadataDetail.catalogVersion, 1)
  assert.equal(metadataDetail.capabilities.productUpdate, false)
  assert.equal(metadataDetail.capabilities.productMetadataUpdate, true)
  const draftEditorMarkup = renderedMarkup(
    await html(`/admin/productos/${metadataLegacyId}`, 'Editar metadatos del borrador', administrator.cookie)
  )
  assert(draftEditorMarkup.includes('Motivo del cambio'))
  assert(draftEditorMarkup.includes('Comprobación informativa de publicación'))
  assert(draftEditorMarkup.includes('no permite publicar'))
  const metadataInput = {
    expectedVersion: metadataDetail.catalogVersion,
    reason: 'Corrección editorial en base desechable',
    name: 'Borrador de catálogo corregido',
    visual: { type: 'caja', color: '#abcdef' }
  }
  const putMetadata = (input: Record<string, unknown>, key: string, cookie = administrator.cookie) =>
    runtime!.dispatchFetch(`${origin}${metadataPath}`, {
      method: 'PUT',
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.123'
      },
      body: JSON.stringify(input)
    })
  assert.equal((await putMetadata(metadataInput, 'denied-customer-draft', customer.cookie)).status, 403)
  assert.equal((await putMetadata(metadataInput, 'denied-nonmfa-draft', unverifiedAdministrator.cookie)).status, 403)
  assert.equal((await putMetadata({ ...metadataInput, status: 'published' }, 'forbidden-field-draft')).status, 422)
  const [metadataSaved, concurrentMetadataReplay] = await Promise.all([
    putMetadata(metadataInput, 'isolated-draft-edit'),
    putMetadata(metadataInput, 'isolated-draft-edit')
  ])
  assert.equal(metadataSaved.status, 200)
  assert.equal(concurrentMetadataReplay.status, 200)
  assert.equal(metadataSaved.headers.get('cache-control'), 'private, no-store')
  const metadataReceipt = await metadataSaved.text()
  assert.equal(await concurrentMetadataReplay.text(), metadataReceipt)
  assert.deepEqual(JSON.parse(metadataReceipt), {
    source: 'cloudflare',
    productId: metadataLegacyId,
    productUuid: metadataProductId,
    catalogVersion: 2,
    updated: true
  })
  const savedMetadataRow = await database
    .prepare('SELECT name,slug,status,attributes,catalog_version AS version FROM products WHERE id = ?')
    .bind(metadataProductId)
    .first<{ name: string; slug: string; status: string; attributes: string; version: number }>()
  assert(savedMetadataRow)
  assert.equal(savedMetadataRow.name, metadataInput.name)
  assert.equal(savedMetadataRow.slug, 'isolated-metadata-draft')
  assert.equal(savedMetadataRow.status, 'draft')
  assert.equal(savedMetadataRow.version, 2)
  assert.deepEqual(JSON.parse(savedMetadataRow.attributes), {
    ...metadataAttributes,
    visual: { ...metadataAttributes.visual, ...metadataInput.visual }
  })
  const unchangedReplay = await putMetadata(metadataInput, 'isolated-draft-edit')
  assert.equal(unchangedReplay.status, 200)
  assert.equal(await unchangedReplay.text(), metadataReceipt)
  await database
    .prepare("UPDATE products SET status = 'hidden', name = 'Cambio posterior aislado' WHERE id = ?")
    .bind(metadataProductId)
    .run()
  const advancedReplay = await putMetadata(metadataInput, 'isolated-draft-edit')
  assert.equal(advancedReplay.status, 200)
  assert.equal(await advancedReplay.text(), metadataReceipt)
  assert.equal((await putMetadata({ ...metadataInput, name: 'Payload distinto' }, 'isolated-draft-edit')).status, 409)
  assert.equal((await putMetadata({ ...metadataInput, expectedVersion: 3 }, 'non-draft-edit')).status, 409)
  for (const table of ['catalog_draft_commands', 'catalog_draft_audit']) {
    const count = await database
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE product_id = ?`)
      .bind(metadataProductId)
      .first<{ n: number }>()
    assert.equal(count?.n, 1)
  }
  assert.equal(
    (
      await database
        .prepare('SELECT catalog_version AS version FROM products WHERE id = ?')
        .bind(metadataProductId)
        .first<{ version: number }>()
    )?.version,
    3
  )
  // Commands and audit rows are immutable: retain this private fixture only in
  // the disposable audit D1 until runtime.dispose(), never in shared state.
  completed++

  scenario = 'real_private_catalog_publication_readiness_advisory'
  const readinessPath = `${metadataPath}/publication-readiness`
  const readinessResponse = await fetch(readinessPath, administrator.cookie)
  assert.equal(readinessResponse.status, 200)
  assert.equal(readinessResponse.headers.get('cache-control'), 'private, no-store')
  assert.equal(readinessResponse.headers.get('vary'), 'Cookie')
  const readiness = (await readinessResponse.json()) as {
    source: string
    advisory: boolean
    publicationEnabled: boolean
    productId: number
    productUuid: string
    catalogVersion: number
    issues: Array<{ code: string; path: string; message: string }>
    limitations: Array<{ code: string; path: string; message: string }>
  }
  assert.equal(readiness.source, 'cloudflare')
  assert.equal(readiness.advisory, true)
  assert.equal(readiness.publicationEnabled, false)
  assert.equal(readiness.productId, metadataLegacyId)
  assert.equal(readiness.productUuid, metadataProductId)
  assert.equal(readiness.catalogVersion, 3)
  assert(readiness.issues.some((issue) => issue.code === 'variant.missing'))
  assert(readiness.issues.some((issue) => issue.code === 'media.primary'))
  assert(readiness.limitations.some((issue) => issue.code === 'advisory.snapshot'))
  assert(!JSON.stringify(readiness).includes(metadataAttributes.image))
  assert.equal((await fetch(readinessPath)).status, 401)
  assert.equal((await fetch(readinessPath, customer.cookie)).status, 403)
  assert.equal((await fetch(readinessPath, unverifiedAdministrator.cookie)).status, 403)
  assert.equal((await fetch(`${readinessPath}?instant=2099-01-01T00:00:00Z`, administrator.cookie)).status, 400)
  const rejectedReadinessWrite = await post(readinessPath, { status: 'published' }, administrator.cookie)
  assert.equal(rejectedReadinessWrite.status, 405)
  assert.equal(rejectedReadinessWrite.headers.get('allow'), 'GET')
  assert.equal(
    (
      await database
        .prepare('SELECT catalog_version AS version FROM products WHERE id=?')
        .bind(metadataProductId)
        .first<{ version: number }>()
    )?.version,
    3
  )
  for (const table of ['catalog_draft_commands', 'catalog_draft_audit']) {
    assert.equal(
      (
        await database
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE product_id=?`)
          .bind(metadataProductId)
          .first<{ n: number }>()
      )?.n,
      1
    )
  }
  completed++

  scenario = 'real_draft_authoring_reference_options_and_create_ssr'
  const draftReferences = catalogDraftAuthoringOptionsSchema.parse(
    await json('/api/admin/products/authoring-options', administrator.cookie)
  )
  assert(
    draftReferences.categories.length &&
      draftReferences.brands.length &&
      draftReferences.taxClasses.length &&
      draftReferences.shippingProfiles.length
  )
  assert.equal((await fetch('/api/admin/products/authoring-options', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/products/authoring-options', unverifiedAdministrator.cookie)).status, 403)
  await html('/admin/productos/nuevo', 'Catálogo D1', administrator.cookie)
  const authoringVariant = {
    sku: `LOCAL-DRAFT-${randomUUID()}`,
    format: 'Botella sintética 1 L',
    ean: '4006381333931',
    gtin: null,
    mpn: null,
    taxClassId: draftReferences.taxClasses[0]!.id,
    shippingProfileId: draftReferences.shippingProfiles[0]!.id,
    unitBase: 'L',
    unitLabel: 'litro',
    contentQuantity: 1,
    unitsPerCase: 1,
    casesPerPallet: null,
    minimumQuantity: 1,
    quantityIncrement: 1,
    maximumQuantity: null,
    weightGrams: 1100,
    widthMm: 100,
    heightMm: 200,
    depthMm: 100,
    backorderAllowed: false,
    leadTimeDays: null,
    color: null
  }
  const authoringInput = {
    expectedVersion: 0,
    reason: 'Synthetic disposable draft creation, not a commercial approval',
    name: 'Borrador nuevo de auditoría aislada',
    categoryId: draftReferences.categories[0]!.id,
    brandId: draftReferences.brands[0]!.id,
    shortDesc: 'Descripción breve sintética del borrador',
    description: 'Descripción sintética sin publicación, precio aprobado ni inventario real.',
    usage: null,
    series: null,
    featured: false,
    badges: [],
    visual: { type: 'botella', color: '#009ac9' },
    attrs: [],
    initialVariant: authoringVariant
  }
  const draftWrite = (
    path: string,
    method: string,
    input: Record<string, unknown>,
    key: string,
    cookie = administrator.cookie
  ) =>
    runtime!.dispatchFetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.123'
      },
      body: JSON.stringify(input)
    })
  completed++

  scenario = 'real_draft_authoring_atomic_create_historical_replay_and_zero_financials'
  const authoringKey = randomUUID()
  const rejectedAuthoring = await draftWrite(
    '/api/admin/products',
    'POST',
    authoringInput,
    authoringKey,
    customer.cookie
  )
  assert.equal(rejectedAuthoring.status, 403)
  const createdDraft = await draftWrite('/api/admin/products', 'POST', authoringInput, authoringKey)
  assert.equal(createdDraft.status, 201)
  assert.equal(createdDraft.headers.get('cache-control'), 'private, no-store')
  const createdDraftText = await createdDraft.text()
  const createdIdentity = catalogDraftAuthoringReceiptSchema.parse(JSON.parse(createdDraftText))
  assert.equal(createdIdentity.action, 'create_draft')
  assert.equal(createdIdentity.catalogVersion, 1)
  const createdPath = `/api/admin/products/${createdIdentity.productId}`
  const createdDetail = await json<{ authoring: unknown; slug: string }>(createdPath, administrator.cookie)
  const createdSnapshot = catalogDraftAuthoringSnapshotSchema.parse(createdDetail.authoring)
  assert.equal(createdSnapshot.productUuid, createdIdentity.productUuid)
  assert.equal(createdSnapshot.variants.length, 1)
  assert.equal(createdSnapshot.status, 'draft')
  assert.equal((await fetch(`/api/products/${createdDetail.slug}`)).status, 404)
  await html(`/admin/productos/${createdIdentity.productId}`, authoringInput.name, administrator.cookie)
  assert.equal(
    (
      await database
        .prepare('SELECT price_gross_cents AS price FROM variants WHERE id=?')
        .bind(createdIdentity.variantUuid)
        .first<{ price: number }>()
    )?.price,
    0
  )
  assert.equal(
    (
      await database
        .prepare(
          'SELECT physical_quantity AS physical,blocked_quantity AS blocked FROM inventory_balances WHERE variant_id=?'
        )
        .bind(createdIdentity.variantUuid)
        .first<{ physical: number; blocked: number }>()
    )?.physical,
    0
  )
  for (const table of ['variant_price_versions', 'inventory_movements'])
    assert.equal(
      (
        await database
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE variant_id=?`)
          .bind(createdIdentity.variantUuid)
          .first<{ n: number }>()
      )?.n,
      0
    )
  const originalReplay = await draftWrite('/api/admin/products', 'POST', authoringInput, authoringKey)
  assert.equal(originalReplay.status, 201)
  assert.equal(await originalReplay.text(), createdDraftText)
  assert.equal(
    (await draftWrite('/api/admin/products', 'POST', { ...authoringInput, name: 'Different payload' }, authoringKey))
      .status,
    409
  )
  completed++

  scenario = 'real_draft_authoring_variant_brand_retirement_and_version_conflict'
  const variantPath = `${createdPath}/variants`
  const createdVariant = await draftWrite(
    variantPath,
    'POST',
    {
      ...authoringVariant,
      ean: null,
      sku: `LOCAL-SECOND-${randomUUID()}`,
      expectedVersion: 1,
      reason: 'Synthetic explicit second variant'
    },
    randomUUID()
  )
  assert.equal(createdVariant.status, 200)
  const secondIdentity = catalogDraftAuthoringReceiptSchema.parse(await createdVariant.json())
  const secondVariantPath = `${variantPath}/${secondIdentity.variantId}`
  const alteredVariant = await draftWrite(
    secondVariantPath,
    'PUT',
    {
      expectedVersion: 2,
      reason: 'Synthetic explicit format change',
      format: 'Caja sintética 6 L'
    },
    randomUUID()
  )
  assert.equal(alteredVariant.status, 200)
  const staleVariant = await draftWrite(
    secondVariantPath,
    'PUT',
    {
      expectedVersion: 2,
      reason: 'Synthetic stale update',
      format: 'Must not apply stale format'
    },
    randomUUID()
  )
  assert.equal(staleVariant.status, 409)
  const assignedBrand = await draftWrite(
    `${createdPath}/brand`,
    'PUT',
    {
      expectedVersion: 3,
      reason: 'Synthetic explicit brand assignment',
      brandId: draftReferences.brands[0]!.id
    },
    randomUUID()
  )
  assert.equal(assignedBrand.status, 200)
  const retiredVariant = await draftWrite(
    `${secondVariantPath}/discontinue`,
    'POST',
    {
      expectedVersion: 4,
      reason: 'Synthetic explicit retirement, preserving the initial variant'
    },
    randomUUID()
  )
  assert.equal(retiredVariant.status, 200)
  const retiredLast = await draftWrite(
    `${variantPath}/${createdIdentity.variantId}/discontinue`,
    'POST',
    {
      expectedVersion: 5,
      reason: 'Synthetic forbidden last variant retirement'
    },
    randomUUID()
  )
  assert.equal(retiredLast.status, 409)
  const finalDetail = await json<{ authoring: unknown }>(createdPath, administrator.cookie)
  const finalSnapshot = catalogDraftAuthoringSnapshotSchema.parse(finalDetail.authoring)
  assert.equal(finalSnapshot.catalogVersion, 5)
  assert.equal(finalSnapshot.variants.length, 1)
  assert.equal(finalSnapshot.variants[0]!.uuid, createdIdentity.variantUuid)
  for (const table of ['catalog_draft_authoring_commands', 'catalog_draft_authoring_audit'])
    assert.equal(
      (
        await database
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE product_uuid=?`)
          .bind(createdIdentity.productUuid)
          .first<{ n: number }>()
      )?.n,
      5
    )
  const historicalReplay = await draftWrite('/api/admin/products', 'POST', authoringInput, authoringKey)
  assert.equal(await historicalReplay.text(), createdDraftText)
  assert.equal((await json<{ total: number }>('/api/products')).total, 20)
  completed++

  scenario = 'real_draft_authoring_unique_constraint_rolls_back_claim_counter_and_effects'
  const authoringState = async () => ({
    counters: (await database.prepare('SELECT entity,last_id FROM catalog_draft_legacy_counters ORDER BY entity').all())
      .results,
    variants: (
      await database
        .prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id')
        .bind(createdIdentity.productUuid)
        .all()
    ).results,
    balances: (
      await database
        .prepare(
          'SELECT b.* FROM inventory_balances b JOIN variants v ON v.id=b.variant_id WHERE v.product_id=? ORDER BY variant_id,location_id'
        )
        .bind(createdIdentity.productUuid)
        .all()
    ).results,
    commands: (
      await database
        .prepare('SELECT id FROM catalog_draft_authoring_commands WHERE product_uuid=? ORDER BY id')
        .bind(createdIdentity.productUuid)
        .all()
    ).results,
    audits: (
      await database
        .prepare('SELECT id FROM catalog_draft_authoring_audit WHERE product_uuid=? ORDER BY id')
        .bind(createdIdentity.productUuid)
        .all()
    ).results
  })
  const beforeConstraint = await authoringState()
  const duplicateIdentifier = await draftWrite(
    variantPath,
    'POST',
    {
      ...authoringVariant,
      sku: `LOCAL-DUPLICATE-${randomUUID()}`,
      expectedVersion: 5,
      reason: 'Synthetic duplicate EAN proves rollback, not a product approval'
    },
    randomUUID()
  )
  assert.equal(duplicateIdentifier.status, 409)
  assert.deepEqual(await duplicateIdentifier.json(), { error: { code: 'conflict' } })
  assert.deepEqual(await authoringState(), beforeConstraint)
  completed++

  scenario = 'real_admin_d1_pricing_readonly_history_and_server_clock'
  const tariff = await json<{
    source: string
    items: Array<{
      id: number
      variantId: string
      sku: string
      grossCents: number
      catalogVersion: number
      latestApproved: { id: string } | null
      history: Array<{ id: string }>
    }>
    capabilities: { priceWrite: boolean; priceSchedule: boolean; priceCancel: boolean; priceHistoryRead: boolean }
    pricingInstant: string
    pagination: { perPage: number; total: number }
    limits: { returnedVersionRecordsMax: number }
  }>('/api/admin/prices?perPage=25', administrator.cookie)
  assert.equal(tariff.source, 'cloudflare')
  assert(tariff.items.length > 0 && tariff.items.length <= 25)
  assert.equal(tariff.pagination.perPage, 25)
  assert.equal(tariff.limits.returnedVersionRecordsMax, 5000)
  assert(Number.isFinite(Date.parse(tariff.pricingInstant)))
  assert.equal(tariff.capabilities.priceHistoryRead, true)
  assert.equal(tariff.capabilities.priceWrite, false)
  assert.equal(tariff.capabilities.priceSchedule, true)
  assert.equal(tariff.capabilities.priceCancel, true)
  // Draft authoring adds legitimately pending zero-price variants before this
  // scenario. Do not mistake alphabetical position for governed price history.
  const pricedVariant = tariff.items.find((item) => item.history.length > 0)
  assert(pricedVariant, 'The seeded governed price history must remain observable')
  const targetedTariff = await json<typeof tariff>(
    `/api/admin/prices?variant=${pricedVariant.id}&historyPerPage=20`,
    administrator.cookie
  )
  assert.equal(targetedTariff.items.length, 1)
  assert.equal(targetedTariff.items[0]!.variantId, pricedVariant.variantId)
  assert(targetedTariff.items[0]!.history.length > 0)
  const pendingTariff = await json<typeof tariff>(
    `/api/admin/prices?variant=${createdIdentity.variantId}&historyPerPage=20`,
    administrator.cookie
  )
  assert.equal(pendingTariff.items.length, 1)
  assert.equal(pendingTariff.items[0]!.variantId, createdIdentity.variantUuid)
  assert.equal(pendingTariff.items[0]!.grossCents, 0)
  assert.equal(pendingTariff.items[0]!.history.length, 0)
  assert.equal((await fetch('/api/admin/prices', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/prices', unverifiedAdministrator.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/prices?instant=2026-01-01T00:00:00Z', administrator.cookie)).status, 400)
  const rejectedPriceWrite = await post('/api/admin/prices', { grossCents: 1 }, administrator.cookie)
  assert.equal(rejectedPriceWrite.status, 400)
  assert.deepEqual(await rejectedPriceWrite.json(), { error: { code: 'invalid_idempotency_key' } })
  await html('/admin/precios', pricedVariant.sku, administrator.cookie)
  completed++

  scenario = 'real_d1_scheduled_price_durable_replay_cancel_and_current_price_preservation'
  const priceContext = targetedTariff.items[0]!
  const scheduledBody = {
    variantId: priceContext.variantId,
    expectedCatalogVersion: priceContext.catalogVersion,
    expectedLatestApprovedId: priceContext.latestApproved?.id ?? null,
    grossCents: priceContext.grossCents + 100,
    compareAtGrossCents: null,
    volumeTiers: [],
    validFrom: new Date(Date.now() + 600_000).toISOString(),
    reason: 'Synthetic local future price decision'
  }
  const priceKey = randomUUID()
  const priceResponse = await adminOperation('/api/admin/prices', 'POST', scheduledBody, administrator.cookie, priceKey)
  assert.equal(priceResponse.status, 201)
  const priceText = await priceResponse.text()
  const scheduledPrice = catalogPriceReceiptSchema.parse(JSON.parse(priceText))
  const priceReplay = await adminOperation('/api/admin/prices', 'POST', scheduledBody, administrator.cookie, priceKey)
  assert.equal(priceReplay.status, 201)
  assert.equal(await priceReplay.text(), priceText)
  const priceConflict = await adminOperation(
    '/api/admin/prices',
    'POST',
    { ...scheduledBody, grossCents: scheduledBody.grossCents + 1 },
    administrator.cookie,
    priceKey
  )
  assert.equal(priceConflict.status, 409)
  assert.deepEqual(await priceConflict.json(), { error: { code: 'idempotency_conflict' } })
  const afterScheduled = await json<typeof tariff>(`/api/admin/prices?variant=${priceContext.id}`, administrator.cookie)
  assert.equal(afterScheduled.items[0]!.grossCents, priceContext.grossCents)
  assert.equal(afterScheduled.items[0]!.latestApproved?.id, scheduledPrice.priceId)
  const cancelBody = {
    expectedCatalogVersion: priceContext.catalogVersion,
    expectedLatestApprovedId: scheduledPrice.priceId,
    reason: 'Cancel synthetic local future price'
  }
  const cancelKey = randomUUID()
  const cancelPath = `/api/admin/prices/${encodeURIComponent(scheduledPrice.priceId)}/cancel`
  const cancelResponse = await adminOperation(cancelPath, 'POST', cancelBody, administrator.cookie, cancelKey)
  assert.equal(cancelResponse.status, 200)
  const cancelText = await cancelResponse.text()
  assert.equal(catalogPriceReceiptSchema.parse(JSON.parse(cancelText)).action, 'price_cancel')
  const cancelReplay = await adminOperation(cancelPath, 'POST', cancelBody, administrator.cookie, cancelKey)
  assert.equal(cancelReplay.status, 200)
  assert.equal(await cancelReplay.text(), cancelText)
  const afterCancelled = await json<typeof tariff>(`/api/admin/prices?variant=${priceContext.id}`, administrator.cookie)
  assert.equal(afterCancelled.items[0]!.grossCents, priceContext.grossCents)
  assert.equal(afterCancelled.items[0]!.catalogVersion, priceContext.catalogVersion)
  assert.equal(afterCancelled.items[0]!.latestApproved?.id ?? null, priceContext.latestApproved?.id ?? null)
  completed++

  scenario = 'real_single_warehouse_operator_receipt_through_actual_durable_object'
  const inventoryPath = `/api/admin/inventory/variants/${createdIdentity.variantId}`
  const inventorySearchPath = `/api/admin/inventory/variants?q=${encodeURIComponent(authoringVariant.sku)}`
  const inventorySearch = adminInventoryVariantSearchSchema.parse(
    await json(inventorySearchPath, inventoryOperator.cookie)
  )
  assert.equal(inventorySearch.pagination.total, 1)
  assert.equal(inventorySearch.items[0]!.id, createdIdentity.variantId)
  assert.equal(inventorySearch.items[0]!.uuid, createdIdentity.variantUuid)
  assert.equal(inventorySearch.items[0]!.sku, authoringVariant.sku)
  assert.equal((await fetch(inventorySearchPath, customer.cookie)).status, 403)
  const manualInventoryInitial = adminInventoryVariantSchema.parse(await json(inventoryPath, inventoryOperator.cookie))
  assert.equal(manualInventoryInitial.balance.physicalQuantity, 0)
  assert.equal(manualInventoryInitial.balance.reservedQuantity, 0)
  assert.equal((await fetch('/api/admin/products', inventoryOperator.cookie)).status, 403)
  assert.equal((await fetch(inventoryPath, customer.cookie)).status, 403)
  const receiptInput = {
    expectedBalanceVersion: manualInventoryInitial.balance.version,
    quantity: 5,
    reason: 'Synthetic local delivery receipt',
    reference: 'LOCAL-INVENTORY-RECEIPT'
  }
  const receiptKey = randomUUID()
  const receiptResponse = await adminOperation(
    `${inventoryPath}/receipts`,
    'POST',
    receiptInput,
    inventoryOperator.cookie,
    receiptKey
  )
  assert.equal(receiptResponse.status, 200)
  const receiptText = await receiptResponse.text()
  const stockReceipt = inventoryCommandReceiptSchema.parse(JSON.parse(receiptText))
  assert.equal(stockReceipt.physicalDelta, 5)
  assert.equal(stockReceipt.physicalQuantity, 5)
  const receiptReplay = await adminOperation(
    `${inventoryPath}/receipts`,
    'POST',
    receiptInput,
    inventoryOperator.cookie,
    receiptKey
  )
  assert.equal(receiptReplay.status, 200)
  assert.equal(await receiptReplay.text(), receiptText)
  const receivedInventory = adminInventoryVariantSchema.parse(await json(inventoryPath, inventoryOperator.cookie))
  assert.equal(receivedInventory.balance.physicalQuantity, 5)
  assert.equal(receivedInventory.ledger.items.filter((entry) => entry.type === 'receipt').length, 1)
  assert(
    receivedInventory.ledger.items.some(
      (entry) => entry.type === 'receipt' && entry.actorId === inventoryOperator.identityId
    )
  )
  completed++

  await html('/admin/inventario', 'Inventario operativo', inventoryOperator.cookie)

  scenario = 'real_single_warehouse_count_distinct_approval_and_revoked_replay'
  const countInput = {
    expectedBalanceVersion: receivedInventory.balance.version,
    countedPhysicalQuantity: 7,
    reason: 'Synthetic local physical count',
    reference: 'LOCAL-INVENTORY-COUNT'
  }
  const countResponse = await adminOperation(
    `${inventoryPath}/counts`,
    'POST',
    countInput,
    inventoryOperator.cookie,
    randomUUID()
  )
  assert.equal(countResponse.status, 200)
  const countReceipt = inventoryCommandReceiptSchema.parse(await countResponse.json())
  assert.equal(countReceipt.physicalDelta, 0)
  assert.equal(countReceipt.proposedPhysicalDelta, 2)
  assert(countReceipt.proposalId)
  const countedInventory = adminInventoryVariantSchema.parse(await json(inventoryPath, inventoryOperator.cookie))
  assert.equal(countedInventory.balance.physicalQuantity, 5)
  assert.equal(countedInventory.balance.version, receivedInventory.balance.version)
  const approvalInput = {
    expectedBalanceVersion: receivedInventory.balance.version,
    reason: 'Independent synthetic count approval'
  }
  const approvalPath = `${inventoryPath}/counts/${countReceipt.proposalId}/approve`
  const selfApproval = await adminOperation(approvalPath, 'POST', approvalInput, inventoryOperator.cookie, randomUUID())
  assert.equal(selfApproval.status, 409)
  assert.deepEqual(await selfApproval.json(), { error: { code: 'approval_self' } })
  const approvedResponse = await adminOperation(
    approvalPath,
    'POST',
    approvalInput,
    inventoryApprover.cookie,
    randomUUID()
  )
  assert.equal(approvedResponse.status, 200)
  assert.equal(inventoryCommandReceiptSchema.parse(await approvedResponse.json()).physicalQuantity, 7)
  const approvedInventory = adminInventoryVariantSchema.parse(await json(inventoryPath, inventoryOperator.cookie))
  assert.equal(approvedInventory.balance.physicalQuantity, 7)
  assert.equal(approvedInventory.ledger.items.filter((entry) => entry.type === 'adjustment').length, 1)
  await database
    .prepare("DELETE FROM identity_roles WHERE identity_id=? AND role_code='warehouse'")
    .bind(inventoryOperator.identityId)
    .run()
  const revokedReplay = await adminOperation(
    `${inventoryPath}/receipts`,
    'POST',
    receiptInput,
    inventoryOperator.cookie,
    receiptKey
  )
  assert.equal(revokedReplay.status, 403)
  assert.deepEqual(await revokedReplay.json(), { error: { code: 'forbidden' } })
  assert.equal(
    (
      await database
        .prepare('SELECT physical_quantity AS n FROM inventory_balances WHERE variant_id=?')
        .bind(stockReceipt.variantUuid)
        .first<{ n: number }>()
    )?.n,
    7
  )
  completed++

  scenario = 'real_r2_quarantine_signed_scan_and_explicit_human_publication'
  // Owned synthetic test image, generated locally; this signature is NOT
  // evidence that a production antivirus or rights review has been exercised.
  const { default: sharp } = await import('sharp')
  const original = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#009ac9' } })
    .png()
    .toBuffer()
  const multipart = new FormData()
  multipart.append('file', new File([new Uint8Array(original)], 'local-runtime-fixture.png', { type: 'image/png' }))
  multipart.append('ownerName', 'Isolated local test fixture')
  multipart.append('license', 'Synthetic test asset only, not operational rights evidence')
  multipart.append('authorizedAt', now.slice(0, 10))
  multipart.append('altText', 'Imagen sintética de auditoría local')
  multipart.append('source', 'local-test-fixture-reference')
  // Serialize using the owning FormData implementation before crossing the
  // Node/Miniflare fetch realm; a foreign FormData may become plain text.
  const uploadRequest = new Request(`${origin}/api/admin/media`, {
    method: 'POST',
    headers: {
      origin,
      cookie: administrator.cookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID()
    },
    body: multipart
  })
  const uploaded = await runtime.dispatchFetch(uploadRequest.url, {
    method: 'POST',
    headers: Object.fromEntries(uploadRequest.headers),
    body: new Uint8Array(await uploadRequest.arrayBuffer())
  })
  assert.equal(uploaded.status, 201)
  const upload = (await uploaded.json()) as { id: string }
  const stored = await database
    .prepare('SELECT object_key, checksum, byte_size, stored_at FROM media_uploads WHERE id = ?')
    .bind(upload.id)
    .first<{ object_key: string; checksum: string; byte_size: number; stored_at: string }>()
  assert(stored)
  assert.equal(stored.checksum, createHash('sha256').update(original).digest('hex'))
  const scanBody = JSON.stringify({
    receiptId: randomUUID(),
    uploadId: upload.id,
    checksum: stored.checksum,
    objectKey: stored.object_key,
    byteSize: stored.byte_size,
    verdict: 'clean',
    scannerVersion: 'isolated-signed-fixture-not-real-scanner',
    scannedAt: stored.stored_at,
    expiresAt: expires
  })
  const scan = await runtime.dispatchFetch(`${origin}/api/media/scan-receipts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '192.0.2.123',
      'x-media-scan-signature': `sha256=${createHmac('sha256', mediaScanSecret).update(scanBody).digest('hex')}`
    },
    body: scanBody
  })
  assert.equal(scan.status, 201)
  const rights = await runtime.dispatchFetch(`${origin}/api/admin/media/${upload.id}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: administrator.cookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID(),
      'if-match': '0'
    },
    body: JSON.stringify({ decision: 'approve', reason: 'Synthetic local rights fixture, not production approval' })
  })
  assert.equal(rights.status, 200)
  const productIdentity = await database
    .prepare('SELECT id,legacy_id AS legacyId FROM products WHERE slug = ?')
    .bind(firstProduct.slug)
    .first<{ id: string; legacyId: number }>()
  assert(productIdentity)
  const published = await runtime.dispatchFetch(`${origin}/api/admin/media/${upload.id}/publications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: administrator.cookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({
      productId: productIdentity.id,
      variantId: null,
      role: 'main',
      title: 'Isolated runtime fixture',
      altText: 'Imagen sintética de auditoría local',
      language: 'es',
      version: 'local-audit-v1',
      validFrom: stored.stored_at,
      validUntil: expires
    })
  })
  assert.equal(published.status, 201)
  const publication = ((await published.json()) as { publication: { id: string } }).publication
  completed++

  scenario = 'real_catalog_status_authoritative_policy_gate_and_private_editor_ssr'
  const statusProductId = randomUUID()
  const statusVariantId = randomUUID()
  const retiredStatusVariantId = randomUUID()
  // Earlier draft commands allocate above the existing fixture high-water
  // marks. Allocate this later synthetic fixture above current IDs too.
  const statusLegacyIdentity = await database
    .prepare(
      `SELECT (SELECT COALESCE(MAX(legacy_id),0)+1 FROM products) AS product,
        (SELECT COALESCE(MAX(legacy_id),0)+1 FROM variants) AS variant`
    )
    .first<{ product: number; variant: number }>()
  assert(statusLegacyIdentity)
  assert(Number.isSafeInteger(statusLegacyIdentity.product) && statusLegacyIdentity.product > 0)
  assert(Number.isSafeInteger(statusLegacyIdentity.variant) && statusLegacyIdentity.variant > 0)
  const statusLegacyId = statusLegacyIdentity.product
  const statusVariantLegacyId = statusLegacyIdentity.variant
  const statusSlug = 'isolated-status-publication-candidate'
  const statusProductName = 'Candidato sintético de publicación de auditoría'
  const statusDependencies = await database
    .prepare(
      `SELECT p.category_id AS categoryId,p.brand_id AS brandId,v.tax_class_id AS taxClassId,
        v.shipping_profile_id AS shippingProfileId,v.price_gross_cents AS priceCents
      FROM products p JOIN categories c ON c.id=p.category_id AND c.status='published'
      JOIN brands b ON b.id=p.brand_id AND b.status='published'
      JOIN variants v ON v.product_id=p.id AND v.status='published'
      JOIN tax_classes tax ON tax.id=v.tax_class_id
      WHERE p.status='published' AND v.price_gross_cents>0
        AND tax.valid_from<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND (tax.valid_until IS NULL OR tax.valid_until>strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      ORDER BY p.legacy_id,v.legacy_id LIMIT 1`
    )
    .first<{ categoryId: string; brandId: string; taxClassId: string; shippingProfileId: string; priceCents: number }>()
  assert(statusDependencies)
  await database.batch([
    database
      .prepare(
        `INSERT INTO products(id,legacy_id,category_id,brand_id,name,slug,status,short_description,description,
          attributes,regulatory,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'review',?,?,?, ?,?,?)`
      )
      .bind(
        statusProductId,
        statusLegacyId,
        statusDependencies.categoryId,
        statusDependencies.brandId,
        statusProductName,
        statusSlug,
        'Descripción breve completa del candidato sintético aislado',
        'Descripción completa para comprobar únicamente la mecánica local de publicación gobernada, sin aceptación comercial ni legal.',
        JSON.stringify({ visual: { type: 'botella', color: '#123456' } }),
        JSON.stringify({ localAuditOnly: true }),
        now,
        now
      ),
    database
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,mpn,format,status,
          unit_base,unit_label,content_quantity,minimum_quantity,quantity_increment,price_gross_cents,currency,
          weight_grams,width_mm,height_mm,depth_mm,backorder_allowed,lead_time_days,created_at,updated_at)
        VALUES (?,?,?,?,?,'LOCAL-STATUS-900012','LOCAL-FIXTURE-MPN-900012','Unidad de prueba','review',
          'unit','unidad',1,1,1,?,'EUR',800,300,200,100,1,5,?,?)`
      )
      .bind(
        statusVariantId,
        statusVariantLegacyId,
        statusProductId,
        statusDependencies.taxClassId,
        statusDependencies.shippingProfileId,
        statusDependencies.priceCents,
        now,
        now
      ),
    // A discontinued, deliberately unmapped sibling is not a publication
    // candidate. The state engine must neither validate it as sellable nor
    // resurrect/change it while propagating product states.
    database
      .prepare(
        `INSERT INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
          price_gross_cents,created_at,updated_at)
        VALUES (?,?,?,?,'LOCAL-STATUS-RETIRED','Variante retirada','discontinued',0,?,?)`
      )
      .bind(
        retiredStatusVariantId,
        statusProductId,
        statusDependencies.taxClassId,
        statusDependencies.shippingProfileId,
        now,
        now
      )
  ])
  // No inventory balance or movement is fabricated: only the explicit existing
  // backorder + five-day lead-time rule supports this synthetic variant.
  const statusPath = `/api/admin/products/${statusLegacyId}/status`
  const putStatus = (
    input: Record<string, unknown>,
    key: string,
    request: { cookie?: string; requestOrigin?: string; query?: string } = {}
  ) =>
    runtime!.dispatchFetch(`${origin}${statusPath}${request.query ?? ''}`, {
      method: 'PUT',
      headers: {
        origin: request.requestOrigin ?? origin,
        cookie: request.cookie ?? administrator.cookie,
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.123'
      },
      body: JSON.stringify(input),
      redirect: 'manual'
    })
  async function statusFixtureState() {
    const product = await database.prepare('SELECT * FROM products WHERE id=?').bind(statusProductId).first()
    const variants = await database
      .prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id')
      .bind(statusProductId)
      .all<Record<string, unknown>>()
    const ledger = await database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM catalog_product_status_commands WHERE product_id=?1) AS commands,
          (SELECT COUNT(*) FROM catalog_product_status_audit WHERE product_id=?1) AS audits`
      )
      .bind(statusProductId)
      .first<{ commands: number; audits: number }>()
    assert(product && ledger)
    return { product, variants: variants.results, ledger }
  }
  const candidateMain = await runtime.dispatchFetch(`${origin}/api/admin/media/${upload.id}/publications`, {
    method: 'POST',
    headers: {
      origin,
      cookie: administrator.cookie,
      'content-type': 'application/json',
      'idempotency-key': 'isolated-status-main-association',
      'cf-connecting-ip': '192.0.2.123'
    },
    body: JSON.stringify({
      productId: statusProductId,
      variantId: null,
      role: 'main',
      title: 'Synthetic local publication candidate only',
      altText: 'Imagen principal exacta del candidato sintético',
      language: 'es',
      version: 'local-status-audit-v1',
      validFrom: stored.stored_at,
      validUntil: expires
    })
  })
  assert.equal(candidateMain.status, 201)
  const candidateMainMapping = await database
    .prepare(
      "SELECT id FROM product_media_publications WHERE product_id=? AND upload_id=? AND role='main' AND variant_id IS NULL"
    )
    .bind(statusProductId, upload.id)
    .first<{ id: string }>()
  assert(candidateMainMapping)
  // Governed evidence may exist for review, without making drafts/bytes public.
  assert.equal((await fetch(`/api/products/${statusSlug}`)).status, 404)
  assert.equal((await fetch(`/media/${candidateMainMapping.id}/image?w=400&format=jpeg`)).status, 404)
  const statusPrivateDetail = await json<{
    catalogVersion: number
    capabilities: { productUpdate: boolean; productStatusTransition: boolean }
  }>(`/api/admin/products/${statusLegacyId}`, administrator.cookie)
  assert.equal(statusPrivateDetail.catalogVersion, 1)
  assert.equal(statusPrivateDetail.capabilities.productUpdate, false)
  assert.equal(statusPrivateDetail.capabilities.productStatusTransition, true)
  scenario = 'real_catalog_status_private_editor_ssr_controls'
  const statusEditorMarkup = renderedMarkup(
    await html(`/admin/productos/${statusLegacyId}`, 'Cambiar estado editorial', administrator.cookie)
  )
  assert(statusEditorMarkup.includes('Motivo del cambio de estado'))
  assert(statusEditorMarkup.includes('Aplicar cambio de estado'))
  assert(statusEditorMarkup.includes('data-product-status-editor'))
  assert(statusEditorMarkup.includes('id="product-target-status"'))
  const statusInput = {
    status: 'published',
    expectedVersion: statusPrivateDetail.catalogVersion,
    reason: 'Publicación sintética local, no aceptación comercial ni legal'
  }
  const beforeStatus = await statusFixtureState()
  scenario = 'real_catalog_status_missing_policy_atomic_denial'
  const blockedPolicy = await putStatus(statusInput, 'isolated-status-no-policy')
  assert.equal(blockedPolicy.status, 409)
  const blockedPolicyBody = (await blockedPolicy.json()) as {
    error: { code: string; issues?: Array<{ code: string }> }
  }
  assert.equal(blockedPolicyBody.error.code, 'publication_blocked')
  assert(blockedPolicyBody.error.issues?.some((issue) => issue.code === 'policy.missing'))
  assert.deepEqual(await statusFixtureState(), beforeStatus)
  assert.deepEqual(beforeStatus.ledger, { commands: 0, audits: 0 })
  scenario = 'real_catalog_status_live_authority_and_csrf_denial'
  assert.equal((await putStatus(statusInput, 'isolated-status-customer', { cookie: customer.cookie })).status, 403)
  assert.equal(
    (await putStatus(statusInput, 'isolated-status-nonmfa', { cookie: unverifiedAdministrator.cookie })).status,
    403
  )
  assert.equal(
    (await putStatus(statusInput, 'isolated-status-bad-cookie', { cookie: 'neteco-session=invalid-local-token' }))
      .status,
    401
  )
  assert.equal(
    (await putStatus(statusInput, 'isolated-status-csrf', { requestOrigin: 'https://cross-site.example.invalid' }))
      .status,
    403
  )
  assert.equal(
    (await putStatus(statusInput, 'isolated-status-client-clock', { query: '?now=2099-01-01T00:00:00Z' })).status,
    400
  )
  assert.deepEqual(await statusFixtureState(), beforeStatus)
  completed++

  scenario = 'real_catalog_policy_create_assign_and_private_ssr'
  // Exercise the actual HTTP authoring commands, not direct policy/assignment
  // inserts. Decisions remain synthetic and local, never legal acceptance.
  function policyCommand(path: string, method: 'POST' | 'PUT', input: Record<string, unknown>, key: string) {
    return runtime!.dispatchFetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie: administrator.cookie,
        'content-type': 'application/json',
        'idempotency-key': key,
        'cf-connecting-ip': '192.0.2.123'
      },
      body: JSON.stringify(input),
      redirect: 'manual'
    })
  }
  const policyInput = {
    code: 'local_http_fixture',
    name: 'Synthetic local-only reviewed policy',
    expectedVersion: 0,
    requiredFields: ['regulatory.requiresSds'],
    requiredMediaRoles: [],
    identifierExceptionsAllowed: false,
    validFrom: now,
    validUntil: null,
    reason: 'Synthetic local review only, never commercial or legal approval'
  }
  const policyCreated = await policyCommand(
    '/api/admin/catalog/policies',
    'POST',
    policyInput,
    'isolated-policy-create'
  )
  assert.equal(policyCreated.status, 200)
  assert.equal(policyCreated.headers.get('cache-control'), 'private, no-store')
  const policyReceiptText = await policyCreated.text()
  const policyReceipt: CatalogPolicyReceipt = catalogPolicyReceiptSchema.parse(JSON.parse(policyReceiptText))
  assert.equal(policyReceipt.action, 'policy_create')
  assert.equal(policyReceipt.source, 'cloudflare')
  assert.equal(policyReceipt.updated, true)
  assert.equal(policyReceipt.policyVersion, 1)
  assert.equal(policyReceipt.entityId, policyReceipt.resourceId)
  assert.equal(policyReceipt.productId, null)
  const fixturePolicyId = policyReceipt.resourceId
  const policyReplay = await policyCommand('/api/admin/catalog/policies', 'POST', policyInput, 'isolated-policy-create')
  assert.equal(policyReplay.status, 200)
  assert.equal(await policyReplay.text(), policyReceiptText)
  const policyList = await json<CatalogPoliciesView>(
    '/api/admin/catalog/policies?code=local_http_fixture&perPage=1',
    administrator.cookie
  )
  assert.equal(policyList.source, 'cloudflare')
  assert.equal(policyList.pagination.total, 1)
  assert.equal(policyList.items[0]?.id, fixturePolicyId)
  assert.equal(policyList.items[0]?.current, true)
  assert.equal((await fetch('/api/admin/catalog/policies', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/catalog/policies', unverifiedAdministrator.cookie)).status, 403)
  for (const alias of [
    '/api/admin/catalog/%70olicies',
    '/api/admin/catalog/policies%2Fbad%2Fwithdraw',
    `/api/admin/%70roducts/${statusLegacyId}/publication-policy`
  ]) {
    const rejectedAlias = await fetch(alias, administrator.cookie)
    assert.equal(rejectedAlias.status, 400)
    assert.equal(rejectedAlias.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await rejectedAlias.json(), { error: { code: 'invalid_input' } })
  }
  await html('/admin/politicas-catalogo', 'Políticas de publicación', administrator.cookie)
  const assignmentInput = {
    expectedVersion: 1,
    policyId: fixturePolicyId,
    regulatory: { productType: 'local_http_fixture', requiresSds: false },
    reason: 'Synthetic explicit local_http_fixture assignment only, not production approval'
  }
  const assignmentPath = `/api/admin/products/${statusLegacyId}/publication-policy`
  const assigned = await policyCommand(assignmentPath, 'PUT', assignmentInput, 'isolated-policy-assign')
  assert.equal(assigned.status, 200)
  const assignmentReceipt = await assigned.text()
  const assignmentReplay = await policyCommand(assignmentPath, 'PUT', assignmentInput, 'isolated-policy-assign')
  assert.equal(assignmentReplay.status, 200)
  assert.equal(await assignmentReplay.text(), assignmentReceipt)
  const assignedView = await json<ProductPublicationPolicyView>(assignmentPath, administrator.cookie)
  assert.equal(assignedView.catalogVersion, 2)
  assert.equal(assignedView.regulatory.requiresSds, false)
  assert.equal(assignedView.policy?.id, fixturePolicyId)
  const regulatoryRow = await database
    .prepare('SELECT regulatory FROM products WHERE id=?')
    .bind(statusProductId)
    .first<{ regulatory: string }>()
  assert(regulatoryRow)
  assert.equal(JSON.parse(regulatoryRow.regulatory).localAuditOnly, true)
  statusInput.expectedVersion = 2
  completed++

  scenario = 'real_catalog_status_publish_exact_replay_hide_and_no_variant_resurrection'
  const statusPublished = await putStatus(statusInput, 'isolated-status-publish')
  assert.equal(statusPublished.status, 200)
  assert.equal(statusPublished.headers.get('cache-control'), 'private, no-store')
  assert.equal(statusPublished.headers.get('vary'), 'Cookie')
  assert.equal(statusPublished.headers.get('x-ratelimit-limit'), '60')
  const statusReceipt = await statusPublished.text()
  assert.deepEqual(JSON.parse(statusReceipt), {
    source: 'cloudflare',
    productId: statusLegacyId,
    productUuid: statusProductId,
    catalogVersion: 3,
    status: 'published',
    active: true,
    updated: true
  })
  const savedStatusReceipt = await database
    .prepare('SELECT response FROM catalog_product_status_commands WHERE product_id=? AND idempotency_key=?')
    .bind(statusProductId, 'isolated-status-publish')
    .first<{ response: string }>()
  assert.equal(savedStatusReceipt?.response, statusReceipt)
  const statusReplay = await putStatus(statusInput, 'isolated-status-publish')
  assert.equal(statusReplay.status, 200)
  assert.equal(await statusReplay.text(), statusReceipt)
  const publishedState = await statusFixtureState()
  assert.equal(publishedState.product.status, 'published')
  assert.equal(publishedState.product.catalog_version, 3)
  assert.equal(publishedState.variants.find((variant) => variant.id === statusVariantId)?.status, 'published')
  assert.deepEqual(
    publishedState.variants.find((variant) => variant.id === retiredStatusVariantId),
    beforeStatus.variants.find((variant) => variant.id === retiredStatusVariantId)
  )
  const publicCandidate = await json<{ id: number; slug: string; image: string; variants: Array<{ id: number }> }>(
    `/api/products/${statusSlug}`
  )
  assert.equal(publicCandidate.id, statusLegacyId)
  assert.equal(publicCandidate.slug, statusSlug)
  assert.equal(publicCandidate.image, `/media/${candidateMainMapping.id}/image?w=800&format=jpeg`)
  assert.deepEqual(
    publicCandidate.variants.map((variant) => variant.id),
    [statusVariantLegacyId]
  )
  const noopStatus = await putStatus({ ...statusInput, expectedVersion: 3 }, 'isolated-status-new-noop')
  assert.equal(noopStatus.status, 409)
  assert.deepEqual(await noopStatus.json(), { error: { code: 'invalid_transition' } })
  const changedStatusPayload = await putStatus(
    { ...statusInput, reason: 'Different synthetic command' },
    'isolated-status-publish'
  )
  assert.equal(changedStatusPayload.status, 409)
  assert.deepEqual(await changedStatusPayload.json(), { error: { code: 'idempotency_conflict' } })
  assert.deepEqual(await statusFixtureState(), publishedState)
  const withdrawPath = `/api/admin/catalog/policies/${fixturePolicyId}/withdraw`
  const withdrawInput = {
    expectedVersion: 1,
    reason: 'End of synthetic local review; preserve immutable policy history'
  }
  const policyLedgerCounts = () =>
    database
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM catalog_policy_commands) AS commands,
    (SELECT COUNT(*) FROM catalog_policy_audit) AS audits,
    (SELECT COUNT(*) FROM catalog_publication_policy_withdrawals) AS withdrawals`
      )
      .first()
  const beforeInUseWithdrawal = await policyLedgerCounts()
  const inUsePolicy = await policyCommand(withdrawPath, 'POST', withdrawInput, 'isolated-policy-withdraw-in-use')
  assert.equal(inUsePolicy.status, 409)
  assert.deepEqual(await inUsePolicy.json(), { error: { code: 'policy_in_use' } })
  assert.deepEqual(await policyLedgerCounts(), beforeInUseWithdrawal)
  assert.deepEqual(await statusFixtureState(), publishedState)
  const hiddenStatus = await putStatus(
    {
      status: 'hidden',
      expectedVersion: 3,
      reason: 'End of synthetic publication fixture; keep immutable history in disposable D1'
    },
    'isolated-status-hide'
  )
  assert.equal(hiddenStatus.status, 200)
  assert.deepEqual(await hiddenStatus.json(), {
    source: 'cloudflare',
    productId: statusLegacyId,
    productUuid: statusProductId,
    catalogVersion: 4,
    status: 'hidden',
    active: false,
    updated: true
  })
  const hiddenState = await statusFixtureState()
  assert.equal(hiddenState.product.status, 'hidden')
  assert.equal(hiddenState.product.catalog_version, 4)
  assert.equal(hiddenState.variants.find((variant) => variant.id === statusVariantId)?.status, 'hidden')
  assert.deepEqual(
    hiddenState.variants.find((variant) => variant.id === retiredStatusVariantId),
    beforeStatus.variants.find((variant) => variant.id === retiredStatusVariantId)
  )
  assert.deepEqual(hiddenState.ledger, { commands: 2, audits: 2 })
  assert.equal((await fetch(`/api/products/${statusSlug}`)).status, 404)
  assert.equal((await fetch(`/media/${candidateMainMapping.id}/image?w=400&format=jpeg`)).status, 404)
  const historicalStatusReplay = await putStatus(statusInput, 'isolated-status-publish')
  assert.equal(historicalStatusReplay.status, 200)
  assert.equal(await historicalStatusReplay.text(), statusReceipt)
  assert.deepEqual(await statusFixtureState(), hiddenState)
  completed++

  scenario = 'real_policy_withdrawal_replay_and_republication_blocked'
  const withdrawnPolicy = await policyCommand(withdrawPath, 'POST', withdrawInput, 'isolated-policy-withdraw')
  assert.equal(withdrawnPolicy.status, 200)
  const withdrawalReceipt = await withdrawnPolicy.text()
  const withdrawnPolicyReplay = await policyCommand(withdrawPath, 'POST', withdrawInput, 'isolated-policy-withdraw')
  assert.equal(withdrawnPolicyReplay.status, 200)
  assert.equal(await withdrawnPolicyReplay.text(), withdrawalReceipt)
  const withdrawnPolicyView = await json<ProductPublicationPolicyView>(assignmentPath, administrator.cookie)
  assert.equal(withdrawnPolicyView.policy?.withdrawn, true)
  assert.equal(withdrawnPolicyView.policy?.current, false)
  assert.equal(withdrawnPolicyView.catalogVersion, 4)
  const republishWithdrawn = await putStatus({ ...statusInput, expectedVersion: 4 }, 'isolated-status-withdrawn-policy')
  assert.equal(republishWithdrawn.status, 409)
  assert.equal(((await republishWithdrawn.json()) as { error: { code: string } }).error.code, 'publication_blocked')
  assert.deepEqual(await statusFixtureState(), hiddenState)
  // Immutable commands/audit/policy/association history stay in this isolated
  // D1 until runtime.dispose(). The candidate is hidden again, and the final
  // products count continues to report only the original seeded storefront.
  completed++

  scenario = 'real_reviewed_identifier_exception_and_historical_assignment_replay'
  // Remove the synthetic fixture's MPN only after hiding it. Variant editing
  // is not claimed as an implemented API; all governed decisions below use
  // the actual publisher-authorized HTTP commands.
  await database.prepare('UPDATE variants SET mpn=NULL WHERE id=?').bind(statusVariantId).run()
  const exceptionPolicyCreated = await policyCommand(
    '/api/admin/catalog/policies',
    'POST',
    { ...policyInput, expectedVersion: 1, identifierExceptionsAllowed: true },
    'isolated-exception-policy-create'
  )
  assert.equal(exceptionPolicyCreated.status, 200)
  const exceptionPolicyReceipt = catalogPolicyReceiptSchema.parse(await exceptionPolicyCreated.json())
  assert.equal(exceptionPolicyReceipt.policyVersion, 2)
  const exceptionPolicyId = exceptionPolicyReceipt.resourceId
  const exceptionAssigned = await policyCommand(
    assignmentPath,
    'PUT',
    { ...assignmentInput, expectedVersion: 4, policyId: exceptionPolicyId },
    'isolated-exception-policy-assign'
  )
  assert.equal(exceptionAssigned.status, 200)
  const exceptionPath = `/api/admin/products/${statusLegacyId}/identifier-exceptions`
  const exceptionInput = {
    expectedVersion: 5,
    variantId: statusVariantId,
    reason: 'Synthetic reviewed missing identifier, not approval of a genuine product',
    evidenceReference: 'Synthetic local-only review record',
    validFrom: now,
    validUntil: null
  }
  const exceptionCreated = await policyCommand(exceptionPath, 'POST', exceptionInput, 'isolated-identifier-exception')
  assert.equal(exceptionCreated.status, 200)
  const exceptionReceiptText = await exceptionCreated.text()
  const exceptionReceipt: CatalogPolicyReceipt = catalogPolicyReceiptSchema.parse(JSON.parse(exceptionReceiptText))
  assert.equal(exceptionReceipt.catalogVersion, 6)
  assert.equal(exceptionReceipt.policyVersion, 2)
  assert.equal(exceptionReceipt.resourceId, statusVariantId)
  const exceptionReplayed = await policyCommand(exceptionPath, 'POST', exceptionInput, 'isolated-identifier-exception')
  assert.equal(exceptionReplayed.status, 200)
  assert.equal(await exceptionReplayed.text(), exceptionReceiptText)
  const exceptionView = await json<ProductPublicationPolicyView>(assignmentPath, administrator.cookie)
  assert.equal(exceptionView.catalogVersion, 6)
  assert.equal(
    exceptionView.variants.find((variant) => variant.id === statusVariantId)?.identifierException?.id,
    exceptionReceipt.entityId
  )
  const exceptionPublished = await putStatus({ ...statusInput, expectedVersion: 6 }, 'isolated-exception-publish')
  assert.equal(exceptionPublished.status, 200)
  assert.equal((await fetch(`/api/products/${statusSlug}`)).status, 200)
  const exceptionWithdrawPath = `${exceptionPath}/${exceptionReceipt.entityId}/withdraw`
  const exceptionWithdrawInput = {
    expectedVersion: 7,
    reason: 'Withdraw synthetic evidence after hiding; keep all immutable history'
  }
  const publishedExceptionWithdrawal = await policyCommand(
    exceptionWithdrawPath,
    'POST',
    exceptionWithdrawInput,
    'isolated-exception-withdraw-published'
  )
  assert.equal(publishedExceptionWithdrawal.status, 409)
  assert.deepEqual(await publishedExceptionWithdrawal.json(), { error: { code: 'invalid_state' } })
  const exceptionHidden = await putStatus(
    { ...statusInput, status: 'hidden', expectedVersion: 7 },
    'isolated-exception-hide'
  )
  assert.equal(exceptionHidden.status, 200)
  const exceptionWithdrawn = await policyCommand(
    exceptionWithdrawPath,
    'POST',
    { ...exceptionWithdrawInput, expectedVersion: 8 },
    'isolated-exception-withdraw'
  )
  assert.equal(exceptionWithdrawn.status, 200)
  const afterExceptionWithdrawal = await json<ProductPublicationPolicyView>(assignmentPath, administrator.cookie)
  assert.equal(afterExceptionWithdrawal.catalogVersion, 9)
  assert.equal(
    afterExceptionWithdrawal.variants.find((variant) => variant.id === statusVariantId)?.identifierException,
    null
  )
  const afterExceptionState = await statusFixtureState()
  const withdrawnExceptionPublish = await putStatus(
    { ...statusInput, expectedVersion: 9 },
    'isolated-exception-republish-withdrawn'
  )
  assert.equal(withdrawnExceptionPublish.status, 409)
  assert.deepEqual(await statusFixtureState(), afterExceptionState)
  const historicalAssignment = await policyCommand(assignmentPath, 'PUT', assignmentInput, 'isolated-policy-assign')
  assert.equal(historicalAssignment.status, 200)
  assert.equal(await historicalAssignment.text(), assignmentReceipt)
  assert.deepEqual(await statusFixtureState(), afterExceptionState)
  assert.equal((await fetch(`/api/products/${statusSlug}`)).status, 404)
  assert.equal((await fetch(`/media/${candidateMainMapping.id}/image?w=400&format=jpeg`)).status, 404)
  completed++

  scenario = 'real_media_library_ssr_and_private_association_metadata'
  const library = await json<{
    items: Array<{
      id: string
      originalName: string
      sourceUrl: null
      canPublish: boolean
      publications: Array<{ id: string }>
    }>
  }>('/api/admin/media', administrator.cookie)
  const libraryAsset = library.items.find((item) => item.id === upload.id)
  assert(libraryAsset)
  assert.equal(libraryAsset.originalName, safeMediaFilename('local-runtime-fixture.png', 'image/png', upload.id))
  assert.equal(libraryAsset.sourceUrl, null)
  assert.equal(libraryAsset.canPublish, true)
  assert(libraryAsset.publications.some((item) => item.id === publication.id))
  scenario = 'real_media_library_ssr'
  const libraryPage = await html('/admin/medios', libraryAsset.originalName, administrator.cookie)
  assert(renderedMarkup(libraryPage).includes('Asociar'))
  assert(!libraryPage.includes(stored.object_key))
  completed++

  scenario = 'real_cart_do_exact_variant_image_without_product_fallback'
  const variantIdentity = await database
    .prepare(
      "SELECT id, legacy_id AS legacyId, minimum_quantity AS quantity FROM variants WHERE product_id = ? AND status = 'published' ORDER BY legacy_id LIMIT 1"
    )
    .bind(productIdentity.id)
    .first<{ id: string; legacyId: number; quantity: number }>()
  assert(variantIdentity)
  const emptyCart = await fetch('/api/cart')
  assert.equal(emptyCart.status, 200)
  const cartCookie = emptyCart.headers
    .getSetCookie()
    .find((value) => value.startsWith('neteco-cart-v2='))
    ?.split(';')[0]
  assert(cartCookie)
  const emptyCartView = (await emptyCart.json()) as { id: string; version: number }
  assert.equal(typeof emptyCartView.id, 'string')
  assert(emptyCartView.id.length > 0)
  const cartVersion = emptyCartView.version
  const originalCartAddIntent = {
    variantId: variantIdentity.legacyId,
    quantity: variantIdentity.quantity,
    expectedVersion: cartVersion,
    idempotencyKey: randomUUID()
  }
  const postOriginalCartAdd = (expectedCartId: string) =>
    runtime!.dispatchFetch(`${origin}/api/cart/items`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'cf-connecting-ip': '192.0.2.123',
        cookie: cartCookie,
        'x-neteco-cart-id': expectedCartId
      },
      body: JSON.stringify(originalCartAddIntent),
      redirect: 'manual'
    })
  const addedCart = await postOriginalCartAdd(emptyCartView.id)
  assert.equal(addedCart.status, 200)
  const beforePhoto = (await addedCart.json()) as { items: Array<{ image: string | null }>; subtotal: number }
  assert.equal(beforePhoto.items[0]!.image, null)

  scenario = 'real_cart_add_receipt_exact_original_intent_and_key'
  const originalCartCommand = await database
    .prepare('SELECT cart_id AS cartId FROM cart_commands WHERE command_id = ?')
    .bind(originalCartAddIntent.idempotencyKey)
    .first<{ cartId: string }>()
  assert(originalCartCommand, 'The actual ADD must have committed a durable D1 command')
  assert.equal(originalCartCommand.cartId, emptyCartView.id, 'The ADD must target the originally observed cart')
  const cartReceiptSnapshot = async () => ({
    carts: (await database.prepare('SELECT * FROM carts ORDER BY id').all()).results,
    lines: (await database.prepare('SELECT * FROM cart_lines ORDER BY cart_id, variant_id').all()).results,
    commands: (await database.prepare('SELECT * FROM cart_commands ORDER BY cart_id, command_id').all()).results
  })
  const beforeCartReceiptReads = await cartReceiptSnapshot()
  const receiptPath = (key: string, quantity = originalCartAddIntent.quantity) =>
    `/api/cart/operations/${encodeURIComponent(key)}?${new URLSearchParams({
      variantId: String(originalCartAddIntent.variantId),
      quantity: String(quantity),
      expectedVersion: String(originalCartAddIntent.expectedVersion)
    })}`
  const appliedReceipt = await fetch(receiptPath(originalCartAddIntent.idempotencyKey), cartCookie)
  assert.equal(appliedReceipt.status, 200)
  assert.equal(appliedReceipt.headers.get('set-cookie'), null, 'Receipt observation must not replace the cart')
  assert.deepEqual(await appliedReceipt.json(), {
    source: 'cloudflare',
    cartId: originalCartCommand.cartId,
    commandId: originalCartAddIntent.idempotencyKey,
    outcome: 'applied',
    appliedVersion: originalCartAddIntent.expectedVersion + 1
  })
  completed++

  scenario = 'real_cart_add_receipt_unknown_is_not_no_effect'
  const unknownCartCommand = randomUUID()
  const unknownReceipt = await fetch(receiptPath(unknownCartCommand), cartCookie)
  assert.equal(unknownReceipt.status, 200)
  assert.equal(unknownReceipt.headers.get('set-cookie'), null)
  assert.deepEqual(await unknownReceipt.json(), {
    source: 'cloudflare',
    cartId: originalCartCommand.cartId,
    commandId: unknownCartCommand,
    outcome: 'unknown',
    appliedVersion: null
  })
  completed++

  scenario = 'real_cart_add_receipt_changed_quantity_conflicts_without_replay'
  const changedQuantity = originalCartAddIntent.quantity === 1 ? 2 : 1
  const conflictingReceipt = await fetch(receiptPath(originalCartAddIntent.idempotencyKey, changedQuantity), cartCookie)
  assert.equal(conflictingReceipt.status, 409)
  assert.deepEqual(await conflictingReceipt.json(), { error: { code: 'conflict' } })
  assert.equal(conflictingReceipt.headers.get('set-cookie'), null)
  completed++

  scenario = 'real_cart_add_receipt_wrong_cookie_denied'
  const wrongCartCookie = cartCookie.slice(0, -1) + (cartCookie.endsWith('a') ? 'b' : 'a')
  const unauthorizedReceipt = await fetch(receiptPath(originalCartAddIntent.idempotencyKey), wrongCartCookie)
  assert.equal(unauthorizedReceipt.status, 401)
  assert.deepEqual(await unauthorizedReceipt.json(), { error: { code: 'unauthorized' } })
  assert.equal(unauthorizedReceipt.headers.get('set-cookie'), null)
  completed++

  scenario = 'real_cart_add_expected_other_cart_header_conflicts_without_state_changes'
  const otherExpectedCartId = randomUUID()
  assert.notEqual(otherExpectedCartId, emptyCartView.id)
  const wrongExpectedCart = await postOriginalCartAdd(otherExpectedCartId)
  assert.equal(wrongExpectedCart.status, 409)
  assert.deepEqual(await wrongExpectedCart.json(), { error: { code: 'conflict' } })
  assert.equal(wrongExpectedCart.headers.get('set-cookie'), null)
  assert.deepEqual(await cartReceiptSnapshot(), beforeCartReceiptReads)
  completed++

  scenario = 'real_cart_add_receipt_reads_leave_d1_cart_lines_and_ledger_unchanged'
  assert.deepEqual(await cartReceiptSnapshot(), beforeCartReceiptReads)
  const nativeCartAddReceiptAudit = {
    scenarios: 6,
    originalIntentRecovered: true,
    unknownIsNotNoEffect: true,
    quantityConflictRejected: true,
    wrongCookieDenied: true,
    expectedOtherCartRejectedWithoutWrites: true,
    receiptReadsHaveNoCartWrites: true
  }
  completed++
  scenario = 'real_cart_do_exact_variant_image_without_product_fallback'
  const variantPublicationResponse = await runtime.dispatchFetch(
    `${origin}/api/admin/media/${upload.id}/publications`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: administrator.cookie,
        'cf-connecting-ip': '192.0.2.123',
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify({
        productId: productIdentity.id,
        variantId: variantIdentity.id,
        role: 'main',
        title: 'Exact local SKU fixture',
        altText: 'Imagen sintética del SKU exacto',
        language: 'es',
        version: 'local-sku-v1',
        validFrom: stored.stored_at,
        validUntil: expires
      })
    }
  )
  assert.equal(variantPublicationResponse.status, 201)
  const variantPublication = ((await variantPublicationResponse.json()) as { publication: { id: string } }).publication
  const withPhoto = await json<{ items: Array<{ image: string; imageAlt: string }>; subtotal: number }>(
    '/api/cart',
    cartCookie
  )
  assert.equal(withPhoto.items[0]!.image, `/media/${variantPublication.id}/image?w=800&format=jpeg`)
  assert.equal(withPhoto.items[0]!.imageAlt, 'Imagen sintética del SKU exacto')
  assert.equal(withPhoto.subtotal, beforePhoto.subtotal)
  completed++

  scenario = 'real_offline_images_avif_webp_jpeg_derivatives'
  for (const format of ['avif', 'webp', 'jpeg'] as const) {
    const derivative = await fetch(`/media/${publication.id}/image?w=400&format=${format}`)
    assert.equal(derivative.status, 200)
    assert.equal(derivative.headers.get('content-type'), `image/${format}`)
    assert.match(derivative.headers.get('cache-control') ?? '', /no-store/)
    const bytes = new Uint8Array(await derivative.arrayBuffer())
    const decoded = await sharp(bytes).metadata()
    assert.equal(decoded.width, 400)
    assert.equal(decoded.height, 400)
    assert(!Buffer.from(bytes).equals(original))
  }
  const publicDetail = await json<{ image: string; imageAlt: string }>(`/api/products/${firstProduct.slug}`)
  assert.equal(publicDetail.image, `/media/${publication.id}/image?w=800&format=jpeg`)
  assert.equal(publicDetail.imageAlt, 'Imagen sintética de auditoría local')
  const renderedProduct = await html(`/producto/${firstProduct.slug}`, firstProduct.name)
  assert(renderedMarkup(renderedProduct).includes('type="image/avif"'))
  // The PDP selects the exact variant's approved image, not the generic product photo.
  assert(renderedMarkup(renderedProduct).includes(`/media/${variantPublication.id}/image`))
  assert.equal((await fetch('/img/products/delenex/a.jpg')).status, 404)
  assert.equal((await fetch('/img/%70roducts/delenex/a.jpg')).status, 400)
  assert.equal((await fetch(`/MEDIA/${publication.id}/image?w=400&format=jpeg`)).status, 404)
  completed++

  scenario = 'real_infected_scan_same_second_revokes_product_and_cart_bytes'
  const infectedBody = JSON.stringify({ ...JSON.parse(scanBody), receiptId: randomUUID(), verdict: 'infected' })
  const infected = await runtime.dispatchFetch(`${origin}/api/media/scan-receipts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '192.0.2.123',
      'x-media-scan-signature': `sha256=${createHmac('sha256', mediaScanSecret).update(infectedBody).digest('hex')}`
    },
    body: infectedBody
  })
  assert.equal(infected.status, 201)
  assert.equal((await fetch(`/media/${publication.id}/image?w=400&format=jpeg`)).status, 404)
  assert.equal((await fetch(`/media/${variantPublication.id}/image?w=400&format=jpeg`)).status, 404)
  const revokedPhoto = await json<{
    items: Array<{ image: string | null; imageAlt: string | null }>
    subtotal: number
  }>('/api/cart', cartCookie)
  assert.equal(revokedPhoto.items[0]!.image, null)
  assert.equal(revokedPhoto.items[0]!.imageAlt, null)
  assert.equal(revokedPhoto.subtotal, beforePhoto.subtotal)
  completed++

  scenario = 'media_withdrawal_immediately_blocks_manifest_and_bytes'
  const withdrawn = await runtime.dispatchFetch(`${origin}/api/admin/media/publications/${publication.id}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: administrator.cookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID(),
      'if-match': '1'
    },
    body: JSON.stringify({ reason: 'End of isolated local audit fixture' })
  })
  assert.equal(withdrawn.status, 200)
  assert.equal((await fetch(`/media/${publication.id}/image?w=400&format=jpeg`)).status, 404)
  const remainingMain = await database
    .prepare("SELECT id FROM product_media_publications WHERE product_id=? AND upload_id=? AND role='main'")
    .bind(productIdentity.id, bootstrapUploadId)
    .first<{ id: string }>()
  assert(remainingMain)
  // The revoked mapping must never return, but this product still has the
  // independent, explicitly attested bootstrap main image. Do not mistake
  // valid evidence for the revoked upload or weaken the current-main gate.
  assert.equal(
    (await json<{ image: string | null }>(`/api/products/${firstProduct.slug}`)).image,
    `/media/${remainingMain.id}/image?w=800&format=jpeg`
  )
  completed++

  scenario = 'authenticated_customer_account_api'
  const account = await json<{ profile: { name: string } }>('/api/account', customer.cookie)
  assert.equal(account.profile.name, customer.name)
  const orders = await json<{ orders: unknown[] }>('/api/orders', customer.cookie)
  assert.deepEqual(orders.orders, [])
  completed++

  scenario = 'authenticated_customer_orders_ssr'
  const customerPage = await html('/cuenta/pedidos', 'Mis pedidos', customer.cookie)
  assert(renderedMarkup(customerPage).includes(customer.name))
  assert(renderedMarkup(customerPage).includes('Todavía no tienes pedidos'))
  completed++

  scenario = 'authenticated_cross_site_document_navigation_ssr'
  const externalNavigation = {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    // dispatchFetch uses Undici.fetch, which otherwise rewrites this browser
    // header to "cors". Miniflare's official ingress shim restores the exact
    // value in workerd and removes its internal MF header before the Worker.
    'MF-Sec-Fetch-Mode': 'navigate'
  }
  const externallyReachedAccount = await html('/cuenta/pedidos', 'Mis pedidos', customer.cookie, externalNavigation)
  assert(renderedMarkup(externallyReachedAccount).includes(customer.name))
  const crossSiteApi = await fetch('/api/_auth/session', customer.cookie, externalNavigation)
  assert.equal(crossSiteApi.status, 403)
  assert.deepEqual(await crossSiteApi.json(), { error: { code: 'csrf_rejected' } })
  completed++

  scenario = 'authenticated_admin_mfa_api'
  const administrativeOrders = await json<{ items: unknown[]; capabilities: { orderStatusUpdate: boolean } }>(
    '/api/admin/orders',
    administrator.cookie
  )
  assert.deepEqual(administrativeOrders.items, [])
  assert.equal(administrativeOrders.capabilities.orderStatusUpdate, false)
  const deniedAdmin = await fetch('/api/admin/orders', unverifiedAdministrator.cookie)
  assert.equal(deniedAdmin.status, 403)
  assert.deepEqual(await deniedAdmin.json(), { error: { code: 'mfa_required' } })
  completed++

  scenario = 'real_inventory_operations_expiry_ledger_and_readonly_ssr'
  type InventoryOperations = {
    source: string
    summary: Record<string, number | null>
    capabilities: Record<string, boolean>
  }
  const initialInventory = await json<InventoryOperations>('/api/admin/operations', administrator.cookie)
  assert.equal(initialInventory.source, 'cloudflare')
  assert.equal(initialInventory.capabilities.inventoryExceptions, true)
  assert.equal(initialInventory.summary.inventoryExceptions, 0)
  assert.equal(initialInventory.summary.inventoryLedgerDivergences, 0)
  const inventoryFixture = await database
    .prepare(
      `SELECT b.variant_id AS variantId, b.location_id AS locationId
       FROM inventory_balances b JOIN variants v ON v.id = b.variant_id
       WHERE b.physical_quantity - b.blocked_quantity - v.safety_stock >= 1
       ORDER BY b.variant_id LIMIT 1`
    )
    .first<{ variantId: string; locationId: string }>()
  assert(inventoryFixture)
  const inventoryKey = `local-operations:${randomUUID()}`
  const reservationAt = new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const reservationUntil = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expiredInventoryReservation = await reserveInventory(database, {
    idempotencyKey: inventoryKey,
    correlationId: 'isolated-operations-audit',
    now: reservationAt,
    expiresAt: reservationUntil,
    lines: [{ ...inventoryFixture, quantity: 1 }],
    reason: 'Synthetic local TTL fixture only'
  })
  assert.equal(expiredInventoryReservation.outcome, 'reserved')
  const pendingExpiry = await json<InventoryOperations>('/api/admin/operations', administrator.cookie)
  assert.equal(pendingExpiry.summary.inventoryReservationExpiryPending, 1)
  assert.equal(pendingExpiry.summary.inventoryLedgerDivergences, 0)
  assert.equal(pendingExpiry.summary.inventoryExceptions, 0)
  assert.equal(
    (
      await database
        .prepare('SELECT status FROM inventory_reservations WHERE idempotency_key = ?')
        .bind(inventoryKey)
        .first<{ status: string }>()
    )?.status,
    'reserved'
  )
  await database
    .prepare(
      'UPDATE inventory_balances SET physical_quantity = physical_quantity + 1 WHERE variant_id = ? AND location_id = ?'
    )
    .bind(inventoryFixture.variantId, inventoryFixture.locationId)
    .run()
  const driftedInventory = await json<InventoryOperations>('/api/admin/operations', administrator.cookie)
  assert.equal(driftedInventory.summary.inventoryLedgerDivergences, 1)
  assert.equal(driftedInventory.summary.inventoryExceptions, 1)
  assert.equal(driftedInventory.summary.inventoryReservationExpiryPending, 1)
  await html('/admin/operaciones', 'Liberación pendiente', administrator.cookie)
  await database
    .prepare(
      'UPDATE inventory_balances SET physical_quantity = physical_quantity - 1 WHERE variant_id = ? AND location_id = ?'
    )
    .bind(inventoryFixture.variantId, inventoryFixture.locationId)
    .run()
  assert.equal(
    (
      await releaseReservation(database, {
        idempotencyKey: inventoryKey,
        correlationId: 'isolated-operations-audit',
        now: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        reason: 'Synthetic fixture cleanup only'
      })
    ).outcome,
    'applied'
  )
  const reconciledInventory = await json<InventoryOperations>('/api/admin/operations', administrator.cookie)
  assert.equal(reconciledInventory.summary.inventoryExceptions, 0)
  assert.equal(reconciledInventory.summary.inventoryReservationExpiryPending, 0)
  completed++

  scenario = 'authenticated_admin_dashboard_ssr'
  await html('/admin', 'Panel de administración', administrator.cookie)
  completed++

  const nativeDispatch = async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers)
    // Undici rewrites Sec-Fetch-Mode. Only the original browser metadata may
    // populate Miniflare's ingress shim; never trust an incoming MF override.
    headers.delete('MF-Sec-Fetch-Mode')
    const fetchMode = headers.get('sec-fetch-mode')
    if (fetchMode !== null) headers.set('MF-Sec-Fetch-Mode', fetchMode)
    // Mimic Cloudflare's reserved ingress address for helpers that do not
    // supply one; this is local test traffic, never a real client IP.
    if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '192.0.2.123')
    const result = await runtime!.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(headers),
      body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
      redirect: 'manual'
    })
    // Miniflare's standards-compliant response is from its own fetch realm.
    return result as unknown as Response
  }
  const markScenario = (name: string) => {
    scenario = name
  }
  const countImportApprover = await identity('warehouse', true)
  const countImportVariantLegacyId = createdIdentity.variantId
  assert(countImportVariantLegacyId !== null, 'Count imports require the existing real legacy variant mapping')
  const inventoryCountImportAudit = await auditNativeInventoryCountImport({
    dispatch: nativeDispatch,
    database,
    origin,
    proposerCookie: inventoryApprover.cookie,
    approverCookie: countImportApprover.cookie,
    unprivilegedCookie: customer.cookie,
    variantLegacyId: countImportVariantLegacyId,
    scenario: markScenario
  })
  completed += inventoryCountImportAudit.scenarios
  const inventoryCountImportBrowserAudit = await auditNativeInventoryCountImportBrowser({
    dispatch: nativeDispatch,
    database,
    origin,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepare() {
      const proposer = await identity('warehouse', true)
      const approver = await identity('warehouse', true)
      const stock = adminInventoryVariantSchema.parse(
        await json(`/api/admin/inventory/variants/${countImportVariantLegacyId}`, proposer.cookie)
      )
      const countedPhysicalQuantity = stock.balance.physicalQuantity + 1
      assert(Number.isSafeInteger(countedPhysicalQuantity))
      return {
        proposerCookie: proposer.cookie,
        approverCookie: approver.cookie,
        variantLegacyId: stock.variant.id,
        sku: stock.variant.sku,
        physicalQuantity: stock.balance.physicalQuantity,
        balanceVersion: stock.balance.version,
        countedPhysicalQuantity
      }
    }
  })
  assert.equal(
    inventoryCountImportBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS.length
  )
  completed += inventoryCountImportBrowserAudit.scenarios
  const cmsAudit = await auditNativeCmsDrafts({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: inventoryOperator.cookie,
    scenario: markScenario
  })
  completed += cmsAudit.scenarios
  await html('/admin/contenido', 'CMS de borradores', administrator.cookie)
  const checkoutAudit = await auditNativeCheckoutPayment({
    dispatch: nativeDispatch,
    database,
    origin,
    variantId: variantIdentity.legacyId,
    quantity: variantIdentity.quantity,
    scenario: markScenario
  })
  completed += checkoutAudit.scenarios
  const preparationAudit = await auditNativeFulfillment({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    orderId: checkoutAudit.orderId,
    scenario: markScenario
  })
  completed += preparationAudit.scenarios
  await html(
    `/admin/pedidos/${checkoutAudit.orderId}`,
    'Contexto operativo confirmado del pedido',
    administrator.cookie
  )
  const fiscalAudit = await auditNativeFiscal({
    dispatch: nativeDispatch,
    database,
    bucket: localBindings.MEDIA,
    origin,
    adminCookie: administrator.cookie,
    guestCookie: checkoutAudit.guestCookie,
    outsiderCookie: customer.cookie,
    orderId: checkoutAudit.orderId,
    scenario: markScenario
  })
  completed += fiscalAudit.scenarios

  // Phase 2 is additive. Keep every existing native/SSR scenario, the original
  // paid order, its reservation and fiscal evidence intact. No resets, retro-
  // active customer claims or manufactured payment facts are permitted here.
  const phase2Baseline = completed
  const cmsPublicationAudit = await auditNativeCmsPublication({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: inventoryApprover.cookie,
    // This owned R2 original has independent clean scan/rights evidence. The
    // later upload.id fixture was intentionally infected and cannot be reused.
    imageUploadId: bootstrapUploadId,
    scenario: markScenario
  })
  completed += cmsPublicationAudit.scenarios

  scenario = 'native_phase2_existing_stock_and_quantity_rules_no_reset'
  const phase2Rules = await database
    .prepare(
      'SELECT minimum_quantity AS minimumQuantity,quantity_increment AS quantityIncrement,maximum_quantity AS maximumQuantity FROM variants WHERE id=?'
    )
    .bind(variantIdentity.id)
    .first<{ minimumQuantity: number; quantityIncrement: number; maximumQuantity: number | null }>()
  assert(phase2Rules, 'Native phase 2 quantity rules are missing')
  const guestQuantity = variantIdentity.quantity
  const preferredReturnQuantity =
    phase2Rules.minimumQuantity +
    Math.ceil(Math.max(0, 2 - phase2Rules.minimumQuantity) / phase2Rules.quantityIncrement) *
      phase2Rules.quantityIncrement
  const returnQuantity =
    phase2Rules.maximumQuantity !== null && preferredReturnQuantity > phase2Rules.maximumQuantity
      ? phase2Rules.minimumQuantity
      : preferredReturnQuantity
  validateQuantity(guestQuantity, phase2Rules)
  validateQuantity(returnQuantity, phase2Rules)
  const phase2Inventory = adminInventoryVariantSchema.parse(
    await json(`/api/admin/inventory/variants/${variantIdentity.legacyId}`, inventoryApprover.cookie)
  )
  assert.equal(phase2Inventory.variant.uuid, variantIdentity.id)
  assert(
    phase2Inventory.balance.sellableQuantity >= guestQuantity + returnQuantity,
    'Native phase 2 requires genuine remaining stock for both new checkouts'
  )
  completed++

  const runtimeCheckoutAudit = await auditNativeCheckoutPayment({
    dispatch: nativeDispatch,
    database,
    origin,
    variantId: variantIdentity.legacyId,
    quantity: guestQuantity,
    scenario: markScenario
  })
  completed += runtimeCheckoutAudit.scenarios
  assert.notEqual(runtimeCheckoutAudit.orderId, checkoutAudit.orderId)
  assert.equal(
    await database
      .prepare('SELECT id FROM fiscal_invoice_intents WHERE order_id=?')
      .bind(runtimeCheckoutAudit.orderId)
      .first(),
    null
  )

  // These are actual Worker-compatible domain executors in the host process
  // with native D1/R2 bindings, NOT workerd's scheduled/Queue entrypoint. Their
  // server-owned local config is independent of the disabled Worker bindings.
  const localFiscalEnvironment: Parameters<typeof configuredFiscalProvider>[0] = {
    APP_ENV: 'local',
    DB: database,
    MEDIA: localBindings.MEDIA,
    IMAGES: localBindings.IMAGES,
    AUTH_ORIGIN: origin,
    FISCAL_LOCAL_VALIDATION_ENABLED: 'true',
    FISCAL_ISSUANCE_ENABLED: 'false',
    FISCAL_POLICY_IDS: '[]',
    BEPLY_ENABLED: 'false'
  }
  const denyExternalFetch: typeof globalThis.fetch = async () => {
    outgoingRequests++
    throw new Error('External providers are disabled in the local native audit')
  }
  const sentMessages: Parameters<TransactionalEmailSender['send']>[0][] = []
  const fakeLocalSender: TransactionalEmailSender = {
    async send(message) {
      assert(/@[^@]+\.(?:test|invalid)$/.test(message.to), 'Only synthetic local recipients may enter this fake sender')
      assert.equal(message.from, 'synthetic-orders@example.test')
      // Retain only in disposable memory for the helper assertions. Do not
      // print recipients, bodies, fiscal references, cookies or bearer URLs.
      sentMessages.push(Object.freeze({ ...message }))
      return { messageId: `synthetic-local-email-${randomUUID()}` }
    }
  }
  const emailTransportMessages: EmailDispatchMessage[] = []
  const serverNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  async function deliverEmailTransport(eventId: string) {
    const report = await publishEmailOutbox(
      database,
      {
        async send(message) {
          const receipt = await receiveEmailDispatch(database, message, serverNow())
          assert(
            receipt === 'stored' || receipt === 'replayed',
            'Native email transport failed to produce a durable consumer receipt'
          )
          emailTransportMessages.push(Object.freeze({ ...message }))
        }
      },
      { now: serverNow(), limit: 100 }
    )
    assert.equal(report.retryable, 0)
    assert.equal(report.lostLease, 0)
    assert.equal(report.manualReview, 0)
    const transported = emailTransportMessages.find((message) => message.eventId === eventId)
    assert(transported, 'Requested email did not traverse the actual outbox publisher')
    // Actual idempotent consumer redelivery, never a manufactured inbox row.
    assert.equal(await receiveEmailDispatch(database, transported, serverNow()), 'replayed')
  }
  const runtimeEmailAudit = await auditNativeFiscalRuntimeEmail({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    orderId: runtimeCheckoutAudit.orderId,
    runFiscal: (configuration) =>
      dispatchFiscalRuntime(
        {
          database,
          storage: createFiscalPdfStorage(localBindings.MEDIA),
          providerResolver: (policy) => configuredFiscalProvider(localFiscalEnvironment, policy, denyExternalFetch)
        },
        configuration
      ),
    runEmails: (configuration) => dispatchTransactionalEmails(database, fakeLocalSender, configuration),
    deliverEmailTransport,
    sentMessages: () => sentMessages,
    scenario: markScenario
  })
  completed += runtimeEmailAudit.scenarios

  const ownedCheckoutAudit = await auditNativeCheckoutPayment({
    dispatch: nativeDispatch,
    database,
    origin,
    variantId: variantIdentity.legacyId,
    quantity: returnQuantity,
    ownerCookie: customer.cookie,
    scenario: markScenario
  })
  completed += ownedCheckoutAudit.scenarios
  assert.notEqual(ownedCheckoutAudit.orderId, checkoutAudit.orderId)
  assert.notEqual(ownedCheckoutAudit.orderId, runtimeCheckoutAudit.orderId)
  const ownership = await database
    .prepare(
      'SELECT o.customer_id AS orderCustomer,i.customer_id AS currentCustomer FROM orders o JOIN identities i ON i.id=?2 WHERE o.id=?1'
    )
    .bind(ownedCheckoutAudit.orderId, customer.identityId)
    .first<{ orderCustomer: string | null; currentCustomer: string | null }>()
  assert(
    ownership?.orderCustomer && ownership.orderCustomer === ownership.currentCustomer,
    'Authenticated native checkout did not establish current customer ownership'
  )
  const ownedPreparationAudit = await auditNativeFulfillment({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario
  })
  completed += ownedPreparationAudit.scenarios
  scenario = 'native_customer_confirmed_fulfillment_projection'
  const customerPreparedResponse = await nativeDispatch(
    new Request(`${origin}/api/orders/${ownedCheckoutAudit.orderId}/lines`, {
      headers: { Cookie: customer.cookie }
    })
  )
  assert.equal(customerPreparedResponse.status, 200)
  assert.match(customerPreparedResponse.headers.get('cache-control') ?? '', /no-store/)
  const customerPrepared = (await customerPreparedResponse.json()) as Record<string, unknown>
  assert.equal(customerPrepared.orderId, ownedCheckoutAudit.orderId)
  assert.equal(customerPrepared.fulfillmentStatus, ownedPreparationAudit.finalState)
  assert.equal(customerPrepared.shipment, null, 'An operational state is not carrier tracking evidence')
  assert(Array.isArray(customerPrepared.lines) && customerPrepared.lines.length > 0)
  const customerPreparedListResponse = await nativeDispatch(
    new Request(`${origin}/api/orders`, { headers: { Cookie: customer.cookie } })
  )
  assert.equal(customerPreparedListResponse.status, 200)
  const customerPreparedList = (await customerPreparedListResponse.json()) as {
    orders: Array<{ id: string; status: string }>
  }
  assert.equal(
    customerPreparedList.orders.find((order) => order.id === ownedCheckoutAudit.orderId)?.status,
    'entregado'
  )
  for (const privateField of ['actorId', 'reason', 'evidence', 'warehouse', 'timeline', 'commandId'])
    assert.equal(Object.hasOwn(customerPrepared, privateField), false)
  const foreignPreparedResponse = await nativeDispatch(
    new Request(`${origin}/api/orders/${ownedCheckoutAudit.orderId}/lines`, {
      headers: { Cookie: administrator.cookie }
    })
  )
  assert.equal(foreignPreparedResponse.status, 404)
  completed += 1
  const returnsAudit = await auditNativeReturns({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    // Existing verified admin fixture also has a distinct active customer;
    // it cannot read the buyer's private customer resource despite its role.
    outsiderCookie: administrator.cookie,
    guestCookie: ownedCheckoutAudit.guestCookie,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario
  })
  completed += returnsAudit.scenarios
  assert.equal(returnsAudit.inventoryUnchanged, true)
  assert.equal(returnsAudit.contractUnchanged, true)
  assert.equal(returnsAudit.economicEffects, false)
  const phase2Scenarios = completed - phase2Baseline
  const phase2CapturedSyntheticMessages = sentMessages.length

  // Phase 3 preserves every preceding scenario and every captured contract.
  // Only this disposable runtime changes opt-ins, never wrangler vars, shared
  // resources or production switches. OFF router assertions above stay real.
  const phase3Baseline = completed
  scenario = 'native_phase3_disposable_opt_ins_preserve_d1_r2_and_session_authority'
  async function persistentEvidence() {
    const batches = await database.batch([
      database.prepare('SELECT id,reservation_id,customer_id,status,total_gross_cents FROM orders ORDER BY id'),
      database.prepare('SELECT * FROM order_lines ORDER BY order_id,line_index'),
      database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'),
      database.prepare('SELECT * FROM inventory_movements ORDER BY id'),
      database.prepare('SELECT * FROM order_payment_states ORDER BY order_id'),
      database.prepare('SELECT * FROM order_returns ORDER BY id'),
      database.prepare('SELECT * FROM fiscal_documents ORDER BY id')
    ])
    assert(
      batches.every((batch) => batch.success),
      'Native persistence snapshot is unconfirmed'
    )
    return createHash('sha256')
      .update(JSON.stringify(batches.map((batch) => batch.results)))
      .digest('hex')
  }
  const beforeRuntimeReload = await persistentEvidence()
  const syntheticSupportPolicy = supportPolicySchema.parse({
    reference: 'explicit-local-audit-policy-not-legal-acceptance',
    version: 1,
    privacyNoticePath: '/privacidad',
    retentionDays: 1,
    responseMinutes: null,
    serviceHoursDescription: null
  })
  assert(!('workers' in auditOptions), 'Native audit must own exactly one local Worker')
  const phase3Options: Parameters<typeof convertV4MiniflareOptions>[0] = {
    ...auditOptions,
    bindings: {
      ...auditOptions.bindings,
      REFUNDS_ENABLED: 'true',
      REFUND_LOCAL_VALIDATION_ENABLED: 'true',
      CREDIT_LOCAL_VALIDATION_ENABLED: 'true',
      // Dispatch stays OFF and policy allowlists empty in workerd; explicit
      // host executors below receive governed policies one by one.
      REFUND_DISPATCH_ENABLED: 'false',
      REFUND_POLICY_IDS: '[]',
      CREDIT_DISPATCH_ENABLED: 'false',
      CREDIT_POLICY_IDS: '[]',
      SUPPORT_ENABLED: 'true',
      SUPPORT_POLICY: JSON.stringify(syntheticSupportPolicy),
      SUPPORT_ATTACHMENTS_ENABLED: 'true',
      SUPPORT_SCAN_SECRET: supportScanSecret,
      SUPPORT_TURNSTILE_ENABLED: 'false',
      NEWSLETTER_EDITORIAL_ENABLED: 'true',
      NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED: 'true',
      NEWSLETTER_LOCAL_VALIDATION_ENABLED: 'true',
      NEWSLETTER_HMAC_KEY: newsletterHmacKey.toString('base64url'),
      NEWSLETTER_PUBLIC_ORIGIN: origin,
      NEWSLETTER_EMAIL_FROM: 'synthetic-newsletter@example.test',
      NEWSLETTER_CAMPAIGN_ALLOWED_RECIPIENTS: '[]',
      NEWSLETTER_FEEDBACK_ENABLED: 'true',
      NEWSLETTER_FEEDBACK_SECRET: newsletterFeedbackSecret,
      // Workerd transactional delivery remains OFF. Renderer proof and fake
      // sender acceptance occur only in the explicitly labelled host callback.
      TRANSACTIONAL_EMAIL_ENABLED: 'false',
      TRANSACTIONAL_EMAIL_RENDERER_KEYS: '[]',
      TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED: 'false'
    }
  }
  await runtime.setOptions(nativeShopRuntimeOptions(phase3Options, queueTransportSecret))
  await runtime.ready
  // Miniflare invalidates binding proxies on reload; never retain old D1/R2
  // stubs in host callbacks or claim a reset database as persistent evidence.
  localBindings = await runtime.getBindings<Pick<CloudflareEnv, 'DB' | 'MEDIA' | 'IMAGES'>>()
  database = localBindings.DB
  assert.equal(await persistentEvidence(), beforeRuntimeReload)
  assert.equal((await fetch('/api/_auth/session', customer.cookie)).status, 200)
  const reloadedBootstrapObject = await localBindings.MEDIA.get(bootstrapKey)
  assert(reloadedBootstrapObject, 'Owned R2 bytes must survive the disposable runtime reload')
  const reloadedBootstrapBytes = await reloadedBootstrapObject.arrayBuffer()
  assert.equal(reloadedBootstrapBytes.byteLength, bootstrapImage.byteLength)
  assert.equal(createHash('sha256').update(new Uint8Array(reloadedBootstrapBytes)).digest('hex'), bootstrapHash)
  completed++

  scenario = 'native_phase3_explicit_synthetic_support_grants_not_customer_authority'
  const supportPermissionCodes = ['support.manage', 'orders.read', 'payments.read', 'invoices.read'] as const
  await database.batch([
    ...supportPermissionCodes.map((permission) =>
      database
        .prepare(
          'INSERT INTO permissions(code,resource,action,description) VALUES(?1,?2,?3,?4) ON CONFLICT(code) DO NOTHING'
        )
        .bind(permission, ...permission.split('.'), 'Explicit disposable existing-permission fixture only')
    ),
    ...supportPermissionCodes.map((permission) =>
      database
        .prepare("INSERT INTO role_permissions(role_code,permission_code) VALUES('admin',?1) ON CONFLICT DO NOTHING")
        .bind(permission)
    )
  ])
  assert.equal((await fetch('/api/admin/support', customer.cookie)).status, 403)
  assert.equal((await fetch('/api/admin/support', unverifiedAdministrator.cookie)).status, 403)
  // The new checkout is an independent synthetic customer's journey. Earlier
  // RMA adversarial requests retain their real identity quota; never erase it
  // or raise production limits to make a second suite pass.
  const financialCustomer = await identity('customer', false)
  completed++

  scenario = 'native_phase3_exact_two_unit_stock_and_contract_without_reset'
  const financialVariant = await database
    .prepare(
      `SELECT v.id,v.legacy_id AS legacyId,v.minimum_quantity AS minimumQuantity,
      v.quantity_increment AS quantityIncrement,v.maximum_quantity AS maximumQuantity
    FROM variants v JOIN products p ON p.id=v.product_id
    WHERE p.status='published' AND v.status='published' AND v.legacy_id IS NOT NULL
      AND v.minimum_quantity<=2 AND (2-v.minimum_quantity)%v.quantity_increment=0
      AND (v.maximum_quantity IS NULL OR v.maximum_quantity>=2) AND v.price_gross_cents>0
      AND ${publicationValidityExpression('p')}
    ORDER BY CASE WHEN v.id=?1 THEN 0 ELSE 1 END,v.legacy_id LIMIT 1`
    )
    .bind(variantIdentity.id)
    .first<{
      id: string
      legacyId: number
      minimumQuantity: number
      quantityIncrement: number
      maximumQuantity: number | null
    }>()
  assert(financialVariant, 'Native financial validation requires a genuinely sellable exact two-unit variant')
  validateQuantity(2, financialVariant)
  const financialInventory = adminInventoryVariantSchema.parse(
    await json(`/api/admin/inventory/variants/${financialVariant.legacyId}`, inventoryApprover.cookie)
  )
  assert.equal(financialInventory.variant.uuid, financialVariant.id)
  assert(financialInventory.balance.sellableQuantity >= 2, 'Native financial checkout requires remaining real stock')
  completed++
  const financialCheckoutAudit = await auditNativeCheckoutPayment({
    dispatch: nativeDispatch,
    database,
    origin,
    variantId: financialVariant.legacyId,
    quantity: 2,
    shippingMethod: 'pickup',
    ownerCookie: financialCustomer.cookie,
    scenario: markScenario
  })
  completed += financialCheckoutAudit.scenarios
  assert(
    ![checkoutAudit.orderId, runtimeCheckoutAudit.orderId, ownedCheckoutAudit.orderId].includes(
      financialCheckoutAudit.orderId
    )
  )
  const financialOwnership = await database
    .prepare(
      'SELECT o.customer_id AS owner,i.customer_id AS currentOwner,o.shipping_method_code AS method,' +
        'o.shipping_gross_cents AS shipping,line.quantity FROM orders o JOIN identities i ON i.id=?2 ' +
        'JOIN order_lines line ON line.order_id=o.id AND line.line_index=0 WHERE o.id=?1'
    )
    .bind(financialCheckoutAudit.orderId, financialCustomer.identityId)
    .first<{
      owner: string | null
      currentOwner: string | null
      method: string
      shipping: number
      quantity: number
    }>()
  assert(financialOwnership?.owner && financialOwnership.owner === financialOwnership.currentOwner)
  assert.equal(financialOwnership.method, 'pickup')
  assert.equal(financialOwnership.shipping, 0)
  assert.equal(financialOwnership.quantity, 2)
  const financialPreparationAudit = await auditNativeFulfillment({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    orderId: financialCheckoutAudit.orderId,
    scenario: markScenario
  })
  completed += financialPreparationAudit.scenarios
  const financialReturnsAudit = await auditNativeReturns({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: financialCustomer.cookie,
    outsiderCookie: administrator.cookie,
    guestCookie: financialCheckoutAudit.guestCookie,
    orderId: financialCheckoutAudit.orderId,
    scenario: markScenario
  })
  completed += financialReturnsAudit.scenarios
  assert.equal(financialReturnsAudit.receivedUnits, 2)
  assert.equal(financialReturnsAudit.finalState, 'resolution_ready')
  assert.equal(financialReturnsAudit.inventoryUnchanged, true)

  const phase3Environment = await runtime.getBindings<CustomerOperationsEnv>()
  const phase3SentMessages: Parameters<TransactionalEmailSender['send']>[0][] = []
  const phase3FakeSender: TransactionalEmailSender = {
    async send(message) {
      assert(/@[^@]+\.(?:test|invalid)$/.test(message.to), 'Only disposable synthetic recipients are allowed')
      assert(
        [
          'synthetic-orders@example.test',
          'synthetic-financial@example.test',
          'synthetic-support@example.test'
        ].includes(message.from)
      )
      phase3SentMessages.push(Object.freeze({ ...message }))
      return { messageId: 'synthetic-phase3-email-' + randomUUID() }
    }
  }
  const runPhase3Emails = (configuration: Parameters<typeof dispatchTransactionalEmails>[2]) =>
    dispatchTransactionalEmails(database, phase3FakeSender, configuration, { renderers: customerEmailRenderers })
  // A genuinely emitted local ordinary document precedes every corrective
  // operation; neither its receipt, source invoice nor paid status is seeded.
  const financialSourceFiscalAudit = await auditNativeFiscalRuntimeEmail({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    orderId: financialCheckoutAudit.orderId,
    runFiscal: (configuration) =>
      dispatchFiscalRuntime(
        {
          database,
          storage: createFiscalPdfStorage(localBindings.MEDIA),
          providerResolver: (policy) => configuredFiscalProvider(phase3Environment, policy, denyExternalFetch)
        },
        configuration
      ),
    runEmails: runPhase3Emails,
    deliverEmailTransport,
    sentMessages: () => phase3SentMessages,
    scenario: markScenario
  })
  completed += financialSourceFiscalAudit.scenarios
  scenario = 'native_phase3_original_invoice_and_capture_authoritative_mappings'
  const originalFiscal = await database
    .prepare(
      'SELECT i.policy_id,i.contract_json,w.status,r.fiscal_status,d.storage_key FROM fiscal_invoice_intents i ' +
        'JOIN fiscal_issuance_work w ON w.intent_id=i.id JOIN fiscal_provider_receipts r ON r.intent_id=i.id ' +
        'JOIN fiscal_documents d ON d.intent_id=i.id WHERE i.order_id=?1'
    )
    .bind(financialCheckoutAudit.orderId)
    .first<{
      policy_id: string
      contract_json: string
      status: string
      fiscal_status: string
      storage_key: string
    }>()
  assert(originalFiscal)
  assert.equal(originalFiscal.status, 'completed')
  assert.equal(originalFiscal.fiscal_status, 'issued')
  assert(await localBindings.MEDIA.head(originalFiscal.storage_key))
  const originalContract = fiscalContractSchema.parse(JSON.parse(originalFiscal.contract_json)),
    originalPolicy = await readFiscalPolicy(database, originalFiscal.policy_id),
    capture = await capturedSource(database, financialCheckoutAudit.orderId)
  assert(
    originalPolicy && originalPolicy.provider === 'local_fake' && originalPolicy.environment === 'local_validation'
  )
  assert.equal(originalContract.orderId, financialCheckoutAudit.orderId)
  assert.equal(originalContract.validationOnly, true)
  const refundPolicy = refundPolicyInputSchema.parse({
    idempotencyKey: randomUUID(),
    provider: 'local_fake',
    environment: 'local_validation',
    mappings: capture.capture.mappings,
    shipping: 'excluded',
    approvalMode: 'same_actor_confirmation',
    maximumRefundCents: capture.capture.capturedCents,
    evidenceRef: 'synthetic-native-financial-not-provider-acceptance',
    reason: 'Explicit disposable local partial-refund budget validation only'
  })
  const creditPolicy = creditPolicyInputSchema.parse({
    idempotencyKey: randomUUID(),
    provider: 'local_fake',
    environment: 'local_validation',
    series: 'RECTLOCAL',
    trigger: 'after_confirmed_refund',
    mappings: originalPolicy.mappings,
    evidenceRef: 'synthetic-native-corrective-not-fiscal-acceptance',
    reason: 'Explicit disposable corrective-document source validation only'
  })
  completed++
  const financialAudit = await auditNativeRefundsCredit({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: financialCustomer.cookie,
    orderId: financialCheckoutAudit.orderId,
    returnPublicRef: financialReturnsAudit.returnPublicRef,
    returnVersion: financialReturnsAudit.version,
    refundPolicy,
    creditPolicy,
    async runRefunds(configuration) {
      assert(configuration.policyId, 'An explicit governed refund policy is required')
      const policy = await readFinancialPolicy(database, configuration.policyId, 'refund')
      assert(policy && policy.provider === 'local_fake' && policy.environment === 'local_validation')
      const provider = await configuredRefundProvider(phase3Environment, policy, denyExternalFetch)
      assert(provider && provider.name === 'local_fake' && provider.environment === 'local_validation')
      return dispatchD1Refunds(database, provider, configuration)
    },
    async runCredits(configuration) {
      assert(configuration.policyId, 'An explicit governed corrective policy is required')
      const policy = await readFinancialPolicy(database, configuration.policyId, 'credit')
      assert(policy && policy.provider === 'local_fake' && policy.environment === 'local_validation')
      const provider = await configuredCreditProvider(phase3Environment, policy, denyExternalFetch)
      assert(provider && provider.name === 'local_fake' && provider.environment === 'local_validation')
      return dispatchD1CreditNotes(database, provider, createFiscalPdfStorage(localBindings.MEDIA), configuration)
    },
    deliverEmailTransport,
    runEmails: runPhase3Emails,
    sentMessages: () => phase3SentMessages,
    scenario: markScenario
  })
  completed += financialAudit.scenarios
  assert.equal(financialAudit.externalAcceptance, false)
  assert.equal(financialAudit.inventoryUnchanged, true)
  assert.equal(financialAudit.captureUnchanged, true)
  assert.equal(financialAudit.originalInvoiceUnchanged, true)

  const supportAudit = await auditNativeSupport({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario,
    async scanAttachment(attachment) {
      const rawBody = JSON.stringify({
        scope: 'support_attachment',
        id: randomUUID(),
        attachmentId: attachment.attachmentId,
        checksum: attachment.checksum,
        byteSize: attachment.byteSize,
        verdict: 'clean',
        scannerVersion: 'synthetic-signed-fixture-not-real-antivirus',
        scannedAt: serverNow(),
        expiresAt: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const receiptRequest = (secret: string) =>
        new Request(origin + '/api/support/attachments/scan-receipts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.149',
            'x-neteco-support-scan-signature':
              'sha256=' +
              createHmac('sha256', secret)
                .update(SUPPORT_SCAN_AUDIENCE + rawBody)
                .digest('hex')
          },
          body: rawBody
        })
      scenario = 'native_phase3_catalog_scan_secret_cannot_approve_private_support_evidence'
      const denied = await nativeDispatch(receiptRequest(mediaScanSecret))
      assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: { code: 'invalid_scan_signature' } })
      completed++
      scenario = 'native_support_verified_scanner_transport'
      return nativeDispatch(receiptRequest(supportScanSecret))
    }
  })
  completed += supportAudit.scenarios
  assert.equal(supportAudit.attachmentsExercised, true)
  assert.equal(supportAudit.providerAuthority, false)
  assert.equal(supportAudit.privateNotesRedacted, true)
  assert.equal(supportAudit.inventoryUnchanged, true)
  assert.equal(supportAudit.contractUnchanged, true)
  assert.equal(supportAudit.scheduledEntrypointExercised, false)

  scenario = 'native_phase3_support_public_email_renderer_manifest_and_local_opt_in'
  const supportEmailEvents = await database
    .prepare(
      "SELECT id FROM email_outbox_events WHERE event_type IN('support.ticket.received','support.ticket.reply') ORDER BY id"
    )
    .all<{ id: string }>()
  assert(supportEmailEvents.success)
  assert.equal(supportEmailEvents.results.length, 3)
  for (const event of supportEmailEvents.results) await deliverEmailTransport(event.id)
  const beforeSupportEmail = phase3SentMessages.length,
    supportEmailConfiguration = {
      enabled: true,
      from: 'synthetic-support@example.test',
      now: serverNow(),
      appEnvironment: 'local' as const
    }
  await runPhase3Emails(supportEmailConfiguration)
  assert.equal(phase3SentMessages.length, beforeSupportEmail)
  const deliveredSupport = await runPhase3Emails({
    ...supportEmailConfiguration,
    rendererOptIns: ['support.ticket.received.v1', 'support.ticket.reply.v1'],
    rendererValidationEnabled: true
  })
  assert.equal(deliveredSupport.sent, 3)
  for (const message of phase3SentMessages.slice(beforeSupportEmail)) {
    assert(!/PRIVATE_SUPPORT_|support\/quarantine\/|storage_key|token=/.test(JSON.stringify(message)))
  }
  const supportManifests = await database
    .prepare(
      'SELECT p.renderer_version,p.source_hash,p.message_hash FROM transactional_email_preparations p ' +
        "JOIN email_outbox_events e ON e.id=p.event_id WHERE e.event_type IN('support.ticket.received','support.ticket.reply')"
    )
    .all<{ renderer_version: string; source_hash: string; message_hash: string }>()
  assert(supportManifests.success)
  assert.equal(supportManifests.results.length, 3)
  for (const manifest of supportManifests.results) {
    assert.equal(manifest.renderer_version, 'support-public-v1')
    assert.match(manifest.source_hash, /^[0-9a-f]{64}$/)
    assert.match(manifest.message_hash, /^[0-9a-f]{64}$/)
  }
  completed++

  const newsletterAudit = await auditNativeNewsletterEditorial({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: customer.cookie,
    newsletterSecrets: { hmacKey: new Uint8Array(newsletterHmacKey) },
    feedbackSecret: new TextEncoder().encode(newsletterFeedbackSecret),
    scenario: markScenario
  })
  completed += newsletterAudit.scenarios
  assert.equal(newsletterAudit.scenarios, 8)
  scenario = 'native_phase3_newsletter_local_sender_has_native_hash_only_receipt'
  const newsletterLocalReceipts = await database
    .prepare(
      'SELECT r.delivery_id,r.message_fingerprint,r.provider_message_id,' +
        'd.provider,d.provider_message_id AS delivery_message_id FROM newsletter_editorial_fake_receipts r ' +
        'LEFT JOIN newsletter_editorial_deliveries d ON d.id=r.delivery_id ORDER BY r.delivery_id'
    )
    .all<{
      delivery_id: string
      message_fingerprint: string
      provider_message_id: string
      provider: string | null
      delivery_message_id: string | null
    }>()
  assert(newsletterLocalReceipts.success, 'Native synthetic newsletter receipt is unconfirmed')
  assert.equal(newsletterLocalReceipts.results.length, 1)
  for (const receipt of newsletterLocalReceipts.results) {
    assert.match(receipt.delivery_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    assert.match(receipt.message_fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(receipt.provider_message_id, 'SYNTHETIC-NEWSLETTER-' + receipt.message_fingerprint)
    assert.equal(receipt.provider, 'local-fake')
    assert.equal(receipt.delivery_message_id, receipt.provider_message_id)
  }
  completed++
  const phase3Scenarios = completed - phase3Baseline

  const phase4Baseline = completed
  scenario = 'native_analytics_explicit_local_opt_in_preserves_existing_d1_r2'
  const beforeAnalyticsReload = await persistentEvidence()
  const analyticsPolicy = analyticsMeasurementPolicySchema.parse({
    reference: 'explicit-local-measurement-not-legal-approval',
    version: 'native-v1',
    purpose: 'first_party_measurement',
    consentVersion: 'v1',
    retentionDays: 7,
    environment: 'local',
    approvedAt: now
  })
  await runtime.setOptions(
    nativeShopRuntimeOptions(
      {
        ...phase3Options,
        bindings: {
          ...phase3Options.bindings,
          ANALYTICS_ENABLED: 'true',
          ANALYTICS_POLICY: JSON.stringify(analyticsPolicy),
          ANALYTICS_SESSION_PEPPER: randomBytes(32).toString('base64url'),
          // Positive maintenance is an explicitly labelled host callback below,
          // never claimed as actual workerd Cron/Queue execution.
          ANALYTICS_PROJECTION_ENABLED: 'false',
          ANALYTICS_RETENTION_ENABLED: 'false'
        }
      },
      queueTransportSecret
    )
  )
  await runtime.ready
  localBindings = await runtime.getBindings<Pick<CloudflareEnv, 'DB' | 'MEDIA' | 'IMAGES'>>()
  database = localBindings.DB
  assert.equal(await persistentEvidence(), beforeAnalyticsReload)
  const analyticsBootstrap = await localBindings.MEDIA.get(bootstrapKey)
  assert(analyticsBootstrap, 'R2 bytes must survive analytics opt-in without replacement')
  const analyticsBootstrapBytes = await analyticsBootstrap.arrayBuffer()
  assert.equal(analyticsBootstrapBytes.byteLength, bootstrapImage.byteLength)
  assert.equal(createHash('sha256').update(new Uint8Array(analyticsBootstrapBytes)).digest('hex'), bootstrapHash)
  const analyticsEnvironment = await runtime.getBindings<AnalyticsRuntimeEnv>()
  const analyticsMeasurement = configuredAnalyticsMeasurement(analyticsEnvironment, { now: serverNow })
  const analyticsRange = {
    from: new Date(Date.parse(now) - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    to: new Date(Date.parse(now) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  completed++
  const analyticsAudit = await auditNativeAnalytics({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: financialCustomer.cookie,
    policy: analyticsPolicy,
    range: analyticsRange,
    scenario: markScenario,
    runProjection: () => projectAnalyticsCommerceFacts(analyticsMeasurement, { limit: 100, maxPages: 2 }),
    runRetention: ({ at, ...options }) =>
      dispatchAnalyticsRetention({ ...analyticsMeasurement, now: () => at }, options)
  })
  completed += analyticsAudit.scenarios
  assert.equal(analyticsAudit.scenarios, 19)
  const analyticsBrowserAudit = await auditNativeAnalyticsBrowser({
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    range: analyticsRange,
    scenario: markScenario,
    browserMode: nativeBrowserMode
  })
  assert.equal(analyticsBrowserAudit.scenarios, nativeBrowserMode === 'not-run' ? 0 : 2)
  completed += analyticsBrowserAudit.scenarios
  const phase4Scenarios = completed - phase4Baseline

  // This independent private read does not depend on later browser journeys.
  // Keep its acceptance before those journeys so a UI harness failure does not
  // prevent exercising the compiled export entrypoint.
  const orderExportAudit = await auditNativeOrderExport({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario
  })
  assert.equal(orderExportAudit.scenarios, ORDER_EXPORT_NATIVE_SCENARIOS.length)
  completed += orderExportAudit.scenarios

  const orderAnnotationsAudit = await auditNativeOrderAnnotations({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario
  })
  assert.equal(orderAnnotationsAudit.scenarios, ORDER_ANNOTATIONS_NATIVE_SCENARIOS.length)
  completed += orderAnnotationsAudit.scenarios

  const editorialAudit = await auditNativeEditorialImport({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: customer.cookie,
    scenario: markScenario
  })
  assert.equal(editorialAudit.scenarios, 6)
  completed += editorialAudit.scenarios
  const catalogExportAudit = await auditNativeCatalogExport({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: customer.cookie,
    scenario: markScenario,
    browserMode: nativeBrowserMode
  })
  assert.equal(catalogExportAudit.scenarios, nativeBrowserMode === 'not-run' ? 6 : 10)
  completed += catalogExportAudit.scenarios

  // This role already exists in this disposable database. Only the synthetic
  // audit administrator gets the explicit stock-initialization grant; no shared
  // permission, deployed identity, configuration or production role changes.
  scenario = 'native_catalog_import_disposable_fixture_stock_permission'
  await database
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'warehouse',?)")
    .bind(administrator.identityId, now)
    .run()
  const importBrowserAudit: { proof?: Awaited<ReturnType<typeof auditNativeCatalogImportBrowser>> } = {}
  const nativeCatalogImportAudit = await auditNativeCatalogImport({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: customer.cookie,
    scenario: markScenario,
    onBrowserFixtures: async ({ records, jobRecords }) => {
      const proof = await auditNativeCatalogImportBrowser({
        dispatch: nativeDispatch,
        origin,
        adminCookie: administrator.cookie,
        records,
        jobRecords,
        scenario: markScenario,
        browserMode: nativeBrowserMode
      })
      importBrowserAudit.proof = proof
      if (nativeBrowserMode === 'required') {
        const record = records[0]!
        const product = await database
          .prepare('SELECT status,catalog_version FROM products WHERE id=?')
          .bind(record.product_id)
          .first<{ status: string; catalog_version: number }>()
        assert.deepEqual(product, { status: 'discontinued', catalog_version: 2 })
        const variant = await database
          .prepare('SELECT status,price_gross_cents FROM variants WHERE id=?')
          .bind(record.variant_id)
          .first<{ status: string; price_gross_cents: number }>()
        assert.deepEqual(variant, { status: 'discontinued', price_gross_cents: 0 })
        const stock = await database
          .prepare('SELECT physical_quantity,blocked_quantity,version FROM inventory_balances WHERE variant_id=?')
          .bind(record.variant_id)
          .first<{ physical_quantity: number; blocked_quantity: number; version: number }>()
        assert.deepEqual(stock, { physical_quantity: 0, blocked_quantity: 0, version: 2 })
        const ledger = await database
          .prepare('SELECT count(*) AS count,sum(physical_delta) AS delta FROM inventory_movements WHERE variant_id=?')
          .bind(record.variant_id)
          .first<{ count: number; delta: number }>()
        assert.deepEqual(ledger, { count: 2, delta: 0 })
        const asset = await database
          .prepare('SELECT rights_status,quarantine_status FROM media_assets WHERE id=?')
          .bind(record.asset_id)
          .first<{ rights_status: string; quarantine_status: string }>()
        assert.deepEqual(asset, { rights_status: 'pending', quarantine_status: 'pending' })
        const jobId = proof.jobCommands?.jobId
        assert(jobId, 'Compiled whole-job journey must return the confirmed job identity')
        const jobEntries = (kind: string) =>
          `SELECT item_id FROM catalog_import_job_entries WHERE job_id=?1 AND kind='${kind}'`
        const jobTruth = await database
          .prepare(
            `SELECT
          (SELECT count(*) FROM products WHERE id IN(${jobEntries('products')}) AND status='discontinued' AND catalog_version=2) AS products,
          (SELECT count(*) FROM variants WHERE id IN(${jobEntries('variants')}) AND status='discontinued' AND price_gross_cents=0) AS variants,
          (SELECT count(*) FROM media_assets WHERE id IN(${jobEntries('assets')}) AND rights_status='pending' AND quarantine_status='pending') AS assets,
          (SELECT count(*) FROM variant_price_versions WHERE variant_id IN(${jobEntries('variants')}) AND status='cancelled') AS prices,
          (SELECT count(*) FROM inventory_balances WHERE variant_id IN(${jobEntries('variants')}) AND physical_quantity=0 AND blocked_quantity=0 AND version=2) AS balances,
          (SELECT count(*) FROM inventory_movements WHERE variant_id IN(${jobEntries('variants')})) AS movements,
          (SELECT sum(physical_delta) FROM inventory_movements WHERE variant_id IN(${jobEntries('variants')})) AS delta,
          (SELECT count(*) FROM catalog_import_job_commands WHERE job_id=?1) AS commands,
          (SELECT count(*) FROM catalog_import_job_command_audit WHERE command_id IN(SELECT id FROM catalog_import_job_commands WHERE job_id=?1)) AS snapshots
        `
          )
          .bind(jobId)
          .first()
        assert.deepEqual(jobTruth, {
          products: 601,
          variants: 601,
          assets: 601,
          prices: 601,
          balances: 601,
          movements: 1202,
          delta: 0,
          commands: 2,
          snapshots: 9015
        })
      }
    }
  })
  assert.equal(nativeCatalogImportAudit.scenarios, 16)
  completed += nativeCatalogImportAudit.scenarios
  assert(importBrowserAudit.proof)
  const nativeImportBrowserProof = importBrowserAudit.proof
  assert.equal(nativeImportBrowserProof.scenarios, nativeBrowserMode === 'not-run' ? 0 : 7)
  completed += nativeImportBrowserProof.scenarios

  // Run after the fixed inventory/payment assertions, but before withdrawing
  // this product's final public image. The journey reserves real disposable
  // stock through checkout; it never inserts a SQL order/payment fixture.
  const checkoutRecoveryBrowserAudit = await auditNativeCheckoutRecoveryBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    variantId: variantIdentity.legacyId,
    quantity: variantIdentity.quantity,
    scenario: markScenario,
    browserMode: nativeBrowserMode
  })
  assert.equal(checkoutRecoveryBrowserAudit.scenarios, nativeBrowserMode === 'not-run' ? 0 : 2)
  completed += checkoutRecoveryBrowserAudit.scenarios

  const cartAddRecoveryBrowserAudit = await auditNativeCartAddRecoveryBrowser({
    dispatch: nativeDispatch,
    origin,
    productSlug: firstProduct.slug,
    variantLegacyId: variantIdentity.legacyId,
    scenario: markScenario,
    browserMode: nativeBrowserMode
  })
  assert.equal(
    cartAddRecoveryBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : CART_ADD_RECOVERY_BROWSER_SCENARIOS.length
  )
  completed += cartAddRecoveryBrowserAudit.scenarios

  const globalSearchSku = await database
    .prepare('SELECT sku FROM variants WHERE id=?')
    .bind(variantIdentity.id)
    .first<{ sku: string }>()
  assert(globalSearchSku)
  const adminGlobalSearchAudit = await auditNativeAdminGlobalSearch({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    productLegacyId: productIdentity.legacyId,
    productSku: globalSearchSku.sku,
    orderId: ownedCheckoutAudit.orderId,
    scenario: markScenario
  })
  completed += adminGlobalSearchAudit.scenarios

  const orderTimelineAudit = await auditNativeOrderTimeline({
    dispatch: nativeDispatch,
    database,
    origin,
    orderId: financialCheckoutAudit.orderId,
    customerCookie: financialCustomer.cookie,
    adminCookie: administrator.cookie,
    wrongOwnerCookie: administrator.cookie,
    customerAdminDenial: 'mfa_required',
    scenario: markScenario
  })
  completed += orderTimelineAudit.scenarios
  assert.deepEqual(orderTimelineAudit.sourceKinds, [
    'checkout',
    'credit',
    'fiscal',
    'fulfillment',
    'payment',
    'refund',
    'return'
  ])

  const cancellationCustomer = await identity('customer', false)
  const orderCancellationAudit = await auditNativeOrderCancellation({
    dispatch: nativeDispatch,
    database,
    origin,
    variantId: variantIdentity.legacyId,
    quantity: guestQuantity,
    customerCookie: cancellationCustomer.cookie,
    wrongOwnerCookie: administrator.cookie,
    scenario: markScenario
  })
  completed += orderCancellationAudit.scenarios

  const orderEmailsAudit = await auditNativeOrderEmails({
    database,
    origin,
    orderIds: {
      fulfillment: [checkoutAudit.orderId, ownedCheckoutAudit.orderId, financialCheckoutAudit.orderId],
      returns: financialCheckoutAudit.orderId,
      cancelled: orderCancellationAudit.orderId,
      payment: ownedCheckoutAudit.orderId
    },
    runEmails: runPhase3Emails,
    deliverEmailTransport,
    sentMessages: () => phase3SentMessages,
    scenario: markScenario
  })
  assert.equal(orderEmailsAudit.scenarios, ORDER_EMAILS_NATIVE_SCENARIOS.length)
  completed += orderEmailsAudit.scenarios

  scenario = 'native_order_operations_browser_acceptance'
  let checkoutInventoryOperator: Awaited<ReturnType<typeof identity>> | undefined
  async function prepareCheckoutInventory(
    variant: { id: string; legacyId: number },
    required: number,
    reference: string
  ) {
    // Lazy fixture authority: not-run never creates an actor or adjusts stock.
    if (!checkoutInventoryOperator) {
      const operator = await identity('warehouse', true)
      await database
        .prepare(
          "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?1,'synthetic-checkout-not-production','[]',?2,?2)"
        )
        .bind(operator.identityId, now)
        .run()
      checkoutInventoryOperator = operator
    }
    const operator = checkoutInventoryOperator
    const inventoryPath = `/api/admin/inventory/variants/${variant.legacyId}`
    const stock = adminInventoryVariantSchema.parse(await json(inventoryPath, operator.cookie))
    assert.equal(stock.variant.uuid, variant.id)
    if (stock.balance.sellableQuantity < required) {
      const key = randomUUID()
      const response = await adminOperation(
        inventoryPath + '/receipts',
        'POST',
        {
          expectedBalanceVersion: stock.balance.version,
          quantity: required - stock.balance.sellableQuantity,
          reason: 'Explicit disposable checkout stock preparation',
          reference
        },
        operator.cookie,
        key
      )
      assert.equal(response.status, 200)
      const receipt = inventoryCommandReceiptSchema.parse(await response.json())
      const committed = await database
        .prepare(
          `SELECT c.id,c.result_version,c.physical_delta,c.response,
          m.physical_delta AS ledger_delta,m.reserved_delta AS ledger_reserved_delta
          FROM inventory_admin_commands c JOIN inventory_movements m ON m.id=c.movement_id
            AND m.variant_id=c.variant_id AND m.location_id=c.location_id
            AND m.reference_type='admin_inventory' AND m.reference_id=c.id
          WHERE c.actor_id=?1 AND c.idempotency_key=?2 AND c.variant_id=?3 AND c.action='receipt'`
        )
        .bind(operator.identityId, key, variant.id)
        .first<{
          id: string
          result_version: number
          physical_delta: number
          response: string
          ledger_delta: number
          ledger_reserved_delta: number
        }>()
      assert(committed)
      assert.equal(committed.id, receipt.commandId)
      assert.equal(committed.result_version, receipt.balanceVersion)
      assert.equal(committed.physical_delta, receipt.physicalDelta)
      assert.equal(committed.ledger_delta, receipt.physicalDelta)
      assert.equal(committed.ledger_reserved_delta, 0)
      assert.deepEqual(JSON.parse(committed.response), receipt)
      assert.equal(receipt.physicalDelta, required - stock.balance.sellableQuantity)
    }
    assert(
      adminInventoryVariantSchema.parse(await json(inventoryPath, operator.cookie)).balance.sellableQuantity >= required
    )
  }
  let workbenchActorCookie: string | undefined
  const orderOperationsBrowserAudit = await auditNativeOrderOperationsBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareWorkbench(viewport) {
      const owner = await identity('customer', false)
      const actor = await identity('admin', true)
      const otherActor = await identity('admin', true)
      // Preauthenticated disposable actors still require real enrollment rows;
      // the session MFA boolean alone is deliberately insufficient.
      for (const enrolled of [actor, otherActor]) {
        await database
          .prepare(
            "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?1,'synthetic-workbench-not-production','[]',?2,?2)"
          )
          .bind(enrolled.identityId, now)
          .run()
      }
      workbenchActorCookie = actor.cookie
      validateQuantity(2, financialVariant)
      const inventoryPath = `/api/admin/inventory/variants/${financialVariant.legacyId}`
      assert.equal((await fetch(inventoryPath, inventoryOperator.cookie)).status, 403)
      await prepareCheckoutInventory(financialVariant, 26 * 2, `LOCAL-WORKBENCH-${viewport}`)
      const query = `Workbench-${viewport}-${randomUUID()}`
      const prepareDispatch = async (request: Request) => {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/orders') return nativeDispatch(request)
        const body = (await request.json()) as {
          customer: { name: string }
          shippingAddress: { recipientName: string }
          billingAddress: { recipientName: string }
        }
        body.customer.name = query
        body.shippingAddress.recipientName = query
        body.billingAddress.recipientName = query
        return nativeDispatch(new Request(request, { body: JSON.stringify(body) }))
      }
      const orders: Array<{ orderId: string; guestCookie: string }> = []
      for (let index = 0; index < 26; index++)
        orders.push(
          await createNativeUnpaidOrder({
            dispatch: prepareDispatch,
            origin,
            variantId: financialVariant.legacyId,
            quantity: 2,
            customerCookie: owner.cookie
          })
        )
      orders.sort((left, right) => left.orderId.localeCompare(right.orderId))
      // Choose payment targets after ordering: both must be on the first page,
      // never rely on random UUID order to make an eligible row visible.
      for (const order of orders.slice(0, 2)) {
        const payment = await adminOperation(
          '/api/checkout/pay',
          'POST',
          { orderId: order.orderId, method: 'tarjeta' },
          order.guestCookie + '; ' + owner.cookie,
          randomUUID()
        )
        assert.equal(payment.status, 200)
        const intent = await database
          .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?1')
          .bind(order.orderId)
          .first<{ merchant_order: string; amount_gross_cents: number }>()
        assert(intent)
        const sandbox = REDSYS_OFFICIAL_CONTRACT.sandbox
        const parameters = encodeMerchantParameters({
          Ds_Order: intent.merchant_order,
          Ds_Amount: String(intent.amount_gross_cents),
          Ds_Currency: sandbox.currency,
          Ds_MerchantCode: sandbox.merchantCode,
          Ds_Terminal: sandbox.terminal,
          Ds_TransactionType: '0',
          Ds_Response: '0000'
        })
        const notification = await nativeDispatch(
          new Request(origin + '/api/payments/redsys/notification', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              Ds_MerchantParameters: parameters,
              Ds_SignatureVersion: 'HMAC_SHA512_V2',
              Ds_Signature: await signMerchantParameters(parameters, sandbox.secretKey)
            }).toString()
          })
        )
        assert.equal(notification.status, 200)
        assert.equal(await notification.text(), 'OK')
        const paid = await database
          .prepare(
            'SELECT p.status AS payment,r.status AS reservation FROM orders o JOIN order_payment_states p ON p.order_id=o.id JOIN inventory_reservations r ON r.id=o.reservation_id WHERE o.id=?1'
          )
          .bind(order.orderId)
          .first()
        assert.deepEqual(paid, { payment: 'paid', reservation: 'assigned' })
        const allocated = await database
          .prepare(
            "SELECT count(*) AS count FROM inventory_movements m JOIN orders o ON o.reservation_id=m.reference_id WHERE o.id=?1 AND m.reference_type='reservation' AND m.movement_type='allocate'"
          )
          .bind(order.orderId)
          .first<{ count: number }>()
        assert.equal(allocated?.count, 1)
      }
      const firstPage = await json<{ items: Array<{ id: string }>; pagination: { total: number } }>(
        `/api/admin/orders?q=${encodeURIComponent(query)}&sortKey=id&sortDir=asc&page=1&perPage=25`,
        actor.cookie
      )
      assert.equal(firstPage.pagination.total, 26)
      assert.deepEqual(
        firstPage.items.map((item) => item.id),
        orders.slice(0, 25).map((order) => order.orderId)
      )
      const secondPage = await json<{ items: Array<{ id: string }>; pagination: { total: number } }>(
        `/api/admin/orders?q=${encodeURIComponent(query)}&sortKey=id&sortDir=asc&page=2&perPage=25`,
        actor.cookie
      )
      assert.equal(secondPage.pagination.total, 26)
      assert.deepEqual(
        secondPage.items.map((item) => item.id),
        [orders[25]!.orderId]
      )
      return {
        adminCookie: actor.cookie,
        otherActorCookie: otherActor.cookie,
        orderIds: orders.map((order) => order.orderId),
        query,
        eligibleOrderIds: orders.slice(0, 2).map((order) => order.orderId),
        blockedOrderId: orders[2]!.orderId
      }
    },
    async readCommittedBulk({ commandId, body, receipt }) {
      assert(workbenchActorCookie)
      assert.equal(receipt.commandId, commandId)
      assert.equal(receipt.payloadHash, await adminOrderBulkIntentHash(body))
      const recovered = adminOrderBulkCommandSchema.parse(
        await json(
          `/api/admin/orders/bulk-fulfillment/commands/${commandId}?payloadHash=${receipt.payloadHash}`,
          workbenchActorCookie
        )
      )
      assert.equal(recovered.outcome, 'applied')
      if (recovered.outcome !== 'applied') throw new Error('unconfirmed_bulk_commit')
      assert.deepEqual(recovered.receipt, receipt)
      const group = adminOrderBulkGroupSchema.parse(
        await json(`/api/admin/orders/bulk-fulfillment/${receipt.groupId}`, workbenchActorCookie)
      )
      assert.equal(group.commandId, commandId)
      assert.equal(group.dispatchId, receipt.dispatchId)
      const durable = await database
        .prepare(
          'SELECT input_json,receipt_json,dispatch_id FROM admin_order_bulk_groups WHERE id=?1 AND command_id=?2 AND payload_hash=?3'
        )
        .bind(receipt.groupId, commandId, receipt.payloadHash)
        .first<{ input_json: string; receipt_json: string; dispatch_id: string }>()
      assert(durable)
      assert.equal(durable.dispatch_id, receipt.dispatchId)
      assert.deepEqual(JSON.parse(durable.input_json), body)
      assert.deepEqual(JSON.parse(durable.receipt_json), receipt)
    },
    async consumeBulkQueue({ groupId, dispatchId }) {
      assert(workbenchActorCookie)
      for (let step = 0; step < 3; step++) {
        const response = await runtime!.dispatchFetch('https://bulk-transport.neteco.test/consume', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-neteco-audit-transport': queueTransportSecret },
          body: JSON.stringify({ type: 'admin.order-bulk.requested', groupId, dispatchId })
        })
        assert.equal(response.status, 200)
        const delivered = (await response.json()) as {
          outcome: string
          ackAll: boolean
          retryBatch: boolean
          retryMessages: number
          explicitAcks: number
        }
        assert.equal(delivered.outcome, 'ok')
        assert.equal(delivered.retryBatch, false)
        assert.equal(delivered.retryMessages, 0)
        assert(delivered.ackAll || delivered.explicitAcks === 1)
        const group = adminOrderBulkGroupSchema.parse(
          await json(`/api/admin/orders/bulk-fulfillment/${groupId}`, workbenchActorCookie)
        )
        assert.equal(group.dispatchId, dispatchId)
        if (group.status === 'completed') return
        assert.equal(group.status, 'pending')
      }
      throw new Error('compiled_bulk_queue_not_completed')
    },
    async prepareUnpaidOrder() {
      const owner = await identity('customer', false)
      const prepared = await createNativeUnpaidOrder({
        dispatch: nativeDispatch,
        origin,
        variantId: variantIdentity.legacyId,
        quantity: guestQuantity,
        prepareInventory: () => prepareCheckoutInventory(variantIdentity, guestQuantity, 'LOCAL-CANCELLATION'),
        customerCookie: owner.cookie
      })
      return { orderId: prepared.orderId, ownerCookie: owner.cookie }
    }
  })
  assert.equal(
    orderOperationsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : ORDER_OPERATIONS_BROWSER_SCENARIOS.length
  )
  completed += orderOperationsBrowserAudit.scenarios

  scenario = 'native_order_returns_browser_acceptance'
  const orderReturnsBrowserAudit = await auditNativeOrderReturnsBrowser({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareDeliveredOrder(viewport) {
      // Setup only: all payment/delivery assertions still run, but their
      // existing scenario IDs are not counted again as browser acceptance.
      scenario = `native_order_returns_${viewport}_dedicated_delivered_setup`
      const owner = await identity('customer', false)
      const fixtureAdministrator = await identity('admin', true)
      validateQuantity(2, financialVariant)
      const stock = adminInventoryVariantSchema.parse(
        await json(`/api/admin/inventory/variants/${financialVariant.legacyId}`, inventoryApprover.cookie)
      )
      assert.equal(stock.variant.uuid, financialVariant.id)
      assert(stock.balance.sellableQuantity >= 2, 'Dedicated RMA checkout requires remaining real stock')
      // Each fulfillment helper costs14 real POSTs. Earlier three journeys
      // already cost42 for the UI administrator; a fresh authorized fixture
      // actor keeps this setup isolated without resetting or raising quotas.
      const fixtureQuotaBefore = await database
        .prepare("SELECT used FROM identity_rate_limits WHERE identity_id=?1 AND scope='admin-fulfillment'")
        .bind(fixtureAdministrator.identityId)
        .first<{ used: number }>()
      assert.equal(fixtureQuotaBefore, null)
      const returnsQuota = await database
        .prepare("SELECT used,expires_at FROM identity_rate_limits WHERE identity_id=?1 AND scope='admin-returns'")
        .bind(administrator.identityId)
        .first<{ used: number; expires_at: number }>()
      const remainingUiPuts = viewport === 'desktop' ? 6 : 3
      assert(
        !returnsQuota ||
          returnsQuota.expires_at <= Math.floor(Date.now() / 1000) ||
          returnsQuota.used + remainingUiPuts <= 60,
        'Administrative RMA browser requests must fit the real unchanged quota'
      )
      const prepared = await auditNativeCheckoutPayment({
        dispatch: nativeDispatch,
        database,
        origin,
        variantId: financialVariant.legacyId,
        quantity: 2,
        shippingMethod: 'pickup',
        ownerCookie: owner.cookie,
        scenario: () => undefined
      })
      const ownership = await database
        .prepare(
          'SELECT o.customer_id AS owner,i.customer_id AS current_owner FROM orders o JOIN identities i ON i.id=?2 WHERE o.id=?1'
        )
        .bind(prepared.orderId, owner.identityId)
        .first<{ owner: string | null; current_owner: string | null }>()
      assert(
        ownership?.owner && ownership.owner === ownership.current_owner,
        'Dedicated RMA order must belong to its authenticated customer'
      )
      const delivered = await auditNativeFulfillment({
        dispatch: nativeDispatch,
        database,
        origin,
        adminCookie: fixtureAdministrator.cookie,
        orderId: prepared.orderId,
        scenario: () => undefined
      })
      assert.equal(delivered.finalState, 'delivered')
      assert.equal(delivered.inventoryUnchanged, true)
      const fixtureQuotaAfter = await database
        .prepare("SELECT used FROM identity_rate_limits WHERE identity_id=?1 AND scope='admin-fulfillment'")
        .bind(fixtureAdministrator.identityId)
        .first<{ used: number }>()
      assert.equal(fixtureQuotaAfter?.used, 14)
      const returns = customerOrderReturnsSchema.parse(
        await json(`/api/orders/${prepared.orderId}/returns`, owner.cookie)
      )
      assert.equal(returns.orderId, prepared.orderId)
      assert(returns.readiness.ready && returns.capabilities.returnRequest)
      assert.equal(returns.version, 0)
      assert.equal(returns.pagination.total, 0)
      return { orderId: prepared.orderId, ownerCookie: owner.cookie }
    }
  })
  assert.equal(
    orderReturnsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : ORDER_RETURNS_BROWSER_SCENARIOS.length
  )
  completed += orderReturnsBrowserAudit.scenarios

  scenario = 'native_company_review_browser_acceptance'
  const companyReviewBrowserAudit = await auditNativeCompanyReviewBrowser({
    dispatch: nativeDispatch,
    database,
    origin,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareCompany(viewport) {
      const owner = await identity('customer', false)
      const password = randomBytes(32).toString('base64url')
      // This is a fresh disposable identity, not a credential reset of an
      // existing user. The company itself is submitted through the real API.
      const passwordHash = await hashWorkerPassword(password)
      await database
        .prepare("UPDATE identities SET password_hash=?1 WHERE id=?2 AND password_hash='unusable-audit-fixture'")
        .bind(passwordHash, owner.identityId)
        .run()
      const taxId = viewport === 'desktop' ? 'B99000648' : 'B99000655'
      const legalName = `Empresa sintética %_\\ ${viewport}`
      const response = await nativeDispatch(
        new Request(origin + '/api/account/company', {
          method: 'PUT',
          headers: {
            cookie: owner.cookie,
            origin,
            'content-type': 'application/json',
            'cf-connecting-ip': '192.0.2.168'
          },
          body: JSON.stringify({
            legalName,
            tradeName: 'Demostración aislada',
            taxId,
            countryCode: 'ES',
            currentPassword: password
          })
        })
      )
      assert.equal(response.status, 200)
      const submitted = (await response.json()) as { companyId?: string; status?: string; user?: { id?: string } }
      assert.equal(submitted.user?.id, owner.identityId)
      assert.equal(submitted.status, 'pending')
      assert.match(submitted.companyId ?? '', /^[0-9a-f-]{36}$/)
      const submittedCompany = await database
        .prepare(
          'SELECT c.id,c.legal_name,c.tax_id,c.status FROM companies c JOIN identities i ON i.customer_id=c.customer_id WHERE c.id=?1 AND i.id=?2'
        )
        .bind(submitted.companyId!, owner.identityId)
        .first<{ id: string; legal_name: string; tax_id: string; status: string }>()
      assert.deepEqual(submittedCompany, {
        id: submitted.companyId,
        legal_name: legalName,
        tax_id: taxId,
        status: 'pending'
      })
      return { companyId: submitted.companyId!, legalName, taxId }
    }
  })
  assert.equal(
    companyReviewBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : COMPANY_REVIEW_BROWSER_SCENARIOS.length
  )
  completed += companyReviewBrowserAudit.scenarios

  scenario = 'native_account_settings_browser_acceptance'
  const accountSettingsBrowserAudit = await auditNativeAccountSettingsBrowser({
    dispatch: nativeDispatch,
    database,
    origin,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareOwner() {
      const owner = await identity('customer', false)
      const currentOwner = await database
        .prepare(
          "SELECT i.id AS identityId,i.customer_id AS customerId,i.email AS ownerEmail FROM identities i JOIN customers c ON c.id=i.customer_id WHERE i.id=?1 AND i.status='active' AND i.email_verified_at IS NOT NULL AND c.status='active'"
        )
        .bind(owner.identityId)
        .first<{ identityId: string; customerId: string; ownerEmail: string }>()
      assert(currentOwner)
      assert.equal(currentOwner.identityId, owner.identityId)
      return {
        ownerCookie: owner.cookie,
        ...currentOwner,
        forbiddenValues: [`${customer.identityId}@example.invalid`, `${administrator.identityId}@example.invalid`]
      }
    }
  })
  assert.equal(
    accountSettingsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : ACCOUNT_SETTINGS_BROWSER_SCENARIOS.length
  )
  completed += accountSettingsBrowserAudit.scenarios

  scenario = 'native_quick_order_browser_acceptance'
  const quickOrderBrowserAudit = await auditNativeQuickOrderBrowser({
    dispatch: nativeDispatch,
    database,
    origin,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareQuickOrder(viewport) {
      // Lazy setup only: NOTRUN never reads/writes fixtures. Existing published
      // disposable seed products retain their real publication and stock.
      const available = (
        await database
          .prepare(
            `
        SELECT v.id,v.legacy_id AS legacyId,v.product_id AS productId,v.sku,
          v.minimum_quantity AS minimumQuantity,v.quantity_increment AS quantityIncrement,
          v.maximum_quantity AS maximumQuantity
        FROM variants v JOIN products p ON p.id=v.product_id
        JOIN tax_classes tax ON tax.id=v.tax_class_id
        WHERE p.status='published' AND p.source_version='demo-v1'
          AND v.status='published' AND v.legacy_id IS NOT NULL AND v.currency='EUR'
          AND v.price_gross_cents>1 AND tax.rate_basis_points>0
          AND p.id NOT IN (SELECT product_id FROM variants WHERE id IN (?1,?2))
          AND v.minimum_quantity+v.quantity_increment<=999
          AND (v.maximum_quantity IS NULL OR v.minimum_quantity+v.quantity_increment<=v.maximum_quantity)
          AND v.legacy_id=(SELECT MIN(sibling.legacy_id) FROM variants sibling
            WHERE sibling.product_id=p.id AND sibling.status='published' AND sibling.legacy_id IS NOT NULL)
          AND ${publicationValidityExpression('p')}
        ORDER BY v.legacy_id LIMIT 4`
          )
          .bind(variantIdentity.id, financialVariant.id)
          .all<{
            id: string
            legacyId: number
            productId: string
            sku: string
            minimumQuantity: number
            quantityIncrement: number
            maximumQuantity: number | null
          }>()
      ).results
      // Separate products per viewport, avoiding pricing changes to previously
      // confirmed desktop and native cart/payment fixture products.
      const candidates = available.slice(viewport === 'desktop' ? 0 : 2, viewport === 'desktop' ? 2 : 4)
      assert.equal(candidates.length, 2, 'Quick order needs two existing published disposable products')
      const [first, second] = candidates as [(typeof candidates)[number], (typeof candidates)[number]]
      assert.notEqual(first.id, second.id)
      assert.notEqual(first.productId, second.productId)
      const quantities: [number, number] = [first.minimumQuantity + first.quantityIncrement, second.minimumQuantity]
      for (const [index, candidate] of candidates.entries()) {
        validateQuantity(quantities[index]!, candidate)
        const stock = adminInventoryVariantSchema.parse(
          await json(`/api/admin/inventory/variants/${candidate.legacyId}`, inventoryApprover.cookie)
        )
        assert.equal(stock.variant.uuid, candidate.id)
        assert(stock.balance.sellableQuantity >= quantities[index]!, 'Quick order cannot fabricate available stock')
      }
      const pricing = catalogPriceListSchema.parse(
        await json(`/api/admin/prices?variant=${first.legacyId}`, administrator.cookie)
      )
      assert.equal(pricing.items.length, 1)
      const current = pricing.items[0]!
      assert.equal(current.variantId, first.id)
      assert(current.grossCents > 1)
      const validFrom = new Date().toISOString()
      assert(
        !current.latestApproved || Date.parse(current.latestApproved.validFrom) < Date.parse(validFrom),
        'Quick order does not cancel or override an existing future price decision'
      )
      const scheduled = await adminOperation(
        '/api/admin/prices',
        'POST',
        {
          variantId: first.id,
          expectedCatalogVersion: current.catalogVersion,
          expectedLatestApprovedId: current.latestApproved?.id ?? null,
          grossCents: current.grossCents,
          compareAtGrossCents: null,
          volumeTiers: [{ minimumQuantity: quantities[0], unitGrossCents: current.grossCents - 1 }],
          validFrom,
          reason: `Synthetic isolated quick-order ${viewport} tier, not commercial approval`
        },
        administrator.cookie,
        randomUUID()
      )
      assert.equal(scheduled.status, 201)
      const receipt = catalogPriceReceiptSchema.parse(await scheduled.json())
      assert.equal(receipt.variantId, first.id)
      assert.equal(receipt.action, 'price_schedule')
      // Synthetic identifier metadata only, before the helper's measured read/
      // cart interval. No publication, price, quantity or stock SQL mutation.
      const eanReference = viewport === 'desktop' ? '2990000000019' : '2990000000026'
      const metadata = await database
        .prepare('UPDATE variants SET ean=?1 WHERE id=?2 AND product_id=?3')
        .bind(eanReference, second.id, second.productId)
        .run()
      assert.equal(metadata.meta.changes, 1)
      return {
        skuReference: first.sku,
        eanReference,
        unknownReference: `SYNTHETIC-QUICK-UNKNOWN-${randomUUID()}`,
        quantities
      }
    }
  })
  assert.equal(
    quickOrderBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : QUICK_ORDER_BROWSER_SCENARIOS.length
  )
  completed += quickOrderBrowserAudit.scenarios

  scenario = 'native_guest_order_browser_acceptance'
  const guestOrderBrowserAudit = await auditNativeGuestOrderBrowser({
    origin,
    dispatch: nativeDispatch,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareGuestOrder(viewport) {
      scenario = `native_guest_order_${viewport}_confirmed_checkout_email_setup`
      const prepared = await createNativeUnpaidOrder({
        dispatch: nativeDispatch,
        origin,
        variantId: variantIdentity.legacyId,
        quantity: guestQuantity,
        prepareInventory: () => prepareCheckoutInventory(variantIdentity, guestQuantity, `LOCAL-GUEST-${viewport}`),
        // This unknown cookie grants no authority. The existing shared fixture
        // requires a nonempty cookie string; actual checkout remains anonymous.
        customerCookie: 'neteco-audit-guest=1'
      })
      const owner = await database.prepare('SELECT customer_id FROM orders WHERE id=?1').bind(prepared.orderId).first()
      assert(owner && owner.customer_id === null, 'Guest fixture must come from actual anonymous checkout')
      const { results: events } = await database
        .prepare("SELECT id FROM email_outbox_events WHERE source_id=?1 AND event_type='order.created'")
        .bind(prepared.orderId)
        .all<{ id: string }>()
      assert.equal(events.length, 1, 'Guest fixture needs its one actual committed email occurrence')
      await deliverEmailTransport(events[0]!.id)
      const before = phase3SentMessages.length
      await runPhase3Emails({
        enabled: true,
        from: 'synthetic-orders@example.test',
        now: serverNow(),
        limit: 100,
        guestOrderLinks: { publicOrigin: origin, sessionCookieConfiguration: cookieConfiguration }
      })
      const messages = phase3SentMessages
        .slice(before)
        .filter((message) => message.subject === `NETECO: pedido recibido ${prepared.orderId}`)
      assert.equal(messages.length, 1, 'Exactly one synthetic receipt must be emitted for the guest fixture')
      const emailLink = messages[0]!.text
        .split(/\s+/)
        .find((candidate) => candidate.startsWith(`${origin}/pedido/${prepared.orderId}?token=`))
      assert(emailLink, 'Confirmed guest email must contain its actual view-only link')
      const url = new URL(emailLink)
      assert.equal(url.origin, origin)
      assert.equal(url.pathname, `/pedido/${prepared.orderId}`)
      assert.equal(url.searchParams.size, 1)
      assert(/^[a-f0-9]{64}$/.test(url.searchParams.get('token') ?? ''), 'Guest view claim must be valid')
      const originalBearer = prepared.guestCookie.split('.').at(-1)
      assert(originalBearer && /^[a-f0-9]{64}$/.test(originalBearer), 'Original bearer must remain private')
      assert(!messages[0]!.text.includes(originalBearer) && !messages[0]!.html.includes(originalBearer))
      return { orderId: prepared.orderId, emailLink, forbiddenValues: [originalBearer, prepared.guestCookie] }
    }
  })
  assert.equal(
    guestOrderBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : GUEST_ORDER_BROWSER_SCENARIOS.length
  )
  completed += guestOrderBrowserAudit.scenarios

  scenario = 'native_inventory_alerts_browser_acceptance'
  const inventoryAlertsBrowserAudit = await auditNativeInventoryAlertsBrowser({
    origin,
    dispatch: nativeDispatch,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepareVariant(viewport) {
      // Use separate existing, governed positions per viewport. Preparation is
      // read-only and lazy: not-run must not configure thresholds or episodes.
      const selected = viewport === 'desktop' ? variantIdentity : financialVariant
      const stock = adminInventoryVariantSchema.parse(
        await json(`/api/admin/inventory/variants/${selected.legacyId}`, administrator.cookie)
      )
      assert.equal(stock.variant.uuid, selected.id)
      assert(stock.variant.sku.length <= 100 && selected.legacyId <= 100)
      const policy = inventoryAlertPolicyResponseSchema.parse(
        await json(`/api/admin/inventory/variants/${selected.legacyId}/alert-policy`, administrator.cookie)
      )
      assert.equal(policy.threshold, null, 'Browser fixture must start without a configured threshold')
      const episodes = inventoryAlertsResponseSchema.parse(
        await json(
          `/api/admin/inventory/alerts?state=all&q=${encodeURIComponent(stock.variant.sku)}`,
          administrator.cookie
        )
      )
      assert.equal(episodes.items.filter((item) => item.variantId === selected.legacyId).length, 0)
      return {
        variantId: selected.legacyId,
        sku: stock.variant.sku,
        threshold: Math.max(1, stock.balance.sellableQuantity)
      }
    },
    async snapshotInventory() {
      const rows = await database.batch([
        database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'),
        database.prepare('SELECT * FROM inventory_movements ORDER BY id'),
        database.prepare('SELECT * FROM inventory_reservations ORDER BY id'),
        database.prepare('SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id')
      ])
      return createHash('sha256')
        .update(JSON.stringify(rows.map((row) => row.results)))
        .digest('hex')
    }
  })
  assert.equal(
    inventoryAlertsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : INVENTORY_ALERTS_BROWSER_SCENARIOS.length
  )
  completed += inventoryAlertsBrowserAudit.scenarios

  scenario = 'last_current_main_withdrawal_blocks_new_cart_and_quote_without_effects'
  const existingCart = await json<{ version: number; subtotal: number }>('/api/cart', cartCookie)
  const saleCounts = () =>
    database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM cart_commands) AS commands,
      (SELECT COUNT(*) FROM checkout_quotes) AS quotes,
      (SELECT COUNT(*) FROM inventory_reservations) AS reservations,
      (SELECT COUNT(*) FROM inventory_movements) AS movements`
      )
      .first()
  const beforeInvalidSales = await saleCounts()
  const lastMainWithdrawn = await runtime.dispatchFetch(`${origin}/api/admin/media/publications/${remainingMain.id}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: administrator.cookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID(),
      'if-match': '1'
    },
    body: JSON.stringify({ reason: 'End of disposable bootstrap evidence, not a production withdrawal' })
  })
  assert.equal(lastMainWithdrawn.status, 200)
  assert.equal((await fetch(`/api/products/${firstProduct.slug}`)).status, 404)
  assert.equal((await fetch(`/media/${remainingMain.id}/image?w=400&format=jpeg`)).status, 404)
  assert.equal((await json<{ total: number }>('/api/products')).total, 19)
  const blockedAddition = await post(
    '/api/cart/items',
    {
      variantId: variantIdentity.legacyId,
      quantity: variantIdentity.quantity,
      expectedVersion: existingCart.version,
      idempotencyKey: randomUUID()
    },
    cartCookie
  )
  assert.equal(blockedAddition.status, 422)
  assert.deepEqual(await blockedAddition.json(), { error: { code: 'variant_not_available' } })
  const blockedQuote = await runtime.dispatchFetch(`${origin}/api/shipping/rates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: cartCookie,
      'cf-connecting-ip': '192.0.2.123',
      'idempotency-key': randomUUID()
    },
    body: JSON.stringify({ postalCode: '28001', city: 'Madrid' })
  })
  assert.equal(blockedQuote.status, 422)
  assert.deepEqual(await blockedQuote.json(), { error: { code: 'variant_not_available' } })
  assert.deepEqual(await saleCounts(), beforeInvalidSales)
  const historicalCart = await json<{ version: number; subtotal: number }>('/api/cart', cartCookie)
  assert.equal(historicalCart.version, existingCart.version)
  assert.equal(historicalCart.subtotal, existingCart.subtotal)
  completed++

  // Keep the earlier fixed 20/19-product gates untouched. These three new
  // drafts enter the public catalogue only after those withdrawal assertions.
  const typedAttributesAudit = await auditNativeTypedAttributes({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    unprivilegedCookie: customer.cookie,
    scenario: markScenario,
    browserMode: nativeBrowserMode,
    publishSyntheticProducts: async (typedProducts) => {
      assert.equal(typedProducts.length, 3)
      // Reuse the original genuine local R2 bytes and their existing synthetic
      // evidence. Do not create new rights decisions or scanner approvals;
      // none of this certifies production rights or antivirus acceptance.
      await database.batch(
        typedProducts.map((product) => {
          const mappingId = randomUUID()
          return database
            .prepare(
              `INSERT INTO product_media_publications(id,product_id,upload_id,role,title,alt,language,version,
                valid_from,scan_receipt_id,rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
                VALUES (?,?,?,'main','Synthetic typed audit image','Imagen sintética local de atributos','es',
                  'synthetic-typed-audit',?,?,?,?,?,?,?)`
            )
            .bind(
              mappingId,
              product.id,
              bootstrapUploadId,
              bootstrapNow,
              bootstrapScanId,
              bootstrapRightsId,
              bootstrapPolicy.actor_id,
              bootstrapNow,
              mappingId,
              bootstrapHash
            )
        })
      )
      const policyCode = `typed_local_${randomUUID().slice(0, 8)}`
      const policy = await policyCommand(
        '/api/admin/catalog/policies',
        'POST',
        {
          code: policyCode,
          name: 'Synthetic local typed-attributes publication policy',
          expectedVersion: 0,
          requiredFields: ['regulatory.requiresSds'],
          requiredMediaRoles: [],
          identifierExceptionsAllowed: false,
          validFrom: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          validUntil: null,
          reason: 'Disposable typed fixture only, not commercial, legal or production antivirus acceptance'
        },
        randomUUID()
      )
      assert.equal(policy.status, 200)
      const receipt = catalogPolicyReceiptSchema.parse(await policy.json())
      assert.equal(receipt.action, 'policy_create')
      for (const product of typedProducts) {
        const path = `/api/admin/products/${product.legacyId}`
        const current = await json<{ uuid: string; catalogVersion: number; status: string }>(path, administrator.cookie)
        assert.equal(current.uuid, product.id)
        assert.equal(current.status, 'draft')
        const assigned = await policyCommand(
          `${path}/publication-policy`,
          'PUT',
          {
            expectedVersion: current.catalogVersion,
            policyId: receipt.resourceId,
            regulatory: { productType: policyCode, requiresSds: false },
            reason: 'Explicit synthetic typed fixture policy assignment, local only'
          },
          randomUUID()
        )
        assert.equal(assigned.status, 200)
        // The real state machine requires draft -> review -> published. Both
        // steps use fresh authoritative versions and propagate sellable variants.
        for (const status of ['review', 'published'] as const) {
          const fresh = await json<{ catalogVersion: number }>(path, administrator.cookie)
          const changed = await adminOperation(
            `${path}/status`,
            'PUT',
            {
              status,
              expectedVersion: fresh.catalogVersion,
              reason: 'Explicit local synthetic typed publication, not production acceptance'
            },
            administrator.cookie,
            randomUUID()
          )
          assert.equal(changed.status, 200)
        }
        const actual = await database
          .prepare('SELECT status FROM products WHERE id=?')
          .bind(product.id)
          .first<{ status: string }>()
        assert.equal(actual?.status, 'published')
        const variants = await database
          .prepare('SELECT status FROM variants WHERE product_id=?')
          .bind(product.id)
          .all<{ status: string }>()
        assert.equal(variants.results.length, 1)
        assert(variants.results.every((variant) => variant.status === 'published'))
        assert.equal((await fetch(`/api/products/${product.slug}`)).status, 200)
      }
    }
  })
  assert.equal(typedAttributesAudit.scenarios, nativeBrowserMode === 'not-run' ? 4 : 6)
  assert.equal(typedAttributesAudit.browserScenarios, nativeBrowserMode === 'not-run' ? 0 : 2)
  completed += typedAttributesAudit.scenarios

  // Additional support obligations stay queued. Execute after all fixed email
  // delivery counters, while this disposable customer's session is still live.
  const supportMacrosAudit = await auditNativeSupportMacros({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    customerCookie: customer.cookie,
    scenario: markScenario
  })
  assert.deepEqual(supportMacrosAudit.checks, [
    'native_support_macros_verified_general_ticket',
    'native_support_macros_draft',
    'native_support_macros_explicitly_synthetic_review',
    'native_support_macros_required_personalization',
    'native_support_macros_exact_preview',
    'native_support_macros_confirmed_exact_reply_queued',
    'native_support_macros_durable_queued_evidence',
    'native_support_macros_withdraw',
    'native_support_macros_withdrawn_exact_replay_no_extra_effect',
    'native_support_macros_withdrawn_new_send_denied',
    'native_support_macros_library_and_exact_historical_detail',
    'native_support_macros_private_authority_uniform_denials'
  ])
  assert.equal(supportMacrosAudit.scenarios, supportMacrosAudit.checks.length)
  completed += supportMacrosAudit.scenarios

  const satisfactionBrowserAudit = await auditNativeSatisfactionBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    async prepare(viewport) {
      const owner = viewport === 'desktop' ? customer : financialCustomer
      const deliveryOrderId = viewport === 'desktop' ? ownedCheckoutAudit.orderId : financialCheckoutAudit.orderId
      const createdResponse = await nativeDispatch(
        new Request(origin + '/api/support/tickets', {
          method: 'POST',
          headers: {
            origin,
            cookie: owner.cookie,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            'cf-connecting-ip': '192.0.2.149'
          },
          body: JSON.stringify({
            name: 'Synthetic satisfaction customer',
            email: `satisfaction-${viewport}@example.invalid`,
            category: 'other',
            subject: `Synthetic optional satisfaction ${viewport}`,
            message: 'Consulta sintética para verificar la valoración opcional del servicio.',
            privacyAcknowledged: true,
            website: ''
          })
        })
      )
      assert.equal(createdResponse.status, 201)
      const created = supportReceiptSchema.parse(await createdResponse.json())
      const resolvedResponse = await adminOperation(
        '/api/admin/support/' + created.publicRef,
        'PUT',
        {
          action: 'update',
          expectedVersion: created.version,
          reason: 'Resolución sintética documentada antes de la valoración',
          state: 'resolved',
          priority: 'normal',
          ownerId: null,
          nextActionAt: null,
          slaDueAt: null,
          resolution: 'Consulta sintética revisada y resuelta sin condicionar el servicio a una puntuación.'
        },
        administrator.cookie,
        randomUUID()
      )
      assert.equal(resolvedResponse.status, 200)
      const resolved = supportReceiptSchema.parse(await resolvedResponse.json())
      assert.equal(resolved.state, 'resolved')
      const deliveryResponse = await nativeDispatch(
        new Request(origin + '/api/account/satisfaction/delivery/' + deliveryOrderId, {
          headers: { cookie: owner.cookie, 'cf-connecting-ip': '192.0.2.149' }
        })
      )
      assert.equal(deliveryResponse.status, 200)
      assert.equal(customerSatisfactionSchema.parse(await deliveryResponse.json()).eligible, true)
      return { customerCookie: owner.cookie, supportRef: created.publicRef, deliveryOrderId }
    },
    scenario: markScenario
  })
  assert.equal(
    satisfactionBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : SATISFACTION_BROWSER_SCENARIOS.length
  )
  completed += satisfactionBrowserAudit.scenarios

  const packingBrowserAudit = await auditNativeOrderPackingBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    browserMode: nativeBrowserMode,
    async prepare(viewport) {
      scenario = `native_packing_${viewport}_dedicated_paid_setup`
      const owner = await identity('customer', false)
      const operator = await identity('admin', true)
      validateQuantity(4, financialVariant)
      const stock = adminInventoryVariantSchema.parse(
        await json(`/api/admin/inventory/variants/${financialVariant.legacyId}`, inventoryApprover.cookie)
      )
      assert.equal(stock.variant.uuid, financialVariant.id)
      assert(stock.balance.sellableQuantity >= 4, 'Packing checkout requires remaining real stock')
      const prepared = await auditNativeCheckoutPayment({
        dispatch: nativeDispatch,
        database,
        origin,
        variantId: financialVariant.legacyId,
        quantity: 4,
        shippingMethod: 'parcel',
        ownerCookie: owner.cookie,
        scenario: () => undefined
      })
      const fulfillmentPath = `/api/admin/orders/${prepared.orderId}/fulfillment`
      for (const [expectedVersion, action] of ['picking', 'packed'].entries()) {
        const commandId = randomUUID()
        const response = await adminOperation(
          fulfillmentPath + '/transitions',
          'POST',
          { action, expectedVersion, reason: 'Synthetic isolated packing preparation, not carrier confirmation' },
          operator.cookie,
          commandId
        )
        assert.equal(response.status, 200)
        const receipt = fulfillmentCommandReceiptSchema.parse(await response.json())
        assert.equal(receipt.orderId, prepared.orderId)
        assert.equal(receipt.commandId, commandId)
        assert.equal(receipt.version, expectedVersion + 1)
      }
      const fulfillment = adminOrderFulfillmentSchema.parse(await json(fulfillmentPath, operator.cookie))
      assert.equal(fulfillment.state, 'packed')
      assert.equal(fulfillment.version, 2)
      assert.equal(fulfillment.readiness.ready, true)
      const packing = adminOrderPackingSchema.parse(
        await json(`/api/admin/orders/${prepared.orderId}/packing`, operator.cookie)
      )
      assert.equal(packing.version, 0)
      assert.equal(packing.shippingMethod, 'parcel')
      assert.equal(
        packing.lines.reduce((sum, line) => sum + line.quantity, 0),
        4
      )
      assert.equal(packing.capabilities.packingWrite, true)
      const quota = await database
        .prepare("SELECT used FROM identity_rate_limits WHERE identity_id=? AND scope='admin-fulfillment'")
        .bind(operator.identityId)
        .first<{ used: number }>()
      assert.equal(quota?.used, 2, 'Fresh packing operator uses the unchanged real quota')
      return { adminCookie: operator.cookie, customerCookie: owner.cookie, orderId: prepared.orderId }
    },
    scenario: markScenario
  })
  assert.equal(packingBrowserAudit.scenarios, nativeBrowserMode === 'not-run' ? 0 : PACKING_BROWSER_SCENARIOS.length)
  completed += packingBrowserAudit.scenarios

  markScenario('native_private_basket_margin_read_only_without_activation')
  const basketAdministrator = await identity('admin', true)
  const basketVariant = await database
    .prepare(
      `
    SELECT v.id,v.minimum_quantity AS quantity,v.cost_net_cents AS costUnitNetCents
    FROM variants v JOIN products p ON p.id=v.product_id JOIN categories c ON c.id=p.category_id
    WHERE v.status='published' AND p.status='published' AND c.status='published'
      AND v.minimum_quantity BETWEEN 1 AND 999 AND ${publicationValidityExpression('p')}
    ORDER BY v.id LIMIT 1
  `
    )
    .first<{ id: string; quantity: number; costUnitNetCents: number | null }>()
  assert(basketVariant, 'A real published variant is required for the read-only margin simulation')
  const basketDomainStatements = [
    `SELECT
      (SELECT count(*) FROM carts) AS carts,
      (SELECT count(*) FROM cart_lines) AS cart_lines,
      (SELECT count(*) FROM checkout_quotes) AS quotes,
      (SELECT count(*) FROM shipping_quotes) AS shipping_quotes,
      (SELECT count(*) FROM orders) AS orders,
      (SELECT count(*) FROM inventory_reservations) AS reservations,
      (SELECT count(*) FROM promotion_rules) AS rules,
      (SELECT count(*) FROM promotion_admin_commands) AS commands,
      (SELECT count(*) FROM promotion_redemptions) AS redemptions`,
    'SELECT * FROM inventory_balances ORDER BY 1,2',
    'SELECT * FROM inventory_movements ORDER BY 1,2'
  ]
  const basketDomainHash = async () =>
    createHash('sha256')
      .update(
        JSON.stringify(
          (await database.batch(basketDomainStatements.map((sql) => database.prepare(sql)))).map(
            (result) => result.results
          )
        )
      )
      .digest('hex')
  const basketBefore = await basketDomainHash()
  const basketRequest = {
    lines: [{ variantId: basketVariant.id, quantity: basketVariant.quantity }],
    destination: { postalCode: '46870', city: 'Ontinyent' },
    customerId: null,
    rule: {
      id: randomUUID(),
      version: 1,
      code: 'LOCAL_BASKET_ONLY',
      status: 'paused',
      channel: 'online',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: null,
      benefit: { kind: 'fixed', grossCents: 1 },
      scope: { kind: 'all' },
      segment: 'all',
      totalLimit: null,
      perCustomerLimit: null,
      volumeMode: 'stack_volume'
    }
  }
  const basketResponse = await post('/api/admin/promotions/basket-preview', basketRequest, basketAdministrator.cookie)
  assert.equal(basketResponse.status, 200)
  assert.match(basketResponse.headers.get('cache-control') ?? '', /private.*no-store/)
  const basketResult = promotionBasketPreviewResponseSchema.parse(await basketResponse.json())
  assert.equal(basketResult.ruleEvaluation, 'proposed_active')
  assert.equal(basketResult.lines[0]!.variantId, basketVariant.id)
  assert.equal(basketResult.lines[0]!.quantity, basketVariant.quantity)
  const basketCost =
    basketVariant.costUnitNetCents === null ? null : basketVariant.costUnitNetCents * basketVariant.quantity
  assert.equal(basketResult.totals.proposed.costNetCents, basketCost)
  assert.equal(
    basketResult.totals.proposed.marginNetCents,
    basketCost === null ? null : basketResult.totals.proposed.netCents - basketCost
  )
  assert.equal(basketResult.totalMarginNetCents, null)
  assert.equal(basketResult.shipping.operationalCostNetCents, null)
  assert.equal((await post('/api/admin/promotions/basket-preview', basketRequest, customer.cookie)).status, 403)
  assert.equal(await basketDomainHash(), basketBefore)
  completed++

  markScenario('native_saved_cart_private_list_and_revocable_shared_snapshot')
  const snapshotOwner = await identity('customer', false)
  const snapshotNow = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const snapshotCart = await createCart(database, { now: snapshotNow, correlationId: 'native-cart-snapshot' })
  await setCartLine(database, {
    ...snapshotCart,
    variantId: basketVariant.id,
    quantity: basketVariant.quantity,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    now: snapshotNow,
    correlationId: 'native-cart-snapshot'
  })
  const snapshotCookie = `${snapshotOwner.cookie}; neteco-cart-v2=v1.${snapshotCart.cartId}.${snapshotCart.token}`
  const snapshotKey = randomUUID()
  const snapshotInput = { name: 'Synthetic saved cart ' + snapshotKey, expectedCartVersion: 2, createShare: true }
  const snapshotSourceHash = async () =>
    createHash('sha256')
      .update(
        JSON.stringify(
          (
            await database.batch([
              database.prepare('SELECT * FROM carts WHERE id=?1').bind(snapshotCart.cartId),
              database
                .prepare('SELECT * FROM cart_lines WHERE cart_id=?1 ORDER BY variant_id')
                .bind(snapshotCart.cartId),
              database.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id'),
              database.prepare('SELECT * FROM inventory_movements ORDER BY id')
            ])
          ).map((result) => result.results)
        )
      )
      .digest('hex')
  const snapshotBefore = await snapshotSourceHash()
  const sendSnapshot = () =>
    runtime!.dispatchFetch(`${origin}/api/account/cart-snapshots`, {
      method: 'POST',
      headers: {
        origin,
        cookie: snapshotCookie,
        'content-type': 'application/json',
        'idempotency-key': snapshotKey,
        'cf-connecting-ip': '192.0.2.123',
        'X-Neteco-Cart-Id': snapshotCart.cartId
      },
      body: JSON.stringify(snapshotInput),
      redirect: 'manual'
    })
  const savedSnapshotResponse = await sendSnapshot()
  assert.equal(savedSnapshotResponse.status, 201)
  assert.equal(savedSnapshotResponse.headers.get('cache-control'), 'private, no-store')
  const savedSnapshotText = await savedSnapshotResponse.text()
  const savedSnapshot = cartSnapshotResponseSchema.parse(JSON.parse(savedSnapshotText))
  assert(savedSnapshot.share)
  assert.equal(savedSnapshot.receipt.commandId, snapshotKey)
  assert.equal(savedSnapshot.receipt.payloadHash, await cartSnapshotIntentHash(snapshotInput))
  assert.notEqual(savedSnapshot.share.token, snapshotCart.token)
  const snapshotReplay = await sendSnapshot()
  assert.equal(snapshotReplay.status, 201)
  assert.equal(await snapshotReplay.text(), savedSnapshotText)
  const recoveredSnapshot = await fetch('/api/account/cart-snapshots/commands/' + snapshotKey, snapshotCookie, {
    'X-Neteco-Command-Payload-Hash': savedSnapshot.receipt.payloadHash,
    'X-Neteco-Cart-Id': snapshotCart.cartId
  })
  assert.equal(recoveredSnapshot.status, 200)
  const snapshotProof = cartSnapshotCommandSchema.parse(await recoveredSnapshot.json())
  assert(snapshotProof.outcome === 'applied' && snapshotProof.action === 'create')
  assert.deepEqual(snapshotProof.receipt, savedSnapshot.receipt)
  assert.deepEqual(snapshotProof.share, savedSnapshot.share)
  const snapshotList = cartSnapshotListSchema.parse(await json('/api/account/cart-snapshots', snapshotOwner.cookie))
  assert.equal(snapshotList.items.length, 1)
  assert.equal(snapshotList.items[0]!.receipt.listId, savedSnapshot.receipt.listId)
  assert(!JSON.stringify(snapshotList).includes(savedSnapshot.share.token))
  const sharedSnapshotInput = { id: savedSnapshot.share.id, token: savedSnapshot.share.token }
  const sharedSnapshotResponse = await post('/api/cart/shared/resolve', sharedSnapshotInput)
  assert.equal(sharedSnapshotResponse.status, 200)
  const sharedSnapshot = sharedCartResolveResponseSchema.parse(await sharedSnapshotResponse.json())
  assert.equal(sharedSnapshot.items[0]!.variantId, basketVariant.id)
  assert.equal(sharedSnapshot.items[0]!.quantity, basketVariant.quantity)
  assert(!JSON.stringify(sharedSnapshot).includes('cost'))
  const revokedSnapshotResponse = await adminOperation(
    '/api/account/cart-snapshots/' + savedSnapshot.share.id + '/revoke',
    'POST',
    {},
    snapshotOwner.cookie,
    randomUUID()
  )
  assert.equal(revokedSnapshotResponse.status, 200)
  assert.equal(
    cartSnapshotRevokeReceiptSchema.parse(await revokedSnapshotResponse.json()).shareId,
    savedSnapshot.share.id
  )
  assert.equal((await post('/api/cart/shared/resolve', sharedSnapshotInput)).status, 404)
  assert.equal(await snapshotSourceHash(), snapshotBefore)
  assert.equal(
    (await database
      .prepare('SELECT count(*) AS count FROM customer_favorite_items WHERE list_id=?1')
      .bind(savedSnapshot.receipt.listId)
      .first<{ count: number }>())!.count,
    1
  )
  const sharedPage = await fetch('/carrito/compartido')
  assert.equal(sharedPage.status, 200)
  assert(!(await sharedPage.text()).includes(savedSnapshot.share.token))
  completed++

  scenario = 'native_cart_snapshots_browser_acceptance'
  const cartSnapshotsBrowserAudit = await auditNativeCartSnapshotsBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepare(viewport) {
      // Lazy real owner/cart fixtures only. Prices, stock and publications
      // remain the current canonical catalog facts, never browser inventions.
      const owner = await identity('customer', false)
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const cart = await createCart(database, { now, correlationId: `native-cart-share-${viewport}` })
      const variant = await database
        .prepare("SELECT legacy_id AS legacyId FROM variants WHERE id=? AND status='published'")
        .bind(basketVariant.id)
        .first<{ legacyId: number | null }>()
      assert(variant?.legacyId, 'The current catalog variant needs its real storefront mapping')
      await setCartLine(database, {
        ...cart,
        variantId: basketVariant.id,
        quantity: basketVariant.quantity,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        now,
        correlationId: `native-cart-share-${viewport}`
      })
      return {
        customerCookie: owner.cookie,
        cartCookie: `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
        cartId: cart.cartId,
        cartVersion: 2,
        variantId: basketVariant.id,
        variantLegacyId: variant.legacyId,
        quantity: basketVariant.quantity
      }
    }
  })
  assert.equal(
    cartSnapshotsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : CART_SNAPSHOTS_BROWSER_SCENARIOS.length
  )
  completed += cartSnapshotsBrowserAudit.scenarios

  markScenario('native_catalog_relations_reviewed_directed_receipt_and_public_context')
  // Choose sources from the current canonical public catalog, never turn a
  // hidden/invalid product into a fixture by bypassing publication policy.
  const relationsCatalog = await json<{ items: Array<{ id: number; slug: string; name: string }> }>(
    '/api/products?limit=20'
  )
  assert(relationsCatalog.items.length >= 2)
  const relationsSource = relationsCatalog.items[0]!,
    relationsTarget = relationsCatalog.items[1]!
  assert.notEqual(relationsSource.id, relationsTarget.id)
  const relationsAdministrator = await identity('admin', true)
  const relationsPath = `/api/admin/products/${relationsSource.id}/relations`
  const relationsBefore = await basketDomainHash()
  const relationsCurrent = adminCatalogRelationsSchema.parse(await json(relationsPath, relationsAdministrator.cookie))
  const relationsInput = {
    expectedVersion: relationsCurrent.version,
    relations: [{ targetProductId: relationsTarget.id, kind: 'accessory' as const }],
    reason: 'Synthetic explicit directed catalog relation reviewed in the disposable audit',
    reviewReference: 'synthetic-local-catalog-review'
  }
  const relationsKey = randomUUID()
  const relationsResponse = await adminOperation(
    relationsPath + '/commands',
    'POST',
    relationsInput,
    relationsAdministrator.cookie,
    relationsKey
  )
  assert.equal(relationsResponse.status, 201)
  assert.match(relationsResponse.headers.get('cache-control') ?? '', /private.*no-store/)
  const relationsReceipt = catalogRelationsReceiptSchema.parse(await relationsResponse.json())
  const relationsHash = await catalogRelationsIntentHash(relationsSource.id, relationsInput)
  assert.equal(relationsReceipt.commandId, relationsKey)
  assert.equal(relationsReceipt.payloadHash, relationsHash)
  const relationsReplay = await adminOperation(
    relationsPath + '/commands',
    'POST',
    relationsInput,
    relationsAdministrator.cookie,
    relationsKey
  )
  assert.equal(relationsReplay.status, 201)
  assert.deepEqual(catalogRelationsReceiptSchema.parse(await relationsReplay.json()), relationsReceipt)
  const relationsRecovery = await fetch(relationsPath + '/commands/' + relationsKey, relationsAdministrator.cookie, {
    'X-Neteco-Command-Payload-Hash': relationsHash
  })
  assert.equal(relationsRecovery.status, 200)
  assert.deepEqual(catalogRelationsCommandSchema.parse(await relationsRecovery.json()), {
    source: 'cloudflare',
    outcome: 'applied',
    receipt: relationsReceipt
  })
  const relationsFresh = adminCatalogRelationsSchema.parse(await json(relationsPath, relationsAdministrator.cookie))
  assert.equal(relationsFresh.version, relationsReceipt.version)
  assert.deepEqual(relationsFresh.items, relationsInput.relations)
  const publicRelations = publicCatalogRelationsSchema.parse(
    await json('/api/product-relations?slugs=' + [relationsSource.slug, relationsTarget.slug].join(','))
  )
  assert(
    publicRelations.groups
      .find((group) => group.productSlug === relationsSource.slug)
      ?.items.some((item) => item.productId === relationsTarget.id && item.kind === 'accessory')
  )
  assert(
    !publicRelations.groups
      .find((group) => group.productSlug === relationsTarget.slug)
      ?.items.some((item) => item.productId === relationsSource.id),
    'A directed relation must not fabricate its reciprocal'
  )
  assert.equal((await fetch(relationsPath, customer.cookie)).status, 403)
  assert.equal(await basketDomainHash(), relationsBefore)
  completed++

  scenario = 'native_catalog_relations_browser_acceptance'
  const catalogRelationsBrowserAudit = await auditNativeCatalogRelationsBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: relationsAdministrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepare(viewport) {
      const owner = await identity('customer', false)
      const instant = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const variant = await database
        .prepare(
          `SELECT v.id,v.minimum_quantity AS quantity FROM variants v JOIN products p ON p.id=v.product_id
         WHERE p.legacy_id=? AND v.status='published' AND v.legacy_id IS NOT NULL
         AND v.minimum_quantity BETWEEN 1 AND 999 ORDER BY v.legacy_id LIMIT 1`
        )
        .bind(relationsSource.id)
        .first<{ id: string; quantity: number }>()
      assert(variant, 'The current published relation source requires a real storefront variant')
      const cart = await createCart(database, { now: instant, correlationId: 'native-relations-' + viewport })
      await setCartLine(database, {
        ...cart,
        variantId: variant.id,
        quantity: variant.quantity,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        now: instant,
        correlationId: 'native-relations-' + viewport
      })
      const created = await adminOperation(
        '/api/support/tickets',
        'POST',
        {
          name: 'Synthetic catalog customer',
          email: `catalog-${viewport}@example.invalid`,
          category: 'product',
          subject: 'Synthetic reviewed product relations ' + viewport,
          message: 'Consulta sintética de las relaciones publicadas, sin inferir compatibilidad química.',
          productSlug: relationsSource.slug,
          privacyAcknowledged: true,
          website: ''
        },
        owner.cookie,
        randomUUID()
      )
      assert.equal(created.status, 201)
      const ticket = supportReceiptSchema.parse(await created.json())
      const detail = supportCustomerTicketSchema.parse(
        await json('/api/account/support/' + ticket.publicRef, owner.cookie)
      )
      assert.equal(detail.productSlug, relationsSource.slug)
      return {
        sourceProductId: relationsSource.id,
        sourceSlug: relationsSource.slug,
        targetProductId: relationsTarget.id,
        targetSlug: relationsTarget.slug,
        targetName: relationsTarget.name,
        customerCookie: owner.cookie,
        cartCookie: `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
        supportRef: ticket.publicRef
      }
    }
  })
  assert.equal(
    catalogRelationsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : CATALOG_RELATIONS_BROWSER_SCENARIOS.length
  )
  completed += catalogRelationsBrowserAudit.scenarios

  scenario = 'native_promotions_browser_acceptance'
  const promotionsAdministrator = nativeBrowserMode === 'not-run' ? administrator : await identity('admin', true)
  const promotionsBrowserAudit = await auditNativePromotionsBrowser({
    database,
    dispatch: nativeDispatch,
    origin,
    adminCookie: promotionsAdministrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario,
    async prepare(viewport) {
      // Lazy fixtures only: no pre-created campaign, order, payment or stock.
      // The DOM creates and activates its own rule using the governed API.
      const owner = await identity('customer', false)
      const variant = await database
        .prepare(
          `SELECT v.id,v.sku,v.minimum_quantity AS quantity
        FROM variants v JOIN products p ON p.id=v.product_id
        WHERE v.status='published' AND p.status='published' AND p.source_version='demo-v1'
          AND v.legacy_id IS NOT NULL AND v.price_gross_cents>101
          AND v.minimum_quantity BETWEEN 1 AND 999
          AND NOT EXISTS(SELECT 1 FROM order_lines used WHERE used.variant_id=v.id)
          AND ${publicationValidityExpression('p')}
        ORDER BY v.legacy_id LIMIT 1`
        )
        .first<{ id: string; sku: string; quantity: number }>()
      assert(variant, 'A genuinely published unused seed variant is required')
      const instant = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      const cart = await createCart(database, { now: instant, correlationId: 'native-promotions-' + viewport })
      await setCartLine(database, {
        ...cart,
        variantId: variant.id,
        quantity: variant.quantity,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        now: instant,
        correlationId: 'native-promotions-' + viewport
      })
      const quote = await quoteCart(database, {
        ...cart,
        expectedVersion: 2,
        idempotencyKey: randomUUID(),
        now: instant,
        correlationId: 'native-promotions-' + viewport
      })
      assert(quote.outcome === 'quoted')
      assert(quote.quote.totals.grossCents > 101)
      assert(quote.quote.lines.every((line) => line.availableQuantity >= line.quantity || line.backorderAllowed))
      const ownerContext = await database
        .prepare('SELECT customer_id AS customerId FROM identities WHERE id=?1')
        .bind(owner.identityId)
        .first<{ customerId: string }>()
      assert(ownerContext?.customerId)
      return {
        customerCookie: owner.cookie,
        cartCookie: `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
        cartId: cart.cartId,
        variantId: variant.id,
        sku: variant.sku,
        customerId: ownerContext.customerId,
        code: `AUDIT_${viewport.toUpperCase()}_${randomUUID().replaceAll('-', '').toUpperCase()}`,
        startsAt: instant,
        quantity: variant.quantity,
        goodsGrossCents: quote.quote.totals.grossCents,
        discountGrossCents: 101
      }
    }
  })
  assert.equal(
    promotionsBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : PROMOTIONS_BROWSER_SCENARIOS.length
  )
  completed += promotionsBrowserAudit.scenarios

  markScenario('native_live_capabilities_synonym_preview_recovery_and_public_sku_effect')
  const capabilitiesResponse = await nativeDispatch(
    new Request(`${origin}/api/admin/capabilities`, { headers: { cookie: administrator.cookie } })
  )
  assert.equal(capabilitiesResponse.status, 200)
  assert.match(capabilitiesResponse.headers.get('cache-control') ?? '', /no-store/)
  const liveCapabilities = adminCapabilitiesSchema.parse(await capabilitiesResponse.json())
  assert.equal(liveCapabilities.identityId, administrator.identityId)
  assert.equal(liveCapabilities.sessionId, administrator.sessionId)
  assert.equal(liveCapabilities.state, 'ready')
  assert(liveCapabilities.permissions.includes('catalog.write'))
  const synonymSource = `nativealias${randomUUID().replaceAll('-', '')}`,
    synonymRoot = '/api/admin/search-synonyms',
    synonymKey = randomUUID(),
    currentPublicProducts = await json<{ items: Array<{ slug: string }> }>('/api/products?limit=1'),
    synonymProduct = currentPublicProducts.items[0]
  assert(synonymProduct)
  const synonymVariant = await database
    .prepare(
      "SELECT v.sku FROM variants v JOIN products p ON p.id=v.product_id WHERE p.slug=? AND v.status='published' AND length(v.sku)>=2 ORDER BY v.sku LIMIT 1"
    )
    .bind(synonymProduct.slug)
    .first<{ sku: string }>()
  assert(synonymVariant)
  const beforeSynonymSearch = await json<{ items: Array<{ slug: string }> }>(`/api/search?q=${synonymSource}`)
  assert.equal(beforeSynonymSearch.items.length, 0)
  const synonymPreviewResponse = await adminOperation(
    synonymRoot + '/preview',
    'POST',
    {
      draft: {
        id: null,
        expectedVersion: 0,
        sourceTerm: synonymSource,
        replacements: [synonymVariant.sku],
        active: true,
        reason: 'Isolated native public SKU search evidence',
        action: 'save'
      },
      query: synonymSource
    },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(synonymPreviewResponse.status, 200)
  const synonymPreview = searchSynonymPreviewSchema.parse(await synonymPreviewResponse.json())
  assert.equal(synonymPreview.before.length, 0)
  assert(synonymPreview.after.some((item) => item.slug === synonymProduct.slug))
  const synonymCommand = { previewId: synonymPreview.previewId, previewHash: synonymPreview.previewHash },
    synonymCreatedResponse = await adminOperation(synonymRoot, 'POST', synonymCommand, administrator.cookie, synonymKey)
  assert.equal(synonymCreatedResponse.status, 201)
  assert.match(synonymCreatedResponse.headers.get('cache-control') ?? '', /no-store/)
  const synonymCreated = searchSynonymReceiptSchema.parse(await synonymCreatedResponse.json()),
    synonymRecovered = searchSynonymReceiptSchema.parse(
      await json(`${synonymRoot}/commands/${synonymKey}`, administrator.cookie)
    ),
    synonymReplayResponse = await adminOperation(synonymRoot, 'POST', synonymCommand, administrator.cookie, synonymKey)
  assert.deepEqual(synonymRecovered, synonymCreated)
  assert.equal(synonymReplayResponse.status, 201)
  assert.deepEqual(searchSynonymReceiptSchema.parse(await synonymReplayResponse.json()), synonymCreated)
  const synonymListing = searchSynonymListSchema.parse(
    await json(`${synonymRoot}?q=${synonymSource}`, administrator.cookie)
  )
  assert.equal(synonymListing.total, 1)
  assert.equal(synonymListing.items[0]?.id, synonymCreated.item.id)
  const expandedSuggestions = await json<{ items: Array<{ slug: string }> }>(`/api/search?q=${synonymSource}`),
    expandedProducts = await json<{ items: Array<{ slug: string }> }>(`/api/products?q=${synonymSource}`)
  assert(expandedSuggestions.items.some((item) => item.slug === synonymProduct.slug))
  assert(expandedProducts.items.some((item) => item.slug === synonymProduct.slug))
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS n FROM search_synonym_commands WHERE actor_id=? AND idempotency_key=?')
        .bind(administrator.identityId, synonymKey)
        .first<{ n: number }>()
    )?.n,
    1
  )
  const nativeSearchSynonymsAudit = {
    scenarios: 1,
    receiptRecovered: true,
    replayDeduplicated: true,
    publicSkuExpansion: true
  }
  completed += nativeSearchSynonymsAudit.scenarios

  markScenario('native_cms_help_publication_category_search_feedback_recovery_and_withdrawal')
  const knowledgeNonce = randomUUID(),
    knowledgeTitle = `Ayuda de navegación ${knowledgeNonce}`,
    knowledgeSlug = `native-help-${knowledgeNonce}`,
    knowledgeRoot = '/api/admin/content/pages',
    knowledgeReviewDueAt = new Date(Date.now() + 366 * 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    knowledgeCreatedResponse = await adminOperation(
      knowledgeRoot,
      'POST',
      {
        title: knowledgeTitle,
        slug: knowledgeSlug,
        blocks: [
          {
            id: randomUUID(),
            type: 'paragraph',
            text: 'Artículo sintético para localizar el estado del pedido en la cuenta. No contiene consejos sobre productos ni seguridad química.'
          }
        ],
        seo: {
          title: 'Ayuda sintética de navegación',
          description: 'Evidencia local de publicación y revisión editorial de ayuda.',
          noindex: false
        },
        changeSummary: 'Creación explícita de ayuda sintética local',
        supportKnowledge: { category: 'envios', reviewDueAt: knowledgeReviewDueAt },
        expectedVersion: 0
      },
      administrator.cookie,
      randomUUID()
    )
  assert.equal(knowledgeCreatedResponse.status, 201)
  const knowledgeCreated = cmsCommandReceiptSchema.parse(await knowledgeCreatedResponse.json()),
    knowledgePath = `${knowledgeRoot}/${knowledgeCreated.pageId}`,
    knowledgeQuery = `/api/support/knowledge?q=${encodeURIComponent(knowledgeTitle)}&category=envios`
  assert.equal(supportKnowledgeListSchema.parse(await json(knowledgeQuery)).total, 0)
  const knowledgePublishedResponse = await adminOperation(
    `${knowledgePath}/publish`,
    'POST',
    {
      action: 'publish',
      expectedRevision: 0,
      expectedVersion: knowledgeCreated.pageVersion,
      versionId: knowledgeCreated.versionId,
      reason: 'Publicación humana explícita de ayuda sintética local'
    },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(knowledgePublishedResponse.status, 200)
  const knowledgePublished = cmsPublicationReceiptSchema.parse(await knowledgePublishedResponse.json()),
    publicKnowledgeResponse = await nativeDispatch(new Request(`${origin}${knowledgeQuery}`))
  assert.equal(publicKnowledgeResponse.status, 200)
  assert.match(publicKnowledgeResponse.headers.get('cache-control') ?? '', /no-store/)
  const publicKnowledge = supportKnowledgeListSchema.parse(await publicKnowledgeResponse.json())
  assert.equal(publicKnowledge.feedbackEnabled, true)
  assert.equal(publicKnowledge.total, 1)
  assert.equal(publicKnowledge.items[0]?.id, knowledgeCreated.pageId)
  assert.equal(publicKnowledge.items[0]?.versionId, knowledgeCreated.versionId)
  assert.equal(publicKnowledge.items[0]?.category, 'envios')
  assert.equal(publicKnowledge.items[0]?.reviewDueAt, knowledgeReviewDueAt)
  assert.equal(
    supportKnowledgeListSchema.parse(await json(knowledgeQuery.replace('category=envios', 'category=pagos'))).total,
    0
  )
  const feedbackKey = randomUUID(),
    feedbackBody = { pageId: knowledgeCreated.pageId, versionId: knowledgeCreated.versionId, helpful: true },
    feedbackResponse = await adminOperation('/api/support/knowledge/feedback', 'POST', feedbackBody, '', feedbackKey)
  assert.equal(feedbackResponse.status, 200)
  const feedbackReceipt = supportKnowledgeFeedbackReceiptSchema.parse(await feedbackResponse.json()),
    feedbackRecovered = supportKnowledgeFeedbackReceiptSchema.parse(
      await json(`/api/support/knowledge/feedback/${feedbackKey}`)
    ),
    feedbackReplay = await adminOperation('/api/support/knowledge/feedback', 'POST', feedbackBody, '', feedbackKey)
  assert.deepEqual(feedbackRecovered, feedbackReceipt)
  assert.equal(feedbackReplay.status, 200)
  assert.deepEqual(supportKnowledgeFeedbackReceiptSchema.parse(await feedbackReplay.json()), feedbackReceipt)
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) AS n FROM support_knowledge_feedback WHERE page_id=? AND version_id=?')
        .bind(knowledgeCreated.pageId, knowledgeCreated.versionId)
        .first<{ n: number }>()
    )?.n,
    1
  )
  const knowledgeWithdrawResponse = await adminOperation(
    `${knowledgePath}/withdraw`,
    'POST',
    {
      action: 'withdraw',
      expectedRevision: knowledgePublished.revision,
      expectedVersion: knowledgeCreated.pageVersion,
      reason: 'Retirada explícita de la publicación sintética al terminar la aceptación local'
    },
    administrator.cookie,
    randomUUID()
  )
  assert.equal(knowledgeWithdrawResponse.status, 200)
  cmsPublicationReceiptSchema.parse(await knowledgeWithdrawResponse.json())
  assert.equal(supportKnowledgeListSchema.parse(await json(knowledgeQuery)).total, 0)
  const nativeSupportKnowledgeAudit = {
    scenarios: 1,
    publishedCategorySearch: true,
    feedbackRecovered: true,
    replayDeduplicated: true,
    withdrawalExcluded: true
  }
  completed += nativeSupportKnowledgeAudit.scenarios

  markScenario('native_admin_recent_activity_confirmed_audit_permissions_cursor_and_read_only')
  // Fixed source whitelist only: never interpolate a DTO id or request input
  // as a SQL table/column. Only immutable audit metadata leaves these reads.
  const activityAuditSources = {
    catalog_category: { table: 'catalog_category_audit', id: 'id', action: 'action' },
    catalog_product_status: { table: 'catalog_product_status_audit', id: 'id', action: 'after_status' },
    catalog_policy: { table: 'catalog_policy_audit', id: 'id', action: 'action' },
    cms_draft: { table: 'content_draft_audit', id: 'id', action: 'action' },
    cms_publication: { table: 'content_publication_audit', id: 'command_id', action: 'action' },
    inventory: { table: 'inventory_admin_audit', id: 'id', action: 'action' },
    fulfillment: { table: 'order_fulfillment_audit', id: 'id', action: 'action' },
    support: { table: 'support_events', id: 'id', action: 'type' }
  } as const
  const activityCounts = async () => {
    const results = await database.batch(
      Object.values(activityAuditSources).map((source) =>
        database.prepare(`SELECT count(*) AS count FROM ${source.table}`)
      )
    )
    assert(results.every((result) => result.success && result.meta.rows_written === 0))
    return results.map((result) => result.results)
  }
  const activityBefore = await activityCounts()
  const activityCapabilities = adminCapabilitiesSchema.parse(
    await json('/api/admin/capabilities', administrator.cookie)
  )
  assert.equal(activityCapabilities.state, 'ready')
  const activityResponse = await fetch('/api/admin/activity?limit=5', administrator.cookie)
  assert.equal(activityResponse.status, 200)
  assert.equal(activityResponse.headers.get('cache-control'), 'private, no-store')
  assert.equal(activityResponse.headers.get('set-cookie'), null)
  const activity = adminActivityResponseSchema.parse(await activityResponse.json())
  assert(activity.items.length >= 1 && activity.items.length <= 5)
  const verifiedActivity = [...activity.items]
  if (activity.nextCursor !== null) {
    assert(activity.nextCursor.length <= 768)
    const next = adminActivityResponseSchema.parse(
      await json(`/api/admin/activity?limit=5&cursor=${encodeURIComponent(activity.nextCursor)}`, administrator.cookie)
    )
    assert(next.items.length <= 5)
    assert(!next.items.some((item) => activity.items.some((previous) => previous.id === item.id)))
    verifiedActivity.push(...next.items)
  }
  for (const item of verifiedActivity) {
    assert(canNavigateAdmin(item.to, activityCapabilities))
    assert.equal(item.to, ADMIN_ACTIVITY_DESTINATIONS[item.kind])
    assert.deepEqual(Object.keys(item).sort(), ['action', 'createdAt', 'id', 'kind', 'to'])
    const source = activityAuditSources[item.kind],
      auditId = item.id.slice(item.kind.length + 1),
      persisted = await database
        .prepare(
          `SELECT ${source.id} AS id,${source.action} AS action,created_at AS createdAt FROM ${source.table} WHERE ${source.id}=?`
        )
        .bind(auditId)
        .first<{ id: string; action: string; createdAt: string }>()
    assert(persisted)
    assert.equal(persisted.id, auditId)
    assert.equal(persisted.action, item.action)
    assert.equal(persisted.createdAt, item.createdAt)
  }
  for (let index = 1; index < verifiedActivity.length; index++) {
    const previous = verifiedActivity[index - 1]!,
      current = verifiedActivity[index]!
    assert(
      previous.createdAt > current.createdAt || (previous.createdAt === current.createdAt && previous.id > current.id)
    )
  }
  const unauthenticatedActivity = await fetch('/api/admin/activity?limit=5')
  assert.equal(unauthenticatedActivity.status, 401)
  assert.deepEqual(await unauthenticatedActivity.json(), { error: { code: 'unauthenticated' } })
  assert.equal((await fetch('/api/admin/activity?limit=5', customer.cookie)).status, 403)
  assert.deepEqual(await activityCounts(), activityBefore)
  const nativeAdminRecentActivityAudit = {
    scenarios: 1,
    status: 'passed',
    httpEntrypoint: 'actual_workerd_shop_fetch',
    auditedEventsVerified: verifiedActivity.length,
    permissionScopedDestinations: true,
    paginationBounded: true,
    auditCountsUnchanged: true
  }
  completed += nativeAdminRecentActivityAudit.scenarios

  scenario = 'native_admin_navigation_browser_acceptance'
  const adminNavigationBrowserAudit = await auditNativeAdminNavigationBrowser({
    dispatch: nativeDispatch,
    origin,
    adminCookie: administrator.cookie,
    browserMode: nativeBrowserMode,
    scenario: markScenario
  })
  assert.equal(
    adminNavigationBrowserAudit.scenarios,
    nativeBrowserMode === 'not-run' ? 0 : ADMIN_NAVIGATION_BROWSER_SCENARIOS.length
  )
  completed += adminNavigationBrowserAudit.scenarios
  // Explicit per-journey expectations: unexecuted browser work is pending,
  // never counted as passed merely because native HTTP checks completed.
  const browserScenarioCounts = [
    { expected: 2, executed: analyticsBrowserAudit.scenarios },
    { expected: 4, executed: catalogExportAudit.browser.status === 'passed' ? 4 : 0 },
    { expected: 7, executed: nativeImportBrowserProof.scenarios },
    { expected: 2, executed: typedAttributesAudit.browserScenarios },
    { expected: 2, executed: checkoutRecoveryBrowserAudit.scenarios },
    { expected: CART_ADD_RECOVERY_BROWSER_SCENARIOS.length, executed: cartAddRecoveryBrowserAudit.scenarios },
    { expected: ADMIN_NAVIGATION_BROWSER_SCENARIOS.length, executed: adminNavigationBrowserAudit.scenarios },
    { expected: ORDER_OPERATIONS_BROWSER_SCENARIOS.length, executed: orderOperationsBrowserAudit.scenarios },
    { expected: ORDER_RETURNS_BROWSER_SCENARIOS.length, executed: orderReturnsBrowserAudit.scenarios },
    { expected: COMPANY_REVIEW_BROWSER_SCENARIOS.length, executed: companyReviewBrowserAudit.scenarios },
    { expected: ACCOUNT_SETTINGS_BROWSER_SCENARIOS.length, executed: accountSettingsBrowserAudit.scenarios },
    { expected: QUICK_ORDER_BROWSER_SCENARIOS.length, executed: quickOrderBrowserAudit.scenarios },
    { expected: GUEST_ORDER_BROWSER_SCENARIOS.length, executed: guestOrderBrowserAudit.scenarios },
    { expected: INVENTORY_ALERTS_BROWSER_SCENARIOS.length, executed: inventoryAlertsBrowserAudit.scenarios },
    { expected: SATISFACTION_BROWSER_SCENARIOS.length, executed: satisfactionBrowserAudit.scenarios },
    { expected: PACKING_BROWSER_SCENARIOS.length, executed: packingBrowserAudit.scenarios },
    { expected: PROMOTIONS_BROWSER_SCENARIOS.length, executed: promotionsBrowserAudit.scenarios },
    { expected: CART_SNAPSHOTS_BROWSER_SCENARIOS.length, executed: cartSnapshotsBrowserAudit.scenarios },
    { expected: CATALOG_RELATIONS_BROWSER_SCENARIOS.length, executed: catalogRelationsBrowserAudit.scenarios },
    { expected: INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS.length, executed: inventoryCountImportBrowserAudit.scenarios }
  ]

  scenario = 'live_d1_session_revocation'
  await database.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').bind(now, customer.sessionId).run()
  const revoked = await fetch('/api/account', customer.cookie)
  assert.equal(revoked.status, 401)
  const revokedSession = await json<Record<string, unknown>>('/api/_auth/session', customer.cookie)
  assert.deepEqual(revokedSession, {})
  const revokedPage = await fetch('/cuenta/pedidos', customer.cookie)
  assert([302, 303, 307].includes(revokedPage.status))
  assert.match(revokedPage.headers.get('location') ?? '', /^\/login\?redirect=/)
  completed++

  scenario = 'no_outbound_network'
  assert.equal(outgoingRequests, 0)
  completed++
  console.log(
    JSON.stringify({
      audit: 'cloudflare-shop-local',
      status: nativeBrowserMode === 'not-run' ? 'passed_browser_pending' : 'passed',
      scenarios: completed,
      migrations: migrations.length,
      products: products.items.length,
      outboundRequests: outgoingRequests,
      editorialImport: { scenarios: editorialAudit.scenarios, profile: 'editorial_csv_v1', productsPerBatchLimit: 100 },
      catalogExport: catalogExportAudit,
      nativeCatalogImport: nativeCatalogImportAudit,
      nativeCatalogImportBrowser: nativeImportBrowserProof,
      typedAttributes: typedAttributesAudit,
      checkoutRecoveryBrowser: checkoutRecoveryBrowserAudit,
      cartAddRecoveryBrowser: cartAddRecoveryBrowserAudit,
      adminNavigationBrowser: adminNavigationBrowserAudit,
      adminRecentActivity: nativeAdminRecentActivityAudit,
      adminGlobalSearch: adminGlobalSearchAudit,
      orderTimeline: orderTimelineAudit,
      orderCancellation: orderCancellationAudit,
      orderExport: orderExportAudit,
      orderAnnotations: orderAnnotationsAudit,
      orderEmails: orderEmailsAudit,
      orderOperationsBrowser: orderOperationsBrowserAudit,
      orderReturnsBrowser: orderReturnsBrowserAudit,
      companyReviewBrowser: companyReviewBrowserAudit,
      accountSettingsBrowser: accountSettingsBrowserAudit,
      quickOrderBrowser: quickOrderBrowserAudit,
      guestOrderBrowser: guestOrderBrowserAudit,
      inventoryAlertsBrowser: inventoryAlertsBrowserAudit,
      inventoryCountImport: inventoryCountImportAudit,
      inventoryCountImportBrowser: inventoryCountImportBrowserAudit,
      satisfactionBrowser: satisfactionBrowserAudit,
      packingBrowser: packingBrowserAudit,
      promotionsBrowser: promotionsBrowserAudit,
      cartSnapshotsBrowser: cartSnapshotsBrowserAudit,
      catalogRelations: { scenarios: 1, directedOnly: true, economicStateUnchanged: true },
      catalogRelationsBrowser: catalogRelationsBrowserAudit,
      supportMacros: supportMacrosAudit,
      searchSynonyms: nativeSearchSynonymsAudit,
      supportKnowledge: nativeSupportKnowledgeAudit,
      cartAddReceipts: nativeCartAddReceiptAudit,
      browserMode: nativeBrowserMode,
      browserAcceptance: {
        status: nativeBrowserMode === 'not-run' ? 'pending' : 'passed',
        execution: nativeBrowserMode === 'not-run' ? 'not_run' : 'passed',
        executedScenarios: browserScenarioCounts.reduce((sum, journey) => sum + journey.executed, 0),
        pendingScenarios: browserScenarioCounts.reduce(
          (sum, journey) => sum + Math.max(0, journey.expected - journey.executed),
          0
        ),
        reason: nativeBrowserMode === 'not-run' ? analyticsBrowserAudit.reason : null,
        productionAcceptance: false
      },
      phase2: {
        scenarios: phase2Scenarios,
        cmsPublication: cmsPublicationAudit.scenarios,
        returns: returnsAudit.scenarios,
        fiscalRuntimeEmail: runtimeEmailAudit.scenarios,
        paidCheckouts: 3,
        httpEntrypoint: 'actual_workerd_shop_fetch',
        fiscalExecutor: 'host_worker_compatible_dispatchFiscalRuntime',
        fiscalProviderFactory: 'configuredFiscalProvider_local_fake_only',
        emailTransport: 'host_publishEmailOutbox_receiveEmailDispatch',
        emailDispatcher: 'host_dispatchTransactionalEmails_fake_local_sender',
        capturedSyntheticMessages: phase2CapturedSyntheticMessages,
        scheduledEntrypointExercised: false,
        queueEntrypointExercised: false,
        externalFiscalProviderAcceptance: false
      },
      phase3: {
        scenarios: phase3Scenarios,
        migrations: [
          '0048_order_refunds_credit_notes.sql',
          '0049_support_operations.sql',
          '0050_newsletter_editorial.sql',
          '0051_newsletter_local_validation.sql'
        ],
        refundsCredit: financialAudit.scenarios,
        support: supportAudit.scenarios,
        newsletterEditorial: newsletterAudit.scenarios,
        newsletterSender: 'actual_workerd_PersistentLocalNewsletterSender_synthetic_only',
        nativeNewsletterReceipts: newsletterLocalReceipts.results.length,
        newPaidCheckouts: 1,
        totalPaidCheckouts: 4,
        sourceFiscalRuntimeEmail: financialSourceFiscalAudit.scenarios,
        newReturnCustody: financialReturnsAudit.scenarios,
        httpEntrypoint: 'actual_workerd_shop_fetch',
        financialExecutors: 'host_worker_compatible_dispatchD1Refunds_dispatchD1CreditNotes',
        providerFactories: 'configuredRefundProvider_configuredCreditProvider_local_fake_only',
        sourceFiscalExecutor: 'host_worker_compatible_dispatchFiscalRuntime',
        supportScanner: 'actual_workerd_signed_private_r2_fixture_not_production_antivirus',
        emailTransport: 'host_publishEmailOutbox_receiveEmailDispatch',
        emailDispatcher: 'host_dispatchTransactionalEmails_customerEmailRenderers_fake_local_sender',
        capturedSyntheticMessages: phase3SentMessages.length,
        inventoryUnchangedAfterReturnsAndRefunds: true,
        originalCaptureAndInvoiceUnchanged: true,
        scheduledEntrypointExercised: false,
        queueEntrypointExercised: false,
        externalFinancialProviderAcceptance: false,
        externalEmailAcceptance: false
      },
      phase4: {
        scenarios: phase4Scenarios,
        migrations: ['0052_analytics_measurement.sql'],
        analytics: analyticsAudit,
        browser: analyticsBrowserAudit,
        realBankSettlementAcceptance: false,
        externalAnalyticsProviderAcceptance: false
      }
    })
  )
} catch (error) {
  // Do not print cookies, generated secrets, HTTP headers or rendered PII.
  const actual = error instanceof assert.AssertionError && typeof error.actual === 'number' ? error.actual : undefined
  const errorType =
    error instanceof assert.AssertionError
      ? 'AssertionError'
      : error instanceof TypeError
        ? 'TypeError'
        : error instanceof Error
          ? 'Error'
          : 'unknown'
  // Location-only frames identify the failed gate without logging the error
  // message, argument values, SQL, provider payloads or identifiers.
  const locationError =
    error instanceof OrderReturnsBrowserDiagnosticError && error.cause instanceof Error ? error.cause : error
  const locations =
    locationError instanceof Error
      ? Array.from(locationError.stack?.matchAll(/(?:scripts|workers|shared)\/[\w./-]+\.(?:ts|js):\d+:\d+/g) ?? [])
          .slice(0, 4)
          .map((match) => match[0])
      : []
  console.error(
    JSON.stringify({
      audit: 'cloudflare-shop-local',
      status: 'failed',
      scenario,
      completed,
      browserMode: nativeBrowserMode,
      optionError:
        scenario === 'cli_options'
          ? 'Only --without-browser is supported; browser checks are required by default.'
          : undefined,
      actual,
      errorType,
      browserDiagnostic:
        error instanceof OrderOperationsBrowserDiagnosticError || error instanceof OrderReturnsBrowserDiagnosticError
          ? error.safeDiagnostic
          : error instanceof InventoryCountImportBrowserError
            ? {
                stage: error.safeDiagnostic.stage,
                viewport: error.safeDiagnostic.viewport,
                documentStatus: error.safeDiagnostic.documentStatus,
                routeKind: error.safeDiagnostic.routeKind,
                panelCount: error.safeDiagnostic.panelCount,
                sessionStatus: error.safeDiagnostic.sessionStatus,
                capabilitiesStatus: error.safeDiagnostic.capabilitiesStatus,
                bootstrap: {
                  scriptsRequested: error.safeDiagnostic.bootstrap.scriptsRequested,
                  scriptResponses200: error.safeDiagnostic.bootstrap.scriptResponses200,
                  scriptResponsesNon200: error.safeDiagnostic.bootstrap.scriptResponsesNon200,
                  scriptMimeNonJs: error.safeDiagnostic.bootstrap.scriptMimeNonJs,
                  scriptsFailed: error.safeDiagnostic.bootstrap.scriptsFailed,
                  consoleErrors: {
                    csp: error.safeDiagnostic.bootstrap.consoleErrors.csp,
                    script_mime: error.safeDiagnostic.bootstrap.consoleErrors.script_mime,
                    module_load: error.safeDiagnostic.bootstrap.consoleErrors.module_load,
                    hydration: error.safeDiagnostic.bootstrap.consoleErrors.hydration,
                    other: error.safeDiagnostic.bootstrap.consoleErrors.other
                  },
                  nuxtAppPresent: error.safeDiagnostic.bootstrap.nuxtAppPresent,
                  hydrating: error.safeDiagnostic.bootstrap.hydrating,
                  runtimeCloudflare: error.safeDiagnostic.bootstrap.runtimeCloudflare,
                  sessionReady: error.safeDiagnostic.bootstrap.sessionReady,
                  loggedIn: error.safeDiagnostic.bootstrap.loggedIn,
                  emailVerified: error.safeDiagnostic.bootstrap.emailVerified,
                  mfaVerified: error.safeDiagnostic.bootstrap.mfaVerified,
                  sessionShapeValid: error.safeDiagnostic.bootstrap.sessionShapeValid,
                  navigationStatus: error.safeDiagnostic.bootstrap.navigationStatus,
                  capabilitiesState: error.safeDiagnostic.bootstrap.capabilitiesState,
                  capabilitiesMatchSession: error.safeDiagnostic.bootstrap.capabilitiesMatchSession
                },
                transportFailure: error.safeDiagnostic.transportFailure,
                pageErrors: error.safeDiagnostic.pageErrors,
                previewPosts: error.safeDiagnostic.previewPosts,
                proposalPosts: error.safeDiagnostic.proposalPosts,
                approvalPosts: error.safeDiagnostic.approvalPosts,
                lostResponses: error.safeDiagnostic.lostResponses,
                receiptGets: error.safeDiagnostic.receiptGets
              }
            : undefined,
      locations
    })
  )
  process.exitCode = 1
} finally {
  try {
    await runtime?.dispose()
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
