-- Explicit manually reviewed product-to-product relations. Directed only:
-- no reciprocal inference, bundle, chemical recommendation or automatic ADD.
CREATE TABLE catalog_relation_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id),
 command_id TEXT NOT NULL,
 product_id TEXT NOT NULL REFERENCES products(id),
 product_legacy_id INTEGER NOT NULL CHECK(product_legacy_id BETWEEN 1 AND 9007199254740991),
 expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
 result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(actor_id,command_id), UNIQUE(product_id,result_version),
 CHECK(COALESCE(json_extract(input_json,'$.expectedVersion')=expected_version
  AND json_type(input_json,'$.relations')='array' AND json_array_length(input_json,'$.relations')<=50
  AND length(trim(json_extract(input_json,'$.reason'))) BETWEEN 10 AND 500
  AND length(trim(json_extract(input_json,'$.reviewReference'))) BETWEEN 3 AND 200,0)),
 CHECK(COALESCE(json_extract(receipt_json,'$.source')='cloudflare'
  AND json_extract(receipt_json,'$.commandId')=command_id AND json_extract(receipt_json,'$.productId')=product_legacy_id
  AND json_extract(receipt_json,'$.expectedVersion')=expected_version AND json_extract(receipt_json,'$.version')=result_version
  AND json_extract(receipt_json,'$.payloadHash')=payload_hash AND json_extract(receipt_json,'$.recordedAt')=recorded_at,0))
) STRICT;
CREATE TABLE catalog_relation_revisions (
 product_id TEXT NOT NULL REFERENCES products(id),version INTEGER NOT NULL CHECK(version>=1),
 actor_id TEXT NOT NULL,command_id TEXT NOT NULL,relations_json TEXT NOT NULL CHECK(json_valid(relations_json) AND json_type(relations_json)='array' AND json_array_length(relations_json)<=50),
 payload_hash TEXT NOT NULL,recorded_at TEXT NOT NULL,
 PRIMARY KEY(product_id,version), UNIQUE(actor_id,command_id),
 FOREIGN KEY(actor_id,command_id) REFERENCES catalog_relation_commands(actor_id,command_id)
) STRICT;
CREATE TABLE catalog_relation_heads (
 product_id TEXT PRIMARY KEY REFERENCES products(id),version INTEGER NOT NULL CHECK(version>=1),
 actor_id TEXT NOT NULL,command_id TEXT NOT NULL,updated_at TEXT NOT NULL,
 FOREIGN KEY(product_id,version) REFERENCES catalog_relation_revisions(product_id,version),
 FOREIGN KEY(actor_id,command_id) REFERENCES catalog_relation_commands(actor_id,command_id)
) STRICT;
CREATE TRIGGER catalog_relation_command_admission BEFORE INSERT ON catalog_relation_commands
WHEN NOT EXISTS(SELECT 1 FROM products p WHERE p.id=NEW.product_id AND p.legacy_id=NEW.product_legacy_id)
 OR NEW.expected_version<>COALESCE((SELECT version FROM catalog_relation_heads WHERE product_id=NEW.product_id),0)
 OR EXISTS(SELECT 1 FROM json_each(NEW.input_json,'$.relations') edge LEFT JOIN products target ON target.legacy_id=json_extract(edge.value,'$.targetProductId')
 WHERE target.id IS NULL OR target.id=NEW.product_id OR COALESCE(json_extract(edge.value,'$.kind') IN('substitute','compatible','accessory','equivalent'),0)=0)
 OR (SELECT count(*) FROM json_each(NEW.input_json,'$.relations'))<>(SELECT count(*) FROM(SELECT json_extract(value,'$.targetProductId'),json_extract(value,'$.kind') FROM json_each(NEW.input_json,'$.relations') GROUP BY 1,2))
BEGIN SELECT RAISE(ABORT,'catalog_relation_command_invalid'); END;
CREATE TRIGGER catalog_relation_revision_admission BEFORE INSERT ON catalog_relation_revisions
WHEN NOT EXISTS(SELECT 1 FROM catalog_relation_commands c WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND c.product_id=NEW.product_id AND c.result_version=NEW.version AND json_extract(c.input_json,'$.relations')=NEW.relations_json
 AND c.payload_hash=NEW.payload_hash AND c.recorded_at=NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'catalog_relation_revision_invalid'); END;
CREATE TRIGGER catalog_relation_head_insert BEFORE INSERT ON catalog_relation_heads
WHEN NOT EXISTS(SELECT 1 FROM catalog_relation_revisions r WHERE r.product_id=NEW.product_id AND r.version=NEW.version
 AND r.actor_id=NEW.actor_id AND r.command_id=NEW.command_id AND r.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'catalog_relation_head_invalid'); END;
CREATE TRIGGER catalog_relation_head_update BEFORE UPDATE ON catalog_relation_heads
WHEN NEW.product_id IS NOT OLD.product_id OR NEW.version<>OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM catalog_relation_revisions r WHERE r.product_id=NEW.product_id AND r.version=NEW.version
 AND r.actor_id=NEW.actor_id AND r.command_id=NEW.command_id AND r.recorded_at=NEW.updated_at)
BEGIN SELECT RAISE(ABORT,'catalog_relation_head_invalid'); END;
CREATE TRIGGER catalog_relation_head_no_delete BEFORE DELETE ON catalog_relation_heads BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_head'); END;
CREATE TRIGGER catalog_relation_head_no_replace BEFORE INSERT ON catalog_relation_heads
WHEN EXISTS(SELECT 1 FROM catalog_relation_heads WHERE product_id=NEW.product_id) AND NEW.version<=(SELECT version FROM catalog_relation_heads WHERE product_id=NEW.product_id)
BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_head'); END;
CREATE TRIGGER catalog_relation_commands_no_update BEFORE UPDATE ON catalog_relation_commands BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_command'); END;
CREATE TRIGGER catalog_relation_commands_no_delete BEFORE DELETE ON catalog_relation_commands BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_command'); END;
CREATE TRIGGER catalog_relation_commands_no_replace BEFORE INSERT ON catalog_relation_commands
WHEN EXISTS(SELECT 1 FROM catalog_relation_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_command'); END;
CREATE TRIGGER catalog_relation_revisions_no_update BEFORE UPDATE ON catalog_relation_revisions BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_revision'); END;
CREATE TRIGGER catalog_relation_revisions_no_delete BEFORE DELETE ON catalog_relation_revisions BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_revision'); END;
CREATE TRIGGER catalog_relation_revisions_no_replace BEFORE INSERT ON catalog_relation_revisions
WHEN EXISTS(SELECT 1 FROM catalog_relation_revisions WHERE product_id=NEW.product_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'immutable_catalog_relation_revision'); END;
CREATE TABLE catalog_relation_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CONSTRAINT catalog_relation_atomic_guard CHECK(valid=1)) STRICT;
