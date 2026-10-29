-- Whole-job atomic commands reuse catalog_import_job_guards. Their durable
-- receipts bind the private owner and exact immutable seal, never a page.
CREATE TABLE catalog_import_job_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 job_id TEXT NOT NULL REFERENCES catalog_import_jobs(id),
 action TEXT NOT NULL CHECK(action IN ('apply','revert')),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
   AND COALESCE(json_type(response,'$.source')='text' AND json_extract(response,'$.source')='cloudflare',0)
   AND COALESCE(json_type(response,'$.action')='text' AND json_extract(response,'$.action')=action,0)
   AND COALESCE(json_type(response,'$.jobId')='text' AND json_extract(response,'$.jobId')=job_id,0)
   AND COALESCE(json_type(response,'$.commandId')='text' AND json_extract(response,'$.commandId')=id,0)
   AND COALESCE(json_type(response,'$.jobHash')='text' AND length(json_extract(response,'$.jobHash'))=64
     AND json_extract(response,'$.jobHash') NOT GLOB '*[^0-9a-f]*',0)
   AND COALESCE(json_type(response,'$.updated')='true',0)
   AND COALESCE(json_type(response,'$.counts')='object',0)
   AND COALESCE(json_type(response,'$.counts.products')='integer' AND json_extract(response,'$.counts.products') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_type(response,'$.counts.variants')='integer' AND json_extract(response,'$.counts.variants') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_type(response,'$.counts.assets')='integer' AND json_extract(response,'$.counts.assets') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_type(response,'$.counts.mappings')='integer' AND json_extract(response,'$.counts.mappings') BETWEEN 1 AND 25000,0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(actor_id,idempotency_key), UNIQUE(job_id,action)
) STRICT;
CREATE TRIGGER catalog_import_job_commands_no_update BEFORE UPDATE ON catalog_import_job_commands
BEGIN SELECT RAISE(ABORT,'import_job_command_immutable'); END;
CREATE TRIGGER catalog_import_job_commands_no_delete BEFORE DELETE ON catalog_import_job_commands
BEGIN SELECT RAISE(ABORT,'import_job_command_immutable'); END;
CREATE TRIGGER catalog_import_job_commands_no_replace BEFORE INSERT ON catalog_import_job_commands
WHEN EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE id=NEW.id OR nonce=NEW.nonce
 OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key) OR (job_id=NEW.job_id AND action=NEW.action))
BEGIN SELECT RAISE(ABORT,'import_job_command_immutable'); END;
CREATE TRIGGER catalog_import_job_commands_shape BEFORE INSERT ON catalog_import_job_commands
WHEN (SELECT count(*) FROM json_each(NEW.response))!=7
 OR EXISTS(SELECT 1 FROM json_each(NEW.response) WHERE key NOT IN ('source','action','jobId','jobHash','commandId','counts','updated'))
 OR (SELECT count(*) FROM json_each(NEW.response,'$.counts'))!=4
 OR EXISTS(SELECT 1 FROM json_each(NEW.response,'$.counts') WHERE key NOT IN ('products','variants','assets','mappings'))
 OR NOT EXISTS(SELECT 1 FROM catalog_import_jobs j JOIN catalog_import_job_seals s ON s.job_id=j.id
   WHERE j.id=NEW.job_id AND j.actor_id=NEW.actor_id AND s.created_at<=NEW.created_at
   AND COALESCE(json_extract(NEW.response,'$.jobHash')=s.hash,0)
   AND COALESCE(json_extract(NEW.response,'$.counts.products')=json_extract(s.counts,'$.products'),0)
   AND COALESCE(json_extract(NEW.response,'$.counts.variants')=json_extract(s.counts,'$.variants'),0)
   AND COALESCE(json_extract(NEW.response,'$.counts.assets')=json_extract(s.counts,'$.assets'),0)
   AND COALESCE(json_extract(NEW.response,'$.counts.mappings')=json_extract(s.counts,'$.mappings'),0))
BEGIN SELECT RAISE(ABORT,'import_job_command_shape'); END;

-- One row per entity, including price, balance and movement evidence. Null
-- fields survive in JSON objects or arrays of fixed-sized column groups.
CREATE TABLE catalog_import_job_command_audit (
 command_id TEXT NOT NULL REFERENCES catalog_import_job_commands(id),
 kind TEXT NOT NULL CHECK(kind IN ('products','variants','assets','media','prices','balances','movements')),
 item_id TEXT NOT NULL CHECK(length(item_id)>0),
 before_state TEXT CHECK(before_state IS NULL OR (json_valid(before_state)
   AND json_type(before_state) IN ('object','array') AND length(CAST(before_state AS BLOB))<=1800000)),
 after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state) IN ('object','array')
   AND length(CAST(after_state AS BLOB))<=1800000),
 -- Both snapshots share one D1 row; leave room for keys below its 2 MB cap.
 CHECK(COALESCE(length(CAST(before_state AS BLOB)),0)+length(CAST(after_state AS BLOB))<=1900000),
 PRIMARY KEY(command_id,kind,item_id)
) STRICT;
CREATE TRIGGER catalog_import_job_command_audit_no_update BEFORE UPDATE ON catalog_import_job_command_audit
BEGIN SELECT RAISE(ABORT,'import_job_audit_immutable'); END;
CREATE TRIGGER catalog_import_job_command_audit_no_delete BEFORE DELETE ON catalog_import_job_command_audit
BEGIN SELECT RAISE(ABORT,'import_job_audit_immutable'); END;
CREATE TRIGGER catalog_import_job_command_audit_no_replace BEFORE INSERT ON catalog_import_job_command_audit
WHEN EXISTS(SELECT 1 FROM catalog_import_job_command_audit WHERE command_id=NEW.command_id AND kind=NEW.kind AND item_id=NEW.item_id)
BEGIN SELECT RAISE(ABORT,'import_job_audit_immutable'); END;
