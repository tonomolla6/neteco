-- Accent/typo-tolerant catalog search with governed synonyms.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE search_synonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_term citext NOT NULL UNIQUE,
  replacements text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES identities(id),
  updated_by uuid REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(source_term::text)) BETWEEN 2 AND 80),
  CHECK (cardinality(replacements) BETWEEN 1 AND 20)
);

CREATE INDEX products_name_lower_trgm_idx ON products USING gin (lower(name) gin_trgm_ops);
CREATE INDEX brands_name_trgm_idx ON brands USING gin (lower(name) gin_trgm_ops);

COMMENT ON TABLE search_synonyms IS
  'Audited business vocabulary. Replacements expand queries but never change catalog facts or publish silently.';
