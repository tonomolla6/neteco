-- SEO-029/030/031: gobierno de contenido (propietario, calendario de revisión, retirada/redirect),
-- autores y revisores técnicos (datos introducidos por administración, nunca inventados),
-- fuentes y afirmaciones con evidencia, y activos enlazables con metodología. Historial append-only.
CREATE TABLE content_authors (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 3 AND 120),
 bio TEXT NOT NULL CHECK(length(trim(bio)) BETWEEN 20 AND 1000),
 experience TEXT NOT NULL CHECK(length(trim(experience)) BETWEEN 20 AND 1000),
 credentials TEXT CHECK(credentials IS NULL OR length(trim(credentials)) BETWEEN 3 AND 500),
 status TEXT NOT NULL CHECK(status IN('active','archived')),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at)
) STRICT;

CREATE TABLE content_governance (
 slug TEXT PRIMARY KEY CHECK(length(slug) BETWEEN 1 AND 160 AND slug NOT GLOB '*[^a-z0-9-]*'),
 owner_name TEXT NOT NULL CHECK(length(trim(owner_name)) BETWEEN 2 AND 120),
 sensitivity TEXT NOT NULL CHECK(sensitivity IN('regulation','product','general')),
 next_review_at TEXT NOT NULL CHECK(length(next_review_at)=10 AND next_review_at=strftime('%Y-%m-%d',next_review_at)),
 author_id TEXT REFERENCES content_authors(id),
 reviewer_id TEXT REFERENCES content_authors(id),
 sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources)='array' AND json_array_length(sources)<=20),
 claims TEXT NOT NULL CHECK(json_valid(claims) AND json_type(claims)='array' AND json_array_length(claims)<=40),
 retire_at TEXT CHECK(retire_at IS NULL OR (length(retire_at)=10 AND retire_at=strftime('%Y-%m-%d',retire_at))),
 redirect_to TEXT CHECK(redirect_to IS NULL OR (retire_at IS NOT NULL AND substr(redirect_to,1,1)='/' AND substr(redirect_to,1,2)<>'//' AND instr(redirect_to,'\')=0 AND length(redirect_to)<=200)),
 last_saved_by TEXT NOT NULL REFERENCES identities(id),
 signed_off_at TEXT CHECK(signed_off_at IS NULL OR signed_off_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',signed_off_at),'')),
 signed_off_by TEXT REFERENCES identities(id),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
 CHECK(author_id IS NULL OR reviewer_id IS NULL OR author_id<>reviewer_id),
 CHECK((signed_off_at IS NULL)=(signed_off_by IS NULL)),
 CHECK(signed_off_at IS NULL OR (author_id IS NOT NULL AND reviewer_id IS NOT NULL AND signed_off_by<>last_saved_by))
) STRICT;
CREATE INDEX content_governance_review ON content_governance(next_review_at,slug);

CREATE TABLE content_assets (
 slug TEXT PRIMARY KEY CHECK(length(slug) BETWEEN 1 AND 160 AND slug NOT GLOB '*[^a-z0-9-]*'),
 kind TEXT NOT NULL CHECK(kind IN('calculator','comparison','guide','checklist','study')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160),
 summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 10 AND 300),
 methodology TEXT NOT NULL CHECK(length(trim(methodology)) BETWEEN 30 AND 2000),
 data_as_of TEXT NOT NULL CHECK(length(data_as_of)=10 AND data_as_of=strftime('%Y-%m-%d',data_as_of)),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(payload)<=65536),
 status TEXT NOT NULL CHECK(status IN('draft','published','retired')),
 published_at TEXT CHECK(published_at IS NULL OR published_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',published_at),'')),
 retired_at TEXT CHECK(retired_at IS NULL OR retired_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',retired_at),'')),
 version INTEGER NOT NULL CHECK(version>=1),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
 CHECK((status='published' AND published_at IS NOT NULL AND retired_at IS NULL)
  OR (status='draft' AND published_at IS NULL AND retired_at IS NULL)
  OR (status='retired' AND retired_at IS NOT NULL))
) STRICT;
CREATE INDEX content_assets_public ON content_assets(status,kind,slug);

CREATE TABLE content_governance_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 entity TEXT NOT NULL CHECK(entity IN('author','governance','asset')),
 entity_key TEXT NOT NULL CHECK(length(entity_key) BETWEEN 1 AND 160),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 action TEXT NOT NULL CHECK(action IN('save_author','save_governance','sign_off','save_asset','publish_asset','retire_asset')),
 version INTEGER NOT NULL CHECK(version>=1),
 response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(actor_id,idempotency_key), UNIQUE(entity,entity_key,version)
) STRICT;
CREATE TRIGGER content_governance_events_no_update BEFORE UPDATE ON content_governance_events
BEGIN SELECT RAISE(ABORT,'content_governance_events_immutable'); END;
CREATE TRIGGER content_governance_events_no_delete BEFORE DELETE ON content_governance_events
BEGIN SELECT RAISE(ABORT,'content_governance_events_immutable'); END;
