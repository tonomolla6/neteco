-- Additive, client-reported telemetry. Existing 0052 rows and schema are retained.
CREATE TABLE analytics_promotional_events (
 event_id TEXT PRIMARY KEY CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 name TEXT NOT NULL CHECK(name IN('promotional_impression','promotional_click')),
 session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
 environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
 policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 100),
 policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
 policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
 properties_json TEXT NOT NULL CHECK(json_valid(properties_json) AND json_type(properties_json)='object' AND length(properties_json)<=4096),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'+0 days'),'')),
 received_at TEXT NOT NULL CHECK(length(received_at)=20 AND received_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',received_at,'+0 days'),'')),
 expires_at TEXT NOT NULL CHECK(length(expires_at)=20 AND expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at,'+0 days'),'') AND expires_at>occurred_at),
 CHECK(COALESCE(json_type(properties_json,'$.version')='integer' AND json_extract(properties_json,'$.version') BETWEEN 1 AND 9007199254740991
  AND json_extract(properties_json,'$.placement') IN('home','catalog','category','product')
  AND json_type(properties_json,'$.pageId')='text' AND json_type(properties_json,'$.publicationId')='text'
  AND ((name='promotional_impression' AND json_type(properties_json,'$.blockId')='null')
    OR (name='promotional_click' AND json_type(properties_json,'$.blockId')='text')),0))
) STRICT;
CREATE INDEX analytics_promotional_period ON analytics_promotional_events(environment,occurred_at,event_id);
CREATE INDEX analytics_promotional_expiry ON analytics_promotional_events(environment,expires_at,event_id);
CREATE TRIGGER analytics_promotional_properties_guard BEFORE INSERT ON analytics_promotional_events
WHEN (SELECT count(*) FROM json_each(NEW.properties_json))<>5
 OR EXISTS(SELECT 1 FROM json_each(NEW.properties_json) p WHERE p.key NOT IN('pageId','publicationId','version','placement','blockId'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.properties_json) p WHERE p.key IN('pageId','publicationId','blockId') AND p.type<>'null'
   AND (length(p.value)<>36 OR substr(p.value,9,1)<>'-' OR substr(p.value,14,1)<>'-' OR substr(p.value,19,1)<>'-' OR substr(p.value,24,1)<>'-'
    OR length(replace(p.value,'-',''))<>32 OR lower(replace(p.value,'-','')) GLOB '*[^0-9a-f]*'))
BEGIN SELECT RAISE(ABORT,'analytics_properties_prohibited'); END;
CREATE TRIGGER analytics_promotional_no_update BEFORE UPDATE ON analytics_promotional_events
BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;
CREATE TRIGGER analytics_promotional_no_replace BEFORE INSERT ON analytics_promotional_events
WHEN EXISTS(SELECT 1 FROM analytics_promotional_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;
CREATE TRIGGER analytics_promotional_cross_key BEFORE INSERT ON analytics_promotional_events
WHEN EXISTS(SELECT 1 FROM analytics_client_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;
CREATE TRIGGER analytics_client_cross_key BEFORE INSERT ON analytics_client_events
WHEN EXISTS(SELECT 1 FROM analytics_promotional_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;
CREATE VIEW analytics_browser_events AS
 SELECT event_id,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at FROM analytics_client_events
 UNION ALL
 SELECT event_id,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at FROM analytics_promotional_events;
