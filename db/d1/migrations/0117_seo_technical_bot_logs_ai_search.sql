-- SEO-023: Monitorización SEO técnica continua
-- SEO-024: Análisis de logs de bots
-- SEO-032: Búsqueda semántica/IA sin sacrificar SEO base

-- 1. SEO Crawl Runs
CREATE TABLE seo_crawl_runs (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('scheduled', 'manual', 'ci')),
  total_urls_scanned INTEGER NOT NULL DEFAULT 0 CHECK(total_urls_scanned >= 0),
  status_2xx_count INTEGER NOT NULL DEFAULT 0 CHECK(status_2xx_count >= 0),
  status_4xx_count INTEGER NOT NULL DEFAULT 0 CHECK(status_4xx_count >= 0),
  status_5xx_count INTEGER NOT NULL DEFAULT 0 CHECK(status_5xx_count >= 0),
  canonical_issues_count INTEGER NOT NULL DEFAULT 0 CHECK(canonical_issues_count >= 0),
  noindex_count INTEGER NOT NULL DEFAULT 0 CHECK(noindex_count >= 0),
  missing_schema_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_schema_count >= 0),
  orphan_count INTEGER NOT NULL DEFAULT 0 CHECK(orphan_count >= 0),
  max_depth_reached INTEGER NOT NULL DEFAULT 0 CHECK(max_depth_reached >= 0),
  accidental_changes_count INTEGER NOT NULL DEFAULT 0 CHECK(accidental_changes_count >= 0),
  baseline_run_id TEXT CHECK(baseline_run_id IS NULL OR length(baseline_run_id)=36),
  started_at TEXT NOT NULL CHECK(started_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',started_at),'')),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',completed_at),'')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;

CREATE INDEX idx_seo_crawl_runs_status ON seo_crawl_runs(status, started_at);

-- 2. Crawled Pages
CREATE TABLE seo_crawl_pages (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  run_id TEXT NOT NULL REFERENCES seo_crawl_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 1000),
  status_code INTEGER NOT NULL CHECK(status_code BETWEEN 0 AND 599),
  depth INTEGER NOT NULL CHECK(depth BETWEEN -1 AND 50),
  parent_url TEXT CHECK(parent_url IS NULL OR length(parent_url) <= 1000),
  canonical_url TEXT CHECK(canonical_url IS NULL OR length(canonical_url) <= 1000),
  canonical_status TEXT NOT NULL CHECK(canonical_status IN ('self', 'cross_domain', 'mismatch', 'missing', 'relative', 'invalid')),
  has_noindex INTEGER NOT NULL CHECK(has_noindex IN (0, 1)),
  is_orphan INTEGER NOT NULL CHECK(is_orphan IN (0, 1)),
  schema_types TEXT NOT NULL CHECK(json_valid(schema_types)),
  title TEXT CHECK(title IS NULL OR length(title) <= 500),
  meta_description TEXT CHECK(meta_description IS NULL OR length(meta_description) <= 1000),
  h1 TEXT CHECK(h1 IS NULL OR length(h1) <= 500),
  inlinks_count INTEGER NOT NULL DEFAULT 0 CHECK(inlinks_count >= 0),
  outlinks_count INTEGER NOT NULL DEFAULT 0 CHECK(outlinks_count >= 0),
  crawled_at TEXT NOT NULL CHECK(crawled_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',crawled_at),'')),
  UNIQUE(run_id, url)
) STRICT;

CREATE INDEX idx_seo_crawl_pages_run ON seo_crawl_pages(run_id, depth);
CREATE INDEX idx_seo_crawl_pages_status ON seo_crawl_pages(run_id, status_code);
CREATE INDEX idx_seo_crawl_pages_orphan ON seo_crawl_pages(run_id, is_orphan);

