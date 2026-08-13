-- Explicit, idempotent editorial scheduling. Timestamps are instants; editors
-- enter Europe/Madrid local time and the browser/API persist the corresponding UTC instant.

ALTER TABLE content_pages
  ADD COLUMN scheduled_publish_at timestamptz,
  ADD COLUMN scheduled_publish_version_id uuid REFERENCES content_versions(id),
  ADD COLUMN scheduled_unpublish_at timestamptz,
  ADD CONSTRAINT content_publish_schedule_pair CHECK (
    (scheduled_publish_at IS NULL) = (scheduled_publish_version_id IS NULL)
  ),
  ADD CONSTRAINT content_publish_schedule_order CHECK (
    scheduled_publish_at IS NULL OR scheduled_unpublish_at IS NULL
      OR scheduled_unpublish_at > scheduled_publish_at
  );

CREATE INDEX content_pages_publication_due_idx
  ON content_pages (LEAST(scheduled_publish_at, scheduled_unpublish_at))
  WHERE scheduled_publish_at IS NOT NULL OR scheduled_unpublish_at IS NOT NULL;
