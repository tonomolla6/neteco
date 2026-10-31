-- SEO-025: programa de optimización de búsquedas sin resultado.
-- Un caso por término sin resultado (abierto/accionado) con línea base medida; el historial es append-only.
CREATE TABLE search_gap_cases (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
 term_normalized TEXT NOT NULL CHECK(length(term_normalized) BETWEEN 2 AND 160 AND term_normalized NOT GLOB '*@*'),
 status TEXT NOT NULL CHECK(status IN('open','actioned','dismissed')),
 action_type TEXT CHECK(action_type IS NULL OR action_type IN('synonym','content','assortment','redirect')),
 reference_id TEXT CHECK(reference_id IS NULL OR length(reference_id) BETWEEN 1 AND 160),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 3 AND 500),
 baseline_from TEXT NOT NULL CHECK(length(baseline_from)=10 AND baseline_from=strftime('%Y-%m-%d',baseline_from)),
 baseline_to TEXT NOT NULL CHECK(length(baseline_to)=10 AND baseline_to=strftime('%Y-%m-%d',baseline_to) AND baseline_to>=baseline_from),
 baseline_searches INTEGER NOT NULL CHECK(baseline_searches>=0),
 baseline_zero_results INTEGER NOT NULL CHECK(baseline_zero_results>=0 AND baseline_zero_results<=baseline_searches),
 actioned_at TEXT CHECK(actioned_at IS NULL OR actioned_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',actioned_at),'')),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
 CHECK((status='actioned' AND action_type IS NOT NULL AND reference_id IS NOT NULL AND actioned_at IS NOT NULL)
  OR (status='open' AND action_type IS NULL AND actioned_at IS NULL)
  OR (status='dismissed' AND note IS NOT NULL AND action_type IS NULL AND actioned_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX search_gap_cases_live_term ON search_gap_cases(environment,term_normalized) WHERE status IN('open','actioned');
CREATE INDEX search_gap_cases_status ON search_gap_cases(environment,status,updated_at);

CREATE TABLE search_gap_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 case_id TEXT NOT NULL REFERENCES search_gap_cases(id),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 action TEXT NOT NULL CHECK(action IN('open','record_action','dismiss')),
 version INTEGER NOT NULL CHECK(version>=1),
 response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(actor_id,idempotency_key), UNIQUE(case_id,version)
) STRICT;
CREATE TRIGGER search_gap_events_no_update BEFORE UPDATE ON search_gap_events
BEGIN SELECT RAISE(ABORT,'search_gap_events_immutable'); END;
CREATE TRIGGER search_gap_events_no_delete BEFORE DELETE ON search_gap_events
BEGIN SELECT RAISE(ABORT,'search_gap_events_immutable'); END;
