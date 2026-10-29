-- Editorial CRUD does not publish categories or approve a product for sale.
ALTER TABLE categories ADD COLUMN category_version INTEGER NOT NULL DEFAULT 1
  CHECK(category_version BETWEEN 1 AND 9007199254740991);
CREATE TRIGGER categories_version_insert BEFORE INSERT ON categories WHEN NEW.category_version<>1
BEGIN SELECT RAISE(ABORT,'category_version_initial'); END;
CREATE TRIGGER categories_version_guard BEFORE UPDATE ON categories
WHEN NEW.category_version<OLD.category_version OR NEW.category_version>OLD.category_version+1
BEGIN SELECT RAISE(ABORT,'category_version_monotonic'); END;
CREATE TRIGGER categories_version_bump AFTER UPDATE OF id,legacy_id,parent_id,name,slug,description,sort_order,status,
  seo_title,seo_description,source_id,source_version ON categories
WHEN NEW.category_version=OLD.category_version AND (
  NEW.id IS NOT OLD.id OR NEW.legacy_id IS NOT OLD.legacy_id OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.name IS NOT OLD.name OR NEW.slug IS NOT OLD.slug OR NEW.description IS NOT OLD.description
  OR NEW.sort_order IS NOT OLD.sort_order OR NEW.status IS NOT OLD.status OR NEW.seo_title IS NOT OLD.seo_title
  OR NEW.seo_description IS NOT OLD.seo_description OR NEW.source_id IS NOT OLD.source_id OR NEW.source_version IS NOT OLD.source_version)
BEGIN UPDATE categories SET category_version=OLD.category_version+1 WHERE id=NEW.id AND category_version=OLD.category_version; END;

CREATE TABLE catalog_category_counter (
  id INTEGER PRIMARY KEY CHECK(id=1), last_id INTEGER NOT NULL CHECK(last_id BETWEEN 999 AND 9007199254740991)
) STRICT;
INSERT INTO catalog_category_counter VALUES(1,max(999,(SELECT COALESCE(max(legacy_id),0) FROM categories)));
CREATE TRIGGER catalog_category_counter_duplicate BEFORE INSERT ON catalog_category_counter
WHEN EXISTS(SELECT 1 FROM catalog_category_counter WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'catalog_category_counter_immutable'); END;
CREATE TRIGGER catalog_category_counter_monotonic BEFORE UPDATE ON catalog_category_counter
WHEN NEW.id<>OLD.id OR NEW.last_id<=OLD.last_id
BEGIN SELECT RAISE(ABORT,'catalog_category_counter_immutable'); END;
CREATE TRIGGER catalog_category_counter_no_delete BEFORE DELETE ON catalog_category_counter
BEGIN SELECT RAISE(ABORT,'catalog_category_counter_immutable'); END;
CREATE TRIGGER categories_counter_insert AFTER INSERT ON categories WHEN NEW.legacy_id>(SELECT last_id FROM catalog_category_counter WHERE id=1)
BEGIN UPDATE catalog_category_counter SET last_id=NEW.legacy_id WHERE id=1; END;
CREATE TRIGGER categories_counter_update AFTER UPDATE OF legacy_id ON categories WHEN NEW.legacy_id>(SELECT last_id FROM catalog_category_counter WHERE id=1)
BEGIN UPDATE catalog_category_counter SET last_id=NEW.legacy_id WHERE id=1; END;

CREATE TABLE catalog_category_aliases (
  slug TEXT PRIMARY KEY CHECK(length(slug) BETWEEN 1 AND 200 AND slug NOT GLOB '*[^a-z0-9-]*'),
  category_uuid TEXT NOT NULL REFERENCES categories(id),
  created_by TEXT NOT NULL REFERENCES identities(id), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER catalog_category_aliases_duplicate BEFORE INSERT ON catalog_category_aliases
WHEN EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=NEW.slug)
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_immutable'); END;
CREATE TRIGGER catalog_category_aliases_namespace BEFORE INSERT ON catalog_category_aliases
WHEN EXISTS(SELECT 1 FROM categories WHERE slug=NEW.slug AND id<>NEW.category_uuid)
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_namespace'); END;
CREATE TRIGGER catalog_category_aliases_no_update BEFORE UPDATE ON catalog_category_aliases
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_immutable'); END;
CREATE TRIGGER catalog_category_aliases_no_delete BEFORE DELETE ON catalog_category_aliases
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_immutable'); END;
CREATE TRIGGER categories_alias_insert BEFORE INSERT ON categories
WHEN EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=NEW.slug AND category_uuid<>NEW.id)
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_namespace'); END;
CREATE TRIGGER categories_alias_update BEFORE UPDATE OF slug,id ON categories
WHEN EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=NEW.slug AND category_uuid<>NEW.id)
BEGIN SELECT RAISE(ABORT,'catalog_category_alias_namespace'); END;

