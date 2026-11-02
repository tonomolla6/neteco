import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { csvCell } from '../server/utils/csv'
import { discardedRequirements, scopedRequirements } from './lib/requirements-scope'
import { traceabilityUpdates } from './lib/requirements-traceability-updates'

const reportPath = resolve('INFORME_MAESTRO_NETECO_PRODUCCION.md')
const outputPath = resolve('docs/production/requirements-traceability.csv')
const validPhases = new Set(['MVP', 'Alpha', 'Beta', 'Fase 1', 'Fase 2', 'Fase 3', 'Fase 4', 'Fase 5', 'Fase 6'])
const expectedPhases: Record<string, number> = {
  MVP: 68,
  Alpha: 402,
  Beta: 57,
  'Fase 1': 49,
  'Fase 2': 24,
  'Fase 3': 42,
  'Fase 4': 31,
  'Fase 5': 22,
  'Fase 6': 7
}
const expectedPriorities: Record<string, number> = { P0: 300, P1: 185, P2: 180, P3: 37 }

type Status = 'REPO_EVIDENCE' | 'PARTIAL_EXTERNAL' | 'MISSING' | 'NOT_VERIFIED' | 'ROADMAP_NOT_STARTED' | 'DISCARDED'

interface Requirement {
  id: string
  phase: string
  priority: string
  requirement: string
  acceptance: string
  domain: string
}

function ids(specification: string) {
  const result: string[] = []
  for (const token of specification
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const range = token.match(/^([A-Z]+)-(\d+)\.\.(\d+)$/)
    if (!range) {
      result.push(token)
      continue
    }
    const [, prefix, from, to] = range
    for (let value = Number(from); value <= Number(to); value += 1) {
      result.push(`${prefix}-${String(value).padStart(from.length, '0')}`)
    }
  }
  return result
}

const mvpRepoEvidence = ids(
  'CAT-002..003;PRI-001..002;SEA-001;CHK-001;PAY-001..002;BEP-003;ORD-001;INV-002;SHP-001..002;CUS-001..002;ADM-001..002;MED-002;SEO-001..002;DAT-001..002;MKT-001;COM-002;SEC-001..002;INT-001;INT-003..004;TST-001..008;CIC-001..005;CIC-008;OBS-001..002;OBS-004'
)
const mvpExternal = ids('CAT-001;BEP-001..002;BEP-004;INV-001;MED-001;PER-001..002;SUP-001;LEG-001..002;OBS-003')
// UI-001 y UI-002 dejan de ser huecos de repositorio: existen la investigación de arquitectura
// de información y el design system funcional (2026-09-01). UI-013 tiene harness
// parcial; Chromium, baselines revisadas y aceptación compilada siguen pendientes.
const mvpMissing: string[] = []

const currentRepoEvidence = new Set(
  ids(
    'CAT-004..006;CAT-008;PRI-002..008;PRI-010..011;SEA-004;PDP-001..002;PDP-003;PDP-006..008;PDP-010..011;CHK-002..010;CHK-014;CHK-017;ADM-001..003;ADM-009..011;ADM-017;MED-007;MED-011;MED-015;SEO-003;SEO-007;SEO-012;SEO-014;PER-004;PER-011;PER-016..017;MKT-002..003;COM-004..008;CUS-013;INV-006;TST-011..013;TST-015..016;TST-020..022;TST-024..027;TST-029..039;UI-001..002;UI-004;UI-007;UI-009..010;UI-012'
  )
)
// Complete/filtered read-only native CSV/XLSX acceptance atoms, locally
// executed through D1/workerd and compiled Chrome on 2026-10-04.
currentRepoEvidence.add('CAT-015')
// Current compiled D1-to-initial-SSR pagination contracts pass locally.
currentRepoEvidence.add('SEA-008')
currentRepoEvidence.add('SEO-011')
const currentPartialExternal = new Set(
  ids(
    'COM-001;SEO-015;PER-003;PER-013;PAY-003..017;BEP-005..018;SHP-003..020;LEG-003..034;OBS-005..023;TST-014;TST-017..019;TST-023;TST-028;TST-040'
  )
)

// Documented partial work is not an unstarted roadmap item or acceptance.
const currentPartialImplementation = new Set([
  'MKT-012',
  'MKT-013',
  'CHK-020',
  'MKT-027',
  'SEO-027',
  'SEA-016',
  'MKT-017',
  'MKT-024',
  'MKT-025',
  'CUS-017',
  'ORD-019',
  'CUS-027',
  'SEC-003',
  'TST-009',
  'CIC-006',
  'CIC-007',
  'UI-005',
  'PDP-004',
  'MED-010',
  'ADM-004',
  'ADM-005',
  'CAT-010',
  'ORD-016',
  'ORD-018',
  'MKT-028',
  'COM-017',
  'SUP-013',
  'SHP-024',
  'INT-002',
  'TST-010',
  'SEA-017',
  'CUS-026',
  'PRI-013',
  'PRI-012',
  'PRI-016',
  'CHK-016',
  'CHK-018',
  'CHK-019',
  'UI-013'
])

function statusFor(requirement: Requirement): Status {
  const update = traceabilityUpdates[requirement.id]
  if (update) return update.status
  if (discardedRequirements.has(requirement.id)) return 'DISCARDED'
  if (mvpRepoEvidence.includes(requirement.id)) return 'REPO_EVIDENCE'
  if (mvpExternal.includes(requirement.id)) return 'PARTIAL_EXTERNAL'
  if (mvpMissing.includes(requirement.id)) return 'MISSING'
  if (currentRepoEvidence.has(requirement.id)) return 'REPO_EVIDENCE'
  if (currentPartialExternal.has(requirement.id)) return 'PARTIAL_EXTERNAL'
  if (currentPartialImplementation.has(requirement.id)) return 'NOT_VERIFIED'
  if (requirement.phase === 'Alpha') return 'NOT_VERIFIED'
  return 'ROADMAP_NOT_STARTED'
}

const packingImplementationRefs =
  'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0069_order_packing.sql; shared/order-packing.ts; workers/fulfillment/packing.ts; workers/fulfillment/packing-http.ts; workers/fulfillment/admin.ts; workers/canary.ts; app/components/OrderPackingPanel.vue; app/components/OrderFulfillmentSection.vue; tests/unit/d1-order-packing.test.ts; tests/unit/d1-order-packing-http.test.ts; tests/unit/d1-order-packing-native.test.ts; tests/components/order-packing-panel.test.ts; scripts/lib/audit-native-order-packing-browser.ts; tests/unit/audit-native-order-packing-browser.test.ts; scripts/audit-cloudflare-shop.ts'

const productWatchImplementationRefs = [
  'db/d1/migrations/0087_product_watch.sql',
  'shared/product-watch.ts',
  'workers/marketing/product-watch.ts',
  'workers/marketing/product-watch-http.ts',
  'workers/runtime/product-watch.ts',
  'workers/runtime/customer-operations-http.ts',
  'app/components/ProductWatchPanel.vue',
  'app/components/ProductEngagementPanel.vue',
  'app/pages/cuenta/avisos-productos.vue',
  'app/pages/producto/[slug].vue',
  'tests/unit/product-watch.test.ts',
  'tests/unit/product-watch-http.test.ts',
  'tests/unit/product-watch-runtime.test.ts',
  'tests/unit/customer-product-engagement-runtime.test.ts',
  'tests/components/product-watch-panel.test.ts',
  'tests/components/product-watch-page.test.ts',
  'tests/components/product-engagement-pdp.test.ts',
  'tests/unit/d1-product-engagement-native.test.ts'
].join('; ')

const cartRecoveryImplementationRefs = [
  'db/d1/migrations/0090_cart_recovery.sql',
  'shared/cart-recovery.ts',
  'workers/marketing/cart-recovery.ts',
  'workers/marketing/cart-recovery-http.ts',
  'workers/marketing/product-watch.ts',
  'workers/marketing/newsletter-campaign-delivery.ts',
  'workers/runtime/cart-recovery.ts',
  'workers/runtime/customer-operations-http.ts',
  'workers/cart-coordinator.ts',
  'workers/catalog/cart.ts',
  'app/components/CartRecoveryPanel.vue',
  'app/components/CartRecoverySection.vue',
  'app/pages/cuenta/recuperar-carrito.vue',
  'app/pages/carrito.vue',
  'app/pages/checkout.vue',
  'tests/unit/cart-recovery.test.ts',
  'tests/unit/cart-recovery-http.test.ts',
  'tests/unit/cart-recovery-frequency-cap.test.ts',
  'tests/unit/cart-recovery-multichannel-cap.test.ts',
  'tests/unit/cart-recovery-coordinator.test.ts',
  'tests/unit/cart-recovery-runtime.test.ts',
  'tests/unit/cart-recovery-dispatch-runtime.test.ts',
  'tests/unit/d1-cart-recovery-native.test.ts',
  'tests/components/cart-recovery.test.ts',
  'tests/components/cart-recovery-section-navigation.test.ts',
  'tests/support/compiled-shop-fixture.ts',
  'tests/compiled/cart-recovery.test.ts'
].join('; ')
const resourceHubImplementationRefs = [
  'shared/resource-hub.ts',
  'workers/content/resource-hub.ts',
  'workers/content/resource-hub-http.ts',
  'workers/cms/public-http.ts',
  'workers/catalog/seo-http.ts',
  'app/components/ResourceHubPanel.vue',
  'app/components/CmsContentBlocks.vue',
  'app/components/CmsDraftEditor.vue',
  'app/pages/recursos/index.vue',
  'app/pages/recursos/[slug].vue',
  'app/pages/contenido/[slug].vue',
  'app/components/AppFooter.vue',
  'tests/unit/resource-hub.test.ts',
  'tests/unit/resource-hub-http.test.ts',
  'tests/unit/resource-hub-runtime.test.ts',
  'tests/unit/resource-hub-ssr.test.ts',
  'tests/unit/d1-resource-hub-seo.test.ts',
  'tests/components/resource-hub.test.ts',
  'tests/components/resource-hub-editor.test.ts',
  'tests/components/resource-content-renderer.test.ts',
  'tests/support/compiled-shop-fixture.ts',
  'tests/compiled/resource-hub.test.ts'
].join('; ')
const productContributionImplementationRefs = [
  'db/d1/migrations/0088_product_contributions.sql',
  'shared/product-contributions.ts',
  'workers/support/product-contributions.ts',
  'workers/support/product-contributions-http.ts',
  'workers/runtime/customer-operations-http.ts',
  'shared/admin-navigation.ts',
  'app/components/ProductContributionsPanel.vue',
  'app/components/AdminProductContributionsPanel.vue',
  'app/pages/admin/aportaciones-productos.vue',
  'app/pages/cuenta/aportaciones-productos.vue',
  'app/pages/producto/[slug].vue',
  'tests/unit/product-contributions.test.ts',
  'tests/unit/product-contributions-http.test.ts',
  'tests/unit/customer-product-engagement-runtime.test.ts',
  'tests/components/product-contributions.test.ts',
  'tests/components/product-engagement-pdp.test.ts',
  'tests/unit/d1-product-engagement-native.test.ts'
].join('; ')
const customer360ImplementationRefs = [
  'shared/customer-360.ts',
  'workers/support/customer-360.ts',
  'workers/support/customer-360-http.ts',
  'workers/runtime/customer-operations-http.ts',
  'app/components/Customer360Panel.vue',
  'app/pages/admin/clientes/contexto.vue',
  'shared/admin-navigation.ts',
  'tests/unit/customer-360.test.ts',
  'tests/unit/customer-360-http.test.ts',
  'tests/unit/commercial-context-runtime.test.ts',
  'tests/unit/d1-commercial-context-native.test.ts',
  'tests/components/customer-360.test.ts'
].join('; ')
const salesQuoteImplementationRefs = [
  'db/d1/migrations/0089_sales_quotes.sql',
  'shared/sales-quotes.ts',
  'workers/catalog/sales-quotes.ts',
  'workers/catalog/sales-quotes-http.ts',
  'workers/catalog/checkout.ts',
  'workers/catalog/shipping.ts',
  'workers/cart-coordinator.ts',
  'workers/runtime/customer-operations-http.ts',
  'app/components/SalesQuotesPanel.vue',
  'app/pages/admin/presupuestos.vue',
  'app/pages/cuenta/presupuestos.vue',
  'tests/unit/sales-quotes-conversion.test.ts',
  'tests/unit/sales-quotes-http.test.ts',
  'tests/unit/commercial-context-runtime.test.ts',
  'tests/unit/d1-commercial-context-native.test.ts',
  'tests/components/sales-quotes-panels.test.ts'
].join('; ')

const deliveryPreferenceImplementationRefs = [
  'db/d1/migrations/0070_delivery_preferences.sql',
  'shared/delivery-preferences.ts',
  'workers/auth/delivery-preferences.ts',
  'workers/auth/delivery-preferences-http.ts',
  'workers/communications/delivery-notice-preferences.ts',
  'workers/communications/transactional-email-delivery.ts',
  'app/components/DeliveryPreferencesPanel.vue',
  'app/pages/cuenta/comunicaciones.vue',
  'workers/auth/account-privacy.ts',
  'tests/unit/d1-delivery-preferences.test.ts',
  'tests/unit/d1-delivery-preferences-http.test.ts',
  'tests/unit/d1-delivery-preferences-native.test.ts',
  'tests/unit/d1-delivery-notice-preferences.test.ts',
  'tests/components/delivery-preferences-panel.test.ts',
  'tests/components/delivery-preferences-mounting.test.ts',
  'scripts/lib/audit-native-account-settings-browser.ts',
  'tests/unit/native-account-settings-browser.test.ts'
].join('; ')

const customerTaxValidationImplementationRefs = [
  'shared/customer-tax-validation.ts',
  'server/domain/spanish-tax-id.ts',
  'workers/auth/company.ts',
  'workers/auth/address-book.ts',
  'workers/auth/admin-companies.ts',
  'workers/catalog/checkout.ts',
  'app/pages/cuenta/datos.vue',
  'app/pages/cuenta/direcciones.vue',
  'tests/unit/customer-tax-validation.test.ts',
  'tests/unit/d1-company-security-notices.test.ts',
  'tests/unit/d1-customer-addresses.test.ts',
  'tests/unit/d1-admin-companies.test.ts',
  'tests/unit/d1-account-security-native.test.ts',
  'tests/components/account-profile.test.ts',
  'tests/components/account-address-book.test.ts'
].join('; ')

const promotionImplementationRefs = [
  'db/d1/migrations/0072_promotions.sql',
  'db/d1/migrations/0073_promotion_admin_commands.sql',
  'shared/promotions.ts',
  'shared/admin-promotions.ts',
  'workers/catalog/promotions.ts',
  'workers/catalog/promotion-lookup.ts',
  'workers/catalog/promotion-order.ts',
  'workers/catalog/admin-promotions.ts',
  'workers/catalog/admin-promotions-http.ts',
  'workers/catalog/cart.ts',
  'workers/catalog/checkout.ts',
  'workers/cart-coordinator.ts',
  'workers/catalog/storefront-shipping.ts',
  'workers/catalog/storefront-checkout.ts',
  'workers/catalog/admin-orders.ts',
  'workers/fiscal/issuance.ts',
  'workers/refunds/source.ts',
  'app/pages/admin/promociones.vue',
  'app/pages/checkout.vue',
  'app/pages/pedido/[id].vue',
  'tests/unit/promotions.test.ts',
  'tests/unit/d1-promotions.test.ts',
  'tests/unit/d1-promotion-schema.test.ts',
  'tests/unit/d1-admin-promotions.test.ts',
  'tests/unit/d1-admin-promotions-http.test.ts',
  'tests/unit/d1-coupon-checkout.test.ts',
  'tests/unit/d1-coupon-http.test.ts',
  'tests/unit/d1-promotions-native.test.ts',
  'tests/unit/fiscal-coupon-contract.test.ts',
  'tests/unit/d1-coupon-refunds.test.ts',
  'tests/unit/d1-order-coupon-breakdown.test.ts',
  'tests/components/admin-promotions.test.ts',
  'tests/components/checkout-coupons.test.ts',
  'tests/components/order-coupon-breakdown.test.ts'
].join('; ')

