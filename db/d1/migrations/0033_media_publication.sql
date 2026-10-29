-- Originals in media_uploads remain immutable and private. No scanner or human
-- decision is inferred from MIME/magic bytes, an upload, or a product filename.
CREATE TABLE media_scan_receipts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  upload_id TEXT NOT NULL REFERENCES media_uploads(id),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  verdict TEXT NOT NULL CHECK (verdict IN ('clean', 'infected')),
  scanner_version TEXT NOT NULL CHECK (length(trim(scanner_version)) BETWEEN 1 AND 100),
  scanned_at TEXT NOT NULL CHECK (scanned_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', scanned_at), '')),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > scanned_at),
  received_at TEXT NOT NULL CHECK (received_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', received_at), '') AND received_at >= scanned_at),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE INDEX media_scan_receipts_upload ON media_scan_receipts(upload_id, seq DESC);
CREATE TRIGGER media_scan_receipts_no_update BEFORE UPDATE ON media_scan_receipts
BEGIN SELECT RAISE(ABORT, 'media_scan_receipts_immutable'); END;
CREATE TRIGGER media_scan_receipts_no_delete BEFORE DELETE ON media_scan_receipts
BEGIN SELECT RAISE(ABORT, 'media_scan_receipts_immutable'); END;

CREATE TABLE media_rights_decisions (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  upload_id TEXT NOT NULL REFERENCES media_uploads(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  evidence_authorized_at TEXT,
  evidence_reference TEXT,
  rights_owner TEXT NOT NULL,
  rights_license TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(actor_id, idempotency_key),
  CHECK (decision = 'rejected' OR (
    length(trim(rights_owner)) BETWEEN 1 AND 300 AND length(trim(rights_license)) BETWEEN 1 AND 500
    AND evidence_authorized_at IS NOT NULL AND evidence_authorized_at = COALESCE(strftime('%Y-%m-%d', evidence_authorized_at), '')
    AND evidence_authorized_at <= substr(created_at, 1, 10)
    AND evidence_reference IS NOT NULL AND length(trim(evidence_reference)) BETWEEN 1 AND 1000
  ))
) STRICT;
CREATE INDEX media_rights_decisions_upload ON media_rights_decisions(upload_id, seq DESC);
CREATE TRIGGER media_rights_decisions_no_update BEFORE UPDATE ON media_rights_decisions
BEGIN SELECT RAISE(ABORT, 'media_rights_decisions_immutable'); END;
CREATE TRIGGER media_rights_decisions_no_delete BEFORE DELETE ON media_rights_decisions
BEGIN SELECT RAISE(ABORT, 'media_rights_decisions_immutable'); END;

CREATE TABLE product_media_publications (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT REFERENCES variants(id),
  upload_id TEXT NOT NULL REFERENCES media_uploads(id),
  role TEXT NOT NULL CHECK (role IN ('main', 'image', 'datasheet', 'sds', 'certificate', 'label')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  alt TEXT NOT NULL CHECK (length(trim(alt)) BETWEEN 1 AND 500),
  language TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 35),
  version TEXT NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 100),
  valid_from TEXT NOT NULL CHECK (valid_from = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_from), '')),
  valid_until TEXT CHECK (valid_until IS NULL OR (valid_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_until), '') AND valid_until > valid_from)),
  scan_receipt_id TEXT NOT NULL REFERENCES media_scan_receipts(id),
  rights_decision_id TEXT NOT NULL REFERENCES media_rights_decisions(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(actor_id, idempotency_key)
) STRICT;
CREATE INDEX product_media_publications_product ON product_media_publications(product_id, variant_id, role);
CREATE INDEX product_media_publications_upload ON product_media_publications(upload_id);
CREATE TRIGGER product_media_publications_same_product BEFORE INSERT ON product_media_publications
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM variants WHERE id = NEW.variant_id AND product_id = NEW.product_id
)
BEGIN SELECT RAISE(ABORT, 'media_variant_product_mismatch'); END;
CREATE TRIGGER product_media_publications_no_update BEFORE UPDATE ON product_media_publications
BEGIN SELECT RAISE(ABORT, 'product_media_publications_immutable'); END;
CREATE TRIGGER product_media_publications_no_delete BEFORE DELETE ON product_media_publications
BEGIN SELECT RAISE(ABORT, 'product_media_publications_immutable'); END;

-- Withdrawal never destroys the relation, its evidence, or historical URLs.
CREATE TABLE product_media_publication_events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  publication_id TEXT NOT NULL UNIQUE REFERENCES product_media_publications(id),
  event_type TEXT NOT NULL CHECK (event_type = 'withdrawn'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(actor_id, idempotency_key)
) STRICT;
CREATE TRIGGER product_media_publication_events_no_update BEFORE UPDATE ON product_media_publication_events
BEGIN SELECT RAISE(ABORT, 'product_media_publication_events_immutable'); END;
CREATE TRIGGER product_media_publication_events_no_delete BEFORE DELETE ON product_media_publication_events
BEGIN SELECT RAISE(ABORT, 'product_media_publication_events_immutable'); END;

-- A failed CAS/authentication guard violates this CHECK inside the same D1
-- batch, rolling back every preceding statement. Successful batches add no row.
CREATE TABLE media_governance_guards (
  id TEXT PRIMARY KEY,
  satisfied INTEGER NOT NULL CONSTRAINT media_governance_guard CHECK (satisfied = 1)
) STRICT;