CREATE TABLE catalog_category_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36), claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id), action TEXT NOT NULL CHECK(action IN ('create_category','update_category','delete_category')),
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  category_id INTEGER NOT NULL CHECK(category_id BETWEEN 1 AND 9007199254740991), category_uuid TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1 AND result_version<=9007199254740991),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500 AND json_extract(input,'$.reason')=reason),
  before_graph TEXT NOT NULL CHECK(json_valid(before_graph) AND json_type(before_graph)='array'),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state) IN ('object','null')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.categoryId')=category_id,0)
    AND COALESCE(json_extract(response,'$.categoryUuid')=category_uuid,0)
    AND COALESCE(json_extract(response,'$.categoryVersion')=result_version,0)
    AND COALESCE(json_extract(response,'$.slug')=json_extract(after_state,'$.slug'),0)
    AND COALESCE(json_extract(response,'$.status')=json_extract(after_state,'$.status'),0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key), UNIQUE(category_uuid,result_version),
  CHECK((action='create_category')=(expected_version=0)),
  CHECK(json_extract(after_state,'$.id')=category_uuid AND json_extract(after_state,'$.legacy_id')=category_id
    AND json_extract(after_state,'$.category_version')=result_version)
) STRICT;
CREATE TRIGGER catalog_category_commands_duplicate BEFORE INSERT ON catalog_category_commands
WHEN EXISTS(SELECT 1 FROM catalog_category_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key) OR (category_uuid=NEW.category_uuid AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'catalog_category_commands_immutable'); END;
CREATE TRIGGER catalog_category_commands_no_update BEFORE UPDATE ON catalog_category_commands
BEGIN SELECT RAISE(ABORT,'catalog_category_commands_immutable'); END;
CREATE TRIGGER catalog_category_commands_no_delete BEFORE DELETE ON catalog_category_commands
BEGIN SELECT RAISE(ABORT,'catalog_category_commands_immutable'); END;
CREATE TABLE catalog_category_audit (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES catalog_category_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id), action TEXT NOT NULL,target TEXT NOT NULL,input TEXT NOT NULL,
  category_id INTEGER NOT NULL,category_uuid TEXT NOT NULL REFERENCES categories(id),expected_version INTEGER NOT NULL,result_version INTEGER NOT NULL,
  reason TEXT NOT NULL,before_graph TEXT NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER catalog_category_audit_duplicate BEFORE INSERT ON catalog_category_audit
WHEN EXISTS(SELECT 1 FROM catalog_category_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'catalog_category_audit_immutable'); END;
CREATE TRIGGER catalog_category_audit_command BEFORE INSERT ON catalog_category_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_category_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.target=NEW.target AND c.input=NEW.input AND c.category_id=NEW.category_id AND c.category_uuid=NEW.category_uuid
  AND c.expected_version=NEW.expected_version AND c.result_version=NEW.result_version AND c.reason=NEW.reason
  AND c.before_graph=NEW.before_graph AND c.before_state=NEW.before_state AND c.after_state=NEW.after_state AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'catalog_category_audit_command'); END;
CREATE TRIGGER catalog_category_audit_no_update BEFORE UPDATE ON catalog_category_audit
BEGIN SELECT RAISE(ABORT,'catalog_category_audit_immutable'); END;
CREATE TRIGGER catalog_category_audit_no_delete BEFORE DELETE ON catalog_category_audit
BEGIN SELECT RAISE(ABORT,'catalog_category_audit_immutable'); END;
CREATE TABLE catalog_category_guards (
  id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT catalog_category_atomic_guard CHECK(satisfied=1)
) STRICT;
