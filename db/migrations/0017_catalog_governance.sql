-- Publication governance, reproducible catalog releases and identifier exceptions.

ALTER TABLE variants
  ADD COLUMN identifier_exception_reason text,
  ADD CONSTRAINT variants_identifier_policy_check CHECK (
    ean IS NOT NULL OR gtin IS NOT NULL OR mpn IS NOT NULL
    OR identifier_exception_reason IS NULL OR length(trim(identifier_exception_reason)) >= 10
  );

CREATE TABLE catalog_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES catalog_sources(id),
  source_version text NOT NULL,
  checksum_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('uploaded', 'validated', 'rejected', 'approved', 'applied', 'rolled_back')),
  preview_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES identities(id),
  approved_by uuid REFERENCES identities(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_version, checksum_sha256)
);

CREATE TABLE catalog_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  checksum_sha256 text NOT NULL,
  import_batch_id uuid REFERENCES catalog_import_batches(id),
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'released', 'superseded', 'rolled_back')),
  product_count integer NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  variant_count integer NOT NULL DEFAULT 0 CHECK (variant_count >= 0),
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  released_by uuid REFERENCES identities(id),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE catalog_releases IS
  'Immutable evidence for a validated catalog dataset; production data must be promoted as a release, never seeded implicitly.';
