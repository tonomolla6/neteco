-- Migration 0132: Editorial SEO Briefings, Commercial Pipeline & Accounts, and Warehouse Scanning Operations
-- ADM-029: Calendario editorial y briefing SEO (Tema, intención, autor experto, fuentes, assets, revisión, publicación/actualización, KPI)
-- ADM-030: Panel comercial de presupuestos y cuentas (Pipeline, actividad, próxima acción, margen, permisos; no sustituye ERP/CRM sin decisión)
-- ADM-031: Panel de almacén orientado a escaneo (Colas recepción/picking/packing, modo excepción, impresoras, métricas operativas)

-- ============================================================================
-- ADM-029: SEO Editorial Briefings & Calendar
-- ============================================================================

CREATE TABLE IF NOT EXISTS editorial_seo_briefings (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  page_id TEXT REFERENCES content_pages(id),
  topic TEXT NOT NULL CHECK(length(trim(topic)) BETWEEN 3 AND 200),
  search_intent TEXT NOT NULL CHECK(search_intent IN ('informational', 'commercial', 'transactional', 'navigational')),
  target_keyword TEXT NOT NULL CHECK(length(trim(target_keyword)) BETWEEN 2 AND 120),
  secondary_keywords_json TEXT NOT NULL CHECK(json_valid(secondary_keywords_json)),
  expert_author_json TEXT NOT NULL CHECK(json_valid(expert_author_json)),
  sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  assets_json TEXT NOT NULL CHECK(json_valid(assets_json)),
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'in_review', 'approved', 'rejected')),
  review_notes TEXT,
  reviewer_identity_id TEXT REFERENCES identities(id),
  target_publish_date TEXT NOT NULL CHECK(target_publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  actual_published_at TEXT CHECK(actual_published_at IS NULL OR actual_published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', actual_published_at), '')),
  update_cadence_months INTEGER CHECK(update_cadence_months IS NULL OR update_cadence_months BETWEEN 1 AND 36),
  last_reviewed_at TEXT CHECK(last_reviewed_at IS NULL OR last_reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_reviewed_at), '')),
  kpi_targets_json TEXT NOT NULL CHECK(json_valid(kpi_targets_json)),
  status TEXT NOT NULL CHECK(status IN ('planned', 'drafting', 'in_review', 'scheduled', 'published', 'needs_update', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_editorial_briefings_status ON editorial_seo_briefings(status, target_publish_date);
CREATE INDEX IF NOT EXISTS idx_editorial_briefings_intent ON editorial_seo_briefings(search_intent);

CREATE TABLE IF NOT EXISTS editorial_seo_briefing_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  briefing_id TEXT NOT NULL REFERENCES editorial_seo_briefings(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'review', 'schedule', 'publish', 'archive')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (briefing_id, result_version)
) STRICT;

CREATE TABLE IF NOT EXISTS editorial_seo_briefing_audit (
  command_id TEXT PRIMARY KEY REFERENCES editorial_seo_briefing_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  briefing_id TEXT NOT NULL REFERENCES editorial_seo_briefings(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS editorial_seo_briefings_version_cas BEFORE UPDATE ON editorial_seo_briefings
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'editorial_briefing_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS editorial_seo_briefing_cmd_no_update BEFORE UPDATE ON editorial_seo_briefing_commands
BEGIN SELECT RAISE(ABORT, 'editorial_seo_briefing_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS editorial_seo_briefing_cmd_no_delete BEFORE DELETE ON editorial_seo_briefing_commands
BEGIN SELECT RAISE(ABORT, 'editorial_seo_briefing_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS editorial_seo_briefing_audit_no_update BEFORE UPDATE ON editorial_seo_briefing_audit
BEGIN SELECT RAISE(ABORT, 'editorial_seo_briefing_audit_immutable'); END;

CREATE TRIGGER IF NOT EXISTS editorial_seo_briefing_audit_no_delete BEFORE DELETE ON editorial_seo_briefing_audit
BEGIN SELECT RAISE(ABORT, 'editorial_seo_briefing_audit_immutable'); END;

-- ============================================================================
-- ADM-030: Commercial Pipeline, Next Actions, & Margins
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_quotes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  current_version INTEGER NOT NULL CHECK(current_version>=1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS commercial_next_actions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  quote_id TEXT REFERENCES sales_quotes(id),
  action_description TEXT NOT NULL CHECK(length(trim(action_description)) BETWEEN 5 AND 500),
  due_date TEXT NOT NULL CHECK(due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  priority TEXT NOT NULL CHECK(priority IN ('urgent', 'high', 'normal', 'low')),
  assigned_identity_id TEXT NOT NULL REFERENCES identities(id),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', completed_at), '')),
  completed_by TEXT REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_commercial_actions_customer ON commercial_next_actions(customer_id, completed, due_date);
CREATE INDEX IF NOT EXISTS idx_commercial_actions_assigned ON commercial_next_actions(assigned_identity_id, completed);

CREATE TABLE IF NOT EXISTS commercial_quote_margins (
  quote_id TEXT PRIMARY KEY REFERENCES sales_quotes(id),
  quote_version INTEGER NOT NULL CHECK(quote_version >= 1),
  total_net_cents INTEGER NOT NULL CHECK(total_net_cents >= 0),
  total_cost_cents INTEGER NOT NULL CHECK(total_cost_cents >= 0),
  margin_cents INTEGER NOT NULL,
  margin_percentage_bps INTEGER NOT NULL,
  is_below_threshold INTEGER NOT NULL CHECK(is_below_threshold IN (0, 1)),
  approved_by TEXT REFERENCES identities(id),
  approved_at TEXT CHECK(approved_at IS NULL OR approved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', approved_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE IF NOT EXISTS commercial_pipeline_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_action', 'complete_action', 'calculate_margin', 'approve_margin')),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  result_version INTEGER NOT NULL CHECK(result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (customer_id, command_id)
) STRICT;

CREATE TABLE IF NOT EXISTS commercial_pipeline_audit (
  command_id TEXT PRIMARY KEY REFERENCES commercial_pipeline_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS commercial_next_actions_version_cas BEFORE UPDATE ON commercial_next_actions
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'commercial_action_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS commercial_pipeline_cmd_no_update BEFORE UPDATE ON commercial_pipeline_commands
BEGIN SELECT RAISE(ABORT, 'commercial_pipeline_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS commercial_pipeline_cmd_no_delete BEFORE DELETE ON commercial_pipeline_commands
BEGIN SELECT RAISE(ABORT, 'commercial_pipeline_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS commercial_pipeline_audit_no_update BEFORE UPDATE ON commercial_pipeline_audit
BEGIN SELECT RAISE(ABORT, 'commercial_pipeline_audit_immutable'); END;

CREATE TRIGGER IF NOT EXISTS commercial_pipeline_audit_no_delete BEFORE DELETE ON commercial_pipeline_audit
BEGIN SELECT RAISE(ABORT, 'commercial_pipeline_audit_immutable'); END;

-- ============================================================================
-- ADM-031: Warehouse Scan-Oriented Operations
-- ============================================================================

CREATE TABLE IF NOT EXISTS warehouse_receptions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  supplier_name TEXT NOT NULL CHECK(length(trim(supplier_name)) BETWEEN 2 AND 160),
  reference_code TEXT NOT NULL CHECK(length(trim(reference_code)) BETWEEN 2 AND 100),
  expected_items_json TEXT NOT NULL CHECK(json_valid(expected_items_json)),
  received_items_json TEXT NOT NULL CHECK(json_valid(received_items_json)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'exception')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_warehouse_receptions_status ON warehouse_receptions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS warehouse_exceptions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  target_type TEXT NOT NULL CHECK(target_type IN ('order', 'reception', 'item')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 64),
  exception_type TEXT NOT NULL CHECK(exception_type IN ('damaged_item', 'barcode_mismatch', 'shortage', 'spill_hazard', 'expired_lot', 'damaged_box')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK(status IN ('open', 'investigating', 'resolved', 'waived')),
  reported_by TEXT NOT NULL REFERENCES identities(id),
  resolved_by TEXT REFERENCES identities(id),
  resolution_notes TEXT,
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_warehouse_exceptions_status ON warehouse_exceptions(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_exceptions_target ON warehouse_exceptions(target_type, target_id);

CREATE TABLE IF NOT EXISTS warehouse_printers (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 2 AND 64),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 80),
  location TEXT NOT NULL CHECK(length(trim(location)) BETWEEN 2 AND 80),
  protocol TEXT NOT NULL CHECK(protocol IN ('zpl', 'ipp', 'raw_tcp', 'cups_pdf')),
  endpoint_address TEXT NOT NULL CHECK(length(trim(endpoint_address)) BETWEEN 3 AND 255),
  status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'error', 'paper_out')),
  supported_formats_json TEXT NOT NULL CHECK(json_valid(supported_formats_json)),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE IF NOT EXISTS warehouse_print_jobs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  printer_id TEXT NOT NULL REFERENCES warehouse_printers(id),
  label_type TEXT NOT NULL CHECK(label_type IN ('parcel_4x6', 'shelf_barcode', 'lot_tag')),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 64),
  copies INTEGER NOT NULL CHECK(copies BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('queued', 'printing', 'completed', 'failed')),
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_warehouse_print_jobs_printer ON warehouse_print_jobs(printer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS warehouse_scan_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('scan_reception', 'scan_pick', 'scan_pack', 'report_exception', 'resolve_exception', 'print_label')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TABLE IF NOT EXISTS warehouse_scan_audit (
  command_id TEXT PRIMARY KEY REFERENCES warehouse_scan_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS warehouse_receptions_version_cas BEFORE UPDATE ON warehouse_receptions
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'warehouse_reception_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS warehouse_scan_cmd_no_update BEFORE UPDATE ON warehouse_scan_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS warehouse_scan_cmd_no_delete BEFORE DELETE ON warehouse_scan_commands
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_command_immutable'); END;

CREATE TRIGGER IF NOT EXISTS warehouse_scan_audit_no_update BEFORE UPDATE ON warehouse_scan_audit
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_audit_immutable'); END;

CREATE TRIGGER IF NOT EXISTS warehouse_scan_audit_no_delete BEFORE DELETE ON warehouse_scan_audit
BEGIN SELECT RAISE(ABORT, 'warehouse_scan_audit_immutable'); END;
