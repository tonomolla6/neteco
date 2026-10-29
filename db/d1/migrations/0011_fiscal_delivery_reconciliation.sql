ALTER TABLE fiscal_outbox_delivery ADD COLUMN published_at TEXT CHECK (
  published_at IS NULL OR published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', published_at), '')
);
-- For pre-migration deliveries the original due time is a conservative retry
-- baseline. Replay remains safe because receipt deduplication uses event_id.
UPDATE fiscal_outbox_delivery SET published_at = available_at WHERE status = 'published';
CREATE INDEX fiscal_outbox_published_idx ON fiscal_outbox_delivery(status, published_at);
