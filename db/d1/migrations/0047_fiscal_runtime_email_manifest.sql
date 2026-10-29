-- Immutable preparation evidence, not a second copy of recipients/bodies/URLs.
-- Renderer v1 is retained and reconstructed from immutable fiscal facts. Any
-- version/source/content drift fails closed BEFORE the durable sending marker.
CREATE TABLE transactional_email_preparations (
  event_id TEXT PRIMARY KEY REFERENCES transactional_email_deliveries(event_id),
  renderer_version TEXT NOT NULL CHECK (length(renderer_version) BETWEEN 1 AND 100),
  source_hash TEXT NOT NULL CHECK (length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
  message_hash TEXT NOT NULL CHECK (length(message_hash)=64 AND message_hash NOT GLOB '*[^0-9a-f]*'),
  prepared_at TEXT NOT NULL CHECK (prepared_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',prepared_at),''))
) STRICT;
-- BEFORE INSERT also protects REPLACE without recursive_triggers being enabled.
CREATE TRIGGER transactional_email_preparation_replay_guard BEFORE INSERT ON transactional_email_preparations
WHEN EXISTS(SELECT 1 FROM transactional_email_preparations old WHERE old.event_id=NEW.event_id
  AND (old.renderer_version<>NEW.renderer_version OR old.source_hash<>NEW.source_hash
    OR old.message_hash<>NEW.message_hash OR old.prepared_at<>NEW.prepared_at))
BEGIN SELECT RAISE(ABORT,'email_preparation_immutable'); END;
CREATE TRIGGER transactional_email_preparation_no_update BEFORE UPDATE ON transactional_email_preparations
BEGIN SELECT RAISE(ABORT,'email_preparation_immutable'); END;
CREATE TRIGGER transactional_email_preparation_no_delete BEFORE DELETE ON transactional_email_preparations
BEGIN SELECT RAISE(ABORT,'email_preparation_immutable'); END;
CREATE TABLE transactional_email_preparation_guards (
  id INTEGER PRIMARY KEY CHECK(id=1), passed INTEGER NOT NULL CHECK(passed=1)
) STRICT;
