-- SEA-019 / SEA-020: Semantic search anchored to catalog, human evaluation benchmark,
-- controlled personalized reordering respecting explicit sort/filters, and incremental uplift measurement.

-- Catalog semantic embeddings & concept representations
CREATE TABLE catalog_semantic_embeddings (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  concept_tokens TEXT NOT NULL CHECK(json_valid(concept_tokens)),
  embedding_vector TEXT NOT NULL CHECK(json_valid(embedding_vector)),
  indexed_at TEXT NOT NULL CHECK(indexed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',indexed_at),'')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
) STRICT;

CREATE INDEX idx_catalog_semantic_indexed ON catalog_semantic_embeddings(indexed_at);

-- SEA-019: Human relevance evaluations (append-only revisions, CAS by version, command idempotency)
CREATE TABLE search_human_evaluation_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  evaluation_id TEXT NOT NULL CHECK(length(evaluation_id)=36),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  version INTEGER NOT NULL CHECK(version=expected_version+1),
  query_normalized TEXT NOT NULL CHECK(length(query_normalized) BETWEEN 1 AND 160),
  product_id TEXT NOT NULL REFERENCES products(id),
  relevance_score INTEGER NOT NULL CHECK(relevance_score BETWEEN 0 AND 4),
  notes TEXT CHECK(notes IS NULL OR length(notes)<=500),
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  response TEXT NOT NULL CHECK(json_valid(response)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id, idempotency_key),
  UNIQUE(evaluation_id, version)
) STRICT;

CREATE INDEX idx_human_eval_query ON search_human_evaluation_commands(query_normalized, evaluation_id, version);
CREATE INDEX idx_human_eval_product ON search_human_evaluation_commands(product_id);

CREATE VIEW search_human_evaluations_current AS
SELECT c.* FROM search_human_evaluation_commands c
WHERE c.version = (
  SELECT max(latest.version)
  FROM search_human_evaluation_commands latest
  WHERE latest.evaluation_id = c.evaluation_id
);

CREATE TRIGGER search_human_evaluation_authority BEFORE INSERT ON search_human_evaluation_commands
WHEN NOT EXISTS(
  SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
  WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
    AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
    AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
    AND EXISTS(
      SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
      WHERE r.identity_id=i.id AND p.permission_code IN ('catalog.write', 'administration.manage') AND r.granted_at<=NEW.created_at
        AND (r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))
    )
)
BEGIN SELECT RAISE(ABORT,'evaluation_authority_changed'); END;

CREATE TRIGGER search_human_evaluation_guard BEFORE INSERT ON search_human_evaluation_commands
WHEN json_extract(NEW.snapshot,'$.id') IS NOT NEW.evaluation_id
  OR json_extract(NEW.snapshot,'$.version') IS NOT NEW.version
  OR json_extract(NEW.snapshot,'$.status') IS NOT NEW.status
  OR json_extract(NEW.snapshot,'$.queryNormalized') IS NOT NEW.query_normalized
  OR json_extract(NEW.snapshot,'$.productId') IS NOT NEW.product_id
  OR json_extract(NEW.snapshot,'$.relevanceScore') IS NOT NEW.relevance_score
  OR json_extract(NEW.snapshot,'$.evaluatorId') IS NOT NEW.actor_id
  OR json_extract(NEW.response,'$.item') IS NOT NEW.snapshot
  OR json_extract(NEW.response,'$.commandId') IS NOT NEW.id
BEGIN SELECT RAISE(ABORT,'evaluation_snapshot_mismatch'); END;

CREATE TRIGGER search_human_evaluation_cas BEFORE INSERT ON search_human_evaluation_commands
WHEN NEW.expected_version IS NOT COALESCE((SELECT max(version) FROM search_human_evaluation_commands WHERE evaluation_id=NEW.evaluation_id),0)
  OR EXISTS(SELECT 1 FROM search_human_evaluations_current WHERE evaluation_id=NEW.evaluation_id AND status='retired')
BEGIN SELECT RAISE(ABORT,'evaluation_version_conflict'); END;

CREATE TRIGGER search_human_evaluation_product BEFORE INSERT ON search_human_evaluation_commands
WHEN NEW.status='active'
  AND NOT EXISTS(SELECT 1 FROM products WHERE id=NEW.product_id AND status='published')
