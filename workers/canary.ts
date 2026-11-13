import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { handleDeploymentHealth } from './runtime/deployment-health'
import { listPublishedCategories } from './catalog/categories'
import { listPublishedProducts, type ProductSort } from './catalog/products'
import { getPublishedProductDetail } from './catalog/product-detail'
import { readD1B2BPricingAuthority } from './catalog/b2b-pricing'
import { handleProductCompareHttp, ownsProductCompareNamespace } from './catalog/product-compare-http'
import { handlePublicSearchHttp } from './catalog/search-http'
import { handleSearchSynonymsHttp, ownsSearchSynonymsNamespace } from './catalog/search-synonyms-http'
import { handleSearchGapHttp, ownsSearchGapNamespace } from './catalog/search-gap-programme-http'
import { handleSearchMerchandisingHttp, ownsSearchMerchandisingNamespace } from './catalog/search-merchandising-http'
import {
  handleCategoryMerchandisingHttp,
  ownsCategoryMerchandisingNamespace
} from './catalog/category-merchandising-http'
import { handleSemanticSearchHttp, ownsSemanticSearchNamespace } from './catalog/semantic-search-http'
import { handlePersonalizedRerankHttp, ownsPersonalizedRerankNamespace } from './catalog/personalized-rerank-http'
import { handleCatalogRelationsHttp, ownsCatalogRelationsNamespace } from './catalog/catalog-relations-http'
import { handleProductDetailExtrasHttp, ownsProductDetailExtrasNamespace } from './catalog/product-detail-extras-http'
import {
  handleProductRecommendationsHttp,
  ownsProductRecommendationsNamespace
} from './catalog/product-recommendations-http'
import { handleD1SeoRequest, ownsD1SeoNamespace } from './catalog/seo-http'
import { handleOgImageHttp } from './seo/og-image-http'
import { ogImageRuntime } from './seo/og-image-runtime'
import { parseOgImagePath } from '../shared/og-image'
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
import { activeOrderCustomerId, listD1CustomerOrders, readD1CustomerOrderLines } from './catalog/customer-orders'
import { handleCustomerFavoritesHttp } from './catalog/customer-favorites-http'
import { handleCustomerCartSnapshotsHttp, ownsCartSnapshotsNamespace } from './catalog/cart-snapshots-http'
import { handleD1AdminOrdersRequest } from './catalog/admin-orders-http'
import { handleOrderTimelineHttp } from './catalog/order-timeline-http'
import { handleOrderCancellationHttp } from './catalog/order-cancellation-http'
import { handleOrderExportHttp } from './catalog/order-export-http'
import { handleOrderAnnotationsHttp } from './catalog/order-annotations-http'
import { handleAdminFulfillmentHttp, ownsAdminFulfillmentNamespace } from './fulfillment/admin-http'
import { handleAdminPackingHttp, ownsAdminPackingNamespace } from './fulfillment/packing-http'
import { handleCarrierScorecardHttp, ownsCarrierScorecardNamespace } from './fulfillment/carrier-scorecard-http'
import { handleDeliverySurveyHttp, ownsDeliverySurveyNamespace } from './fulfillment/delivery-survey-http'
import { handleCarrierManifestsHttp, ownsCarrierManifestsNamespace } from './fulfillment/carrier-manifests-http'
import { handleDeliveryDriverAppHttp, ownsDeliveryDriverAppNamespace } from './fulfillment/delivery-driver-app-http'
import { handlePackingOptimizerHttp, ownsPackingOptimizerNamespace } from './fulfillment/packing-optimizer-http'
import { handleSupportLiveChatHttp, ownsSupportLiveChatNamespace } from './support/live-chat-http'
import { handleCustomerAccountManagerHttp, ownsCustomerAccountManagerNamespace } from './crm/account-manager-http'
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
import {
  handleContentGovernanceAdminHttp,
  handleContentGovernancePublicHttp,
  ownsContentGovernanceAdminNamespace,
  ownsContentGovernancePublicNamespace
} from './content/content-governance-http'
import {
  handleDownloadableTemplatesHttp,
  ownsDownloadableTemplatesNamespace
} from './content/downloadable-templates-http'
import { handleBrandCenterHttp, ownsBrandCenterNamespace } from './brand/brand-center-http'
import { handleWarehouseAdrAssetsHttp, ownsWarehouseAdrAssetsNamespace } from './fulfillment/warehouse-adr-assets-http'
import { handleProcurementApprovalsHttp, ownsProcurementApprovalsNamespace } from './orders/procurement-approvals-http'
import { handleSplitBackordersHttp, ownsSplitBackordersNamespace } from './orders/split-backorders-http'
import { handlePaymentContingencyHttp, ownsPaymentContingencyNamespace } from './payments/contingency-routing-http'
import { alternativeProviderFromEnv } from './payments/alternative-contingency-provider'
import { handleCmsMediaHttp } from './cms/media-delivery'
import { runCmsSchedules } from './cms/schedules'
import { handleAdminReturnsHttp, ownsAdminReturnsNamespace } from './returns/admin-http'
import { handleCustomerReturnsHttp, ownsCustomerReturnsNamespace } from './returns/customer-http'
import { handleD1FiscalRequest, ownsFiscalNamespace } from './fiscal/http'
import { dispatchFiscalRuntime } from './fiscal/runtime-dispatch'
import { handleBeplyOrdersRequest, ownsBeplyOrdersNamespace } from './integrations/beply-orders-http'
import {
  beplyOrdersRuntimeProvider,
  consumeBeplyOrdersMessage,
  dispatchConfiguredBeplyOrders,
  type BeplyOrdersVariables
} from './integrations/beply-orders-runtime'
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
  handleMarketingModalsHttp,
  isAdminMarketingModalsPath,
  ownsMarketingModalsNamespace
} from './marketing/marketing-modals-http'
import {
  handleAdminInventoryHttp,
  inventoryCommandErrorCodeSchema,
  ownsAdminInventoryNamespace
} from './catalog/admin-inventory-http'
import { InventoryCommandError } from './catalog/admin-inventory'
import { handleInventoryAlertsHttp, ownsInventoryAlertsNamespace } from './catalog/inventory-alerts-http'
import { handleInventoryPlanningHttp, ownsInventoryPlanningNamespace } from './catalog/inventory-planning-http'
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
import { handleWalletHttp, walletAppleAssociationFromEnv, walletEvidenceFromEnv } from './payments/wallet-http'
import { handleTokenizationHttp, ownsSavedCardsNamespace } from './payments/tokenization-http'
import { captureTokenAfterPayment } from './payments/tokenization'
import { configuredTokenization, type TokenizationRuntime } from './payments/tokenization-runtime'
import { handlePreauthHttp, isPreauthNotificationPath, ownsPreauthNamespace } from './payments/preauth-http'
import { configuredPreauth, type PreauthRuntime } from './payments/preauth-runtime'
import { sweepPreauthorizations } from './payments/preauth'
import { handlePaymentFunnelHttp, ownsPaymentFunnelNamespace } from './payments/funnel-http'
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
import { handleSecurityAnomaliesHttp, ownsSecurityAnomaliesNamespace } from './auth/security-anomalies-http'
import { handleAdminOrderViewsHttp, ownsAdminOrderViewsNamespace } from './catalog/admin-order-views-http'
import { supportJson } from './support/http'
import { handleAdminActivityHttp } from './auth/admin-activity-http'
import { handleAdminGlobalSearchHttp } from './auth/admin-global-search-http'
import { handleAdminCompaniesHttp } from './auth/admin-companies-http'
import { handleAccountPrivacyHttp } from './auth/account-privacy-http'
import { handleAdminAiAssistantHttp, ownsAdminAiAssistantNamespace } from './admin/ai-assistant-http'
import { handleCatalogAiGenerationHttp, ownsCatalogAiGenerationNamespace } from './catalog/ai-generation-http'
import { handleMediaAiEnrichmentHttp, ownsMediaAiEnrichmentNamespace } from './catalog/media-ai-enrichment-http'
import { handleAiopsHttp, ownsAiopsNamespace } from './observability/aiops-http'
import { handlePerformanceInsightsHttp, ownsPerformanceInsightsNamespace } from './performance/performance-http'
import { handleSupportCopilotHttp, ownsSupportCopilotNamespace } from './support/copilot-http'
import { handleSupportRcaHttp, ownsSupportRcaNamespace } from './support/rca-http'
import { handleSupportInsightsAdminHttp, ownsSupportInsightsAdminNamespace } from './support/insights-http'
import { handleAudiencesHttp, ownsAudiencesNamespace } from './marketing/audiences-http'
import { handleBundlesHttp, ownsBundlesNamespace } from './marketing/bundles-http'
import { handleEventsHttp, ownsEventsNamespace } from './marketing/events-http'
import { handleReferralsHttp, ownsReferralsNamespace } from './marketing/referrals-http'
import { handleQuickOrderCompanyHttp, ownsQuickOrderCompanyNamespace } from './catalog/quick-order-company-http'
import { handlePromoFraudHttp, ownsPromoFraudNamespace } from './security/promo-fraud-http'
import { purgePromoFraudSignals } from './security/promo-fraud'
import {
  handleMarketingAutomationsHttp,
  ownsMarketingAutomationsNamespace
} from './marketing/marketing-automations-http'
import { handleBrowseAbandonmentHttp, ownsBrowseAbandonmentNamespace } from './marketing/browse-abandonment-http'
import { handleWelcomeCouponHttp, ownsWelcomeCouponNamespace } from './marketing/welcome-coupon-http'
import { handleRecommendationEngineHttp, ownsRecommendationEngineNamespace } from './catalog/recommendation-engine-http'
import { handleCrmAutomationMetricsHttp, ownsCrmAutomationMetricsNamespace } from './crm/crm-automation-metrics-http'
import {
  handleMarketingObservabilityHttp,
  ownsMarketingObservabilityNamespace
} from './marketing/marketing-automation-observability-http'
import { handleAnomalyDetectionHttp, ownsAnomalyDetectionNamespace } from './observability/anomaly-detection-http'
import {
  handlePromotionsAutomationMatrixHttp,
  ownsPromotionsAutomationMatrixNamespace
} from './marketing/promotions-automation-matrix-http'
import { handleAccountIsolationHttp, ownsAccountIsolationNamespace } from './security/account-isolation-http'
import {
  handleWarehouseRouteOfflineHttp,
  ownsWarehouseRouteOfflineNamespace
} from './fulfillment/warehouse-route-offline-http'
import { handleGameDayHttp, ownsGameDayNamespace } from './observability/game-day-resilience-http'
import { handleExperimentsHttp, ownsExperimentsNamespace } from './analytics/experiments-http'
import { handleGrowthHttp, ownsGrowthNamespace } from './growth/growth-http'
import { handlePricingHttp, ownsPricingNamespace } from './pricing/pricing-http'
import {
  handleInventoryLotsCostingForecastHttp,
  ownsInventoryLotsCostingForecastNamespace
} from './catalog/inventory-lots-costing-forecast-http'
import {
  handleInventoryOpsHttp,
  ownsInventoryOpsNamespace
} from './catalog/inventory-commitments-picking-purchasing-http'
import {
  handleCustomerRecurringListsHttp,
  ownsCustomerRecurringListsNamespace
} from './catalog/customer-recurring-lists-http'
import { handleMarketCatalogHttp, ownsMarketCatalogNamespace } from './catalog/market-catalog-http'
import {
  handleInternationalFeedsAdrHttp,
  ownsInternationalFeedsAdrNamespace
} from './catalog/international-feeds-adr-http'
import { handleProductMediaGuidesHttp, ownsProductMediaGuidesNamespace } from './catalog/product-media-guides-http'
import { handleProductReviewsQaHttp, ownsProductReviewsQaNamespace } from './catalog/product-reviews-qa-http'
import { handleProductRecallHttp } from './catalog/product-recall-http'
import { handleCheckoutMarketHttp, handlePublicCheckoutMarketHttp } from './catalog/market-checkout-http'
import { handleB2BHttp } from './catalog/b2b-http'
import { handleHighValueConsentHttp } from './communications/high-value-consent-http'
import { handleHighValueMessagesHttp } from './communications/high-value-messages-http'
import { handleWhatsAppBusinessHttp } from './communications/whatsapp-business-http'
import { handleHighValueOptOutHttp } from './communications/high-value-optout-http'
import {
  handleAccountNotificationsHttp,
  ownsAccountNotificationsNamespace
} from './communications/account-notifications-http'
import { handleMultichannelHttp, ownsMultichannelNamespace } from './communications/multichannel-http'
import { handleCustomerRiskScoringHttp, ownsCustomerRiskScoringNamespace } from './crm/risk-scoring-http'
import { handleB2bEdiHttp, ownsB2bEdiNamespace } from './b2b/edi-gateway-http'
import { handleB2bPublicAdmin, ownsB2bPublicAdminNamespace } from './developer-platform/b2b-public-admin'
import { handleDeveloperOwnership, ownsDeveloperOwnershipNamespace } from './developer-platform/ownership-http'
import { handleConnectorsHttp, ownsConnectorsNamespace } from './developer-platform/connector-marketplace'
import { handleIntegrationsHttp, ownsIntegrationsNamespace } from './integrations/integrations-http'
import { handleB2bPublicApi, ownsB2bPublicApiNamespace, resetB2bSandbox } from './developer-platform/b2b-public-api'
import {
  handleCompanyShippingConditionsHttp,
  ownsCompanyShippingConditionsNamespace
} from './fulfillment/company-shipping-conditions-http'
import { handleConveniencePointsHttp, ownsConveniencePointsNamespace } from './fulfillment/convenience-points-http'
import { handleDeliveryRoutesHttp, ownsDeliveryRoutesNamespace } from './fulfillment/delivery-routes-http'
import { handleB2BContractSloHttp, ownsB2BContractSloNamespace } from './observability/b2b-slo-http'
import { handleCapacityPlanningHttp, ownsCapacityPlanningNamespace } from './observability/capacity-planning-http'
import { handleErrorBudgetHttp, ownsErrorBudgetNamespace } from './observability/error-budget-http'
import { handleAlphaBetaPromotionHttp, ownsAlphaBetaPromotionNamespace } from './release/alpha-beta-promotion-http'
import { handleProgressiveRolloutHttp, ownsProgressiveRolloutNamespace } from './release/progressive-rollout-http'
import { handleCloudflarePolicyHttp, ownsCloudflarePolicyNamespace } from './release/cloudflare-policy-http'
import { handleCampaignPipelineHttp, ownsCampaignPipelineNamespace } from './cms/campaign-pipeline-http'
import { handleOperationalAlertsHttp, ownsOperationalAlertsNamespace } from './communications/operational-alerts-http'
import {
  handleSendTimeOptimizationHttp,
  ownsSendTimeOptimizationNamespace
} from './communications/send-time-optimization-http'
import {
  handleWarehouseRouteTelemetryHttp,
  ownsWarehouseRouteTelemetryNamespace
} from './observability/warehouse-route-telemetry-http'
import { handlePaymentTokenRemovalHttp } from './payments/token-removal-http'
import { handlePayGoldLinksHttp } from './payments/paygold-links-http'
import { handlePayGoldDraftHttp } from './payments/paygold-draft-http'
import { configuredPayGoldDraftIssue, configuredPayGoldIssue, type PayGoldRuntime } from './payments/paygold-runtime'
import { runConfiguredTokenRemovalRecovery, type TokenRemovalRuntime } from './payments/token-removal-runtime'
import { handleSecurityControlsHttp, ownsSecurityControlsNamespace } from './security/security-controls-http'
import { handleSeoHttp, ownsSeoNamespace } from './seo/seo-http'
import { handleSeoContentDashboardHttp, ownsSeoContentDashboardNamespace } from './seo/content-dashboard-http'
import { handleB2bSalesMetricsHttp, ownsB2bSalesMetricsNamespace } from './b2b/metrics-http'
import { handleCostToServeHttp, ownsCostToServeNamespace } from './analytics/cost-to-serve-http'
import { handleUgcReviewsHttp, ownsUgcReviewsNamespace } from './media/ugc-reviews-http'
import { handleCustomerCaseStudiesHttp, ownsCustomerCaseStudiesNamespace } from './cms/customer-case-studies-http'
import { handleLearningCentreHttp, ownsLearningCentreNamespace } from './learning/learning-centre-http'
import { handleTargetedCampaignsHttp, ownsTargetedCampaignsNamespace } from './marketing/targeted-campaigns-http'
import { handleRecurringIncentivesHttp, ownsRecurringIncentivesNamespace } from './b2b/recurring-incentives-http'
import {
  handlePredictivePersonalizationHttp,
  ownsPredictivePersonalizationNamespace
} from './marketing/predictive-personalization-http'
import { handleModelEvaluationHttp, ownsModelEvaluationNamespace } from './analytics/model-evaluation-http'
import { handleCmsPreviewComparisonHttp, ownsCmsPreviewComparisonNamespace } from './cms/preview-comparison-http'
import { handleRoleDashboardHttp, ownsRoleDashboardNamespace } from './admin/role-dashboard-http'
import { handleCommercialCampaignsHttp, ownsCommercialCampaignsNamespace } from './marketing/commercial-campaigns-http'
import { handleSeasonalCampaignsHttp, ownsSeasonalCampaignsNamespace } from './marketing/seasonal-campaigns-http'
import { handleSupplierFeedHttp, ownsSupplierFeedNamespace } from './catalog/supplier-feed-comparison-http'
import { handleEditorialContentHttp, ownsEditorialContentNamespace } from './catalog/editorial-content-http'
import { handleSupplierSourcingHttp, ownsSupplierSourcingNamespace } from './catalog/supplier-sourcing-http'
import { handleDraftOrdersHttp, ownsDraftOrdersNamespace } from './b2b/draft-orders-http'
import { handleEditorialBriefingHttp, ownsEditorialBriefingNamespace } from './cms/editorial-seo-briefing-http'
import {
  handleCommercialQuotesAccountsHttp,
  ownsCommercialQuotesAccountsNamespace
} from './catalog/commercial-quotes-accounts-http'
import { handleWarehouseScanHttp, ownsWarehouseScanNamespace } from './fulfillment/warehouse-scan-operations-http'
import { handleAccountPreferencesHttp } from './auth/account-preferences-http'
import { handleAccountLifecycleHttp, ownsAccountLifecycleNamespace } from './auth/account-lifecycle-http'
import { scheduleReplenishmentReminders } from './auth/replenishment-reminders'
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

