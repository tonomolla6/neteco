ALTER TABLE media_uploads ADD COLUMN storage_checked_at TEXT
  CHECK (storage_checked_at IS NULL OR storage_checked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', storage_checked_at), ''));
ALTER TABLE media_uploads ADD COLUMN storage_check_result TEXT
  CHECK (storage_check_result IN ('missing', 'mismatch', 'recovered', 'unavailable'));

-- Old missing objects must not starve newer recoverable uploads in bounded sweeps.
CREATE INDEX media_uploads_reconciliation ON media_uploads(storage_checked_at, created_at, id)
  WHERE storage_status = 'staging';
