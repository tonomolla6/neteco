-- SEA-013: boost/bury and redirect rules for public search, one append-only revision per command.
-- The revisions are the immutable audit trail and the durable idempotency receipt.
-- No rules or business approvals are seeded. A rule always has a reason, an author and an expiry.
CREATE TABLE search_merchandising_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 rule_id TEXT NOT NULL CHECK(length(rule_id)=36), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1),
 term_normalized TEXT NOT NULL CHECK(length(term_normalized) BETWEEN 2 AND 160),
 kind TEXT NOT NULL CHECK(kind IN('boost','bury','redirect')),
 product_id TEXT REFERENCES products(id), weight INTEGER CHECK(weight IS NULL OR weight BETWEEN 1 AND 10),
 redirect_path TEXT CHECK(redirect_path IS NULL OR (
  length(redirect_path) BETWEEN 2 AND 300
  AND redirect_path NOT GLOB '*[^A-Za-z0-9._~/?=&,+-]*'
  AND instr(redirect_path,'//')=0 AND instr(redirect_path,'..')=0 AND instr(redirect_path,'/./')=0
  AND length(redirect_path)-length(replace(redirect_path,'?',''))<=1
  AND (redirect_path IN('/catalogo','/contenido','/recursos')
   OR redirect_path GLOB '/catalogo/*' OR redirect_path GLOB '/catalogo[?]*'
   OR redirect_path GLOB '/contenido/*' OR redirect_path GLOB '/contenido[?]*'
   OR redirect_path GLOB '/recursos/*' OR redirect_path GLOB '/recursos[?]*'
   OR redirect_path GLOB '/producto/*')
  AND (redirect_path NOT GLOB '/producto/*' OR (redirect_path NOT GLOB '/producto/*[/?]*' AND length(redirect_path)>10)))),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 valid_from TEXT NOT NULL CHECK(valid_from=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_from),'')),
 valid_until TEXT NOT NULL CHECK(valid_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',valid_until),'')
  AND valid_until>valid_from AND valid_until<=strftime('%Y-%m-%dT%H:%M:%SZ',valid_from,'+180 days')),
 status TEXT NOT NULL CHECK(status IN('active','retired')),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK((kind IN('boost','bury') AND product_id IS NOT NULL AND weight IS NOT NULL AND redirect_path IS NULL)
  OR (kind='redirect' AND product_id IS NULL AND weight IS NULL AND redirect_path IS NOT NULL)),
 UNIQUE(actor_id,idempotency_key), UNIQUE(rule_id,version)
) STRICT;
CREATE INDEX search_merchandising_term ON search_merchandising_commands(term_normalized,rule_id,version);
CREATE INDEX search_merchandising_product ON search_merchandising_commands(product_id);
CREATE VIEW search_merchandising_current AS SELECT c.* FROM search_merchandising_commands c
 WHERE c.version=(SELECT max(latest.version) FROM search_merchandising_commands latest WHERE latest.rule_id=c.rule_id);
CREATE TRIGGER search_merchandising_command_authority BEFORE INSERT ON search_merchandising_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='catalog.write' AND r.granted_at<=NEW.created_at
 AND(r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'merchandising_authority_changed'); END;
CREATE TRIGGER search_merchandising_command_guard BEFORE INSERT ON search_merchandising_commands
WHEN json_extract(NEW.snapshot,'$.id') IS NOT NEW.rule_id
 OR json_extract(NEW.snapshot,'$.version') IS NOT NEW.version
 OR json_extract(NEW.snapshot,'$.status') IS NOT NEW.status
 OR json_extract(NEW.snapshot,'$.reason') IS NOT NEW.reason
 OR json_extract(NEW.snapshot,'$.validFrom') IS NOT NEW.valid_from
 OR json_extract(NEW.snapshot,'$.validUntil') IS NOT NEW.valid_until
 OR json_extract(NEW.snapshot,'$.authorId') IS NOT NEW.actor_id
 OR json_extract(NEW.snapshot,'$.termNormalized') IS NOT NEW.term_normalized
 OR json_extract(NEW.snapshot,'$.kind') IS NOT NEW.kind
 OR json_extract(NEW.snapshot,'$.productId') IS NOT NEW.product_id
 OR json_extract(NEW.snapshot,'$.weight') IS NOT NEW.weight
 OR json_extract(NEW.snapshot,'$.redirectPath') IS NOT NEW.redirect_path
 OR json_extract(NEW.response,'$.item') IS NOT NEW.snapshot
 OR json_extract(NEW.response,'$.commandId') IS NOT NEW.id