/** Fail-closed guards shared by the HTTP modules mounted below. */
function isAdministrativePath(path: string): boolean {
  // Encoded aliases are treated as administrative so they can never skip the stricter guard.
  return /^\/api\/admin(?:[/\\%]|$)/i.test(path) || path.includes('%')
}

function privateJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'private, no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' }
  })
}

function authUnavailable(env: CloudflareEnv): Response | null {
  return env.AUTH_ENABLED === 'true' ? null : privateJson({ error: { code: 'service_unavailable' } }, 503)
}

/** B2B public API and its key administration need both AUTH_ENABLED and their own feature flag. */
function b2bPublicUnavailable(env: CloudflareEnv): Response | null {
  const flag = (env as unknown as Record<string, string | undefined>).B2B_PUBLIC_API_ENABLED
  return env.AUTH_ENABLED === 'true' && flag === 'true'
    ? null
    : privateJson({ error: { code: 'service_unavailable' } }, 503)
}

async function mountEdgeLimit(
  request: Request,
  env: CloudflareEnv,
  administrative: boolean,
  scope: string
): Promise<Response | null> {
  const limited = await checkAdministrativeEdgeLimit(
    request,
    administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
    env.AUTH_RATE_LIMIT_PEPPER,
    scope as Parameters<typeof checkAdministrativeEdgeLimit>[3]
  )
  if (limited === 'allowed') return null
  return privateJson(
    { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
    limited === 'limited' ? 429 : 503
  )
}

/** AUTH_ENABLED 503 guard plus edge limiter; null means the request may proceed. */
async function mountGuard(
  request: Request,
  env: CloudflareEnv,
  administrative: boolean,
  scope: string,
  options: { requireAuth?: boolean } = {}
): Promise<Response | null> {
  if (options.requireAuth !== false) {
    const unavailable = authUnavailable(env)
    if (unavailable) return unavailable
  }
  const crossOrigin = crossOriginMutation(request, env)
  if (crossOrigin) return crossOrigin
  return mountEdgeLimit(request, env, administrative, scope)
}

/** Defence in depth beside SameSite=Lax: mutating requests from another origin never reach a module. */
function crossOriginMutation(request: Request, env: CloudflareEnv): Response | null {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return null
  const origin = request.headers.get('origin')
  const rejected = privateJson({ error: { code: 'csrf_rejected' } }, 403)
  if (origin !== null) return origin !== env.AUTH_ORIGIN ? rejected : null
  if (/(?:^|;\s*)neteco-session=/.test(request.headers.get('cookie') ?? '')) return rejected
  // No Origin header: browsers still disclose cross-site context via Fetch Metadata or Referer.
  // Header-less server-to-server callers (webhooks, B2B API keys) remain unaffected.
  if (request.headers.get('sec-fetch-site') === 'cross-site') return rejected
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      if (new URL(referer).origin !== env.AUTH_ORIGIN) return rejected
    } catch {
      return rejected
    }
  }
  return null
}

