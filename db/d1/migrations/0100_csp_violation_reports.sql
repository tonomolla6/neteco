-- Migration: 0101_csp_violation_reports.sql
-- SEC-034: CSP violation reports aggregated by directive, blocked-uri, and route without PII.

CREATE TABLE csp_violation_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directive TEXT NOT NULL CHECK (length(directive) BETWEEN 1 AND 64),
  blocked_uri TEXT NOT NULL CHECK (length(blocked_uri) BETWEEN 1 AND 500),
  route TEXT NOT NULL CHECK (length(route) BETWEEN 1 AND 256),
  disposition TEXT NOT NULL CHECK (disposition IN ('enforce', 'report')),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  first_seen_at TEXT NOT NULL CHECK (first_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  last_seen_at TEXT NOT NULL CHECK (last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z' AND last_seen_at >= first_seen_at),
  sample_original_policy TEXT CHECK (sample_original_policy IS NULL OR length(sample_original_policy) <= 1000),
  CONSTRAINT csp_violation_unique_key UNIQUE (directive, blocked_uri, route, disposition)
) STRICT;

CREATE INDEX idx_csp_violations_route ON csp_violation_aggregates(route);
CREATE INDEX idx_csp_violations_last_seen ON csp_violation_aggregates(last_seen_at DESC);