BEGIN SELECT RAISE(ABORT,'evaluation_product_unavailable'); END;

CREATE TRIGGER search_human_evaluation_no_update BEFORE UPDATE ON search_human_evaluation_commands
BEGIN SELECT RAISE(ABORT,'evaluation_immutable'); END;

CREATE TRIGGER search_human_evaluation_no_delete BEFORE DELETE ON search_human_evaluation_commands
BEGIN SELECT RAISE(ABORT,'evaluation_immutable'); END;

-- SEA-020: Controlled personalized re-ranking experiments & uplift tracking
CREATE TABLE search_rerank_experiments (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 64),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 120),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 3 AND 500),
  status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed')),
  control_ratio REAL NOT NULL CHECK(control_ratio >= 0.0 AND control_ratio <= 1.0),
  max_boost_weight REAL NOT NULL CHECK(max_boost_weight >= 0.0 AND max_boost_weight <= 5.0),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;

INSERT INTO search_rerank_experiments (id, name, description, status, control_ratio, max_boost_weight, created_at, updated_at)
VALUES (
  'rerank_affinity_v1',
  'Reordenación por afinidad de segmento y categoría química',
  'Experimento controlado A/B de personalización manteniendo filtros y orden explícito',
  'active',
  0.5,
  2.0,
  '2026-10-01T00:00:00Z',
  '2026-10-01T00:00:00Z'
);

CREATE TABLE search_rerank_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),
  experiment_id TEXT NOT NULL REFERENCES search_rerank_experiments(id),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  variant TEXT NOT NULL CHECK(variant IN ('control', 'personalized')),
  user_segment TEXT NOT NULL CHECK(user_segment IN ('anonymous', 'customer', 'professional')),
  query_normalized TEXT NOT NULL CHECK(length(query_normalized) <= 160),
  has_explicit_sort INTEGER NOT NULL CHECK(has_explicit_sort IN (0, 1)),
  has_explicit_filters INTEGER NOT NULL CHECK(has_explicit_filters IN (0, 1)),
  products_shown TEXT NOT NULL CHECK(json_valid(products_shown)),
  occurred_at TEXT NOT NULL CHECK(occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at),'')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX idx_rerank_exp_variant ON search_rerank_events(experiment_id, variant, occurred_at);
CREATE INDEX idx_rerank_session ON search_rerank_events(session_hash, occurred_at);

CREATE TRIGGER search_rerank_events_no_update BEFORE UPDATE ON search_rerank_events
BEGIN SELECT RAISE(ABORT,'rerank_event_immutable'); END;

CREATE TRIGGER search_rerank_events_no_delete BEFORE DELETE ON search_rerank_events
BEGIN SELECT RAISE(ABORT,'rerank_event_immutable'); END;

CREATE TRIGGER search_rerank_events_no_replace BEFORE INSERT ON search_rerank_events
WHEN EXISTS(SELECT 1 FROM search_rerank_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'rerank_event_conflict'); END;

-- Separate immutable table for interaction events (clicks, add_to_cart, purchases)
CREATE TABLE search_rerank_interactions (
  interaction_id TEXT PRIMARY KEY CHECK(length(interaction_id)=36),
  event_id TEXT NOT NULL REFERENCES search_rerank_events(event_id),
  clicked_product_id TEXT REFERENCES products(id),
  clicked_rank INTEGER CHECK(clicked_rank IS NULL OR clicked_rank >= 1),
  converted INTEGER NOT NULL DEFAULT 0 CHECK(converted IN (0, 1)),
  conversion_cents INTEGER CHECK(conversion_cents IS NULL OR conversion_cents >= 0),
  occurred_at TEXT NOT NULL CHECK(occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at),'')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX idx_rerank_interactions_event ON search_rerank_interactions(event_id);

CREATE TRIGGER search_rerank_interactions_no_update BEFORE UPDATE ON search_rerank_interactions
BEGIN SELECT RAISE(ABORT,'rerank_interaction_immutable'); END;

CREATE TRIGGER search_rerank_interactions_no_delete BEFORE DELETE ON search_rerank_interactions
BEGIN SELECT RAISE(ABORT,'rerank_interaction_immutable'); END;