-- 3. SEO Issues Detected
CREATE TABLE seo_crawl_issues (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  run_id TEXT NOT NULL REFERENCES seo_crawl_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 1000),
  issue_type TEXT NOT NULL CHECK(issue_type IN (
    'http_4xx',
    'http_5xx',
    'canonical_mismatch',
    'canonical_missing',
    'canonical_loop',
    'accidental_noindex',
    'missing_schema',
    'invalid_schema',
    'orphan_page',
    'excessive_depth',
    'status_regression',
    'accidental_canonical_change',
    'accidental_title_change'
  )),
  severity TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
  details TEXT NOT NULL CHECK(json_valid(details)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;

CREATE INDEX idx_seo_crawl_issues_run ON seo_crawl_issues(run_id, severity);
CREATE INDEX idx_seo_crawl_issues_type ON seo_crawl_issues(issue_type);

-- 4. Bot Access Logs (Pseudonymized IP, Zero PII, Waste Identified)
CREATE TABLE seo_bot_access_logs (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  bot_family TEXT NOT NULL CHECK(bot_family IN ('googlebot', 'bingbot', 'duckduckbot', 'yandexbot', 'applebot', 'other_crawler', 'unknown')),
  bot_name TEXT NOT NULL CHECK(length(bot_name) <= 100),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified', 'fake', 'unverified')),
  ip_hash TEXT NOT NULL CHECK(length(ip_hash)=64 AND ip_hash NOT GLOB '*[^0-9a-f]*'),
  path TEXT NOT NULL CHECK(length(path) <= 1000),
  method TEXT NOT NULL DEFAULT 'GET' CHECK(length(method) <= 10),
  status_code INTEGER NOT NULL CHECK(status_code BETWEEN 100 AND 599),
  is_waste INTEGER NOT NULL CHECK(is_waste IN (0, 1)),
  waste_category TEXT NOT NULL CHECK(waste_category IN ('none', 'disallowed_url', 'status_4xx', 'status_5xx', 'noindex_target', 'parameter_duplicate')),
  response_time_ms INTEGER NOT NULL DEFAULT 0 CHECK(response_time_ms >= 0),
  user_agent_truncated TEXT NOT NULL CHECK(length(user_agent_truncated) <= 300),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;

CREATE INDEX idx_seo_bot_logs_created ON seo_bot_access_logs(created_at);
CREATE INDEX idx_seo_bot_logs_family ON seo_bot_access_logs(bot_family, verification_status);
CREATE INDEX idx_seo_bot_logs_waste ON seo_bot_access_logs(is_waste, waste_category);

CREATE TRIGGER seo_bot_logs_no_update BEFORE UPDATE ON seo_bot_access_logs
BEGIN SELECT RAISE(ABORT, 'bot_logs_immutable'); END;

-- 5. Bot Retention Policy
CREATE TABLE seo_bot_retention_policy (
  id TEXT PRIMARY KEY CHECK(id = 'active_policy'),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 7 AND 365),
  anonymize_ips INTEGER NOT NULL DEFAULT 1 CHECK(anonymize_ips IN (0, 1)),
  auto_prune_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_prune_enabled IN (0, 1)),
  last_pruned_at TEXT CHECK(last_pruned_at IS NULL OR last_pruned_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',last_pruned_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
) STRICT;

INSERT INTO seo_bot_retention_policy (id, retention_days, anonymize_ips, auto_prune_enabled, last_pruned_at, updated_at, version)
VALUES ('active_policy', 30, 1, 1, NULL, '2026-10-01T00:00:00Z', 1);

-- 6. SEO AI Search Queries & Syntheses (Strictly Non-Indexable Guardrails)
CREATE TABLE seo_ai_search_queries (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  query_normalized TEXT NOT NULL CHECK(length(query_normalized) BETWEEN 1 AND 200),
  answer_text TEXT NOT NULL,
  citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  grounding_score REAL NOT NULL CHECK(grounding_score >= 0.0 AND grounding_score <= 1.0),
  is_indexable INTEGER NOT NULL DEFAULT 0 CHECK(is_indexable = 0),
  noindex_enforced INTEGER NOT NULL DEFAULT 1 CHECK(noindex_enforced = 1),
  canonical_url TEXT NOT NULL CHECK(length(canonical_url) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;

CREATE INDEX idx_seo_ai_queries_created ON seo_ai_search_queries(created_at);

-- 7. Curated AI Guides (Only reviewed and approved guides may be indexed)
CREATE TABLE seo_ai_curated_guides (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  slug TEXT UNIQUE NOT NULL CHECK(length(slug) BETWEEN 3 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'),
  topic_query TEXT NOT NULL CHECK(length(topic_query) BETWEEN 3 AND 160),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 5 AND 150),
  approved_content TEXT NOT NULL CHECK(length(approved_content) >= 50),
  citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  is_indexable INTEGER NOT NULL DEFAULT 0 CHECK(is_indexable IN (0, 1)),
  canonical_url TEXT NOT NULL CHECK(length(canonical_url) BETWEEN 1 AND 1000),
  reviewer_id TEXT REFERENCES identities(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;

-- 8. Curated Guide Commands (CAS + Idempotency + Audit)
CREATE TABLE seo_ai_curated_guide_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  session_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  guide_id TEXT NOT NULL CHECK(length(guide_id)=36),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  version INTEGER NOT NULL CHECK(version = expected_version + 1),
  action TEXT NOT NULL CHECK(action IN ('create_guide', 'update_guide', 'approve_guide', 'reject_guide')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id, idempotency_key),
  UNIQUE(guide_id, version)
) STRICT;

CREATE TRIGGER seo_ai_guide_command_no_update BEFORE UPDATE ON seo_ai_curated_guide_commands
BEGIN SELECT RAISE(ABORT, 'guide_command_immutable'); END;

CREATE TRIGGER seo_ai_guide_command_no_delete BEFORE DELETE ON seo_ai_curated_guide_commands
BEGIN SELECT RAISE(ABORT, 'guide_command_immutable'); END;
