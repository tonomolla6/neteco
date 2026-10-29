-- Explicit category definitions only. Product JSON remains the sole authority
-- for values; no product trigger/projection, legacy mutation or permission grant.
CREATE TABLE catalog_typed_attribute_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create','update','retire')),
  definition_id TEXT NOT NULL CHECK(length(definition_id)=36),
  category_id TEXT NOT NULL REFERENCES categories(id) CHECK(length(category_id) BETWEEN 1 AND 200),
  expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740989),
  result_revision INTEGER NOT NULL CHECK(result_revision = expected_revision + 1 AND result_revision<=9007199254740990),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'
    AND json_extract(input,'$.reason') IS reason AND json_extract(input,'$.expectedVersion') IS expected_revision),
  before_state TEXT CHECK(before_state IS NULL OR (json_valid(before_state) AND json_type(before_state)='object')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'
    AND json_extract(after_state,'$.id') IS definition_id
    AND json_extract(after_state,'$.categoryUuid') IS category_id
    AND json_type(after_state,'$.categoryId') IS 'integer'
    AND json_extract(after_state,'$.categoryId') BETWEEN 1 AND 9007199254740990
    AND json_type(after_state,'$.revision') IS 'integer'
    AND json_extract(after_state,'$.revision') IS result_revision
    AND json_type(after_state,'$.config') IS 'object'
    AND json_extract(after_state,'$.status') IS CASE WHEN action='retire' THEN 'retired' ELSE 'active' END),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND json_extract(response,'$.source') IS 'cloudflare'
    AND json_extract(response,'$.action') IS action
    AND json_extract(response,'$.commandId') IS id
    AND json_extract(response,'$.definition') IS after_state
    AND json_type(response,'$.updated') IS 'true'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  UNIQUE(definition_id,result_revision),
  CHECK((action='create' AND expected_revision=0 AND before_state IS NULL) OR
        (action IN ('update','retire') AND expected_revision>0 AND before_state IS NOT NULL
         AND json_extract(before_state,'$.id') IS definition_id
         AND json_extract(before_state,'$.categoryUuid') IS category_id
         AND json_extract(before_state,'$.revision') IS expected_revision
         AND json_extract(before_state,'$.status') IS 'active'
         AND json_extract(before_state,'$.code') IS json_extract(after_state,'$.code')
         AND json_extract(before_state,'$.kind') IS json_extract(after_state,'$.kind')
         AND json_extract(before_state,'$.categoryId') IS json_extract(after_state,'$.categoryId')))
) STRICT;
CREATE TABLE catalog_typed_attribute_definitions (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  category_id TEXT NOT NULL REFERENCES categories(id) CHECK(length(category_id) BETWEEN 1 AND 200),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_-]*'),
  kind TEXT NOT NULL CHECK(kind IN ('text','number','unit','boolean','list','reference')),
  current_revision INTEGER NOT NULL CHECK(current_revision BETWEEN 1 AND 9007199254740990),
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
  UNIQUE(category_id,code)
) STRICT;
CREATE TABLE catalog_typed_attribute_revisions (
  definition_id TEXT NOT NULL REFERENCES catalog_typed_attribute_definitions(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  config TEXT NOT NULL CHECK(json_valid(config) AND json_type(config)='object'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  command_id TEXT NOT NULL REFERENCES catalog_typed_attribute_commands(id),
  PRIMARY KEY(definition_id,revision),
  UNIQUE(command_id)
) STRICT;
CREATE TABLE catalog_typed_attribute_audit (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  command_id TEXT NOT NULL UNIQUE REFERENCES catalog_typed_attribute_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create','update','retire')),
  definition_id TEXT NOT NULL CHECK(length(definition_id)=36),
  category_id TEXT NOT NULL REFERENCES categories(id),
  expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740989),
  result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1 AND result_revision<=9007199254740990),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  before_state TEXT CHECK(before_state IS NULL OR (json_valid(before_state) AND json_type(before_state)='object')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE catalog_typed_attribute_guards (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  satisfied INTEGER NOT NULL CHECK(satisfied=1)
) STRICT;
-- REPLACE's implicit DELETE skips DELETE triggers with recursive_triggers OFF.
-- Guard every primary and business identity before INSERT, not only UPDATE.
CREATE TRIGGER catalog_typed_attribute_definition_duplicate BEFORE INSERT ON catalog_typed_attribute_definitions
WHEN EXISTS(SELECT 1 FROM catalog_typed_attribute_definitions WHERE id=NEW.id OR (category_id=NEW.category_id AND code=NEW.code))
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_definition_immutable'); END;
CREATE TRIGGER catalog_typed_attribute_definition_initial BEFORE INSERT ON catalog_typed_attribute_definitions
WHEN NEW.current_revision<>1 OR NEW.status<>'active'
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_definition_initial'); END;
CREATE TRIGGER catalog_typed_attribute_revision_duplicate BEFORE INSERT ON catalog_typed_attribute_revisions
WHEN EXISTS(SELECT 1 FROM catalog_typed_attribute_revisions WHERE (definition_id=NEW.definition_id AND revision=NEW.revision) OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_revision_immutable'); END;
CREATE TRIGGER catalog_typed_attribute_command_duplicate BEFORE INSERT ON catalog_typed_attribute_commands
WHEN EXISTS(SELECT 1 FROM catalog_typed_attribute_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key)
  OR (definition_id=NEW.definition_id AND result_revision=NEW.result_revision))
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_command_immutable'); END;
CREATE TRIGGER catalog_typed_attribute_audit_duplicate BEFORE INSERT ON catalog_typed_attribute_audit
WHEN EXISTS(SELECT 1 FROM catalog_typed_attribute_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_audit_immutable'); END;
CREATE TRIGGER catalog_typed_attribute_revision_command BEFORE INSERT ON catalog_typed_attribute_revisions
WHEN NOT EXISTS(SELECT 1 FROM catalog_typed_attribute_commands c WHERE c.id=NEW.command_id
  AND c.definition_id=NEW.definition_id AND c.result_revision=NEW.revision
  AND json_extract(c.after_state,'$.label') IS NEW.label
  AND json_extract(c.after_state,'$.status') IS NEW.status
  AND json_extract(c.after_state,'$.config') IS NEW.config AND c.created_at IS NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_revision_command'); END;
CREATE TRIGGER catalog_typed_attribute_audit_command BEFORE INSERT ON catalog_typed_attribute_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_typed_attribute_commands c WHERE c.id=NEW.command_id
  AND c.actor_id IS NEW.actor_id AND c.action IS NEW.action AND c.definition_id IS NEW.definition_id
  AND c.category_id IS NEW.category_id AND c.expected_revision IS NEW.expected_revision
  AND c.result_revision IS NEW.result_revision AND c.reason IS NEW.reason AND c.input IS NEW.input
  AND c.before_state IS NEW.before_state AND c.after_state IS NEW.after_state
  AND c.response IS NEW.response AND c.created_at IS NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_audit_command'); END;
CREATE TRIGGER catalog_typed_attribute_definition_delete BEFORE DELETE ON catalog_typed_attribute_definitions BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_definition_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_definition_identity BEFORE UPDATE ON catalog_typed_attribute_definitions
WHEN NEW.id IS NOT OLD.id OR NEW.category_id IS NOT OLD.category_id OR NEW.code IS NOT OLD.code
  OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status='retired' OR NEW.current_revision<>OLD.current_revision+1
  OR NOT EXISTS(SELECT 1 FROM catalog_typed_attribute_revisions r WHERE r.definition_id=NEW.id
    AND r.revision=NEW.current_revision AND r.status=NEW.status)
BEGIN SELECT RAISE(ABORT,'catalog_typed_attribute_definition_immutable'); END;
CREATE TRIGGER catalog_typed_attribute_revision_update BEFORE UPDATE ON catalog_typed_attribute_revisions BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_revision_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_revision_delete BEFORE DELETE ON catalog_typed_attribute_revisions BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_revision_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_command_update BEFORE UPDATE ON catalog_typed_attribute_commands BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_command_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_command_delete BEFORE DELETE ON catalog_typed_attribute_commands BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_command_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_audit_update BEFORE UPDATE ON catalog_typed_attribute_audit BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_audit_immutable');
END;
CREATE TRIGGER catalog_typed_attribute_audit_delete BEFORE DELETE ON catalog_typed_attribute_audit BEGIN
  SELECT RAISE(ABORT,'catalog_typed_attribute_audit_immutable');
END;