function mountSession(env: CloudflareEnv) {
  return { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 }
}

function mountSessionOrNull(env: CloudflareEnv) {
  return env.AUTH_ENABLED === 'true' ? mountSession(env) : null
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

async function catalogSession(request: Request, env: CloudflareEnv) {
  if (!hasSessionCookie(request))
    return { claims: null, customerId: null, pricingCustomerId: undefined, fingerprint: null }
  if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
  const claims = await customerSession(request, env)
  if (!claims) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
  const customerId = await activeOrderCustomerId(env.DB, claims, serverNow())
  if (!customerId) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
  const company = await env.DB.prepare("SELECT 1 FROM companies WHERE customer_id=?1 AND status='approved'")
    .bind(customerId)
    .first()
  const fingerprint = company ? await readD1B2BPricingAuthority(env.DB, customerId, serverNow()) : null
  return { claims, customerId, pricingCustomerId: company ? customerId : undefined, fingerprint }
}

async function catalogSessionCurrent(
  env: CloudflareEnv,
  authority: Exclude<Awaited<ReturnType<typeof catalogSession>>, Response>
) {
  if (!authority.claims) return true
  const customerId = await activeOrderCustomerId(env.DB, authority.claims, serverNow())
  if (customerId !== authority.customerId) return false
  const company = await env.DB.prepare("SELECT 1 FROM companies WHERE customer_id=?1 AND status='approved'")
    .bind(customerId)
    .first()
  if (Boolean(company) !== Boolean(authority.pricingCustomerId)) return false
  return !company || (await readD1B2BPricingAuthority(env.DB, customerId!, serverNow())) === authority.fingerprint
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

const canaryWorker = {
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
    if (!b2bPublicUnavailable(env)) {
      await stage('b2b.sandbox-reset', async () => {
        await resetB2bSandbox(env.DB, now)
      })
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
      // CUS-019: queue consented, capped replenishment reminders (no message is sent here).
      await stage('replenishment.reminders', async () => {
        const result = await scheduleReplenishmentReminders(env.DB, { now, limit: 100 })
        console.log(JSON.stringify({ event: 'replenishment.reminders.schedule', ...result }))
      })
    }
    await stage('payments.recovery', async () => {
      const result = await recoverAuthorisedPayments(env.DB, { now, limit: 25 }, paymentInventoryGateway(env))
      console.log(JSON.stringify({ event: 'payments.recovery', ...result }))
    })
    {
      const preauth = configuredPreauth(env as CloudflareEnv & PreauthRuntime, paymentConfiguration(env), () => now)
      if (preauth)
        await stage('payments.preauth', async () => {
          const result = await sweepPreauthorizations(preauth)
          console.log(JSON.stringify({ event: 'payments.preauth', ...result }))
          if (result.failed > 0) throw new Error('payment_preauth_sweep_failed')
        })
    }
    if ((env as CloudflareEnv & TokenRemovalRuntime).PAYMENT_TOKEN_REMOVAL_ENABLED === 'true') {
      await stage('payments.token-removal', async () => {
        const result = await runConfiguredTokenRemovalRecovery(env as CloudflareEnv & TokenRemovalRuntime, now)
        console.log(JSON.stringify({ event: 'payments.token-removal', ...result }))
        if (result.enabled && result.failed > 0) throw new Error('payment_token_removal_recovery_failed')
      })
    }
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
    await stage('beply.orders', async () => {
      const result = await dispatchConfiguredBeplyOrders(
        {
          database: env.DB,
          queue: {
            send: async (message) => {
              await env.ASYNC_JOBS.send(message)
            }
          },
          fetcher: fetch
        },
        env as CloudflareEnv & BeplyOrdersVariables,
        { now, limit: 10 }
      )
      console.log(JSON.stringify({ event: 'beply.orders.dispatch', ...result }))
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
    // SEC-036: retention of pseudonymised promo-fraud signals (90 days); cases and audit events are kept.
    if (env.AUTH_ENABLED === 'true') {
      await stage('security.promo-fraud-retention', async () => {
        const result = await purgePromoFraudSignals(env.DB, { now })
        console.log(JSON.stringify({ event: 'security.promo-fraud-retention', ...result }))
      })
    }
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
    const deploymentHealth = await handleDeploymentHealth(request, env)
    if (deploymentHealth) return deploymentHealth
    const demoLogin = await handleDemoLoginRequest(request, env)
    if (demoLogin) return demoLogin
    const earlyPath = new URL(request.url).pathname
    if (ownsBeplyOrdersNamespace(earlyPath)) {
      const blocked = await mountGuard(request, env, isAdministrativePath(earlyPath), 'admin-orders')
      if (blocked) return blocked
      return (
        (await handleBeplyOrdersRequest(request, {
          database: env.DB,
          sessionCookieConfiguration: mountSession(env),
          origin: env.AUTH_ORIGIN,
          now: serverNow
        })) ?? noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    // Dynamic Open Graph cards (/og/<kind>/<slug>.png): public, anonymous, cached and with a static fallback.
    if (parseOgImagePath(earlyPath)) {
      const card = await handleOgImageHttp(
        request,
        ogImageRuntime(new URL(request.url).origin, (internal) => canaryWorker.fetch(internal, env))
      )
      if (card) return card
    }
    // The generic analytics namespace claims /api/admin/analytics/* and /api/analytics/*; these two
    // modules live under it and are mounted further below, so they must not be shadowed.
    const analytics =
      ownsCostToServeNamespace(earlyPath) || ownsPredictivePersonalizationNamespace(earlyPath)
        ? null
        : await handleConfiguredAnalyticsHttp(request, env)
    if (analytics) return analytics
    // SEO-029/030/031: mounted early so no broader /api/admin or /api/content* router can shadow it.
    if (ownsContentGovernanceAdminNamespace(earlyPath)) {
      const blocked = await mountGuard(request, env, true, 'admin-cms', { requireAuth: true })
      if (blocked) return blocked
      return (
        (await handleContentGovernanceAdminHttp(request, env)) ?? noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsContentGovernancePublicNamespace(earlyPath)) {
      return (
        (await handleContentGovernancePublicHttp(request, { database: env.DB, origin: env.AUTH_ORIGIN })) ??
        noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsSupportCopilotNamespace(earlyPath) || ownsSupportRcaNamespace(earlyPath)) {
      const blocked = await mountGuard(request, env, true, 'admin-support')
      if (blocked) return blocked
      const supportAi = {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      }
      return (
        (await handleSupportCopilotHttp(request, supportAi)) ??
        (await handleSupportRcaHttp(request, supportAi)) ??
        noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsSupportInsightsAdminNamespace(earlyPath)) {
      // SUP-012/014/015/017 administrative surface; mountGuard already applied CSRF + the admin edge limit.
      const blocked = await mountGuard(request, env, true, 'admin-support')
      if (blocked) return blocked
      return (
        (await handleSupportInsightsAdminHttp(request, {
          database: env.DB,
          origin: env.AUTH_ORIGIN,
          sessionCookieConfiguration: mountSession(env),
          edgeGate: async () => 'allowed'
        })) ?? noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
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
        cmsPublication: cmsDependencies,
        // Optional plain variable; absent means no gated content section is advertised.
        publishedSections: (env as unknown as { PUBLISHED_SECTIONS?: string }).PUBLISHED_SECTIONS
      })
      if (seo) return seo
    }
    const search = await handlePublicSearchHttp(request, { database: env.DB })
    if (search) return search
    const semanticSearch = await handleSemanticSearchHttp(request, env)
    if (semanticSearch) return semanticSearch
    const rerankEvents = await handlePersonalizedRerankHttp(request, env)
    if (rerankEvents) return rerankEvents
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
    if (ownsSecurityAnomaliesNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return supportJson({ error: { code: 'service_unavailable' } }, 503)
      return (
        (await handleSecurityAnomaliesHttp(request, {
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
    if (ownsAccountLifecycleNamespace(path)) {
      // CUS-015/016/019/028: preference centre, company documents, replenishment plans, support impersonation.
      if (env.AUTH_ENABLED !== 'true') {
        const denied = noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        denied.headers.set('Cache-Control', 'private, no-store')
        denied.headers.set('Vary', 'Cookie')
        return denied
      }
      const lifecycle = await handleAccountLifecycleHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        customerEdgeLimiter: env.AUTH_EDGE_LIMIT,
        adminEdgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (lifecycle) return lifecycle
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
    if (ownsCompanyShippingConditionsNamespace(path)) {
      const blocked = await mountGuard(request, env, isAdministrativePath(path), 'shipping-ops')
      if (blocked) return blocked
      const conditions = await handleCompanyShippingConditionsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env)
      })
      return conditions ?? noStoreJson({ error: { code: 'not_found' } }, 404)
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
    if (ownsProductRecommendationsNamespace(path)) {
      const authority = await catalogSession(request, env)
      if (authority instanceof Response) return authority
      const recommendations = await handleProductRecommendationsHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        pricing: authority.pricingCustomerId ? { customerId: authority.pricingCustomerId } : undefined
      })
      if (!(await catalogSessionCurrent(env, authority))) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
      return recommendations ?? noStoreJson({ error: { code: 'not_found' } }, 404)
    }
    if (ownsProductDetailExtrasNamespace(path)) {
      const extras = await handleProductDetailExtrasHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      return extras ?? noStoreJson({ error: { code: 'not_found' } }, 404)
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
      ownsSearchSynonymsNamespace(path) ||
      ownsSearchGapNamespace(path) ||
      ownsSearchMerchandisingNamespace(path) ||
      ownsCategoryMerchandisingNamespace(path) ||
      ownsSemanticSearchNamespace(path) ||
      ownsPersonalizedRerankNamespace(path)
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
      const searchGaps = await handleSearchGapHttp(request, env)
      if (searchGaps) return searchGaps
      const synonyms = await handleSearchSynonymsHttp(request, env)
      if (synonyms) return synonyms
      const merchandising = await handleSearchMerchandisingHttp(request, env)
      if (merchandising) return merchandising
      const categoryMerchandising = await handleCategoryMerchandisingHttp(request, env)
      if (categoryMerchandising) return categoryMerchandising
      const semanticSearch = await handleSemanticSearchHttp(request, env)
      if (semanticSearch) return semanticSearch
      const personalizedRerank = await handlePersonalizedRerankHttp(request, env)
      if (personalizedRerank) return personalizedRerank
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
    if (ownsMarketingModalsNamespace(path)) {
      const modalFailure = (code: string, status: number) =>
        Response.json(
          { error: { code } },
          { status, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } }
        )
      if (isAdminMarketingModalsPath(path)) {
        if (env.AUTH_ENABLED !== 'true') return modalFailure('service_unavailable', 503)
        const limited = await checkAdministrativeEdgeLimit(
          request,
          env.ADMIN_EDGE_LIMIT,
          env.AUTH_RATE_LIMIT_PEPPER,
          'admin-pricing'
        )
        if (limited !== 'allowed')
          return modalFailure(
            limited === 'limited' ? 'rate_limited' : 'service_unavailable',
            limited === 'limited' ? 429 : 503
          )
      }
      const marketingModals = await handleMarketingModalsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (marketingModals) return marketingModals
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
    if (ownsInventoryOpsNamespace(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const inventoryOps = await handleInventoryOpsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (inventoryOps) return inventoryOps
    }
    if (ownsInventoryLotsCostingForecastNamespace(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const lots = await handleInventoryLotsCostingForecastHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (lots) return lots
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
    if (ownsCarrierScorecardNamespace(path)) {
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
      const scorecard = await handleCarrierScorecardHttp(request, env)
      if (scorecard) return scorecard
    }
    if (ownsDeliverySurveyNamespace(path)) {
      const administrative = path.startsWith('/api/admin/')
      if (administrative && env.AUTH_ENABLED !== 'true')
        return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-fulfillment' : 'storefront-fulfillment'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const deliverySurvey = await handleDeliverySurveyHttp(request, env)
      if (deliverySurvey) return deliverySurvey
    }
    if (
      ownsDeliveryDriverAppNamespace(path) ||
      ownsCarrierManifestsNamespace(path) ||
      ownsPackingOptimizerNamespace(path)
    ) {
      const blocked = await mountGuard(request, env, true, 'shipping-ops')
      if (blocked) return blocked
      const shippingOps = { database: env.DB, sessionCookieConfiguration: mountSession(env) }
      return (
        (await handleDeliveryDriverAppHttp(request, shippingOps)) ??
        (await handleCarrierManifestsHttp(request, shippingOps)) ??
        (await handlePackingOptimizerHttp(request, shippingOps)) ??
        noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (ownsSupportLiveChatNamespace(path)) {
      const administrative = path.startsWith('/api/admin/')
      if (administrative && env.AUTH_ENABLED !== 'true')
        return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-support' : 'support-live-chat'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const liveChat = await handleSupportLiveChatHttp(request, {
        database: env.DB,
        sessionCookieConfiguration:
          env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null,
        origin: env.AUTH_ORIGIN
      })
      if (liveChat) return liveChat
    }
    if (ownsCustomerAccountManagerNamespace(path)) {
      const administrative = path.startsWith('/api/admin/')
      if (administrative && env.AUTH_ENABLED !== 'true')
        return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        administrative ? 'admin-crm' : 'customer-crm'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const crm = await handleCustomerAccountManagerHttp(request, {
        database: env.DB,
        sessionCookieConfiguration:
          env.AUTH_ENABLED === 'true' ? { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 } : null,
        origin: env.AUTH_ORIGIN
      })
      if (crm) return crm
    }
    if (ownsPreauthNamespace(path) || isPreauthNotificationPath(path)) {
      // PAY-021: off by default; owned here so no legacy handler can shadow the admin or bank routes.
      const preauth = await handlePreauthHttp(request, {
        preauth: configuredPreauth(env as CloudflareEnv & PreauthRuntime, paymentConfiguration(env), serverNow),
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSessionOrNull(env),
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      return preauth ?? privateJson({ error: { code: 'not_found' } }, 404)
    }
    if (ownsPaymentFunnelNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const limited = await checkAdministrativeEdgeLimit(
        request,
        env.ADMIN_EDGE_LIMIT,
        env.AUTH_RATE_LIMIT_PEPPER,
        'admin-payment-funnel'
      )
      if (limited !== 'allowed')
        return noStoreJson(
          { error: { code: limited === 'limited' ? 'rate_limited' : 'service_unavailable' } },
          limited === 'limited' ? 429 : 503
        )
      const paymentFunnel = await handlePaymentFunnelHttp(request, env)
      if (paymentFunnel) return paymentFunnel
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
    if (ownsAdminAiAssistantNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const csrf = crossOriginMutation(request, env)
      if (csrf) return csrf
      const res = await handleAdminAiAssistantHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (res) return res
    }
    if (ownsCatalogAiGenerationNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const csrf = crossOriginMutation(request, env)
      if (csrf) return csrf
      const res = await handleCatalogAiGenerationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (res) return res
    }
    if (ownsMediaAiEnrichmentNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const csrf = crossOriginMutation(request, env)
      if (csrf) return csrf
      const res = await handleMediaAiEnrichmentHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (res) return res
    }
    if (ownsAiopsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const res = await handleAiopsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      })
      if (res) return res
    }
    if (ownsPerformanceInsightsNamespace(path)) {
      if (env.AUTH_ENABLED !== 'true') return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
      const res = await handlePerformanceInsightsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
        origin: env.AUTH_ORIGIN
      })
      if (res) return res
    }
    if (ownsDeliveryRoutesNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'shipping-ops')
      if (blocked) return blocked
      const routes = await handleDeliveryRoutesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env)
      })
      if (routes) return routes
    }
    if (ownsConveniencePointsNamespace(path)) {
      const blocked = await mountGuard(request, env, false, 'storefront-shipping', { requireAuth: false })
      if (blocked) return blocked
      const points = await handleConveniencePointsHttp(request, { database: env.DB })
      if (points) return points
    }
    if (ownsAudiencesNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-audiences')
      if (blocked) return blocked
      const audiences = await handleAudiencesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (audiences) return audiences
    }
    if (ownsOperationalAlertsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-operations')
      if (blocked) return blocked
      const alerts = await handleOperationalAlertsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (alerts) return alerts
    }
    if (ownsSendTimeOptimizationNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-marketing')
      if (blocked) return blocked
      const sendTime = await handleSendTimeOptimizationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (sendTime) return sendTime
    }
    if (ownsBundlesNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-bundles' : 'storefront-bundles',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      return handleBundlesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env),
        origin: env.AUTH_ORIGIN
      })
    }
    if (ownsEventsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-events' : 'storefront-events',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      return handleEventsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env),
        origin: env.AUTH_ORIGIN
      })
    }
    if (ownsPromoFraudNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-promo-fraud' : 'customer-promo-fraud'
      )
      if (blocked) return blocked
      const promoFraud = await handlePromoFraudHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        session: (incoming) => customerSession(incoming, env)
      })
      if (promoFraud) return promoFraud
    }
    if (ownsQuickOrderCompanyNamespace(path)) {
      const blocked = await mountGuard(request, env, false, 'quick-order-company')
      if (blocked) return blocked
      const quickOrder = await handleQuickOrderCompanyHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        session: (incoming) => customerSession(incoming, env)
      })
      if (quickOrder) return quickOrder
    }
    if (ownsReferralsNamespace(path)) {
      const blocked = await mountGuard(request, env, isAdministrativePath(path), 'customer-referrals')
      if (blocked) return blocked
      return handleReferralsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        fraudPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
    }
    if (ownsMarketingAutomationsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-marketing-automations' : 'customer-marketing-preferences'
      )
      if (blocked) return blocked
      const automations = await handleMarketingAutomationsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (automations) return automations
    }
    if (ownsBrowseAbandonmentNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-browse-recovery' : 'customer-browse-preferences'
      )
      if (blocked) return blocked
      const browse = await handleBrowseAbandonmentHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (browse) return browse
    }
    if (ownsPromotionsAutomationMatrixNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-pricing')
      if (blocked) return blocked
      const promoMatrix = await handlePromotionsAutomationMatrixHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (promoMatrix) return promoMatrix
    }
    if (ownsAccountIsolationNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-orders')
      if (blocked) return blocked
      const accountIso = await handleAccountIsolationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (accountIso) return accountIso
    }
    if (ownsWarehouseRouteOfflineNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-fulfillment')
      if (blocked) return blocked
      const warehouseOffline = await handleWarehouseRouteOfflineHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (warehouseOffline) return warehouseOffline
    }
    if (ownsWelcomeCouponNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-welcome-coupon' : 'customer-welcome-coupon'
      )
      if (blocked) return blocked
      const coupon = await handleWelcomeCouponHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (coupon) return coupon
    }
    if (ownsRecommendationEngineNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-recommendations' : 'public-recommendations'
      )
      if (blocked) return blocked
      const recommendations = await handleRecommendationEngineHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (recommendations) return recommendations
    }
    if (ownsCrmAutomationMetricsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-crm-metrics')
      if (blocked) return blocked
      const crmMetrics = await handleCrmAutomationMetricsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (crmMetrics) return crmMetrics
    }
    if (ownsMarketingObservabilityNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-marketing-observability')
      if (blocked) return blocked
      const mktObs = await handleMarketingObservabilityHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (mktObs) return mktObs
    }
    if (ownsExperimentsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-experiments' : 'client-experiments'
      )
      if (blocked) return blocked
      const experiments = await handleExperimentsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (experiments) return experiments
    }
    if (ownsPricingNamespace(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const pricing = await handlePricingHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: isAdministrativePath(path) ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        storeCreditRedemptionEnabled:
          (env as CloudflareEnv & { STORE_CREDIT_REDEMPTION_ENABLED?: string }).STORE_CREDIT_REDEMPTION_ENABLED ===
          'true'
      })
      if (pricing) return pricing
    }
    if (ownsGrowthNamespace(path)) {
      const administrative = isAdministrativePath(path)
      // Lead magnets are public and keep working with auth disabled; everything else fails closed.
      if (administrative || !/^\/api\/lead-magnets(?:\/|$)/.test(path)) {
        const unavailable = authUnavailable(env)
        if (unavailable) return unavailable
      }
      const growth = await handleGrowthHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (growth) return growth
    }
    if (ownsCustomerRecurringListsNamespace(path)) {
      const blocked = await mountGuard(request, env, false, 'customer-recurring-lists')
      if (blocked) return blocked
      const lists = await handleCustomerRecurringListsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env)
      })
      if (lists) return lists
    }
    if (ownsMarketCatalogNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-catalog' : 'storefront-shipping',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      const markets = await handleMarketCatalogHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (markets) {
        if (!administrative) return markets
        // The module omits Cache-Control on its administrative errors; enforce it at the mount.
        const privateResponse = new Response(markets.body, markets)
        privateResponse.headers.set('cache-control', 'private, no-store')
        return privateResponse
      }
    }
    if (ownsInternationalFeedsAdrNamespace(path)) {
      // SEO-033 hreflang, SEO-034 channel feeds, SHP-029 ADR / limited quantities.
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-catalog' : 'storefront-shipping',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const international = await handleInternationalFeedsAdrHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (international) return international
    }
    if (ownsProductReviewsQaNamespace(path) || ownsProductMediaGuidesNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-catalog' : 'product-contributions',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      const context = {
        database: env.DB,
        sessionClaimsResolver: async (incoming: Request) => {
          const claims = await customerSession(incoming, env)
          if (!claims) return null
          const customerId = await activeOrderCustomerId(env.DB, claims, serverNow())
          return { ...claims, customerId }
        }
      }
      const feedback =
        (await handleProductReviewsQaHttp(request, context)) ?? (await handleProductMediaGuidesHttp(request, context))
      if (feedback) return feedback
    }
    if (ownsUgcReviewsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-media' : 'product-contributions',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const ugc = await handleUgcReviewsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env)
      })
      if (ugc) return ugc
    }
    if (ownsCustomerCaseStudiesNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-cms' : 'product-contributions',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const caseStudy = await handleCustomerCaseStudiesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env)
      })
      if (caseStudy) return caseStudy
    }
    if (ownsLearningCentreNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-learning' : 'customer-learning',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const learning = await handleLearningCentreHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (learning) return learning
    }
    if (ownsTargetedCampaignsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-marketing' : 'customer-marketing',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const mkt = await handleTargetedCampaignsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (mkt) return mkt
    }
    if (ownsRecurringIncentivesNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(request, env, administrative, administrative ? 'admin-b2b' : 'customer-b2b', {
        requireAuth: administrative
      })
      if (blocked) return blocked
      const incentives = await handleRecurringIncentivesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (incentives) return incentives
    }
    if (ownsPredictivePersonalizationNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-marketing' : 'customer-marketing',
        { requireAuth: administrative }
      )
      if (blocked) return blocked
      const pred = await handlePredictivePersonalizationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (pred) return pred
    }
    if (ownsModelEvaluationNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(request, env, administrative, 'admin-analytics', { requireAuth: true })
      if (blocked) return blocked
      const evalResp = await handleModelEvaluationHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (evalResp) return evalResp
    }
    if (ownsCmsPreviewComparisonNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-cms', { requireAuth: true })
      if (blocked) return blocked
      const previewComp = await handleCmsPreviewComparisonHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (previewComp) return previewComp
    }
    if (ownsRoleDashboardNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-dashboard', { requireAuth: true })
      if (blocked) return blocked
      const roleDash = await handleRoleDashboardHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (roleDash) return roleDash
    }
    if (ownsCommercialCampaignsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-marketing', { requireAuth: true })
      if (blocked) return blocked
      const commCamp = await handleCommercialCampaignsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (commCamp) return commCamp
    }
    if (ownsSeasonalCampaignsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-marketing', { requireAuth: true })
      if (blocked) return blocked
      const seasonalCamp = await handleSeasonalCampaignsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env)
      })
      if (seasonalCamp) return seasonalCamp
    }
    if (ownsSupplierFeedNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-catalog', { requireAuth: true })
      if (blocked) return blocked
      const feedResp = await handleSupplierFeedHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (feedResp) return feedResp
    }
    if (ownsEditorialContentNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-catalog', { requireAuth: true })
      if (blocked) return blocked
      const editResp = await handleEditorialContentHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (editResp) return editResp
    }
    if (ownsSupplierSourcingNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-catalog', { requireAuth: true })
      if (blocked) return blocked
      const sourcResp = await handleSupplierSourcingHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (sourcResp) return sourcResp
    }
    if (ownsDraftOrdersNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-orders', { requireAuth: true })
      if (blocked) return blocked
      const draftResp = await handleDraftOrdersHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (draftResp) return draftResp
    }
    if (/^\/api\/admin\/checkout-markets\/[A-Z]{2}$/.test(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const markets = await handleCheckoutMarketHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (markets) return markets
    }
    if (path.startsWith('/api/admin/product-recalls/')) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const recall = await handleProductRecallHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (recall) return recall
    }
    if (/^\/api\/account\/high-value-consent\/(?:sms|whatsapp)$/.test(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const optOut = await handleHighValueOptOutHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (optOut) return optOut
    }
    if (ownsAccountNotificationsNamespace(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const notifResponse = await handleAccountNotificationsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.AUTH_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (notifResponse) return notifResponse
    }
    if (ownsMultichannelNamespace(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const multiResponse = await handleMultichannelHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (multiResponse) return multiResponse
    }
    if (/^\/api\/admin\/customers\/[^/]+\/whatsapp-business\/(?:state|messages|status)$/.test(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const whatsapp = await handleWhatsAppBusinessHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        pricing: { whatsappCostMinor: 7, dailyBudgetMinor: 5000 },
        transport: env.APP_ENV === 'local' ? 'official-fake' : 'disabled'
      })
      if (whatsapp) return whatsapp
    }
    if (/^\/api\/admin\/customers\/[^/]+\/high-value-messages$/.test(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const messages = await handleHighValueMessagesHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
        // Synthetic test prices are used only by the local fake, never a real transport.
        pricing: { smsCostMinor: 5, dailyBudgetMinor: 5000 },
        transport: env.APP_ENV === 'local' ? 'local-fake' : 'disabled'
      })
      if (messages) return messages
    }
    if (/^\/api\/admin\/customers\/[^/]+\/high-value-consent\//.test(path)) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const consent = await handleHighValueConsentHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (consent) return consent
    }
    if (path === '/api/admin/b2b' || path === '/api/account/b2b' || path.startsWith('/api/admin/b2b/')) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const b2b = await handleB2BHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        environment: env.APP_ENV,
        session: (incoming) => customerSession(incoming, env),
        edgeLimiter: path.startsWith('/api/admin/') ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (b2b) return b2b
    }
    if (ownsCustomerRiskScoringNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-scoring')
      if (blocked) return blocked
      const scoring = await handleCustomerRiskScoringHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env)
      })
      if (scoring) return scoring
    }
    if (ownsB2bEdiNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(request, env, administrative, administrative ? 'admin-edi' : 'b2b-edi', {
        requireAuth: administrative
      })
      if (blocked) return blocked
      const edi = await handleB2bEdiHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env)
      })
      if (edi) return edi
    }
    if (ownsSecurityControlsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-security-controls' : 'security-public',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      const secrets = env as unknown as Record<string, string | undefined>
      const security = await handleSecurityControlsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSessionOrNull(env),
        secrets: {
          apiKeyPepper: secrets.NETECO_API_KEY_PEPPER,
          offlineMasterKey: secrets.NETECO_DEVICE_OFFLINE_MASTER_KEY,
          abuseSubjectPepper: secrets.NETECO_ABUSE_SUBJECT_PEPPER
        }
      })
      if (security) return security
    }
    if (ownsDeveloperOwnershipNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-developer-platform')
      if (blocked) return blocked
      const ownership = await handleDeveloperOwnership(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (ownership) return ownership
    }
    if (ownsB2bPublicAdminNamespace(path)) {
      const unavailable = b2bPublicUnavailable(env)
      if (unavailable) return unavailable
      const blocked = await mountEdgeLimit(request, env, true, 'admin-b2b-public')
      if (blocked) return blocked
      const publicAdmin = await handleB2bPublicAdmin(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (publicAdmin) return publicAdmin
    }
    if (ownsConnectorsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-connectors')
      if (blocked) return blocked
      const connectors = await handleConnectorsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        secretPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (connectors) return connectors
    }
    if (ownsIntegrationsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-integrations')
      if (blocked) return blocked
      const integrations = await handleIntegrationsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN
      })
      if (integrations) return integrations
    }
    if (ownsB2bPublicApiNamespace(path)) {
      // Keyed API: quota and authentication are enforced per key by the handler.
      const unavailable = b2bPublicUnavailable(env)
      if (unavailable) return unavailable
      const blocked = await mountEdgeLimit(request, env, false, 'b2b-public')
      if (blocked) return blocked
      const publicApi = await handleB2bPublicApi(request, { database: env.DB })
      if (publicApi) return publicApi
    }
    if (
      ownsErrorBudgetNamespace(path) ||
      ownsCapacityPlanningNamespace(path) ||
      ownsB2BContractSloNamespace(path) ||
      ownsWarehouseRouteTelemetryNamespace(path) ||
      ownsAnomalyDetectionNamespace(path) ||
      ownsGameDayNamespace(path)
    ) {
      const blocked = await mountGuard(request, env, true, 'admin-observability')
      if (blocked) return blocked
      const observability = {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        edgeLimiter: env.ADMIN_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      }
      return (
        (await handleErrorBudgetHttp(request, observability)) ??
        (await handleCapacityPlanningHttp(request, observability)) ??
        (await handleB2BContractSloHttp(request, observability)) ??
        (await handleWarehouseRouteTelemetryHttp(request, observability)) ??
        (await handleAnomalyDetectionHttp(request, observability)) ??
        (await handleGameDayHttp(request, observability)) ??
        noStoreJson({ error: { code: 'not_found' } }, 404)
      )
    }
    if (
      ownsAlphaBetaPromotionNamespace(path) ||
      ownsProgressiveRolloutNamespace(path) ||
      ownsCloudflarePolicyNamespace(path) ||
      ownsCampaignPipelineNamespace(path)
    ) {
      // Only the runtime rollout evaluation and the campaign preview are session-less; everything else is admin.
      const releasePublic =
        path === '/api/release/progressive-rollouts/eval' ||
        path === '/api/campaign-pipeline/preview' ||
        path === '/api/content/campaign-pipeline/preview'
      const releaseBlocked = await mountGuard(
        request,
        env,
        !releasePublic,
        releasePublic ? 'storefront-release' : 'admin-release',
        { requireAuth: !releasePublic }
      )
      if (releaseBlocked) return releaseBlocked
      const releaseDeps = {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        now: serverNow
      }
      const response =
        (await handleProgressiveRolloutHttp(request, releaseDeps)) ??
        (await handleCampaignPipelineHttp(request, releaseDeps)) ??
        (await handleAlphaBetaPromotionHttp(request, releaseDeps)) ??
        (await handleCloudflarePolicyHttp(request, releaseDeps))
      if (response) return response
    }
    if (path === '/api/account/paygold-links' || path.startsWith('/api/account/paygold-links/')) {
      const privateFailure = (code: string, status: number) => {
        const response = noStoreJson({ error: { code } }, status)
        response.headers.set('Cache-Control', 'private, no-store')
        response.headers.set('Vary', 'Cookie')
        return response
      }
      const issue = configuredPayGoldIssue(env as CloudflareEnv & PayGoldRuntime, paymentConfiguration(env), serverNow)
      if (env.AUTH_ENABLED !== 'true' || !issue) return privateFailure('service_unavailable', 503)
      const draftIssue = configuredPayGoldDraftIssue(
        env as CloudflareEnv & PayGoldRuntime,
        paymentConfiguration(env),
        serverNow
      )
      const draft = draftIssue
        ? await handlePayGoldDraftHttp(request, {
            database: env.DB,
            sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
            origin: env.AUTH_ORIGIN,
            now: serverNow,
            issue: draftIssue
          })
        : null
      if (draft) return draft
      return (
        (await handlePayGoldLinksHttp(request, {
          database: env.DB,
          sessionCookieConfiguration: { password: env.NUXT_SESSION_PASSWORD, maxAgeSeconds: 3600 },
          origin: env.AUTH_ORIGIN,
          now: serverNow,
          issue,
          recover: issue.recover
        })) ?? privateFailure('not_found', 404)
      )
    }
    if (ownsSavedCardsNamespace(path)) {
      // PAY-022: closed unless bank support, PCI review and self-service removal are all configured.
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const saved = await handleTokenizationHttp(request, {
        tokenization: configuredTokenization(
          env as CloudflareEnv & TokenizationRuntime,
          paymentConfiguration(env),
          paymentInventoryGateway(env),
          serverNow
        ),
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      return saved ?? privateJson({ error: { code: 'not_found' } }, 404)
    }
    if (path === '/api/account/payment-tokens' || path.startsWith('/api/account/payment-tokens/')) {
      const unavailable = authUnavailable(env)
      if (unavailable) return unavailable
      const tokens = await handlePaymentTokenRemovalHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      // Child paths are owned here too: never fall through to a legacy handler.
      return tokens ?? privateJson({ error: { code: 'not_found' } }, 404)
    }
    if (ownsSeoNamespace(path)) {
      const administrative = isAdministrativePath(path)
      const blocked = await mountGuard(
        request,
        env,
        administrative,
        administrative ? 'admin-seo' : 'storefront-search',
        {
          requireAuth: administrative
        }
      )
      if (blocked) return blocked
      const seoApi = await handleSeoHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env),
        edgeLimiter: administrative ? env.ADMIN_EDGE_LIMIT : env.CART_EDGE_LIMIT,
        rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
      })
      if (seoApi) return seoApi
    }
    if (ownsSeoContentDashboardNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-seo', { requireAuth: true })
      if (blocked) return blocked
      const seoDashboard = await handleSeoContentDashboardHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (seoDashboard) return seoDashboard
    }
    if (ownsB2bSalesMetricsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-b2b', { requireAuth: true })
      if (blocked) return blocked
      const b2bMetrics = await handleB2bSalesMetricsHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (b2bMetrics) return b2bMetrics
    }
    if (ownsCostToServeNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-analytics', { requireAuth: true })
      if (blocked) return blocked
      const costToServe = await handleCostToServeHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (costToServe) return costToServe
    }
    if (ownsEditorialBriefingNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-cms', { requireAuth: true })
      if (blocked) return blocked
      const briefingRes = await handleEditorialBriefingHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (briefingRes) return briefingRes
    }
    if (ownsCommercialQuotesAccountsNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-commercial', { requireAuth: true })
      if (blocked) return blocked
      const commercialRes = await handleCommercialQuotesAccountsHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (commercialRes) return commercialRes
    }
    if (ownsInventoryPlanningNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-inventory-planning', { requireAuth: true })
      if (blocked) return blocked
      const planningRes = await handleInventoryPlanningHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (planningRes) return planningRes
    }
    if (ownsWarehouseScanNamespace(path)) {
      const blocked = await mountGuard(request, env, true, 'admin-warehouse', { requireAuth: true })
      if (blocked) return blocked
      const warehouseRes = await handleWarehouseScanHttp(request, {
        database: env.DB,
        origin: env.AUTH_ORIGIN,
        sessionCookieConfiguration: mountSession(env)
      })
      if (warehouseRes) return warehouseRes
    }
    if (ownsDownloadableTemplatesNamespace(path)) {
      const administrative = isAdministrativePath(path)
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-cms', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handleDownloadableTemplatesHttp(request, {
        database: env.DB,
        claims: claims ?? undefined,
        now: serverNow()
      })
      if (res) return res
    }
    if (ownsBrandCenterNamespace(path)) {
      const administrative = isAdministrativePath(path)
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-media', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handleBrandCenterHttp(request, {
        database: env.DB,
        claims: claims ?? undefined,
        now: serverNow()
      })
      if (res) return res
    }
    if (ownsWarehouseAdrAssetsNamespace(path)) {
      const administrative = isAdministrativePath(path) || path.includes('/transport-document')
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-warehouse', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handleWarehouseAdrAssetsHttp(request, {
        database: env.DB,
        claims: claims ?? undefined,
        now: serverNow()
      })
      if (res) return res
    }
    if (ownsProcurementApprovalsNamespace(path)) {
      const administrative = isAdministrativePath(path)
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-orders', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handleProcurementApprovalsHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        claims: claims ?? undefined,
        now: serverNow()
      })
      if (res) return res
    }
    if (ownsSplitBackordersNamespace(path)) {
      const administrative = isAdministrativePath(path)
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-orders', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handleSplitBackordersHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        origin: env.AUTH_ORIGIN,
        claims: claims ?? undefined,
        now: serverNow()
      })
      if (res) return res
    }
    if (ownsPaymentContingencyNamespace(path)) {
      const administrative = isAdministrativePath(path)
      if (administrative) {
        const blocked = await mountGuard(request, env, true, 'admin-orders', { requireAuth: true })
        if (blocked) return blocked
      }
      const claims = hasSessionCookie(request) ? await customerSession(request, env) : undefined
      const res = await handlePaymentContingencyHttp(request, {
        database: env.DB,
        sessionCookieConfiguration: mountSession(env),
        claims: claims ?? undefined,
        // Fail closed: only a provider built from Worker secrets may verify webhook signatures.
        alternativeProvider: alternativeProviderFromEnv(env as unknown as Record<string, unknown>) ?? undefined,
        now: serverNow()
      })
      if (res) return res
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
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER,
      session: (incoming) => customerSession(incoming, env),
      authenticationEnabled: env.AUTH_ENABLED === 'true'
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
    const publicCheckoutMarketResponse = await handlePublicCheckoutMarketHttp(request, {
      database: env.DB,
      edgeLimiter: env.CART_EDGE_LIMIT,
      rateLimitPepper: env.AUTH_RATE_LIMIT_PEPPER
    })
    if (publicCheckoutMarketResponse) return publicCheckoutMarketResponse
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
    const walletEnv = env as CloudflareEnv & {
      WALLET_PAYMENTS_ENABLED?: unknown
      WALLET_EVIDENCE_JSON?: unknown
      APPLE_PAY_DOMAIN_ASSOCIATION?: unknown
    }
    const walletResponse = await handleWalletHttp(request, {
      database: env.DB,
      now: serverNow,
      configuration: () => paymentConfiguration(env),
      evidence: () => walletEvidenceFromEnv(walletEnv),
      appleDomainAssociation: () => walletAppleAssociationFromEnv(walletEnv)
    })
    if (walletResponse) return walletResponse
    const tokenization = configuredTokenization(
      env as CloudflareEnv & TokenizationRuntime,
      paymentConfiguration(env),
      paymentInventoryGateway(env),
      serverNow
    )
    const paymentResponse = await handlePaymentHttp(request, {
      database: env.DB,
      now: serverNow,
      inventory: paymentInventoryGateway(env),
      configuration: () => paymentConfiguration(env),
      // PAY-022: a bank token is kept only for a payment with recorded consent, and only after capture.
      ...(tokenization
        ? { afterCaptured: (envelope) => captureTokenAfterPayment(envelope, tokenization).then(() => undefined) }
        : {})
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
        const authority = await catalogSession(request, env)
        if (authority instanceof Response) return authority
        const page = Math.max(Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1)
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '24', 10) || 24, 1), 100)
        const requestedSort = url.searchParams.get('sort') ?? 'default'
        const sort: ProductSort = ['name', 'price_asc', 'price_desc'].includes(requestedSort)
          ? (requestedSort as ProductSort)
          : 'default'
        const result = await listPublishedProducts(
          env.DB,
          {
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
            inStock: url.searchParams.get('stock') === '1',
            featured: url.searchParams.has('featured'),
            facets: url.searchParams.has('facets'),
            page,
            limit,
            sort
          },
          authority.pricingCustomerId ? { customerId: authority.pricingCustomerId } : undefined
        )
        if (!(await catalogSessionCurrent(env, authority))) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
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
    if (ownsProductCompareNamespace(url.pathname)) {
      const compareResponse = await handleProductCompareHttp(request, { database: env.DB })
      if (compareResponse) return compareResponse
    }
    const productDetailPath = /^\/api\/products\/([a-z0-9][a-z0-9-]{0,179})$/.exec(url.pathname)
    if (request.method === 'GET' && productDetailPath) {
      try {
        const authority = await catalogSession(request, env)
        if (authority instanceof Response) return authority
        const product = await getPublishedProductDetail(
          env.DB,
          productDetailPath[1]!,
          authority.pricingCustomerId ? { customerId: authority.pricingCustomerId } : undefined
        )
        if (!(await catalogSessionCurrent(env, authority))) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
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
        if (hasSessionCookie(request) && env.AUTH_ENABLED !== 'true')
          return noStoreJson({ error: { code: 'service_unavailable' } }, 503)
        const ownerSession = hasSessionCookie(request) ? await customerSession(request, env) : null
        if (hasSessionCookie(request) && !ownerSession) return noStoreJson({ error: { code: 'unauthorized' } }, 401)
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
            ownerSession,
            ...(body.couponCode === undefined ? {} : { couponCode: body.couponCode })
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
            marketCheckout: body.marketCheckout,
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
    const isBeplyOrder = (body: unknown): boolean =>
      body !== null && typeof body === 'object' && 'type' in body && body.type === 'beply.order.sync'
    // Keep Beply transport serial even though unrelated queue families below
    // can run concurrently. D1 work and provider identity survive redelivery.
    for (const message of batch.messages) {
      if (!isBeplyOrder(message.body)) continue
      try {
        const provider = beplyOrdersRuntimeProvider(env as CloudflareEnv & BeplyOrdersVariables, fetch)
        if (provider)
          await consumeBeplyOrdersMessage(env.DB, provider, message.body, { enabled: true, now: serverNow() })
        message.ack()
      } catch {
        message.retry({ delaySeconds: 60 })
      }
    }
    const processedInBatch = new Set<string>()
    let bulkProcessed = 0
    await Promise.all(
      batch.messages.map(async (message) => {
        if (isBeplyOrder(message.body)) return
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

export default canaryWorker
