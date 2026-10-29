/**
 * Functional batching for the production requirement inventory.
 *
 * This module is deliberately Node-free. Callers parse the authoritative CSV
 * and may supply a filesystem-backed selectorExists callback to validation.
 */

export type FunctionalRequirementStatus =
  'REPO_EVIDENCE' | 'PARTIAL_EXTERNAL' | 'MISSING' | 'NOT_VERIFIED' | 'ROADMAP_NOT_STARTED' | 'DISCARDED'

export interface FunctionalRequirementRow {
  id: string
  phase_min: string
  domain: string
  priority: string
  /** Kept as CSV text so callers can report malformed/unknown values. */
  status: string
  requirement: string
  acceptance: string
}

export type RequirementOwnership =
  { kind: 'prefix'; prefix: string } | { kind: 'range'; prefix: string; from: number; to: number; width?: number }

export type FunctionalRiskCategory =
  | 'accessibility-and-content'
  | 'analytics-and-consent'
  | 'availability-and-performance'
  | 'catalog-governance'
  | 'customer-experience'
  | 'data-integrity'
  | 'delivery-and-recovery'
  | 'external-provider'
  | 'identity-and-authorization'
  | 'inventory-and-fulfilment'
  | 'money-and-tax'
  | 'payment-and-fiscal'
  | 'privacy-and-legal'
  | 'test-determinism'

export interface FunctionalDeliveryFront {
  id: string
  title: string
  purpose: string
}

export interface FunctionalModuleDefinition {
  id: string
  title: string
  ownership: readonly RequirementOwnership[]
  dependsOn: readonly string[]
  dependsOnContracts: readonly string[]
  testSelectors: readonly string[]
  riskCategories: readonly FunctionalRiskCategory[]
  frontId: string
}

export interface FunctionalDeliveryPlanManifest {
  id: string
  execution: readonly ['prepare-tests', 'implement-fronts', 'root-integration', 'joint-tests']
  dependencySemantics: 'entry-contracts-only'
  sharedContracts: readonly { id: string; owner: string; purpose: string }[]
  fronts: readonly FunctionalDeliveryFront[]
  modules: readonly FunctionalModuleDefinition[]
  excludedRequirementIds: readonly string[]
  rootIntegration: { owner: 'root'; dependsOnFrontIds: readonly string[] }
  validationBoundary: 'local-only'
}

export interface FunctionalDeliveryCounts {
  total: number
  byStatus: Record<string, number>
  byPriority: Record<string, number>
  byPhase: Record<string, number>
}

export interface FunctionalDeliveryBatch extends FunctionalModuleDefinition {
  requirementIds: string[]
  requirements: FunctionalRequirementRow[]
  counts: FunctionalDeliveryCounts
}

export interface FunctionalDeliveryPlanSnapshot {
  manifestId: string
  execution: FunctionalDeliveryPlanManifest['execution']
  dependencySemantics: FunctionalDeliveryPlanManifest['dependencySemantics']
  sharedContracts: { id: string; owner: string; purpose: string }[]
  fronts: FunctionalDeliveryFront[]
  modules: FunctionalDeliveryBatch[]
  excludedRequirementIds: string[]
  excludedRequirements: FunctionalRequirementRow[]
  rootIntegration: FunctionalDeliveryPlanManifest['rootIntegration']
  validationBoundary: 'local-only'
  totals: {
    historicalRequirementCount: number
    activeRequirementCount: number
    discardedRequirementCount: number
    byStatus: Record<string, number>
    byPriority: Record<string, number>
    byPhase: Record<string, number>
  }
}

export interface FunctionalDeliveryValidationOptions {
  selectorExists?: (selector: string) => boolean
}

export const FUNCTIONAL_REQUIREMENT_STATUSES: readonly FunctionalRequirementStatus[] = [
  'REPO_EVIDENCE',
  'PARTIAL_EXTERNAL',
  'MISSING',
  'NOT_VERIFIED',
  'ROADMAP_NOT_STARTED',
  'DISCARDED'
]

const frontDefinitions: readonly FunctionalDeliveryFront[] = [
  {
    id: 'storefront-commerce',
    title: 'Catálogo y compra',
    purpose: 'Catálogo, descubrimiento, precio, disponibilidad, pedido y pago.'
  },
  {
    id: 'customer-operations',
    title: 'Cliente y operación',
    purpose: 'Cuentas, administración, contenido comercial, comunicación y soporte.'
  },
  {
    id: 'platform-trust',
    title: 'Confianza y plataforma',
    purpose: 'Seguridad, datos, integraciones, rendimiento, calidad y entrega.'
  }
]

/**
 * Prefix ownership is exhaustive and non-overlapping. Discarded rows retain
 * their original CSV record but are intentionally omitted from implementation
 * batches through the explicit exclusion list below.
 */
