-- Private originals only. Neither rights nor malware approval is granted here.
CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL UNIQUE CHECK (object_key = 'quarantine/' || id || '/' || checksum),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 150),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width INTEGER,
  height INTEGER,
  alt TEXT NOT NULL CHECK (length(trim(alt)) BETWEEN 1 AND 500),
  rights_owner TEXT NOT NULL CHECK (length(trim(rights_owner)) BETWEEN 1 AND 300),
  rights_license TEXT NOT NULL CHECK (length(trim(rights_license)) BETWEEN 1 AND 500),
  rights_source TEXT NOT NULL CHECK (length(trim(rights_source)) BETWEEN 1 AND 2000),
  rights_status TEXT NOT NULL DEFAULT 'pending' CHECK (rights_status = 'pending'),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status = 'pending'),
  storage_status TEXT NOT NULL DEFAULT 'staging' CHECK (storage_status IN ('staging', 'quarantined')),
  r2_etag TEXT,
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  stored_at TEXT CHECK (stored_at IS NULL OR (stored_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', stored_at), '') AND stored_at >= created_at)),
  UNIQUE (actor_id, idempotency_key),
  CHECK ((content_type = 'application/pdf' AND width IS NULL AND height IS NULL) OR
    (content_type != 'application/pdf' AND width IS NOT NULL AND height IS NOT NULL AND width BETWEEN 600 AND 12000 AND height BETWEEN 600 AND 12000)),
  CHECK ((storage_status = 'staging' AND r2_etag IS NULL AND stored_at IS NULL) OR
    (storage_status = 'quarantined' AND r2_etag IS NOT NULL AND length(r2_etag) > 0 AND stored_at IS NOT NULL))
) STRICT;

CREATE INDEX media_uploads_staging ON media_uploads(created_at, id) WHERE storage_status = 'staging';

CREATE TRIGGER media_uploads_identity_immutable
BEFORE UPDATE OF id, actor_id, idempotency_key, payload_hash, checksum, object_key,
  filename, content_type, byte_size, width, height, alt, rights_owner, rights_license, rights_source, created_at
ON media_uploads BEGIN
  SELECT RAISE(ABORT, 'media upload identity is immutable');
END;

CREATE TRIGGER media_uploads_receipt_immutable
BEFORE UPDATE ON media_uploads WHEN OLD.storage_status = 'quarantined' BEGIN
  SELECT RAISE(ABORT, 'media quarantine receipt is immutable');
END;
