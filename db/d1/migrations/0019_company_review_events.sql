-- A fiscal edit is not an approval. Keep a redacted, append-only trail of
-- requests so staff can review changes before commercial terms are granted.
ALTER TABLE companies ADD COLUMN last_change_id TEXT;

CREATE TABLE company_review_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  actor_identity_id TEXT NOT NULL REFERENCES identities(id),
  event_type TEXT NOT NULL CHECK (event_type = 'submitted'),
  tax_id_suffix TEXT CHECK (tax_id_suffix IS NULL OR length(tax_id_suffix) BETWEEN 1 AND 4),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX company_review_events_company_time ON company_review_events(company_id, created_at);
CREATE TRIGGER company_review_events_no_update BEFORE UPDATE ON company_review_events
BEGIN SELECT RAISE(ABORT, 'company_review_events_immutable'); END;
CREATE TRIGGER company_review_events_no_delete BEFORE DELETE ON company_review_events
BEGIN SELECT RAISE(ABORT, 'company_review_events_immutable'); END;
