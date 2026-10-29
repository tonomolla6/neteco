-- Guest order credentials may be revoked without changing the immutable
-- contractual token hash. Access duration is derived from orders.created_at;
-- no mutable expiry can accidentally extend an old bearer token.
ALTER TABLE orders ADD COLUMN access_revoked_at TEXT
  CHECK (access_revoked_at IS NULL OR access_revoked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', access_revoked_at), ''));
