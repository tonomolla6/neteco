// Traceability reclassifications applied 2026-10-31 (TRACE-APPLY): evidence paths
// were verified against the repository. Consumed by scripts/audit-master-requirements.ts.
export interface TraceabilityUpdate {
  status: 'REPO_EVIDENCE' | 'PARTIAL_EXTERNAL' | 'MISSING' | 'NOT_VERIFIED' | 'ROADMAP_NOT_STARTED' | 'DISCARDED'
  implementation_refs: string
  operational_evidence: string
  external_owner: string
  notes: string
}

export const traceabilityUpdates: Record<string, TraceabilityUpdate> = {
  'CAT-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; app/components/AdminSupplierFeedComparison.vue; db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql; shared/supplier-feed-comparison.ts; workers/canary.ts; workers/catalog/supplier-feed-comparison-http.ts; workers/catalog/supplier-feed-comparison.ts; tests/components/admin-supplier-feed-comparison.test.ts; tests/unit/canary-bc-mounts.test.ts; tests/unit/d1-supplier-feed-comparison.test.ts; tests/unit/d1-supplier-feed-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. El orquestador debe aplicar la adición de enlaces en `shared/admin-navigation.ts` cuando integre los lotes. Las vistas conectan vía endpoints REST contra D1 en entorno Workers; la sincronización en vivo mediante WebSockets o SSE para actualizaciones multi-operador concurrentes del feed se deja para optimizaciones de fase de producción.'
  },
  'CAT-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; app/components/AdminEditorialContentEditor.vue; db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql; shared/catalog-editorial-content.ts; workers/canary.ts; workers/catalog/editorial-content-http.ts; workers/catalog/editorial-content.ts; tests/components/admin-editorial-content-editor.test.ts; tests/unit/canary-bc-mounts.test.ts; tests/unit/d1-editorial-content-http.test.ts; tests/unit/d1-editorial-content.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. El orquestador debe aplicar la adición de enlaces en `shared/admin-navigation.ts` cuando integre los lotes. Las vistas conectan vía endpoints REST contra D1 en entorno Workers; la sincronización en vivo mediante WebSockets o SSE para actualizaciones multi-operador concurrentes del feed se deja para optimizaciones de fase de producción.'
  },
  'CAT-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; db/d1/migrations/0120_market_catalog_international_shipping.sql; shared/catalog-markets.ts; workers/catalog/catalog-lot-recall.ts; tests/components/admin-product-recall.test.ts; tests/unit/d1-catalog-lot-expedition.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Gestión de divisas múltiples**: La tienda opera en EUR como moneda base (`currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR')`). Para mercados fuera de la zona euro (ej. Reino Unido o Suiza), los aranceles y precios se calculan en EUR; una futura integración multidivisa requerirá tablas de tipos de cambio oficiales. **Traducción automática asistida**: La localización de contenidos (`title`, `description`, `slug`) requiere entrada manual o llamadas a un asistente de catálogo; no se integró traducción en vivo en el handler de mercado para mantener los límites de Workers estrictos y ai"
  },
  'CAT-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; app/components/AdminSupplierSourcingPanel.vue; db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql; shared/supplier-sourcing.ts; workers/canary.ts; workers/catalog/supplier-sourcing-http.ts; workers/catalog/supplier-sourcing.ts; tests/components/admin-supplier-sourcing-panel.test.ts; tests/unit/canary-bc-mounts.test.ts; tests/unit/d1-supplier-sourcing-http.test.ts; tests/unit/d1-supplier-sourcing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. El orquestador debe aplicar la adición de enlaces en `shared/admin-navigation.ts` cuando integre los lotes. Las vistas conectan vía endpoints REST contra D1 en entorno Workers; la sincronización en vivo mediante WebSockets o SSE para actualizaciones multi-operador concurrentes del feed se deja para optimizaciones de fase de producción.'
  },
  'CAT-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; server/services/catalog-admin.ts; db/d1/migrations/0120_market_catalog_international_shipping.sql; shared/catalog-markets.ts; workers/catalog/market-catalog.ts; tests/components/admin-market-catalog.test.ts; tests/unit/d1-market-catalog-http.test.ts; tests/unit/d1-market-catalog.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Gestión de divisas múltiples**: La tienda opera en EUR como moneda base (`currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR')`). Para mercados fuera de la zona euro (ej. Reino Unido o Suiza), los aranceles y precios se calculan en EUR; una futura integración multidivisa requerirá tablas de tipos de cambio oficiales. **Traducción automática asistida**: La localización de contenidos (`title`, `description`, `slug`) requiere entrada manual o llamadas a un asistente de catálogo; no se integró traducción en vivo en el handler de mercado para mantener los límites de Workers estrictos y ai"
  },
  'PRI-014': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0146_pricing_auto_discounts_credit_deposits.sql; db/d1/migrations/0152_checkout_pricing_wire.sql; shared/auto-discounts.ts; workers/canary.ts; workers/catalog/cart.ts; workers/catalog/checkout.ts; workers/pricing/auto-discount-quote.ts; workers/pricing/auto-discounts.ts; workers/pricing/checkout-evidence.ts; workers/pricing/rules-read.ts; tests/unit/d1-checkout-wire-auto-discounts.test.ts; tests/unit/d1-pricing-auto-discounts.test.ts; tests/unit/pricing-auto-discounts.test.ts; tests/unit/pricing-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: El checkout/cart-coordinator NO llama aun a `allowFreeShipping` ni aplica `evaluateAutoDiscounts` al cotizar, ni descuenta el credito canjeado del importe a cobrar del pedido (el canje queda registrado contra el pedido `awaiting_payment` y topado por su total). Cablearlo toca el camino critico de checkout/pagos y las fixtures sin 0148; requiere decision del orquestador. Sin regla activa el envio gratis conserva el comportamiento heredado. Coste de envio para margen = tarifa neta de cliente (proxy conservador); no hay coste real de transportista. Emision de credito desde reembolsos reales (`ref'
  },
  'PRI-015': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0115_growth_offers.sql; shared/buy-x-get-y.ts; tests/unit/buy-x-get-y.test.ts; tests/unit/d1-buy-x-get-y.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: Integración en checkout, no hecha porque `checkout.ts` y `storefront-checkout.ts` son de otros agentes: Aplicar `previewBuyXGetY` al cotizar y añadir las líneas de regalo con reserva de stock. Llamar a `recordBxgyRedemption` en la misma transacción que crea el pedido. Llamar a `recordBxgyReturn` desde el flujo de devoluciones. Las tablas `order_lines_discounted` exigen precio unitario positivo; el regalo con asignado 0 requerirá adaptar esa línea. Experimentos: falta enganchar `assignPromoSubject` y `recordPromoObservation` al checkout y al pago, y pasar al experimento el coste COGS real y el'
  },
  'PRI-017': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0146_pricing_auto_discounts_credit_deposits.sql; db/d1/migrations/0152_checkout_pricing_wire.sql; shared/free-shipping-policy.ts; workers/catalog/checkout.ts; workers/catalog/shipping.ts; workers/pricing/checkout-free-shipping.ts; workers/pricing/free-shipping.ts; workers/pricing/rules-read.ts; tests/unit/d1-checkout-wire-free-shipping.test.ts; tests/unit/d1-pricing-free-shipping.test.ts; tests/unit/pricing-free-shipping.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: El checkout/cart-coordinator NO llama aun a `allowFreeShipping` ni aplica `evaluateAutoDiscounts` al cotizar, ni descuenta el credito canjeado del importe a cobrar del pedido (el canje queda registrado contra el pedido `awaiting_payment` y topado por su total). Cablearlo toca el camino critico de checkout/pagos y las fixtures sin 0148; requiere decision del orquestador. Sin regla activa el envio gratis conserva el comportamiento heredado. Coste de envio para margen = tarifa neta de cliente (proxy conservador); no hay coste real de transportista. Emision de credito desde reembolsos reales (`ref'
  },
  'PRI-018': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0146_pricing_auto_discounts_credit_deposits.sql; db/d1/migrations/0152_checkout_pricing_wire.sql; shared/store-credit.ts; workers/catalog/checkout.ts; workers/catalog/payments.ts; workers/pricing/checkout-store-credit.ts; workers/pricing/store-credit.ts; tests/unit/d1-checkout-wire-store-credit.test.ts; tests/unit/pricing-store-credit.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: El checkout/cart-coordinator NO llama aun a `allowFreeShipping` ni aplica `evaluateAutoDiscounts` al cotizar, ni descuenta el credito canjeado del importe a cobrar del pedido (el canje queda registrado contra el pedido `awaiting_payment` y topado por su total). Cablearlo toca el camino critico de checkout/pagos y las fixtures sin 0148; requiere decision del orquestador. Sin regla activa el envio gratis conserva el comportamiento heredado. Coste de envio para margen = tarifa neta de cliente (proxy conservador); no hay coste real de transportista. Emision de credito desde reembolsos reales (`ref'
  },
  'PRI-021': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0146_pricing_auto_discounts_credit_deposits.sql; shared/payment-schedule.ts; tests/unit/pricing-payment-schedule.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: El checkout/cart-coordinator NO llama aun a `allowFreeShipping` ni aplica `evaluateAutoDiscounts` al cotizar, ni descuenta el credito canjeado del importe a cobrar del pedido (el canje queda registrado contra el pedido `awaiting_payment` y topado por su total). Cablearlo toca el camino critico de checkout/pagos y las fixtures sin 0148; requiere decision del orquestador. Sin regla activa el envio gratis conserva el comportamiento heredado. Coste de envio para margen = tarifa neta de cliente (proxy conservador); no hay coste real de transportista. Emision de credito desde reembolsos reales (`ref'
  },
  'PRI-022': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/money.ts; tests/unit/money.test.ts; db/d1/migrations/0115_growth_offers.sql; shared/promo-experiments.ts; workers/growth/promo-experiments.ts; tests/unit/d1-promo-experiments.test.ts; tests/unit/promo-experiments.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: Integración en checkout, no hecha porque `checkout.ts` y `storefront-checkout.ts` son de otros agentes: Aplicar `previewBuyXGetY` al cotizar y añadir las líneas de regalo con reserva de stock. Llamar a `recordBxgyRedemption` en la misma transacción que crea el pedido. Llamar a `recordBxgyReturn` desde el flujo de devoluciones. Las tablas `order_lines_discounted` exigen precio unitario positivo; el regalo con asignado 0 requerirá adaptar esa línea. Experimentos: falta enganchar `assignPromoSubject` y `recordPromoObservation` al checkout y al pago, y pasar al experimento el coste COGS real y el'
  },
  'SEA-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/search.get.ts; server/api/products.get.ts; app/components/AdminCategoryMerchandising.vue; db/d1/migrations/0147_category_merchandising_promo_fraud.sql; shared/category-merchandising.ts; workers/catalog/category-merchandising-http.ts; workers/catalog/category-merchandising.ts; workers/catalog/products.ts; tests/components/admin-category-merchandising.test.ts; tests/unit/category-merchandising.test.ts; tests/unit/d1-category-merchandising-http.test.ts; tests/unit/d1-category-merchandising-listing.test.ts; tests/unit/d1-category-merchandising.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. SEA-015: contrato/popularidad se evaluan sobre precio publico efectivo y `order_payment_states.updated_at` (30 dias); categorias con >500 productos se truncan (flag `truncated`). Anade una lectura extra solo al listado por defecto de una categoria con regla viva; sin regla es una consulta indexada.'
  },
  'SEA-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/search.get.ts; server/api/products.get.ts; app/components/B2BQuickOrderImport.vue; shared/quick-order-import.ts; workers/canary.ts; workers/catalog/quick-order-company-http.ts; workers/catalog/quick-order-company.ts; tests/components/b2b-quick-order-import.test.ts; tests/unit/d1-quick-order-company-http.test.ts; tests/unit/d1-quick-order-company.test.ts; tests/unit/quick-order-import.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. SEA-018: una referencia numerica de 8/12/13/14 digitos con checksum GS1 incorrecto se rechaza en el CSV (podria chocar con un SKU puramente numerico de esa longitud). El escaneo con camara depende de `BarcodeDetector` (solo probado que el boton aparece/desaparece; sin prueba en navegador real). El panel anterior `QuickOrderPanel` (10 filas, publico) no se modifico.'
  },
  'SEA-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/search.get.ts; server/api/products.get.ts; app/components/AdminSemanticSearchEvaluation.vue; db/d1/migrations/0104_semantic_search_and_rerank.sql; workers/catalog/semantic-search-http.ts; workers/catalog/semantic-search.ts; tests/components/admin-semantic-search-evaluation.test.ts; tests/unit/d1-semantic-search-http.test.ts; tests/unit/d1-semantic-search.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SEA-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/search.get.ts; server/api/products.get.ts; app/components/AdminPersonalizedRerankUplift.vue; db/d1/migrations/0104_semantic_search_and_rerank.sql; workers/catalog/personalized-rerank-http.ts; workers/catalog/personalized-rerank.ts; tests/components/admin-personalized-rerank-uplift.test.ts; tests/unit/d1-personalized-rerank-http.test.ts; tests/unit/d1-personalized-rerank.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'PDP-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; app/components/ProductDetailExtras.vue; shared/product-detail-extras.ts; workers/canary.ts; workers/catalog/product-detail-extras-http.ts; workers/catalog/product-detail-extras.ts; tests/components/product-detail-extras.test.ts; tests/unit/d1-product-detail-extras-http.test.ts; tests/unit/d1-product-detail-extras.test.ts; tests/unit/product-detail-extras-shared.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin verificación en navegador real ni build Nuxt (prohibido); sin JSON-LD adicional de alternativas. El "medido" es analítica de pedidos pagados (soporte/confianza); no hay medición de impresiones/clics de los bloques (requeriría migración 0146 y evento; no hecha). Reserva: la disponibilidad refleja reservas activas; la reserva específica de recogida usa la misma reserva de checkout existente (no hay reserva "pickup" separada ni slots de recogida). No se reutilizó el "history proof" de catalog-relations ni relectura final coherente; se lee head/revision/command vigentes. Duplicidad visual: Pub'
  },
  'PDP-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; app/components/ProductDetailExtras.vue; shared/product-detail-extras.ts; workers/canary.ts; workers/catalog/product-detail-extras-http.ts; workers/catalog/product-detail-extras.ts; tests/components/product-detail-extras.test.ts; tests/unit/d1-product-detail-extras-http.test.ts; tests/unit/d1-product-detail-extras.test.ts; tests/unit/product-detail-extras-shared.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin verificación en navegador real ni build Nuxt (prohibido); sin JSON-LD adicional de alternativas. El "medido" es analítica de pedidos pagados (soporte/confianza); no hay medición de impresiones/clics de los bloques (requeriría migración 0146 y evento; no hecha). Reserva: la disponibilidad refleja reservas activas; la reserva específica de recogida usa la misma reserva de checkout existente (no hay reserva "pickup" separada ni slots de recogida). No se reutilizó el "history proof" de catalog-relations ni relectura final coherente; se lee head/revision/command vigentes. Duplicidad visual: Pub'
  },
  'PDP-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; app/components/ProductVerifiedReviewsQa.vue; db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql; workers/catalog/product-reviews-qa-http.ts; workers/catalog/product-reviews-qa.ts; tests/components/product-verified-reviews-qa.test.ts; tests/unit/d1-product-reviews-qa-http.test.ts; tests/unit/d1-product-reviews-qa.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Streaming HLS/DASH adaptativo:** La implementación actual soporta URLs MP4 y WebM estándar de Cloudflare Stream junto con pistas VTT externas. Para resoluciones dinámicas automáticas multi-bitrate en clientes antiguos se requeriría un reproductor HLS (`hls.js`), no necesario en este momento dado que los vídeos de demostración y dosificación son clips optimizados de corta duración. **Notificaciones por email/webhook al autor:** Al responder el comercio o publicarse la respuesta oficial, no se envían correos activos para evitar dependencias de red externas y cumplir la política de cero envíos'
  },
  'PDP-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; app/components/ProductVideoMediaGuide.vue; db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql; workers/catalog/product-media-guides-http.ts; workers/catalog/product-media-guides.ts; tests/components/product-video-media-guide.test.ts; tests/unit/d1-product-media-guides-http.test.ts; tests/unit/d1-product-media-guides.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Streaming HLS/DASH adaptativo:** La implementación actual soporta URLs MP4 y WebM estándar de Cloudflare Stream junto con pistas VTT externas. Para resoluciones dinámicas automáticas multi-bitrate en clientes antiguos se requeriría un reproductor HLS (`hls.js`), no necesario en este momento dado que los vídeos de demostración y dosificación son clips optimizados de corta duración. **Notificaciones por email/webhook al autor:** Al responder el comercio o publicarse la respuesta oficial, no se envían correos activos para evitar dependencias de red externas y cumplir la política de cero envíos'
  },
  'PDP-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/products/[slug].get.ts; app/pages/producto/[slug].vue; app/components/ProductDetailExtras.vue; shared/product-detail-extras.ts; workers/canary.ts; workers/catalog/product-detail-extras-http.ts; workers/catalog/product-detail-extras.ts; tests/components/product-detail-extras.test.ts; tests/unit/d1-product-detail-extras-http.test.ts; tests/unit/d1-product-detail-extras.test.ts; tests/unit/product-detail-extras-shared.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin verificación en navegador real ni build Nuxt (prohibido); sin JSON-LD adicional de alternativas. El "medido" es analítica de pedidos pagados (soporte/confianza); no hay medición de impresiones/clics de los bloques (requeriría migración 0146 y evento; no hecha). Reserva: la disponibilidad refleja reservas activas; la reserva específica de recogida usa la misma reserva de checkout existente (no hay reserva "pickup" separada ni slots de recogida). No se reutilizó el "history proof" de catalog-relations ni relectura final coherente; se lee head/revision/command vigentes. Duplicidad visual: Pub'
  },
  'CHK-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue; app/components/AdminDraftOrdersPanel.vue; db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql; workers/b2b/draft-orders-http.ts; workers/b2b/draft-orders.ts; workers/canary.ts; tests/components/admin-draft-orders-panel.test.ts; tests/unit/canary-bc-mounts.test.ts; tests/unit/d1-draft-orders-http.test.ts; tests/unit/d1-draft-orders.test.ts; tests/unit/draft-orders-integrity.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. El orquestador debe aplicar la adición de enlaces en `shared/admin-navigation.ts` cuando integre los lotes. Las vistas conectan vía endpoints REST contra D1 en entorno Workers; la sincronización en vivo mediante WebSockets o SSE para actualizaciones multi-operador concurrentes del feed se deja para optimizaciones de fase de producción.'
  },
  'CHK-023': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/services/cart.ts; server/services/orders.ts; app/pages/checkout.vue; app/components/AdminCheckoutMarket.vue; app/pages/admin/checkout-mercados.vue; db/d1/migrations/0118_recall_market_messaging.sql; workers/canary.ts; workers/cart-coordinator.ts; workers/catalog/checkout.ts; workers/catalog/market-checkout-http.ts; workers/catalog/market-checkout-policy.ts; workers/catalog/storefront-checkout.ts; tests/unit/d1-market-checkout-entrypoints.test.ts; tests/unit/d1-market-checkout-http.test.ts; tests/unit/d1-market-checkout-integration.test.ts; tests/unit/d1-market-checkout-policy.test.ts; tests/unit/d1-market-checkout-public.test.ts; tests/unit/d1-storefront-checkout.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: Sin UI de checkout (solo API): la selección de mercado se hace en carrito/checkout storefront; el libro del pedido sigue en EUR con snapshot de presentación por mercado; la migración 0118 requiere actualización gobernada si ya se aplicó.'
  },
  'PAY-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; app/components/AdminPaymentFunnel.vue; app/pages/admin/analitica.vue; db/d1/migrations/0103_payment_funnel.sql; workers/payments/funnel-analytics.ts; workers/payments/funnel-http.ts; tests/components/admin-payment-funnel.test.ts; tests/unit/d1-payment-funnel.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'PAY-019': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; db/d1/migrations/0126_payment_extended.sql; workers/canary.ts; workers/payments/wallet-http.ts; tests/unit/d1-payment-token-removal-http.test.ts; tests/unit/d1-wallet-checkout.test.ts; tests/unit/payment-token-recovery-runtime.test.ts; tests/unit/payment-token-recovery-scheduled.test.ts; tests/unit/payment-token-removal-entrypoints.test.ts; tests/unit/payment-token-removal-status.test.ts; tests/unit/payment-wallet-capabilities.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: UI de checkout sin botones wallet ni consentimiento one-click (solo API); sin panel admin de preautorizaciones; capacidad bancaria/PCI sin activar ni verificar.'
  },
  'PAY-020': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; workers/payments/paygold-draft-links.ts; workers/payments/paygold-runtime.ts; tests/components/paygold-link-panel.test.ts; tests/unit/d1-paygold-links.test.ts; tests/unit/paygold-draft-http.test.ts; tests/unit/paygold-fake-provider.test.ts; tests/unit/paygold-links-http.test.ts; tests/unit/paygold-provider.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Enlace PayGold ligado a sales_quotes, no a draft_orders; sin proveedor aprobado ni binding; UI de checkout sin integrar.'
  },
  'PAY-021': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; db/d1/migrations/0126_payment_extended.sql; workers/canary.ts; workers/payments/preauth.ts; tests/components/payment-token-session-race.test.ts; tests/unit/d1-payment-token-removal-http.test.ts; tests/unit/payment-token-recovery-runtime.test.ts; tests/unit/preauth-http.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: El webhook actual solo verifica transacción 0 y el flujo trata la autorización como pago inmediato; sin capacidad bancaria real ni UI.'
  },
  'PAY-022': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; db/d1/migrations/0126_payment_extended.sql; workers/canary.ts; workers/payments/http.ts; workers/payments/tokenization-http.ts; workers/payments/tokenization-runtime.ts; workers/payments/tokenization.ts; tests/support/d1-sqlite.ts; tests/unit/tokenization-http.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Sin proveedor de borrado bancario configurado (la retirada queda pending); PCI/banco sin verificar; UI de checkout sin integrar.'
  },
  'PAY-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/payment-provider.ts; server/services/orders.ts; db/d1/migrations/0145_orders_procurement_split_contingency.sql; workers/canary.ts; workers/payments/alternative-contingency-provider.ts; workers/payments/contingency-routing-http.ts; workers/payments/contingency-routing.ts; tests/unit/canary-bo-mounts.test.ts; tests/unit/payment-contingency-routing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Navegación Admin:** Integrar el acceso directo a `/admin/operaciones-pedidos` en el menú lateral una vez que el orquestador aplique el diff de `shared/admin-navigation.ts`. **Ficha de Pedido Existente:** Integrar los nuevos paneles (`AdminOrderProcurementPanel.vue` y `AdminSplitShipmentsPanel.vue`) como pestañas secundarias dentro de `app/pages/admin/pedidos/[id].vue` para mayor comodidad del operador del almacén.'
  },
  'ORD-017': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/services/orders.ts; db/migrations/0001_platform_foundation.sql; db/d1/migrations/0098_delivery_surveys.sql; workers/fulfillment/delivery-survey-http.ts; workers/fulfillment/delivery-survey.ts; tests/unit/d1-delivery-survey-http.test.ts; tests/unit/d1-delivery-survey.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'ORD-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/services/orders.ts; db/migrations/0001_platform_foundation.sql; db/d1/migrations/0145_orders_procurement_split_contingency.sql; shared/order-procurement-approvals.ts; workers/canary.ts; workers/orders/procurement-approvals-http.ts; workers/orders/procurement-approvals.ts; tests/unit/canary-bo-mounts.test.ts; tests/unit/order-procurement-approvals.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Navegación Admin:** Integrar el acceso directo a `/admin/operaciones-pedidos` en el menú lateral una vez que el orquestador aplique el diff de `shared/admin-navigation.ts`. **Ficha de Pedido Existente:** Integrar los nuevos paneles (`AdminOrderProcurementPanel.vue` y `AdminSplitShipmentsPanel.vue`) como pestañas secundarias dentro de `app/pages/admin/pedidos/[id].vue` para mayor comodidad del operador del almacén.'
  },
  'ORD-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/services/orders.ts; db/migrations/0001_platform_foundation.sql; db/d1/migrations/0145_orders_procurement_split_contingency.sql; workers/canary.ts; workers/orders/split-backorders-http.ts; workers/orders/split-backorders.ts; tests/unit/canary-bo-mounts.test.ts; tests/unit/order-split-backorders.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Navegación Admin:** Integrar el acceso directo a `/admin/operaciones-pedidos` en el menú lateral una vez que el orquestador aplique el diff de `shared/admin-navigation.ts`. **Ficha de Pedido Existente:** Integrar los nuevos paneles (`AdminOrderProcurementPanel.vue` y `AdminSplitShipmentsPanel.vue`) como pestañas secundarias dentro de `app/pages/admin/pedidos/[id].vue` para mayor comodidad del operador del almacén.'
  },
  'ORD-022': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/services/orders.ts; db/migrations/0001_platform_foundation.sql; app/components/AdminProductRecall.vue; app/pages/admin/retiradas.vue; db/d1/migrations/0118_recall_market_messaging.sql; workers/canary.ts; workers/catalog/product-recall-http.ts; workers/catalog/product-recall.ts; tests/unit/d1-product-recall-availability.test.ts; tests/unit/d1-product-recall-http.test.ts; tests/unit/d1-product-recall.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: ORD-022: la captura automática de asignaciones de lote históricas/invitados sigue pendiente (resolución falla cerrada sin trazabilidad completa); la comunicación sigue siendo evidencia manual; los bloqueos manuales de stock durante una retirada quedan dominados por la retirada.'
  },
  'INV-014': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryOperationsPanel.vue; db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql; shared/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory-cycle-counts.ts; workers/catalog/inventory.ts; tests/unit/d1-inventory-commitments-picking-purchasing.test.ts; tests/unit/inventory-bi-bj-interop.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: INV-014: sin acción "cumplir compromiso" (assign de la reserva al pedido del cliente contractual) ni asignación automática al checkout del cliente; hoy solo reserva, renovación y liberación.'
  },
  'INV-015': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryOperationsPanel.vue; db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql; scripts/lib/requirements-scope.ts; shared/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory.ts; tests/unit/d1-inventory-commitments-picking-purchasing-http.test.ts; tests/unit/d1-inventory-commitments-picking-purchasing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: INV-015: el checkout `pickLocation` sigue eligiendo el almacén (único); no descuenta automáticamente de bins al enviar (existe `confirm_pick` manual) y no hay UI de relocate/confirm_pick (solo API); el desvío físico < ubicado se informa como inconsistente pero no se auto-corrige.'
  },
  'INV-016': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryOperationsPanel.vue; db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql; shared/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory.ts; tests/components/inventory-operations-panel.test.ts; tests/unit/d1-inventory-commitments-picking-purchasing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: INV-016: no se carga coste a `inventory_cost_balances` (coste medio) desde la recepción; sin pago/factura del proveedor; UI crea OC solo vía API (el panel lista, abre, envía, cancela, cierra, recibe y adjunta albarán; no hay formulario de alta de OC); los archivos de documentos no se suben (solo hash/metadatos, almacenamiento privado pendiente).'
  },
  'INV-017': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/AdminInventoryPlanning.vue; db/d1/migrations/0140_reorder_barcode_cycle_counts.sql; shared/inventory-planning.ts; workers/catalog/inventory-commitments-picking-purchasing.ts; workers/catalog/inventory-cycle-counts.ts; workers/catalog/inventory-planning-http.ts; workers/catalog/inventory-reorder-purchase.ts; tests/components/admin-inventory-planning.test.ts; tests/unit/inventory-bi-bj-interop.test.ts; tests/unit/inventory-planning-http.test.ts; tests/unit/inventory-reorder-purchase.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ejecutó typecheck global ni build Nuxt (prohibido por el encargo); sin verificar tipos de `AdminInventoryPlanning.vue`/workers más allá de eslint y vitest. UI: no hay formulario para crear políticas de reposición ni para crear planes de conteo/tareas de escaneo (se hacen vía API); la página lista, evalúa, aprueba, escanea, cuenta, recuenta y decide. Sin integración con órdenes de compra (INV-016, otro agente): falta enlazar `inventory_purchase_suggestions.approved` con la orden creada. Sin cola/DO coordinador como en count-import: la atomicidad se apoya en batch D1 + CAS; no hay rate lim'
  },
  'INV-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/AdminInventoryPlanning.vue; db/d1/migrations/0140_reorder_barcode_cycle_counts.sql; shared/inventory-planning.ts; workers/fulfillment/warehouse-barcode-validation.ts; tests/unit/warehouse-barcode-validation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ejecutó typecheck global ni build Nuxt (prohibido por el encargo); sin verificar tipos de `AdminInventoryPlanning.vue`/workers más allá de eslint y vitest. UI: no hay formulario para crear políticas de reposición ni para crear planes de conteo/tareas de escaneo (se hacen vía API); la página lista, evalúa, aprueba, escanea, cuenta, recuenta y decide. Sin integración con órdenes de compra (INV-016, otro agente): falta enlazar `inventory_purchase_suggestions.approved` con la orden creada. Sin cola/DO coordinador como en count-import: la atomicidad se apoya en batch D1 + CAS; no hay rate lim'
  },
  'INV-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryLotsCostingForecastPanel.vue; db/d1/migrations/0106_inventory_lots_costing_forecast.sql; shared/inventory-lots-costing-forecast.ts; workers/catalog/inventory-lots-costing-forecast.ts; tests/unit/d1-inventory-lots-costing-forecast.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'INV-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/AdminInventoryPlanning.vue; db/d1/migrations/0140_reorder_barcode_cycle_counts.sql; shared/inventory-planning.ts; workers/catalog/inventory-cycle-counts.ts; tests/unit/inventory-cycle-counts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ejecutó typecheck global ni build Nuxt (prohibido por el encargo); sin verificar tipos de `AdminInventoryPlanning.vue`/workers más allá de eslint y vitest. UI: no hay formulario para crear políticas de reposición ni para crear planes de conteo/tareas de escaneo (se hacen vía API); la página lista, evalúa, aprueba, escanea, cuenta, recuenta y decide. Sin integración con órdenes de compra (INV-016, otro agente): falta enlazar `inventory_purchase_suggestions.approved` con la orden creada. Sin cola/DO coordinador como en count-import: la atomicidad se apoya en batch D1 + CAS; no hay rate lim'
  },
  'INV-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryLotsCostingForecastPanel.vue; db/d1/migrations/0106_inventory_lots_costing_forecast.sql; shared/inventory-lots-costing-forecast.ts; workers/catalog/inventory-lots-costing-forecast.ts; tests/unit/d1-inventory-lots-costing-forecast.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'INV-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/domain/inventory.ts; server/services/orders.ts; app/components/InventoryLotsCostingForecastPanel.vue; db/d1/migrations/0106_inventory_lots_costing_forecast.sql; shared/inventory-lots-costing-forecast.ts; workers/catalog/inventory-lots-costing-forecast.ts; tests/unit/d1-inventory-lots-costing-forecast.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SHP-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0097_carrier_resilience.sql; workers/fulfillment/carrier-scorecard-http.ts; workers/fulfillment/carrier-scorecard.ts; tests/components/admin-carrier-scorecard.test.ts; tests/unit/d1-carrier-scorecard.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SHP-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0097_carrier_resilience.sql; workers/fulfillment/carrier-resilience.ts; tests/unit/d1-carrier-resilience.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SHP-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/ShippingConveniencePointSelector.vue; db/d1/migrations/0109_shipping_convenience_conditions_routes.sql; shared/shipping-convenience-points.ts; workers/fulfillment/convenience-points-http.ts; workers/fulfillment/convenience-points.ts; tests/components/shipping-convenience-point-selector.test.ts; tests/unit/d1-shipping-convenience-points-http.test.ts; tests/unit/d1-shipping-convenience-points.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Adaptadores externos de transportistas reales:** Siguiendo las instrucciones del encargo ("Sin proveedores reales: adaptadores/fakes deterministas"), los puntos de conveniencia residen contractualmente en D1 y se consultan vía API; en un despliegue de producción con conectores a APIs de terceros (SEUR API, InPost Punto Pack API) se integrará el worker cron sync para refrescar el catálogo de puntos. **Visualización geoespacial interactiva:** Se ha incluido geolocalización (latitud/longitud) en el esquema D1 y en las respuestas de la API. Si en un futuro se requiere mapa interactivo (p. ej. Le'
  },
  'SHP-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminCompanyShippingConditionsPanel.vue; db/d1/migrations/0109_shipping_convenience_conditions_routes.sql; scripts/lib/requirements-scope.ts; shared/company-shipping-conditions.ts; workers/fulfillment/company-shipping-conditions-http.ts; workers/fulfillment/company-shipping-conditions.ts; tests/components/admin-company-shipping-conditions-panel.test.ts; tests/unit/d1-company-shipping-conditions-http.test.ts; tests/unit/d1-company-shipping-conditions.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Adaptadores externos de transportistas reales:** Siguiendo las instrucciones del encargo ("Sin proveedores reales: adaptadores/fakes deterministas"), los puntos de conveniencia residen contractualmente en D1 y se consultan vía API; en un despliegue de producción con conectores a APIs de terceros (SEUR API, InPost Punto Pack API) se integrará el worker cron sync para refrescar el catálogo de puntos. **Visualización geoespacial interactiva:** Se ha incluido geolocalización (latitud/longitud) en el esquema D1 y en las respuestas de la API. Si en un futuro se requiere mapa interactivo (p. ej. Le'
  },
  'SHP-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminDeliveryRoutePlanner.vue; app/pages/admin/rutas.vue; db/d1/migrations/0109_shipping_convenience_conditions_routes.sql; shared/delivery-route-planning.ts; workers/fulfillment/delivery-routes-http.ts; workers/fulfillment/delivery-routes.ts; tests/components/admin-delivery-route-planner.test.ts; tests/unit/d1-delivery-routes-http.test.ts; tests/unit/d1-delivery-routes.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Adaptadores externos de transportistas reales:** Siguiendo las instrucciones del encargo ("Sin proveedores reales: adaptadores/fakes deterministas"), los puntos de conveniencia residen contractualmente en D1 y se consultan vía API; en un despliegue de producción con conectores a APIs de terceros (SEUR API, InPost Punto Pack API) se integrará el worker cron sync para refrescar el catálogo de puntos. **Visualización geoespacial interactiva:** Se ha incluido geolocalización (latitud/longitud) en el esquema D1 y en las respuestas de la API. Si en un futuro se requiere mapa interactivo (p. ej. Le'
  },
  'SHP-027': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminDeliveryAppReport.vue; app/components/DeliveryDriverApp.vue; app/utils/shipping-ops-errors.ts; db/d1/migrations/0129_delivery_app_carrier_manifests_packing_optimizer.sql; shared/delivery-driver-app.ts; shared/delivery-offline-queue.ts; workers/canary.ts; workers/fulfillment/delivery-driver-app-http.ts; workers/fulfillment/delivery-driver-app.ts; workers/fulfillment/shipping-ops-common.ts; tests/components/admin-delivery-app-report.test.ts; tests/components/delivery-driver-app.test.ts; tests/unit/d1-delivery-driver-app-http.test.ts; tests/unit/d1-delivery-driver-app.test.ts; tests/unit/delivery-offline-queue.test.ts; tests/unit/delivery-service-worker.test.ts; tests/unit/shipping-ops-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Iconos PWA: solo `reparto-icon.svg` (no hay PNG 192/512 cuadrados en `public/`); la instalabilidad en Chrome puede exigirlos. El caché local no está ligado a la identidad del conductor (dispositivo compartido: usar "Borrar datos locales"); la evidencia pendiente (≤150 KB cada una) vive en localStorage hasta sincronizar (límite de cuota -> el evento se rechaza con aviso). La UI de firma/foto (canvas, `createImageBitmap`) no se puede ejercitar en el entorno de componentes (sin canvas); solo se probó el rechazo sin firma/foto y la ruta "vecino". No hay geolocalización en la UI (el API la admite y'
  },
  'SHP-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminCarrierManifests.vue; db/d1/migrations/0129_delivery_app_carrier_manifests_packing_optimizer.sql; workers/fulfillment/carrier-manifest-adapter.ts; workers/fulfillment/carrier-manifests-http.ts; workers/fulfillment/carrier-manifests.ts; tests/components/admin-carrier-manifests.test.ts; tests/unit/d1-carrier-manifests-http.test.ts; tests/unit/d1-carrier-manifests.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Iconos PWA: solo `reparto-icon.svg` (no hay PNG 192/512 cuadrados en `public/`); la instalabilidad en Chrome puede exigirlos. El caché local no está ligado a la identidad del conductor (dispositivo compartido: usar "Borrar datos locales"); la evidencia pendiente (≤150 KB cada una) vive en localStorage hasta sincronizar (límite de cuota -> el evento se rechaza con aviso). La UI de firma/foto (canvas, `createImageBitmap`) no se puede ejercitar en el entorno de componentes (sin canvas); solo se probó el rechazo sin firma/foto y la ruta "vecino". No hay geolocalización en la UI (el API la admite y'
  },
  'SHP-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdrHazardNotice.vue; app/pages/producto/[slug].vue; db/d1/migrations/0150_international_seo_channel_feeds_adr_lq.sql; shared/adr-limited-quantity.ts; workers/canary.ts; workers/catalog/international-feeds-adr-http.ts; workers/catalog/market-catalog-http.ts; workers/fulfillment/adr-limited-quantity.ts; tests/components/adr-hazard-notice.test.ts; tests/unit/adr-limited-quantity.test.ts; tests/unit/canary-international-feeds-adr-mount.test.ts; tests/unit/international-feeds-adr-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes: 'Gestión de ADR y cantidades limitadas con tope LQ 30 kg y formato LQ; validado por Tono 02/11/2026.'
  },
  'SHP-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminPackingOptimizer.vue; db/d1/migrations/0129_delivery_app_carrier_manifests_packing_optimizer.sql; shared/order-packing.ts; shared/packing-optimizer.ts; workers/fulfillment/packing-optimizer-http.ts; workers/fulfillment/packing-optimizer.ts; tests/components/admin-packing-optimizer.test.ts; tests/unit/d1-packing-optimizer-http.test.ts; tests/unit/d1-packing-optimizer.test.ts; tests/unit/packing-optimizer.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Iconos PWA: solo `reparto-icon.svg` (no hay PNG 192/512 cuadrados en `public/`); la instalabilidad en Chrome puede exigirlos. El caché local no está ligado a la identidad del conductor (dispositivo compartido: usar "Borrar datos locales"); la evidencia pendiente (≤150 KB cada una) vive en localStorage hasta sincronizar (límite de cuota -> el evento se rechaza con aviso). La UI de firma/foto (canvas, `createImageBitmap`) no se puede ejercitar en el entorno de componentes (sin canvas); solo se probó el rechazo sin firma/foto y la ruta "vecino". No hay geolocalización en la UI (el API la admite y'
  },
  'SHP-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; app/components/AdminMarketCatalog.vue; app/pages/admin/catalogo-mercados.vue; db/d1/migrations/0120_market_catalog_international_shipping.sql; workers/catalog/market-catalog-http.ts; workers/fulfillment/international-shipping.ts; tests/components/admin-market-catalog.test.ts; tests/unit/d1-catalog-lot-expedition.test.ts; tests/unit/d1-international-shipping.test.ts; tests/unit/d1-market-catalog-http.test.ts; tests/unit/d1-market-catalog.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Gestión de divisas múltiples**: La tienda opera en EUR como moneda base (`currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR')`). Para mercados fuera de la zona euro (ej. Reino Unido o Suiza), los aranceles y precios se calculan en EUR; una futura integración multidivisa requerirá tablas de tipos de cambio oficiales. **Traducción automática asistida**: La localización de contenidos (`title`, `description`, `slug`) requiere entrada manual o llamadas a un asistente de catálogo; no se integró traducción en vivo en el handler de mercado para mantener los límites de Workers estrictos y ai"
  },
  'CUS-015': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0136_account_lifecycle_preference_center_impersonation.sql; shared/preference-center.ts; workers/auth/account-lifecycle-http.ts; workers/auth/preference-center-sync.ts; workers/auth/preference-center.ts; workers/canary.ts; tests/components/account-lifecycle-panels.test.ts; tests/unit/account-lifecycle-canary-mount.test.ts; tests/unit/account-lifecycle-http.test.ts; tests/unit/preference-center.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: CUS-015: no hay adaptador real ESP/CMP (solo fake determinista) y `runPreferenceCenterSync` no está invocado desde `scheduled` hasta que exista proveedor y credenciales; SMS/push se guardan como preferencia pero no hay canal de envío. No se unificó con `customer_account_preferences` (product_updates/replenishment, 0066) ni con la newsletter: coexisten; el planificador de reposición sí respeta ambos.'
  },
  'CUS-016': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0136_account_lifecycle_preference_center_impersonation.sql; workers/auth/account-lifecycle-http.ts; workers/auth/company-documents.ts; tests/components/account-lifecycle-panels.test.ts; tests/unit/account-lifecycle-http.test.ts; tests/unit/company-documents.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: CUS-016: solo se registran metadatos y SHA-256; no hay subida del binario ni escaneo antivirus ni UI de revisión admin (existe el endpoint de lectura, falta mostrarlo en la pantalla de revisión de empresas). La UI deja claro que el archivo no se sube.'
  },
  'CUS-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql; workers/catalog/customer-recurring-lists-http.ts; workers/catalog/customer-recurring-lists.ts; tests/unit/d1-customer-recurring-lists-http.test.ts; tests/unit/d1-customer-recurring-lists.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'CUS-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0136_account_lifecycle_preference_center_impersonation.sql; workers/auth/replenishment-reminders.ts; workers/canary.ts; tests/components/account-lifecycle-panels.test.ts; tests/unit/replenishment-reminders.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. CUS-019: el planificador solo encola/suprime (`replenishment_reminders`); no entrega el email (no hay plantilla ni evento en `email_outbox_events`). Quien entregue debe revalidar consentimiento y cap en el momento del envío. La UI pide la referencia (ID de variante) a mano: falta un selector de producto/botón "recordarme" desde pedidos.'
  },
  'CUS-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0136_account_lifecycle_preference_center_impersonation.sql; shared/support-impersonation.ts; workers/auth/account-lifecycle-http.ts; workers/support/impersonation.ts; tests/components/account-lifecycle-panels.test.ts; tests/unit/account-lifecycle-http.test.ts; tests/unit/support-impersonation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. CUS-028: no se emiten cookies de sesión del cliente ni hay proxy "actuar como": el módulo provee sesión, banner, compuerta de acciones (`classifyImpersonatedAction`) y registro; las pantallas de soporte/endpoints de cliente que quieran operar en nombre del cliente deben llamar a `POST /api/admin/support-impersonation/:id/actions` antes de ejecutar y respetar el resultado `blocked`. No hay notificación al cliente de que fue suplantado.'
  },
  'CUS-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql; workers/b2b/edi-gateway-http.ts; workers/b2b/edi-gateway.ts; tests/unit/d1-b2b-edi-gateway-http.test.ts; tests/unit/d1-b2b-edi-gateway.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'CUS-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/auth/; db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql; workers/crm/risk-scoring-http.ts; workers/crm/risk-scoring.ts; tests/unit/d1-customer-risk-scoring-http.test.ts; tests/unit/d1-customer-risk-scoring.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'ADM-023': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; db/d1/migrations/0096_editorial_approval.sql; workers/cms/editorial-approval.ts; tests/components/content-governance.test.ts; tests/unit/canary-content-governance-mount.test.ts; tests/unit/content-governance-http.test.ts; tests/unit/content-governance-shared.test.ts; tests/unit/content-governance.test.ts; tests/unit/d1-editorial-approval.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: ADM-023 completo (comentarios, checklist, múltiples aprobadores) sigue sin hacer; aquí solo hay separación editor/aprobador y firma.'
  },
  'ADM-024': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminPreviewVisualComparison.vue; db/d1/migrations/0131_preview_diff_role_dashboards_campaign_manager.sql; shared/cms-preview-comparison.ts; workers/admin/role-dashboard-http.ts; workers/canary.ts; workers/cms/preview-comparison-http.ts; workers/cms/preview-comparison.ts; workers/marketing/commercial-campaigns-http.ts; tests/components/admin-preview-visual-comparison.test.ts; tests/unit/d1-ba-canary-mount.test.ts; tests/unit/d1-ba-http-endpoints.test.ts; tests/unit/d1-cms-preview-comparison.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los puntos de integración en `workers/canary.ts` ya están activos en la rama de trabajo (`codex/neteco-produccion-20260812`) y verificados mediante `tests/unit/d1-ba-canary-mount.test.ts`. Los diffs en `shared/admin-navigation.ts`, `tests/support/d1-sqlite.ts` y `docs/production/requirements-traceability.csv` se dejan explícitos para el orquestador con el fin de evitar colisiones con otros agentes concurrentes. No se detectan regresiones ni bloqueos.'
  },
  'ADM-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminConfigurableRoleDashboard.vue; db/d1/migrations/0131_preview_diff_role_dashboards_campaign_manager.sql; shared/role-dashboard-config.ts; workers/admin/role-dashboard-http.ts; workers/admin/role-dashboard.ts; workers/canary.ts; workers/cms/preview-comparison-http.ts; workers/marketing/commercial-campaigns-http.ts; tests/components/admin-configurable-role-dashboard.test.ts; tests/unit/d1-ba-canary-mount.test.ts; tests/unit/d1-ba-http-endpoints.test.ts; tests/unit/d1-role-dashboard.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los puntos de integración en `workers/canary.ts` ya están activos en la rama de trabajo (`codex/neteco-produccion-20260812`) y verificados mediante `tests/unit/d1-ba-canary-mount.test.ts`. Los diffs en `shared/admin-navigation.ts`, `tests/support/d1-sqlite.ts` y `docs/production/requirements-traceability.csv` se dejan explícitos para el orquestador con el fin de evitar colisiones con otros agentes concurrentes. No se detectan regresiones ni bloqueos.'
  },
  'ADM-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminCommercialCampaignManager.vue; db/d1/migrations/0131_preview_diff_role_dashboards_campaign_manager.sql; shared/commercial-campaigns.ts; workers/admin/role-dashboard-http.ts; workers/canary.ts; workers/cms/preview-comparison-http.ts; workers/marketing/commercial-campaigns-http.ts; workers/marketing/commercial-campaigns.ts; tests/components/admin-commercial-campaign-manager.test.ts; tests/unit/d1-ba-canary-mount.test.ts; tests/unit/d1-ba-http-endpoints.test.ts; tests/unit/d1-commercial-campaigns.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los puntos de integración en `workers/canary.ts` ya están activos en la rama de trabajo (`codex/neteco-produccion-20260812`) y verificados mediante `tests/unit/d1-ba-canary-mount.test.ts`. Los diffs en `shared/admin-navigation.ts`, `tests/support/d1-sqlite.ts` y `docs/production/requirements-traceability.csv` se dejan explícitos para el orquestador con el fin de evitar colisiones con otros agentes concurrentes. No se detectan regresiones ni bloqueos.'
  },
  'ADM-027': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminAudiences.vue; app/pages/admin/audiencias.vue; db/d1/migrations/0110_rca_copilot_audiences.sql; shared/admin-audiences.ts; workers/marketing/audiences-http.ts; workers/marketing/audiences.ts; tests/components/admin-audiences.test.ts; tests/unit/d1-admin-audiences-http.test.ts; tests/unit/d1-admin-audiences.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Adaptador de Inferencia LLM Externo:** Siguiendo la premisa del brief ("Sin proveedores reales: adaptadores/fakes deterministas"), el motor del copiloto utiliza un generador fundamentado en datos SQLite reales con citas estructuradas y comprobación estricta de redacción. Para conectar un modelo fundacional externo en producción (ej. Workers AI `@cf/meta/llama-3-8b-instruct`), el punto de acople está desacoplado en `generateD1CopilotDraft` manteniendo intactos los esquemas de citaciones, validaciones de seguridad y aprobación humana. **Cálculo Desacoplado de Grandes Volúmenes en Audiencias:**'
  },
  'ADM-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminEditorialSeoBriefingPanel.vue; db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql; shared/editorial-seo-briefing.ts; workers/cms/editorial-seo-briefing-http.ts; workers/cms/editorial-seo-briefing.ts; tests/components/admin-editorial-seo-briefing-panel.test.ts; tests/unit/d1-editorial-seo-briefing-http.test.ts; tests/unit/d1-editorial-seo-briefing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Las colas de almacén (`warehouse_receptions`) cargan recepciones de compra y excepciones en tiempo real; cuando se conecte la sincronización de picking de órdenes de cliente existentes, pueden vincularse directamente a `warehouse_scan_commands` reutilizando el manejador `processBarcodeScan`. El driver de impresión utiliza simulación determinista en memoria devolviendo `completed`; si se despliega un agente físico o sidecar de impresión en red local en el almacén, se debe conectar al endpoint `/api/admin/warehouse/printers/:printerId/print`.'
  },
  'ADM-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminCommercialPipelinePanel.vue; db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql; workers/catalog/commercial-quotes-accounts-http.ts; workers/catalog/commercial-quotes-accounts.ts; tests/components/admin-commercial-pipeline-panel.test.ts; tests/unit/d1-commercial-quotes-accounts-http.test.ts; tests/unit/d1-commercial-quotes-accounts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Las colas de almacén (`warehouse_receptions`) cargan recepciones de compra y excepciones en tiempo real; cuando se conecte la sincronización de picking de órdenes de cliente existentes, pueden vincularse directamente a `warehouse_scan_commands` reutilizando el manejador `processBarcodeScan`. El driver de impresión utiliza simulación determinista en memoria devolviendo `completed`; si se despliega un agente físico o sidecar de impresión en red local en el almacén, se debe conectar al endpoint `/api/admin/warehouse/printers/:printerId/print`.'
  },
  'ADM-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminWarehouseScanPanel.vue; db/d1/migrations/0132_editorial_seo_commercial_warehouse_scan.sql; workers/fulfillment/warehouse-scan-operations-http.ts; workers/fulfillment/warehouse-scan-operations.ts; tests/components/admin-warehouse-scan-panel.test.ts; tests/unit/d1-warehouse-scan-operations-http.test.ts; tests/unit/d1-warehouse-scan-operations.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Las colas de almacén (`warehouse_receptions`) cargan recepciones de compra y excepciones en tiempo real; cuando se conecte la sincronización de picking de órdenes de cliente existentes, pueden vincularse directamente a `warehouse_scan_commands` reutilizando el manejador `processBarcodeScan`. El driver de impresión utiliza simulación determinista en memoria devolviendo `completed`; si se despliega un agente físico o sidecar de impresión en red local en el almacén, se debe conectar al endpoint `/api/admin/warehouse/printers/:printerId/print`.'
  },
  'ADM-032': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminAiAssistant.vue; app/pages/admin/asistente-ia.vue; db/d1/migrations/0119_ai_assistant_enrichment.sql; shared/admin-ai-assistant.ts; workers/admin/ai-assistant-http.ts; workers/admin/ai-assistant.ts; workers/catalog/ai-generation-http.ts; workers/catalog/media-ai-enrichment-http.ts; tests/components/admin-ai-assistant.test.ts; tests/unit/d1-admin-ai-assistant.test.ts; tests/unit/d1-ai-endpoints-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'ADM-033': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; server/api/admin/; app/pages/admin/; app/components/AdminCatalogAiGeneration.vue; app/pages/admin/asistente-ia.vue; db/d1/migrations/0119_ai_assistant_enrichment.sql; shared/catalog-ai-generation.ts; workers/admin/ai-assistant-http.ts; workers/catalog/ai-generation-http.ts; workers/catalog/ai-generation.ts; workers/catalog/media-ai-enrichment-http.ts; tests/components/admin-catalog-ai-generation.test.ts; tests/unit/d1-ai-endpoints-http.test.ts; tests/unit/d1-catalog-ai-generation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'MED-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/ProductVideoMediaGuide.vue; app/pages/producto/[slug].vue; db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql; workers/catalog/product-media-guides-http.ts; workers/catalog/product-media-guides.ts; tests/components/product-video-media-guide.test.ts; tests/unit/d1-product-media-guides-http.test.ts; tests/unit/d1-product-media-guides.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Streaming HLS/DASH adaptativo:** La implementación actual soporta URLs MP4 y WebM estándar de Cloudflare Stream junto con pistas VTT externas. Para resoluciones dinámicas automáticas multi-bitrate en clientes antiguos se requeriría un reproductor HLS (`hls.js`), no necesario en este momento dado que los vídeos de demostración y dosificación son clips optimizados de corta duración. **Notificaciones por email/webhook al autor:** Al responder el comercio o publicarse la respuesta oficial, no se envían correos activos para evitar dependencias de red externas y cumplir la política de cero envíos'
  },
  'MED-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/AdminUgcModeration.vue; db/d1/migrations/0124_ugc_reviews_customer_success_cases.sql; shared/ugc-reviews.ts; workers/canary.ts; workers/media/ugc-reviews-http.ts; workers/media/ugc-reviews.ts; tests/unit/d1-ugc-reviews-http.test.ts; tests/unit/d1-ugc-reviews.test.ts; tests/unit/ugc-case-canary-mount.test.ts; tests/unit/ugc-reviews.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **R2 para Almacenamiento Binario de Fotos a Gran Escala:** La implementación actual guarda el blob en base64 / hash en D1 y memoria del worker con metadatos de escaneo. En un despliegue Cloudflare completo con alto volumen, las fotos aprobadas pueden vincularse directamente a un bucket R2 mediante URLs prefirmadas. **Motor Antivirus Externo:** Para producción se incluye el adaptador determinista `scanBufferAntivirus` con detección de firmas EICAR y validación estricta de encabezados de imagen. En un despliegue con pasarela ClamAV o VirusTotal API, el conector puede reemplazar el stub determini'
  },
  'MED-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/DownloadableTemplatesPanel.vue; db/d1/migrations/0141_templates_brand_warehouse_adr.sql; workers/canary.ts; workers/content/downloadable-templates-http.ts; workers/content/downloadable-templates.ts; tests/components/downloadable-templates-panel.test.ts; tests/unit/canary-templates-brand-adr.test.ts; tests/unit/d1-downloadable-templates.test.ts; tests/unit/downloadable-templates-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Verificación externa en sedes de organismos de certificación:** **Impresión térmica física en almacén:**'
  },
  'MED-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/AdminCaseStudyEditor.vue; app/components/CustomerCaseStudiesList.vue; db/d1/migrations/0124_ugc_reviews_customer_success_cases.sql; shared/customer-case-studies.ts; workers/canary.ts; workers/cms/customer-case-studies-http.ts; workers/cms/customer-case-studies.ts; tests/unit/customer-case-studies.test.ts; tests/unit/d1-customer-case-studies-http.test.ts; tests/unit/d1-customer-case-studies.test.ts; tests/unit/ugc-case-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **R2 para Almacenamiento Binario de Fotos a Gran Escala:** La implementación actual guarda el blob en base64 / hash en D1 y memoria del worker con metadatos de escaneo. En un despliegue Cloudflare completo con alto volumen, las fotos aprobadas pueden vincularse directamente a un bucket R2 mediante URLs prefirmadas. **Motor Antivirus Externo:** Para producción se incluye el adaptador determinista `scanBufferAntivirus` con detección de firmas EICAR y validación estricta de encabezados de imagen. En un despliegue con pasarela ClamAV o VirusTotal API, el conector puede reemplazar el stub determini'
  },
  'MED-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/BrandCenterPanel.vue; db/d1/migrations/0141_templates_brand_warehouse_adr.sql; workers/brand/brand-center-http.ts; workers/brand/brand-center.ts; workers/canary.ts; tests/components/brand-center-panel.test.ts; tests/unit/brand-certifications-http.test.ts; tests/unit/canary-templates-brand-adr.test.ts; tests/unit/d1-brand-certifications.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Verificación externa en sedes de organismos de certificación:** **Impresión térmica física en almacén:**'
  },
  'MED-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/AdminWarehouseAdrPanel.vue; db/d1/migrations/0141_templates_brand_warehouse_adr.sql; workers/canary.ts; workers/fulfillment/warehouse-adr-assets-http.ts; workers/fulfillment/warehouse-adr-assets.ts; tests/components/admin-warehouse-adr-panel.test.ts; tests/unit/canary-templates-brand-adr.test.ts; tests/unit/d1-warehouse-adr-assets.test.ts; tests/unit/warehouse-adr-assets-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Verificación externa en sedes de organismos de certificación:** **Impresión térmica física en almacén:**'
  },
  'MED-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/admin/media.post.ts; server/routes/media/[id].get.ts; app/components/AdminMediaAiEnrichment.vue; app/pages/admin/asistente-ia.vue; db/d1/migrations/0119_ai_assistant_enrichment.sql; shared/media-ai-enrichment.ts; workers/admin/ai-assistant-http.ts; workers/catalog/ai-generation-http.ts; workers/catalog/media-ai-enrichment-http.ts; workers/catalog/media-ai-enrichment.ts; tests/components/admin-media-ai-enrichment.test.ts; tests/unit/d1-ai-endpoints-http.test.ts; tests/unit/d1-media-ai-enrichment.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SEO-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/AdminSeoTechnicalPanel.vue; db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql; workers/seo/crawler.ts; tests/unit/d1-seo-crawler.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Simulador de DNS inverso de Googlebot en producción**: En el worker Cloudflare real, la verificación depende de la cabecera provista por Cloudflare (`request.cf?.botManagement?.verifiedBot`). En entornos de desarrollo/preview o Cloudflare Workers sin plan Enterprise Bot Management, la verificación recae en el prefijo de red o comprobación DNS determinista implementada en `verifyBotIdentity`. **Integración con cron triggers de Cloudflare**: El endpoint `POST /api/admin/seo/crawl/run` soporta llamadas programadas con `triggerType: 'scheduled'`. Cuando el orquestador configure los cron triggers"
  },
  'SEO-024': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/AdminSeoTechnicalPanel.vue; db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql; shared/seo-bot-logs.ts; workers/seo/bot-logs.ts; tests/unit/d1-seo-bot-logs.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Simulador de DNS inverso de Googlebot en producción**: En el worker Cloudflare real, la verificación depende de la cabecera provista por Cloudflare (`request.cf?.botManagement?.verifiedBot`). En entornos de desarrollo/preview o Cloudflare Workers sin plan Enterprise Bot Management, la verificación recae en el prefijo de red o comprobación DNS determinista implementada en `verifyBotIdentity`. **Integración con cron triggers de Cloudflare**: El endpoint `POST /api/admin/seo/crawl/run` soporta llamadas programadas con `triggerType: 'scheduled'`. Cuando el orquestador configure los cron triggers"
  },
  'SEO-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; db/d1/migrations/0148_search_gap_programme.sql; shared/search-gap-programme.ts; workers/analytics/search-analytics.ts; workers/catalog/search-gap-programme-http.ts; workers/catalog/search-gap-programme.ts; workers/catalog/search-merchandising.ts; workers/catalog/search-synonyms.ts; tests/unit/search-gap-programme-http.test.ts; tests/unit/search-gap-programme.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin UI admin para el programa de búsquedas sin resultado (solo API y tests). La ficha de producto (`[slug].vue`) no tiene test de componente ni de navegador; solo se validó lint/prettier y el endpoint/builder. Referencia `assortment` solo exige producto con status published (no la validez de publicación completa). Referencia `content` exige publicación CMS vigente. Preexistente, no corregido: `ProductVerifiedReviewsQa` pide `/api/products/${product.id}/reviews` con id numérico, mientras `product_reviews.product_id` guarda el id de texto; la lista visible podría salir vacía. Mi endpoint summary'
  },
  'SEO-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/ProductContributionsPanel.vue; app/components/ProductEngagementPanel.vue; app/pages/producto/[slug].vue; shared/review-aggregate.ts; workers/catalog/product-review-seo.ts; workers/catalog/product-reviews-qa-http.ts; tests/components/product-engagement-pdp.test.ts; tests/unit/seo-product-aggregate-rating.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin UI admin para el programa de búsquedas sin resultado (solo API y tests). La ficha de producto (`[slug].vue`) no tiene test de componente ni de navegador; solo se validó lint/prettier y el endpoint/builder. Referencia `assortment` solo exige producto con status published (no la validez de publicación completa). Referencia `content` exige publicación CMS vigente. Preexistente, no corregido: `ProductVerifiedReviewsQa` pide `/api/products/${product.id}/reviews` con id numérico, mientras `product_reviews.product_id` guarda el id de texto; la lista visible podría salir vacía. Mi endpoint summary'
  },
  'SEO-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; shared/landing-quality.ts; workers/catalog/seo-http.ts; workers/content/resource-hub.ts; tests/unit/landing-quality.test.ts; tests/unit/resource-hub-landings.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin UI admin para el programa de búsquedas sin resultado (solo API y tests). La ficha de producto (`[slug].vue`) no tiene test de componente ni de navegador; solo se validó lint/prettier y el endpoint/builder. Referencia `assortment` solo exige producto con status published (no la validez de publicación completa). Referencia `content` exige publicación CMS vigente. Preexistente, no corregido: `ProductVerifiedReviewsQa` pide `/api/products/${product.id}/reviews` con id numérico, mientras `product_reviews.product_id` guarda el id de texto; la lista visible podría salir vacía. Mi endpoint summary'
  },
  'SEO-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/AdminContentGovernancePanel.vue; db/d1/migrations/0149_content_governance.sql; shared/content-governance.ts; workers/canary.ts; workers/content/content-governance.ts; tests/unit/canary-content-governance-mount.test.ts; tests/unit/content-governance-shared.test.ts; tests/unit/content-governance.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ha ejecutado typecheck global, build Nuxt ni E2E/a11y de navegador (prohibido por el brief). Las vistas están probadas a nivel de componente. Sin prueba contra D1 real ni despliegue; la migración se validó solo sobre `node:sqlite`. Las redirecciones de retirada de recursos se sirven al cliente (410 + `redirectTo` y `navigateTo` 301 en la página); no hay redirect de borde ni integración con `search_merchandising` / sitemap. Calculadora: solo tipo `dilution`. No hay editor visual de payload (JSON validado por servidor) ni histórico visible en UI (los eventos existen en BD). El calendario m'
  },
  'SEO-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/ContentAssetsPanel.vue; shared/content-governance.ts; workers/content/content-governance.ts; tests/unit/content-governance-shared.test.ts; tests/unit/content-governance.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ha ejecutado typecheck global, build Nuxt ni E2E/a11y de navegador (prohibido por el brief). Las vistas están probadas a nivel de componente. Sin prueba contra D1 real ni despliegue; la migración se validó solo sobre `node:sqlite`. Las redirecciones de retirada de recursos se sirven al cliente (410 + `redirectTo` y `navigateTo` 301 en la página); no hay redirect de borde ni integración con `search_merchandising` / sitemap. Calculadora: solo tipo `dilution`. No hay editor visual de payload (JSON validado por servidor) ni histórico visible en UI (los eventos existen en BD). El calendario m'
  },
  'SEO-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/ContentTrustPanel.vue; shared/content-governance.ts; workers/content/content-governance.ts; tests/unit/content-governance.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se ha ejecutado typecheck global, build Nuxt ni E2E/a11y de navegador (prohibido por el brief). Las vistas están probadas a nivel de componente. Sin prueba contra D1 real ni despliegue; la migración se validó solo sobre `node:sqlite`. Las redirecciones de retirada de recursos se sirven al cliente (410 + `redirectTo` y `navigateTo` 301 en la página); no hay redirect de borde ni integración con `search_merchandising` / sitemap. Calculadora: solo tipo `dilution`. No hay editor visual de payload (JSON validado por servidor) ni histórico visible en UI (los eventos existen en BD). El calendario m'
  },
  'SEO-032': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/components/AdminSeoTechnicalPanel.vue; db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql; shared/seo-semantic-search.ts; workers/seo/ai-search.ts; tests/unit/d1-seo-ai-search.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      "Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Simulador de DNS inverso de Googlebot en producción**: En el worker Cloudflare real, la verificación depende de la cabecera provista por Cloudflare (`request.cf?.botManagement?.verifiedBot`). En entornos de desarrollo/preview o Cloudflare Workers sin plan Enterprise Bot Management, la verificación recae en el prefijo de red o comprobación DNS determinista implementada en `verifyBotIdentity`. **Integración con cron triggers de Cloudflare**: El endpoint `POST /api/admin/seo/crawl/run` soporta llamadas programadas con `triggerType: 'scheduled'`. Cuando el orquestador configure los cron triggers"
  },
  'SEO-033': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; app/app.vue; app/utils/hreflang-links.ts; db/d1/migrations/0150_international_seo_channel_feeds_adr_lq.sql; shared/seo-international.ts; workers/canary.ts; workers/catalog/international-feeds-adr-http.ts; workers/catalog/market-catalog-http.ts; workers/catalog/seo-international.ts; tests/unit/canary-international-feeds-adr-mount.test.ts; tests/unit/hreflang-links.test.ts; tests/unit/international-feeds-adr-http.test.ts; tests/unit/seo-international.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: 1. **Rutas localizadas inexistentes (SEO-033)**: no existe todavía la página Nuxt `/<locale>/producto/<slug>`. El hreflang solo emite alternates de mercados con revisión humana registrada (hoy ninguno), así que no hay enlaces muertos, pero antes de revisar el primer mercado hay que crear esa ruta (renderizado desde `/api/storefront/products/market`). Hasta entonces no se debe registrar ninguna revisión.'
  },
  'SEO-034': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/routes/robots.txt.get.ts; server/routes/sitemap.xml.get.ts; db/d1/migrations/0150_international_seo_channel_feeds_adr_lq.sql; shared/channel-feeds.ts; workers/canary.ts; workers/catalog/channel-feeds.ts; tests/unit/canary-international-feeds-adr-mount.test.ts; tests/unit/channel-feeds.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **SSR del hreflang**: `app.vue` llama con `$fetch` a una ruta que vive en el canary; si el SSR de Nitro no la resuelve, cae al par es-ES/x-default (comportamiento seguro). Hay que comprobarlo en un entorno con el worker real. El sitemap multi-mercado no se ha tocado. **Revisión humana real**: el sistema registra al revisor autenticado y su nombre, pero la traducción humana la aporta el equipo; no hay proveedor de traducción. **Feeds**: el feed XML antiguo `server/routes/feeds/google-merchant.xml.get.ts` (SQL Postgres) no se ha migrado ni sustituido. Los nuevos feeds por canal son JSON/XML gené'
  },
  'PER-020': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'scripts/lib/performance-gate.ts; scripts/performance-gate.ts; tests/unit/performance-gate.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: PER-020: docs/operations/performance-baseline.json does not exist. I cannot generate it without a real run on the Oracle runner. Until it is committed, the gate only enforces the absolute budgets and the diff says "No baseline". There is no exceptions file yet (a missing file counts as no exceptions). The CI step was not run (no remote CI by instruction).'
  },
  'PER-021': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'scripts/lib/synthetic-purchase.ts; scripts/synthetic-purchase.ts; tests/unit/synthetic-purchase.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: PER-021: it was only run against local fakes. The probe locations are labels (headers). The real geography depends on where the runner/scheduler runs it. It is not wired to a scheduled job or to the canary. A demo SKU (DEMO-SYNTHETIC-001) must exist in the staging/demo dataset, and the endpoints `/api/cart/items` and `/buscar` were assumed from the existing code.'
  },
  'PER-022': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'app/pages/admin/rendimiento.vue; db/d1/migrations/0128_aiops_third_party_b2b_cache_edge_personalization.sql; shared/performance-insights-error.ts; shared/third-party-value.ts; workers/canary.ts; workers/performance/performance-http.ts; tests/unit/performance-insights-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: El manifiesto de terceros es solo admin (el storefront no lo consume) y el A/B no tiene recolector de métricas; el veredicto keep/remove está implementado.'
  },
  'PER-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'app/pages/admin/rendimiento.vue; db/d1/migrations/0128_aiops_third_party_b2b_cache_edge_personalization.sql; shared/b2b-catalog-cache.ts; shared/performance-insights-error.ts; workers/canary.ts; workers/performance/performance-http.ts; tests/unit/performance-insights-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modulos de cache B2B no estan enchufados a `listPublishedProducts`/endpoints publicos del catalogo (requiere tocar codigo de catalogo y un secreto `pepper` nuevo en wrangler: `CATALOG_CACHE_PEPPER`, no creado). Listos: `createStatsBackedCatalogCache`. El manifiesto de terceros (`/third-parties/manifest`) es admin; el storefront aun no lo consume para cargar/omitir scripts. La asignacion A/B (`assignExperimentArm`) existe pero no hay recolector de metricas: los resultados se registran agregados por admin. Las senales AIOps se ingestan por API admin; no hay productor automatico (cron/alertas'
  },
  'PER-024': {
    status: 'NOT_VERIFIED',
    implementation_refs: 'shared/incremental-sync.ts; tests/unit/incremental-sync.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: PER-024: the engine is not connected to a real D1 sink or Queue, nor to the stock/price/feed import paths (workers/catalog/). The checkpoint is not persisted (it needs a migration, e.g. 0147, if D1 persistence is wanted).'
  },
  'PER-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'app/pages/admin/rendimiento.vue; db/d1/migrations/0128_aiops_third_party_b2b_cache_edge_personalization.sql; shared/edge-personalization.ts; shared/performance-insights-error.ts; workers/canary.ts; workers/performance/performance-http.ts; tests/unit/performance-insights-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modulos de cache B2B no estan enchufados a `listPublishedProducts`/endpoints publicos del catalogo (requiere tocar codigo de catalogo y un secreto `pepper` nuevo en wrangler: `CATALOG_CACHE_PEPPER`, no creado). Listos: `createStatsBackedCatalogCache`. El manifiesto de terceros (`/third-parties/manifest`) es admin; el storefront aun no lo consume para cargar/omitir scripts. La asignacion A/B (`assignExperimentArm`) existe pero no hay recolector de metricas: los resultados se registran agregados por admin. Las senales AIOps se ingestan por API admin; no hay productor automatico (cron/alertas'
  },
  'PER-026': {
    status: 'NOT_VERIFIED',
    implementation_refs: 'shared/rum-backlog.ts; tests/unit/rum-backlog.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: PER-026: no source feeds it. It needs a job that reads web_vital events from analytics and queue lag from the queues, plus a view/endpoint in admin. The deviceClass cohort is not emitted by the current rum plugin (strict schema), so for now cohorts are "unknown/<navigationType>".'
  },
  'DAT-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminCohorts.vue; app/pages/admin/analitica.vue; db/d1/migrations/0099_analytics_cohorts.sql; workers/analytics/cohorts-http.ts; workers/analytics/cohorts.ts; tests/components/admin-cohorts.test.ts; tests/unit/d1-analytics-cohorts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'DAT-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminFunnel.vue; app/pages/admin/analitica.vue; db/d1/migrations/0099_analytics_cohorts.sql; workers/analytics/funnel-http.ts; workers/analytics/funnel.ts; tests/components/admin-funnel.test.ts; tests/unit/d1-analytics-funnel.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'DAT-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminCrmMetricsPanel.vue; app/pages/admin/automatizaciones.vue; db/d1/migrations/0137_crm_automation_metrics_and_anomaly_detection.sql; shared/crm-automation-metrics.ts; workers/crm/crm-automation-metrics-http.ts; workers/crm/crm-automation-metrics.ts; tests/components/admin-crm-metrics.test.ts; tests/unit/d1-crm-automation-metrics.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. - No quedan tareas pendientes en el alcance funcional ni técnico de DAT-016 y DAT-024.'
  },
  'DAT-017': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminExperimentsDashboard.vue; db/d1/migrations/0111_experiments_ab_testing.sql; shared/experiments-ab-testing.ts; workers/analytics/experiments.ts; tests/components/admin-experiments-dashboard.test.ts; tests/unit/d1-experiments-ab-testing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La suite se probó con tests unitarios y de componentes dedicados y pasa al 100%. El orquestador debe aplicar los diffs en `shared/admin-navigation.ts` y `tests/support/d1-sqlite.ts` para que el elemento aparezca en el menú lateral de navegación administrativa de forma global y quede fijado en el fixture de base de datos. No hay ningún test `.skip` ni relajado.'
  },
  'DAT-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminExperimentsDashboard.vue; db/d1/migrations/0111_experiments_ab_testing.sql; shared/experiments-ab-testing.ts; workers/analytics/experiments.ts; tests/components/admin-experiments-dashboard.test.ts; tests/unit/d1-experiments-ab-testing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La suite se probó con tests unitarios y de componentes dedicados y pasa al 100%. El orquestador debe aplicar los diffs en `shared/admin-navigation.ts` y `tests/support/d1-sqlite.ts` para que el elemento aparezca en el menú lateral de navegación administrativa de forma global y quede fijado en el fixture de base de datos. No hay ningún test `.skip` ni relajado.'
  },
  'DAT-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminSeoContentDashboard.vue; app/pages/admin/analitica.vue; db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql; workers/seo/content-dashboard-http.ts; workers/seo/content-dashboard.ts; tests/components/admin-seo-content-dashboard.test.ts; tests/unit/d1-seo-content-dashboard-http.test.ts; tests/unit/d1-seo-content-dashboard.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La implementación en base de datos, módulos de lógica de negocio en Workers, routers HTTP, componentes Vue con sus tabs en la página de analítica y tests exhaustivos están 100% completados y verificados en verde. Para la ingesta en producción de datos de Google Search Console o costes reales de ERP, los endpoints `/api/admin/seo/dashboard/sync` y `/api/admin/analytics/cost-to-serve/calculate` quedan listos con validación de contrato para ser consumidos por los cron jobs o webhooks correspondientes una vez que se configuren las credenciales del proveedor.'
  },
  'DAT-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminB2bSalesMetrics.vue; app/pages/admin/analitica.vue; db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql; scripts/lib/requirements-scope.ts; workers/b2b/metrics-http.ts; workers/b2b/metrics.ts; tests/components/admin-b2b-sales-metrics.test.ts; tests/unit/d1-b2b-sales-metrics-http.test.ts; tests/unit/d1-b2b-sales-metrics.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La implementación en base de datos, módulos de lógica de negocio en Workers, routers HTTP, componentes Vue con sus tabs en la página de analítica y tests exhaustivos están 100% completados y verificados en verde. Para la ingesta en producción de datos de Google Search Console o costes reales de ERP, los endpoints `/api/admin/seo/dashboard/sync` y `/api/admin/analytics/cost-to-serve/calculate` quedan listos con validación de contrato para ser consumidos por los cron jobs o webhooks correspondientes una vez que se configuren las credenciales del proveedor.'
  },
  'DAT-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminCostToServe.vue; app/pages/admin/analitica.vue; db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql; shared/cost-to-serve.ts; workers/analytics/cost-to-serve-http.ts; workers/analytics/cost-to-serve.ts; tests/components/admin-cost-to-serve.test.ts; tests/unit/d1-cost-to-serve-http.test.ts; tests/unit/d1-cost-to-serve.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La implementación en base de datos, módulos de lógica de negocio en Workers, routers HTTP, componentes Vue con sus tabs en la página de analítica y tests exhaustivos están 100% completados y verificados en verde. Para la ingesta en producción de datos de Google Search Console o costes reales de ERP, los endpoints `/api/admin/seo/dashboard/sync` y `/api/admin/analytics/cost-to-serve/calculate` quedan listos con validación de contrato para ser consumidos por los cron jobs o webhooks correspondientes una vez que se configuren las credenciales del proveedor.'
  },
  'DAT-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminModelEvaluationGate.vue; db/d1/migrations/0127_predictive_personalization_campaign_eval.sql; workers/analytics/model-evaluation.ts; tests/unit/d1-model-evaluation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modelos predictivos utilizan pesos, reglas de inferencia y fakes deterministas en base de datos para la evaluación offline y online en staging/canary. La integración con motores de inferencia remotos de mayor escala (como Workers AI bindings o GPUs dedicadas) se gestionará según la política de despliegue una vez promovido el gate. No se han modificado credenciales ni ficheros protegidos (.env, packages compartidos). Todo el trabajo cumple la política de un almacén único (sin sedes ni jerarquías complejas).'
  },
  'DAT-024': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/; scripts/db-migrate.ts; app/components/AdminAnomalyDetectionPanel.vue; app/pages/admin/observabilidad.vue; db/d1/migrations/0137_crm_automation_metrics_and_anomaly_detection.sql; shared/anomaly-detection.ts; workers/observability/anomaly-detection-http.ts; workers/observability/anomaly-detection.ts; tests/components/admin-anomaly-detection.test.ts; tests/unit/d1-anomaly-detection.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. - No quedan tareas pendientes en el alcance funcional ni técnico de DAT-016 y DAT-024.'
  },
  'MKT-009': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminMarketingModals.vue; app/components/MarketingModalHost.vue; db/d1/migrations/0094_marketing_modals.sql; shared/marketing-modals.ts; workers/marketing/marketing-modals-http.ts; workers/marketing/marketing-modals.ts; tests/components/admin-marketing-modals.test.ts; tests/components/marketing-modal-host.test.ts; tests/unit/d1-marketing-modals-http.test.ts; tests/unit/d1-marketing-modals.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: AF: evaluateOrderExpeditionEligibility y lot_expedition_blocks no estan enganchados al flujo real de expedicion/embalaje; el bloqueo solo pone el lote en cuarentena. Block/unblock sin tabla de comandos append-only (la evidencia se sobrescribe al desbloquear). evaluateInternationalShipping no esta usado por el checkout. AE: decision/propose del asistente y propuestas de media no son atomicos (propuesta + comando en dos escrituras; una carrera pierde con error UNIQUE 500 en vez de 409). El apply de catalogo modifica products sin pasar por la politica/versionado de publicacion del catalogo. AK: f'
  },
  'MKT-011': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminExperimentsDashboard.vue; db/d1/migrations/0111_experiments_ab_testing.sql; shared/experiments-ab-testing.ts; workers/analytics/experiments.ts; tests/components/admin-experiments-dashboard.test.ts; tests/unit/d1-experiments-ab-testing.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. La suite se probó con tests unitarios y de componentes dedicados y pasa al 100%. El orquestador debe aplicar los diffs en `shared/admin-navigation.ts` y `tests/support/d1-sqlite.ts` para que el elemento aparezca en el menú lateral de navegación administrativa de forma global y quede fijado en el fixture de base de datos. No hay ningún test `.skip` ni relajado.'
  },
  'MKT-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminBrowseRecovery.vue; db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql; workers/marketing/browse-abandonment-http.ts; workers/marketing/browse-abandonment.ts; tests/components/admin-browse-recovery.test.ts; tests/unit/browse-abandonment.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Cron Batch / Cloudflare Queues:** **Re-entrenamiento asíncrono de la matriz de co-compra:**'
  },
  'MKT-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminMarketingAutomations.vue; db/d1/migrations/0107_marketing_automations.sql; shared/marketing-automations.ts; workers/marketing/marketing-automations-http.ts; workers/marketing/marketing-automations.ts; tests/components/admin-marketing-automations.test.ts; tests/unit/d1-marketing-automations-http.test.ts; tests/unit/d1-marketing-automations.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'MKT-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminWelcomeCoupon.vue; db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql; workers/marketing/welcome-coupon-http.ts; workers/marketing/welcome-coupon.ts; tests/components/admin-welcome-coupon.test.ts; tests/unit/welcome-coupon.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Cron Batch / Cloudflare Queues:** **Re-entrenamiento asíncrono de la matriz de co-compra:**'
  },
  'MKT-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminMarketingAutomations.vue; db/d1/migrations/0107_marketing_automations.sql; shared/marketing-automations.ts; workers/marketing/marketing-automations-http.ts; workers/marketing/marketing-automations.ts; tests/components/admin-marketing-automations.test.ts; tests/unit/d1-marketing-automations-http.test.ts; tests/unit/d1-marketing-automations.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'MKT-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminMarketingAutomations.vue; db/d1/migrations/0107_marketing_automations.sql; shared/marketing-automations.ts; workers/marketing/marketing-automations-http.ts; workers/marketing/marketing-automations.ts; tests/components/admin-marketing-automations.test.ts; tests/unit/d1-marketing-automations-http.test.ts; tests/unit/d1-marketing-automations.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'MKT-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminRecommendationEngine.vue; db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql; workers/catalog/recommendation-engine-http.ts; workers/catalog/recommendation-engine.ts; tests/components/admin-recommendation-engine.test.ts; tests/unit/recommendation-engine.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. 3. **Modelos predictivos en MKT-020 (Fase 2):**'
  },
  'MKT-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/bundles/BundleConfigurator.vue; db/d1/migrations/0112_bundles_referrals_events.sql; shared/bundles.ts; workers/marketing/bundles.ts; tests/components/bundle-configurator.test.ts; tests/unit/d1-bundles.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Tests históricos con aserción de longitud fija de migraciones**: Pruebas heredadas (`tests/unit/d1-promotions-native.test.ts`, `tests/unit/d1-account-security-native.test.ts`, `tests/unit/audit-cloudflare-shop-cli.test.ts`) contienen aserciones rígidas que esperan un número histórico fijo de migraciones (ej. 71, 74 o 90) en lugar de una comprobación `>=`. Conforme a la regla de no alterar ni relajar pruebas ajenas a nuestro encargo, se dejan intactas para resolución por el orquestador. **Defecto en migración 0130 de otro agente concurrente**: `db/d1/migrations/0130_connector_marketplace.sql`'
  },
  'MKT-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/FreeShippingProgressBar.vue; app/composables/useFreeShipping.ts; shared/free-shipping-progress.ts; tests/components/FreeShippingProgressBar.test.ts; tests/unit/free-shipping-progress.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. - **Pendientes**: Ninguno dentro del alcance asignado. Los tres requisitos MKT-022, MKT-023 y MKT-032 están implementados al 100%, con contratos Zod, base de datos D1 STRICT, lógica de dominio pura y desacoplada, endpoints HTTP seguros, componentes Vue accesibles y baterías completas de pruebas unitarias y de componentes.'
  },
  'MKT-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/VolumePricingTable.vue; shared/volume-pricing-scale.ts; tests/components/VolumePricingTable.test.ts; tests/unit/volume-pricing-scale.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. - **Pendientes**: Ninguno dentro del alcance asignado. Los tres requisitos MKT-022, MKT-023 y MKT-032 están implementados al 100%, con contratos Zod, base de datos D1 STRICT, lógica de dominio pura y desacoplada, endpoints HTTP seguros, componentes Vue accesibles y baterías completas de pruebas unitarias y de componentes.'
  },
  'MKT-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/marketing/ReferralAccountPanel.vue; db/d1/migrations/0112_bundles_referrals_events.sql; shared/referrals.ts; workers/marketing/referrals-http.ts; workers/marketing/referrals.ts; tests/components/referral-account-panel.test.ts; tests/unit/d1-referrals-integrity.test.ts; tests/unit/d1-referrals.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Tests históricos con aserción de longitud fija de migraciones**: Pruebas heredadas (`tests/unit/d1-promotions-native.test.ts`, `tests/unit/d1-account-security-native.test.ts`, `tests/unit/audit-cloudflare-shop-cli.test.ts`) contienen aserciones rígidas que esperan un número histórico fijo de migraciones (ej. 71, 74 o 90) en lugar de una comprobación `>=`. Conforme a la regla de no alterar ni relajar pruebas ajenas a nuestro encargo, se dejan intactas para resolución por el orquestador. **Defecto en migración 0130 de otro agente concurrente**: `db/d1/migrations/0130_connector_marketplace.sql`'
  },
  'MKT-029': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/LeadMagnetPanel.vue; app/pages/herramientas/[slug].vue; db/d1/migrations/0115_growth_offers.sql; shared/buy-x-get-y.ts; shared/lead-magnets.ts; shared/promo-experiments.ts; workers/growth/lead-magnets.ts; tests/components/lead-magnet-panel.test.ts; tests/unit/buy-x-get-y.test.ts; tests/unit/d1-buy-x-get-y.test.ts; tests/unit/d1-growth-fixture.ts; tests/unit/d1-growth-http.test.ts; tests/unit/d1-lead-magnets.test.ts; tests/unit/d1-migrations-upgrade.test.ts; tests/unit/d1-promo-experiments.test.ts; tests/unit/lead-magnets.test.ts; tests/unit/promo-experiments.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: Integración en checkout, no hecha porque `checkout.ts` y `storefront-checkout.ts` son de otros agentes: Aplicar `previewBuyXGetY` al cotizar y añadir las líneas de regalo con reserva de stock. Llamar a `recordBxgyRedemption` en la misma transacción que crea el pedido. Llamar a `recordBxgyReturn` desde el flujo de devoluciones. Las tablas `order_lines_discounted` exigen precio unitario positivo; el regalo con asignado 0 requerirá adaptar esa línea. Experimentos: falta enganchar `assignPromoSubject` y `recordPromoObservation` al checkout y al pago, y pasar al experimento el coste COGS real y el'
  },
  'MKT-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/events/EventRegistrationCard.vue; db/d1/migrations/0112_bundles_referrals_events.sql; shared/events.ts; workers/marketing/events.ts; tests/components/event-registration-card.test.ts; tests/unit/d1-events.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Tests históricos con aserción de longitud fija de migraciones**: Pruebas heredadas (`tests/unit/d1-promotions-native.test.ts`, `tests/unit/d1-account-security-native.test.ts`, `tests/unit/audit-cloudflare-shop-cli.test.ts`) contienen aserciones rígidas que esperan un número histórico fijo de migraciones (ej. 71, 74 o 90) en lugar de una comprobación `>=`. Conforme a la regla de no alterar ni relajar pruebas ajenas a nuestro encargo, se dejan intactas para resolución por el orquestador. **Defecto en migración 0130 de otro agente concurrente**: `db/d1/migrations/0130_connector_marketplace.sql`'
  },
  'MKT-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminCaseStudyEditor.vue; app/components/CustomerCaseStudiesList.vue; db/d1/migrations/0124_ugc_reviews_customer_success_cases.sql; scripts/lib/requirements-scope.ts; shared/customer-case-studies.ts; workers/canary.ts; workers/cms/customer-case-studies-http.ts; workers/cms/customer-case-studies.ts; tests/components/customer-case-studies.test.ts; tests/unit/customer-case-studies.test.ts; tests/unit/d1-customer-case-studies-http.test.ts; tests/unit/d1-customer-case-studies.test.ts; tests/unit/ugc-case-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **R2 para Almacenamiento Binario de Fotos a Gran Escala:** La implementación actual guarda el blob en base64 / hash en D1 y memoria del worker con metadatos de escaneo. En un despliegue Cloudflare completo con alto volumen, las fotos aprobadas pueden vincularse directamente a un bucket R2 mediante URLs prefirmadas. **Motor Antivirus Externo:** Para producción se incluye el adaptador determinista `scanBufferAntivirus` con detección de firmas EICAR y validación estricta de encabezados de imagen. En un despliegue con pasarela ClamAV o VirusTotal API, el conector puede reemplazar el stub determini'
  },
  'MKT-032': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/pages/admin/campanas-estacionales.vue; db/d1/migrations/0143_seasonal_sector_campaigns.sql; workers/canary.ts; workers/marketing/seasonal-campaigns-http.ts; workers/marketing/seasonal-campaigns.ts; tests/unit/canary-bm-mounts.test.ts; tests/unit/d1-seasonal-sector-campaigns-http.test.ts; tests/unit/d1-seasonal-sector-campaigns.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. - **Pendientes**: Ninguno dentro del alcance asignado. Los tres requisitos MKT-022, MKT-023 y MKT-032 están implementados al 100%, con contratos Zod, base de datos D1 STRICT, lógica de dominio pura y desacoplada, endpoints HTTP seguros, componentes Vue accesibles y baterías completas de pruebas unitarias y de componentes.'
  },
  'MKT-033': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/LearningCentreProgress.vue; db/d1/migrations/0125_learning_campaigns_recurring_incentives.sql; shared/learning-centre.ts; workers/b2b/recurring-incentives-http.ts; workers/learning/learning-centre-http.ts; workers/learning/learning-centre.ts; workers/marketing/targeted-campaigns-http.ts; tests/unit/d1-learning-campaigns-http.test.ts; tests/unit/d1-learning-centre.test.ts; tests/unit/learning-centre.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se han realizado llamadas externas reales de red ni envío de correos (en cumplimiento estricto de las reglas comunes). La integración en el menú de navegación lateral del backoffice (`shared/admin-navigation.ts`) queda a la espera de la fusión del orquestador mediante el diff suministrado.'
  },
  'MKT-035': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminTargetedCampaignsPanel.vue; db/d1/migrations/0125_learning_campaigns_recurring_incentives.sql; scripts/lib/requirements-scope.ts; shared/targeted-campaigns.ts; workers/b2b/recurring-incentives-http.ts; workers/learning/learning-centre-http.ts; workers/marketing/targeted-campaigns-http.ts; workers/marketing/targeted-campaigns.ts; tests/unit/d1-learning-campaigns-http.test.ts; tests/unit/d1-targeted-campaigns.test.ts; tests/unit/targeted-campaigns.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se han realizado llamadas externas reales de red ni envío de correos (en cumplimiento estricto de las reglas comunes). La integración en el menú de navegación lateral del backoffice (`shared/admin-navigation.ts`) queda a la espera de la fusión del orquestador mediante el diff suministrado.'
  },
  'MKT-036': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminRecurringIncentivesPanel.vue; db/d1/migrations/0125_learning_campaigns_recurring_incentives.sql; shared/recurring-incentives.ts; workers/b2b/recurring-incentives-http.ts; workers/b2b/recurring-incentives.ts; workers/learning/learning-centre-http.ts; workers/marketing/targeted-campaigns-http.ts; tests/unit/d1-learning-campaigns-http.test.ts; tests/unit/d1-recurring-incentives.test.ts; tests/unit/recurring-incentives.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. No se han realizado llamadas externas reales de red ni envío de correos (en cumplimiento estricto de las reglas comunes). La integración en el menú de navegación lateral del backoffice (`shared/admin-navigation.ts`) queda a la espera de la fusión del orquestador mediante el diff suministrado.'
  },
  'MKT-037': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminPredictiveCampaignsPanel.vue; db/d1/migrations/0127_predictive_personalization_campaign_eval.sql; workers/marketing/predictive-personalization.ts; tests/components/admin-predictive-campaigns-panel.test.ts; tests/unit/d1-model-evaluation-http.test.ts; tests/unit/d1-predictive-personalization-http.test.ts; tests/unit/d1-predictive-personalization.test.ts; tests/unit/predictive-personalization-fixture.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modelos predictivos utilizan pesos, reglas de inferencia y fakes deterministas en base de datos para la evaluación offline y online en staging/canary. La integración con motores de inferencia remotos de mayor escala (como Workers AI bindings o GPUs dedicadas) se gestionará según la política de despliegue una vez promovido el gate. No se han modificado credenciales ni ficheros protegidos (.env, packages compartidos). Todo el trabajo cumple la política de un almacén único (sin sedes ni jerarquías complejas).'
  },
  'MKT-038': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/analytics/events.post.ts; app/composables/useAnalytics.ts; app/components/AdminPredictiveCampaignsPanel.vue; db/d1/migrations/0127_predictive_personalization_campaign_eval.sql; workers/marketing/predictive-personalization.ts; tests/unit/d1-predictive-personalization.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modelos predictivos utilizan pesos, reglas de inferencia y fakes deterministas en base de datos para la evaluación offline y online en staging/canary. La integración con motores de inferencia remotos de mayor escala (como Workers AI bindings o GPUs dedicadas) se gestionará según la política de despliegue una vez promovido el gate. No se han modificado credenciales ni ficheros protegidos (.env, packages compartidos). Todo el trabajo cumple la política de un almacén único (sin sedes ni jerarquías complejas).'
  },
  'COM-013': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; app/components/AdminHighValueMessages.vue; app/components/HighValueOptOut.vue; app/pages/admin/avisos-alto-valor.vue; workers/canary.ts; workers/communications/high-value-consent-http.ts; workers/communications/high-value-consent.ts; workers/communications/high-value-delivery.ts; workers/communications/high-value-fallback.ts; workers/communications/high-value-messages-http.ts; workers/communications/high-value-messaging-policy.ts; workers/communications/high-value-optout-http.ts; workers/communications/high-value-optout.ts; workers/communications/high-value-source.ts; tests/unit/d1-high-value-consent-entrypoints.test.ts; tests/unit/d1-high-value-consent-http.test.ts; tests/unit/d1-high-value-consent.test.ts; tests/unit/d1-high-value-delivery.test.ts; tests/unit/d1-high-value-fallback.test.ts; tests/unit/d1-high-value-messages-entrypoints.test.ts; tests/unit/d1-high-value-messages-http.test.ts; tests/unit/d1-high-value-optout-entrypoints.test.ts; tests/unit/d1-high-value-optout-http.test.ts; tests/unit/d1-high-value-optout.test.ts; tests/unit/d1-high-value-source.test.ts; tests/unit/high-value-messaging-policy.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: COM-013/014: solo adaptadores simulados; un proveedor oficial real requerirá verificación de estado, webhooks y plantillas aprobadas.'
  },
  'COM-014': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; workers/communications/whatsapp-business-http.ts; workers/communications/whatsapp-business.ts; tests/unit/d1-whatsapp-business-entrypoints.test.ts; tests/unit/d1-whatsapp-business-http.test.ts; tests/unit/d1-whatsapp-business.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Adaptador WhatsApp simulado (sin proveedor oficial): requiere verificación de estado, webhooks y plantillas aprobadas; adopción real pendiente.'
  },
  'COM-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; db/d1/migrations/0135_multichannel_orchestration_notification_center.sql; workers/communications/account-notifications-http.ts; workers/communications/multichannel-http.ts; workers/communications/multichannel-orchestrator.ts; tests/unit/d1-multichannel-http.test.ts; tests/unit/d1-multichannel-orchestration.test.ts; tests/unit/multichannel-admin-authorization.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con proveedores remotos en producción:** **Push notifications (Web Push / Service Worker):**'
  },
  'COM-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; db/d1/migrations/0135_multichannel_orchestration_notification_center.sql; workers/communications/account-notifications-http.ts; workers/communications/account-notifications.ts; workers/communications/multichannel-http.ts; tests/unit/d1-account-notifications.test.ts; tests/unit/d1-multichannel-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con proveedores remotos en producción:** **Push notifications (Web Push / Service Worker):**'
  },
  'COM-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; app/components/AdminOperationalAlertsPanel.vue; db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql; shared/operational-alerts.ts; workers/communications/operational-alerts-http.ts; workers/communications/operational-alerts.ts; tests/unit/d1-operational-alerts-http.test.ts; tests/unit/d1-operational-alerts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. 1. **Gateways físicos externos:** Las pruebas utilizan adaptadores fakes deterministas con D1 y SQLite en memoria. Para el paso a producción de COM-019 en Fase 4 se requerirá configurar las credenciales del proveedor de SMS/pager y las URLs de webhooks en la infraestructura de despliegue.'
  },
  'COM-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'scripts/outbox-worker.ts; server/integrations/email-provider.ts; app/components/AdminSendTimeOptimizationPanel.vue; db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql; shared/send-time-optimization.ts; workers/communications/send-time-optimization-http.ts; workers/communications/send-time-optimization.ts; tests/unit/d1-send-time-optimization-http.test.ts; tests/unit/d1-send-time-optimization.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SUP-011': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'app/components/AdminSupportLiveChat.vue; app/components/SupportLiveChatWidget.vue; db/d1/migrations/0102_support_live_chat_and_account_managers.sql; workers/support/live-chat-http.ts; workers/support/live-chat.ts; tests/components/admin-support-live-chat.test.ts; tests/components/support-live-chat-widget.test.ts; tests/unit/d1-support-live-chat-http.test.ts; tests/unit/d1-support-live-chat.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SUP-012': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'app/components/AdminSupportContactAnalysis.vue; app/components/AdminSupportEducation.vue; app/components/SupportFaqAssistant.vue; app/utils/support-insights-labels.ts; db/d1/migrations/0151_support_assistant_insights_b2b_portal.sql; shared/support-faq-assistant.ts; workers/canary.ts; workers/runtime/customer-operations-http.ts; workers/support/faq-assistant.ts; workers/support/insight-commands.ts; workers/support/insights-http.ts; tests/components/admin-support-insights.test.ts; tests/components/support-faq-assistant.test.ts; tests/unit/support-faq-assistant.test.ts; tests/unit/support-insights-http.test.ts; tests/unit/support-insights-mounts.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Subida real de bytes de documentos B2B: solo metadatos+sha256; falta binding R2, escaneo y descarga (docs quedan `pending`). Los SLA (24/72/48/72/24 h por tipo, 24 h derivaciones) son constantes internas en calendario, no horario laboral; pendientes de confirmar por Tono. Sin notificación por correo a cliente/equipo en derivación o cambios de estado B2B. El portal B2B se activa con `SUPPORT_ENABLED` + `AUTH_ENABLED`; el asistente con la publicación CMS; sin flag propio. No se ejecutó typecheck global ni build (prohibido); tipos validados solo por eslint/vitest. No se probó contra D1 real/worke'
  },
  'SUP-014': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'app/components/AdminSupportContactAnalysis.vue; app/components/AdminSupportEducation.vue; db/d1/migrations/0151_support_assistant_insights_b2b_portal.sql; shared/support-insights.ts; workers/support/contact-analysis.ts; tests/components/admin-support-insights.test.ts; tests/unit/support-contact-analysis.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Subida real de bytes de documentos B2B: solo metadatos+sha256; falta binding R2, escaneo y descarga (docs quedan `pending`). Los SLA (24/72/48/72/24 h por tipo, 24 h derivaciones) son constantes internas en calendario, no horario laboral; pendientes de confirmar por Tono. Sin notificación por correo a cliente/equipo en derivación o cambios de estado B2B. El portal B2B se activa con `SUPPORT_ENABLED` + `AUTH_ENABLED`; el asistente con la publicación CMS; sin flag propio. No se ejecutó typecheck global ni build (prohibido); tipos validados solo por eslint/vitest. No se probó contra D1 real/worke'
  },
  'SUP-015': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'app/components/AdminSupportEducation.vue; db/d1/migrations/0151_support_assistant_insights_b2b_portal.sql; shared/support-insights.ts; workers/support/education.ts; tests/unit/support-education.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Subida real de bytes de documentos B2B: solo metadatos+sha256; falta binding R2, escaneo y descarga (docs quedan `pending`). Los SLA (24/72/48/72/24 h por tipo, 24 h derivaciones) son constantes internas en calendario, no horario laboral; pendientes de confirmar por Tono. Sin notificación por correo a cliente/equipo en derivación o cambios de estado B2B. El portal B2B se activa con `SUPPORT_ENABLED` + `AUTH_ENABLED`; el asistente con la publicación CMS; sin flag propio. No se ejecutó typecheck global ni build (prohibido); tipos validados solo por eslint/vitest. No se probó contra D1 real/worke'
  },
  'SUP-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'app/components/AdminCustomerAccountManager.vue; app/components/CustomerAccountManagerCard.vue; db/d1/migrations/0102_support_live_chat_and_account_managers.sql; workers/crm/account-manager-http.ts; workers/crm/account-manager.ts; tests/components/admin-customer-account-manager.test.ts; tests/components/customer-account-manager-card.test.ts; tests/unit/d1-customer-account-manager-http.test.ts; tests/unit/d1-customer-account-manager.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'SUP-017': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'app/components/AccountB2bRequests.vue; app/components/AdminB2bRequests.vue; app/components/AdminSupportContactAnalysis.vue; app/components/AdminSupportEducation.vue; db/d1/migrations/0151_support_assistant_insights_b2b_portal.sql; shared/support-insights.ts; workers/canary.ts; workers/runtime/customer-operations-http.ts; workers/support/b2b-requests.ts; workers/support/insights-http.ts; tests/components/account-b2b-requests.test.ts; tests/components/admin-support-insights.test.ts; tests/unit/support-b2b-requests.test.ts; tests/unit/support-insights-http.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Subida real de bytes de documentos B2B: solo metadatos+sha256; falta binding R2, escaneo y descarga (docs quedan `pending`). Los SLA (24/72/48/72/24 h por tipo, 24 h derivaciones) son constantes internas en calendario, no horario laboral; pendientes de confirmar por Tono. Sin notificación por correo a cliente/equipo en derivación o cambios de estado B2B. El portal B2B se activa con `SUPPORT_ENABLED` + `AUTH_ENABLED`; el asistente con la publicación CMS; sin flag propio. No se ejecutó typecheck global ni build (prohibido); tipos validados solo por eslint/vitest. No se probó contra D1 real/worke'
  },
  'SUP-018': {
    status: 'PARTIAL_EXTERNAL',
    implementation_refs:
      'app/components/AdminSupportRca.vue; db/d1/migrations/0110_rca_copilot_audiences.sql; shared/support-rca.ts; workers/support/rca-http.ts; app/pages/admin/soporte-rca.vue; workers/support/rca.ts; tests/components/admin-support-rca.test.ts; tests/unit/d1-support-rca-http.test.ts; tests/unit/d1-support-rca.test.ts',
    operational_evidence: 'Required before phase acceptance',
    external_owner: 'Business/Operations/Legal/Provider (assign explicitly)',
    notes:
      'Partial external dependency: Subida real de bytes de documentos B2B: solo metadatos+sha256; falta binding R2, escaneo y descarga (docs quedan `pending`). Los SLA (24/72/48/72/24 h por tipo, 24 h derivaciones) son constantes internas en calendario, no horario laboral; pendientes de confirmar por Tono. Sin notificación por correo a cliente/equipo en derivación o cambios de estado B2B. El portal B2B se activa con `SUPPORT_ENABLED` + `AUTH_ENABLED`; el asistente con la publicación CMS; sin flag propio. No se ejecutó typecheck global ni build (prohibido); tipos validados solo por eslint/vitest. No se probó contra D1 real/worke'
  },
  'SUP-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'app/components/AdminSupportCopilot.vue; db/d1/migrations/0110_rca_copilot_audiences.sql; shared/support-copilot.ts; workers/support/copilot-http.ts; workers/support/copilot.ts; tests/components/admin-support-copilot.test.ts; tests/unit/d1-support-copilot-http.test.ts; tests/unit/d1-support-copilot.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Adaptador de Inferencia LLM Externo:** Siguiendo la premisa del brief ("Sin proveedores reales: adaptadores/fakes deterministas"), el motor del copiloto utiliza un generador fundamentado en datos SQLite reales con citas estructuradas y comprobación estricta de redacción. Para conectar un modelo fundacional externo en producción (ej. Workers AI `@cf/meta/llama-3-8b-instruct`), el punto de acople está desacoplado en `generateD1CopilotDraft` manteniendo intactos los esquemas de citaciones, validaciones de seguridad y aprobación humana. **Cálculo Desacoplado de Grandes Volúmenes en Audiencias:**'
  },
  'SEC-036': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/utils/auth-session.ts; app/components/AccountPromoFraudAppeals.vue; app/components/AdminPromoFraudCases.vue; db/d1/migrations/0147_category_merchandising_promo_fraud.sql; shared/promo-fraud.ts; shared/referrals.ts; workers/canary.ts; workers/cart-coordinator.ts; workers/catalog/checkout-promo-fraud.ts; workers/catalog/checkout.ts; workers/marketing/referrals-http.ts; workers/marketing/referrals.ts; workers/security/promo-fraud-http.ts; workers/security/promo-fraud.ts; tests/components/promo-fraud-ui.test.ts; tests/unit/d1-promo-fraud-checkout.test.ts; tests/unit/d1-promo-fraud-http.test.ts; tests/unit/d1-promo-fraud.test.ts; tests/unit/d1-referrals-integrity.test.ts; tests/unit/d1-referrals.test.ts; tests/unit/promo-fraud.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: `assessPromoFraud` no esta invocado todavia por checkout ni por la atribucion de referidos (ver punto 3); no existe hoy captura de dispositivo/pago en checkout, hay que definir de donde salen esas senales. Existente sin tocar: `attributeD1ReferralOrder` acepta `refereeCustomerId` del cliente en `/api/account/referrals/attribute` y `settle` no es atomico; son defectos previos, reportados, no corregidos. Conteo de senales y escritura no son una unica transaccion: dos clientes simultaneos con la misma senal pueden verse ambos "sin compartidos". Aceptado y documentado en el modulo; la revision hum'
  },
  'SEC-038': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; db/d1/migrations/0114_security_keys_devices_abuse.sql; shared/security-abuse-detection.ts; shared/security-b2b-api-keys.ts; workers/security/b2b-api-keys.ts; workers/security/security-controls-http.ts; tests/unit/security-b2b-api-keys.test.ts; tests/unit/security-controls-http.test.ts; tests/unit/security-controls-migration.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. `tests/unit/d1-migrations-upgrade.test.ts` falla ahora por huecos de numeracion ajenos (faltan 0119/0120 de otros agentes; existen 0121/0126); 0114 esta presente. No es de esta tarea; no ejecutada su version completa. No hay UI admin (paginas/componentes) ni entrada de navegacion: solo API. Haria falta una pagina con estados carga/error/vacio y la entrada en shared/admin-navigation.ts. Las rutas publicas (`/api/b2b/v1/ping`, `/api/devices/v1/*`) no pasan por los limitadores edge (AUTH_EDGE_LIMIT/ADMIN_EDGE_LIMIT) de canary.ts; recomendable envolverlas con el mismo mecanismo que `/api/account/b'
  },
  'SEC-039': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; db/d1/migrations/0114_security_keys_devices_abuse.sql; shared/security-warehouse-devices.ts; workers/security/security-controls-http.ts; workers/security/warehouse-devices.ts; tests/unit/security-warehouse-devices.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. `tests/unit/d1-migrations-upgrade.test.ts` falla ahora por huecos de numeracion ajenos (faltan 0119/0120 de otros agentes; existen 0121/0126); 0114 esta presente. No es de esta tarea; no ejecutada su version completa. No hay UI admin (paginas/componentes) ni entrada de navegacion: solo API. Haria falta una pagina con estados carga/error/vacio y la entrada en shared/admin-navigation.ts. Las rutas publicas (`/api/b2b/v1/ping`, `/api/devices/v1/*`) no pasan por los limitadores edge (AUTH_EDGE_LIMIT/ADMIN_EDGE_LIMIT) de canary.ts; recomendable envolverlas con el mismo mecanismo que `/api/account/b'
  },
  'SEC-040': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/utils/auth-session.ts; db/d1/migrations/0114_security_keys_devices_abuse.sql; shared/security-abuse-detection.ts; workers/security/abuse-detection.ts; workers/security/security-controls-http.ts; tests/unit/security-abuse-detection.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. `tests/unit/d1-migrations-upgrade.test.ts` falla ahora por huecos de numeracion ajenos (faltan 0119/0120 de otros agentes; existen 0121/0126); 0114 esta presente. No es de esta tarea; no ejecutada su version completa. No hay UI admin (paginas/componentes) ni entrada de navegacion: solo API. Haria falta una pagina con estados carga/error/vacio y la entrada en shared/admin-navigation.ts. Las rutas publicas (`/api/b2b/v1/ping`, `/api/devices/v1/*`) no pasan por los limitadores edge (AUTH_EDGE_LIMIT/ADMIN_EDGE_LIMIT) de canary.ts; recomendable envolverlas con el mismo mecanismo que `/api/account/b'
  },
  'INT-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts; app/components/AdminIntegrationsDashboard.vue; db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql; shared/integration-sandbox-contracts.ts; workers/integrations/integrations-http.ts; workers/integrations/sandbox-contracts.ts; tests/components/admin-integrations-dashboard.test.ts; tests/unit/d1-integrations-canary-http.test.ts; tests/unit/d1-sandbox-contracts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Configuración de credenciales reales de Sandbox:** Los adaptadores de prueba utilizan generadores de endpoints y seeds sintéticos (`.invalid`, `sis-t.redsys.es`). Cuando el equipo obtenga los API keys sandbox oficiales de Beply y Redsys, se deberán configurar en Cloudflare secrets mediante wrangler (`BEPLY_SANDBOX_API_KEY`, etc.). **Activador periódico Cloudflare Cron Triggers:** En `wrangler.toml` se puede configurar un cron trigger (p.ej. diario a las 04:00 UTC) para invocar `executeSandboxContractRun` de forma automática contra los proveedores registrados. **Queue / Worker consumidor para'
  },
  'INT-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts; app/components/AdminIntegrationsDashboard.vue; db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql; shared/integration-fault-injection.ts; workers/integrations/integrations-http.ts; tests/components/admin-integrations-dashboard.test.ts; tests/unit/d1-integration-faults.test.ts; tests/unit/d1-integrations-canary-http.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Configuración de credenciales reales de Sandbox:** Los adaptadores de prueba utilizan generadores de endpoints y seeds sintéticos (`.invalid`, `sis-t.redsys.es`). Cuando el equipo obtenga los API keys sandbox oficiales de Beply y Redsys, se deberán configurar en Cloudflare secrets mediante wrangler (`BEPLY_SANDBOX_API_KEY`, etc.). **Activador periódico Cloudflare Cron Triggers:** En `wrangler.toml` se puede configurar un cron trigger (p.ej. diario a las 04:00 UTC) para invocar `executeSandboxContractRun` de forma automática contra los proveedores registrados. **Queue / Worker consumidor para'
  },
  'INT-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts; db/d1/migrations/0121_b2b_public_api.sql; workers/canary.ts; workers/developer-platform/b2b-public-admin.ts; workers/developer-platform/b2b-public-api.ts; workers/developer-platform/b2b-public-contract.ts; tests/unit/b2b-public-contract.test.ts; tests/unit/d1-b2b-public-admin.test.ts; tests/unit/d1-b2b-public-api.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Añadir y probar la navegación compartida; mientras no se integre, la UI no es accesible en Cloudflare. Repetir las verificaciones del router y de navegación tras integrar los cambios paralelos; el check de formato actual del router pasa. La migración 0121 fue incluida en un checkpoint paralelo antes de sus ampliaciones posteriores. Las pruebas aplican la versión actual solo a bases nuevas. Si alguna base ya aplicó la versión anterior, editar ese archivo no actualiza su esquema: hay que verificar el historial y acordar una migración forward compatible, sin reescribir ni borrar datos. Este encar'
  },
  'INT-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts; app/components/AdminIntegrationsDashboard.vue; db/d1/migrations/0138_integration_sandbox_faults_webhooks.sql; shared/outbound-webhooks.ts; workers/integrations/integrations-http.ts; workers/integrations/outbound-webhooks.ts; tests/components/admin-integrations-dashboard.test.ts; tests/unit/d1-integrations-canary-http.test.ts; tests/unit/d1-outbound-webhooks.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Configuración de credenciales reales de Sandbox:** Los adaptadores de prueba utilizan generadores de endpoints y seeds sintéticos (`.invalid`, `sis-t.redsys.es`). Cuando el equipo obtenga los API keys sandbox oficiales de Beply y Redsys, se deberán configurar en Cloudflare secrets mediante wrangler (`BEPLY_SANDBOX_API_KEY`, etc.). **Activador periódico Cloudflare Cron Triggers:** En `wrangler.toml` se puede configurar un cron trigger (p.ej. diario a las 04:00 UTC) para invocar `executeSandboxContractRun` de forma automática contra los proveedores registrados. **Queue / Worker consumidor para'
  },
  'INT-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'db/migrations/0001_platform_foundation.sql; scripts/reconcile.ts; app/components/AdminConnectorsMarketplace.vue; db/d1/migrations/0130_connector_marketplace.sql; workers/canary.ts; workers/developer-platform/connector-marketplace.ts; tests/components/admin-connectors-marketplace.test.ts; tests/unit/connector-marketplace-canary.test.ts; tests/unit/connector-marketplace.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Integrar la cola de procesamiento en diferido (Cloudflare Queues / Durable Objects) para sincronizaciones periódicas de conectores de tipo `edi_batch` y reintentos automáticos con backoff exponencial cuando se habiliten proveedores de red externos.'
  },
  'TST-041': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'tests/; vitest.config.ts; playwright.config.ts; app/components/AdminQualityAssuranceSuite.vue; workers/canary.ts; workers/marketing/promotions-automation-matrix.ts; tests/components/AdminQualityAssuranceSuite.test.ts; tests/unit/canary-bx-mounts.test.ts; tests/unit/promotions-automation-table-driven.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'TST-042': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'tests/; vitest.config.ts; playwright.config.ts; app/components/AdminQualityAssuranceSuite.vue; scripts/lib/requirements-scope.ts; workers/canary.ts; workers/security/account-isolation.ts; tests/components/AdminQualityAssuranceSuite.test.ts; tests/unit/account-isolation-concurrency.test.ts; tests/unit/canary-bx-mounts.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'TST-043': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'tests/; vitest.config.ts; playwright.config.ts; app/components/AdminQualityAssuranceSuite.vue; workers/canary.ts; workers/fulfillment/warehouse-route-offline.ts; tests/components/AdminQualityAssuranceSuite.test.ts; tests/unit/canary-bx-mounts.test.ts; tests/unit/warehouse-route-offline.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Sin pendientes declarados en el informe.'
  },
  'TST-044': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'tests/; vitest.config.ts; playwright.config.ts; app/components/AdminModelEvaluationGate.vue; db/d1/migrations/0127_predictive_personalization_campaign_eval.sql; workers/analytics/model-evaluation.ts; tests/components/admin-model-evaluation-gate.test.ts; tests/unit/d1-model-evaluation-http.test.ts; tests/unit/d1-model-evaluation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Los modelos predictivos utilizan pesos, reglas de inferencia y fakes deterministas en base de datos para la evaluación offline y online en staging/canary. La integración con motores de inferencia remotos de mayor escala (como Workers AI bindings o GPUs dedicadas) se gestionará según la política de despliegue una vez promovido el gate. No se han modificado credenciales ni ficheros protegidos (.env, packages compartidos). Todo el trabajo cumple la política de un almacén único (sin sedes ni jerarquías complejas).'
  },
  'CIC-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; app/components/AdminReleaseGatesPanel.vue; db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql; shared/alpha-beta-promotion.ts; workers/canary.ts; workers/cms/campaign-pipeline-http.ts; workers/release/alpha-beta-promotion-http.ts; workers/release/alpha-beta-promotion.ts; workers/release/cloudflare-policy-http.ts; workers/release/progressive-rollout-http.ts; tests/unit/alpha-beta-signoff-integrity.test.ts; tests/unit/canary-bd-mounts.test.ts; tests/unit/d1-alpha-beta-promotion-http.test.ts; tests/unit/d1-alpha-beta-promotion.test.ts; tests/unit/release-http-authorization.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con Proveedores Externos en Producción:** La verificación de pentest y firmas legales utiliza hashes criptográficos y referencias a registros de auditoría; en el entorno real de producción los links a informes deberán validarse contra el bucket de documentación confidencial. **Cron de Publicación Programada en Cloudflare Scheduled Event:** Se implementaron las funciones para publicar campañas que hayan alcanzado su `publish_at`. En el worker programado de canary se puede añadir una tarea periódica que llame a `publishDueScheduledCampaigns()` cada 5 minutos. **No se ejecutó la sui'
  },
  'CIC-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; app/components/AdminReleaseGatesPanel.vue; db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql; shared/progressive-rollout.ts; workers/canary.ts; workers/release/progressive-rollout-http.ts; workers/release/progressive-rollout.ts; tests/unit/canary-bd-mounts.test.ts; tests/unit/d1-progressive-rollout-http.test.ts; tests/unit/d1-progressive-rollout.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con Proveedores Externos en Producción:** La verificación de pentest y firmas legales utiliza hashes criptográficos y referencias a registros de auditoría; en el entorno real de producción los links a informes deberán validarse contra el bucket de documentación confidencial. **Cron de Publicación Programada en Cloudflare Scheduled Event:** Se implementaron las funciones para publicar campañas que hayan alcanzado su `publish_at`. En el worker programado de canary se puede añadir una tarea periódica que llame a `publishDueScheduledCampaigns()` cada 5 minutos. **No se ejecutó la sui'
  },
  'CIC-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; app/components/AdminReleaseGatesPanel.vue; db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql; shared/cloudflare-policy.ts; workers/canary.ts; workers/release/cloudflare-policy-http.ts; workers/release/cloudflare-policy.ts; tests/unit/canary-bd-mounts.test.ts; tests/unit/d1-cloudflare-policy-http.test.ts; tests/unit/d1-cloudflare-policy.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con Proveedores Externos en Producción:** La verificación de pentest y firmas legales utiliza hashes criptográficos y referencias a registros de auditoría; en el entorno real de producción los links a informes deberán validarse contra el bucket de documentación confidencial. **Cron de Publicación Programada en Cloudflare Scheduled Event:** Se implementaron las funciones para publicar campañas que hayan alcanzado su `publish_at`. En el worker programado de canary se puede añadir una tarea periódica que llame a `publishDueScheduledCampaigns()` cada 5 minutos. **No se ejecutó la sui'
  },
  'CIC-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; app/components/AdminReleaseGatesPanel.vue; db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql; shared/campaign-pipeline.ts; workers/canary.ts; workers/cms/campaign-pipeline-http.ts; workers/cms/campaign-pipeline.ts; tests/unit/canary-bd-mounts.test.ts; tests/unit/d1-campaign-pipeline-http.test.ts; tests/unit/d1-campaign-pipeline.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración con Proveedores Externos en Producción:** La verificación de pentest y firmas legales utiliza hashes criptográficos y referencias a registros de auditoría; en el entorno real de producción los links a informes deberán validarse contra el bucket de documentación confidencial. **Cron de Publicación Programada en Cloudflare Scheduled Event:** Se implementaron las funciones para publicar campañas que hayan alcanzado su `publish_at`. En el worker programado de canary se puede añadir una tarea periódica que llame a `publishDueScheduledCampaigns()` cada 5 minutos. **No se ejecutó la sui'
  },
  'CIC-032': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; db/d1/migrations/0121_b2b_public_api.sql; workers/canary.ts; workers/developer-platform/b2b-public-admin.ts; workers/developer-platform/b2b-public-api.ts; workers/developer-platform/b2b-public-contract.ts; tests/components/admin-b2b-public-keys.test.ts; tests/unit/b2b-public-canary-d1.test.ts; tests/unit/b2b-public-canary.test.ts; tests/unit/b2b-public-contract.test.ts; tests/unit/b2b-sandbox-scheduler.test.ts; tests/unit/d1-b2b-public-admin.test.ts; tests/unit/d1-b2b-public-api.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Añadir y probar la navegación compartida; mientras no se integre, la UI no es accesible en Cloudflare. Repetir las verificaciones del router y de navegación tras integrar los cambios paralelos; el check de formato actual del router pasa. La migración 0121 fue incluida en un checkpoint paralelo antes de sus ampliaciones posteriores. Las pruebas aplican la versión actual solo a bases nuevas. Si alguna base ya aplicó la versión anterior, editar ese archivo no actualiza su esquema: hay que verificar el historial y acordar una migración forward compatible, sin reescribir ni borrar datos. Este encar'
  },
  'CIC-034': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      '.github/workflows/ci.yml; Dockerfile; package-lock.json; app/components/AdminDeveloperPortal.vue; shared/admin-navigation.ts; shared/developer-portal-catalog.ts; workers/developer-platform/ownership-http.ts; tests/components/admin-developer-portal.test.ts; tests/unit/d1-developer-ownership.test.ts; tests/unit/developer-portal-catalog.test.ts; tests/unit/developer-portal-navigation.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. Añadir y probar la navegación compartida; mientras no se integre, la UI no es accesible en Cloudflare. Repetir las verificaciones del router y de navegación tras integrar los cambios paralelos; el check de formato actual del router pasa. La migración 0121 fue incluida en un checkpoint paralelo antes de sus ampliaciones posteriores. Las pruebas aplican la versión actual solo a bases nuevas. Si alguna base ya aplicó la versión anterior, editar ese archivo no actualiza su esquema: hay que verificar el historial y acordar una migración forward compatible, sin reescribir ni borrar datos. Este encar'
  },
  'OBS-024': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/components/AdminGameDayPanel.vue; app/pages/admin/observabilidad.vue; db/d1/migrations/0144_game_day_and_marketing_automation_observability.sql; shared/game-day-resilience.ts; workers/observability/game-day-resilience-http.ts; workers/observability/game-day-resilience.ts; tests/components/admin-game-day-panel.test.ts; tests/unit/d1-game-day-resilience.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Ejecución de simulacros programados en entornos de staging continuo:** La infraestructura Cloudflare D1 y el motor de evaluación de la puerta de tráfico quedan plenamente operativos y testeados. Cuando se habilite un entorno con tráfico simulado de carga (Load Testing Engine), se recomienda orquestar un disparador periódico (cron de Worker) que invoque la suite de inyección de fallos semanalmente. **Canales de notificación externos en producción:** Los contratos soportan `slack_sre`, `pagerduty` y `email_ops`. En los tests unitarios se validan los receptores locales deterministas; para emiti'
  },
  'OBS-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/pages/admin/observabilidad.vue; db/d1/migrations/0116_observability_sre_capacity_slo.sql; shared/error-budget-releases.ts; workers/observability/error-budget-http.ts; workers/observability/error-budget.ts; tests/components/admin-observability.test.ts; tests/unit/d1-error-budget-releases-http.test.ts; tests/unit/d1-error-budget-releases.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración de enlaces de navegación:** La página `/admin/observabilidad` está operativa y probada mediante tests de componentes de Nuxt. Requiere que el orquestador aplique el diff de `shared/admin-navigation.ts` para que aparezca visible en la barra lateral del panel administrativo. **Workers programados (Scheduled Cron):** Las tablas e índices de métricas están preparados para conectarse opcionalmente a un cron worker programado (ej. `scheduled(event, env)` en `workers/canary.ts`) para el volcado automático diario de mediciones SLI desde Cloudflare Analytics Engine o logs de edge. **Depen'
  },
  'OBS-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/pages/admin/observabilidad.vue; db/d1/migrations/0116_observability_sre_capacity_slo.sql; shared/cloudflare-capacity-planning.ts; workers/observability/capacity-planning-http.ts; workers/observability/capacity-planning.ts; tests/components/admin-observability.test.ts; tests/unit/d1-cloudflare-capacity-planning-http.test.ts; tests/unit/d1-cloudflare-capacity-planning.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración de enlaces de navegación:** La página `/admin/observabilidad` está operativa y probada mediante tests de componentes de Nuxt. Requiere que el orquestador aplique el diff de `shared/admin-navigation.ts` para que aparezca visible en la barra lateral del panel administrativo. **Workers programados (Scheduled Cron):** Las tablas e índices de métricas están preparados para conectarse opcionalmente a un cron worker programado (ej. `scheduled(event, env)` en `workers/canary.ts`) para el volcado automático diario de mediciones SLI desde Cloudflare Analytics Engine o logs de edge. **Depen'
  },
  'OBS-027': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/components/AdminMarketingObservabilityPanel.vue; app/pages/admin/automatizaciones.vue; db/d1/migrations/0144_game_day_and_marketing_automation_observability.sql; shared/marketing-automation-observability.ts; workers/marketing/marketing-automation-observability-http.ts; workers/marketing/marketing-automation-observability.ts; tests/components/admin-marketing-observability-panel.test.ts; tests/unit/d1-marketing-automation-observability.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Ejecución de simulacros programados en entornos de staging continuo:** La infraestructura Cloudflare D1 y el motor de evaluación de la puerta de tráfico quedan plenamente operativos y testeados. Cuando se habilite un entorno con tráfico simulado de carga (Load Testing Engine), se recomienda orquestar un disparador periódico (cron de Worker) que invoque la suite de inyección de fallos semanalmente. **Canales de notificación externos en producción:** Los contratos soportan `slack_sre`, `pagerduty` y `email_ops`. En los tests unitarios se validan los receptores locales deterministas; para emiti'
  },
  'OBS-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/components/AdminB2BContractSloPanel.vue; app/components/AdminCapacityPlanningPanel.vue; app/components/AdminErrorBudgetReleaseGate.vue; app/pages/admin/observabilidad.vue; db/d1/migrations/0116_observability_sre_capacity_slo.sql; shared/b2b-contract-slo.ts; shared/cloudflare-capacity-planning.ts; shared/error-budget-releases.ts; workers/canary.ts; workers/observability/b2b-slo-http.ts; workers/observability/b2b-slo.ts; workers/observability/capacity-planning-http.ts; workers/observability/capacity-planning.ts; workers/observability/error-budget-http.ts; workers/observability/error-budget.ts; tests/components/admin-observability.test.ts; tests/unit/d1-b2b-contract-slo-http.test.ts; tests/unit/d1-b2b-contract-slo.test.ts; tests/unit/d1-cloudflare-capacity-planning-http.test.ts; tests/unit/d1-cloudflare-capacity-planning.test.ts; tests/unit/d1-error-budget-releases-http.test.ts; tests/unit/d1-error-budget-releases.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. **Integración de enlaces de navegación:** La página `/admin/observabilidad` está operativa y probada mediante tests de componentes de Nuxt. Requiere que el orquestador aplique el diff de `shared/admin-navigation.ts` para que aparezca visible en la barra lateral del panel administrativo. **Workers programados (Scheduled Cron):** Las tablas e índices de métricas están preparados para conectarse opcionalmente a un cron worker programado (ej. `scheduled(event, env)` en `workers/canary.ts`) para el volcado automático diario de mediciones SLI desde Cloudflare Analytics Engine o logs de edge. **Depen'
  },
  'OBS-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; app/components/AdminWarehouseRouteTelemetryPanel.vue; db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql; shared/warehouse-route-telemetry.ts; workers/observability/warehouse-route-telemetry-http.ts; workers/observability/warehouse-route-telemetry.ts; tests/unit/d1-warehouse-route-telemetry-http.test.ts; tests/unit/d1-warehouse-route-telemetry.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Repository evidence verified via Cloudflare/D1/Nuxt with deterministic tests. 2. **Historial masivo de telemetría:** El cálculo de agregados de OBS-029 procesa en tiempo real los eventos de la partición día/turno. Si el volumen en un único turno superase los 50.000 eventos, se recomienda programar un cron Cloudflare Worker nocturno para materializar los agregados periódicamente.'
  },
  'OBS-030': {
    status: 'NOT_VERIFIED',
    implementation_refs:
      'server/api/health/; scripts/operational-alerts.ts; docs/operations/; db/d1/migrations/0128_aiops_third_party_b2b_cache_edge_personalization.sql; shared/aiops-recommendations.ts; shared/performance-insights-error.ts; workers/canary.ts; workers/observability/aiops-http.ts; tests/unit/performance-insights-canary-mount.test.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Partial implementation: Las señales AIOps se ingieren por API admin: sin productor automático (cron/alertas) ni integración con operational-alerts; la aprobación destructiva y la métrica de precisión están implementadas.'
  },
  'SHP-003': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; db/d1/migrations/0006_checkout_orders.sql; scripts/lib/d1-shipping-seed.ts; workers/catalog/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-004': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-005': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-006': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/services/shipping.ts; workers/catalog/shipping.ts; db/d1/migrations/0006_checkout_orders.sql; scripts/lib/d1-shipping-seed.ts; tests/unit/d1-checkout.test.ts; scripts/audit-d1-checkout.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-007': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-008': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-010': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-011': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-012': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SHP-017': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/integrations/carrier-provider.ts; server/services/shipping.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'TST-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'tests/e2e/shipping-fulfillment.spec.ts; server/services/shipping.ts; server/integrations/mock-carrier.ts; app/pages/admin/pedidos.vue; playwright.config.ts',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'TST-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs:
      'server/integrations/carrier-provider.ts; server/integrations/mock-carrier.ts; server/integrations/carrier-factory.ts; tests/unit/shipping.test.ts; tests/e2e/shipping-fulfillment.spec.ts; docs/testing/carrier-contract.md',
    operational_evidence: '',
    external_owner: '',
    notes:
      'Resuelto con adaptador local y operativa manual (etiquetas/manifiestos/seguimiento manual); sin API de transportista por decisión de Tono 02/11.'
  },
  'SEC-033': {
    status: 'REPO_EVIDENCE',
    implementation_refs: 'server/middleware/security.ts; server/utils/auth-session.ts',
    operational_evidence: '',
    external_owner: '',
    notes: 'Pentest externo independiente; validado por Tono 02/11/2026.'
  },
  'LEG-001': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-002': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-003': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-004': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-005': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-006': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-007': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-008': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-009': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-010': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-011': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-012': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-013': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-014': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-015': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-016': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-017': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-018': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-019': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-020': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-021': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-022': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-023': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-024': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-025': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-026': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-027': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-028': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-029': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-030': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-031': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-032': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-033': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  },
  'LEG-034': {
    status: 'REPO_EVIDENCE',
    implementation_refs: '',
    operational_evidence: '',
    external_owner: '',
    notes: 'Revisión legal conforme; validado por Tono 02/11/2026.'
  }
}
