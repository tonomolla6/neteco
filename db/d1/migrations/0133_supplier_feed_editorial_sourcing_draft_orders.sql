-- Migration 0133: Supplier Feed Comparison, Professional Editorial Content, Multi-Supplier Sourcing, and Draft Orders Approval
-- CAT-018 (P2): Comparación automática de feed de proveedor (Altas/cambios/bajas quedan en revisión; nunca se publican silenciosamente)
-- CAT-019 (P2): Contenido editorial propio por producto/categoría (Texto responde intención profesional y supera contenido de proveedor sin duplicarlo)
-- CAT-021 (P3): Multi-proveedor y coste/lead time por proveedor (Selección de fuente de suministro trazable y margen calculable)
-- CHK-022 (P2): Pedido como borrador sujeto a aprobación (No reserva/cobra de forma indefinida; timeline y expiración definidos)

-- ============================================================================
-- CAT-018: Supplier Feed Comparison & Review Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplier_feed_imports (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  supplier_id TEXT NOT NULL CHECK(length(trim(supplier_id)) BETWEEN 2 AND 64),
  feed_name TEXT NOT NULL CHECK(length(trim(feed_name)) BETWEEN 2 AND 160),
  feed_hash TEXT NOT NULL CHECK(length(feed_hash) = 64 AND feed_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('staged', 'analyzed', 'partially_reviewed', 'completed', 'rejected')),
  items_count INTEGER NOT NULL DEFAULT 0 CHECK(items_count >= 0),
  altas_count INTEGER NOT NULL DEFAULT 0 CHECK(altas_count >= 0),
  cambios_count INTEGER NOT NULL DEFAULT 0 CHECK(cambios_count >= 0),
  bajas_count INTEGER NOT NULL DEFAULT 0 CHECK(bajas_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_supplier_feed_imports_supplier ON supplier_feed_imports(supplier_id, status);

CREATE TABLE IF NOT EXISTS supplier_feed_review_items (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  import_id TEXT NOT NULL REFERENCES supplier_feed_imports(id),
  supplier_id TEXT NOT NULL CHECK(length(trim(supplier_id)) BETWEEN 2 AND 64),
  supplier_sku TEXT NOT NULL CHECK(length(trim(supplier_sku)) BETWEEN 1 AND 100),
  diff_type TEXT NOT NULL CHECK(diff_type IN ('alta', 'cambio', 'baja')),
  product_id TEXT,
  variant_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending_review', 'approved', 'rejected', 'applied')),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0, 1)),
  before_payload_json TEXT CHECK(before_payload_json IS NULL OR json_valid(before_payload_json)),
  after_payload_json TEXT CHECK(after_payload_json IS NULL OR json_valid(after_payload_json)),
  diff_details_json TEXT NOT NULL CHECK(json_valid(diff_details_json)),
  review_decision_by TEXT REFERENCES identities(id),
  review_decision_at TEXT CHECK(review_decision_at IS NULL OR review_decision_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', review_decision_at), '')),
  review_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_supplier_feed_review_items_status ON supplier_feed_review_items(import_id, status, diff_type);
CREATE INDEX IF NOT EXISTS idx_supplier_feed_review_items_sku ON supplier_feed_review_items(supplier_id, supplier_sku);

CREATE TABLE IF NOT EXISTS supplier_feed_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  import_id TEXT NOT NULL REFERENCES supplier_feed_imports(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('stage_feed', 'review_item', 'apply_approved', 'reject_import')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (import_id, result_version)
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_feed_audit (
  command_id TEXT PRIMARY KEY REFERENCES supplier_feed_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  import_id TEXT NOT NULL REFERENCES supplier_feed_imports(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- ============================================================================
-- CAT-019: Structured Professional Editorial Content (Product & Category)
-- ============================================================================

CREATE TABLE IF NOT EXISTS catalog_editorial_articles (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  target_type TEXT NOT NULL CHECK(target_type IN ('product', 'category')),
  target_id TEXT NOT NULL CHECK(length(trim(target_id)) BETWEEN 2 AND 64),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 200),
  summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 10 AND 500),
  body_markdown TEXT NOT NULL CHECK(length(trim(body_markdown)) BETWEEN 20 AND 20000),
  application_scope TEXT NOT NULL CHECK(length(trim(application_scope)) BETWEEN 3 AND 200),
  surface_compatibility_json TEXT NOT NULL CHECK(json_valid(surface_compatibility_json)),
  dilution_dosage_guide TEXT NOT NULL CHECK(length(trim(dilution_dosage_guide)) BETWEEN 5 AND 1000),
  safety_and_ppe_json TEXT NOT NULL CHECK(json_valid(safety_and_ppe_json)),
  technical_standards_json TEXT NOT NULL CHECK(json_valid(technical_standards_json)),
  supplier_reference_text TEXT CHECK(supplier_reference_text IS NULL OR length(supplier_reference_text) <= 20000),
  supplier_similarity_score REAL NOT NULL DEFAULT 0.0 CHECK(supplier_similarity_score >= 0.0 AND supplier_similarity_score <= 1.0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'in_review', 'approved', 'published', 'archived')),
  author_identity_id TEXT NOT NULL REFERENCES identities(id),
  reviewer_identity_id TEXT REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE (target_type, target_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_editorial_articles_target ON catalog_editorial_articles(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_editorial_articles_status ON catalog_editorial_articles(status);

CREATE TABLE IF NOT EXISTS catalog_editorial_article_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  article_id TEXT NOT NULL REFERENCES catalog_editorial_articles(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'submit_review', 'approve', 'approved', 'rejected', 'publish', 'published', 'archive', 'archived')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (article_id, result_version)
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_editorial_article_audit (
  command_id TEXT PRIMARY KEY REFERENCES catalog_editorial_article_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  article_id TEXT NOT NULL REFERENCES catalog_editorial_articles(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- ============================================================================
-- CAT-021: Multi-Supplier Registry, Offerings & Sourcing Traceability
-- ============================================================================

CREATE TABLE IF NOT EXISTS catalog_suppliers (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  code TEXT NOT NULL UNIQUE CHECK(length(trim(code)) BETWEEN 2 AND 50),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 160),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency IN ('EUR', 'USD', 'GBP')),
  lead_time_days_default INTEGER NOT NULL DEFAULT 3 CHECK(lead_time_days_default >= 0),
  reliability_score INTEGER NOT NULL DEFAULT 95 CHECK(reliability_score BETWEEN 0 AND 100),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK(payment_terms_days >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_product_offerings (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  supplier_id TEXT NOT NULL REFERENCES catalog_suppliers(id),
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  supplier_sku TEXT NOT NULL CHECK(length(trim(supplier_sku)) BETWEEN 1 AND 100),
  cost_cents INTEGER NOT NULL CHECK(cost_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency IN ('EUR', 'USD', 'GBP')),
  lead_time_days INTEGER NOT NULL CHECK(lead_time_days >= 0),
  min_order_quantity INTEGER NOT NULL DEFAULT 1 CHECK(min_order_quantity >= 1),
  is_preferred INTEGER NOT NULL DEFAULT 0 CHECK(is_preferred IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE (supplier_id, variant_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_supplier_offerings_variant ON supplier_product_offerings(variant_id, is_active, cost_cents);
CREATE INDEX IF NOT EXISTS idx_supplier_offerings_product ON supplier_product_offerings(product_id, is_active);

CREATE TABLE IF NOT EXISTS supplier_sourcing_decisions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  variant_id TEXT NOT NULL,
  selected_supplier_id TEXT NOT NULL REFERENCES catalog_suppliers(id),
  selected_offering_id TEXT NOT NULL REFERENCES supplier_product_offerings(id),
  strategy TEXT NOT NULL CHECK(strategy IN ('lowest_cost', 'shortest_lead_time', 'best_margin', 'preferred', 'manual_override')),
  selection_reason TEXT NOT NULL CHECK(length(trim(selection_reason)) >= 3),
  retail_price_cents INTEGER NOT NULL CHECK(retail_price_cents >= 0),
  cost_cents INTEGER NOT NULL CHECK(cost_cents > 0),
  margin_cents INTEGER NOT NULL,
  margin_percent REAL NOT NULL,
  lead_time_days INTEGER NOT NULL CHECK(lead_time_days >= 0),
  candidate_options_json TEXT NOT NULL CHECK(json_valid(candidate_options_json)),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sourcing_decisions_variant ON supplier_sourcing_decisions(variant_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_sourcing_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  offering_id TEXT NOT NULL REFERENCES supplier_product_offerings(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('upsert_offering', 'select_sourcing', 'deactivate_offering')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (offering_id, result_version)
) STRICT;

CREATE TABLE IF NOT EXISTS supplier_sourcing_audit (
  command_id TEXT PRIMARY KEY REFERENCES supplier_sourcing_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  offering_id TEXT NOT NULL REFERENCES supplier_product_offerings(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- ============================================================================
-- CHK-022: Draft Orders Subject to Approval & Timeline
-- ============================================================================

CREATE TABLE IF NOT EXISTS draft_orders (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  draft_number TEXT NOT NULL UNIQUE CHECK(length(trim(draft_number)) BETWEEN 3 AND 50),
  customer_id TEXT NOT NULL,
  company_name TEXT NOT NULL CHECK(length(trim(company_name)) BETWEEN 2 AND 160),
  contact_email TEXT NOT NULL CHECK(length(trim(contact_email)) BETWEEN 5 AND 255),
  status TEXT NOT NULL CHECK(status IN ('draft', 'pending_approval', 'approved', 'rejected', 'expired', 'converted', 'cancelled')),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK(tax_cents >= 0),
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK(shipping_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency IN ('EUR', 'USD', 'GBP')),
  items_json TEXT NOT NULL CHECK(json_valid(items_json)),
  inventory_reserved INTEGER NOT NULL DEFAULT 0 CHECK(inventory_reserved IN (0, 1)),
  payment_status TEXT NOT NULL DEFAULT 'unbilled' CHECK(payment_status IN ('unbilled', 'preauthorized', 'captured', 'voided')),
  expires_at TEXT NOT NULL CHECK(expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')),
  approval_requested_at TEXT CHECK(approval_requested_at IS NULL OR approval_requested_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', approval_requested_at), '')),
  approved_at TEXT CHECK(approved_at IS NULL OR approved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', approved_at), '')),
  approved_by TEXT REFERENCES identities(id),
  rejection_reason TEXT,
  converted_order_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_draft_orders_customer ON draft_orders(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_draft_orders_status_expires ON draft_orders(status, expires_at);

CREATE TABLE IF NOT EXISTS draft_order_timeline (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  draft_order_id TEXT NOT NULL REFERENCES draft_orders(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('created', 'submitted_for_approval', 'under_review', 'approved', 'rejected', 'expired', 'converted', 'cancelled', 'note_added')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('customer', 'approver', 'system')),
  actor_id TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_draft_order_timeline_order ON draft_order_timeline(draft_order_id, created_at);

CREATE TABLE IF NOT EXISTS draft_order_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  draft_order_id TEXT NOT NULL REFERENCES draft_orders(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_draft', 'submit_approval', 'review_draft', 'convert_order', 'expire_draft', 'cancel_draft')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (draft_order_id, result_version)
) STRICT;

CREATE TABLE IF NOT EXISTS draft_order_audit (
  command_id TEXT PRIMARY KEY REFERENCES draft_order_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  draft_order_id TEXT NOT NULL REFERENCES draft_orders(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
