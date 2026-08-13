-- Preserve public URLs when catalog slugs change.

CREATE TABLE canonical_redirects (
  source_path text PRIMARY KEY CHECK (source_path LIKE '/%'),
  destination_path text NOT NULL CHECK (destination_path LIKE '/%'),
  status_code integer NOT NULL DEFAULT 301 CHECK (status_code IN (301, 308)),
  resource_type text NOT NULL CHECK (resource_type IN ('product', 'category', 'content')),
  resource_id uuid,
  created_by uuid REFERENCES identities(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_path <> destination_path)
);

CREATE INDEX canonical_redirects_destination_idx ON canonical_redirects (destination_path);
