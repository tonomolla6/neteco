-- Catalog quality review state, idempotent command receipts, and immutable audit log (CAT-017).
CREATE TABLE catalog_quality_review_commands (
 actor_id TEXT NOT NULL REFERENCES identities(id),
 command_id TEXT NOT NULL,
 product_id TEXT NOT NULL REFERENCES products(id),
 product_legacy_id INTEGER NOT NULL CHECK(product_legacy_id BETWEEN 1 AND 9007199254740991),
 expected_catalog_version INTEGER NOT NULL CHECK(expected_catalog_version BETWEEN 1 AND 9007199254740991),
 expected_review_version INTEGER NOT NULL CHECK(expected_review_version BETWEEN 0 AND 9007199254740990),
 result_review_version INTEGER NOT NULL CHECK(result_review_version=expected_review_version+1),
 score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
 penalty_codes_json TEXT NOT NULL CHECK(json_valid(penalty_codes_json) AND json_type(penalty_codes_json)='array'),
 note TEXT CHECK(note IS NULL OR (length(trim(note)) BETWEEN 1 AND 500 AND note NOT GLOB ('*' || char(10) || '*') AND note NOT GLOB ('*' || char(13) || '*'))),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object'),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 PRIMARY KEY(actor_id,command_id),
 UNIQUE(product_id,result_review_version),
 CHECK(COALESCE(json_extract(input_json,'$.expectedCatalogVersion')=expected_catalog_version
  AND json_extract(input_json,'$.expectedReviewVersion')=expected_review_version,0)),
 CHECK(COALESCE(json_extract(receipt_json,'$.source')='cloudflare'
  AND json_extract(receipt_json,'$.commandId')=command_id
  AND json_extract(receipt_json,'$.productId')=product_legacy_id
  AND json_extract(receipt_json,'$.reviewedCatalogVersion')=expected_catalog_version
  AND json_extract(receipt_json,'$.expectedReviewVersion')=expected_review_version
  AND json_extract(receipt_json,'$.reviewVersion')=result_review_version
  AND json_extract(receipt_json,'$.score')=score
  AND json_extract(receipt_json,'$.payloadHash')=payload_hash
  AND json_extract(receipt_json,'$.reviewedAt')=recorded_at,0))
) STRICT;

CREATE TABLE catalog_quality_reviews (
 product_id TEXT PRIMARY KEY REFERENCES products(id),
 product_legacy_id INTEGER NOT NULL UNIQUE CHECK(product_legacy_id BETWEEN 1 AND 9007199254740991),
 review_version INTEGER NOT NULL CHECK(review_version>=1),
 reviewed_catalog_version INTEGER NOT NULL CHECK(reviewed_catalog_version>=1),
 reviewed_score INTEGER NOT NULL CHECK(reviewed_score BETWEEN 0 AND 100),
 penalty_codes_json TEXT NOT NULL CHECK(json_valid(penalty_codes_json) AND json_type(penalty_codes_json)='array'),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 reviewed_by TEXT NOT NULL REFERENCES identities(id),
 reviewed_at TEXT NOT NULL CHECK(reviewed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',reviewed_at),'')),
 command_id TEXT NOT NULL,
 FOREIGN KEY(reviewed_by,command_id) REFERENCES catalog_quality_review_commands(actor_id,command_id)
) STRICT;

CREATE TABLE catalog_quality_review_audit (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id),
 product_legacy_id INTEGER NOT NULL CHECK(product_legacy_id BETWEEN 1 AND 9007199254740991),
 review_version INTEGER NOT NULL CHECK(review_version>=1),
 reviewed_catalog_version INTEGER NOT NULL CHECK(reviewed_catalog_version>=1),
 reviewed_score INTEGER NOT NULL CHECK(reviewed_score BETWEEN 0 AND 100),
 penalty_codes_json TEXT NOT NULL CHECK(json_valid(penalty_codes_json) AND json_type(penalty_codes_json)='array'),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 command_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
 UNIQUE(product_id,review_version),
 UNIQUE(actor_id,command_id),
 FOREIGN KEY(actor_id,command_id) REFERENCES catalog_quality_review_commands(actor_id,command_id)
) STRICT;

CREATE INDEX idx_catalog_quality_reviews_reviewed_at ON catalog_quality_reviews(reviewed_at ASC, product_legacy_id ASC);
CREATE INDEX idx_catalog_quality_review_audit_product ON catalog_quality_review_audit(product_id, review_version DESC);

CREATE TRIGGER catalog_quality_review_command_admission BEFORE INSERT ON catalog_quality_review_commands
WHEN NOT EXISTS(SELECT 1 FROM products p WHERE p.id=NEW.product_id AND p.legacy_id=NEW.product_legacy_id AND p.catalog_version=NEW.expected_catalog_version)
 OR NEW.expected_review_version<>COALESCE((SELECT review_version FROM catalog_quality_reviews WHERE product_id=NEW.product_id),0)
