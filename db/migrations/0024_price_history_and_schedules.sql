CREATE TABLE variant_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  gross_cents integer NOT NULL CHECK (gross_cents > 0),
  compare_at_gross_cents integer CHECK (
    compare_at_gross_cents IS NULL OR compare_at_gross_cents > gross_cents
  ),
  reference_gross_cents_30d integer CHECK (reference_gross_cents_30d IS NULL OR reference_gross_cents_30d > 0),
  volume_tiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(volume_tiers) = 'array'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'cancelled')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_by uuid REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by uuid REFERENCES identities(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (
    (status = 'approved' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL)
  )
);

CREATE INDEX variant_price_versions_timeline_idx
  ON variant_price_versions (variant_id, valid_from DESC, created_at DESC);
CREATE INDEX variant_price_versions_upcoming_idx
  ON variant_price_versions (valid_from)
  WHERE status = 'approved' AND valid_until IS NULL;

INSERT INTO variant_price_versions (
  variant_id, gross_cents, compare_at_gross_cents, volume_tiers, valid_from, reason
)
SELECT id, price_gross_cents, compare_at_gross_cents, '[]'::jsonb, created_at,
       'Precio base importado al activar el histórico gobernado'
FROM variants;

CREATE VIEW effective_variant_prices AS
SELECT variant.id AS variant_id,
       COALESCE(selected.id::text, 'legacy:' || variant.id::text) AS pricing_version,
       COALESCE(selected.gross_cents, variant.price_gross_cents) AS gross_cents,
       COALESCE(selected.compare_at_gross_cents, variant.compare_at_gross_cents) AS compare_at_gross_cents,
       selected.reference_gross_cents_30d,
       COALESCE(selected.volume_tiers, '[]'::jsonb) AS volume_tiers,
       COALESCE(selected.valid_from, variant.created_at) AS valid_from,
       selected.valid_until
FROM variants variant
LEFT JOIN LATERAL (
  SELECT price.id, price.gross_cents, price.compare_at_gross_cents,
         price.reference_gross_cents_30d, price.volume_tiers, price.valid_from, price.valid_until
  FROM variant_price_versions price
  WHERE price.variant_id = variant.id AND price.status = 'approved'
    AND price.valid_from <= now()
    AND (price.valid_until IS NULL OR price.valid_until > now())
  ORDER BY price.valid_from DESC, price.created_at DESC
  LIMIT 1
) selected ON true;
