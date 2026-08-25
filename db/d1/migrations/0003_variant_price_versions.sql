-- Governed price history for variants (D1/SQLite port of PostgreSQL migration 0024).
-- All timestamps are canonical ISO-8601 UTC strings (seconds or milliseconds) so that
-- lexicographic comparison matches chronological comparison.
CREATE TABLE variant_price_versions (
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
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
  CHECK (
    (status = 'approved' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)
  )
) STRICT;

-- Effective-price lookup: filter by variant + status, order by recency with a fully
-- deterministic tiebreak (valid_from DESC, created_at DESC, id DESC).
CREATE INDEX variant_price_versions_effective_idx
  ON variant_price_versions (variant_id, status, valid_from DESC, created_at DESC, id DESC);
-- Schedule queries: upcoming or historical windows per variant regardless of status.
CREATE INDEX variant_price_versions_schedule_idx
  ON variant_price_versions (variant_id, valid_from);
-- Upcoming approved open-ended versions (cancellation candidates), mirroring the
-- partial index of the PostgreSQL model.
CREATE INDEX variant_price_versions_upcoming_idx
  ON variant_price_versions (valid_from)
  WHERE status = 'approved' AND valid_until IS NULL;