function evidenceFor(id: string) {
  const infrastructurePartialRefs: Record<string, string[]> = {
    'SEC-003': [
      '.gitleaks.toml',
      '.github/workflows/ci.yml',
      'scripts/lib/gitleaks-policy-probe.mjs',
      'tests/unit/gitleaks-policy-probe.test.ts',
      'scripts/lib/cloudflare-config-safety.ts',
      'tests/unit/cloudflare-config-boundaries.test.ts',
      'tests/unit/cloudflare-demo-secrets.test.ts'
    ],
    'TST-009': [
      'tests/unit/d1-durable-object-persistence-native.test.ts',
      'tests/unit/d1-migrations-upgrade.test.ts',
      'tests/unit/d1-account-security-native.test.ts',
      'scripts/audit-cloudflare-shop.ts'
    ],
    'CIC-006': [
      'scripts/emit-cloudflare-artifacts.ts',
      'scripts/lib/cloudflare-artifact-manifest.ts',
      'tests/unit/cloudflare-artifact-manifest.test.ts',
      'tests/unit/cloudflare-artifacts-cli.test.ts',
      'tests/unit/cloudflare-artifacts-ci.test.ts',
      'scripts/lib/worker-bundle-policy.ts'
    ],
    'CIC-007': [
      'infra/cloudflare/README.md',
      'infra/cloudflare/versions.tf',
      'infra/cloudflare/resources.tf',
      'infra/cloudflare/edge.tf',
      'scripts/generate-shop-config.ts',
      'scripts/lib/cloudflare-environment-config.ts',
      'scripts/cloudflare-iac-check.mjs',
      'tests/unit/cloudflare-iac-ci.test.ts',
      '.github/workflows/cloudflare-compat.yml'
    ]
  }
  if (infrastructurePartialRefs[id]) return infrastructurePartialRefs[id]!.join('; ')
  const shippingCalendarRefs = [
    'db/d1/migrations/0078_shipping_calendars.sql',
    'shared/shipping-calendar.ts',
    'workers/catalog/shipping-calendar.ts',
    'workers/catalog/shipping-calendar-http.ts',
    'workers/catalog/shipping.ts',
    'workers/catalog/storefront-shipping.ts',
    'workers/catalog/checkout.ts',
    'workers/canary.ts',
    'app/components/ShippingCalendarPanel.vue',
    'app/pages/admin/operaciones.vue',
    'app/pages/checkout.vue',
    'tests/unit/d1-shipping-calendar.test.ts',
    'tests/unit/d1-shipping-calendar-http.test.ts',
    'tests/unit/d1-storefront-shipping.test.ts',
    'tests/unit/operations-batch-runtime.test.ts',
    'tests/unit/operations-batch-native.test.ts',
    'tests/components/shipping-calendar.test.ts',
    'tests/components/admin-operations-capabilities.test.ts'
  ].join('; ')
  const paginationImplementationRefs = [
    'server/api/search.get.ts',
    'server/api/products.get.ts',
    'workers/catalog/products.ts',
    'app/composables/useInfiniteProducts.ts',
    'app/pages/catalogo.vue',
    'app/pages/categoria/[slug].vue',
    'app/pages/buscar.vue',
    'app/components/ResourceHubPanel.vue',
    'app/pages/recursos/index.vue',
    'tests/components/search-read-state.test.ts',
    'tests/components/resource-hub.test.ts',
    'tests/compiled/search-pagination.test.ts',
    'tests/compiled/resource-hub.test.ts',
    'vitest.compiled.config.ts'
  ].join('; ')
  const evidence: Record<string, string> = {
    'SEA-008': paginationImplementationRefs,
    'SEO-011': paginationImplementationRefs,
    'MKT-012': cartRecoveryImplementationRefs,
    'MKT-013': cartRecoveryImplementationRefs,
    'CHK-020': cartRecoveryImplementationRefs,
    'MKT-027': resourceHubImplementationRefs,
    'SEO-027': resourceHubImplementationRefs,
    'SEA-016': resourceHubImplementationRefs,
    'MKT-017': productWatchImplementationRefs,
    'MKT-024': productContributionImplementationRefs,
    'MKT-025': productContributionImplementationRefs,
    'CUS-017': customer360ImplementationRefs,
    'ORD-019': salesQuoteImplementationRefs,
    'CUS-027': salesQuoteImplementationRefs,
    'SHP-009': shippingCalendarRefs,
    'SHP-019': shippingCalendarRefs,
    'SUP-006': [
      'db/d1/migrations/0079_support_escalations.sql',
      'shared/support-escalations.ts',
      'workers/support/escalations.ts',
      'workers/support/escalations-http.ts',
      'workers/runtime/customer-operations-http.ts',
      'app/components/AdminSupportEscalationsPanel.vue',
      'app/components/AdminSupportPanel.vue',
      'tests/unit/d1-support-escalations.test.ts',
      'tests/unit/d1-support-escalations-http.test.ts',
      'tests/components/support-escalations.test.ts',
      'tests/unit/operations-batch-runtime.test.ts',
      'tests/unit/operations-batch-native.test.ts'
    ].join('; '),
    'UI-013': [
      'tests/fixtures/ui-state-harness.ts',
      'tests/fixtures/ui-state-visual-artifacts.ts',
      'tests/unit/ui-state-harness.test.ts',
      'tests/unit/ui-state-visual-artifacts.test.ts',
      'tests/components/ui-state-harness.test.ts',
      'tests/visual/ui-state-harness.spec.ts',
      'tests/e2e/ui-state-routes.spec.ts',
      'playwright.ui-state-harness.config.ts',
      'playwright.ui-state-routes.config.ts',
      'docs/testing/ui-state-harness.md'
    ].join('; '),
    'CAT-010':
      'db/d1/migrations/0076_catalog_relations.sql; shared/catalog-relations.ts; workers/catalog/catalog-relations.ts; workers/catalog/catalog-relations-http.ts; workers/canary.ts; app/components/ProductRelationsEditor.vue; app/components/PublishedProductRelations.vue; app/pages/admin/productos/[id].vue; app/pages/producto/[slug].vue; app/pages/carrito.vue; app/components/support/SupportTicketFacts.vue; tests/unit/d1-catalog-relations.test.ts; tests/unit/d1-catalog-relations-http.test.ts; tests/unit/d1-catalog-relations-native.test.ts; tests/components/product-relations-editor.test.ts; tests/components/published-product-relations.test.ts',
    'CHK-018':
      'db/d1/migrations/0075_cart_snapshots.sql; shared/cart-snapshots.ts; workers/catalog/cart-snapshots.ts; workers/catalog/cart-snapshots-http.ts; workers/catalog/customer-favorites.ts; workers/catalog/cart.ts; workers/canary.ts; app/components/CartSnapshotsPanel.vue; app/pages/carrito.vue; app/pages/carrito-compartido.vue; tests/unit/d1-cart-snapshots.test.ts; tests/unit/d1-cart-snapshots-http.test.ts; tests/unit/d1-cart-snapshots-native.test.ts; tests/components/cart-snapshots-panel.test.ts; tests/components/cart-shared.test.ts',
    'PRI-013': promotionImplementationRefs,
    'PRI-016': promotionImplementationRefs,
    'CHK-019': promotionImplementationRefs,
    'PRI-012':
      'server/domain/money.ts; shared/promotion-basket-preview.ts; workers/catalog/promotion-basket-preview.ts; workers/catalog/cart.ts; workers/catalog/shipping.ts; workers/catalog/admin-promotions-http.ts; workers/canary.ts; app/components/PromotionBasketSimulator.vue; app/pages/admin/promociones.vue; tests/unit/d1-promotion-basket-preview.test.ts; tests/unit/d1-promotion-basket-preview-http.test.ts; tests/unit/d1-promotions-native.test.ts; tests/components/promotion-basket-simulator.test.ts; tests/components/admin-promotions.test.ts',
    'CHK-016':
      'server/services/cart.ts; server/services/orders.ts; db/d1/migrations/0074_order_purchase_reference.sql; workers/catalog/order-customer-reference.ts; workers/catalog/checkout.ts; workers/cart-coordinator.ts; workers/catalog/storefront-checkout.ts; workers/catalog/admin-orders.ts; workers/fulfillment/admin.ts; shared/order-fulfillment.ts; shared/types/orders.ts; app/pages/checkout.vue; app/pages/pedido/[id].vue; app/pages/admin/pedidos/[id].vue; tests/unit/d1-order-purchase-reference.test.ts; tests/unit/d1-order-purchase-reference-readers.test.ts; tests/unit/d1-storefront-checkout.test.ts; tests/unit/d1-promotions-native.test.ts; tests/components/checkout-purchase-reference.test.ts; tests/components/order-purchase-reference.test.ts',
    'SHP-015':
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; shared/order-tracking.ts; workers/fulfillment/tracking.ts; workers/fulfillment/tracking-http.ts; workers/catalog/guest-order-access.ts; workers/canary.ts; app/components/OrderTrackingPanel.vue; app/pages/pedido/[id].vue; app/pages/admin/pedidos/[id].vue; tests/unit/d1-order-tracking.test.ts; tests/unit/d1-order-tracking-http.test.ts; tests/unit/d1-order-tracking-native.test.ts; tests/components/order-tracking-panel.test.ts; tests/components/order-tracking-mounting.test.ts; scripts/lib/audit-native-order-tracking-browser.ts; tests/unit/audit-native-order-tracking-browser.test.ts; scripts/lib/audit-native-guest-order-browser.ts; tests/unit/native-guest-order-browser.test.ts; scripts/audit-cloudflare-shop.ts; ' +
      deliveryPreferenceImplementationRefs,
    'SHP-013': packingImplementationRefs,
    'SHP-018': packingImplementationRefs,
    'SHP-020': packingImplementationRefs,
    'SUP-010':
      'db/d1/migrations/0068_support_satisfaction.sql; shared/support-satisfaction.ts; workers/support/satisfaction.ts; workers/support/satisfaction-http.ts; workers/runtime/customer-operations-http.ts; app/components/CustomerSatisfactionPanel.vue; app/components/AdminSatisfactionPanel.vue; app/components/CustomerSupportSection.vue; app/components/AdminSupportSection.vue; app/pages/pedido/[id].vue; tests/unit/d1-support-satisfaction.test.ts; tests/unit/d1-support-satisfaction-schema.test.ts; tests/unit/d1-support-satisfaction-adversarial.test.ts; tests/unit/d1-support-satisfaction-http.test.ts; tests/unit/d1-support-satisfaction-native.test.ts; tests/unit/customer-operations-http.test.ts; tests/components/satisfaction-panels.test.ts; tests/components/support-satisfaction-mounting.test.ts; tests/components/delivery-satisfaction-mounting.test.ts; scripts/lib/audit-native-satisfaction-browser.ts; tests/unit/audit-native-satisfaction-browser.test.ts; scripts/audit-cloudflare-shop.ts',
    'INV-011':
      'db/d1/migrations/0067_inventory_alerts.sql; shared/inventory-alerts.ts; workers/catalog/inventory-position-sql.ts; workers/catalog/inventory-alerts.ts; workers/catalog/inventory-alerts-http.ts; workers/canary.ts; app/components/InventoryAlertsPanel.vue; app/pages/admin/inventario.vue; tests/unit/d1-inventory-alerts.test.ts; tests/unit/d1-inventory-alerts-http.test.ts; tests/unit/d1-inventory-alerts-runtime.test.ts; tests/unit/d1-inventory-alerts-native.test.ts; tests/components/inventory-alerts-panel.test.ts; tests/components/admin-inventory-page.test.ts; scripts/lib/audit-native-inventory-alerts-browser.ts; tests/unit/audit-native-inventory-alerts-browser.test.ts; scripts/audit-cloudflare-shop.ts',
    'ORD-008':
      'workers/catalog/guest-order-access.ts; workers/catalog/guest-order-access-http.ts; workers/catalog/storefront-checkout.ts; workers/catalog/checkout.ts; workers/communications/order-created-email.ts; workers/communications/transactional-email-delivery.ts; workers/canary.ts; workers/shop.ts; shared/types/orders.ts; app/pages/pedido/[id].vue; tests/unit/d1-guest-order-access.test.ts; tests/unit/d1-guest-order-access-entrypoints.test.ts; tests/unit/d1-guest-order-email.test.ts; tests/unit/d1-guest-order-email-scheduled.test.ts; tests/components/order-payment-recovery.test.ts',
    'SEA-017':
      'shared/quick-order.ts; app/components/QuickOrderPanel.vue; app/pages/pedido-rapido.vue; app/components/AppHeader.vue; tests/unit/quick-order.test.ts; tests/unit/quick-order-native.test.ts; tests/components/quick-order.test.ts; tests/components/admin-navigation.test.ts',
    'CUS-026':
      'shared/quick-order.ts; app/components/QuickOrderPanel.vue; app/pages/pedido-rapido.vue; app/stores/cart.ts; tests/unit/quick-order.test.ts; tests/unit/quick-order-native.test.ts; tests/components/quick-order.test.ts',
    'INT-002':
      'db/d1/migrations/0009_fiscal_outbox.sql; db/d1/migrations/0027_email_outbox.sql; db/d1/migrations/0031_transactional_email_delivery.sql; workers/catalog/fiscal-outbox.ts; workers/communications/email-outbox.ts; workers/canary.ts; tests/unit/d1-email-outbox.test.ts; tests/unit/d1-scheduled-outbox-isolation.test.ts',
    'TST-010':
      'db/d1/migrations/; scripts/lib/d1-demo-sql.ts; tests/support/d1-sqlite.ts; tests/unit/d1-migrations-upgrade.test.ts',
    'ORD-003':
      'shared/order-timeline.ts; workers/catalog/order-timeline.ts; workers/catalog/order-timeline-http.ts; workers/canary.ts; app/components/OrderTimelinePanel.vue; app/components/AccountOrderRow.vue; app/pages/admin/pedidos/[id].vue; tests/unit/d1-order-timeline.test.ts; tests/unit/d1-order-timeline-http.test.ts; tests/unit/d1-order-timeline-native.test.ts; tests/unit/d1-order-timeline-adversarial.test.ts; tests/unit/d1-order-timeline-entrypoints.test.ts; tests/components/order-timeline-panel.test.ts; tests/components/order-timeline-mounting.test.ts; scripts/lib/audit-native-order-timeline.ts; tests/unit/audit-native-order-timeline.test.ts; scripts/audit-cloudflare-shop.ts',
    'ORD-018':
      'shared/order-reorder.ts; app/composables/useReorder.ts; app/components/ReorderDialog.vue; app/utils/orderDetail.ts; app/components/AccountOrderRow.vue; app/stores/cart.ts; app/pages/carrito.vue; app/pages/checkout.vue; workers/catalog/cart.ts; workers/catalog/storefront-cart.ts; workers/catalog/customer-orders.ts; tests/components/reorder-read-state.test.ts; tests/components/account-order-row-read-state.test.ts; tests/components/cart-add-recovery.test.ts; tests/components/checkout-command-recovery.test.ts; tests/unit/order-reorder-offer.test.ts; tests/unit/d1-cart-operations-native.test.ts; tests/unit/d1-cart-entrypoints.test.ts; tests/unit/d1-customer-orders.test.ts; tests/unit/d1-customer-orders-native.test.ts; tests/unit/audit-native-cart-add-recovery-browser.test.ts',
    'SEA-005':
      'db/d1/migrations/0061_search_synonyms.sql; shared/search-synonyms.ts; workers/catalog/search-synonyms.ts; workers/catalog/search-synonyms-http.ts; workers/catalog/search.ts; workers/catalog/products.ts; app/components/SearchSynonymsPanel.vue; app/pages/admin/busqueda.vue; tests/unit/d1-search-synonyms.test.ts; tests/unit/d1-search-synonyms-http.test.ts; tests/unit/d1-products-search-native.test.ts; tests/components/search-synonyms.test.ts; scripts/audit-cloudflare-shop.ts',
    'SUP-007':
      'db/d1/migrations/0062_support_knowledge_feedback.sql; shared/support-knowledge.ts; workers/support/knowledge.ts; workers/support/knowledge-http.ts; workers/runtime/customer-operations-http.ts; app/components/SupportKnowledgePanel.vue; app/components/CmsDraftEditor.vue; app/pages/ayuda.vue; tests/unit/d1-support-knowledge.test.ts; tests/unit/d1-support-knowledge-http.test.ts; tests/unit/d1-support-knowledge-schema.test.ts; tests/components/support-knowledge.test.ts; tests/components/cms-draft-editor.test.ts; scripts/audit-cloudflare-shop.ts',
    'UI-003':
      'shared/admin-navigation.ts; shared/admin-activity.ts; shared/admin-global-search.ts; workers/auth/admin-capabilities.ts; workers/auth/admin-activity.ts; workers/auth/admin-activity-http.ts; workers/auth/admin-global-search.ts; workers/auth/admin-global-search-http.ts; app/composables/useAdminNavigation.ts; app/layouts/admin.vue; app/middleware/admin.ts; app/components/AdminCommandPalette.vue; app/components/AdminNavigationContext.vue; app/components/AdminRecentActivity.vue; app/components/AdminGlobalSearch.vue; tests/unit/d1-admin-capabilities.test.ts; tests/unit/d1-admin-entrypoints.test.ts; tests/unit/d1-admin-activity.test.ts; tests/unit/d1-admin-activity-http.test.ts; tests/unit/d1-admin-activity-native.test.ts; tests/unit/d1-admin-global-search.test.ts; tests/unit/d1-admin-global-search-http.test.ts; tests/unit/d1-admin-global-search-native.test.ts; tests/unit/audit-native-admin-global-search.test.ts; tests/components/admin-navigation.test.ts; tests/components/admin-command-palette.test.ts; tests/components/admin-navigation-context.test.ts; tests/components/admin-recent-activity.test.ts; tests/components/admin-global-search.test.ts',
    'CIC-001':
      '.node-version; package.json; package-lock.json; nuxt.config.ts; wrangler.canary.jsonc; workers/shop.ts; workers/runtime/shop-ingress.ts; workers/runtime/nitro-bridge.ts; server-cloudflare/middleware/00.d1-api.ts; scripts/generate-shop-config.ts; scripts/lib/cloudflare-config-safety.ts; scripts/lib/worker-bundle-policy.ts; scripts/lib/worker-source-map.ts; scripts/audit-shop-bundle.ts; scripts/audit-cloudflare-shop.ts; tests/unit/cloudflare-shop-config.test.ts; tests/unit/cloudflare-config-boundaries.test.ts; tests/unit/worker-bundle-policy.test.ts; tests/unit/worker-build-evidence.test.ts; tests/unit/worker-source-map.test.ts; tests/unit/nuxt-cloudflare-profile.test.ts; tests/unit/nitro-d1-bridge.test.ts; tests/unit/cloudflare-shop-ingress.test.ts; .github/workflows/cloudflare-compat.yml; docs/cloudflare/README.md',
    'CUS-013':
      'db/d1/migrations/0026_customer_favorites.sql; workers/catalog/customer-favorites.ts; workers/catalog/customer-favorites-http.ts; app/composables/useFavorites.ts; app/pages/cuenta/favoritos.vue; tests/unit/d1-customer-favorites.test.ts; tests/unit/d1-customer-favorites-http.test.ts',
    'COM-001':
      'db/d1/migrations/0031_transactional_email_delivery.sql; workers/communications/transactional-email-delivery.ts; workers/communications/order-created-email.ts; workers/communications/README.md; workers/canary.ts; wrangler.canary.jsonc; tests/unit/d1-transactional-email-delivery.test.ts; docs/cloudflare/preproduction.md',
    'ADM-007':
      'workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; app/pages/admin/index.vue; app/pages/admin/operaciones.vue; tests/unit/d1-admin-orders.test.ts; tests/unit/d1-admin-inventory-operations.test.ts; tests/unit/d1-admin-orders-origin.test.ts; tests/components/admin-operations-capabilities.test.ts; tests/components/admin-dashboard-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'ADM-008':
      'db/d1/migrations/0034_catalog_draft_metadata.sql; workers/catalog/admin-catalog.ts; workers/catalog/admin-catalog-http.ts; workers/catalog/admin-catalog-mutations.ts; workers/catalog/catalog-publication-readiness.ts; workers/catalog/admin-pricing.ts; workers/catalog/admin-pricing-http.ts; app/utils/catalogCapabilities.ts; app/components/DraftProductMetadataEditor.vue; app/components/CatalogPublicationReadiness.vue; app/pages/admin/productos/index.vue; app/pages/admin/productos/[id].vue; app/pages/admin/categorias.vue; app/pages/admin/precios.vue; tests/unit/d1-admin-catalog.test.ts; tests/unit/d1-admin-catalog-mutations.test.ts; tests/unit/d1-admin-catalog-mutations-http.test.ts; tests/unit/d1-catalog-publication-readiness.test.ts; tests/unit/d1-admin-pricing.test.ts; tests/unit/d1-admin-pricing-review.test.ts; tests/unit/catalog-capabilities.test.ts; tests/components/admin-catalog-capabilities.test.ts; tests/components/draft-product-metadata-editor.test.ts; tests/components/catalog-publication-readiness.test.ts; tests/components/admin-category-capabilities.test.ts; tests/components/admin-pricing-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'ADM-012':
      'scripts/lib/cloudflare-config-safety.ts; scripts/generate-shop-config.ts; scripts/cloudflare-preprod.ts; tests/unit/cloudflare-shop-config.test.ts; tests/unit/cloudflare-preprod-config.test.ts; tests/unit/cloudflare-config-boundaries.test.ts; docs/cloudflare/preproduction.md',
    'ADM-014':
      'db/d1/migrations/0012_media_quarantine.sql; db/d1/migrations/0033_media_publication.sql; workers/catalog/media.ts; workers/media/http.ts; workers/media/governance.ts; workers/media/governance-http.ts; app/pages/admin/medios.vue; app/components/MediaPublicationDialog.vue; app/utils/mediaPublication.ts; tests/unit/media-publication-form.test.ts; tests/components/media-publication-dialog.test.ts; tests/components/media-library-governance.test.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-review-adversarial.test.ts; docs/cloudflare/README.md',
    'MED-001':
      'db/d1/migrations/0012_media_quarantine.sql; db/d1/migrations/0033_media_publication.sql; workers/media/http.ts; workers/media/governance.ts; workers/media/governance-http.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-review-adversarial.test.ts; docs/cloudflare/README.md',
    'MED-002':
      'db/d1/migrations/0033_media_publication.sql; workers/media/governance.ts; workers/media/public-catalog.ts; workers/media/public-delivery.ts; workers/catalog/storefront-cart.ts; workers/catalog/customer-orders.ts; workers/catalog/admin-orders.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-review-adversarial.test.ts; tests/unit/d1-media-public.test.ts; tests/unit/d1-storefront-cart.test.ts; tests/unit/d1-customer-orders.test.ts; tests/unit/d1-admin-orders.test.ts; tests/support/media-publication-fixture.ts; docs/cloudflare/README.md',
    'MED-006':
      'db/d1/migrations/0033_media_publication.sql; workers/media/governance.ts; workers/media/public-catalog.ts; workers/media/public-delivery.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-public.test.ts; docs/cloudflare/README.md',
    'MED-007':
      'db/d1/migrations/0012_media_quarantine.sql; db/d1/migrations/0013_media_storage_reconciliation.sql; db/d1/migrations/0033_media_publication.sql; shared/media-envelope.ts; shared/media-dimensions.ts; workers/catalog/media.ts; workers/media/http.ts; workers/media/governance.ts; workers/media/governance-http.ts; workers/media/public-delivery.ts; tests/unit/d1-media.test.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-review-adversarial.test.ts; tests/unit/d1-media-public.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'MED-008':
      'workers/media/public-delivery.ts; app/utils/publishedMedia.ts; app/utils/catalogImages.ts; app/components/PublishedProductImage.vue; app/components/ProductImage.vue; app/components/OrderLineThumb.vue; app/components/HeroOfferSlider.vue; app/pages/producto/[slug].vue; tests/unit/d1-media-public.test.ts; tests/unit/published-media.test.ts; tests/components/published-product-image.test.ts; tests/components/governed-image-consumers.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'MED-009':
      'db/d1/migrations/0033_media_publication.sql; workers/media/governance.ts; workers/media/public-catalog.ts; app/utils/catalogImages.ts; app/components/PublishedProductImage.vue; app/components/ProductImage.vue; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-public.test.ts; tests/components/published-product-image.test.ts; docs/cloudflare/README.md',
    'MED-011':
      'db/d1/migrations/0033_media_publication.sql; workers/media/governance.ts; workers/media/public-catalog.ts; workers/media/public-delivery.ts; app/utils/publishedMedia.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-public.test.ts; tests/unit/published-media.test.ts; docs/cloudflare/README.md',
    'MED-012':
      'db/d1/migrations/0033_media_publication.sql; workers/media/governance.ts; workers/media/governance-http.ts; workers/media/public-catalog.ts; workers/media/public-delivery.ts; tests/unit/d1-media-governance.test.ts; tests/unit/d1-media-public.test.ts; docs/cloudflare/README.md',
    'MED-015':
      'app/components/ProductImage.vue; app/components/ProductVisual.vue; app/utils/catalogImages.ts; workers/catalog/storefront-cart.ts; workers/catalog/customer-orders.ts; workers/catalog/admin-orders.ts; tests/components/published-product-image.test.ts; tests/unit/d1-storefront-cart.test.ts; tests/unit/d1-customer-orders.test.ts; tests/unit/d1-admin-orders.test.ts; docs/cloudflare/README.md',
    'CUS-001':
      'db/d1/migrations/0014_identity_authorization.sql; db/d1/migrations/0018_customer_profiles.sql; workers/auth/profile.ts; tests/unit/d1-authentication-http.test.ts',
    'CUS-002':
      'db/d1/migrations/0018_customer_profiles.sql; db/d1/migrations/0019_company_review_events.sql; workers/auth/profile.ts; workers/auth/company.ts; tests/unit/d1-authentication-http.test.ts; scripts/audit-d1-media.ts',
    'CUS-003':
      'db/d1/migrations/0014_identity_authorization.sql; db/d1/migrations/0017_authentication_rate_limits.sql; db/d1/migrations/0021_account_security.sql; db/d1/migrations/0022_mfa_enrollments.sql; db/d1/migrations/0032_identity_lifecycle.sql; workers/auth/login.ts; workers/auth/session-cookie.ts; workers/auth/security.ts; workers/auth/mfa-enrollment.ts; workers/auth/http.ts; workers/auth/lifecycle.ts; workers/auth/lifecycle-http.ts; workers/communications/identity-email-delivery.ts; app/pages/registro.vue; tests/unit/d1-authentication-http.test.ts; tests/unit/d1-account-security.test.ts; tests/unit/d1-mfa-enrollment.test.ts; tests/unit/d1-identity-lifecycle.test.ts; tests/unit/d1-identity-lifecycle-http.test.ts; tests/unit/d1-identity-lifecycle-adversarial.test.ts; tests/unit/d1-identity-email-delivery.test.ts; tests/unit/d1-identity-email-integration.test.ts; tests/components/registration-state.test.ts; scripts/audit-d1-media.ts; scripts/audit-cloudflare-shop.ts',
    'CUS-005':
      'db/d1/migrations/0018_customer_profiles.sql; db/d1/migrations/0019_company_review_events.sql; db/d1/migrations/0021_account_security.sql; db/d1/migrations/0022_mfa_enrollments.sql; db/d1/migrations/0071_account_security_notices.sql; workers/auth/company.ts; workers/auth/security.ts; workers/auth/mfa-enrollment.ts; tests/unit/d1-authentication-http.test.ts; tests/unit/d1-account-security.test.ts; tests/unit/d1-mfa-enrollment.test.ts; scripts/audit-d1-media.ts; workers/auth/lifecycle.ts; workers/communications/identity-security-email.ts; workers/communications/account-security-notices.ts; workers/communications/account-security-email.ts; workers/communications/transactional-email-delivery.ts; tests/unit/d1-identity-security-notice.test.ts; tests/unit/d1-identity-security-native.test.ts; tests/unit/d1-account-security-schema.test.ts; tests/unit/d1-account-security-notices.test.ts; tests/unit/d1-email-change-security-notices.test.ts; tests/unit/d1-company-security-notices.test.ts; tests/unit/d1-account-security-native.test.ts',
    'ADM-003':
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; db/d1/migrations/0022_mfa_enrollments.sql; workers/auth/mfa-enrollment.ts; tests/unit/d1-mfa-enrollment.test.ts; scripts/audit-d1-media.ts',
    'SEC-007':
      'server/middleware/security.ts; server/utils/auth-session.ts; db/d1/migrations/0022_mfa_enrollments.sql; workers/auth/mfa-enrollment.ts; app/pages/cuenta/seguridad.vue; tests/unit/d1-mfa-enrollment.test.ts; scripts/audit-d1-media.ts',
    'CUS-006':
      'server/domain/customer.ts; db/d1/migrations/0020_customer_addresses.sql; workers/auth/address-book.ts; workers/auth/http.ts; tests/unit/d1-customer-addresses.test.ts; scripts/audit-d1-media.ts; db/d1/migrations/0006_checkout_orders.sql',
    'CUS-014':
      'db/d1/migrations/0020_customer_addresses.sql; workers/auth/address-book.ts; app/pages/cuenta/direcciones.vue; tests/unit/d1-customer-addresses.test.ts; tests/components/account-address-read-state.test.ts; scripts/audit-d1-media.ts',
    'CAT-005':
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; db/d1/migrations/0035_catalog_product_status.sql; workers/catalog/admin-catalog-status.ts; workers/catalog/admin-catalog-http.ts; app/components/ProductStatusEditor.vue; app/pages/admin/productos/[id].vue; tests/unit/d1-admin-catalog-status.test.ts; tests/unit/d1-admin-catalog-status-http.test.ts; tests/components/product-status-editor.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'CAT-006':
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; server/domain/catalog-publication.ts; db/d1/migrations/0036_catalog_publication_policy.sql; workers/catalog/catalog-publication-gate.ts; workers/catalog/catalog-publication-readiness.ts; workers/catalog/admin-catalog-status.ts; workers/catalog/admin-catalog-http.ts; workers/media/governance.ts; app/components/CatalogPublicationReadiness.vue; app/components/ProductStatusEditor.vue; app/pages/admin/productos/[id].vue; tests/unit/d1-catalog-publication-gate.test.ts; tests/unit/d1-catalog-publication-readiness.test.ts; tests/unit/d1-admin-catalog-status.test.ts; tests/unit/d1-admin-catalog-status-http.test.ts; tests/components/catalog-publication-readiness.test.ts; tests/components/product-status-editor.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'CHK-014':
      'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue; app/pages/carrito.vue; app/components/CartReadFeedback.vue; app/stores/cart.ts; tests/components/cart-read-recovery.test.ts',
    'SHP-024':
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; workers/catalog/shipping.ts; app/composables/useFreeShipping.ts; app/pages/carrito.vue; tests/components/cart-read-recovery.test.ts',
    'CAT-002':
      'db/d1/migrations/0002_catalog_read_model.sql; scripts/generate-d1-category-seed.ts; scripts/generate-d1-product-seed.ts; scripts/audit-d1-catalog.ts; workers/catalog/products.ts; workers/catalog/product-detail.ts; tests/unit/d1-category-seed.test.ts; tests/unit/d1-product-seed.test.ts; tests/unit/d1-product-facets.test.ts; tests/unit/d1-product-detail.test.ts',
    'CIC-005':
      'wrangler.canary.jsonc; workers/canary.ts; worker-configuration.d.ts; .github/workflows/cloudflare-compat.yml; package.json; tests/unit/cloudflare-canary.test.ts',
    'SEA-001':
      'db/migrations/0020_search_relevance.sql; server/api/search.get.ts; server/api/products.get.ts; workers/catalog/search.ts; workers/catalog/search-http.ts; workers/catalog/products.ts; tests/unit/d1-search.test.ts; scripts/audit-cloudflare-shop.ts',
    'SEA-003':
      'app/components/AppHeader.vue; shared/types/catalog.ts; workers/catalog/search.ts; workers/catalog/search-http.ts; tests/unit/d1-search.test.ts; scripts/audit-cloudflare-shop.ts',
    'SEA-004': 'server/utils/search-terms.ts; db/migrations/0020_search_relevance.sql',
    'PDP-001':
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; db/d1/migrations/0002_catalog_read_model.sql; workers/catalog/product-detail.ts; tests/unit/d1-product-detail.test.ts',
    'PDP-002':
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; db/d1/migrations/0003_variant_price_versions.sql; workers/catalog/pricing.ts; workers/catalog/product-detail.ts; tests/unit/d1-product-detail.test.ts',
    'PDP-003': 'server/api/shipping/product-rates.post.ts; server/services/shipping.ts; app/pages/producto/[slug].vue',
    'PDP-007': 'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue',
    'PDP-008': 'server/api/admin/products/[id]/active.put.ts; server/api/health/ready.get.ts',
    'CHK-001':
      'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue; db/d1/migrations/0005_cart_checkout.sql; workers/catalog/cart.ts; workers/cart-coordinator.ts; tests/unit/d1-cart.test.ts; tests/unit/d1-cart-coordinator.test.ts; scripts/audit-d1-cart.ts',
    'CHK-002':
      'server/services/orders.ts; app/pages/checkout.vue; tests/integration/commerce-transactions.test.ts; workers/catalog/cart.ts; workers/catalog/pricing.ts; workers/catalog/inventory.ts; workers/catalog/checkout.ts; tests/unit/d1-cart.test.ts; tests/unit/d1-checkout.test.ts; scripts/audit-d1-cart.ts; scripts/audit-d1-checkout.ts',
    'CHK-006': 'server/services/shipping.ts; server/services/orders.ts',
    'CHK-009':
      'app/pages/checkout.vue; server/domain/money.ts; db/d1/migrations/0005_cart_checkout.sql; workers/catalog/cart.ts; tests/unit/d1-cart.test.ts; scripts/audit-d1-cart.ts',
    'SHP-001':
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0006_checkout_orders.sql; workers/catalog/shipping.ts; scripts/lib/d1-shipping-seed.ts; tests/unit/d1-checkout.test.ts',
    'SHP-002': 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    'SHP-003':
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0006_checkout_orders.sql; scripts/lib/d1-shipping-seed.ts; workers/catalog/shipping.ts',
    'SHP-006':
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; workers/catalog/shipping.ts; db/d1/migrations/0006_checkout_orders.sql; scripts/lib/d1-shipping-seed.ts; tests/unit/d1-checkout.test.ts; scripts/audit-d1-checkout.ts',
    'ORD-001':
      'server/services/orders.ts; db/migrations/0001_platform_foundation.sql; db/d1/migrations/0006_checkout_orders.sql; db/d1/migrations/0025_order_customer_ownership.sql; workers/catalog/checkout.ts; workers/catalog/customer-orders.ts; tests/unit/d1-checkout.test.ts; tests/unit/d1-customer-orders.test.ts; scripts/audit-d1-checkout.ts',
    'PRI-004': 'server/services/cart.ts; app/components/ProductCard.vue; app/pages/checkout.vue',
    'PRI-006':
      'db/migrations/0024_price_history_and_schedules.sql; server/services/pricing.ts; server/api/admin/prices.get.ts; app/pages/admin/precios.vue; db/d1/migrations/0003_variant_price_versions.sql; db/d1/migrations/0023_price_window_precision.sql; workers/catalog/pricing.ts; workers/catalog/admin-pricing.ts; workers/catalog/admin-pricing-http.ts; scripts/audit-d1-catalog.ts; tests/unit/d1-effective-pricing.test.ts; tests/unit/d1-admin-pricing.test.ts; tests/unit/d1-admin-pricing-review.test.ts; tests/components/admin-pricing-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'PRI-008':
      'server/domain/money.ts; server/services/orders.ts; app/pages/producto/[slug].vue; app/pages/admin/precios.vue; tests/unit/money.test.ts; workers/catalog/pricing.ts; workers/catalog/volume-pricing.ts; workers/catalog/cart.ts; workers/catalog/admin-pricing.ts; workers/catalog/admin-pricing-http.ts; tests/unit/d1-cart.test.ts; tests/unit/d1-admin-pricing.test.ts; tests/unit/d1-admin-pricing-review.test.ts; tests/components/admin-pricing-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'PRI-011':
      'server/services/pricing.ts; server/api/admin/prices.get.ts; server/api/admin/prices.post.ts; server/api/admin/prices/[id]/cancel.post.ts; app/pages/admin/precios.vue; workers/catalog/pricing.ts; workers/catalog/admin-pricing.ts; workers/catalog/admin-pricing-http.ts; tests/unit/d1-admin-pricing.test.ts; tests/unit/d1-admin-pricing-review.test.ts; tests/components/admin-pricing-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'INV-002':
      'db/migrations/0013_inventory_ledger_deltas.sql; db/d1/migrations/0004_inventory_operations.sql; workers/catalog/inventory.ts; scripts/lib/d1-inventory-seed.ts; scripts/audit-d1-inventory.ts',
    'INV-003':
      'workers/catalog/inventory.ts; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; app/pages/admin/operaciones.vue; tests/unit/d1-inventory.test.ts; tests/unit/d1-admin-inventory-operations.test.ts; tests/components/admin-operations-capabilities.test.ts; scripts/audit-d1-inventory.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'INV-004': 'workers/catalog/inventory.ts; tests/unit/d1-inventory.test.ts; scripts/audit-d1-inventory.ts',
    'INV-005':
      'workers/catalog/inventory.ts; workers/inventory-coordinator.ts; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; app/pages/admin/operaciones.vue; scripts/reservation-worker.ts; scripts/audit-d1-inventory.ts; tests/unit/d1-inventory-coordinator.test.ts; tests/unit/d1-admin-inventory-operations.test.ts; tests/components/admin-operations-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'INV-006': 'workers/catalog/inventory.ts; tests/unit/d1-inventory.test.ts; scripts/audit-d1-inventory.ts',
    'INV-008':
      'db/d1/migrations/0004_inventory_operations.sql; scripts/lib/d1-inventory-seed.ts; scripts/audit-d1-inventory.ts',
    'INV-009':
      'db/d1/migrations/0004_inventory_operations.sql; workers/catalog/inventory.ts; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; app/pages/admin/operaciones.vue; tests/unit/d1-inventory.test.ts; tests/unit/d1-admin-inventory-operations.test.ts; tests/components/admin-operations-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'INV-012':
      'server/domain/inventory.ts; server/services/orders.ts; db/d1/migrations/0004_inventory_operations.sql; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; app/pages/admin/index.vue; app/pages/admin/operaciones.vue; tests/unit/d1-admin-inventory-operations.test.ts; tests/components/admin-operations-capabilities.test.ts; tests/components/admin-dashboard-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'SEO-003':
      'server/routes/sitemap.xml.get.ts; server/routes/sitemaps/; workers/catalog/seo-http.ts; workers/runtime/shop-ingress.ts; tests/unit/d1-seo-http.test.ts; tests/unit/d1-seo-privacy.test.ts; scripts/audit-cloudflare-shop.ts',
    'SEO-007': 'app/app.vue; app/pages/producto/[slug].vue',
    'SEO-015': 'server/routes/feeds/google-merchant.xml.get.ts; docs/operations/merchant-feed.md',
    'ADM-009': 'server/utils/content-schema.ts; app/pages/admin/contenido.vue',
    'ADM-010':
      'server/api/admin/content/pages/[id]/preview.post.ts; server/api/admin/content/pages/[id]/publish.post.ts',
    'ADM-011': 'db/migrations/0022_typed_content_cms.sql; server/api/admin/content/pages/[id]/rollback.post.ts',
    'ADM-017':
      'db/migrations/0023_feature_flag_governance.sql; server/api/admin/feature-flags; app/pages/admin/flags.vue',
    'UI-001': 'docs/ui/arquitectura-informacion.md; docs/ui/auditoria-ui-ux-2026-09-01.md',
    'UI-002':
      'docs/ui/design-system.md; app/assets/css/main.css; app/components/ui/Surface.vue; app/components/ui/PageHeader.vue; app/components/ui/EmptyState.vue; app/components/ui/DataTable.vue',
    'UI-004':
      'app/pages/admin/index.vue; app/pages/admin/operaciones.vue; server/api/admin/operations.get.ts; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; tests/unit/d1-admin-orders.test.ts; tests/unit/d1-admin-inventory-operations.test.ts; tests/unit/d1-admin-orders-origin.test.ts; tests/components/admin-operations-capabilities.test.ts; tests/components/admin-dashboard-capabilities.test.ts; scripts/audit-cloudflare-shop.ts; docs/cloudflare/README.md',
    'UI-007':
      'app/pages/admin/pedidos/[id].vue; app/utils/adminOrder.ts; server/api/admin/orders/[id]/detail.get.ts; workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; tests/unit/d1-admin-orders.test.ts',
    'UI-010':
      'app/pages/pedido/[id].vue; app/composables/useReorder.ts; app/components/ReorderDialog.vue; server/api/orders/[id]/lines.get.ts; tests/components/reorder-read-state.test.ts',
    'UI-012': 'app/assets/css/main.css; app/components/ui/; docs/ui/accesibilidad-2026-09-01.md',
    'UI-009':
      'app/layouts/cuenta.vue; app/pages/cuenta/index.vue; app/pages/cuenta/pedidos.vue; app/pages/cuenta/direcciones.vue; app/pages/cuenta/datos.vue; app/pages/cuenta/seguridad.vue; app/pages/cuenta/comunicaciones.vue; app/pages/cuenta/favoritos.vue; app/composables/useAccount.ts',
    'COM-004': 'scripts/outbox-worker.ts; db/migrations/0015_support_and_communications.sql',
    'COM-005':
      'server/api/webhooks/email.post.ts; db/migrations/0025_email_delivery_webhooks.sql; tests/e2e/email-webhook.spec.ts',
    'COM-006':
      'scripts/outbox-worker.ts; scripts/invoice-worker.ts; server/domain/admin-order-status.ts; server/services/invoice-email.ts; tests/unit/invoice-email.test.ts; tests/integration/commerce-transactions.test.ts',
    'COM-007':
      'server/api/orders/[id].get.ts; server/api/orders/[id]/invoice.get.ts; server/api/auth/reset-password.post.ts; server/api/auth/verify-email.post.ts; server/api/account/email-change.post.ts; db/d1/migrations/0032_identity_lifecycle.sql; workers/auth/lifecycle.ts; workers/communications/identity-email.ts; workers/communications/identity-email-delivery.ts; tests/unit/d1-identity-lifecycle-adversarial.test.ts; tests/unit/d1-identity-email-delivery.test.ts; tests/unit/d1-identity-email-integration.test.ts; scripts/audit-cloudflare-shop.ts',
    'COM-008':
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; server/utils/email-base-url.ts; tests/unit/email-provider.test.ts; tests/unit/email-base-url.test.ts; tests/unit/invoice-email.test.ts',
    'TST-006':
      'docs/testing/coverage-policy.json; scripts/audit-coverage-policy.ts; vitest.config.ts; .github/workflows/ci.yml',
    'TST-004':
      'tests/fixtures/deterministic.ts; tests/fixtures/postgres.ts; tests/fixtures/playwright.ts; tests/support/integration-global-setup.ts; tests/support/no-external-network.ts; server/utils/application-clock.ts; scripts/audit-test-determinism.ts; tests/integration/; tests/e2e/',
    'TST-011':
      'tests/e2e/redsys-checkout.spec.ts; scripts/run-e2e.ts; playwright.config.ts; server/api/checkout/pay.post.ts; app/pages/pedido/[id].vue',
    'TST-012':
      'tests/e2e/authenticated-purchase.spec.ts; scripts/run-e2e.ts; server/api/orders/index.post.ts; server/api/auth/logout.post.ts; app/pages/pedido/[id].vue',
    'TST-013':
      'tests/e2e/bank-transfer.spec.ts; scripts/bank-transfer-reconcile.ts; server/services/orders.ts; server/api/admin/operations/bank-transfers/[id]/reconcile.post.ts; scripts/reservation-worker.ts',
    'TST-014':
      'tests/e2e/shipping-fulfillment.spec.ts; server/services/shipping.ts; server/integrations/mock-carrier.ts; app/pages/admin/pedidos.vue; playwright.config.ts',
    'TST-015':
      'tests/e2e/shipping-fulfillment.spec.ts; server/services/orders.ts; server/services/returns.ts; scripts/refund-worker.ts; scripts/credit-note-worker.ts; scripts/outbox-worker.ts; app/pages/devoluciones.vue; app/pages/admin/devoluciones.vue',
    'TST-016':
      'tests/integration/commerce-transactions.test.ts; tests/e2e/bank-transfer.spec.ts; tests/e2e/redsys-checkout.spec.ts; server/services/orders.ts; scripts/reservation-worker.ts; db/migrations/0012_payment_webhook_idempotency.sql',
    'TST-017':
      'tests/fixtures/redsys-official.ts; tests/unit/redsys.test.ts; tests/e2e/redsys-checkout.spec.ts; server/integrations/redsys.ts; server/utils/runtime-config.ts; scripts/redsys-sandbox-contract.ts; docs/testing/strategy.md',
    'TST-018':
      'tests/unit/beply.test.ts; tests/integration/commerce-transactions.test.ts; server/integrations/beply.ts; scripts/invoice-worker.ts; scripts/credit-note-worker.ts; scripts/reconcile.ts; scripts/beply-sandbox-contract.ts; docs/testing/strategy.md',
    'TST-019':
      'server/integrations/carrier-provider.ts; server/integrations/mock-carrier.ts; server/integrations/carrier-factory.ts; tests/unit/shipping.test.ts; tests/e2e/shipping-fulfillment.spec.ts; docs/testing/carrier-contract.md',
    'TST-020':
      'tests/e2e/authorization-idor.spec.ts; tests/e2e/authenticated-purchase.spec.ts; tests/e2e/bank-transfer.spec.ts; docs/testing/authorization-idor.md; playwright.config.ts; .github/workflows/ci.yml',
    'TST-021':
      'tests/e2e/security.spec.ts; tests/e2e/authorization-idor.spec.ts; tests/e2e/privacy.spec.ts; tests/unit/security-boundaries.test.ts; tests/unit/media-upload.test.ts; tests/unit/beply.test.ts; tests/unit/invoice-email.test.ts; server/integrations/beply.ts; server/utils/outbound-url.ts; server/utils/csv.ts; server/utils/private-cookie.ts; server/utils/security-headers.ts; server/utils/abuse-limit.ts; docs/testing/input-output-security.md; .github/workflows/ci.yml',
    'TST-022':
      'tests/e2e/accessibility.spec.ts; docs/testing/automated-accessibility.md; package.json; playwright.config.ts; .github/workflows/ci.yml',
    'TST-024':
      'scripts/run-performance.ts; scripts/lib/performance.ts; server/api/__test__/pool.get.ts; server/db/redis.ts; docs/operations/performance-budgets.json; tests/unit/performance-harness.test.ts; .github/workflows/ci.yml',
    'TST-025':
      'tests/integration/provider-recovery.test.ts; tests/fixtures/postgres-failover-client.ts; server/integrations/mock-carrier.ts; scripts/invoice-worker.ts; scripts/outbox-worker.ts; docs/testing/provider-outage-recovery.md; package.json; .github/workflows/ci.yml',
    'TST-026':
      'tests/components/; app/components/SearchBox.vue; app/components/ProductFilters.vue; app/components/VariantSelector.vue; app/components/QuantityStepper.vue; app/components/CartLineControls.vue; app/components/LoginForm.vue; app/components/ConsentManager.vue; app/components/AdminOrderTable.vue; app/components/RoleGate.vue; docs/testing/critical-component-tests.md; vitest.config.ts; package.json; .github/workflows/ci.yml',
    'TST-027':
      'tests/visual/templates.spec.ts; tests/visual/templates.spec.ts-snapshots/; playwright.visual.config.ts; docs/testing/visual-regression.md; package.json; .github/workflows/ci.yml',
    'TST-028':
      'tests/browser-matrix/storefront-smoke.spec.ts; playwright.matrix.config.ts; playwright.config.ts; docs/testing/browser-device-matrix.md; docs/testing/strategy.md; package.json; .github/workflows/ci.yml',
    'TST-029':
      'server/services/transactional-email.ts; server/services/invoice-email.ts; server/services/newsletter-email.ts; server/integrations/email-provider.ts; scripts/outbox-worker.ts; tests/unit/transactional-email.test.ts; tests/unit/email-provider.test.ts; tests/unit/invoice-email.test.ts; tests/unit/newsletter-email.test.ts; tests/integration/email-notifications.test.ts; tests/integration/provider-recovery.test.ts; tests/integration/newsletter-double-opt-in.test.ts; tests/e2e/email-webhook.spec.ts; docs/testing/email-notifications.md; .github/workflows/ci.yml',
    'TST-030':
      'server/services/catalog-tabular.ts; server/services/catalog-import.ts; scripts/catalog-tabular.ts; tests/unit/catalog-tabular.test.ts; tests/integration/catalog-import.test.ts; docs/testing/catalog-import-export.md; package.json; .github/workflows/ci.yml',
    'TST-031':
      'app/utils/seo.ts; app/composables/useInfiniteProducts.ts; app/app.vue; app/pages/catalogo.vue; app/pages/categoria/[slug].vue; server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; server/routes/sitemaps/; server/middleware/01-security-headers.ts; server/middleware/04-canonical-redirects.ts; server/utils/robots.ts; tests/unit/seo.test.ts; tests/e2e/seo.spec.ts; docs/testing/automated-seo.md; package.json; .github/workflows/ci.yml',
    'TST-032':
      'app/composables/useAnalytics.ts; app/composables/useConsent.ts; app/plugins/analytics.client.ts; app/plugins/rum.client.ts; server/api/analytics/events.post.ts; server/api/analytics/session.delete.ts; server/utils/analytics.ts; server/services/orders.ts; scripts/refund-worker.ts; tests/unit/analytics.test.ts; tests/e2e/analytics.spec.ts; tests/integration/commerce-transactions.test.ts; docs/testing/automated-analytics.md; package.json; .github/workflows/ci.yml',
    'TST-033':
      'server/utils/madrid-calendar.ts; server/utils/shipping-policy.ts; server/domain/shipping.ts; server/integrations/beply.ts; server/services/content-publication.ts; server/api/admin/content/pages/[id]/schedule.post.ts; app/pages/admin/contenido.vue; scripts/content-publication-worker.ts; scripts/operational-alerts.ts; db/migrations/0029_scheduled_content_publication.sql; tests/unit/madrid-calendar.test.ts; tests/unit/shipping.test.ts; tests/unit/shipping-policy.test.ts; tests/unit/feature-flags.test.ts; tests/unit/beply.test.ts; tests/integration/calendar-boundaries.test.ts; tests/integration/pricing-schedules.test.ts; docs/testing/timezone-calendar.md; package.json; .github/workflows/ci.yml',
    'TST-034':
      'docs/testing/exploratory-testing.md; docs/testing/exploratory-runs/2026-08-13-tst034.json; scripts/lib/exploratory-evidence.ts; scripts/audit-exploratory-evidence.ts; scripts/operational-alerts.ts; tests/unit/exploratory-evidence.test.ts; tests/e2e/redsys-checkout.spec.ts; tests/e2e/accessibility.spec.ts; tests/browser-matrix/storefront-smoke.spec.ts; tests/integration/provider-recovery.test.ts; tests/integration/calendar-boundaries.test.ts; package.json; .github/workflows/ci.yml',
    'TST-035':
      'scripts/lib/flaky-policy.ts; scripts/audit-flaky-policy.ts; scripts/run-flake-monitor.ts; scripts/run-browser-flake-monitor.ts; scripts/audit-playwright-flake-report.ts; tests/unit/flaky-policy.test.ts; test-results/flaky-rate.json; test-results/flaky-browser-rate.json; playwright.config.ts; playwright.flake.config.ts; vitest.config.ts; docs/testing/flaky-tests.md; package.json; .github/workflows/ci.yml',
    'TST-036':
      'scripts/lib/ci-artifacts.ts; scripts/audit-ci-artifacts.ts; scripts/run-browser-flake-monitor.ts; tests/unit/ci-artifacts.test.ts; docs/testing/ci-artifacts.json; docs/testing/ci-reporting.md; playwright.config.ts; playwright.a11y.config.ts; playwright.matrix.config.ts; playwright.visual.config.ts; package.json; .github/workflows/ci.yml',
    'TST-037':
      'stryker.config.mjs; tsconfig.stryker.json; scripts/lib/mutation-evidence.ts; scripts/audit-mutation-evidence.ts; tests/unit/mutation-evidence.test.ts; tests/unit/catalog-publication.test.ts; docs/testing/mutation-policy.json; docs/testing/mutation-policy.md; docs/testing/strategy.md; package.json; .github/workflows/ci.yml',
    'TST-038':
      'tests/support/property.ts; tests/fixtures/property-seeds.json; tests/unit/property-helper.test.ts; tests/unit/money.test.ts; tests/unit/inventory.test.ts; tests/unit/states.test.ts; tests/unit/customer.test.ts; tests/unit/catalog-tabular.test.ts; server/services/catalog-tabular.ts; docs/testing/property-based.md; docs/testing/strategy.md; .github/workflows/ci.yml',
    'TST-039':
      'docs/testing/chaos-policy.json; docs/testing/chaos-recovery.md; scripts/lib/chaos-policy.ts; scripts/run-chaos.ts; scripts/operational-alerts.ts; scripts/outbox-worker.ts; scripts/invoice-worker.ts; scripts/refund-worker.ts; scripts/credit-note-worker.ts; tests/unit/chaos-policy.test.ts; tests/unit/worker-leases.test.ts; tests/integration/provider-recovery.test.ts; tests/integration/email-notifications.test.ts; tests/integration/commerce-transactions.test.ts; docs/operations/incident-runbooks.md; docs/testing/strategy.md; package.json; .github/workflows/chaos.yml',
    'TST-040':
      'docs/testing/operational-uat-policy.json; docs/testing/operational-uat.md; scripts/lib/operational-uat.ts; scripts/lib/operational-uat-inventory.ts; scripts/run-operational-uat-preflight.ts; scripts/operational-uat-inventory-evidence.ts; scripts/audit-operational-uat-policy.ts; scripts/audit-operational-uat.ts; server/api/health/live.get.ts; tests/unit/operational-uat.test.ts; tests/unit/operational-uat-inventory.test.ts; tests/e2e/health.spec.ts; docs/testing/strategy.md; package.json; .github/workflows/ci.yml; .github/workflows/staging-uat.yml',
    'TST-023':
      'docs/testing/manual-accessibility.md; scripts/audit-manual-accessibility-evidence.ts; scripts/lib/manual-accessibility-evidence.ts; tests/unit/manual-accessibility-evidence.test.ts; package.json',
    'MKT-002':
      'db/migrations/0026_newsletter_double_opt_in.sql; server/services/newsletter.ts; tests/integration/newsletter-double-opt-in.test.ts; db/d1/migrations/0024_newsletter_consent.sql; db/d1/migrations/0030_newsletter_confirmation_delivery.sql; workers/marketing/newsletter.ts; workers/marketing/newsletter-http.ts; workers/marketing/newsletter-delivery.ts; tests/unit/d1-newsletter-consent.test.ts; tests/unit/d1-newsletter-delivery.test.ts',
    'MKT-003':
      'server/services/newsletter-email.ts; server/api/newsletter/unsubscribe.post.ts; app/pages/newsletter/baja.vue; scripts/outbox-worker.ts; db/d1/migrations/0024_newsletter_consent.sql; workers/marketing/newsletter.ts; workers/marketing/newsletter-http.ts; workers/marketing/newsletter-delivery.ts; tests/unit/d1-newsletter-consent.test.ts; tests/unit/d1-newsletter-delivery.test.ts',
    'PER-003': 'app/plugins/rum.client.ts; server/api/analytics/events.post.ts',
    'PER-013': 'app/plugins/rum.client.ts; server/api/analytics/events.post.ts; db/migrations/0019_rum_measurement.sql'
  }
  const domainEvidence: Record<string, string> = {
    CAT: 'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts',
    PRI: 'server/domain/money.ts; tests/unit/money.test.ts',
    SEA: 'server/api/search.get.ts; server/api/products.get.ts',
    PDP: 'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue',
    CHK: 'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue',
    PAY: 'server/integrations/payment-provider.ts; server/services/orders.ts',
    BEP: 'server/integrations/beply.ts; scripts/invoice-worker.ts',
    ORD: 'server/services/orders.ts; db/migrations/0001_platform_foundation.sql',
    INV: 'server/domain/inventory.ts; server/services/orders.ts',
    SHP: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    CUS: 'server/services/customer.ts; server/api/auth/',
    ADM: 'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/',
    MED: 'server/api/admin/media.post.ts; server/routes/media/[id].get.ts',
    SEO: 'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts',
    DAT: 'db/migrations/; scripts/db-migrate.ts',
    MKT: 'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts',
    COM: 'scripts/outbox-worker.ts; server/integrations/email-provider.ts',
    SEC: 'server/middleware/security.ts; server/utils/auth-session.ts',
    INT: 'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts',
    TST: 'tests/; vitest.config.ts; playwright.config.ts',
    CIC: '.github/workflows/ci.yml; Dockerfile; package-lock.json',
    OBS: 'server/api/health/; scripts/operational-alerts.ts; docs/operations/',
    UI: 'app/pages/admin/; app/pages/cuenta/; app/pages/pedido/; app/components/'
  }
  const continuousEvidence: Record<string, string> = {
    'CUS-001': 'app/pages/cuenta/datos.vue; tests/components/account-profile-read-state.test.ts',
    'CUS-005': 'app/pages/cuenta/datos.vue; tests/components/account-profile-read-state.test.ts',
    'SEA-006': 'workers/catalog/products.ts; tests/unit/d1-product-facets.test.ts; scripts/audit-cloudflare-shop.ts',
    'ADM-008':
      'db/d1/migrations/0038_catalog_draft_authoring.sql; shared/catalog-draft-authoring.ts; shared/catalog-draft-authoring-options.ts; workers/catalog/admin-catalog-authoring.ts; workers/catalog/admin-catalog-authoring-http.ts; workers/catalog/admin-catalog-references.ts; app/components/DraftProductCreate.vue; app/components/DraftProductVariantsEditor.vue; app/components/DraftVariantFields.vue; app/pages/admin/productos/index.vue; app/pages/admin/productos/[id].vue; tests/unit/d1-catalog-draft-authoring.test.ts; tests/unit/d1-catalog-draft-authoring-http.test.ts; tests/components/catalog-draft-authoring.test.ts; tests/components/catalog-draft-authoring-page.test.ts; scripts/audit-cloudflare-shop.ts',
    'CAT-006':
      'workers/catalog/publication-validity.ts; workers/media/evidence-sql.ts; workers/media/public-catalog.ts; workers/media/public-delivery.ts; workers/catalog/products.ts; workers/catalog/product-detail.ts; workers/catalog/search.ts; workers/catalog/seo-http.ts; workers/catalog/cart.ts; workers/catalog/checkout.ts; workers/catalog/payments.ts; workers/catalog/storefront-shipping.ts; workers/runtime/d1-errors.ts; tests/unit/d1-publication-validity.test.ts; tests/unit/d1-cart.test.ts; tests/unit/d1-checkout.test.ts; tests/unit/d1-payments.test.ts; tests/unit/d1-storefront-shipping.test.ts; tests/unit/d1-errors.test.ts',
    'UI-010': 'app/pages/cuenta/pedidos.vue; tests/components/account-orders-read-state.test.ts',
    'CUS-013': 'tests/components/account-favorites-read-state.test.ts'
  }
  const priceCommands =
    'db/d1/migrations/0039_catalog_price_commands.sql; shared/catalog-price-commands.ts; workers/catalog/admin-price-commands.ts; workers/catalog/admin-pricing-http.ts; app/components/GovernedPriceEditor.vue; tests/unit/d1-admin-price-commands.test.ts; tests/unit/d1-admin-price-commands-http.test.ts; tests/components/governed-price-editor.test.ts; scripts/audit-cloudflare-shop.ts'
  const categoryCommands =
    'db/d1/migrations/0040_catalog_category_commands.sql; shared/catalog-category-commands.ts; workers/catalog/admin-categories.ts; workers/catalog/admin-categories-http.ts; workers/catalog/category-redirects.ts; app/components/CategoryCrudEditor.vue; app/pages/admin/categorias.vue; tests/unit/d1-admin-categories.test.ts; tests/unit/d1-admin-categories-http.test.ts; tests/unit/d1-category-redirects.test.ts; tests/components/catalog-category-crud.test.ts; scripts/audit-cloudflare-shop.ts'
  const inventoryCommands =
    'db/d1/migrations/0041_admin_inventory_commands.sql; shared/inventory-commands.ts; workers/catalog/admin-inventory.ts; workers/catalog/admin-inventory-http.ts; workers/inventory-coordinator.ts; app/components/InventoryOperations.vue; app/pages/admin/inventario.vue; tests/unit/d1-admin-inventory.test.ts; tests/unit/d1-admin-inventory-http.test.ts; tests/components/admin-inventory.test.ts; tests/components/admin-inventory-page.test.ts; tests/unit/d1-inventory-coordinator.test.ts; scripts/audit-cloudflare-shop.ts'
  const executionEvidence: Record<string, string> = {
    'ADM-008': `${priceCommands}; ${categoryCommands}`,
    'CAT-008': categoryCommands,
    'PRI-006': priceCommands,
    'PRI-008': priceCommands,
    'PRI-011': priceCommands,
    'INV-002': inventoryCommands,
    'INV-007': inventoryCommands,
    'INV-010': `${inventoryCommands}; db/d1/migrations/0077_inventory_count_imports.sql; shared/inventory-count-import.ts; workers/catalog/inventory-count-import.ts; workers/catalog/inventory-count-import-http.ts; workers/runtime/inventory-count-import-coordinator.ts; workers/canary.ts; app/components/InventoryCountImportPanel.vue; tests/unit/d1-inventory-count-import.test.ts; tests/unit/d1-inventory-count-import-http.test.ts; tests/unit/d1-inventory-count-import-runtime.test.ts; tests/unit/d1-inventory-count-import-native.test.ts; scripts/lib/audit-native-inventory-count-import.ts; tests/unit/audit-native-inventory-count-import.test.ts; scripts/lib/audit-native-inventory-count-import-browser.ts; tests/unit/audit-native-inventory-count-import-browser.test.ts; tests/components/inventory-count-import.test.ts`
  }
  const fiscalIssuance =
    'db/d1/migrations/0042_fiscal_issuance.sql; shared/fiscal-issuance.ts; workers/fiscal/issuance.ts; workers/fiscal/access.ts; workers/fiscal/http.ts; workers/fiscal/d1-boundary.ts; workers/fiscal/local-provider.ts; workers/fiscal/beply-provider.ts; workers/runtime/fiscal-pdf-storage.ts; tests/unit/d1-fiscal-issuance.test.ts; tests/unit/fiscal-pdf-storage.test.ts; scripts/lib/audit-native-fiscal.ts'
  const fulfillment =
    'db/d1/migrations/0043_order_fulfillment.sql; shared/order-fulfillment.ts; workers/fulfillment/admin.ts; workers/fulfillment/admin-http.ts; app/components/OrderFulfillmentPanel.vue; app/components/OrderFulfillmentSection.vue; tests/unit/d1-fulfillment.test.ts; tests/unit/d1-fulfillment-http.test.ts; tests/components/order-fulfillment-panel.test.ts; tests/components/order-fulfillment-section.test.ts; scripts/lib/audit-native-fulfillment.ts; scripts/lib/audit-native-checkout-payment.ts'
  const cmsDrafts =
    'db/d1/migrations/0044_cms_draft_commands.sql; shared/cms-commands.ts; workers/cms/drafts.ts; workers/cms/http.ts; app/components/CmsDraftEditor.vue; tests/unit/d1-cms-drafts.test.ts; tests/unit/d1-cms-http.test.ts; tests/unit/d1-cms-adversarial.test.ts; tests/components/cms-draft-editor.test.ts; scripts/lib/audit-native-cms-drafts.ts'
  const nativeOperationsEvidence: Record<string, string> = {
    'BEP-003': fiscalIssuance,
    'BEP-004': `${fiscalIssuance}; db/d1/migrations/0009_fiscal_outbox.sql; db/d1/migrations/0010_fiscal_evaluation_inbox.sql; db/d1/migrations/0011_fiscal_delivery_reconciliation.sql; workers/catalog/payments.ts; workers/catalog/fiscal-outbox.ts; workers/canary.ts; tests/unit/d1-payments.test.ts; tests/unit/cloudflare-canary.test.ts; scripts/audit-d1-payments.ts`,
    'BEP-006': fiscalIssuance,
    'BEP-007': fiscalIssuance,
    'BEP-008': fiscalIssuance,
    'ORD-001': fulfillment,
    'ORD-004': fulfillment,
    'INV-006': fulfillment,
    'ADM-009': cmsDrafts,
    'ADM-011': cmsDrafts
  }
  const cmsPublication =
    'db/d1/migrations/0045_cms_publication.sql; shared/cms-publication.ts; workers/cms/publication.ts; workers/cms/publication-gate.ts; workers/cms/preview.ts; workers/cms/schedules.ts; workers/cms/public-http.ts; workers/cms/media-delivery.ts; workers/catalog/seo-http.ts; app/components/CmsPublicationControls.vue; app/pages/contenido/[slug].vue; tests/unit/d1-cms-publication.test.ts; tests/unit/d1-cms-publication-schema.test.ts; tests/unit/d1-cms-publication-http.test.ts; tests/unit/d1-cms-publication-races.test.ts; tests/unit/d1-cms-publication-media.test.ts; tests/unit/d1-cms-preview-schedule.test.ts; tests/unit/d1-cms-seo-http.test.ts; tests/components/cms-publication-controls.test.ts; scripts/lib/audit-native-cms-publication.ts'
  const returns =
    'db/d1/migrations/0046_order_returns.sql; shared/order-returns.ts; workers/returns/operations.ts; workers/returns/admin-http.ts; workers/returns/customer-http.ts; app/components/OrderReturnPanel.vue; app/components/OrderReturnSection.vue; app/components/CustomerReturnPanel.vue; app/pages/admin/devoluciones.vue; app/pages/devoluciones.vue; tests/unit/d1-returns.test.ts; tests/unit/d1-returns-http.test.ts; tests/unit/order-returns-contract.test.ts; tests/unit/native-returns-audit.test.ts; tests/components/order-return-panels.test.ts; tests/components/order-return-sections.test.ts; scripts/lib/audit-native-returns.ts'
  const fiscalRuntimeEmail =
    'db/d1/migrations/0047_fiscal_runtime_email_manifest.sql; workers/fiscal/runtime-dispatch.ts; workers/runtime/operations-config.ts; workers/canary.ts; workers/communications/invoice-issued-email.ts; workers/communications/transactional-email-delivery.ts; shared/fiscal-view.ts; app/components/OrderFiscalSection.vue; tests/unit/d1-fiscal-runtime.test.ts; tests/unit/operations-config.test.ts; tests/unit/fiscal-view.test.ts; tests/unit/cloudflare-canary.test.ts; tests/components/order-fiscal-section.test.ts; scripts/lib/audit-native-fiscal-runtime-email.ts'
  const phaseTwoEvidence: Record<string, string> = {
    'ADM-009': cmsPublication,
    'ADM-010': `${cmsPublication}; shared/analytics-privacy.ts; app/composables/useAnalytics.ts; app/plugins/analytics.client.ts; tests/components/analytics-preview-privacy.test.ts`,
    'ADM-011': cmsPublication,
    'ADM-013': `${cmsPublication}; shared/cms-calendar.ts; workers/cms/calendar.ts; app/components/CmsEditorialCalendar.vue; app/components/CmsDraftEditor.vue; tests/unit/d1-cms-calendar.test.ts; tests/components/cms-editorial-calendar.test.ts; tests/components/cms-draft-editor.test.ts`,
    'ADM-016': cmsPublication,
    'SEO-004': cmsPublication,
    'BEP-004': fiscalRuntimeEmail,
    'BEP-006': fiscalRuntimeEmail,
    'BEP-007': fiscalRuntimeEmail,
    'BEP-008': fiscalRuntimeEmail,
    'COM-004': fiscalRuntimeEmail,
    'COM-006': fiscalRuntimeEmail,
    'COM-008': fiscalRuntimeEmail,
    'ORD-001': returns,
    'ORD-004': returns,
    'ORD-007': returns,
    'ORD-016': returns
  }
  const customerOperationsRuntime =
    'workers/runtime/customer-operations-config.ts; workers/runtime/customer-operations-http.ts; workers/runtime/customer-operations-dispatch.ts; workers/canary.ts; tests/unit/customer-operations-config.test.ts; tests/unit/customer-operations-http.test.ts; tests/unit/customer-financial-authority-audit.test.ts; scripts/audit-cloudflare-shop.ts'
  const financialResolution =
    'db/d1/migrations/0048_order_refunds_credit_notes.sql; shared/order-refunds.ts; shared/fiscal-credit.ts; workers/refunds/operations.ts; workers/refunds/authority.ts; workers/refunds/source.ts; workers/refunds/http.ts; workers/refunds/redsys-provider.ts; workers/fiscal/credit-notes.ts; workers/fiscal/beply-provider.ts; app/components/refunds/OrderRefundPanel.vue; app/components/refunds/AdminRefundActions.vue; app/components/refunds/financial-ui.ts; tests/unit/d1-refunds-credit.test.ts; tests/unit/worker-redsys-refunds.test.ts; tests/unit/order-refunds-ui.test.ts; tests/components/order-refunds.test.ts; scripts/lib/audit-native-refunds-credit.ts'
  const supportOperations =
    'db/d1/migrations/0049_support_operations.sql; shared/support-operations.ts; workers/support/operations.ts; workers/support/context.ts; workers/support/attachments.ts; workers/support/contact-http.ts; workers/support/admin-http.ts; workers/support/customer-http.ts; workers/runtime/support-adapters.ts; shared/http-security.ts; shared/support-navigation.ts; workers/runtime/shop-ingress.ts; app/middleware/support-contact-document.ts; app/components/SupportChallengeWidget.vue; app/components/SupportContactSection.vue; app/components/SupportContactPanel.vue; app/components/AdminSupportPanel.vue; app/components/CustomerSupportPanel.vue; tests/unit/d1-support-operations.test.ts; tests/unit/d1-support-http.test.ts; tests/unit/support-runtime-adapters.test.ts; tests/unit/support-browser-security-audit.test.ts; tests/unit/support-contact-navigation.test.ts; tests/components/support-challenge-widget.test.ts; tests/components/support-sections.test.ts; tests/components/support-panels.test.ts; scripts/lib/audit-native-support.ts'
  const newsletterEditorial =
    'db/d1/migrations/0050_newsletter_editorial.sql; db/d1/migrations/0051_newsletter_local_validation.sql; shared/newsletter-editorial.ts; workers/marketing/newsletter-preferences.ts; workers/marketing/newsletter-editorial-commands.ts; workers/marketing/newsletter-editorial-http.ts; workers/marketing/newsletter-campaigns.ts; workers/marketing/newsletter-campaign-render.ts; workers/marketing/newsletter-campaign-delivery.ts; workers/marketing/newsletter-campaign-feedback.ts; workers/marketing/local-newsletter-sender.ts; app/pages/admin/newsletter.vue; app/pages/newsletter/preferencias.vue; app/components/NewsletterCampaignEditor.vue; app/components/NewsletterPreferencesPanel.vue; tests/unit/d1-newsletter-editorial.test.ts; tests/unit/d1-newsletter-editorial-adversarial.test.ts; tests/unit/local-newsletter-sender.test.ts; tests/unit/customer-operations-authority-audit.test.ts; tests/components/newsletter-editorial.test.ts; tests/components/newsletter-preference-access.test.ts; scripts/lib/audit-native-newsletter-editorial.ts'
  const customerOperationEmails =
    'workers/communications/refund-credit-email.ts; workers/support/email.ts; workers/communications/transactional-email-delivery.ts; workers/communications/README.md; tests/unit/d1-refunds-credit.test.ts; tests/unit/d1-support-email.test.ts'
  const contextualSupport =
    'app/pages/categoria/[slug].vue; app/pages/producto/[slug].vue; app/components/support/SupportTicketFacts.vue; app/components/SupportContactPanel.vue; tests/components/catalog-support-context.test.ts; tests/components/support-sections.test.ts; tests/components/typed-public-catalog-pages.test.ts'
  const phaseThreeEvidence: Record<string, string> = {
    'PAY-008': `${financialResolution}; ${customerOperationsRuntime}`,
    'BEP-009': `${financialResolution}; ${customerOperationsRuntime}`,
    'ORD-006': `${financialResolution}; ${customerOperationsRuntime}`,
    'ORD-007': `${financialResolution}; ${customerOperationsRuntime}`,
    'SUP-002': `${supportOperations}; ${customerOperationsRuntime}; ${contextualSupport}`,
    'SUP-003': `${supportOperations}; ${customerOperationsRuntime}; ${contextualSupport}`,
    'SUP-004': `${supportOperations}; ${customerOperationsRuntime}`,
    'SUP-008': `${supportOperations}; ${customerOperationsRuntime}`,
    'SUP-009': `${supportOperations}; ${customerOperationsRuntime}`,
    'SUP-013': `${supportOperations}; ${customerOperationsRuntime}`,
    'MKT-002': `${newsletterEditorial}; ${customerOperationsRuntime}`,
    'MKT-003': `${newsletterEditorial}; ${customerOperationsRuntime}`,
    'MKT-028': `${newsletterEditorial}; ${customerOperationsRuntime}`,
    'COM-004': `${customerOperationEmails}; ${customerOperationsRuntime}`,
    'COM-006': `${customerOperationEmails}; ${customerOperationsRuntime}`,
    'COM-008': `${customerOperationEmails}; ${customerOperationsRuntime}`,
    'COM-012': `${newsletterEditorial}; ${customerOperationsRuntime}`,
    'COM-017': `${newsletterEditorial}; ${customerOperationsRuntime}`
  }
  const analyticsAuthorityEvidence =
    'db/d1/migrations/0052_analytics_measurement.sql; shared/analytics-measurement.ts; workers/analytics/authority.ts; workers/analytics/commerce-projection.ts; workers/analytics/read-model.ts; workers/analytics/reconciliation.ts; workers/analytics/retention.ts; workers/catalog/payments.ts; workers/runtime/analytics-config.ts; workers/runtime/analytics-http.ts; workers/runtime/analytics-dispatch.ts; tests/unit/d1-analytics-core.test.ts; tests/unit/d1-analytics-reconciliation.test.ts; tests/unit/d1-analytics-authority-race.test.ts; tests/unit/d1-payments.test.ts; tests/unit/analytics-runtime-config.test.ts; scripts/lib/audit-native-analytics.ts; scripts/audit-cloudflare-shop.ts'
  const analyticsClientEvidence =
    'shared/analytics-privacy.ts; shared/analytics-client.ts; workers/analytics/collector.ts; workers/analytics/http.ts; app/composables/useAnalytics.ts; tests/unit/analytics-privacy.test.ts; tests/unit/analytics-client.test.ts; tests/unit/d1-analytics-http.test.ts; tests/components/analytics-preview-privacy.test.ts'
  const analyticsDashboardEvidence =
    'app/pages/admin/analitica.vue; app/components/AnalyticsOperationsPanel.vue; app/components/analytics/operations-ui.ts; app/layouts/admin.vue; tests/unit/analytics-operations-ui.test.ts; tests/components/analytics-operations.test.ts; scripts/lib/audit-native-analytics-browser.ts'
  const phaseFourEvidence: Record<string, string> = {
    'DAT-001': `${analyticsAuthorityEvidence}; ${analyticsClientEvidence}`,
    'DAT-002': `${analyticsAuthorityEvidence}; ${analyticsClientEvidence}`,
    'DAT-003': analyticsClientEvidence,
    'DAT-004': `${analyticsAuthorityEvidence}; ${analyticsClientEvidence}`,
    'DAT-005': analyticsAuthorityEvidence,
    'DAT-006': `${analyticsAuthorityEvidence}; ${analyticsDashboardEvidence}`,
    'DAT-007': `${analyticsAuthorityEvidence}; ${analyticsClientEvidence}`,
    'DAT-008': `${analyticsAuthorityEvidence}; ${analyticsDashboardEvidence}`,
    'DAT-010': analyticsClientEvidence,
    'DAT-012': analyticsClientEvidence,
    'DAT-013': `${analyticsAuthorityEvidence}; ${analyticsClientEvidence}`
  }
  const editorialImportEvidence =
    'db/d1/migrations/0053_catalog_editorial_import.sql; shared/catalog-editorial-csv.ts; shared/catalog-editorial-import.ts; shared/catalog-tabular-core.ts; workers/catalog/editorial-import.ts; workers/catalog/editorial-import-http.ts; app/components/CatalogEditorialImport.vue; app/pages/admin/productos/index.vue; tests/unit/catalog-editorial-csv.test.ts; tests/unit/catalog-tabular-core.test.ts; tests/unit/d1-editorial-import.test.ts; tests/unit/d1-editorial-import-adversarial.test.ts; tests/components/catalog-editorial-import.test.ts; scripts/lib/audit-native-editorial-import.ts; scripts/audit-cloudflare-shop.ts'
  const catalogExportEvidence =
    'shared/catalog-export.ts; workers/catalog/catalog-export.ts; workers/catalog/catalog-export-http.ts; app/utils/catalog-export-xlsx.client.ts; app/components/CatalogSnapshotExport.vue; app/pages/admin/productos/index.vue; tests/unit/catalog-export-contract.test.ts; tests/unit/d1-catalog-export-http.test.ts; tests/unit/d1-catalog-export-adversarial.test.ts; tests/unit/catalog-export-xlsx.test.ts; tests/components/catalog-snapshot-export.test.ts; scripts/lib/audit-native-catalog-export.ts; scripts/audit-cloudflare-shop.ts; scripts/lib/worker-bundle-policy.ts; tests/unit/worker-bundle-policy.test.ts'
  const catalogFilePreparationEvidence =
    'shared/catalog-xlsx-archive.ts; app/utils/catalog-import-file.client.ts; app/components/CatalogFilePreflight.vue; tests/unit/catalog-import-file.test.ts; tests/components/catalog-file-preflight.test.ts; tests/support/catalog-tabular-fixture.ts; scripts/lib/audit-native-catalog-export.ts'
  const catalogNativeImportEvidence =
    'db/d1/migrations/0054_catalog_native_import.sql; db/d1/migrations/0055_catalog_import_jobs.sql; db/d1/migrations/0056_catalog_color_pattern.sql; db/d1/migrations/0057_catalog_import_job_commands.sql; shared/catalog-tabular-core.ts; shared/catalog-native-import.ts; shared/catalog-import-job.ts; shared/catalog-import-job-review.ts; shared/catalog-import-job-commands.ts; workers/catalog/native-import.ts; workers/catalog/native-import-http.ts; workers/catalog/import-job.ts; workers/catalog/import-job-http.ts; workers/catalog/import-job-commands.ts; app/utils/catalog-import-file.client.ts; app/components/CatalogFilePreflight.vue; app/components/CatalogNativeImport.vue; app/components/CatalogImportJob.vue; app/components/CatalogImportJobReview.vue; app/components/CatalogImportJobCommands.vue; app/pages/admin/productos/index.vue; tests/unit/catalog-native-import-contract.test.ts; tests/unit/d1-native-catalog-import.test.ts; tests/unit/d1-native-catalog-import-http.test.ts; tests/unit/d1-catalog-color-migration.test.ts; tests/unit/catalog-import-job.test.ts; tests/unit/catalog-import-job-review.test.ts; tests/unit/d1-catalog-import-job.test.ts; tests/unit/d1-catalog-import-job-http.test.ts; tests/unit/d1-catalog-import-job-review.test.ts; tests/unit/catalog-import-job-command-contract.test.ts; tests/unit/d1-catalog-import-job-command-schema.test.ts; tests/unit/d1-catalog-import-job-commands.test.ts; tests/unit/d1-catalog-import-job-commands-http.test.ts; tests/unit/native-catalog-import-audit.test.ts; tests/unit/catalog-import-file.test.ts; tests/unit/catalog-file-scale.test.ts; tests/components/catalog-file-preflight.test.ts; tests/components/catalog-native-import.test.ts; tests/components/catalog-import-job.test.ts; tests/components/catalog-import-job-review.test.ts; tests/components/catalog-import-job-commands.test.ts; scripts/lib/audit-native-catalog-import.ts; scripts/lib/audit-native-catalog-import-browser.ts; scripts/audit-native-catalog-import-scale.ts; scripts/audit-catalog-file-scale.ts; scripts/lib/catalog-file-scale.ts; server/services/catalog-tabular.ts; scripts/audit-cloudflare-shop.ts'
  const typedAttributeEvidence =
    'db/d1/migrations/0058_catalog_typed_attributes.sql; db/d1/migrations/0059_catalog_typed_attribute_values.sql; shared/catalog-typed-attributes.ts; shared/catalog-typed-attribute-views.ts; shared/catalog-typed-attribute-filters.ts; shared/types/catalog.ts; workers/catalog/typed-attribute-definitions.ts; workers/catalog/typed-attribute-values.ts; workers/catalog/typed-attribute-http.ts; workers/catalog/typed-attribute-sql.ts; workers/catalog/typed-attribute-integrity.ts; workers/catalog/typed-attribute-facets.ts; workers/catalog/products.ts; workers/catalog/product-detail.ts; workers/catalog/catalog-publication-readiness.ts; workers/catalog/admin-catalog-authoring.ts; workers/catalog/admin-catalog-mutations.ts; workers/canary.ts; shared/catalog-tabular-core.ts; workers/catalog/native-import.ts; workers/catalog/import-job.ts; workers/catalog/import-job-commands.ts; server/services/catalog-tabular.ts; app/components/CategoryAttributeDefinitionsEditor.vue; app/components/TypedProductAttributesEditor.vue; app/components/ProductFilters.vue; app/utils/catalog-typed-filters.ts; app/pages/admin/categorias.vue; app/pages/admin/productos/[id].vue; app/pages/producto/[slug].vue; tests/unit/catalog-typed-attributes.test.ts; tests/unit/catalog-typed-attribute-views.test.ts; tests/unit/catalog-typed-attribute-filters.test.ts; tests/unit/catalog-typed-filters-ui.test.ts; tests/unit/d1-typed-attribute-definitions.test.ts; tests/unit/d1-typed-attribute-values.test.ts; tests/unit/d1-typed-attributes-http.test.ts; tests/unit/d1-typed-attribute-integrity.test.ts; tests/unit/d1-typed-attribute-facets.test.ts; tests/unit/d1-typed-attribute-detail.test.ts; tests/unit/d1-typed-catalog-intake.test.ts; tests/unit/catalog-tabular-typed-attributes.test.ts; tests/components/category-attribute-definitions-editor.test.ts; tests/components/typed-product-attributes-editor.test.ts; tests/components/typed-catalog-filters.test.ts; tests/components/typed-public-catalog-pages.test.ts; scripts/lib/audit-native-typed-attributes.ts; scripts/lib/audit-native-typed-intake.ts; scripts/audit-cloudflare-shop.ts; docs/production/catalog-typed-attributes-plan.md'
  const promotionalEvidence =
    'shared/promotional-content.ts; shared/cms-safe-links.ts; workers/cms/promotional-content.ts; workers/cms/promotional-content-http.ts; app/components/CmsDraftEditor.vue; app/components/ContentPreviewPanel.vue; app/components/PromotionalBlocks.vue; app/pages/index.vue; app/pages/catalogo.vue; app/pages/categoria/[slug].vue; app/pages/producto/[slug].vue; shared/promotional-analytics.ts; shared/analytics-client.ts; shared/analytics-measurement.ts; db/d1/migrations/0081_promotional_analytics.sql; workers/analytics/collector.ts; workers/analytics/read-model.ts; workers/analytics/retention.ts; tests/unit/d1-promotional-content.test.ts; tests/unit/d1-promotional-content-http.test.ts; tests/unit/promotional-analytics-client.test.ts; tests/unit/d1-promotional-analytics-storage.test.ts; tests/components/promotional-blocks.test.ts; tests/unit/promotional-communications-runtime.test.ts'
  const communicationHistoryEvidence =
    'db/d1/migrations/0080_communication_history_commands.sql; shared/communication-history.ts; workers/communications/history.ts; workers/communications/history-http.ts; workers/runtime/customer-operations-http.ts; app/components/AdminCommunicationHistoryPanel.vue; app/pages/admin/operaciones.vue; tests/unit/d1-communication-history.test.ts; tests/unit/d1-communication-history-http.test.ts; tests/unit/d1-communication-history-native.test.ts; tests/components/communication-history.test.ts; tests/components/admin-operations-capabilities.test.ts; tests/unit/promotional-communications-runtime.test.ts'
  const references = [
    id === 'UI-005'
      ? 'db/d1/migrations/0085_admin_order_views.sql; db/d1/migrations/0086_admin_order_bulk.sql; shared/admin-order-views.ts; shared/admin-order-bulk.ts; workers/catalog/admin-order-views.ts; workers/catalog/admin-order-views-http.ts; workers/catalog/admin-order-cursor.ts; workers/catalog/admin-orders-http.ts; workers/fulfillment/bulk.ts; workers/fulfillment/bulk-http.ts; workers/fulfillment/bulk-runtime.ts; workers/fulfillment/admin.ts; workers/canary.ts; app/components/AdminOrderViews.vue; app/components/AdminOrderWorkbench.vue; app/components/AdminOrderExport.vue; app/components/AdminOrderBatchPreparation.vue; tests/unit/d1-admin-order-views.test.ts; tests/unit/d1-admin-order-views-http.test.ts; tests/unit/d1-admin-order-views-runtime.test.ts; tests/unit/d1-admin-order-views-native.test.ts; tests/unit/d1-admin-order-cursor.test.ts; tests/unit/d1-admin-order-bulk.test.ts; tests/unit/d1-admin-order-bulk-http.test.ts; tests/unit/d1-admin-order-bulk-runtime.test.ts; tests/unit/d1-admin-order-bulk-ingress.test.ts; tests/unit/d1-admin-order-bulk-native.test.ts; tests/components/admin-order-views.test.ts; tests/components/admin-order-workbench.test.ts; tests/components/admin-order-export.test.ts; tests/components/admin-order-batch-preparation.test.ts'
      : undefined,
    ['PDP-004', 'MED-010'].includes(id)
      ? 'app/components/ProductImageLightbox.vue; app/pages/producto/[slug].vue; app/utils/publishedMedia.ts; tests/components/product-image-lightbox.test.ts; tests/components/governed-image-consumers.test.ts; tests/components/published-product-image.test.ts'
      : undefined,
    id === 'ADM-005'
      ? 'db/d1/migrations/0084_admin_audit.sql; shared/admin-audit.ts; workers/auth/admin-audit.ts; workers/auth/admin-audit-sources.ts; workers/auth/admin-audit-http.ts; workers/auth/admin-audit-network.ts; workers/catalog/order-cancellation.ts; workers/catalog/order-cancellation-http.ts; workers/canary.ts; shared/admin-navigation.ts; app/components/AdminAuditPanel.vue; app/pages/admin/auditoria.vue; tests/unit/admin-audit-network.test.ts; tests/unit/d1-admin-audit.test.ts; tests/unit/d1-admin-audit-integrity.test.ts; tests/unit/d1-admin-audit-boundaries.test.ts; tests/unit/d1-admin-audit-cancellation.test.ts; tests/unit/d1-admin-audit-http.test.ts; tests/unit/d1-admin-audit-runtime.test.ts; tests/unit/d1-admin-audit-native.test.ts; tests/components/admin-audit-panel.test.ts; tests/components/admin-audit-page.test.ts'
      : undefined,
    id === 'ADM-004'
      ? 'db/d1/migrations/0082_admin_invitations.sql; db/d1/migrations/0083_admin_bootstrap.sql; shared/admin-invitations.ts; workers/auth/admin-invitations.ts; workers/auth/admin-invitations-http.ts; workers/canary.ts; scripts/lib/d1-admin-bootstrap.ts; scripts/provision-d1-admin.ts; app/components/AdminInvitationsPanel.vue; app/components/AdminInvitationAcceptance.vue; app/pages/admin/equipo.vue; app/pages/cuenta/invitacion.vue; shared/admin-navigation.ts; tests/unit/d1-admin-bootstrap.test.ts; tests/unit/d1-admin-invitations.test.ts; tests/unit/d1-admin-invitations-http.test.ts; tests/unit/d1-admin-invitations-runtime.test.ts; tests/unit/d1-admin-invitations-native.test.ts; tests/components/admin-invitations-panel.test.ts; tests/components/admin-invitation-acceptance.test.ts; tests/components/admin-team-page.test.ts'
      : undefined,
    ['SEA-002', 'SEA-010'].includes(id)
      ? 'app/pages/buscar.vue; app/composables/useInfiniteProducts.ts; tests/components/search-read-state.test.ts; tests/components/typed-public-catalog-pages.test.ts'
      : undefined,
    id === 'SEO-005'
      ? 'app/app.vue; app/utils/seo.ts; tests/components/search-seo.test.ts; tests/unit/seo.test.ts'
      : undefined,
    ['MKT-004', 'MKT-006'].includes(id) ? promotionalEvidence : undefined,
    id === 'COM-011' ? communicationHistoryEvidence : undefined,
    evidence[id] ?? domainEvidence[id.split('-')[0]!] ?? '',
    continuousEvidence[id],
    executionEvidence[id],
    ['CUS-006', 'CUS-007'].includes(id) ? customerTaxValidationImplementationRefs : undefined,
    id === 'CUS-012'
      ? 'db/d1/migrations/0071_account_security_notices.sql; tests/unit/d1-account-security-native.test.ts; scripts/lib/audit-native-account-settings-browser.ts; tests/unit/native-account-settings-browser.test.ts'
      : undefined,
    nativeOperationsEvidence[id],
    phaseTwoEvidence[id],
    phaseThreeEvidence[id],
    phaseFourEvidence[id],
    ['ORD-004', 'ORD-005'].includes(id)
      ? 'shared/order-cancellation.ts; workers/catalog/order-cancellation.ts; workers/catalog/order-cancellation-http.ts; workers/catalog/payments.ts; workers/catalog/inventory.ts; workers/canary.ts; app/components/OrderCancellationPanel.vue; app/components/AccountOrderRow.vue; app/pages/cuenta/pedidos.vue; app/pages/admin/pedidos/[id].vue; tests/unit/d1-order-cancellation.test.ts; tests/unit/d1-order-cancellation-http.test.ts; tests/unit/d1-order-cancellation-native.test.ts; tests/unit/d1-order-cancellation-entrypoints.test.ts; tests/components/order-cancellation-panel.test.ts; tests/components/order-cancellation-mounting.test.ts; scripts/lib/audit-native-order-cancellation.ts; tests/unit/audit-native-order-cancellation.test.ts'
      : undefined,
    id === 'ORD-015'
      ? 'workers/catalog/admin-orders.ts; workers/catalog/admin-orders-http.ts; shared/order-export.ts; workers/catalog/order-export.ts; workers/catalog/order-export-http.ts; workers/canary.ts; app/components/AdminOrderWorkbench.vue; app/components/AdminOrderExport.vue; app/pages/admin/pedidos/index.vue; tests/unit/d1-admin-orders.test.ts; tests/unit/d1-admin-orders-origin.test.ts; tests/unit/d1-order-export.test.ts; tests/unit/d1-order-export-http.test.ts; tests/unit/d1-order-export-native.test.ts; tests/unit/d1-order-export-entrypoints.test.ts; tests/components/admin-order-workbench.test.ts; tests/components/admin-order-export.test.ts; scripts/lib/audit-native-order-export.ts; tests/unit/audit-native-order-export.test.ts'
      : undefined,
    id === 'ORD-010'
      ? 'db/d1/migrations/0063_order_annotations.sql; shared/order-annotations.ts; workers/catalog/order-annotations.ts; workers/catalog/order-annotations-http.ts; workers/canary.ts; app/components/OrderAnnotationsPanel.vue; app/pages/admin/pedidos/[id].vue; tests/unit/d1-order-annotations.test.ts; tests/unit/d1-order-annotations-http.test.ts; tests/unit/d1-order-annotations-native.test.ts; tests/unit/d1-order-annotations-entrypoints.test.ts; tests/components/order-annotations-panel.test.ts; tests/components/order-cancellation-mounting.test.ts; scripts/lib/audit-native-order-annotations.ts; tests/unit/audit-native-order-annotations.test.ts; scripts/lib/audit-native-order-operations-browser.ts; tests/unit/audit-native-order-operations-browser.test.ts'
      : undefined,
    id === 'ORD-012'
      ? 'workers/communications/order-operations-email.ts; workers/communications/order-return-email.ts; workers/communications/order-payment-email.ts; workers/communications/transactional-email-renderers.ts; workers/communications/transactional-email-delivery.ts; workers/fulfillment/admin.ts; workers/catalog/order-cancellation.ts; workers/catalog/payments.ts; workers/returns/operations.ts; workers/runtime/customer-operations-config.ts; workers/canary.ts; tests/unit/d1-order-operations-email.test.ts; tests/unit/d1-order-return-email.test.ts; tests/unit/d1-order-payment-email.test.ts; tests/unit/customer-operations-config.test.ts; tests/unit/d1-transactional-email-delivery.test.ts; tests/unit/d1-order-cancellation-native.test.ts; scripts/lib/audit-native-order-emails.ts; tests/unit/audit-native-order-emails.test.ts; scripts/audit-cloudflare-shop.ts'
      : undefined,
    ['CUS-001', 'CUS-005'].includes(id)
      ? 'app/pages/cuenta/datos.vue; app/pages/cuenta/seguridad.vue; tests/components/account-profile.test.ts; tests/components/account-profile-read-state.test.ts; tests/components/account-security.test.ts'
      : undefined,
    id === 'CUS-006' ? 'app/pages/cuenta/direcciones.vue; tests/components/account-address-book.test.ts' : undefined,
    id === 'CUS-002'
      ? 'db/d1/migrations/0064_company_admin_review.sql; shared/company-review.ts; workers/auth/admin-companies.ts; workers/auth/admin-companies-http.ts; workers/canary.ts; app/components/CompanyReviewPanel.vue; app/pages/admin/clientes.vue; shared/admin-navigation.ts; tests/unit/d1-admin-companies.test.ts; tests/unit/d1-admin-companies-http.test.ts; tests/unit/d1-admin-companies-native.test.ts; tests/unit/d1-admin-companies-entrypoints.test.ts; tests/components/admin-companies.test.ts'
      : undefined,
    id === 'CUS-009'
      ? 'app/pages/cuenta/index.vue; workers/catalog/customer-orders.ts; workers/auth/profile.ts; workers/auth/address-book.ts; workers/catalog/customer-favorites.ts; tests/components/account-overview.test.ts; tests/components/account-orders-read-state.test.ts; tests/components/account-order-row-read-state.test.ts; tests/unit/d1-customer-orders.test.ts; tests/unit/d1-customer-orders-native.test.ts'
      : undefined,
    ['CUS-008', 'CUS-010'].includes(id)
      ? 'db/d1/migrations/0066_account_preferences.sql; shared/account-preferences.ts; workers/auth/account-preferences.ts; workers/auth/account-preferences-http.ts; workers/canary.ts; app/components/AccountPreferencesPanel.vue; app/pages/cuenta/comunicaciones.vue; tests/unit/d1-account-preferences.test.ts; tests/unit/d1-account-preferences-http.test.ts; tests/unit/d1-account-preferences-native.test.ts; tests/unit/d1-account-settings-entrypoints.test.ts; tests/components/account-preferences.test.ts; tests/components/account-settings-mounting.test.ts'
      : undefined,
    id === 'CUS-012'
      ? 'db/d1/migrations/0065_account_privacy.sql; shared/account-privacy.ts; workers/auth/account-privacy.ts; workers/auth/account-privacy-http.ts; workers/canary.ts; app/components/AccountPrivacyPanel.vue; app/pages/cuenta/comunicaciones.vue; tests/unit/d1-account-privacy.test.ts; tests/unit/d1-account-privacy-http.test.ts; tests/unit/d1-account-privacy-native.test.ts; tests/unit/d1-account-settings-entrypoints.test.ts; tests/components/account-privacy-panel.test.ts; tests/components/account-settings-mounting.test.ts'
      : undefined,
    ['CAT-007', 'SEA-006'].includes(id)
      ? `${typedAttributeEvidence}; workers/catalog/product-facets.ts; app/components/ReferencePicker.vue; tests/unit/d1-product-facets-scale.test.ts; scripts/audit-native-public-facets-scale.ts`
      : undefined,
    ['CAT-014', 'CAT-015', 'ADM-008'].includes(id) ? editorialImportEvidence : undefined,
    id === 'CAT-015' ? catalogExportEvidence : undefined,
    id === 'CAT-014' ? catalogFilePreparationEvidence : undefined,
    ['CAT-014', 'ADM-018'].includes(id)
      ? `${catalogNativeImportEvidence}; tests/unit/native-catalog-import-browser.test.ts`
      : undefined
  ]
    .filter(Boolean)
    .join('; ')
  if (!['CAT-005', 'CAT-006', 'ADM-008'].includes(id)) return references
  return [
    references,
    'db/d1/migrations/0037_catalog_policy_commands.sql',
    'shared/catalog-publication-policy.ts',
    'workers/catalog/catalog-policy.ts',
    'workers/catalog/catalog-policy-http.ts',
    'app/pages/admin/politicas-catalogo.vue',
    'app/components/ProductPublicationPolicyEditor.vue',
    'tests/unit/d1-catalog-policy.test.ts',
    'tests/unit/d1-catalog-policy-http.test.ts',
    'tests/components/catalog-policy-management.test.ts',
    'tests/components/product-publication-policy-editor.test.ts'
  ].join('; ')
}

