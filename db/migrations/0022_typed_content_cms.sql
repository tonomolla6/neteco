-- Typed, versioned content. Versions are immutable; publish and rollback only move
-- pointers or create a new version, so history and authorship remain auditable.

CREATE TABLE content_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 160),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  draft_version_id uuid,
  published_version_id uuid,
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES content_pages(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  blocks jsonb NOT NULL,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_summary text NOT NULL CHECK (length(change_summary) BETWEEN 3 AND 500),
  based_on_id uuid REFERENCES content_versions(id),
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, version)
);

ALTER TABLE content_pages
  ADD CONSTRAINT content_pages_draft_version_fk
    FOREIGN KEY (draft_version_id) REFERENCES content_versions(id),
  ADD CONSTRAINT content_pages_published_version_fk
    FOREIGN KEY (published_version_id) REFERENCES content_versions(id);

CREATE TABLE content_preview_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES content_pages(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  segment text NOT NULL DEFAULT 'default' CHECK (length(segment) BETWEEN 1 AND 80),
  device text NOT NULL DEFAULT 'responsive' CHECK (device IN ('responsive', 'desktop', 'mobile')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_pages_status_updated_idx ON content_pages (status, updated_at DESC);
CREATE INDEX content_versions_page_version_idx ON content_versions (page_id, version DESC);
CREATE INDEX content_preview_tokens_active_idx ON content_preview_tokens (page_id, expires_at)
  WHERE revoked_at IS NULL;

