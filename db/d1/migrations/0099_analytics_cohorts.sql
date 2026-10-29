-- DAT-014 / DAT-015: First-party cohorts and conversion funnel measurement.
-- PII-free events, grouped referrer/UTM acquisition and daily aggregates.

CREATE TABLE analytics_funnel_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  step TEXT NOT NULL CHECK(step IN('visit','product_view','cart_add','checkout_start','purchase')),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 100),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  device TEXT NOT NULL CHECK(device IN('desktop','mobile','tablet','unknown')),
  source TEXT NOT NULL CHECK(source IN('direct','organic','cpc','social','email','referral','other')),
  segment TEXT NOT NULL CHECK(segment IN('anonymous','customer','professional')),
  target_id TEXT CHECK(target_id IS NULL OR (length(target_id) BETWEEN 1 AND 120)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'+0 days'),'')),
  received_at TEXT NOT NULL CHECK(length(received_at)=20 AND received_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',received_at,'+0 days'),'')),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=20 AND expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at,'+0 days'),'') AND expires_at>occurred_at)
) STRICT;

CREATE INDEX analytics_funnel_period ON analytics_funnel_events(environment,occurred_at,event_id);
CREATE INDEX analytics_funnel_session ON analytics_funnel_events(environment,session_hash,occurred_at);
CREATE INDEX analytics_funnel_expiry ON analytics_funnel_events(environment,expires_at,event_id);

CREATE TRIGGER analytics_funnel_no_update BEFORE UPDATE ON analytics_funnel_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;

CREATE TRIGGER analytics_funnel_no_delete BEFORE DELETE ON analytics_funnel_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;

CREATE TRIGGER analytics_funnel_no_replace BEFORE INSERT ON analytics_funnel_events
WHEN EXISTS(SELECT 1 FROM analytics_funnel_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;

CREATE TRIGGER analytics_funnel_cross_key_client BEFORE INSERT ON analytics_funnel_events
WHEN EXISTS(SELECT 1 FROM analytics_client_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;

-- Fast daily aggregation table for conversion funnel with zero N+1
CREATE TABLE funnel_analytics_daily (
  day TEXT NOT NULL CHECK(length(day)=10 AND day=strftime('%Y-%m-%d', day)),
  step TEXT NOT NULL CHECK(step IN('visit','product_view','cart_add','checkout_start','purchase')),
  device TEXT NOT NULL CHECK(device IN('desktop','mobile','tablet','unknown')),
  source TEXT NOT NULL CHECK(source IN('direct','organic','cpc','social','email','referral','other')),
  segment TEXT NOT NULL CHECK(segment IN('anonymous','customer','professional')),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  events_count INTEGER NOT NULL DEFAULT 0 CHECK(events_count >= 0),
  unique_sessions_count INTEGER NOT NULL DEFAULT 0 CHECK(unique_sessions_count >= 0),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at,'+0 days'),'')),
  PRIMARY KEY (day, step, device, source, segment, environment)
) STRICT;

CREATE INDEX funnel_analytics_daily_query ON funnel_analytics_daily(environment, day, device, source, segment);

CREATE TRIGGER funnel_analytics_trigger_insert AFTER INSERT ON analytics_funnel_events
BEGIN
  INSERT INTO funnel_analytics_daily (
    day, step, device, source, segment, environment,
    events_count, unique_sessions_count, updated_at
  )
  VALUES (
    substr(NEW.occurred_at, 1, 10),
    NEW.step,
    NEW.device,
    NEW.source,
    NEW.segment,
    NEW.environment,
    1,
    CASE WHEN EXISTS(
      SELECT 1 FROM analytics_funnel_events prev
      WHERE prev.environment = NEW.environment
        AND prev.session_hash = NEW.session_hash
        AND prev.step = NEW.step
        AND substr(prev.occurred_at, 1, 10) = substr(NEW.occurred_at, 1, 10)
        AND prev.event_id <> NEW.event_id
    ) THEN 0 ELSE 1 END,
    NEW.received_at
  )
  ON CONFLICT(day, step, device, source, segment, environment) DO UPDATE SET
    events_count = events_count + 1,
    unique_sessions_count = unique_sessions_count + CASE WHEN EXISTS(
      SELECT 1 FROM analytics_funnel_events prev
      WHERE prev.environment = NEW.environment
        AND prev.session_hash = NEW.session_hash
        AND prev.step = NEW.step
        AND substr(prev.occurred_at, 1, 10) = substr(NEW.occurred_at, 1, 10)
        AND prev.event_id <> NEW.event_id
    ) THEN 0 ELSE 1 END,
    updated_at = NEW.received_at;
END;
