-- Existing rows may use canonical UTC seconds or milliseconds. SQLite text
-- ordering does not preserve chronology across those two spellings within one
-- second, so rebuild the table with normalized cross-precision window checks.
CREATE TABLE variant_price_versions_next (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
  compare_at_gross_cents INTEGER CHECK (
    compare_at_gross_cents IS NULL OR compare_at_gross_cents > gross_cents
  ),
  reference_gross_cents_30d INTEGER CHECK (
    reference_gross_cents_30d IS NULL OR reference_gross_cents_30d > 0
  ),
  volume_tiers TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(volume_tiers) AND json_type(volume_tiers) = 'array'),
  valid_from TEXT NOT NULL CHECK (
    (length(valid_from) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', valid_from) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%SZ', valid_from) = valid_from)
    OR
    (length(valid_from) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) = valid_from)
  ),
  valid_until TEXT CHECK (
    valid_until IS NULL OR
    (length(valid_until) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', valid_until) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%SZ', valid_until) = valid_until)
    OR
    (length(valid_until) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_until) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', valid_until) = valid_until)
  ),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'cancelled')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by TEXT,
  created_at TEXT NOT NULL CHECK (
    (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at)
    OR
    (length(created_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
  ),
  cancelled_by TEXT,
  cancelled_at TEXT CHECK (
    cancelled_at IS NULL OR
    (length(cancelled_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', cancelled_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%SZ', cancelled_at) = cancelled_at)
    OR
    (length(cancelled_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) = cancelled_at)
  ),
  cancellation_reason TEXT CHECK (
    cancellation_reason IS NULL OR length(cancellation_reason) BETWEEN 3 AND 500
  ),
  CHECK (
    valid_until IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', valid_until) > strftime('%Y-%m-%dT%H:%M:%fZ', valid_from)
  ),
  CHECK (
    cancelled_at IS NULL OR
    strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  CHECK (
    (status = 'approved' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)
  )
) STRICT;

INSERT INTO variant_price_versions_next (
  id, variant_id, gross_cents, compare_at_gross_cents, reference_gross_cents_30d,
  volume_tiers, valid_from, valid_until, status, reason, created_by, created_at,
  cancelled_by, cancelled_at, cancellation_reason
)
SELECT id, variant_id, gross_cents, compare_at_gross_cents, reference_gross_cents_30d,
       volume_tiers, valid_from, valid_until, status, reason, created_by, created_at,
       cancelled_by, cancelled_at, cancellation_reason
FROM variant_price_versions;

DROP TABLE variant_price_versions;
ALTER TABLE variant_price_versions_next RENAME TO variant_price_versions;

CREATE INDEX variant_price_versions_effective_idx
  ON variant_price_versions (
    variant_id, status,
    strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) DESC,
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) DESC,
    id DESC
  );
CREATE INDEX variant_price_versions_schedule_idx
  ON variant_price_versions (variant_id, valid_from);
CREATE INDEX variant_price_versions_upcoming_idx
  ON variant_price_versions (valid_from)
  WHERE status = 'approved' AND valid_until IS NULL;