BEGIN SELECT RAISE(ABORT,'merchandising_snapshot_mismatch'); END;
CREATE TRIGGER search_merchandising_command_cas BEFORE INSERT ON search_merchandising_commands
WHEN NEW.expected_version IS NOT COALESCE((SELECT max(version) FROM search_merchandising_commands WHERE rule_id=NEW.rule_id),0)
 OR EXISTS(SELECT 1 FROM search_merchandising_current WHERE rule_id=NEW.rule_id AND status='retired')
BEGIN SELECT RAISE(ABORT,'merchandising_version_conflict'); END;
CREATE TRIGGER search_merchandising_command_expiry BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='active' AND (NEW.valid_until<=NEW.created_at
 OR NEW.valid_until>strftime('%Y-%m-%dT%H:%M:%SZ',NEW.created_at,'+180 days'))
BEGIN SELECT RAISE(ABORT,'merchandising_expiry_invalid'); END;
CREATE TRIGGER search_merchandising_command_product BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='active' AND NEW.kind IN('boost','bury')
 AND NOT EXISTS(SELECT 1 FROM products WHERE id=NEW.product_id AND status='published')
BEGIN SELECT RAISE(ABORT,'merchandising_product_unavailable'); END;
CREATE TRIGGER search_merchandising_command_target BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='active' AND NEW.kind='redirect' AND NEW.redirect_path GLOB '/producto/*'
 AND NOT EXISTS(SELECT 1 FROM products WHERE slug=substr(NEW.redirect_path,11) AND status='published')
BEGIN SELECT RAISE(ABORT,'merchandising_redirect_target_unavailable'); END;
CREATE TRIGGER search_merchandising_command_conflict BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM search_merchandising_current c
 WHERE c.rule_id<>NEW.rule_id AND c.term_normalized=NEW.term_normalized AND c.status='active'
 AND c.valid_until>NEW.created_at AND (CASE WHEN NEW.kind='redirect' THEN c.kind='redirect'
  ELSE c.kind<>'redirect' AND c.product_id=NEW.product_id END))
BEGIN SELECT RAISE(ABORT,'merchandising_rule_conflict'); END;
CREATE TRIGGER search_merchandising_command_limit BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='active' AND (SELECT count(*) FROM search_merchandising_current c
 WHERE c.rule_id<>NEW.rule_id AND c.term_normalized=NEW.term_normalized AND c.status='active'
 AND c.valid_until>NEW.created_at)>=20
BEGIN SELECT RAISE(ABORT,'merchandising_rule_limit'); END;
CREATE TRIGGER search_merchandising_command_retire BEFORE INSERT ON search_merchandising_commands
WHEN NEW.status='retired' AND NOT EXISTS(SELECT 1 FROM search_merchandising_current c
 WHERE c.rule_id=NEW.rule_id AND c.term_normalized=NEW.term_normalized AND c.kind=NEW.kind
 AND c.product_id IS NEW.product_id AND c.weight IS NEW.weight AND c.redirect_path IS NEW.redirect_path
 AND c.valid_from=NEW.valid_from AND c.valid_until=NEW.valid_until)
BEGIN SELECT RAISE(ABORT,'merchandising_retire_content'); END;
CREATE TRIGGER search_merchandising_command_no_update BEFORE UPDATE ON search_merchandising_commands
BEGIN SELECT RAISE(ABORT,'merchandising_immutable'); END;
CREATE TRIGGER search_merchandising_command_no_delete BEFORE DELETE ON search_merchandising_commands
BEGIN SELECT RAISE(ABORT,'merchandising_immutable'); END;