const source = await readFile(reportPath, 'utf8')
const requirements: Requirement[] = []
let domain = ''
for (const line of source.slice(0, source.indexOf('# 10. ')).split('\n')) {
  const heading = line.match(/^## 9\.\d+ (.+)$/)
  if (heading) domain = heading[1]!.trim()
  const columns = line
    .split('|')
    .slice(1, -1)
    .map((value) => value.trim())
  if (columns.length !== 5 || !/^[A-Z]{2,4}-\d{3}$/.test(columns[0]!) || !validPhases.has(columns[1]!)) continue
  requirements.push({
    id: columns[0]!,
    phase: columns[1]!,
    priority: columns[2]!,
    requirement: columns[3]!,
    acceptance: columns[4]!,
    domain
  })
}

const failures: string[] = []
for (const id of [...discardedRequirements, ...Object.keys(scopedRequirements)]) {
  if (!requirements.some((requirement) => requirement.id === id)) failures.push(`unknown scope ID: ${id}`)
  if (discardedRequirements.has(id) && scopedRequirements[id]) failures.push(`conflicting scope ID: ${id}`)
}
if (requirements.length !== 702) failures.push(`expected 702 requirements, found ${requirements.length}`)
const duplicated = requirements.filter(
  (item, index) => requirements.findIndex((candidate) => candidate.id === item.id) !== index
)
if (duplicated.length) failures.push(`duplicated IDs: ${duplicated.map((item) => item.id).join(', ')}`)
for (const [phase, expected] of Object.entries(expectedPhases)) {
  const actual = requirements.filter((requirement) => requirement.phase === phase).length
  if (actual !== expected) failures.push(`${phase}: expected ${expected}, found ${actual}`)
}
for (const [priority, expected] of Object.entries(expectedPriorities)) {
  const actual = requirements.filter((requirement) => requirement.priority === priority).length
  if (actual !== expected) failures.push(`${priority}: expected ${expected}, found ${actual}`)
}
for (const id of [...mvpRepoEvidence, ...mvpExternal, ...mvpMissing]) {
  if (!requirements.some((requirement) => requirement.id === id)) failures.push(`unknown classified ID: ${id}`)
}
if (failures.length) throw new Error(`Master requirement audit failed:\n- ${failures.join('\n- ')}`)

const header = [
  'id',
  'phase_min',
  'domain',
  'priority',
  'requirement',
  'acceptance',
  'status',
  'implementation_refs',
  'operational_evidence',
  'external_owner',
  'last_verified',
  'notes'
]
// Narrow local evidence update only: statusFor() and acceptance counts remain
// unchanged. Local attestation fixtures are not real scanning/licensing or
// deployed acceptance; combined local gates are recorded in the checkpoint
// documentation, not treated as production/operational acceptance.
const mediaCheckpointNotes: Record<string, string> = {
  'CAT-007':
    'Historical PostgreSQL evidence is retained; new implementation is D1/Cloudflare only. Six strict types, explicit categories, immutable revisions and governed controls are implemented. The compiled workerd/Chromium baseline passed 309 scenarios, 59 migrations, 15 browser scenarios, different categories, history, lost-response GET/exact replay, 409 recovery and 401/403, with zero outbound Worker requests. Bounded CSV/XLSX retain 71 columns, legacy JSON, false/zero and six values through two audited native lifecycles. The separate typed native 25k cycle passed: 98 pages, 87449224 expanded bytes, 150000 values, 375000 snapshots and two receipts; hosted/deployed acceptance remains false. The actual typed maximum file is correctly rejected by the unchanged 20 MB file/100 MB expanded budgets, not a full-file round-trip PASS. A later single D1 batch and one server-owned clock now provide count/page/eligible media/fixed and typed facets/category and filter admission from one response snapshot; semantic preflight is revalidated inside it and no state is read afterwards. Directed product/facet/scale and typed/publication/media checks pass 36 plus 213 cases, preserving bounds and before/after-snapshot races. Independent actual workerd scale previously passed 1500 products, 3000 variants and nine public GETs, no outbound, owned temporary state cleaned. Reference name/SKU selection passes 31 component cases and the compiled browser journey. Hosted concurrency/load, business data, UAT and complete Oracle CI remain unverified; status remains NOT_VERIFIED.',
  'CUS-001':
    'Historical repository evidence is retained. The account profile now requires a confirmed current bounded Node/D1 DTO before any profile, email or fiscal form is usable. Failed or malformed reads never initialize writable blank phone data. Explicit GET recovery hydrates clean fields while preserving deliberate edits and guards duplicate/stale/unmounted requests; writes are not retried automatically. This does not establish full identity/account, fiscal, provider or production acceptance; status unchanged.',
  'CUS-005':
    'Existing sensitive-change server validation is retained. Profile, email and company form callbacks additionally require current validated profile authority, isolate submitted payloads and refuse success or buffer clearing after a failed current refresh. A rejected profile/company PUT may already have committed: it revokes the current read and permits only an explicit fresh GET, preserving all input buffers without automatic mutation retry. Email/fiscal approvals, security notices and production delivery remain independently unverified; status unchanged.',
  'SEA-006':
    'Historical Node/PostgreSQL evidence, fixed-axis fifty-value admission, JSON bindings, literal LIKE escaping and Precortado semantics are retained. One D1 response batch now contains count, ordered page with eligible media, eleven facet aggregates, category existence and typed-filter admission, sharing one server-owned clock; typed semantic preflight is revalidated inside the same snapshot and there is no later state read. Directed product/facet/scale checks pass 36 cases and typed-facet/publication/media checks pass 213, including withdrawals and price/name/definition changes before and immediately after the snapshot. D1 SQL/binding limits and legacy bounded-page checks remain intact; no complete contributor ID/row set is exported to JavaScript. Independent actual bundled workerd/D1 previously passed 1500 synthetic products/3000 variants and nine public GETs, unique variant-axis counts, compatible badge occurrences, brand/capacity self-exclusion, SKU and indivisible mixed-variant capacity pairs, with zero outbound and owned cleanup. Its withdrawal was between requests, not concurrent hosted-load acceptance. The earlier compiled six-type/category/history/recovery baseline passes 309 scenarios/59 migrations/15 browser scenarios. Native typed 25k import passed separately, not public facet or maximum file acceptance. Hosted limits/concurrency, business relevance, UAT and complete Oracle CI remain unverified; status remains NOT_VERIFIED.',
  'CAT-005':
    'Historical Node repository evidence is retained. Cloudflare adds the five-state graph, live original-permission checks, CAS/versioned immutable command and full variant audit, exact durable replay and an atomic rollback guard. A separate narrow capability drives the confirmed UI command and fresh GET after receipt. Discontinued variants are not resurrected. Publication invokes the authoritative policy/dependency/R2 gate, not the advisory query. Local mechanics do not certify real catalog or operational acceptance; status unchanged.',
  'UI-010':
    'Historical repository evidence and order-line retry tests are retained. The account order list additionally distinguishes pending, failed or malformed reads from confirmed empty results, hides stale rows/counts/actions and permits only guarded explicit GET recovery. Payloads and dates are bounded and validated; duplicate/stale/unmounted responses cannot enable reorder. Existing partial-add errors never trigger a read retry. Tracking, invoice, returns, full repeat-order correctness and production acceptance are not newly certified; status unchanged.',
  'CUS-013':
    'Existing D1 favorites evidence is retained. The account page displays lists/counts/actions only after a current validated read; pending, failed and malformed responses never become empty success. Explicit recovery retries only GET, with duplicate/stale/unmount guards. The entire pre-cart snapshot is validated before the first addition, and lost authority or a partial add does not trigger automatic write retries. Full advanced favorites/list-sharing and production acceptance are not newly certified; status unchanged.',
  'CAT-006':
    'Historical Node repository evidence is retained. The authoritative transition gate requires an explicitly assigned current product-type policy, reviewed identifier exceptions and applicable fields/documents, with bounded original R2 verification and atomic dependency rechecks. Migration 0037 provides explicit live-authorized policy/assignment/exception commands, immutable audit and durable replay. A shared execution-time D1 predicate now requires current policy, classification, identifiers, tax, category/brand and attested media for public catalog/SEO/bytes and new cart, quote, checkout and payment commands, with no legacy publication exemption. Final projection/batch guards close asynchronous withdrawal/expiry races; checkout compensates a newly invalid reserved attempt. Historical contracts and received-payment callbacks remain reconcilable rather than discarded. No real legal classification, scanner verdict or licensing evidence is invented. Full exception history, proactive expiry notifications/operational renewal, genuine dataset/scanning/licensing and deployed acceptance remain outstanding; status unchanged.',
  'CHK-014':
    'Local component evidence distinguishes cart/checkout loading or failed reads from empty carts, hides unconfirmed cached products/payment actions and retries only a GET without legacy-cache import writes. Checkout recovery errors still block payment. Keyboard/screen-reader end-to-end completion and full checkout acceptance are not established by these tests; status unchanged.',
  'SHP-024':
    'The existing shared threshold is now advertised only for eligible standard parcels subject to the authoritative quote; carts never guarantee free agency delivery solely from subtotal and exclude pallet/dangerous goods from that promise. Invalid/disabled thresholds hide the message. No margin/segment policy or full SHP-024 acceptance is implemented; roadmap status unchanged.',
  'CUS-014':
    'The local address agenda distinguishes pending/error/invalid payload from a successful empty array, hides stale cached rows and offers a guarded explicit GET refresh. Eighteen focused component cases pass. CRUD, ownership, fiscal/address completeness and production acceptance are not newly certified; status unchanged.',
  'ADM-008':
    'Local private Cloudflare catalog/pricing reads, draft metadata, status and policy governance remain live-authorized. Migration 0038 adds separate draft-only product creation, existing-brand assignment and explicit variant create/update/retirement, with immutable legacy IDs/SKU/slug, high-water allocation, live catalog.write/MFA, CAS, claim ownership, complete audit and rollback. New variants have pending zero price and zero balance in the single existing warehouse; no price approval, stock movement, media, policy or publication authority is fabricated. Reference and private catalog reads require confirmed own success/results envelopes; failed or missing counts never become a confirmed empty list. Inherited or malformed DTO fields fail closed. Draft form callbacks also stop after known loss of local session/MFA authority; exact original payload/key remain for deliberate ambiguous-delivery recovery and fresh GETs replace historical receipts as current state. Category CRUD, complete product management, full exception history, price scheduling/cancellation, real evidence and operational acceptance remain incomplete/unverified; status unchanged.',
  'ADM-014':
    'Local governed media library separates original upload, human rights review, signed scan evidence, publication and append-only withdrawal. Flags default off; no genuine scanner or real licensed inventory/provider acceptance. Full library/UAT criterion and production remain unverified; status unchanged.',
  'MED-001':
    'Immutable ownership/license/declaration/date/reference plus separate live human decisions have local evidence. Signed fixtures are synthetic; real permissions, allowed uses, complete asset inventory and legal/provider approval remain outstanding. Flags off; no production acceptance.',
  'MED-002':
    'Explicit immutable product/optional same-product variant/version mappings bind current scan/rights evidence. Cart/order projection selects the exact current SKU/variant, never product-level, sibling or legacy photos; local race/photo integration passes. Repository evidence does not establish real asset/product acceptance; status unchanged.',
  'MED-006':
    'Local technical PDF roles, language/version/validity metadata, private delivery and retained withdrawal history exist. Genuine current SDS/UFI/product documents and commercial/regulatory review remain unverified; status unchanged.',
  'MED-007':
    'Private immutable original upload/reconciliation and independently signed bounded scan receipts are implemented. Infectious verdict wins same-second ties; production mutation guards use SQL execution time and exact concurrent-command replay. Magic bytes/test HMAC fixtures are not antivirus; genuine scanner, licensed originals and deployed acceptance remain absent. Flags off; status unchanged.',
  'MED-008':
    'Local bounded IMAGES derivatives and actual picture AVIF/WebP/JPEG/srcset/sizes are evidenced. Final combined local workerd build checkpoint passes 33 scenarios/33 migrations/20 seeded products with zero outbound requests, including race/photo integration and current read-only pricing/inventory/HTTP/dashboard guards. Deployed provider, real assets, focal crop/quality/performance/cache measurement remain open; status unchanged.',
  'MED-009':
    'Contextual association alt is validated and projected to responsive components, including exact cart/order variant alt. Latest photo integration passes locally; editorial accessibility/keyword review and complete decorative-image acceptance are not established; status unchanged.',
  'MED-011':
    'Publication UUID URLs are independent of filenames/slugs; withdrawals retain immutable history and deny fresh delivery. Cache migration, deployed URL continuity and performance remain unverified; status unchanged.',
  'MED-012':
    'Explicit technical role/title/language/version/validity/product/variant metadata plus guarded PDF download are locally evidenced. Real document scope/currentness, download measurement and operational/deployed acceptance remain unverified; status unchanged.',
  'MED-015':
    'Component fallback is an honest family illustration on missing/failed governed images. Cart/order photos require exact current SKU/variant and omit unapproved legacy pointers; no different-product photo fallback. Latest local workerd integration passes; repository evidence is not production acceptance.'
}
for (const id of ['CAT-007', 'SEA-006'])
  mediaCheckpointNotes[id] +=
    ' The subsequent rebuilt actual workerd/D1 audit passed 20 public GETs over 1500 products/3000 variants and four overlapping HTTP/writer contenders, observing both complete before/after snapshots without mixtures; post-write reads and restoration match exactly, zero outbound, owned runtime/database removed. This is local emulator concurrency evidence, not hosted acceptance. Bundle policy passed 6909 entries/859 original Nitro sources.'
// Read-only pricing adds local evidence to existing requirements, not completion
// of their scheduling/business/legal/provider acceptance criteria.
const pricingCheckpointNotes: Record<string, string> = {
  'PRI-006':
    'Local D1 staff-only paginated history/current/compare/reference reads reuse effective-price authority with live catalog.write/email/MFA checks before/after a consistent read snapshot. UI handles fresh history, pagination, failures and stale responses; Node remains unchanged. Synthetic fixtures are not real tariff/regulatory/production acceptance; status unchanged.',
  'PRI-008':
    'Existing governed volume tiers are projected by private D1 prices and remain readable in current/history mobile UI with the real currency. This read-only addition does not create/edit tiers or certify selected real references and operational boundary acceptance; status unchanged.',
  'PRI-011':
    'Local Cloudflare GET reads current validity and earliest approved future version from the whole history at a server pricing instant. List/history are bounded and independently paginated; missing legacy validity stays null. Focused SQLite/UI and independent pricing review plus the local 33-scenario Worker/SSR build checkpoint provide read-only evidence. Cloudflare scheduling, editing, cancellation and write governance are not implemented; Node existing routes remain. No real tariff, operational or production acceptance; status unchanged.'
}
// Read-time aggregate diagnostics do not implement a daily reconciliation job,
// new inventory writes, multi-warehouse workflows or operational acceptance.
const inventoryCheckpointNotes: Record<string, string> = {
  'INV-003':
    'Local single-warehouse diagnostics retain all persisted reserved quantities, including overdue TTLs, and report uncovered reservations only above max(0, physical-blocked-safety) without authorized backorder. Normal exhaustion without reservations is not an incident. Unknown scope returns null/capability false, not zero. Read-only SQLite/UI and workerd evidence does not establish full concurrency, operational or production acceptance; status unchanged.',
  'INV-005':
    'Read-only operations count expired reservations still persisted as reserved once each; quantities are not silently released by observation. The local workerd checkpoint exercises overdue retention, explicit release and restored zero counters. This diagnostic does not implement new TTL jobs or certify every rejection/cancellation/captured-stock release path or daily operation; status unchanged.',
  'INV-009':
    'Private diagnostics apply the existing safety buffer and backorder policy: permitted over-availability commitments are separate from uncovered non-backorder reservations and do not alone inflate inventoryExceptions. Structural ledger drift can coexist with a permitted commitment. No policy editing, real lead-time acceptance or production verification is claimed; status unchanged.',
  'INV-012':
    'Persisted single-warehouse physical/reserved ledger differences and active reservations with a missing balance are diagnosed by unique variant/location pair. Retired net-zero ledger history without active reservations is not a false anomaly. inventoryExceptions deduplicates overlapping pair causes plus unique stock-exception orders, excluding TTL/backorder-only counts. This read-time dashboard is not a daily reconciliation job or operational acceptance; status unchanged.',
  'ADM-007':
    'Local operations expose five bounded inventory aggregates with per-metric capabilities, no buyer/reservation/ledger/warehouse/actor identifiers or new writes. Unknown warehouse scope leaves stock diagnostics null while real stock-exception orders remain observable. Focused inventory 42/UI 53, HTTP-origin 62 and order-regression 31 cases plus a local 33-scenario build checkpoint provide partial evidence. Full operational dashboard/provider acceptance remains unverified; Node existing GET/POST behavior is preserved; status unchanged.',
  'UI-004':
    'Capability/source-driven operations and dashboard keep unavailable stock unknown rather than claiming it was checked or treating it as zero. TTL, ledger, uncovered reservations, stock-exception orders and permitted backorders have distinct descriptions/units; observed stock incidents link to Operations. Focused operations 53/dashboard 27 cases cover loading/error/retry, hostile capabilities and responsive/accessibility structure. Full owner/age/next-action coverage, browser/manual acceptance and production remain unverified; status unchanged.'
}
const configurationCheckpointNotes: Record<string, string> = {
  'CIC-001':
    'Local full-shop build uses reviewed explicit binding/variable projection, remote:false resources, disabled provider flags and no inherited production environments/services/build hooks/aliases. Dependency evidence validates original esbuild metadata separately from original standard/indexed source maps; empty/corrupt graphs cannot be repaired by fabricated map inputs. Real renderer aliases remain supported without allowing forbidden resolved dependencies. Local full bundle policy passes 4377 entries/651 Nitro sources and workerd passes 34 scenarios/33 migrations/20 seeded products with zero outbound requests. Production acceptance remains unproven; status unchanged.',
  'ADM-012':
    'Local/preprod configuration projection rejects remote/nested binding escapes and non-data/prototype-bearing variables, keeps only explicit non-secret vars, validates primitive account/resource identifiers and disables all provider flags including Bizum. Importing the preprod module performs no credential reads or API calls. Focused 112 configuration cases include installed Wrangler schema/current manifest and independent accessor/coercion regressions. These generators have local evidence only; promotion review, real isolated account acceptance and production remain unverified; status unchanged.'
}
// Add implementation evidence without changing broad requirement status or
// treating synthetic local inventory/prices as real operational acceptance.
const executionCheckpointNotes: Record<string, string> = {
  'SHP-009':
    'Cloudflare shipping resolves preparation, supplier stock lead time, Madrid cutoff and explicit destination/method/profile/zone operating calendars into stable date-only ETA snapshots. Missing calendar or unknown supplier lead time is unknown, never a fabricated natural-day estimate. Option hashes include calendar revision and dates; checkout recalculates current eligibility and its guarded batch rejects a changed revision or crossed temporal boundary. Dates remain estimates, not a carrier guarantee. Local targeted evidence does not certify real calendars, carrier SLAs, compiled Chromium or deployed operational acceptance; status unchanged.',
  'SHP-019':
    'Migration 0078 adds an initially empty versioned calendar configuration, immutable commands and audited live administration.manage/email/MFA writes. National, local and carrier calendars select preparation/transit stages and configured weekdays/closed dates without seeded holidays. Private UI requires explicit review and confirmation; uncertain results retain the original intent for hash-bound receipt and current-state GET recovery. Real holiday schedules, operator approval, carrier policy and compiled-browser/deployed acceptance remain pending; status unchanged.',
  'SUP-006':
    'Migration 0079 adds independent internal payment/stock/transport/Beply escalation queues, eligible owners, severity, next action and ticket/escalation CAS. Separate internal runbooks have explicit draft/approve/withdraw revisions and review expiry; customer-reply macros confer no operational approval. Immutable actor-bound commands and exact hash recovery do not resolve the customer ticket or alter money, stock, fiscal records or communications. Private UI coordinates legacy actions and retains uncertain delivery. Real operational runbook approval, provider integration and compiled-browser/deployed acceptance remain pending; local directed evidence does not certify them; status unchanged.',
  'UI-013':
    'Deterministic read-only fixtures cover dense/empty/loading/error/stale/denied states on real admin-order and customer-order components. Directed bands observed 5 harness, 12 component and 8 bounded artifact-capture tests passing. Opt-in static component HTML/CSS capture uses only the Cloudflare output, rejects symlinks and foreign artifacts, and creates nothing by default. Prepared Playwright discovery contains 48 visual comparisons at 320/768/1024/1440 plus two isolated real-route cases, not executed acceptance. No PNG baselines have been generated or reviewed; static hashes do not prove SFC/bundle provenance or hydration. Chromium, real-route E2E, reviewed baselines and compiled acceptance remain pending; status unchanged.',
  'SHP-015':
    'Private Cloudflare tracking reads canonical fulfillment and complete audited packing history for current owners, live MFA administrators or existing sealed guest view grants. Manual references remain unverified, never imply delivery and disclose no private financial, address or label data. Carrier events are not fabricated; fallback directs customers to NETECO. Existing guest links retain their 24-hour window: tracking does not extend or renew them. Separate registered-customer preparation/delivery email preferences now use live authority, CAS, immutable commands and exact hashed receipt recovery; marketing/newsletter consent is unchanged. The real dispatcher honors confirmed opt-outs at its atomic pre-send boundary and records immutable terminal suppression, never a fake send or manual-review error. Re-enabling does not resend suppressed events; payment, cancellation, fiscal, refund, support and security messages remain independent. The account UI coordinates private actions and the data export includes the actual delivery choice. Guest preference writes, carrier integration, approved policy, compiled Chromium and deployed acceptance remain pending; status unchanged.',
  'SHP-013':
    'Cloudflare packing records bounded parcel weights, dimensions and exact contractual line allocations, including split quantities, as immutable audited revisions. Live administration.manage/email/MFA, canonical paid/assigned fulfillment facts and both packing/fulfillment versions govern commands and receipt recovery. Local SQLite/HTTP and actual canary-source workerd D1/all 69 migrations preserve economic, stock and fulfillment tables with zero outbound. An external label reference is unverified_reference_only, not a stored/scanned label artifact or carrier acceptance. Compiled Chromium journeys, real labels/carrier limits and deployed operational acceptance remain pending; status unchanged.',
  'SHP-018':
    'Manual parcel contingency registers one carrier/shipment/tracking/external-label reference per confirmed bulto with an explicit operational reason, immutable command/audit and exact UUID/hash recovery. It requires authoritative paid/assigned packed fulfillment, never advances delivery state or submits to a provider, and cannot revise a dispatched packing. Private UI retains uncertain intent instead of automatically reposting. References are unverified_reference_only; no PDF, external URL, webhook or carrier verification is fabricated. Compiled Chromium journeys, real contingency procedure and operational/provider acceptance remain pending; status unchanged.',
  'SHP-020':
    'Manual dispatch retains the original contractual shipping gross, operator-declared actual net/tax basis points and server-rounded tax/gross with an integer gross variance, using the existing money rounding authority. These are internal expedition observations, not customer charges or changes to the order, payment, stock or fulfillment. Local native workerd evidence preserves those domains. Real carrier invoices/cost reconciliation, compiled Chromium journeys and deployed operational acceptance remain pending; status unchanged.',
  'SUP-010':
    'Optional Cloudflare satisfaction follows confirmed resolved/closed support or delivered registered-customer orders; it never changes service, stock, money or order states. Current customer ownership/email/session, source version and the exact displayed privacy-policy hash govern writes and durable same-key recovery. Existing feedback retains its original expiry even when policy changes; expired comments are excluded from reads. Admin support.manage/MFA aggregates are segmented with comments excluded by default, and corrupt applicable projections fail closed instead of reporting zero. Physical comment erasure is not automated, guest survey invitations are not implemented and real privacy policy/retention, compiled Chromium journeys and deployed operation remain unaccepted. Local SQLite/HTTP and actual canary-source workerd evidence is not production acceptance; status unchanged.',
  'INV-011':
    'Single-warehouse Cloudflare alerts share canonical inventory facts without stock writes. Explicit per-variant thresholds remain separate from safety stock; low/out-of-stock/anomaly episodes are unique while active, audited and CAS/idempotency governed. Live-authorized private reads, exact alertId recovery, bounded manual evaluation and a durable paged Cron cursor distinguish current facts from persisted episodes. Cron is OFF by default and independent of fiscal failures. The panel configures thresholds from confirmed SKU selection, retains uncertain commands for manual receipt/current recovery and purges on lost authority. Directed service/HTTP/runtime/component tests and actual canary source with workerd D1/all 67 migrations pass, including 100 positions and unchanged stock. Compiled Chromium journeys and deployed operational thresholds/retention remain pending; status unchanged.',
  'ADM-008':
    'Existing draft authoring, publication policy/status governance and private reads remain evidenced. Migrations 0039/0040 add separate live administration.manage/email/MFA price schedule/cancel and category create/rename/move/empty-retirement commands, with CAS, claim ownership, immutable audit, durable replay and atomic rollback. Category creation remains draft and cannot implicitly publish a hidden branch. Narrow confirmed UI capabilities never enable the legacy full writer; uncertain delivery retains the original intent and key. Complete product management, category publication workflow, exception history, real catalog and operational acceptance remain outstanding; status unchanged.',
  'CAT-008':
    'Local category commands preserve immutable identity, monotonic legacy IDs and actual parent snapshots, including unmapped ancestors. Rename records an immutable slug alias resolved directly to the current canonical slug only under published mapped acyclic ancestry; current canonical slugs take precedence. GET/HEAD return private no-store internal 301s, with bounded filters/UTM and no arbitrary redirect target. Cycles, visibility expansion, alias theft and nonempty retirement fail closed. New categories remain draft. Real taxonomy, full navigation/publication administration and production SEO acceptance remain unverified; status unchanged.',
  'PRI-006':
    'Historical private D1 reads are retained. Governed scheduling/cancellation now record immutable command and audit snapshots, share effective-price authority, preserve finite historical gaps and restore only coherent owned predecessor windows. The thirty-day reference is explicitly limited to available approved windows, not invented legacy coverage or regulatory proof. Local synthetic mechanics do not certify real tariffs, full legal history or production acceptance; status unchanged.',
  'PRI-008':
    'Local governed price scheduling accepts bounded volume tiers validated by the shared money and current MOQ/increment/maximum rules. Private UI keeps exact minor-unit amounts and separates tiers from direct legacy price writes. Existing server-side quote selection remains authoritative. Selected real references, full commercial boundary acceptance and production remain unverified; status unchanged.',
  'PRI-011':
    'D1 now supports separate live-authorized schedule and latest-future cancellation commands without deployment. Head and catalog version CAS, execution-time temporal checks, immutable proof, durable same-key replay and rollback govern writes; cancellation restores only a coherent original predecessor window. Current effective price, explicit legacy/governed identity and complete approval head are distinct from paged history. UI preserves the exact sent intent on uncertain or postcommit authorization errors and confirms current state by GET. Real tariff and production acceptance remain unverified; status unchanged.',
  'INV-002':
    'Existing reservation ledger evidence is retained. Single-warehouse manual receipts/approved counts now append a governed nonzero physical movement atomically with balance/version, immutable actor/reason/reference audit and durable receipt. Proposals never mutate balance or fabricate a zero movement; historical unknown actors stay null. The actual global InventoryCoordinator bypasses cached authorization for these manual commands and rechecks current D1 grants on replay. Real stock master/process and production acceptance remain unverified; status unchanged.',
  'INV-007':
    'Local manual stock changes require inventory.write, verified email/MFA, exact balance CAS, consistent physical/reserved ledger and immutable reason/reference. Every count adjustment conservatively requires a distinct live-authorized approver; no threshold is invented. Decrements cannot consume blocked or persisted reserved units, even overdue TTLs. Receipts can recover a genuine backorder deficit, never conceal ledger corruption. UI and HTTP retain ambiguous sent commands with their exact key/body and require confirmed fresh stock. Business thresholds, operational training and production acceptance remain outstanding; status unchanged.',
  'INV-010':
    'Single-warehouse UTF-8 CSV counts are bounded to 100 rows and 64 KiB, with read-only previews, per-row errors, exact differences, reason and reference. Immutable proposals change no stock; a distinct live inventory.write/email/MFA actor approves the entire reconciled batch against unchanged source snapshots and versions. The existing global inventory Durable Object serializes writes; guarded set-based D1 batches commit balances, ledger, audit and actor-bound exact receipts atomically. Zero differences do not create movements. Paginated discovery, fresh details and manual hash-bound recovery use the same authoritative records; malformed/encoded namespaces and outages fail closed. Local targeted evidence does not certify real stock counts, compiled-browser or deployed operation; status unchanged.'
}
const nativeOperationsCheckpointNotes: Record<string, string> = {
  'BEP-003':
    'Ordinary fiscal protocol now has a Worker-compatible Beply API v3 port, tested offline against the existing versioned contract. No provider credentials, network calls or acceptance are implied; existing real Beply lookup/reconciliation capability is not fabricated. Status unchanged.',
  'BEP-004':
    'Reclassified from MISSING to PARTIAL_EXTERNAL after reviewing each acceptance atom: payment/outbox atomicity, resumable fenced Queue transport and ordinary local recovery are evidenced. An explicit administrative queue command atomically records its owned receipt, frozen intent/work/audit and releases only its event; policy approval never emits. Native issuance still invokes the dispatcher explicitly: authorized runtime execution wiring, real Beply correlation/reconciliation capability, policy/series/mappings and controlled provider recovery remain pending. Partial implementation is not real-provider or legal acceptance.',
  'BEP-006':
    'The ordinary invoice contract uses historical order/line/address/shipping snapshots, captured amount and an explicit approved policy fingerprint; never current prices or tax/rates. D1 intent, fenced provider receipt, document checksum and event are governed. Real Beply issuance and business policy remain unaccepted; status unchanged.',
  'BEP-007':
    'Local ordinary issuance records an issuing marker before provider calls and fences finalization. An ambiguous response is uncertain, never blindly reissued; manual reconciliation requires matching authoritative lookup evidence. The persistent fake proves lost-response recovery, while Beply lookup support remains explicitly unavailable. Production acceptance and rectifications remain outstanding; status unchanged.',
  'BEP-008':
    'Private R2 PDFs use bounded content-addressed objects, confirmed storage acknowledgements and checksums. Customer ownership or existing revocable 24-hour guest access is rechecked after storage/hash awaits. Native HTTP is private/no-store/noindex and synthetic documents are local-only. This is not real Beply PDF/legal acceptance; status unchanged.',
  'ORD-001':
    'Existing independent contractual order/payment states are retained. Migration 0043 adds separately governed preparation and delivery state/version/timeline; ordinary fiscal workflow is also independent. Payment allocates stock once; fulfillment never decrements it again. Returns and provider tracking remain separate pending domains; status unchanged.',
  'ORD-004':
    'Single-warehouse fulfillment commands require current administration.manage, verified email/MFA, captured winning payment and exact allocation/ledger proof. CAS, immutable actor/reason/evidence, guarded batch and durable same-key replay prevent skipped or duplicated transitions. UI confirms current context and preserves ambiguous intent. This does not cover cancellation/refund/RMA/carrier transitions; status unchanged.',
  'INV-006':
    'Reclassified to REPO_EVIDENCE after complete technical criterion review: verified capture assigns stock once in the guarded reservation batch; fulfillment revalidates the winning payment, completed recovery, assigned lines, exact allocate movements and reconciled balances. Native checkout/payment uses the real DO, and repeated bank callbacks plus preparation-to-delivery retain allocation and complete inventory/contract digests. Picking/packing/collection never causes another decrement. Real stock master, operational policy approval and warehouse UAT remain unaccepted separately; no production-completion claim.',
  'ADM-009':
    'D1 CMS drafts reuse the existing typed block schema with bounded own JSON, safe CTA URLs and no arbitrary HTML/JS. Separate confirmed UI supports create/edit/restore/archive; images remain quarantine references, not approved public media. Publication, signed preview, scheduling and public rendering remain unavailable; status unchanged.',
  'ADM-011':
    'D1 CMS versions and actor history are immutable. Restore creates a new version with CAS, current permission/MFA and atomic audit/durable replay; archival retains history and reserved slug. This does not certify configuration rollback or full publication/preview workflow; status unchanged.'
}
const phaseTwoCheckpointNotes: Record<string, string> = {
  'ADM-009':
    'Typed CMS drafts now have a separate governed D1 publication projection and public renderer. Immutable version/release/media links, current scan/rights and original R2 bytes are required; arbitrary HTML/JS remain unavailable. Public reads revalidate after asynchronous work. Local synthetic media do not establish real rights/editorial approval or full accessibility acceptance; status unchanged.',
  'ADM-010':
    'Atomic publish/withdraw is governed by live catalog.publish, email/MFA, CAS and durable command receipts. Signed thirty-minute previews bind immutable version, default segment and responsive/desktop/mobile device; revocation and current scan/rights/R2 authority are checked. Private preview URLs cannot enter client analytics, RUM or SEO; headers disable indexing/referrer/cache. Only the default public segment is supported, not arbitrary targeting. Real editorial/device acceptance remains separate; status unchanged.',
  'ADM-011':
    'D1 immutable draft history and restore-as-new-version remain evidenced. Separate publication heads do not expose a later draft, and superseded slugs resolve only to the current valid release. Replay cannot bypass withdrawn permission or preview authority. Configuration rollback and complete visual/editorial acceptance remain unverified; status unchanged.',
  'ADM-013':
    'Publication/withdrawal scheduling uses explicit Europe/Madrid local times with DST gap/repeated-hour handling, durable approval, unique phase events and atomic release CAS. A private read-only D1 calendar now batches month count/page/global alerts and rechecks live email/MFA/catalog.write; approved version labels, active blocked incidents outside the selected month, completed/cancelled/superseded phases and pending due actions are distinct. The actual Nuxt calendar blocks navigation during unsaved or ambiguous commands and clears stale actor/runtime responses. Calendar SQLite/HTTP/component regressions and the two new native HTTP helper cases passed the combined local workerd gate (242 scenarios,51 migrations,zero outbound on 2026-10-03). Runtime Cron is wired, but positive deployed Cron/Queue acceptance remains unproven. Broad status remains NOT_VERIFIED.',
  'ADM-016':
    'D1 public content projects immutable typed title/description/noindex and excludes previews, drafts, withdrawn or invalid releases from the content sitemap. This is not full OG/schema/SEO-template administration, real editorial defaults or production search acceptance; status unchanged.',
  'SEO-004':
    'The CMS-enabled D1 sitemap index includes content shards with a real current-publication count and bounded one-thousand-entry pages. Count/slice share a batch and scan/rights/publication are rechecked after awaits; revoked authority fails closed rather than serving partial stale XML. Tests include 1001 releases and noindex/draft/preview/expiry exclusions. This narrow content proof does not certify every entity feed or production crawling; status unchanged.',
  'BEP-004':
    'PARTIAL_EXTERNAL is retained. Governed ordinary intents now have a scheduled/Queue runtime executor with explicit policy allowlist, independent issuance/local-validation opt-ins, strict environment/provider/mapping checks and no implicit provider. The runtime factory refuses the known production Beply tenant in local/preview. Canary regression tests cover invalid transport, replay, missing R2 acknowledgement and disabled gates. Host callbacks against native D1/R2 are distinguished from actual workerd Cron/Queue entrypoint acceptance. Real fiscal policy/series/mappings and Beply correlation/recovery remain open.',
  'BEP-006':
    'The ordinary frozen contractual invoice source now also produces an immutable versioned invoice-email preparation manifest, without rebuilding tax/prices from current catalog. Fake completion is clearly synthetic and provider fiscal status remains separate from workflow completion. Real Beply/customer mapping and legal acceptance remain outstanding; status unchanged.',
  'BEP-007':
    'Runtime issuance uses only owned frozen intents and a server allowlist. Missing acknowledgements or expired issuing markers become uncertain; reconciliation, not blind reissuance, is required. The persistent local provider supports authoritative lookup, while the Beply port does not fabricate external lookup support. Real provider reconciliation and rectifications remain open; status unchanged.',
  'BEP-008':
    'Private R2 PDF ownership/checksum evidence remains intact. The order UI confirms current actor/order/session context, clears stale reads and distinguishes issued/fiscal_pending/local validation/uncertain; no emission POST or invented administrative PDF endpoint is added. Invoice email is independently gated and grants no new access or bearer link. Real Beply PDF/legal and external email acceptance remain outstanding; status unchanged.',
  'COM-004':
    'Invoice delivery now uses the existing separate transactional outbox publisher/consumer and durable sent ledger, plus an immutable renderer/source/message checksum manifest. Invoice and synthetic-validation delivery require independent opt-ins; transport replay does not resend. Ambiguous sends remain manual_review, not automatic duplicate retries. Native helper sender is memory-only synthetic, not provider delivery; real sender/reputation/Queue acceptance remain outstanding. Broad status unchanged.',
  'COM-006':
    'The Worker invoice.issued renderer is versioned and distinguishes genuine provider fiscal status from local synthetic validation; its confirmed private source contains no storage key, token or new access link. Existing order/identity templates remain separate. Payment, preparation, shipment, cancellation, refund and incident templates still need complete D1 wiring and provider/client acceptance; broad status unchanged.',
  'COM-008':
    'Invoice rendering uses bounded own JSON, escaped contractual strings and controlled sender/subject; private source and message hashes are persisted atomically before delivery. Hostile payload and preview-client analytics exclusions are tested. This is local renderer evidence, not a complete provider/client or template-matrix acceptance; status unchanged.',
  'ORD-001':
    'D1 adds an independent RMA graph/version/event/command projection beside historical order, captured payment, fulfillment and ordinary fiscal states. Requested/approved/received/inspected/resolution_ready are distinct, and received items remain non_sellable custody. No financial, stock, invoice or original contract source is mutated by the RMA. Refund/fiscal resolution and carrier tracking remain separate open domains; status unchanged.',
  'ORD-004':
    'Existing live-authorized fulfillment transitions now have a separate governed RMA command graph with CAS, immutable audit and durable replay. Shared SQL quantity budgets prevent concurrent cases from exceeding purchased quantities; receipts/inspection support partial quantities without implicit reselling or refunds. Cancellation, economic resolution/refund and provider tracking still lack full coverage; status unchanged.',
  'ORD-007':
    'Administrative D1 RMA supports eligibility, reason, approval/rejection, partial receipt/inspection and a traceable resolution_ready handoff, with live administration.manage/email/MFA and atomic audit/replay. This is not resolved: refund/credit-note/disposition effects remain explicitly false and non_sellable custody does not replenish stock. Full economic resolution and operational acceptance are pending; status remains NOT_VERIFIED.',
  'ORD-016':
    'Verified customer ownership is required for D1 return creation and private case reads. Owned order quantities, delivery/payment eligibility, timeline and partial custody are server governed; foreign orders and unverified guests cannot use email/order number as identity proof. Customer/admin panels preserve ambiguous intents and failed reads. Guest verification, labels/tracking and complete economic resolution remain pending; status unchanged.'
}
const phaseThreeCheckpointNotes: Record<string, string> = {
  'PAY-008':
    'Governed D1 refund planning/confirmation/cancellation/reconciliation and the administrative panel use fresh authority, CAS, durable exact receipts, purchased-line/captured-money budgets and a separate provider state. Signed Redsys type-3/0900 correlation is tested offline; ambiguous acceptance retains budget and forbids blind resending. Real bank acceptance, settlement and operational double-confirmation acceptance remain open. PARTIAL_EXTERNAL unchanged.',
  'BEP-009':
    'D1 corrective contracts preserve the original invoice reference and signed line/tax amounts, reserve quantity/economic budgets and have separate governed local execution/private PDF/email sources. The real Beply corrective adapter deliberately refuses before I/O until authoritative document-kind, original-reference and signed-total evidence is supported. Synthetic completion is not fiscal issuance. Real rectification/legal/provider acceptance remains open; PARTIAL_EXTERNAL unchanged.',
  'ORD-006':
    'D1 refund contracts allocate exact historical line/shipping money within captured and RMA budgets without rewriting payment, original invoice or stock. Uncertain provider outcomes retain allocation; reconciliation never creates an automatic second submission. Admin actions retain ambiguous bodies/keys, while customer reads are owned and read-only. Stock disposition and complete bank/fiscal/communication reconciliation remain open; status unchanged.',
  'ORD-007':
    'The governed RMA resolution_ready handoff now feeds independently confirmed refund and corrective-document contracts with quantity/money gates. Received custody remains non_sellable and no restock is inferred. Synthetic local providers validate durable recovery, not real bank/Beply acceptance or a fully resolved operational return. Broad NOT_VERIFIED remains unchanged.',
  'SUP-002':
    'Cloudflare contact/options routes create bounded contextual tickets with consent, dedicated quotas and optional signed private attachment scanning. Explicit real Turnstile descriptors are verified server-side against exact hostname/action/time; the contact document alone permits its SDK, SPA navigation obtains that document, and revoked/late callbacks cannot restore tokens. Local verifier fixtures are not real anti-spam/scanner acceptance. Adaptive challenge policy and operational acceptance remain open; status unchanged.',
  'SUP-003':
    'An independent D1 support graph, immutable timeline and governed commands cover public messages, internal notes, assignment, priority and next action. Policy controls due/retention information without inventing service-hours/SLA claims. Verified owners and current support staff have separate readers. This does not prove every order/payment/carrier/fiscal context or full operational SLA acceptance; status unchanged.',
  'SUP-004':
    'Cloudflare private support reads require sealed live identity and owned ticket/order relationships; an anonymous claimed email or order number is not proof and grants no private portal access. Permission/MFA is rechecked after awaits and before replay; attachment authority is separate and private. A complete proportional guest-verification workflow and real staff exercise remain open; status unchanged.',
  'SUP-008':
    'D1 support context redacts by current role and verified ownership, with separate bounded order/payment/invoice lookups. Customer replies exclude internal notes, quarantine keys and other customers. UI clears stale actor/ticket reads; dedicated signed scan receipts do not authorize catalog media. A full CRM 360/role/operational acceptance matrix remains unverified; status unchanged.',
  'SUP-009':
    'Governed support internal notes and next-action/assignment commands record actor/time/version and immutable receipts under explicit policy. Customer timelines redact staff-only content. Logical retention/redaction is not physical erasure or legal retention approval; a complete categorized call log and operational retention exercise remain open; status unchanged.',
  'SUP-013':
    'Owned Cloudflare customer support and RMA panels expose separate confirmed timelines and permitted replies, with no private access inferred from email/order claims. Loading/failed/empty states and ambiguous command recovery are distinct. Complete guest verification, carrier/label integration and provider-resolved financial outcomes remain open; roadmap status unchanged.',
  'MKT-002':
    'Existing D1 consent/double-opt-in evidence now supports separately governed editorial preferences through an explicit confirmation-token exchange, never an email-only claim. Preference updates do not create consent; source/version/revision and suppression remain authoritative. Local campaign proof does not accept external provider synchronization or legal consent wording; REPO_EVIDENCE is not production acceptance.',
  'MKT-003':
    'Editorial messages use signed unsubscribe and explicit authenticated preference access without login, respecting the authoritative D1 suppression. Disabling acquisition does not disable unsubscribe/consent maintenance. Preference link pages are private and excluded from analytics/RUM before any token handling. External suppression and already-sent provider behavior remain unaccepted; broad status unchanged.',
  'MKT-028':
    'D1 adds governed topics/policies, explicit theme/frequency/quiet-hour preferences, immutable CMS-backed campaign approval and bounded consented-recipient expansion. Current CMS authority, suppression, caps and expiry are rechecked before send; uncertainty forbids blind duplicates. A separately opted-in local workerd sender persists only synthetic message fingerprints/IDs, never recipient/content/token. Real editorial plan, ratio review, provider/reputation and delivery acceptance remain open; roadmap status unchanged.',
  'COM-004':
    'Existing transactional outbox/transport now registers separately opted-in versioned refund/credit/support renderers. Disabled dispatch and empty policy allowlists do not sweep financial markers or contact providers. Native integration distinguishes workerd HTTP/local newsletter receipts from host financial/email callbacks; it does not establish positive deployed Cron/Queue/provider acceptance. Broad status unchanged.',
  'COM-006':
    'Worker renderer registry now includes refund.succeeded.v1, invoice.credit.v1 and public support received/reply templates alongside order/identity/ordinary-invoice sources. Immutable manifests and synthetic/fiscal-pending labels prevent invented bank/fiscal status or private access. Other preparation/shipment/delivery/cancellation templates and provider/client matrix remain open; broad status unchanged.',
  'COM-008':
    'New refund/credit/support/editorial renderers use bounded own JSON, escaped authoritative strings, controlled subjects/senders, safe links and immutable hashes. Private notes/storage keys/tokens are excluded; local newsletter receipts contain hashes only. This is local defensive renderer evidence, not full mailbox/provider or template matrix acceptance; status unchanged.',
  'COM-012':
    'Explicit D1 editorial preferences implement Spanish locale, chosen frequency and Europe/Madrid quiet hours without altering transactional immediacy or inferring marketing consent. Campaign caps, suppression and due-time gates are server-owned. Other languages and actual provider/operational delivery acceptance remain open; status unchanged.',
  'COM-017':
    'Governed CMS-backed editorial campaigns use explicit topics/frequency and signed simple unsubscribe; recipient expansion is paginated rather than silently capped. Local synthetic delivery remains independently gated and cannot activate the ordinary transactional sender. Real personalized digest/content program and external acceptance remain open; roadmap status unchanged.'
}
const phaseFourCheckpointNotes: Record<string, string> = {
  'DAT-001':
    'D1 measurement v1 separates consented browser events from authoritative capture/refund/fiscal facts, with shared schemas and explicit metric/source/population definitions. Only an explicitly configured approved dataset policy enables acquisition. This narrow taxonomy is not complete ecommerce/operational measurement or legal/production approval; broad status unchanged.',
  'DAT-002':
    'Client event identity is immutable and anonymous sessions use a dedicated HMAC namespace. Commerce facts deduplicate by environment/source kind/source identity and require exact persisted contract/proof/fingerprint matches. Original verified bank provenance is captured only on the first real authorization path; legacy callbacks are not backfilled. Cross-device/cart/channel attribution and full identifier continuity remain open; status unchanged.',
  'DAT-003':
    'Consent/private-path/PII validation precedes dataLayer and the single retry-free browser POST. Newsletter links, CMS previews and case/encoding aliases are excluded; withdrawal clears the anonymous cookie even when acquisition, policy or its limiter is unavailable, with a second clear after a late accepted POST. This does not certify all regions, tags/providers or browser-unload behavior; status unchanged.',
  'DAT-004':
    'The existing Node v1 client input contract and its accepted event names are preserved, without inventing financial browser events. New D1 facts cover confirmed captures, irreversible submitted refunds and ordinary fiscal issuance. Private cart/checkout paths remain excluded; complete ecommerce funnel/payment/purchase/refund quantities and attribution are not implemented by this checkpoint. NOT_VERIFIED remains unchanged.',
  'DAT-005':
    'D1 projected captures require the actual winning intent, applied order state, fulfillment claim, completed recovery and one hash-only original verified authorization proof. Sandbox/synthetic sources are excluded in production; legacy or contradictory proofs stay unconfirmed. Browser events never create revenue, and invoices are not sales. Real bank/provider settlement acceptance remains open; status unchanged.',
  'DAT-006':
    'A live MFA administration.manage reader compares source contracts with projected fingerprints, money/currency/dates and population in one read-only D1 snapshot. Counts and issues have independent real pagination; submitted uncertain refunds force unknown money rather than a successful zero. This local comparison does not call Redsys/Beply or implement the full daily provider reconciliation/task workflow; status unchanged.',
  'DAT-007':
    'Explicit local/preview populations remain validation-only, production excludes known sandbox/synthetic facts, and missing bank provenance cannot be inferred from APP_ENV. The client collector excludes known bot markers and private/preview routes without retaining IP/UA/query data. Full internal-traffic/hostname policy and real provider/raw-data acceptance remain open; status unchanged.',
  'DAT-008':
    'The read-only Nuxt D1 panel separates collected gross, confirmed refunds, collected-minus-refunds, ordinary fiscal documentation and consented browser counts. Missing proof/backlog means nullable metrics, not invented zeros; complete source coverage, UTC period, policy and population remain visible. Sealed current identity/MFA, epoch guards and post-await synchronous configuration gates prevent stale or relabeled results. This is not net sales/margin/conversion/AOV or the complete commercial dashboard; status unchanged.',
  'DAT-010':
    'Validated search_completed v1 keeps result counts but sends a fixed omitted marker and persists no free-form query. PII is rejected before omission. This privacy-safe subset does not implement normalized-query/click/conversion/zero-result/latency analysis; broad status unchanged.',
  'DAT-012':
    'Shared strict own-JSON schema/PII/private-route validation runs before dataLayer or HTTP, with adversarial client tests. Frozen or throwing dataLayer objects cannot break the storefront or schedule blind retries. Full CI/E2E ecommerce taxonomy/duplication and third-party tag acceptance remain open; status unchanged.',
  'DAT-013':
    'Explicit policy binds retention/environment and sensitive D1 reads to live email/MFA/administration permission. Dedicated HMAC pseudonyms replace raw session identifiers; bounded independent retention deletes only expired client telemetry with durable quotas and guarded atomic batches. Financial contracts/immutable facts are untouched, and unavailable outcomes are not labeled zero. Approved real retention, all dataset exports/audit/erasure and deployed maintenance acceptance remain open; status unchanged.'
}
const editorialCheckpointNotes: Record<string, string> = {
  'CAT-014':
    'A separate bounded editorial CSV v1 updates only six metadata fields of existing draft/review products. Own UTF-8 input, identity/version, immutable private preview, diff and human reason precede atomic D1 apply. Per-product audit, live permission/MFA, execution-time CAS and durable replay govern the batch. Revert is an audited new version and refuses intervening edits; no price/stock/media/publication authority is imported. SQLite/component gates and six actual disposable workerd HTTP/D1 scenarios pass, without outbound requests. Preparation of full import now also reuses the existing 71-column schema for browser-local CSV/XLSX inspection, with bounded archive/row/cell parsing, actual existing ExcelJS, formula/hyperlink rejection and no upload or mutation. This local check is not D1 authority, full apply/jobs/recovery or production acceptance; CAT-014 stays NOT_VERIFIED.',
  'CAT-015':
    'A separate nine-column editorial template exports current private draft/review identities, versions and six metadata fields, bounded to 100 products/1 MB with no silent truncation. Incomplete cells are preserved, formulas rejected and permission/MFA rechecked; the download is private/no-store and runs through actual disposable workerd HTTP/D1. The original full 71-column Node CSV/XLSX contract remains preserved, not replaced. Full filtered/complete native D1 CSV/XLSX exports and production acceptance are still outstanding; broad status remains NOT_VERIFIED.'
}
const catalogNativeImportCheckpoint =
  'Local native CSV/XLSX import retains the complete 71-column contract alongside the separate bounded editorial importer. Migrations 0054/0055 add immutable private previews, paginated staging, live references, seal and paginated diff; 0056 preserves variant colors while fixing the D1 LIKE/GLOB pattern limit. Migration 0057 adds atomic whole-job apply and exact compensation only while the complete recorded row set is unchanged and unused, with per-entity immutable audit and durable same-key replay. Current session, verified email, MFA, catalog.write, administration.manage, inventory.write, owner and CSRF checks govern commands and replay. New products remain drafts, initial prices/stock are audited and media remain pending verification; no publication, scanner verdict or original upload authority is fabricated. Directed SQLite/D1-limited service/HTTP, UI/component and Node XLSX regression checks pass, including null-safe exact audit predecessors and byte-window decoding. The October 7 disposable actual workerd audit passed 303 scenarios with 57 migrations, 13 compiled Chromium scenarios and zero outbound requests. Its native browser journey explicitly uploads three pages, reviews all 2404 diff entries across 97 pages, recovers lost successful responses by GET and exact same-key replay, and compensates both the whole 601-record job and bounded batch; the job retains 9015 immutable snapshots. The 60-case command/page integration regression preserves receipts and verifies live GET state, stale-feedback removal and mobile hash wrapping. On October 8 a separate maximum-volume local HTTP/D1 cycle passes 25000 records/79 pages/70631587 expanded bytes, late rollback, apply in 15.623 seconds and revert in 17.084 seconds, exact replays, 375000 snapshots, two receipts, unchanged counters and staged source, zero outbound requests and final temporary database cleanup. Query-plan regressions cover all three quadratic staging/apply/revert defects without relaxing guards. This does not certify deployed D1 limits; cloudLimitsAccepted and deployedAcceptance remain false. The separate real 25000-row XLSX proof passes all 1775000 fields exactly in 76.457 seconds (11253856 bytes), including Unicode/JSON; the 44334545-byte CSV is correctly rejected by the unchanged 20 MB cap. A one-row regression isolated Node writer surrogate corruption and the existing ExcelJS streaming writer fixes it without changing the decoder. The final integrated global gate and actual Oracle self-hosted CI remain pending. Genuine scanner/upload authority, real catalog/reference/media evidence and operational UAT remain open; broad status stays NOT_VERIFIED.'
const catalogNativeImportCheckpointNotes: Record<string, string> = {
  'CAT-014': catalogNativeImportCheckpoint,
  'ADM-018':
    catalogNativeImportCheckpoint +
    ' Panel confirmation preserves the original sent body/key for explicit ambiguous-delivery recovery and refreshes current state by GET; it does not certify all administrative import/export acceptance atoms.'
}
const paginationCheckpointNotes =
  'Local repository pagination acceptance: catalogue, category, search and resources expose unique page URLs and real previous/next anchors preserving filters. Current compiled Worker contracts compare actual D1 API rows with initial SSR product/resource links using 20 products (12 + 8) and 21 governed resources (20 + 1), with JavaScript disabled and scripts removed. Adjacent URLs, page-one normalization and the unfiltered resource page-two canonical are checked. Component controls cover first/last bounds, filter reset, failed reads and stale-content purging; existing incremental loading and filtered noindex policies remain intact. Discovery does not depend on infinite scroll. This is not deployed crawling, browser hydration or production acceptance; those remain pending.'
const functionalBatchCheckpointNotes: Record<string, string> = {
  'SEA-008': paginationCheckpointNotes,
  'SEO-011': paginationCheckpointNotes,
  'MKT-012':
    'Partial implementation: real owner-bound D1 cart/checkout associations require live verified identity, cart possession/version, separate explicit recovery consent and current global product-update consent. Configured abandonment wait, bounded cursor, immutable delivery deduplication, current catalog/price/stock checks and inactive/converted/withdrawn exclusion precede delivery. Recovery rotates the existing cart token through its actual serialized CartDO, preserves expiry, stores only hashes and returns possession exclusively by HttpOnly cookie. Real source/workerd/D1 HTTP resume, exact replay/recovery and live revocation pass with no outbound or economic effects. Approved timing/legal/sender policy, real delivery, compiled browser and deployed acceptance remain pending; feature and external delivery default OFF.',
  'MKT-013':
    'Partial implementation: dedicated false-default versioned opt-in and durable owner-scoped association share canonical current price/publication/inventory authority without reserving stock. Actual-send/claim frequency limits cover delayed and simultaneous cart/checkout reminders, including ambiguous provider outcomes. Recovery respects editorial newsletter caps; editorial newsletter and confirmed product signals also check the recovery cooldown at atomic claim and immediately before dispatch, while explicit confirmation remains exempt. Other directions of cross-marketing suppression, legal review, approved delivery configuration, compiled browser and deployed UAT remain pending; no provider send is claimed.',
  'CHK-020':
    'Partial implementation: explicit private recovery review uses a scrubbed owner-bound fragment, current server lines and a versioned command; CartDO resumes once through CAS, preserves TTL and recovers an exact receipt without exposing tokens in JSON or durable caches. UI rechecks the exact current cart, version and quantities after the receipt and purges authority changes; cart/checkout expose manual opt-in controls. Attribution, real post-purchase operational exclusion evidence, compiled browser and deployed acceptance remain pending.',
  'MKT-027':
    'Partial implementation: approved canonical CMS resources support category/kind search, author and experience, real editorial review windows, related currently published products/categories/resources and separate explicit double-opt-in newsletter access. Draft creation/restoration uses the existing versioned CMS commands without publication. Actual SFC SSR rendering proves initial content and author; privacy and stale-response controls remain. The canonical CMS sitemap emits a single resource URL and shares review eligibility across count, rows and final revalidation while preserving legacy content and empty shards. Approved business content, consent-aware measurement, joint rebuilt browser and deployed acceptance remain pending.',
  'SEO-027':
    'Partial implementation: canonical CMS metadata represents pillars/articles/landings, author experience, publication and reviewed/review-due dates, validated related resource/catalog links and a single resource canonical path. Public resource and ordinary CMS reads exclude invalid review windows. Sitemap count, bounded rows and final release validation share that eligibility and emit /recursos only for resources, without duplicating legacy /contenido URLs. Source SSR and directed D1/HTTP/component/sitemap controls are local evidence only; approved intent clusters/content, search acceptance and deployed UAT remain outstanding.',
  'SEA-016':
    'Partial implementation: governed resource landings reuse approved CMS content and current category/product targets with catalog category filters and resource canonical URLs. No product or sector content is invented and no empty unavailable source becomes a published page. Canonical CMS sitemap integration preserves legacy content and excludes invalid editorial review windows, including expiry during the read. Real problem/sector content, merchandising relevance, browser search and deployed acceptance remain unverified.',
  'MKT-017':
    'Partial implementation: D1 per-variant opt-in, owner-bound confirmation, immutable commands, cancellation, effective-price/real-stock observation and durable deduplicated delivery obligations reuse canonical publication, inventory and communication preferences without reserving stock or subscribing to newsletter. Fifteen SQLite core cases, one exact HTTP-detail case, nine scheduled-runtime cases and ten panel/page cases pass locally; confirmation fragments are scrubbed before login and never copied to its redirect. The clean canary-source workerd journey passes actual D1 create/detail/confirmation/cancellation/recovery and joint review/moderation/revocation, with 88 migrations, unchanged critical domain tables and zero outbound requests. Balanced internal SQL predicates preserve authority while respecting the real D1 expression-depth limit. Joint compiled/browser acceptance, approved marketing sender, actual delivery and deployed UAT remain pending. External delivery defaults OFF; fake-adapter success is not provider acceptance.',
  'MKT-024':
    'Partial implementation: immutable D1 submissions, audited moderation and customer replies, server-derived delivered-own-order verified-purchase evidence or an explicit unverified label, bounded public privacy projection and owner/role-aware private history. Eighteen combined core/HTTP cases, eight component cases and six PDP integration cases pass locally; the clean canary-source workerd journey also passes submission, enrolled-MFA moderation, public projection and live permission revocation against actual D1, without outbound requests or economic effects. Dedicated fraud/incentive policy and operational handling, real program data, joint compiled/browser acceptance and deployed UAT remain unverified. There are no community accounts or unreviewed automatic public posts.',
  'MKT-025':
    'Partial implementation: moderated product questions, reviewed expert answers, customer replies returning to moderation, explicit nullable SLA, safe public text projection and PDP reuse. Public readers do not gain private identity/order/receipt context; support.manage plus live verified MFA governs moderation and revoked grants fail closed. Eighteen combined core/HTTP cases, eight component cases and six PDP integration cases pass locally. Real expert/SLA policy, operational follow-up, source native and joint compiled/browser acceptance, production configuration and deployed UAT remain outstanding.',
  'CUS-017':
    'Partial implementation: read-only canonical customer context combines paginated own orders, retained support incidents, fiscal records, captured payments minus only actually settled refunds, recorded preferences and the explicit earliest retained follow-up. Support or administration plus verified live enrolled MFA gates entry; existing orders/payments/invoices/support/administration grants govern separate visible or explicitly redacted sections. Contact, tax, provider and authentication payloads are not projected; newsletter status remains unknown without an authoritative identity link. Sixteen core/HTTP and six component cases pass locally, including name searches with SQL NULL, revocation, outages, history integrity, role redaction and stale UI purging; actual Worker context/quote routing and late revocation also pass a SQLite-backed test. A clean actual canary-source/workerd/D1 journey also proves permission-redacted context and revoked sessions together with real CartDO/InventoryDO quote conversion. Joint compiled/browser, real data and deployed acceptance remain pending; context reads perform no impersonation, provider or economic writes.',
  'ORD-019':
    'Partial implementation: versioned D1 commercial drafts use canonical prices/quantity/shipping and explicit audited review and hash-bound approval. Administration plus live verified enrolled MFA governs commercial actions; catalogue authority is additionally required to expose existing cost/margin evidence, which remains null when unknown. Nineteen conversion, ten HTTP and sixteen panel cases pass locally, including price-lock, single global quote-to-order binding, immutable history, reserve-boundary revocation/future timestamps, shared pre-send hashes and lost-response recovery. Private owner-bound shipping preparation resolves approved goods only from D1; both directions of public repricing across the free-shipping threshold preserve approved charges while current rates, calendar, option hash, publication, VAT and stock remain revalidated. Creation uses explicit canonical product/variant selection, review and approval require confirmation, and uncertain conversion is recovered by GET without repeating POST. A clean canary-source/workerd journey proves actual CartDO and InventoryDO conversion, approved goods/parcel shipping despite public repricing, exact replay/receipt recovery, one order/reservation and live revocation with zero outbound and zero payment/fiscal attempts. Canonical invalid-address input is rejected before consuming the cart binding. Joint compiled/browser acceptance, real commercial UAT and deployed configuration remain pending.',
  'CUS-027':
    'Partial implementation: the verified owner can read approved governed commercial terms and convert through the existing checkout saga, inventory primitives and contractual order. The approved amount is preserved for its validity without accepting a client price, while publication, quantities, VAT, stock and shipping are revalidated. Foreign/revoked owners, stale approval and duplicate cart/key bindings fail closed or recover the same order; no new bearer or customer MFA requirement is invented. Nineteen conversion, ten HTTP and sixteen shared admin/customer panel cases pass locally. Owner-bound shipping preparation preserves approved charges across both public-price/free-shipping threshold crossings without changing the public shipping API; the customer explicitly confirms the current matching cart and recovers ambiguous conversion by exact receipt GET, never automatic POST retry. Clean actual canary-source/workerd/D1 conversion through CartDO and InventoryDO now passes approved price-lock, parcel charges, exact receipt recovery and live revocation without outbound/payment/fiscal effects. Joint compiled/browser, provider and deployed UAT remain unverified.',
  'SEC-003':
    'Partial implementation: explicit environment configuration rejects secrets in vars, and demo secret generation matches the runtime key formats without overwriting existing secrets. Pinned Gitleaks 8.24.3 has a mandatory CI policy probe; six real local scans detect synthetic canaries in ordinary/example/test paths and deleted Git history while accepting placeholders. The removed plural global allowlist was inert in this version; no bypass fix is claimed. Deployed secret bindings by environment, rotation, least privilege and access audit remain pending; local scanning does not certify complete Oracle CI or operational secret management.',
  'TST-009':
    'Partial implementation: local workerd/Miniflare tests exercise real D1 and SQLite-backed Durable Objects, concurrent serialization, exact replay, rollback, constraints, persisted restart and alarms. The directed D1/DO persistence band passed 23 local cases; migration upgrades and actual canary HTTP security flows provide additional native evidence without provider traffic. This is not the complete integral native suite or its controlled remote execution. Full integral native suite, controlled remote acceptance and complete Oracle CI remain pending.',
  'CIC-006':
    'Partial implementation: Cloudflare artifact emission and verification bind the Worker/assets, lock-derived SBOM, toolchain and explicit source/build hashes; dependency and bundle-policy tests reject prohibited content and malformed evidence. The SBOM describes lock supply-chain dependencies, not proof of an installed or deployed environment. Startup limits, independent reproducibility, blocking vulnerability checks in complete Oracle CI and hosted operational acceptance remain pending; local build evidence does not certify them.',
  'CIC-007':
    'Partial implementation: reviewed Terraform/OpenTofu files describe environment-scoped data, queues and optional edge resources, while Wrangler retains Worker/assets, Durable Objects, Workflow/Cron and consumers without duplicate ownership. The strict offline environment DTO and generator validate explicit bindings without adopting existing demo resources or provisioning anything. Actual local OpenTofu 1.10.6/Cloudflare 5.25.0 ARM64 validation passed with zero errors and warnings; 16 unit cases cover the fail-closed offline CI gate. Its sealed toolchain and user/network namespace capability are not yet verified on the runner. Clean remote recreation, reviewed remote state/credentials, complete Oracle CI and deployed recovery acceptance remain pending; source configuration is not evidence of a recreated environment.',
  'UI-005':
    'Operator-private saved order views persist bounded filter/sort/column configuration, never search text, selected IDs, customer snapshots or tokens. Operational pages now use sealed ten-minute keyset cursors bound to the live administrator/session and complete query; all four sorts work in both directions without OFFSET, and an emptied live page retains its return path. Explicit selection is limited to 25 confirmed visible orders and clears on context or authority changes. Bulk preview captures real eligibility and versions; an immutable D1 group freezes the reviewed intent and deterministic child keys. Queue processing executes one canonical fulfillment command per invocation, revalidates enrolled MFA inside the atomic child commit, records honest applied/rejected/not_attempted/unknown results, and recovers lost responses through explicit receipt GETs. Continuations ACK only after successful publication; bounded Cron recovery republishes durable pending obligations. No bulk action changes economic or inventory state. The directed SQLite/native SOURCE workerd tests cover simultaneous duplicate deliveries, revocation, rollback, history replacement guards and conservative query bounds; mounted components cover recovery and live-empty navigation. Full compiled-browser/accessibility journeys, operational scale and deployed acceptance remain pending. NOT_VERIFIED unchanged.',
  'PDP-004':
    'The real product page uses an accessible headless image dialog over its existing governed-media resolver. High resolution is requested only while open; variant/source changes close stale images. Focus containment/restoration, Escape/backdrop close, keyboard and touch-button zoom/pan, bounded manual image retry and reduced-motion behavior are implemented without new assets or remote URL authority. Reserved main-image geometry is retained. This is partial implementation: reviewed real imagery, complete multi-image galleries, measured layout/performance and browser/screen-reader acceptance remain pending.',
  'MED-010':
    'The product viewer reuses the installed headless dialog and existing publication-bound image derivatives, with focus containment, contextual alt, keyboard and touch-button zoom/pan, deferred high-resolution rendering and explicit bounded retry. It does not invent photographs, captions or media rights. This is partial implementation: complete approved multi-image content, responsive visual review, browser accessibility and production acceptance remain pending.',
  'ADM-005':
    'Cloudflare central audit reads 38 existing immutable administrative source families with bounded filters, keyset cursors and explicitly unknown historical metadata; customer self-service, provider automation, application logs and unclassified historical cancellations are excluded. Detail exposes only governed before/after fields, never arbitrary payloads or free-text reasons. Missing or mismatched paired audits reject the scoped history/export instead of hiding damaged records. Review uses live enrolled MFA, current administration.manage, version CAS and immutable actor/session/ingress-HMAC receipts. Export is explicit, actor-bound and idempotent, capped at 1000 rows/2 MB with exact CSV digest/bytes and private download access expiring after 24 hours; expiry is not deletion or the asynchronous encrypted export acceptance of ADM-019. New cancellation producers record their real audience/session/request metadata without rewriting historical proofs. Directed service, HTTP, component and disposable canary-source/workerd D1 checks pass; compiled Chromium, complete source-family operational review, retention policy and deployed acceptance remain pending.',
  'ADM-004':
    'Existing verified active accounts accept bounded invitations only with real enrolled MFA and a live session. Issuance delegates a currently owned, nonempty role policy; acceptance rechecks current issuer identity/version/permissions and the frozen policy, consumes once, grants, audits and revokes recipient sessions atomically. Issuer logout alone does not shorten the invitation TTL. Browser-generated secrets remain memory-only, with only hashes persisted; explicit actor-bound receipt recovery never resends an uncertain acceptance. The separate local-only first-admin CLI defaults to a read-only plan and requires an exact plan hash, command UUID and reason before one atomic statement; it does not create identities, passwords or policy seeds, and is not a remote recovery tool. Compiled browser, real account/policy provisioning and deployed acceptance remain pending.',
  'SEA-002':
    'Partial implementation: the real search page distinguishes pending, failed and successful reads. A failed API read does not announce zero matches or present cached rows as current. An explicit single-flight retry reuses the existing products GET and retains query, filters and ordering. Directed mounted-page checks do not certify complete keyboard/screen-reader behavior, measured latency or compiled browser acceptance; these remain pending. NOT_VERIFIED unchanged.',
  'SEA-010':
    'Partial implementation: confirmed successful empty search retains catalog and filter-removal links; loading and API errors no longer masquerade as zero results. An explicit retry recovers the same query without automatic repetition or a new endpoint. Full correction suggestions, approved contact/budget guidance, query measurement and compiled browser acceptance remain pending. NOT_VERIFIED unchanged.',
  'SEO-005':
    'Partial implementation: search remains noindex and does not emit canonical or language-alternate links targeting a noindex search URL. The real head manager retains the configured public origin and clean paginated catalog/category and product canonicals, removing tracking, ordering and SKU parameters as before. Complete redirect/error/noindex destination verification across every entity and deployed browser acceptance remain pending. NOT_VERIFIED unchanged.',
  'MKT-004':
    'Partial implementation: contextual banners, bars and cards reuse existing immutable CMS versions, live publication/media evidence, scheduling and device-pinned preview grants. A visual metadata editor selects public placements, exact paths/category/product slugs and priority, without personal targeting or another CMS. Public batched reads exclude drafts and recheck current release/media authority; ordinary pages remain compatible. The same accessible block renderer serves storefront and private preview, without preview measurement. Consented visible impressions and explicit CTA clicks use strictly typed client-reported IDs, separate additive D1 telemetry, global idempotency and bounded atomic retention; they never certify publication or sales. Compiled browser, reviewed visual/accessibility acceptance, real editorial policy and deployed acceptance remain pending; NOT_VERIFIED unchanged.',
  'MKT-006':
    'Partial implementation: storefront trust messages link delivery, stock availability, returns, support and payment to the applicable conditions instead of a generic trust seal or unsupported fixed delivery promise. Contextual CMS content can add explicitly approved messages using canonical safe CTAs. Public rendering does not infer live carrier commitments or validate an editorial claim merely because it is published. Complete real-business content review, compiled browser and operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'COM-011':
    'Partial implementation: a metadata-only paginated history requires current administration.manage, verified email and MFA; support.manage alone does not expose global financial context. It omits recipient, body, source/customer identity, provider identifiers and security/marketing mail. A human-reviewed, actor/hash-bound immutable command rearms only proven order.created or public support preparation_failed pending work, with live source/retention authority and attempts/availability CAS; it does not invoke a sender, reset attempts or create an outbox event. Sending, sent, ambiguous, suppressed, exhausted and unsupported sources cannot be rearmed. The panel explicitly reads, freezes reviewed intent, never automatically repeats uncertain POSTs, recovers exact receipts and confirms current event metadata; authority/context loss purges private state. Compiled browser, real provider delivery and complete support-scoped operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'CAT-010':
    'Partial implementation: explicitly reviewed directed substitute, compatible, accessory and equivalent product relations use versioned D1 snapshots, live catalog.write/email/MFA authority, atomic CAS and immutable receipts with manual recovery. Public batched reads expose only currently published valid endpoints and canonical effective gross/net prices, never review references, reasons or private costs. PDP, cart and support consume the same bounded public projection separately from generic same-category recommendations; no automatic substitution, inferred reciprocity, chemical advice or cart ADD. Local targeted evidence does not certify technical review of the real catalog. Compiled browser and deployed acceptance remain pending.',
  'CHK-018':
    'Cloudflare saves a server-owned cart snapshot atomically into existing favorite lists, with live verified owner, original cart possession/version and durable actor-bound idempotent receipts. Sharing is explicit, immutable variant/quantity only, with a separate 24-hour HMAC capability stored only as a token hash; tokens travel in an ephemeral URL fragment and bounded POST body, never API query or persisted client storage. Owner revocation, expiry, deleted-list invalidation and active owner identity/customer gate public access. Public preview reuses canonical live prices/tiers/tax/quantity/stock and releases only published public fields, never costs, private tariffs, contact data or coupon. UI freezes the original cart before hashing and sends a matching cart-id header, handles uncertain results and historical receipts without recreating lists, and copies only explicitly confirmed lines using sequential existing cart ADD with no automatic retry of an uncertain line. Original cart, stock and reservations are not mutated by save/share/read. Local real D1 and canary/workerd evidence is not compiled-browser acceptance. Compiled browser and deployed acceptance remain pending.',
  'PRI-012':
    'Private D1 basket simulation resolves current effective prices, volume tiers, tax, quantities, shipping eligibility, customer segment and redemption counters from authoritative sources. The proposed rule is evaluated active in memory without activation, reservation, cart, quote or usage writes. Shared canonical pricing and shipping queries avoid duplicated policies. Real variants.cost_net_cents distinguishes unknown from known zero; base, volume and permitted proposed-rule results expose merchandise net cost, margin and loss, without treating buyer shipping charges as profit or cost of fulfillment. Shipping rates are customer charges, not shipping operational cost; operational cost and total profit remain unknown. Cost reads require the atomic live intersection of catalog.write and administration.manage with verified email/MFA before and after asynchronous reads. Directed service, HTTP, UI and actual workerd D1 checks target read-only behavior, integer cents, combinations and revocation. Compiled browser and deployed acceptance remain pending.',
  'CHK-016':
    'Cloudflare checkout adds optional purchaseOrderReference, normalized to bounded single-line NFC text and stored immutably with the accepted order, separate from fiscal identity and delivery instructions. Its exact value participates in the frozen checkout command and same-key conflict contract; blank omission preserves historical payloads. Owner/guest, administrative detail and preparation reads retain current authorization, without adding references to public lists or search. Migration preserves historical amounts and NULL references. Local service, HTTP, UI and native checks target persistence, replay, invalid input before reservation, text escaping and authority revoked during asynchronous reads; no fiscal provider payload or financial amounts are changed. Compiled browser and deployed acceptance remain pending.',
  'PRI-013':
    'Cloudflare adds governed code/calendar/channel/segment rules, immutable revisions, live administration.manage/MFA commands, CAS, audit and exact receipt recovery. Server-side quotes and accepted orders share effective prices, volume tiers, money/tax and authoritative customer identity. Global/customer use limits commit atomically with the order; replay never consumes again and a competing last-use rollback compensates its own reservation. Uses count accepted orders, including subsequently abandoned unpaid orders; no automatic quota restoration is claimed. Actual workerd D1/all73 and cart DO pass local administration/checkout/replay/limit acceptance. Compiled browser, deployed operation and approved campaign policy remain unverified.',
  'PRI-016':
    'The explicit coupon/volume-tier matrix supports stack_volume, exclude_volume and best_of_volume; fixed/percentage discounts allocate integer cents deterministically and preserve exact net/tax/gross through order, fiscal source and partial refunds. One coupon per quote is supported. Other automatic promotions, bundles, gifts, free-shipping benefits and a complete cross-promotion matrix are not implemented. Local service/native evidence is not full compiled-browser or production acceptance.',
  'CHK-019':
    'Cloudflare checkout accepts only a coupon code; server-owned eligibility feedback reveals no private rule or customer counter. Applying/removing a code invalidates shipping intent, and uncertain checkout preserves the exact original command. Customer/admin order views expose contractual discounts without subtracting twice; historical no-coupon orders retain their amounts. Zero payable orders are rejected before reservation or use because a no-payment completion flow is not implemented. Compiled browser and deployed acceptance remain pending.',
  'ORD-008':
    'Partial implementation: a purpose-separated HMAC link is exchanged before SSR for a clean canonical URL and a separate sealed HttpOnly/Secure/SameSite cookie. Public exchange rejects the original payment bearer. The internal email issuer reconstructs authority only from the confirmed order.created occurrence, completed checkout attempt and matching command; the view link exists only in the prepared message, never in outbox payloads. The existing dispatcher rechecks source, recipient, current hash, revocation and original expiry atomically before its sending marker. Revoked or expired receipts omit the link; an authority race cannot send a stale prepared link. Delivery remains explicitly disabled by default and tests use only a fake sender. Cookie access is read-only, capped at 30 minutes and the original 24-hour grant; logout with existing valid CSRF revokes every guest cookie for that order. Main order DTO marks view_only and the page removes payment actions and stale intents without claiming the reservation expired. Current D1 authority is rechecked after asynchronous reads. Landing and POST reject foreign origins, malformed bodies, unsupported aliases and unavailable configuration without rendering credentials. Existing checkout/payment and Node behavior are preserved. Directed SQLite, actual workerd D1, real entrypoint, scheduled wiring and SFC tests pass. Compiled browser, provider delivery, operational and global CI acceptance remain pending; NOT_VERIFIED is not complete acceptance.',
  'SUP-002':
    'Cloudflare category and product contact actions preserve the current canonical slug through the existing contact form into the support ticket; the confirmed customer/admin facts show only context retained in the current DTO. Declared catalog references never prove order ownership or technical advice. Losing authority purges private drafts and prepared intent even for the same actor; recovering authority never sends automatically. Existing exact command recovery and Node behavior are retained. Directed component checks pass; compiled browser, complete anti-spam, operational SLA and provider acceptance remain pending. Broad status unchanged.',
  'SUP-003':
    'The support file now exposes declared product/category context from its current authorized DTO with canonical links, separate from permission-filtered order context. Withdrawn or retention-redacted context is not reconstructed from a previous snapshot. Category/PDP entry and contact intent are tested without adding endpoints or unsolicited sends. This closes a contextual UI gap, not the whole support domain; compiled browser, end-to-end operational SLA and external delivery acceptance remain pending. Broad status unchanged.',
  'SEA-017':
    'Partial implementation: the Cloudflare quick-order page accepts at most ten CSV reference/quantity rows and 8 KiB, reports row errors, requires exact observed SKU/EAN/GTIN/MPN matches and validates current quantity rules, VAT, volume tiers and availability through existing public contracts. Capped search results are not proof of global uniqueness or exhaustive catalog coverage. Preview is read-only; selection and explicit consent precede single-flight cart additions. An ambiguous ADD stops the batch and cannot be replayed automatically by this panel; current session changes purge private buffers. Cloudflare desktop/mobile headers expose the actual route and Node remains explicitly unsupported. Directed Node, SFC and real HTTP/workerd D1 checks pass with no preview writes or outbound. Compiled browser, exhaustive matching and operational acceptance remain pending; NOT_VERIFIED is not completion.',
  'CUS-026':
    'Partial implementation: the existing cart store and authoritative public product contracts support bounded SKU/EAN/CSV preview for guests, individuals and companies, without inventing a separate B2B price policy. Quantity multiples, volume prices and VAT use existing shared rules; duplicates and ambiguous matches are rejected before explicit selected additions. Lost responses preserve cart recovery authority and block unsent lines rather than silently retrying. Preview amounts are current observed merchandise values, not a contractual full quote or shipping commitment. Directed Node, component and actual HTTP/workerd D1 checks pass. Complete pre-cart contractual quotation, exhaustive catalog resolution, compiled browser and operational acceptance remain pending; NOT_VERIFIED is not completion.',
  'INT-002':
    'Partial implementation: existing fiscal and email outboxes commit with their domain effects, use durable fenced publication, deduplicated consumers and receipt reconciliation. A reproduced Cron failure previously starved independent email obligations; isolated bounded stages now continue unrelated work while rejecting the invocation with observable failures. Reconcile and publish retain their dependency chain. Directed SQLite/runtime tests pass without provider sends. CanaryWorkflow only validates bindings; deployed Queue delivery, business Workflows, operational reconciliation and complete Oracle CI remain pending. NOT_VERIFIED is not production acceptance.',
  'TST-010':
    'Partial implementation: seven directed tests apply all 66 real migrations from empty SQLite and workerd D1, upgrade populated 0055/0062 baselines, preserve recorded fields and exercise post-upgrade ownership, CAS, append-only audit and replay. A deliberate final-statement failure rolls back migration0066 DDL/data and the original SQL then succeeds by forward retry in both engines. SQLite additionally checks integrity; D1 checks foreign keys and executable contracts without its unsupported integrity_check pragma. No migration defect was detected and no artificial RED is claimed. Controlled deployed upgrades, the production recovery runbook and complete Oracle CI remain pending. NOT_VERIFIED is not operational acceptance.',
  'CUS-002':
    'Historical repository evidence and the single-company/no-branches scope are retained. A separate immutable D1 administrative review command uses the existing company change identifier and state machine, current verified-email/MFA/administration.manage authority, CAS and exact durable replay. Bounded literal company/NIF reads and private receipts support manual recovery. The Cloudflare panel validates acknowledgement and current GET state, blocks competing actions while delivery is ambiguous and purges private input on hard authority boundaries; Node remains unchanged. Directed service, HTTP, actual D1 and component checks pass. This does not grant roles, credit, commercial terms or external fiscal approval. Compiled browser, operational and provider acceptance remain pending; repository evidence is not production completion.',
  'CUS-009':
    'Partial implementation: the Cloudflare account overview reads actual owner-scoped order, profile, address and favorite contracts independently, validates bounded DTOs and distinguishes failed reads from confirmed empty state. Identity, verified email and session version bind private state; authority changes and unmount purge buffers and late responses. Last-order lines correlate with the current owner/order, never an undefined endpoint. The existing 200-order subset is labelled consulted rather than a global total. Node behavior is retained and directed component checks pass. Complete company authorization, invoice signed-PDF delivery, compiled browser and operational acceptance remain pending; broad NOT_VERIFIED is unchanged.',
  'CUS-008':
    'Partial implementation: two separately chosen commercial email purposes use explicit current-owner commands, recorded policy/text hash/date and an immutable D1 consent audit. Defaults are off without fabricating consent; CAS and exact recovery protect repeated or ambiguous writes. Newsletter retains its separate double opt-in authority. Contract, privacy, profiling and cookies are not granted by these controls. Directed SQLite, HTTP, actual D1 and component checks pass; complete purpose/channel governance, approved policy, compiled browser and operational acceptance remain pending. Broad NOT_VERIFIED is unchanged.',
  'CUS-010':
    'Partial implementation: the Cloudflare account page integrates email preferences for product updates and replenishment with private current-owner reads, CAS, immutable commands, exact receipts and explicit recovery. A matching acknowledgement plus fresh GET precedes UI success; identity/email/session boundaries clear state and late callbacks. Newsletter remains independently governed, and Node behavior is preserved. Saving does not send messages or activate automation. SMS, WhatsApp, provider suppression, full frequency/channel synchronization, compiled browser and operational acceptance remain pending; broad NOT_VERIFIED is unchanged.',
  'CUS-012':
    'Partial implementation: authenticated Cloudflare customers register durable idempotent privacy requests, recover their receipt and download minimized owner-only JSON. Migration0071 security notices are exported by the currently authorized identity, never by recipient email or shared customer alone, preserving historical recipients and stable order without IDs, credentials or fiscal payload. Required securityNotices is empty when absent; the 1001st row rejects instead of truncating, preserving the 2 MiB cap and final live authority check. The browser bridge additionally compares the downloaded notices with the actual owner ledger. Real canary/workerd HTTP exercises five notices, foreign denial and revocation with zero outbound. Preferences reflect actual records, not invented consent. UI acknowledgement, current GET and explicit ambiguous-intent recovery remain intact. Anonymization only records a request; no financial data are deleted and the inherited 30-day due date is operational, not legal evidence. Complete data-subject coverage, legal exceptions/retention, executed anonymization, compiled browser and operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'CUS-007':
    'Partial implementation: Cloudflare professional submissions, administrative approval, address book and checkout share existing normalization and the existing Spanish DNI/NIE/CIF checksum validator. Professional and approval use require a nonempty normalized identifier; address tax ID stays optional and checkout retains its supplied-value and ES-only rules. Other countries keep the existing structural fallback, without tax-authority or VAT validity claims. Account and address forms reject invalid identifiers before transport and preserve corrections and sensitive-command guards. Directed RED/GREEN covers invalid checksums, normalized-empty required values, field errors, no domain/notices on rejection, valid duplicates and unchanged legacy Node contracts. Native canary/workerd HTTP rejects invalid professional/address data with 400 and no domain/outbox changes. Country-complete validation, real fiscal approval, compiled browser and operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'CUS-001':
    'Historical repository evidence is retained. Current Cloudflare profile, address and security pages validate the existing D1 DTOs and bind private reads and mutations to identity, verified email and session version. Single-flight writes retain their submitted intent; receipt and fresh GET confirmation precede success, ambiguous outcomes require explicit read recovery, and authority changes/unmount purge private buffers and late feedback. Password rotation permits only the acknowledged same-session version increment; MFA setup and recovery codes remain private and are cleared across boundaries. Directed component regressions preserve existing Node behavior. Full account, provider, compiled browser, legal and operational acceptance remain pending; repository evidence is not production completion.',
  'CUS-005':
    'Partial implementation: Cloudflare profile/company and security forms retain current D1 ownership, acknowledgement, fresh-read confirmation and secret-buffer isolation. Sensitive commands preserve password reauthentication, configured MFA and live session checks. Completed password reset, authenticated password change, MFA activation, verified email change and fiscal presentation now commit security sources and outbox atomically with their effects. Email changes warn both immutable historical recipients, never a later profile address; fiscal notices explicitly do not grant approval. Registered renderers revalidate source, recipient and live authority at the pre-send boundary, exclude credentials and fiscal payload, and ignore marketing/delivery opt-outs. Directed service/HTTP/outbox/fake-dispatch checks cover rollback, replay, races, disabled delivery, corruption, bounded pre-send outages and unknown-send no-retry. A native acceptance compiles actual canary and dispatcher into workerd with all 71 migrations, exercises all four new HTTP flows, five fake sends, queue replay, rollback and unchanged domain snapshots with zero outbound. Existing reset and delivery-preference native regressions and populated migration upgrades pass. Migration0071 preserves pending outbox/child receipts; an explicit final FK guard rejects injected orphans before resetting deferred bookkeeping, in both SQLite and native D1. Fiscal/email approval, real mailbox/provider, compiled browser and operational/production acceptance remain pending; NOT_VERIFIED unchanged.',
  'CUS-006':
    'Partial implementation: Cloudflare address-book UI validates the existing D1 UUID/kind/default/nullable/timestamp contract and bounded input, isolates submitted bodies and requires acknowledgement plus a current matching GET before success. Server-side single-line fields normalize to NFC and reject C0/C1/DEL and Unicode line separators before trimming; multiline instructions retain their existing policy. Strict HTTP rejection of unknown/foreign keys is preserved, inputs are not mutated and historical addresses are not rewritten. Unknown writes block competing actions until explicit read review; a missing acknowledgement never proves no commit. Identity/email/session changes and unmount clear address PII, dialogs and stale results. Existing Node behavior remains unchanged. Full country/address policy, contractual fulfillment, compiled browser and operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'ORD-012':
    'Partial implementation: versioned fulfillment, unpaid cancellation, return requested/status and payment-confirmed renderers reuse the existing transactional outbox, atomically recording immutable references with their domain commands. Source verification binds current projection, full command/audit/receipt proof, historical recipient and verified captured-payment claim/inventory assignment. Escaped content excludes internal notes/reasons and does not claim bank settlement, automatic restocking or reimbursement. Explicit opt-ins remain empty and delivery disabled by default; obsolete sources require manual review and unknown sends are not automatically retried. Directed SQLite/runtime tests pass. Five additional native compiled workerd/D1 scenarios use only synthetic recipients and a fake sender: six current targets, fifteen obsolete sources, exact replay and unchanged domain digest. The next frozen bundle passes 385 scenarios/63 migrations/zero outbound, including all 25 required Chromium journeys; desktop/mobile history, annotations and cancellation recover lost successful responses without duplicating their writes. Delivered current states cover delivered, cancelled, captured and return resolution_ready; other delivery states, rejected-return native coverage, native unknown-send proof, real mailbox/provider and operational acceptance remain pending. Broad NOT_VERIFIED stays unchanged.',
  'ORD-010':
    'Partial implementation: private Cloudflare order annotations provide append-only notes with actor/date and versioned operational labels. Current verified administrators with MFA and administration.manage read bounded keyset pages, submit CAS/idempotent commands and recover exact receipts. SQL guards enforce immutable history, fresh authority and concurrent versioning; matching concurrent replay returns the original receipt. The panel purges private state on authority changes, retains ambiguous intent, blocks competing order actions and resolves obsolete CAS only after fresh state and a second receipt lookup; new submission remains explicit. Customer reads, safe timelines and CSV do not expose annotations. Directed component, HTTP and actual D1 regressions pass; compiled browser/UAT and complete operational acceptance remain pending. Broad NOT_VERIFIED is unchanged.',
  'ORD-004':
    'Partial implementation: existing fulfillment and RMA transitions are retained. A separate live-authorized unpaid cancellation uses one D1 transaction for eligibility, exact reservation release, order state, durable command, immutable audit and final guards. It refuses every existing payment attempt, preparation or fiscal history; payment initiation rechecks order/reservation and the fresh SQL clock inside its batch. Exact replay, rollback, races and postcommit revocation are tested on SQLite and actual D1. Paid cancellation and complete operational/provider/browser acceptance remain pending; NOT_VERIFIED unchanged.',
  'ORD-005':
    'Partial implementation limited to awaiting-payment orders that have never initiated any payment. Verified owners and current MFA administrators can explicitly cancel with a reason; one atomic transaction releases valid inventory without duplicating stock or rewriting contractual snapshots. Durable receipts and the confirmed timeline support recovery; ambiguous delivery retains the original key/body and blocks competing actions. No refund, Beply or carrier operation is attempted. Cancellation after any payment attempt, paid resolution, external provider coordination and compiled browser/UAT remain pending; NOT_VERIFIED unchanged.',
  'ORD-015':
    'Partial implementation: the Cloudflare operational workbench exposes paginated reads, explicit search and payment/order/shipping/customer/date filters, stable sort, and one selected governed fulfillment context. Literal bound NIF/CIF search reads buyer tax identity or contractual billing NIF without adding tax identifiers to response rows; list and export share the same query. Read-only CSV exports use the same filters/order and confirmed applied query, all matching rows within explicit 1000-row/2 MB limits, UTF-8/BOM/CRLF, formula protection and minor-unit amounts; oversized results fail without truncation. Current session/email/MFA/grant checks precede reads and finish with fresh SQL authority. The client validates bytes/headers, purges private buffers and revokes object URLs. Failed reads are not empty results; pending commands block competing queue/navigation/export actions while preserving manual recovery. Node retains its existing page. Carrier/exception coverage, compiled browser/UAT and operational acceptance remain pending; NOT_VERIFIED unchanged.',
  'ORD-003':
    'Partial implementation: Cloudflare owner and administration timelines project confirmed checkout, payment, fulfillment, return, refund and fiscal/credit records using existing immutable commands, audit and receipts. Private bounded GETs bind cursors to order/audience and recheck current ownership, verified identity and administrative MFA/grants independently of the event cutoff. Safe customer/admin DTOs omit actor, reason, payload, correlation and PII; source evidence remains in existing durable ledgers. Local validation financial records are explicitly marked, legacy payment markers remain unknown and capture does not claim bank settlement. The client mounts only for an authenticated open current order; admin replaces only the Cloudflare legacy block and Node stays unchanged. Guest access, source-specific operational audit acceptance, compiled browser/UAT and global CI remain pending; broad status stays NOT_VERIFIED.',
  'ORD-018':
    'Partial implementation: explicit reorder preserves the contractual historical quantities and gross prices while displaying separately observed current gross/net prices, VAT, quantity limits and single-location availability from the existing authoritative pricing/inventory rules. Current offers are read with final live ownership at one SQL clock; unpublished/zero-price offers are unavailable and nonpurchasable quantities are excluded. Cloudflare rejects a missing current-offer field; Node retains its existing optional contract. Single-flight intent excludes confirmed lines; an ambiguous ADD stops before unsent lines. Cloudflare stores a bounded non-PII recovery journal and reads an authenticated exact-command receipt, then the current cart. Explicit replay retains its body/key/version and server-checked original cart header; unknown never proves no commit. Pending ADDs block cart mutations, delivery quotes, order creation and payment across awaits. Scope changes invalidate late results; Node retains tab-local recovery. Directed component, HTTP and actual workerd D1 tests pass. Substitutes and compiled browser/operational acceptance remain pending; broad status stays NOT_VERIFIED.',
  'SEA-005':
    'Cloudflare D1 now implements persisted preview, live catalog.write/MFA authorization, CAS, immutable command history and actor-scoped recovery/replay. Public suggestions and product lists share bounded nonrecursive expansion, including SKU aliases; search candidates are materialized before deep authority/facet expressions without adding a read or dropping publication rules. Directed service/HTTP/UI and actual workerd D1 regressions pass. Browser/global CI acceptance and approved business synonym configuration remain pending; broad status stays NOT_VERIFIED.',
  'SUP-007':
    'Published CMS documents can explicitly opt into categorized public knowledge with a review deadline. Search/category pagination excludes drafts, withdrawn, invalid and review-overdue content; anonymous helpful feedback has durable same-key recovery without PII. The help page and existing CMS editor use this contract, independently of private ticket configuration. Directed schema/service/HTTP/UI tests pass. Approved content for all seven topics, operational review practice, compiled browser/UAT and global release acceptance remain pending; broad status stays NOT_VERIFIED.',
  'UI-003':
    'Cloudflare navigation derives from live session-bound capability reads and exposes only existing authorized destinations. The keyboard/focus-managed command palette, contextual breadcrumbs and five canonical visited destinations use those links. Global entity search reads private products by name/SKU and orders by identifier with literal Spanish-folded queries, bounded exact-first results and live per-source permissions before/after; it returns only existing detail destinations and no order PII or amounts. Its UI submits explicit reads, validates the shared DTO and authorized roots, and purges stale results on query/session/grant changes. A separate bounded activity reader verifies immutable audits against their durable commands across eight existing sources, rechecks live permissions and exposes only canonical destinations/action/time without actor, payload or customer data. Its GET and cursor are read-only; the UI distinguishes loading/error/confirmed empty and purges late data on authority changes. Visited pages remain distinct from audited actions. Directed service/HTTP/component and actual workerd D1 tests pass. Every P0 two-level journey and compiled browser/operational acceptance remain pending; broad status stays NOT_VERIFIED.'
}
const rows = requirements.map((requirement) => {
  const scoped = scopedRequirements[requirement.id]
  const status = statusFor(requirement)
  const update = traceabilityUpdates[requirement.id]
  const operationalEvidence =
    update?.operational_evidence ?? (status === 'PARTIAL_EXTERNAL' ? 'Required before phase acceptance' : '')
  const externalOwner =
    update?.external_owner ??
    (status === 'PARTIAL_EXTERNAL'
      ? requirement.id === 'TST-040'
        ? 'Warehouse/Administration/Support/Release management'
        : 'Business/Operations/Legal/Provider (assign explicitly)'
      : '')
  const defaultNotes =
    status === 'DISCARDED'
      ? 'Descartado por decisión del usuario el 2026-09-08; fuera del alcance activo, no completado. Ver docs/production/alcance-vigente.md.'
      : scoped
        ? 'Alcance adaptado el 2026-09-08; estado de evidencia conservado, sin reclamar trabajo nuevo. Ver docs/production/alcance-vigente.md.'
        : status === 'REPO_EVIDENCE'
          ? 'Repository evidence is not production acceptance; execute the stated criterion and retain evidence.'
          : status === 'NOT_VERIFIED'
            ? 'No pass claim: inspect every acceptance atom before changing this status.'
            : status === 'ROADMAP_NOT_STARTED'
              ? 'Minimum phase is after Alpha; intentionally not claimed by the current production-candidate scope.'
              : status === 'MISSING'
                ? 'Known repository gap.'
                : 'Provider, contract, real data, approval or operational exercise remains outstanding.'
  const checkpointNotes =
    (requirement.id === 'CAT-015'
      ? 'The distinct native_catalog_snapshot_v1 profile exports complete or q/category/status-filtered D1 products, including native/unmapped identities, all variant states, original attributes, nullable fields, inventory, effective and historical prices, retained media associations and scoped references. One consistent read-only batch, joint live catalog.write/administration.manage/email/MFA, late reauthorization, server UUID/time and a verified SHA-256 bind the snapshot. CSV preserves all entities as sheet,row_index,record_json plus Manifest; browser-only existing ExcelJS emits six string-cell sheets plus Manifest with no formulas/hyperlinks or Node codec in the Worker. Limits of 1000 products/10000 aggregate rows/8 MB/20K-cell reject rather than truncate; cumulative own-data and SQL count/byte budgets precede projection. Local SQLite tests enforce expression100/parameters100/functionArgs32/compound5; compiled Chrome downloads both real formats on desktop/mobile through actual disposable workerd. Global suites pass 5521 units/200 files and 1922 components/52 files; paired build/bundle policy passes and 278 native scenarios retain 53 migrations and zero outbound requests. This closes repository implementation of the export atoms, not full import, remote deployment, provider or production acceptance.'
      : undefined) ??
    functionalBatchCheckpointNotes[requirement.id] ??
    catalogNativeImportCheckpointNotes[requirement.id] ??
    editorialCheckpointNotes[requirement.id] ??
    phaseFourCheckpointNotes[requirement.id] ??
    phaseThreeCheckpointNotes[requirement.id] ??
    phaseTwoCheckpointNotes[requirement.id] ??
    nativeOperationsCheckpointNotes[requirement.id] ??
    executionCheckpointNotes[requirement.id] ??
    configurationCheckpointNotes[requirement.id] ??
    inventoryCheckpointNotes[requirement.id] ??
    pricingCheckpointNotes[requirement.id] ??
    mediaCheckpointNotes[requirement.id] ??
    defaultNotes
  const notes = update
    ? update.notes
    : currentPartialImplementation.has(requirement.id)
      ? checkpointNotes.replace(/(?:roadmap )?status unchanged\./gi, '').trimEnd() +
        ' Partial implementation; acceptance remains NOT_VERIFIED. last_verified records documentary review, not executed acceptance.'
      : checkpointNotes
  return [
    requirement.id,
    requirement.phase,
    requirement.domain,
    requirement.priority,
    scoped?.requirement ?? requirement.requirement,
    scoped?.acceptance ?? requirement.acceptance,
    status,
    update?.implementation_refs ?? evidenceFor(requirement.id),
    operationalEvidence,
    externalOwner,
    // Pagination records its executed local criterion; existing documentary
    // checkpoint dates below keep their original meaning and scope.
    ['SEA-008', 'SEO-011'].includes(requirement.id)
      ? '2026-10-10'
      : [
            'ADM-004',
            'ADM-005',
            'UI-005',
            'PDP-004',
            'MED-010',
            'SEA-002',
            'SEA-010',
            'SEO-005',
            'MKT-004',
            'MKT-006',
            'COM-011',
            'CAT-010',
            'SHP-009',
            'SHP-019',
            'SUP-006',
            'UI-013',
            'INV-010',
            'PRI-013',
            'PRI-012',
            'PRI-016',
            'CHK-016',
            'CHK-018',
            'CHK-019',
            'SUP-010',
            'INV-011',
            'SHP-013',
            'SHP-015',
            'SHP-018',
            'SHP-020',
            'SEA-017',
            'CUS-026',
            'INT-002',
            'TST-010',
            'CAT-007',
            'SEA-006',
            'CAT-014',
            'ADM-018',
            'SEA-005',
            'SUP-007',
            'UI-003',
            'ORD-018',
            'ORD-003',
            'ORD-008',
            'ORD-004',
            'ORD-005',
            'ORD-010',
            'ORD-012',
            'ORD-015',
            'CUS-001',
            'CUS-002',
            'CUS-005',
            'CUS-006',
            'CUS-007',
            'CUS-008',
            'CUS-009',
            'CUS-010',
            'CUS-012'
          ].includes(requirement.id)
        ? [
            'ADM-004',
            'ADM-005',
            'UI-005',
            'PDP-004',
            'MED-010',
            'SEA-002',
            'SEA-010',
            'SEO-005',
            'MKT-004',
            'MKT-006',
            'COM-011',
            'CAT-010',
            'SHP-009',
            'SHP-019',
            'SUP-006',
            'UI-013',
            'INV-010',
            'PRI-013',
            'PRI-012',
            'PRI-016',
            'CHK-016',
            'CHK-018',
            'CHK-019',
            'INV-011',
            'SUP-010',
            'SHP-013',
            'SHP-015',
            'SHP-018',
            'SHP-020',
            'CUS-005',
            'CUS-006',
            'CUS-007',
            'CUS-012'
          ].includes(requirement.id)
          ? '2026-10-09'
          : '2026-10-08'
        : requirement.id === 'CAT-015'
          ? '2026-10-04'
          : Object.hasOwn(editorialCheckpointNotes, requirement.id) ||
              Object.hasOwn(phaseFourCheckpointNotes, requirement.id) ||
              Object.hasOwn(phaseThreeCheckpointNotes, requirement.id) ||
              Object.hasOwn(phaseTwoCheckpointNotes, requirement.id) ||
              Object.hasOwn(nativeOperationsCheckpointNotes, requirement.id)
            ? '2026-10-03'
            : [
                  'CAT-005',
                  'CAT-006',
                  'ADM-008',
                  'UI-010',
                  'CUS-013',
                  'CUS-001',
                  'CUS-005',
                  'SEA-006',
                  ...Object.keys(executionCheckpointNotes)
                ].includes(requirement.id)
              ? '2026-10-01'
              : [
                    'CUS-003',
                    'CUS-013',
                    'COM-001',
                    'COM-007',
                    'ADM-007',
                    'UI-004',
                    'UI-007',
                    'CIC-001',
                    'SEA-001',
                    'SEA-003',
                    'SEO-003',
                    ...Object.keys(mediaCheckpointNotes),
                    ...Object.keys(pricingCheckpointNotes),
                    ...Object.keys(inventoryCheckpointNotes),
                    ...Object.keys(configurationCheckpointNotes)
                  ].includes(requirement.id)
                ? '2026-09-30'
                : ['SHP-001', 'SHP-003', 'SHP-006', 'ORD-001'].includes(requirement.id)
                  ? '2026-08-26'
                  : ['PRI-006'].includes(requirement.id)
                    ? '2026-08-25'
                    : ['CAT-002', 'CIC-005'].includes(requirement.id)
                      ? '2026-08-20'
                      : '',
    notes
  ]
    .map(csvCell)
    .join(',')
})

const generated = `${header.map(csvCell).join(',')}\n${rows.join('\n')}\n`

if (process.argv.includes('--write')) {
  await mkdir(resolve('docs/production'), { recursive: true })
  await writeFile(outputPath, generated, 'utf8')
} else {
  const existing = await readFile(outputPath, 'utf8').catch(() => '')
  if (existing !== generated) {
    throw new Error('Requirements traceability is stale; run npm run requirements:audit -- --write')
  }
}

const counts = requirements.reduce<Record<Status, number>>(
  (summary, requirement) => {
    summary[statusFor(requirement)] += 1
    return summary
  },
  { REPO_EVIDENCE: 0, PARTIAL_EXTERNAL: 0, MISSING: 0, NOT_VERIFIED: 0, ROADMAP_NOT_STARTED: 0, DISCARDED: 0 }
)
const active = requirements.length - counts.DISCARDED
process.stdout.write(
  `active=${active} repository_evidence_percent=${((100 * counts.REPO_EVIDENCE) / active).toFixed(2)} (not production completion)\n`
)
process.stdout.write(
  `requirements=702 ${Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(' ')}${process.argv.includes('--write') ? ` output=${outputPath}` : ''}\n`
)
