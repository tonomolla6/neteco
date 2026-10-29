-- SEA-012: First-party search analytics and daily aggregates.
-- Never records raw unredacted queries with detected PII or user identities.
CREATE TABLE analytics_search_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK(name IN('search_performed','search_result_clicked','add_to_cart')),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 100),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  term_normalized TEXT NOT NULL CHECK(length(term_normalized) BETWEEN 1 AND 160 AND term_normalized NOT GLOB '*@*'),
  device TEXT NOT NULL CHECK(device IN('desktop','mobile','tablet','unknown')),
  segment TEXT NOT NULL CHECK(segment IN('anonymous','customer','professional')),
  result_count INTEGER CHECK(result_count IS NULL OR result_count >= 0),
  target_id TEXT CHECK(target_id IS NULL OR (length(target_id) BETWEEN 1 AND 120)),
  rank INTEGER CHECK(rank IS NULL OR (rank BETWEEN 1 AND 1000)),
  quantity INTEGER CHECK(quantity IS NULL OR (quantity BETWEEN 1 AND 100000)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'+0 days'),'')),
  received_at TEXT NOT NULL CHECK(length(received_at)=20 AND received_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',received_at,'+0 days'),'')),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=20 AND expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at,'+0 days'),'') AND expires_at>occurred_at)
) STRICT;

CREATE INDEX analytics_search_period ON analytics_search_events(environment,occurred_at,event_id);
CREATE INDEX analytics_search_session ON analytics_search_events(environment,session_hash,occurred_at);
CREATE INDEX analytics_search_term ON analytics_search_events(environment,term_normalized,occurred_at);
CREATE INDEX analytics_search_expiry ON analytics_search_events(environment,expires_at,event_id);

CREATE TRIGGER analytics_search_no_update BEFORE UPDATE ON analytics_search_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;

CREATE TRIGGER analytics_search_no_delete BEFORE DELETE ON analytics_search_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;

CREATE TRIGGER analytics_search_no_replace BEFORE INSERT ON analytics_search_events
WHEN EXISTS(SELECT 1 FROM analytics_search_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;

CREATE TRIGGER analytics_search_cross_key_client BEFORE INSERT ON analytics_search_events
WHEN EXISTS(SELECT 1 FROM analytics_client_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;

CREATE TRIGGER analytics_search_cross_key_promo BEFORE INSERT ON analytics_search_events
WHEN EXISTS(SELECT 1 FROM analytics_promotional_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;

-- Daily aggregations table for fast dashboard queries with zero N+1
CREATE TABLE search_analytics_daily (
  day TEXT NOT NULL CHECK(length(day)=10 AND day=strftime('%Y-%m-%d', day)),
  term_normalized TEXT NOT NULL CHECK(length(term_normalized) BETWEEN 1 AND 160),
  device TEXT NOT NULL CHECK(device IN('desktop','mobile','tablet','unknown')),
  segment TEXT NOT NULL CHECK(segment IN('anonymous','customer','professional')),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  searches_count INTEGER NOT NULL DEFAULT 0 CHECK(searches_count >= 0),
  zero_results_count INTEGER NOT NULL DEFAULT 0 CHECK(zero_results_count >= 0),
  clicks_count INTEGER NOT NULL DEFAULT 0 CHECK(clicks_count >= 0),
  add_to_cart_count INTEGER NOT NULL DEFAULT 0 CHECK(add_to_cart_count >= 0),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at,'+0 days'),'')),
  PRIMARY KEY (day, term_normalized, device, segment, environment)
) STRICT;

CREATE INDEX search_analytics_daily_query ON search_analytics_daily(environment, day, device, segment);
CREATE INDEX search_analytics_daily_term ON search_analytics_daily(environment, term_normalized, day);

CREATE TRIGGER search_analytics_trigger_search AFTER INSERT ON analytics_search_events
WHEN NEW.name = 'search_performed'
BEGIN
  INSERT INTO search_analytics_daily (
    day, term_normalized, device, segment, environment,
    searches_count, zero_results_count, clicks_count, add_to_cart_count, updated_at
  )
  VALUES (
    substr(NEW.occurred_at, 1, 10),
    NEW.term_normalized,
    NEW.device,
    NEW.segment,
    NEW.environment,
    1,
    CASE WHEN COALESCE(NEW.result_count, 0) = 0 THEN 1 ELSE 0 END,
    0,
    0,
    NEW.received_at
  )
  ON CONFLICT(day, term_normalized, device, segment, environment) DO UPDATE SET
    searches_count = searches_count + 1,
    zero_results_count = zero_results_count + CASE WHEN COALESCE(NEW.result_count, 0) = 0 THEN 1 ELSE 0 END,
    updated_at = NEW.received_at;
END;

CREATE TRIGGER search_analytics_trigger_click AFTER INSERT ON analytics_search_events
WHEN NEW.name = 'search_result_clicked'
BEGIN
  INSERT INTO search_analytics_daily (
    day, term_normalized, device, segment, environment,
    searches_count, zero_results_count, clicks_count, add_to_cart_count, updated_at
  )
  VALUES (
    substr(NEW.occurred_at, 1, 10),
    NEW.term_normalized,
    NEW.device,
    NEW.segment,
    NEW.environment,
    0,
    0,
    1,
    0,
    NEW.received_at
  )
  ON CONFLICT(day, term_normalized, device, segment, environment) DO UPDATE SET
    clicks_count = clicks_count + 1,
    updated_at = NEW.received_at;
END;

CREATE TRIGGER search_analytics_trigger_add_to_cart AFTER INSERT ON analytics_search_events
WHEN NEW.name = 'add_to_cart'
BEGIN
  INSERT INTO search_analytics_daily (
    day, term_normalized, device, segment, environment,
    searches_count, zero_results_count, clicks_count, add_to_cart_count, updated_at
  )
  VALUES (
    substr(NEW.occurred_at, 1, 10),
    NEW.term_normalized,
    NEW.device,
    NEW.segment,
    NEW.environment,
    0,
    0,
    0,
    1,
    NEW.received_at
  )
  ON CONFLICT(day, term_normalized, device, segment, environment) DO UPDATE SET
    add_to_cart_count = add_to_cart_count + 1,
    updated_at = NEW.received_at;
END;
