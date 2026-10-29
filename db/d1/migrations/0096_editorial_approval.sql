-- Migration 0097: Editorial Approval Workflow (ADM-023)
-- Author, editor, publisher separation of duties, checklist per content type,
-- append-only immutable comments, CAS concurrency, and audit trail.

CREATE TABLE editorial_checklist_templates (
  content_type TEXT PRIMARY KEY CHECK(content_type IN ('general', 'legal', 'chemical_safety', 'pricing')),
  is_critical INTEGER NOT NULL CHECK(is_critical IN (0, 1)),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
  items_json TEXT NOT NULL CHECK(json_valid(items_json) AND json_type(items_json) = 'array'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

INSERT INTO editorial_checklist_templates(content_type, is_critical, title, items_json, created_at) VALUES
  ('general', 0, 'Contenido general', '["ortografia_estilo", "enlaces_revisados"]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('legal', 1, 'Página legal y regulatoria', '["revision_legal", "conformidad_privacidad", "terminos_vigentes"]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('chemical_safety', 1, 'Ficha de seguridad química', '["fds_vigente", "pictogramas_clp", "frases_hp_revisadas"]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('pricing', 1, 'Precios y ofertas comerciales', '["exactitud_precios", "iva_claramente_indicado", "condiciones_comerciales"]', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

CREATE TABLE editorial_reviews (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  page_id TEXT NOT NULL REFERENCES content_pages(id),
  version_id TEXT NOT NULL REFERENCES content_versions(id),
  content_type TEXT NOT NULL REFERENCES editorial_checklist_templates(content_type),
  status TEXT NOT NULL CHECK(status IN ('draft', 'in_review', 'approved', 'published', 'rejected', 'withdrawn')),
  is_critical INTEGER NOT NULL CHECK(is_critical IN (0, 1)),
  author_id TEXT NOT NULL REFERENCES identities(id),
  assigned_reviewer_id TEXT REFERENCES identities(id),
  approved_by TEXT REFERENCES identities(id),
  approved_at TEXT CHECK(approved_at IS NULL OR approved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', approved_at), '')),
  published_by TEXT REFERENCES identities(id),
  published_at TEXT CHECK(published_at IS NULL OR published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', published_at), '')),
  rejection_reason TEXT CHECK(rejection_reason IS NULL OR (length(trim(rejection_reason)) BETWEEN 3 AND 500)),
  withdrawn_reason TEXT CHECK(withdrawn_reason IS NULL OR (length(trim(withdrawn_reason)) BETWEEN 3 AND 500)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK((status = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK((status = 'withdrawn') = (withdrawn_reason IS NOT NULL)),
  CHECK((status IN ('approved', 'published')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK((status = 'published') = (published_by IS NOT NULL AND published_at IS NOT NULL)),
  CHECK(is_critical = 0 OR approved_by IS NULL OR approved_by <> author_id),
  CHECK(is_critical = 0 OR published_by IS NULL OR published_by <> author_id)
) STRICT;

CREATE INDEX idx_editorial_reviews_assigned ON editorial_reviews(assigned_reviewer_id, status, updated_at DESC);
CREATE INDEX idx_editorial_reviews_page_version ON editorial_reviews(page_id, version_id);
CREATE INDEX idx_editorial_reviews_status ON editorial_reviews(status, updated_at DESC);

CREATE TRIGGER editorial_reviews_transition BEFORE UPDATE OF status ON editorial_reviews
WHEN OLD.status <> NEW.status AND (
     (OLD.status = 'draft' AND NEW.status NOT IN ('in_review', 'withdrawn'))
  OR (OLD.status = 'in_review' AND NEW.status NOT IN ('approved', 'rejected', 'withdrawn'))
  OR (OLD.status = 'rejected' AND NEW.status NOT IN ('in_review', 'withdrawn'))
  OR (OLD.status = 'approved' AND NEW.status NOT IN ('published', 'withdrawn'))
  OR (OLD.status = 'published' AND NEW.status NOT IN ('withdrawn'))
  OR (OLD.status = 'withdrawn' AND NEW.status NOT IN ('in_review'))
)
BEGIN SELECT RAISE(ABORT, 'editorial_invalid_transition'); END;

CREATE TRIGGER editorial_reviews_checklist_complete BEFORE UPDATE OF status ON editorial_reviews
WHEN NEW.status = 'approved' AND OLD.status <> 'approved' AND EXISTS(
  SELECT 1 FROM editorial_checklist_items WHERE review_id = NEW.id AND completed = 0
)
BEGIN SELECT RAISE(ABORT, 'editorial_checklist_incomplete'); END;

CREATE TRIGGER editorial_reviews_version_cas BEFORE UPDATE ON editorial_reviews
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'editorial_version_conflict'); END;

CREATE TRIGGER editorial_reviews_no_delete BEFORE DELETE ON editorial_reviews
BEGIN SELECT RAISE(ABORT, 'editorial_review_immutable'); END;

CREATE TABLE editorial_checklist_items (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  review_id TEXT NOT NULL REFERENCES editorial_reviews(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK(length(item_key) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  completed_by TEXT REFERENCES identities(id),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', completed_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(review_id, item_key),
  CHECK((completed = 1) = (completed_by IS NOT NULL AND completed_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_editorial_checklist_review ON editorial_checklist_items(review_id, completed);

CREATE TABLE editorial_review_comments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  review_id TEXT NOT NULL REFERENCES editorial_reviews(id),
  author_id TEXT NOT NULL REFERENCES identities(id),
  comment TEXT NOT NULL CHECK(length(trim(comment)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_editorial_comments_review ON editorial_review_comments(review_id, created_at ASC);

CREATE TRIGGER editorial_review_comments_no_update BEFORE UPDATE ON editorial_review_comments
BEGIN SELECT RAISE(ABORT, 'editorial_comment_immutable'); END;

CREATE TRIGGER editorial_review_comments_no_delete BEFORE DELETE ON editorial_review_comments
BEGIN SELECT RAISE(ABORT, 'editorial_comment_immutable'); END;

CREATE TABLE editorial_approval_commands (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  review_id TEXT NOT NULL REFERENCES editorial_reviews(id),
  action TEXT NOT NULL CHECK(action IN ('create_review', 'assign_reviewer', 'update_checklist', 'add_comment', 'approve', 'reject', 'withdraw')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json) = 'object' AND length(CAST(input_json AS BLOB)) <= 8192),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state) IN ('object', 'null')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state) = 'object'),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object' AND length(CAST(response_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER editorial_approval_commands_no_update BEFORE UPDATE ON editorial_approval_commands
BEGIN SELECT RAISE(ABORT, 'editorial_command_immutable'); END;

CREATE TRIGGER editorial_approval_commands_no_delete BEFORE DELETE ON editorial_approval_commands
BEGIN SELECT RAISE(ABORT, 'editorial_command_immutable'); END;

CREATE TABLE editorial_review_audit (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  review_id TEXT NOT NULL REFERENCES editorial_reviews(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(length(trim(action)) BETWEEN 1 AND 60),
  from_status TEXT CHECK(from_status IS NULL OR from_status IN ('draft', 'in_review', 'approved', 'published', 'rejected', 'withdrawn')),
  to_status TEXT CHECK(to_status IS NULL OR to_status IN ('draft', 'in_review', 'approved', 'published', 'rejected', 'withdrawn')),
  details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_editorial_audit_review ON editorial_review_audit(review_id, created_at DESC);

CREATE TRIGGER editorial_review_audit_no_update BEFORE UPDATE ON editorial_review_audit
BEGIN SELECT RAISE(ABORT, 'editorial_audit_immutable'); END;

CREATE TRIGGER editorial_review_audit_no_delete BEFORE DELETE ON editorial_review_audit
BEGIN SELECT RAISE(ABORT, 'editorial_audit_immutable'); END;