export const FUNCTIONAL_DELIVERY_PLAN: FunctionalDeliveryPlanManifest = {
  id: 'neteco-functional-delivery-v1',
  execution: ['prepare-tests', 'implement-fronts', 'root-integration', 'joint-tests'],
  dependencySemantics: 'entry-contracts-only',
  sharedContracts: [
    {
      id: 'base-d1',
      owner: 'root',
      purpose: 'Existing D1 database/runtime boundary, migration discipline, and local fixtures.'
    },
    {
      id: 'identity-authorization',
      owner: 'security-compliance',
      purpose: 'Current identity, permissions, MFA, and fail-closed authorization checks.'
    },
    {
      id: 'catalog-read-model',
      owner: 'catalog-content',
      purpose: 'Canonical product, variant, publication, and media projection.'
    },
    {
      id: 'provider-ports',
      owner: 'integrations-apis',
      purpose: 'Versioned provider boundaries with deterministic local substitutes.'
    }
  ],
  fronts: frontDefinitions,
  modules: [
    {
      id: 'catalog-content',
      title: 'Catálogo, publicación y medios',
      ownership: [
        { kind: 'prefix', prefix: 'CAT' },
        { kind: 'prefix', prefix: 'MED' }
      ],
      dependsOn: ['security-compliance'],
      dependsOnContracts: ['base-d1', 'identity-authorization'],
      testSelectors: [
        'tests/unit/d1-catalog-relations.test.ts',
        'tests/unit/d1-catalog-relations-http.test.ts',
        'tests/unit/d1-catalog-relations-native.test.ts',
        'tests/components/product-relations-editor.test.ts',
        'tests/components/published-product-relations.test.ts',
        'tests/unit/d1-products.test.ts',
        'tests/unit/d1-product-facets.test.ts',
        'tests/unit/d1-product-facets-scale.test.ts',
        'tests/unit/d1-product-seed.test.ts',
        'tests/unit/d1-category-seed.test.ts',
        'tests/unit/d1-admin-catalog.test.ts',
        'tests/unit/d1-admin-catalog-mutations.test.ts',
        'tests/unit/d1-admin-catalog-mutations-http.test.ts',
        'tests/unit/d1-catalog-draft-authoring.test.ts',
        'tests/unit/d1-catalog-draft-authoring-http.test.ts',
        'tests/unit/d1-admin-catalog-status.test.ts',
        'tests/unit/d1-admin-catalog-status-http.test.ts',
        'tests/unit/d1-catalog-publication-gate.test.ts',
        'tests/unit/d1-catalog-publication-readiness.test.ts',
        'tests/unit/d1-catalog-policy.test.ts',
        'tests/unit/d1-catalog-policy-http.test.ts',
        'tests/unit/d1-admin-categories.test.ts',
        'tests/unit/d1-admin-categories-http.test.ts',
        'tests/unit/d1-category-redirects.test.ts',
        'tests/unit/d1-media.test.ts',
        'tests/unit/d1-product-detail.test.ts',
        'tests/unit/d1-media-governance.test.ts',
        'tests/unit/d1-media-public.test.ts',
        'tests/unit/d1-media-review-adversarial.test.ts',
        'tests/unit/d1-editorial-import.test.ts',
        'tests/unit/d1-editorial-import-adversarial.test.ts',
        'tests/unit/catalog-import-file.test.ts',
        'tests/unit/catalog-tabular.test.ts',
        'tests/unit/catalog-tabular-core.test.ts',
        'tests/unit/catalog-tabular-typed-attributes.test.ts',
        'tests/unit/catalog-import-scale-typed-fixture.test.ts',
        'tests/unit/catalog-typed-attributes.test.ts',
        'tests/unit/catalog-typed-attribute-views.test.ts',
        'tests/unit/catalog-typed-attribute-filters.test.ts',
        'tests/unit/catalog-typed-filters-ui.test.ts',
        'tests/unit/d1-typed-attribute-definitions.test.ts',
        'tests/unit/d1-typed-attribute-values.test.ts',
        'tests/unit/d1-typed-attributes-http.test.ts',
        'tests/unit/d1-typed-attribute-integrity.test.ts',
        'tests/unit/d1-typed-attribute-facets.test.ts',
        'tests/unit/d1-typed-attribute-detail.test.ts',
        'tests/unit/d1-typed-catalog-intake.test.ts',
        'tests/unit/catalog-file-scale.test.ts',
        'tests/unit/catalog-native-import-contract.test.ts',
        'tests/unit/d1-native-catalog-import.test.ts',
        'tests/unit/d1-catalog-color-migration.test.ts',
        'tests/unit/d1-native-catalog-import-http.test.ts',
        'tests/unit/catalog-import-job.test.ts',
        'tests/unit/catalog-import-job-review.test.ts',
        'tests/unit/d1-catalog-import-job.test.ts',
        'tests/unit/d1-catalog-import-job-http.test.ts',
        'tests/unit/d1-catalog-import-job-review.test.ts',
        'tests/unit/catalog-import-job-command-contract.test.ts',
        'tests/unit/d1-catalog-import-job-command-schema.test.ts',
        'tests/unit/d1-catalog-import-job-commands.test.ts',
        'tests/unit/d1-catalog-import-job-commands-http.test.ts',
        'tests/unit/native-catalog-import-audit.test.ts',
        'tests/unit/native-catalog-import-browser.test.ts',
        'tests/unit/d1-catalog-export-http.test.ts',
        'tests/unit/d1-catalog-export-adversarial.test.ts',
        'tests/unit/catalog-export-contract.test.ts',
        'tests/unit/catalog-export-xlsx.test.ts',
        'tests/components/catalog-draft-authoring.test.ts',
        'tests/components/category-attribute-definitions-editor.test.ts',
        'tests/components/typed-product-attributes-editor.test.ts',
        'tests/components/typed-catalog-filters.test.ts',
        'tests/components/typed-public-catalog-pages.test.ts',
        'tests/components/catalog-editorial-import.test.ts',
        'tests/components/catalog-file-preflight.test.ts',
        'tests/components/catalog-native-import.test.ts',
        'tests/components/catalog-import-job.test.ts',
        'tests/components/catalog-import-job-review.test.ts',
        'tests/components/catalog-import-job-commands.test.ts',
        'tests/components/catalog-snapshot-export.test.ts',
        'tests/components/catalog-publication-readiness.test.ts',
        'tests/components/catalog-policy-management.test.ts',
        'tests/components/media-publication-dialog.test.ts',
        'tests/components/media-library-governance.test.ts',
        'tests/components/product-status-editor.test.ts'
      ],
      riskCategories: ['catalog-governance', 'data-integrity', 'privacy-and-legal'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'discovery-experience',
      title: 'Búsqueda, ficha y descubrimiento orgánico',
      ownership: [
        { kind: 'prefix', prefix: 'SEA' },
        { kind: 'prefix', prefix: 'PDP' },
        { kind: 'prefix', prefix: 'SEO' }
      ],
      dependsOn: ['catalog-content'],
      dependsOnContracts: ['base-d1', 'catalog-read-model'],
      testSelectors: [
        'tests/components/search-read-state.test.ts',
        'tests/components/search-seo.test.ts',
        'tests/components/catalog-support-context.test.ts',
        'tests/unit/native-quick-order-browser.test.ts',
        'tests/unit/quick-order.test.ts',
        'tests/unit/quick-order-native.test.ts',
        'tests/components/quick-order.test.ts',
        'tests/components/admin-navigation.test.ts',
        'tests/unit/d1-search.test.ts',
        'tests/unit/d1-search-synonyms.test.ts',
        'tests/unit/d1-search-synonyms-http.test.ts',
        'tests/unit/d1-products-search-native.test.ts',
        'tests/components/search-synonyms.test.ts',
        'tests/unit/d1-product-facets.test.ts',
        'tests/unit/d1-product-facets-scale.test.ts',
        'tests/unit/d1-product-detail.test.ts',
        'tests/unit/d1-typed-attribute-facets.test.ts',
        'tests/unit/d1-typed-attribute-detail.test.ts',
        'tests/unit/catalog-typed-attribute-filters.test.ts',
        'tests/unit/catalog-typed-filters-ui.test.ts',
        'tests/components/typed-catalog-filters.test.ts',
        'tests/components/typed-public-catalog-pages.test.ts',
        'tests/unit/d1-seo-http.test.ts',
        'tests/unit/d1-seo-privacy.test.ts',
        'tests/unit/seo.test.ts',
        'tests/unit/d1-category-redirects.test.ts',
        'tests/components/published-product-image.test.ts',
        'tests/components/product-image-lightbox.test.ts',
        'tests/components/governed-image-consumers.test.ts'
      ],
      riskCategories: ['accessibility-and-content', 'availability-and-performance'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'pricing-rules',
      title: 'Precios, impuestos y promociones',
      ownership: [{ kind: 'prefix', prefix: 'PRI' }],
      dependsOn: ['catalog-content'],
      dependsOnContracts: ['base-d1', 'catalog-read-model', 'identity-authorization'],
      testSelectors: [
        'tests/unit/d1-promotion-basket-preview.test.ts',
        'tests/unit/d1-promotion-basket-preview-http.test.ts',
        'tests/components/promotion-basket-simulator.test.ts',
        'tests/unit/native-promotions-browser.test.ts',
        'tests/unit/promotions.test.ts',
        'tests/unit/d1-promotions.test.ts',
        'tests/unit/d1-promotion-schema.test.ts',
        'tests/unit/d1-admin-promotions.test.ts',
        'tests/unit/d1-admin-promotions-http.test.ts',
        'tests/unit/d1-promotions-native.test.ts',
        'tests/unit/d1-coupon-checkout.test.ts',
        'tests/components/admin-promotions.test.ts',
        'tests/unit/d1-effective-pricing.test.ts',
        'tests/unit/d1-admin-pricing.test.ts',
        'tests/unit/d1-admin-pricing-review.test.ts',
        'tests/unit/d1-admin-price-commands.test.ts',
        'tests/unit/d1-admin-price-commands-http.test.ts',
        'tests/components/admin-pricing-capabilities.test.ts',
        'tests/components/governed-price-editor.test.ts'
      ],
      riskCategories: ['data-integrity', 'money-and-tax'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'fulfillment-logistics',
      title: 'Inventario, almacén y logística',
      ownership: [
        { kind: 'prefix', prefix: 'INV' },
        { kind: 'prefix', prefix: 'SHP' }
      ],
      dependsOn: ['catalog-content'],
      dependsOnContracts: ['base-d1', 'catalog-read-model', 'identity-authorization', 'provider-ports'],
      testSelectors: [
        'tests/unit/d1-admin-order-bulk.test.ts',
        'tests/unit/d1-admin-order-bulk-http.test.ts',
        'tests/unit/d1-admin-order-bulk-runtime.test.ts',
        'tests/unit/d1-admin-order-bulk-native.test.ts',
        'tests/unit/d1-admin-order-bulk-ingress.test.ts',
        'tests/unit/d1-admin-order-cursor.test.ts',
        'tests/components/admin-order-batch-preparation.test.ts',
        'tests/unit/d1-shipping-calendar.test.ts',
        'tests/unit/d1-shipping-calendar-http.test.ts',
        'tests/unit/operations-batch-runtime.test.ts',
        'tests/unit/operations-batch-native.test.ts',
        'tests/components/shipping-calendar.test.ts',
        'tests/components/admin-operations-capabilities.test.ts',
        'tests/unit/d1-order-purchase-reference-readers.test.ts',
        'tests/unit/d1-inventory.test.ts',
        'tests/unit/d1-inventory-coordinator.test.ts',
        'tests/unit/d1-admin-inventory.test.ts',
        'tests/unit/d1-admin-inventory-http.test.ts',
        'tests/unit/d1-admin-inventory-operations.test.ts',
        'tests/unit/d1-inventory-count-import.test.ts',
        'tests/unit/d1-inventory-count-import-http.test.ts',
        'tests/unit/d1-inventory-count-import-runtime.test.ts',
        'tests/unit/d1-inventory-count-import-native.test.ts',
        'tests/unit/audit-native-inventory-count-import.test.ts',
        'tests/unit/audit-native-inventory-count-import-browser.test.ts',
        'tests/unit/d1-inventory-alerts.test.ts',
        'tests/unit/d1-inventory-alerts-http.test.ts',
        'tests/unit/d1-inventory-alerts-runtime.test.ts',
        'tests/unit/d1-inventory-alerts-native.test.ts',
        'tests/unit/audit-native-inventory-alerts-browser.test.ts',
        'tests/unit/d1-storefront-shipping.test.ts',
        'tests/unit/d1-fulfillment.test.ts',
        'tests/unit/d1-fulfillment-http.test.ts',
        'tests/unit/d1-order-packing.test.ts',
        'tests/unit/d1-order-packing-http.test.ts',
        'tests/unit/d1-order-packing-native.test.ts',
        'tests/unit/audit-native-order-packing-browser.test.ts',
        'tests/unit/d1-order-tracking.test.ts',
        'tests/unit/d1-order-tracking-http.test.ts',
        'tests/unit/d1-order-tracking-native.test.ts',
        'tests/unit/audit-native-order-tracking-browser.test.ts',
        'tests/unit/d1-delivery-preferences.test.ts',
        'tests/unit/d1-delivery-preferences-http.test.ts',
        'tests/unit/d1-delivery-preferences-native.test.ts',
        'tests/unit/d1-delivery-notice-preferences.test.ts',
        'tests/unit/native-account-settings-browser.test.ts',
        'tests/components/delivery-preferences-panel.test.ts',
        'tests/components/delivery-preferences-mounting.test.ts',
        'tests/components/account-settings-mounting.test.ts',
        'tests/unit/d1-order-timeline.test.ts',
        'tests/unit/d1-order-timeline-native.test.ts',
        'tests/unit/audit-native-order-timeline.test.ts',
        'tests/unit/d1-order-cancellation.test.ts',
        'tests/unit/d1-order-cancellation-native.test.ts',
        'tests/components/admin-order-workbench.test.ts',
        'tests/components/admin-inventory.test.ts',
        'tests/components/admin-inventory-page.test.ts',
        'tests/components/admin-inventory-boundaries.test.ts',
        'tests/components/inventory-alerts-panel.test.ts',
        'tests/components/inventory-receipt-integrity.test.ts',
        'tests/components/inventory-count-import.test.ts',
        'tests/components/order-fulfillment-panel.test.ts',
        'tests/components/order-fulfillment-section.test.ts',
        'tests/components/order-packing-panel.test.ts',
        'tests/components/order-tracking-panel.test.ts',
        'tests/components/order-tracking-mounting.test.ts',
        'tests/unit/d1-customer-orders.test.ts',
        'tests/unit/d1-customer-orders-native.test.ts'
      ],
      riskCategories: ['data-integrity', 'external-provider', 'inventory-and-fulfilment'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'commerce-transactions',
      title: 'Carrito, checkout y ciclo del pedido',
      ownership: [
        { kind: 'prefix', prefix: 'CHK' },
        { kind: 'prefix', prefix: 'ORD' }
      ],
      dependsOn: ['catalog-content', 'pricing-rules', 'fulfillment-logistics'],
      dependsOnContracts: ['base-d1', 'catalog-read-model', 'identity-authorization'],
      testSelectors: [
        'tests/components/published-product-relations.test.ts',
        'tests/unit/cart-snapshots-browser.test.ts',
        'tests/unit/d1-cart-snapshots.test.ts',
        'tests/unit/d1-cart-snapshots-http.test.ts',
        'tests/unit/d1-cart-snapshots-native.test.ts',
        'tests/components/cart-snapshots-panel.test.ts',
        'tests/components/cart-shared.test.ts',
        'tests/unit/d1-order-purchase-reference.test.ts',
        'tests/unit/d1-order-purchase-reference-readers.test.ts',
        'tests/components/checkout-purchase-reference.test.ts',
        'tests/components/order-purchase-reference.test.ts',
        'tests/unit/native-promotions-browser.test.ts',
        'tests/unit/d1-promotions-native.test.ts',
        'tests/unit/d1-coupon-checkout.test.ts',
        'tests/unit/d1-coupon-http.test.ts',
        'tests/unit/d1-checkout-replay-authority.test.ts',
        'tests/unit/d1-order-coupon-breakdown.test.ts',
        'tests/components/checkout-coupons.test.ts',
        'tests/components/order-coupon-breakdown.test.ts',
        'tests/unit/native-guest-order-browser.test.ts',
        'tests/unit/d1-guest-order-email.test.ts',
        'tests/unit/d1-guest-order-access.test.ts',
        'tests/unit/d1-guest-order-access-entrypoints.test.ts',
        'tests/unit/order-detail-headline.test.ts',
        'tests/unit/native-quick-order-browser.test.ts',
        'tests/unit/quick-order.test.ts',
        'tests/unit/quick-order-native.test.ts',
        'tests/components/quick-order.test.ts',
        'tests/unit/d1-cart.test.ts',
        'tests/unit/d1-cart-coordinator.test.ts',
        'tests/unit/d1-cart-operations-native.test.ts',
        'tests/unit/d1-cart-entrypoints.test.ts',
        'tests/unit/d1-checkout.test.ts',
        'tests/unit/d1-order-timeline-adversarial.test.ts',
        'tests/unit/d1-order-timeline.test.ts',
        'tests/unit/d1-order-timeline-native.test.ts',
        'tests/unit/audit-native-order-timeline.test.ts',
        'tests/unit/d1-order-cancellation.test.ts',
        'tests/unit/d1-order-cancellation-native.test.ts',
        'tests/unit/audit-native-order-cancellation.test.ts',
        'tests/unit/d1-order-export.test.ts',
        'tests/unit/d1-order-export-native.test.ts',
        'tests/unit/audit-native-order-export.test.ts',
        'tests/unit/audit-native-order-operations-browser.test.ts',
        'tests/unit/d1-order-annotations.test.ts',
        'tests/unit/d1-order-operations-email.test.ts',
        'tests/unit/d1-order-return-email.test.ts',
        'tests/unit/d1-order-payment-email.test.ts',
        'tests/unit/audit-native-order-emails.test.ts',
        'tests/unit/d1-order-annotations-native.test.ts',
        'tests/unit/audit-native-order-annotations.test.ts',
        'tests/unit/d1-storefront-cart.test.ts',
        'tests/unit/d1-storefront-checkout.test.ts',
        'tests/unit/d1-customer-orders.test.ts',
        'tests/unit/d1-customer-orders-native.test.ts',
        'tests/unit/audit-native-checkout-recovery-browser.test.ts',
        'tests/unit/audit-native-cart-add-recovery-browser.test.ts',
        'tests/unit/order-reorder-offer.test.ts',
        'tests/unit/d1-admin-orders.test.ts',
        'tests/unit/d1-admin-orders-origin.test.ts',
        'tests/unit/d1-returns.test.ts',
        'tests/unit/d1-returns-http.test.ts',
        'tests/unit/d1-refunds-credit.test.ts',
        'tests/unit/order-returns-contract.test.ts',
        'tests/components/cart-read-recovery.test.ts',
        'tests/components/cart-add-recovery.test.ts',
        'tests/components/checkout-command-recovery.test.ts',
        'tests/components/order-payment-recovery.test.ts',
        'tests/components/account-orders-read-state.test.ts',
        'tests/components/account-order-row-read-state.test.ts',
        'tests/components/reorder-read-state.test.ts',
        'tests/components/order-return-panels.test.ts',
        'tests/components/order-return-sections.test.ts',
        'tests/components/order-return-authority-boundaries.test.ts',
        'tests/unit/native-order-returns-browser.test.ts',
        'tests/components/order-refunds.test.ts'
      ],
      riskCategories: ['data-integrity', 'delivery-and-recovery', 'money-and-tax'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'payments-fiscal',
      title: 'Pagos y facturación',
      ownership: [
        { kind: 'prefix', prefix: 'PAY' },
        { kind: 'prefix', prefix: 'BEP' }
      ],
      dependsOn: ['commerce-transactions', 'integrations-apis'],
      dependsOnContracts: ['base-d1', 'identity-authorization', 'provider-ports'],
      testSelectors: [
        'tests/unit/fiscal-coupon-contract.test.ts',
        'tests/unit/d1-coupon-refunds.test.ts',
        'tests/unit/d1-payments.test.ts',
        'tests/unit/d1-fiscal-runtime.test.ts',
        'tests/unit/d1-fiscal-issuance.test.ts',
        'tests/unit/d1-fiscal-invoice-email.test.ts',
        'tests/unit/worker-redsys.test.ts',
        'tests/unit/audit-native-checkout-recovery-browser.test.ts',
        'tests/unit/beply.test.ts',
        'tests/components/order-fiscal-section.test.ts',
        'tests/components/order-payment-recovery.test.ts',
        'tests/components/order-refunds.test.ts'
      ],
      riskCategories: ['external-provider', 'money-and-tax', 'payment-and-fiscal'],
      frontId: 'storefront-commerce'
    },
    {
      id: 'customer-accounts',
      title: 'Clientes, cuentas y comercio B2B',
      ownership: [{ kind: 'prefix', prefix: 'CUS' }],
      dependsOn: ['security-compliance'],
      dependsOnContracts: ['base-d1', 'identity-authorization'],
      testSelectors: [
        'tests/unit/cart-snapshots-browser.test.ts',
        'tests/unit/d1-cart-snapshots.test.ts',
        'tests/unit/d1-cart-snapshots-http.test.ts',
        'tests/unit/d1-cart-snapshots-native.test.ts',
        'tests/components/cart-snapshots-panel.test.ts',
        'tests/components/cart-shared.test.ts',
        'tests/components/order-purchase-reference.test.ts',
        'tests/unit/d1-order-coupon-breakdown.test.ts',
        'tests/components/order-coupon-breakdown.test.ts',
        'tests/unit/native-guest-order-browser.test.ts',
        'tests/unit/d1-guest-order-access.test.ts',
        'tests/unit/d1-guest-order-access-entrypoints.test.ts',
        'tests/unit/order-detail-headline.test.ts',
        'tests/unit/native-quick-order-browser.test.ts',
        'tests/unit/quick-order.test.ts',
        'tests/unit/quick-order-native.test.ts',
        'tests/components/quick-order.test.ts',
        'tests/unit/native-account-settings-browser.test.ts',
        'tests/unit/customer-tax-validation.test.ts',
        'tests/unit/d1-authentication-http.test.ts',
        'tests/unit/d1-identity-lifecycle.test.ts',
        'tests/unit/d1-identity-lifecycle-http.test.ts',
        'tests/unit/d1-identity-lifecycle-adversarial.test.ts',
        'tests/unit/d1-account-security-schema.test.ts',
        'tests/unit/d1-account-security-notices.test.ts',
        'tests/unit/d1-email-change-security-notices.test.ts',
        'tests/unit/d1-company-security-notices.test.ts',
        'tests/unit/d1-account-security-native.test.ts',
        'tests/unit/d1-identity-security-notice.test.ts',
        'tests/unit/d1-identity-security-native.test.ts',
        'tests/unit/d1-mfa.test.ts',
        'tests/unit/d1-mfa-enrollment.test.ts',
        'tests/unit/d1-customer-favorites.test.ts',
        'tests/unit/d1-customer-favorites-http.test.ts',
        'tests/unit/d1-customer-addresses.test.ts',
        'tests/unit/d1-admin-companies.test.ts',
        'tests/unit/d1-admin-companies-http.test.ts',
        'tests/unit/d1-admin-companies-native.test.ts',
        'tests/unit/d1-admin-companies-entrypoints.test.ts',
        'tests/unit/native-company-review-browser.test.ts',
        'tests/unit/d1-account-privacy.test.ts',
        'tests/unit/d1-account-privacy-http.test.ts',
        'tests/unit/d1-account-privacy-native.test.ts',
        'tests/unit/d1-account-preferences.test.ts',
        'tests/unit/d1-account-preferences-http.test.ts',
        'tests/unit/d1-account-preferences-native.test.ts',
        'tests/unit/d1-delivery-preferences.test.ts',
        'tests/unit/d1-delivery-preferences-http.test.ts',
        'tests/unit/d1-delivery-preferences-native.test.ts',
        'tests/components/delivery-preferences-panel.test.ts',
        'tests/components/delivery-preferences-mounting.test.ts',
        'tests/unit/d1-account-settings-entrypoints.test.ts',
        'tests/components/account-privacy-panel.test.ts',
        'tests/components/account-preferences.test.ts',
        'tests/components/account-settings-mounting.test.ts',
        'tests/components/admin-companies.test.ts',
        'tests/components/account-overview.test.ts',
        'tests/unit/d1-order-timeline-adversarial.test.ts',
        'tests/unit/d1-order-timeline-http.test.ts',
        'tests/unit/d1-order-timeline-entrypoints.test.ts',
        'tests/components/order-timeline-panel.test.ts',
        'tests/components/order-timeline-mounting.test.ts',
        'tests/unit/d1-order-cancellation-http.test.ts',
        'tests/unit/d1-order-cancellation-entrypoints.test.ts',
        'tests/components/order-cancellation-panel.test.ts',
        'tests/components/order-cancellation-mounting.test.ts',
        'tests/unit/d1-customer-orders.test.ts',
        'tests/unit/d1-customer-orders-native.test.ts',
        'tests/unit/d1-identity-email-delivery.test.ts',
        'tests/unit/order-reorder-offer.test.ts',
        'tests/components/account-address-read-state.test.ts',
        'tests/components/account-address-book.test.ts',
        'tests/components/account-orders-read-state.test.ts',
        'tests/components/account-order-row-read-state.test.ts',
        'tests/components/reorder-read-state.test.ts',
        'tests/components/account-profile-read-state.test.ts',
        'tests/components/account-profile.test.ts',
        'tests/components/account-security.test.ts',
        'tests/components/account-sessions-read-state.test.ts',
        'tests/components/account-favorites-read-state.test.ts',
        'tests/components/account-favorites-mutations.test.ts',
        'tests/components/registration-state.test.ts'
      ],
      riskCategories: ['customer-experience', 'identity-and-authorization', 'privacy-and-legal'],
      frontId: 'customer-operations'
    },
    {
      id: 'admin-publishing',
      title: 'Administración, CMS y experiencia de cuenta',
      ownership: [
        { kind: 'prefix', prefix: 'ADM' },
        { kind: 'prefix', prefix: 'UI' }
      ],
      dependsOn: ['catalog-content', 'customer-accounts', 'security-compliance'],
      dependsOnContracts: ['base-d1', 'identity-authorization', 'catalog-read-model'],
      testSelectors: [
        'tests/unit/d1-admin-order-bulk.test.ts',
        'tests/unit/d1-admin-order-bulk-http.test.ts',
        'tests/unit/d1-admin-order-bulk-runtime.test.ts',
        'tests/unit/d1-admin-order-bulk-native.test.ts',
        'tests/unit/d1-admin-order-bulk-ingress.test.ts',
        'tests/unit/d1-admin-order-cursor.test.ts',
        'tests/components/admin-order-batch-preparation.test.ts',
        'tests/unit/d1-admin-order-views.test.ts',
        'tests/unit/d1-admin-order-views-http.test.ts',
        'tests/unit/d1-admin-order-views-runtime.test.ts',
        'tests/unit/d1-admin-order-views-native.test.ts',
        'tests/components/admin-order-views.test.ts',
        'tests/unit/admin-audit-network.test.ts',
        'tests/unit/d1-admin-audit.test.ts',
        'tests/unit/d1-admin-audit-integrity.test.ts',
        'tests/unit/d1-admin-audit-boundaries.test.ts',
        'tests/unit/d1-admin-audit-cancellation.test.ts',
        'tests/unit/d1-admin-audit-http.test.ts',
        'tests/unit/d1-admin-audit-runtime.test.ts',
        'tests/unit/d1-admin-audit-native.test.ts',
        'tests/components/admin-audit-panel.test.ts',
        'tests/components/admin-audit-page.test.ts',
        'tests/unit/d1-admin-bootstrap.test.ts',
        'tests/unit/d1-admin-invitations.test.ts',
        'tests/unit/d1-admin-invitations-http.test.ts',
        'tests/unit/d1-admin-invitations-runtime.test.ts',
        'tests/unit/d1-admin-invitations-native.test.ts',
        'tests/components/admin-invitations-panel.test.ts',
        'tests/components/admin-invitation-acceptance.test.ts',
        'tests/components/admin-team-page.test.ts',
        'tests/unit/ui-state-harness.test.ts',
        'tests/unit/ui-state-visual-artifacts.test.ts',
        'tests/components/ui-state-harness.test.ts',
        'tests/components/product-relations-editor.test.ts',
        'tests/unit/d1-order-purchase-reference-readers.test.ts',
        'tests/components/order-purchase-reference.test.ts',
        'tests/unit/d1-promotion-basket-preview.test.ts',
        'tests/unit/d1-promotion-basket-preview-http.test.ts',
        'tests/components/promotion-basket-simulator.test.ts',
        'tests/unit/native-promotions-browser.test.ts',
        'tests/unit/d1-admin-promotions.test.ts',
        'tests/unit/d1-admin-promotions-http.test.ts',
        'tests/components/admin-promotions.test.ts',
        'tests/unit/d1-admin-catalog.test.ts',
        'tests/unit/d1-admin-capabilities.test.ts',
        'tests/unit/d1-admin-companies.test.ts',
        'tests/unit/d1-admin-companies-http.test.ts',
        'tests/unit/d1-admin-companies-native.test.ts',
        'tests/unit/d1-admin-companies-entrypoints.test.ts',
        'tests/unit/native-company-review-browser.test.ts',
        'tests/components/admin-companies.test.ts',
        'tests/unit/d1-order-timeline-http.test.ts',
        'tests/unit/d1-order-timeline-entrypoints.test.ts',
        'tests/components/order-timeline-panel.test.ts',
        'tests/components/order-timeline-mounting.test.ts',
        'tests/unit/d1-order-cancellation-http.test.ts',
        'tests/unit/d1-order-cancellation-entrypoints.test.ts',
        'tests/components/order-cancellation-panel.test.ts',
        'tests/components/order-cancellation-mounting.test.ts',
        'tests/components/admin-order-workbench.test.ts',
        'tests/unit/d1-admin-activity.test.ts',
        'tests/unit/d1-order-export.test.ts',
        'tests/unit/d1-order-export-http.test.ts',
        'tests/unit/d1-order-export-native.test.ts',
        'tests/unit/d1-order-export-entrypoints.test.ts',
        'tests/unit/audit-native-order-export.test.ts',
        'tests/unit/audit-native-order-operations-browser.test.ts',
        'tests/components/admin-order-export.test.ts',
        'tests/unit/d1-order-annotations.test.ts',
        'tests/unit/d1-order-annotations-http.test.ts',
        'tests/unit/d1-order-annotations-native.test.ts',
        'tests/unit/d1-order-annotations-entrypoints.test.ts',
        'tests/unit/audit-native-order-annotations.test.ts',
        'tests/components/order-annotations-panel.test.ts',
        'tests/unit/d1-admin-activity-http.test.ts',
        'tests/unit/d1-admin-activity-native.test.ts',
        'tests/unit/d1-search-synonyms.test.ts',
        'tests/unit/d1-search-synonyms-http.test.ts',
        'tests/components/admin-navigation.test.ts',
        'tests/components/admin-navigation-context.test.ts',
        'tests/components/admin-recent-activity.test.ts',
        'tests/components/admin-global-search.test.ts',
        'tests/unit/d1-admin-global-search.test.ts',
        'tests/unit/d1-admin-global-search-http.test.ts',
        'tests/unit/d1-admin-global-search-native.test.ts',
        'tests/unit/audit-native-admin-global-search.test.ts',
        'tests/components/admin-command-palette.test.ts',
        'tests/components/search-synonyms.test.ts',
        'tests/unit/d1-admin-catalog-mutations.test.ts',
        'tests/unit/d1-admin-catalog-mutations-http.test.ts',
        'tests/unit/d1-catalog-draft-authoring.test.ts',
        'tests/unit/d1-catalog-draft-authoring-http.test.ts',
        'tests/unit/d1-admin-categories.test.ts',
        'tests/unit/d1-admin-categories-http.test.ts',
        'tests/unit/d1-admin-pricing.test.ts',
        'tests/unit/d1-admin-inventory-operations.test.ts',
        'tests/unit/d1-admin-orders.test.ts',
        'tests/unit/d1-cms-drafts.test.ts',
        'tests/unit/d1-cms-http.test.ts',
        'tests/unit/d1-cms-adversarial.test.ts',
        'tests/unit/d1-cms-publication.test.ts',
        'tests/unit/d1-cms-publication-http.test.ts',
        'tests/unit/d1-cms-publication-races.test.ts',
        'tests/unit/d1-cms-publication-media.test.ts',
        'tests/unit/d1-cms-calendar.test.ts',
        'tests/unit/d1-cms-preview-schedule.test.ts',
        'tests/unit/d1-promotional-content.test.ts',
        'tests/unit/d1-promotional-content-http.test.ts',
        'tests/components/admin-catalog-capabilities.test.ts',
        'tests/components/catalog-draft-authoring.test.ts',
        'tests/components/catalog-draft-authoring-page.test.ts',
        'tests/components/catalog-category-crud.test.ts',
        'tests/components/cms-draft-editor.test.ts',
        'tests/components/promotional-blocks.test.ts',
        'tests/components/cms-publication-controls.test.ts',
        'tests/components/cms-editorial-calendar.test.ts',
        'tests/components/admin-dashboard-capabilities.test.ts',
        'tests/components/admin-operations-capabilities.test.ts',
        'tests/components/admin-inventory-page.test.ts',
        'tests/components/admin-inventory-boundaries.test.ts'
      ],
      riskCategories: ['accessibility-and-content', 'customer-experience', 'identity-and-authorization'],
      frontId: 'customer-operations'
    },
    {
      id: 'marketing-communications',
      title: 'Marketing y comunicación',
      ownership: [
        { kind: 'prefix', prefix: 'MKT' },
        { kind: 'prefix', prefix: 'COM' }
      ],
      dependsOn: ['customer-accounts', 'admin-publishing'],
      dependsOnContracts: ['base-d1', 'identity-authorization', 'provider-ports'],
      testSelectors: [
        'tests/unit/d1-communication-history.test.ts',
        'tests/unit/d1-communication-history-http.test.ts',
        'tests/unit/d1-communication-history-native.test.ts',
        'tests/unit/promotional-communications-runtime.test.ts',
        'tests/components/communication-history.test.ts',
        'tests/components/shipping-operational-copy.test.ts',
        'tests/unit/d1-identity-security-notice.test.ts',
        'tests/unit/d1-identity-security-native.test.ts',
        'tests/unit/d1-guest-order-email.test.ts',
        'tests/unit/d1-account-security-schema.test.ts',
        'tests/unit/d1-account-security-notices.test.ts',
        'tests/unit/d1-email-change-security-notices.test.ts',
        'tests/unit/d1-company-security-notices.test.ts',
        'tests/unit/d1-account-security-native.test.ts',
        'tests/unit/d1-guest-order-email-scheduled.test.ts',
        'tests/unit/d1-delivery-notice-preferences.test.ts',
        'tests/unit/native-account-settings-browser.test.ts',
        'tests/unit/d1-account-preferences.test.ts',
        'tests/unit/d1-account-preferences-http.test.ts',
        'tests/unit/d1-account-preferences-native.test.ts',
        'tests/components/account-preferences.test.ts',
        'tests/components/account-settings-mounting.test.ts',
        'tests/unit/d1-newsletter-editorial.test.ts',
        'tests/unit/d1-newsletter-editorial-http.test.ts',
        'tests/unit/d1-newsletter-editorial-adversarial.test.ts',
        'tests/unit/d1-newsletter-editorial-pagination.test.ts',
        'tests/unit/d1-newsletter-editorial-schema.test.ts',
        'tests/unit/d1-newsletter-editorial-feedback.test.ts',
        'tests/unit/d1-newsletter-delivery.test.ts',
        'tests/unit/d1-newsletter-consent.test.ts',
        'tests/unit/d1-transactional-email-delivery.test.ts',
        'tests/unit/d1-order-operations-email.test.ts',
        'tests/unit/d1-order-return-email.test.ts',
        'tests/unit/d1-order-payment-email.test.ts',
        'tests/unit/audit-native-order-emails.test.ts',
        'tests/unit/d1-email-outbox.test.ts',
        'tests/unit/newsletter-email.test.ts',
        'tests/components/newsletter-editorial.test.ts',
        'tests/components/newsletter-link-actions.test.ts',
        'tests/components/newsletter-preference-access.test.ts',
        'tests/components/account-communications-newsletter.test.ts',
        'tests/components/cms-editorial-calendar.test.ts'
      ],
      riskCategories: ['customer-experience', 'external-provider', 'privacy-and-legal'],
      frontId: 'customer-operations'
    },
    {
      id: 'support-crm',
      title: 'Atención al cliente, CRM y soporte',
      ownership: [{ kind: 'prefix', prefix: 'SUP' }],
      dependsOn: ['customer-accounts', 'security-compliance'],
      dependsOnContracts: ['base-d1', 'identity-authorization', 'provider-ports'],
      testSelectors: [
        'tests/unit/d1-support-escalations.test.ts',
        'tests/unit/d1-support-escalations-http.test.ts',
        'tests/unit/operations-batch-runtime.test.ts',
        'tests/unit/operations-batch-native.test.ts',
        'tests/components/support-escalations.test.ts',
        'tests/components/published-product-relations.test.ts',
        'tests/components/catalog-support-context.test.ts',
        'tests/unit/d1-support-satisfaction.test.ts',
        'tests/unit/d1-support-satisfaction-schema.test.ts',
        'tests/unit/d1-support-satisfaction-http.test.ts',
        'tests/unit/d1-support-satisfaction-native.test.ts',
        'tests/unit/d1-support-satisfaction-adversarial.test.ts',
        'tests/unit/audit-native-satisfaction-browser.test.ts',
        'tests/components/satisfaction-panels.test.ts',
        'tests/components/support-satisfaction-mounting.test.ts',
        'tests/components/delivery-satisfaction-mounting.test.ts',
        'tests/unit/d1-support-operations.test.ts',
        'tests/unit/d1-support-knowledge.test.ts',
        'tests/unit/d1-support-knowledge-http.test.ts',
        'tests/unit/d1-support-knowledge-schema.test.ts',
        'tests/unit/d1-support-knowledge-native.test.ts',
        'tests/unit/d1-admin-orders.test.ts',
        'tests/components/support-knowledge.test.ts',
        'tests/components/cms-draft-editor.test.ts',
        'tests/components/admin-operations-capabilities.test.ts',
        'tests/unit/d1-support-macros.test.ts',
        'tests/unit/d1-support-macros-schema.test.ts',
        'tests/unit/audit-native-support-macros.test.ts',
        'tests/unit/d1-support-macros-http.test.ts',
        'tests/unit/d1-support-http.test.ts',
        'tests/unit/d1-support-adversarial.test.ts',
        'tests/unit/d1-support-attachments.test.ts',
        'tests/unit/d1-support-challenge.test.ts',
        'tests/unit/d1-support-email.test.ts',
        'tests/unit/support-contact-navigation.test.ts',
        'tests/unit/support-runtime-adapters.test.ts',
        'tests/components/support-challenge-widget.test.ts',
        'tests/components/support-panels.test.ts',
        'tests/components/support-macros.test.ts',
        'tests/components/support-sections.test.ts'
      ],
      riskCategories: ['customer-experience', 'external-provider', 'privacy-and-legal'],
      frontId: 'customer-operations'
    },
    {
      id: 'analytics-measurement',
      title: 'Analítica, datos y atribución',
      ownership: [{ kind: 'prefix', prefix: 'DAT' }],
      dependsOn: ['commerce-transactions', 'payments-fiscal', 'security-compliance'],
      dependsOnContracts: ['base-d1', 'identity-authorization'],
      testSelectors: [
        'tests/unit/promotional-analytics-client.test.ts',
        'tests/unit/d1-promotional-analytics-storage.test.ts',
        'tests/unit/d1-analytics-core.test.ts',
        'tests/unit/d1-analytics-authority-race.test.ts',
        'tests/unit/d1-analytics-reconciliation.test.ts',
        'tests/unit/d1-analytics-http.test.ts',
        'tests/unit/analytics-client.test.ts',
        'tests/unit/analytics-privacy.test.ts',
        'tests/unit/analytics-runtime-config.test.ts',
        'tests/components/analytics-operations.test.ts',
        'tests/components/analytics-preview-privacy.test.ts'
      ],
      riskCategories: ['analytics-and-consent', 'data-integrity', 'privacy-and-legal'],
      frontId: 'platform-trust'
    },
    {
      id: 'security-compliance',
      title: 'Seguridad, privacidad y cumplimiento',
      ownership: [
        { kind: 'prefix', prefix: 'SEC' },
        { kind: 'prefix', prefix: 'LEG' }
      ],
      dependsOn: [],
      dependsOnContracts: ['base-d1'],
      testSelectors: [
        'tests/unit/d1-catalog-relations.test.ts',
        'tests/unit/d1-catalog-relations-http.test.ts',
        'tests/unit/d1-catalog-relations-native.test.ts',
        'tests/unit/cart-snapshots-browser.test.ts',
        'tests/unit/d1-cart-snapshots.test.ts',
        'tests/unit/d1-cart-snapshots-http.test.ts',
        'tests/unit/d1-cart-snapshots-native.test.ts',
        'tests/components/cart-snapshots-panel.test.ts',
        'tests/components/cart-shared.test.ts',
        'tests/unit/d1-order-purchase-reference.test.ts',
        'tests/unit/d1-order-purchase-reference-readers.test.ts',
        'tests/unit/d1-promotion-basket-preview.test.ts',
        'tests/unit/d1-promotion-basket-preview-http.test.ts',
        'tests/unit/d1-checkout-replay-authority.test.ts',
        'tests/unit/d1-identity-security-notice.test.ts',
        'tests/unit/d1-identity-security-native.test.ts',
        'tests/unit/native-guest-order-browser.test.ts',
        'tests/unit/d1-account-security-schema.test.ts',
        'tests/unit/d1-account-security-notices.test.ts',
        'tests/unit/d1-email-change-security-notices.test.ts',
        'tests/unit/d1-company-security-notices.test.ts',
        'tests/unit/d1-account-security-native.test.ts',
        'tests/unit/d1-guest-order-email.test.ts',
        'tests/unit/d1-guest-order-access.test.ts',
        'tests/unit/d1-guest-order-access-entrypoints.test.ts',
        'tests/unit/d1-authorization.test.ts',
        'tests/unit/d1-admin-capabilities.test.ts',
        'tests/unit/d1-account-security.test.ts',
        'tests/components/account-security.test.ts',
        'tests/unit/d1-mfa.test.ts',
        'tests/unit/d1-mfa-enrollment.test.ts',
        'tests/unit/security-boundaries.test.ts',
        'tests/unit/support-browser-security-audit.test.ts',
        'tests/unit/analytics-privacy.test.ts'
      ],
      riskCategories: ['identity-and-authorization', 'privacy-and-legal'],
      frontId: 'platform-trust'
    },
    {
      id: 'integrations-apis',
      title: 'Integraciones, APIs y procesos asíncronos',
      ownership: [{ kind: 'prefix', prefix: 'INT' }],
      dependsOn: [],
      dependsOnContracts: ['base-d1', 'identity-authorization'],
      testSelectors: [
        'tests/unit/d1-guest-order-email-scheduled.test.ts',
        'tests/unit/cloudflare-shop-phase3-wiring.test.ts',
        'tests/unit/d1-scheduled-outbox-isolation.test.ts',
        'tests/unit/d1-email-outbox.test.ts',
        'tests/unit/d1-identity-email-integration.test.ts',
        'tests/unit/d1-transactional-email-delivery.test.ts',
        'tests/unit/worker-build-evidence.test.ts',
        'tests/unit/cloudflare-shop-ingress.test.ts'
      ],
      riskCategories: ['data-integrity', 'delivery-and-recovery', 'external-provider'],
      frontId: 'platform-trust'
    },
    {
      id: 'performance-observability',
      title: 'Rendimiento, observabilidad y continuidad',
      ownership: [
        { kind: 'prefix', prefix: 'PER' },
        { kind: 'prefix', prefix: 'OBS' }
      ],
      dependsOn: [],
      dependsOnContracts: ['base-d1', 'provider-ports'],
      testSelectors: [
        'tests/unit/d1-scheduled-outbox-isolation.test.ts',
        'tests/unit/d1-errors.test.ts',
        'tests/unit/cloudflare-shop-ingress.test.ts',
        'tests/unit/worker-build-evidence.test.ts',
        'tests/unit/cloudflare-shop-config.test.ts',
        'tests/unit/cloudflare-canary.test.ts'
      ],
      riskCategories: ['availability-and-performance', 'delivery-and-recovery'],
      frontId: 'platform-trust'
    },
    {
      id: 'quality-delivery',
      title: 'Testing, cobertura, CI y releases',
      ownership: [
        { kind: 'prefix', prefix: 'TST' },
        { kind: 'prefix', prefix: 'CIC' }
      ],
      dependsOn: [],
      dependsOnContracts: ['base-d1'],
      testSelectors: [
        'tests/unit/ui-state-harness.test.ts',
        'tests/unit/ui-state-visual-artifacts.test.ts',
        'tests/components/ui-state-harness.test.ts',
        'tests/unit/cloudflare-shop-phase3-wiring.test.ts',
        'tests/unit/d1-migrations-upgrade.test.ts',
        'tests/unit/d1-scheduled-outbox-isolation.test.ts',
        'tests/unit/deterministic-fixtures.test.ts',
        'tests/unit/d1-admin-entrypoints.test.ts',
        'tests/unit/d1-fixture-loading.test.ts',
        'tests/unit/requirements-inventory-consistency.test.ts',
        'tests/unit/vitest-node-config.test.ts',
        'tests/unit/flake-monitor.test.ts',
        'tests/unit/flaky-policy.test.ts',
        'tests/unit/ci-artifacts.test.ts',
        'tests/unit/remote-test-browser.test.ts',
        'tests/unit/oracle-shop-audit.test.ts',
        'tests/unit/oracle-workflow-policy.test.ts',
        'tests/unit/neteco-oracle-job-hook.test.ts',
        'tests/unit/neteco-oracle-isolation-probe.test.ts',
        'tests/unit/neteco-oracle-network-probe.test.ts',
        'tests/unit/neteco-oracle-network-bootstrap.test.ts',
        'tests/unit/neteco-oracle-egress-seccomp.test.ts',
        'tests/unit/neteco-oracle-capability-probe.test.ts',
        'tests/unit/neteco-oracle-image-stage.test.ts',
        'tests/unit/neteco-oracle-build-storage.test.ts',
        'tests/unit/neteco-oracle-docker.test.ts',
        'tests/unit/storage-preflight.test.ts',
        'tests/unit/audit-cloudflare-shop-cli.test.ts',
        'tests/unit/cloudflare-canary.test.ts'
      ],
      riskCategories: ['test-determinism', 'delivery-and-recovery'],
      frontId: 'platform-trust'
    }
  ],
  excludedRequirementIds: ['CHK-021', 'CUS-020', 'CUS-021', 'CUS-025', 'CUS-029', 'COM-018', 'MKT-034'],
  rootIntegration: {
    owner: 'root',
    dependsOnFrontIds: ['storefront-commerce', 'customer-operations', 'platform-trust']
  },
  validationBoundary: 'local-only'
}

function countBy(rows: readonly FunctionalRequirementRow[], field: 'status' | 'priority' | 'phase_min') {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const key = row[field]
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}

function countSummary(rows: readonly FunctionalRequirementRow[]): FunctionalDeliveryCounts {
  return {
    total: rows.length,
    byStatus: countBy(rows, 'status'),
    byPriority: countBy(rows, 'priority'),
    byPhase: countBy(rows, 'phase_min')
  }
}

function ownsId(ownership: readonly RequirementOwnership[], id: string): boolean {
  const match = /^([A-Z]{2,4})-(\d+)$/.exec(id)
  if (!match) return false
  const [, prefix, numberText] = match
  const number = Number(numberText)

  return ownership.some((rule) => {
    if (rule.prefix !== prefix) return false
    if (rule.kind === 'prefix') return true
    return number >= rule.from && number <= rule.to
  })
}

/** Build dynamic requirement batches from the caller's current CSV records. */
export function buildFunctionalDeliveryPlan(rows: readonly FunctionalRequirementRow[]): FunctionalDeliveryPlanSnapshot {
  const activeRows = rows.filter((row) => row.status !== 'DISCARDED')
  const excludedRequirements = rows
    .filter((row) => row.status === 'DISCARDED')
    .map((row) => ({ ...row }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const modules: FunctionalDeliveryBatch[] = FUNCTIONAL_DELIVERY_PLAN.modules.map((definition) => {
    const requirements = activeRows
      .filter((row) => ownsId(definition.ownership, row.id))
      .map((row) => ({ ...row }))
      .sort((left, right) => left.id.localeCompare(right.id))

    return {
      ...definition,
      ownership: definition.ownership.map((rule) => ({ ...rule })),
      dependsOn: [...definition.dependsOn],
      dependsOnContracts: [...definition.dependsOnContracts],
      testSelectors: [...definition.testSelectors],
      riskCategories: [...definition.riskCategories],
      requirementIds: requirements.map((row) => row.id),
      requirements,
      counts: countSummary(requirements)
    }
  })

  return {
    manifestId: FUNCTIONAL_DELIVERY_PLAN.id,
    execution: [...FUNCTIONAL_DELIVERY_PLAN.execution],
    dependencySemantics: FUNCTIONAL_DELIVERY_PLAN.dependencySemantics,
    sharedContracts: FUNCTIONAL_DELIVERY_PLAN.sharedContracts.map((contract) => ({ ...contract })),
    fronts: FUNCTIONAL_DELIVERY_PLAN.fronts.map((front) => ({ ...front })),
    modules,
    excludedRequirementIds: [...FUNCTIONAL_DELIVERY_PLAN.excludedRequirementIds],
    excludedRequirements,
    rootIntegration: {
      owner: 'root',
      dependsOnFrontIds: [...FUNCTIONAL_DELIVERY_PLAN.rootIntegration.dependsOnFrontIds]
    },
    validationBoundary: FUNCTIONAL_DELIVERY_PLAN.validationBoundary,
    totals: {
      historicalRequirementCount: rows.length,
      activeRequirementCount: activeRows.length,
      discardedRequirementCount: excludedRequirements.length,
      byStatus: countBy(rows, 'status'),
      byPriority: countBy(rows, 'priority'),
      byPhase: countBy(rows, 'phase_min')
    }
  }
}

function matchesOwnershipRule(rule: RequirementOwnership): boolean {
  if (!/^[A-Z]{2,4}$/.test(rule.prefix)) return false
  if (rule.kind === 'prefix') return true
  const width = rule.width ?? 3
  return (
    Number.isInteger(rule.from) &&
    Number.isInteger(rule.to) &&
    rule.from >= 0 &&
    rule.to >= rule.from &&
    Number.isInteger(width) &&
    width > 0
  )
}

function ownershipRulesOverlap(left: RequirementOwnership, right: RequirementOwnership): boolean {
  if (left.prefix !== right.prefix) return false
  if (left.kind === 'prefix' || right.kind === 'prefix') return true
  return left.from <= right.to && right.from <= left.to
}

function sameCounts(actual: Record<string, number>, expected: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)])
  return [...keys].every((key) => actual[key] === expected[key])
}

function sameRequirement(left: FunctionalRequirementRow, right: FunctionalRequirementRow): boolean {
  return (
    left.id === right.id &&
    left.phase_min === right.phase_min &&
    left.domain === right.domain &&
    left.priority === right.priority &&
    left.status === right.status &&
    left.requirement === right.requirement &&
    left.acceptance === right.acceptance
  )
}

/**
 * Return all structural and input-data problems; optional selector validation
 * lets a CLI provide filesystem checks without coupling this shared module to
 * Node APIs.
 */
export function validateFunctionalDeliveryPlan(
  plan: FunctionalDeliveryPlanSnapshot,
  rows: readonly FunctionalRequirementRow[],
  options: FunctionalDeliveryValidationOptions = {}
): string[] {
  const failures: string[] = []
  const allowedStatuses = new Set<string>(FUNCTIONAL_REQUIREMENT_STATUSES)
  if (plan.dependencySemantics !== 'entry-contracts-only') {
    failures.push('Dependencies must be entry contracts, not whole-module completion gates')
  }
  if (plan.execution.join(',') !== 'prepare-tests,implement-fronts,root-integration,joint-tests') {
    failures.push('Execution must prepare tests first, then implement fronts, integrate, and joint-test')
  }
  if (plan.modules.length < 12 || plan.modules.length > 16) {
    failures.push(`Expected 12–16 functional modules, found ${plan.modules.length}`)
  }

  const sourceById = new Map<string, FunctionalRequirementRow>()
  const duplicateSourceIds = new Set<string>()
  for (const row of rows) {
    if (sourceById.has(row.id)) duplicateSourceIds.add(row.id)
    else sourceById.set(row.id, row)
    if (!allowedStatuses.has(row.status)) failures.push(`Unknown status ${row.status} for ${row.id}`)
    if (row.status !== 'DISCARDED') {
      if (!row.requirement.trim()) failures.push(`Active requirement ${row.id} has an empty requirement`)
      if (!row.acceptance.trim()) failures.push(`Active requirement ${row.id} has empty acceptance criteria`)
      if (!row.priority.trim()) failures.push(`Active requirement ${row.id} has no priority`)
      if (!row.phase_min.trim()) failures.push(`Active requirement ${row.id} has no minimum phase`)
    }
  }
  if (duplicateSourceIds.size) {
    failures.push(`Duplicate source requirement IDs: ${[...duplicateSourceIds].sort().join(', ')}`)
  }

  const modulesById = new Map<string, FunctionalDeliveryBatch>()
  const duplicateModuleIds = new Set<string>()
  for (const module of plan.modules) {
    if (modulesById.has(module.id)) duplicateModuleIds.add(module.id)
    else modulesById.set(module.id, module)
    if (!module.ownership.length) failures.push(`Module ${module.id} has no ownership rules`)
    for (const rule of module.ownership) {
      if (!matchesOwnershipRule(rule)) failures.push(`Module ${module.id} has an invalid ownership rule`)
    }
    if (!module.riskCategories.length) failures.push(`Module ${module.id} has no risk categories`)
    if (!module.testSelectors.length) failures.push(`Module ${module.id} has no focused test selectors`)
    if (options.selectorExists) {
      for (const selector of module.testSelectors) {
        if (!options.selectorExists(selector)) {
          failures.push(`Missing test selector ${selector} for module ${module.id}`)
        }
      }
    }
  }
  if (duplicateModuleIds.size) {
    failures.push(`Duplicate module IDs: ${[...duplicateModuleIds].sort().join(', ')}`)
  }

  const contractById = new Map<string, { id: string; owner: string; purpose: string }>()
  for (const contract of plan.sharedContracts) {
    if (contractById.has(contract.id)) failures.push(`Duplicate shared contract ID: ${contract.id}`)
    contractById.set(contract.id, contract)
    if (!contract.purpose.trim()) failures.push(`Shared contract ${contract.id} has no purpose`)
    if (contract.owner !== 'root' && !modulesById.has(contract.owner)) {
      failures.push(`Shared contract ${contract.id} has unknown owner ${contract.owner}`)
    }
  }
  for (const module of plan.modules) {
    const contractDependencies = new Set<string>()
    for (const contractId of module.dependsOnContracts) {
      if (contractDependencies.has(contractId)) {
        failures.push(`Duplicate contract dependency ${contractId} in module ${module.id}`)
      }
      contractDependencies.add(contractId)
      if (!contractById.has(contractId)) {
        failures.push(`Module ${module.id} has missing contract dependency ${contractId}`)
      }
    }
  }

  for (let leftIndex = 0; leftIndex < plan.modules.length; leftIndex += 1) {
    const leftModule = plan.modules[leftIndex]!
    if (!plan.fronts.some((front) => front.id === leftModule.frontId)) {
      failures.push(`Module ${leftModule.id} references missing front ${leftModule.frontId}`)
    }
    for (const rightModule of plan.modules.slice(leftIndex + 1)) {
      for (const leftRule of leftModule.ownership) {
        for (const rightRule of rightModule.ownership) {
          if (ownershipRulesOverlap(leftRule, rightRule)) {
            failures.push(`Overlapping ownership selectors in modules ${leftModule.id} and ${rightModule.id}`)
          }
        }
      }
    }
  }

  const assignedSet = new Set<string>()
  for (const module of plan.modules) {
    const expectedIds = rows
      .filter((row) => row.status !== 'DISCARDED' && ownsId(module.ownership, row.id))
      .map((row) => row.id)
      .sort()
    if ([...module.requirementIds].sort().join('\n') !== expectedIds.join('\n')) {
      failures.push(`Module ${module.id} requirement IDs do not match its ownership rules`)
    }
    if (module.counts.total !== module.requirements.length) {
      failures.push(`Module ${module.id} total count does not match its requirement rows`)
    }
    const expectedCounts = countSummary(module.requirements)
    if (
      !sameCounts(module.counts.byStatus, expectedCounts.byStatus) ||
      !sameCounts(module.counts.byPriority, expectedCounts.byPriority) ||
      !sameCounts(module.counts.byPhase, expectedCounts.byPhase)
    ) {
      failures.push(`Module ${module.id} counts are not derived from its requirement rows`)
    }
    const requirementRecordIds = module.requirements.map((row) => row.id)
    if (
      new Set(requirementRecordIds).size !== requirementRecordIds.length ||
      [...requirementRecordIds].sort().join('\n') !== [...module.requirementIds].sort().join('\n')
    ) {
      failures.push(`Module ${module.id} requirement rows do not match its requirement IDs`)
    }
    for (const row of module.requirements) {
      const source = sourceById.get(row.id)
      if (!source) failures.push(`Unknown requirement record in module ${module.id}: ${row.id}`)
      else if (!sameRequirement(row, source)) {
        failures.push(`Requirement phase, priority, status, or criteria changed for ${row.id}`)
      }
    }

    for (const id of module.requirementIds) {
      if (assignedSet.has(id)) failures.push(`Duplicate requirement assignment: ${id}`)
      assignedSet.add(id)

      const source = sourceById.get(id)
      if (!source) failures.push(`Unknown requirement ID in module ${module.id}: ${id}`)
      else {
        if (source.status === 'DISCARDED') {
          failures.push(`Discarded requirement ${id} is assigned to module ${module.id}`)
        }
        if (!ownsId(module.ownership, id)) {
          failures.push(`Requirement ${id} is outside module ${module.id} ownership`)
        }
      }
    }
  }

  for (const row of rows) {
    if (row.status !== 'DISCARDED' && !assignedSet.has(row.id)) {
      failures.push(`Missing active requirement ID: ${row.id}`)
    }
  }

  const actualDiscardedIds = rows
    .filter((row) => row.status === 'DISCARDED')
    .map((row) => row.id)
    .sort()
  const declaredDiscardedIds = [...plan.excludedRequirementIds].sort()
  if (new Set(declaredDiscardedIds).size !== declaredDiscardedIds.length) {
    failures.push('Duplicate discarded requirement exclusion IDs')
  }
  if (declaredDiscardedIds.join('\n') !== actualDiscardedIds.join('\n')) {
    failures.push('Explicit discarded requirement exclusions do not match discarded CSV rows')
  }
  for (const id of plan.excludedRequirementIds) {
    if (!sourceById.has(id)) failures.push(`Unknown explicitly excluded requirement ID: ${id}`)
  }
  const preservedDiscardedIds = plan.excludedRequirements.map((row) => row.id).sort()
  if (preservedDiscardedIds.join('\n') !== actualDiscardedIds.join('\n')) {
    failures.push('Discarded CSV rows are not fully preserved in excludedRequirements')
  }
  for (const row of plan.excludedRequirements) {
    const source = sourceById.get(row.id)
    if (!source) failures.push(`Unknown discarded history record: ${row.id}`)
    else if (!sameRequirement(row, source)) {
      failures.push(`Discarded requirement history changed for ${row.id}`)
    }
  }

  const totalCounts = countSummary(rows)
  if (
    plan.totals.historicalRequirementCount !== rows.length ||
    plan.totals.activeRequirementCount !== rows.filter((row) => row.status !== 'DISCARDED').length ||
    plan.totals.discardedRequirementCount !== actualDiscardedIds.length ||
    !sameCounts(plan.totals.byStatus, totalCounts.byStatus) ||
    !sameCounts(plan.totals.byPriority, totalCounts.byPriority) ||
    !sameCounts(plan.totals.byPhase, totalCounts.byPhase)
  ) {
    failures.push('Plan totals/status/priority/phase counts are not derived from source rows')
  }

  const frontIds = plan.fronts.map((front) => front.id)
  if (new Set(frontIds).size !== frontIds.length) failures.push('Duplicate implementation front IDs')
  if (frontIds.length !== 3) failures.push(`Expected exactly 3 implementation fronts, found ${frontIds.length}`)
  for (const frontId of plan.rootIntegration.dependsOnFrontIds) {
    if (!frontIds.includes(frontId)) {
      failures.push(`Root integration references missing implementation front ${frontId}`)
    }
  }
  for (const module of plan.modules) {
    const dependencies = new Set<string>()
    for (const dependencyId of module.dependsOn) {
      if (dependencies.has(dependencyId)) {
        failures.push(`Duplicate dependency ${dependencyId} in module ${module.id}`)
      }
      dependencies.add(dependencyId)
      if (!modulesById.has(dependencyId)) {
        failures.push(`Module ${module.id} has missing dependency ${dependencyId}`)
      }
      if (dependencyId === module.id) failures.push(`Module ${module.id} has a self-dependency`)
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>()
  const reportedCycles = new Set<string>()
  const visit = (moduleId: string, path: string[]) => {
    if (visitState.get(moduleId) === 'visited') return
    if (visitState.get(moduleId) === 'visiting') {
      const start = path.indexOf(moduleId)
      const cycle = [...path.slice(start), moduleId]
      const key = cycle.slice(0, -1).sort().join('|')
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key)
        failures.push(`Module dependency cycle: ${cycle.join(' -> ')}`)
      }
      return
    }

    visitState.set(moduleId, 'visiting')
    const module = modulesById.get(moduleId)
    for (const dependencyId of module?.dependsOn ?? []) {
      if (modulesById.has(dependencyId)) visit(dependencyId, [...path, moduleId])
    }
    visitState.set(moduleId, 'visited')
  }
  for (const moduleId of modulesById.keys()) visit(moduleId, [])

  return failures
}