BEGIN SELECT RAISE(ABORT,'catalog_quality_review_command_invalid'); END;

CREATE TRIGGER catalog_quality_review_head_insert BEFORE INSERT ON catalog_quality_reviews
WHEN NOT EXISTS(SELECT 1 FROM catalog_quality_review_commands c WHERE c.actor_id=NEW.reviewed_by AND c.command_id=NEW.command_id
 AND c.product_id=NEW.product_id AND c.product_legacy_id=NEW.product_legacy_id AND c.result_review_version=NEW.review_version
 AND c.expected_catalog_version=NEW.reviewed_catalog_version AND c.score=NEW.reviewed_score
 AND c.penalty_codes_json=NEW.penalty_codes_json AND c.note IS NEW.note AND c.recorded_at=NEW.reviewed_at)
BEGIN SELECT RAISE(ABORT,'catalog_quality_review_head_invalid'); END;

CREATE TRIGGER catalog_quality_review_head_update BEFORE UPDATE ON catalog_quality_reviews
WHEN NEW.product_id IS NOT OLD.product_id OR NEW.product_legacy_id IS NOT OLD.product_legacy_id OR NEW.review_version<>OLD.review_version+1
 OR NOT EXISTS(SELECT 1 FROM catalog_quality_review_commands c WHERE c.actor_id=NEW.reviewed_by AND c.command_id=NEW.command_id
 AND c.product_id=NEW.product_id AND c.product_legacy_id=NEW.product_legacy_id AND c.result_review_version=NEW.review_version
 AND c.expected_catalog_version=NEW.reviewed_catalog_version AND c.score=NEW.reviewed_score
 AND c.penalty_codes_json=NEW.penalty_codes_json AND c.note IS NEW.note AND c.recorded_at=NEW.reviewed_at)
BEGIN SELECT RAISE(ABORT,'catalog_quality_review_head_invalid'); END;

CREATE TRIGGER catalog_quality_review_head_no_delete BEFORE DELETE ON catalog_quality_reviews BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_head'); END;
CREATE TRIGGER catalog_quality_review_head_no_replace BEFORE INSERT ON catalog_quality_reviews
WHEN EXISTS(SELECT 1 FROM catalog_quality_reviews WHERE product_id=NEW.product_id)
 AND NEW.review_version<=(SELECT review_version FROM catalog_quality_reviews WHERE product_id=NEW.product_id)
BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_head'); END;

CREATE TRIGGER catalog_quality_review_commands_no_update BEFORE UPDATE ON catalog_quality_review_commands BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_command'); END;
CREATE TRIGGER catalog_quality_review_commands_no_delete BEFORE DELETE ON catalog_quality_review_commands BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_command'); END;
CREATE TRIGGER catalog_quality_review_commands_no_replace BEFORE INSERT ON catalog_quality_review_commands
WHEN EXISTS(SELECT 1 FROM catalog_quality_review_commands WHERE actor_id=NEW.actor_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_command'); END;

CREATE TRIGGER catalog_quality_review_audit_admission BEFORE INSERT ON catalog_quality_review_audit
WHEN NOT EXISTS(SELECT 1 FROM catalog_quality_review_commands c WHERE c.actor_id=NEW.actor_id AND c.command_id=NEW.command_id
 AND c.product_id=NEW.product_id AND c.product_legacy_id=NEW.product_legacy_id AND c.result_review_version=NEW.review_version
 AND c.expected_catalog_version=NEW.reviewed_catalog_version AND c.score=NEW.reviewed_score
 AND c.penalty_codes_json=NEW.penalty_codes_json AND c.note IS NEW.note AND c.payload_hash=NEW.payload_hash AND c.recorded_at=NEW.recorded_at)
BEGIN SELECT RAISE(ABORT,'catalog_quality_review_audit_invalid'); END;

CREATE TRIGGER catalog_quality_review_audit_no_update BEFORE UPDATE ON catalog_quality_review_audit BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_audit'); END;
CREATE TRIGGER catalog_quality_review_audit_no_delete BEFORE DELETE ON catalog_quality_review_audit BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_audit'); END;
CREATE TRIGGER catalog_quality_review_audit_no_replace BEFORE INSERT ON catalog_quality_review_audit
WHEN EXISTS(SELECT 1 FROM catalog_quality_review_audit WHERE id=NEW.id OR (product_id=NEW.product_id AND review_version=NEW.review_version) OR (actor_id=NEW.actor_id AND command_id=NEW.command_id))
BEGIN SELECT RAISE(ABORT,'immutable_catalog_quality_review_audit'); END;

CREATE TABLE catalog_quality_review_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CONSTRAINT catalog_quality_review_atomic_guard CHECK(valid=1)) STRICT;
