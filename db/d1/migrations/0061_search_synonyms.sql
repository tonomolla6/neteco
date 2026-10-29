-- Event-sourced synonym revisions are the immutable audit and durable receipt.
-- No synonyms or business approvals are seeded.
CREATE TABLE search_synonym_previews (
 id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL,
 target_id TEXT NOT NULL CHECK(length(target_id)=36), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 base_revision INTEGER NOT NULL CHECK(base_revision>=0), source_normalized TEXT NOT NULL CHECK(length(source_normalized) BETWEEN 2 AND 160),
 draft TEXT NOT NULL CHECK(json_valid(draft)), term_data TEXT NOT NULL CHECK(json_valid(term_data) AND json_array_length(term_data)<=8),
 response TEXT NOT NULL CHECK(json_valid(response)), hash TEXT NOT NULL CHECK(length(hash)=64),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at)
) STRICT;
CREATE INDEX search_synonym_previews_owner ON search_synonym_previews(actor_id,expires_at);
CREATE TABLE search_synonym_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id), session_version INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 preview_id TEXT NOT NULL REFERENCES search_synonym_previews(id), preview_hash TEXT NOT NULL CHECK(length(preview_hash)=64),
 synonym_id TEXT NOT NULL CHECK(length(synonym_id)=36), expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 version INTEGER NOT NULL CHECK(version=expected_version+1), source_normalized TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('save','retire')), active INTEGER NOT NULL CHECK(active IN(0,1)),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), term_data TEXT NOT NULL CHECK(json_valid(term_data)),
 response TEXT NOT NULL CHECK(json_valid(response)), created_at TEXT NOT NULL,
 UNIQUE(actor_id,idempotency_key), UNIQUE(synonym_id,version)
) STRICT;
CREATE INDEX search_synonym_revisions ON search_synonym_commands(synonym_id,version DESC);
CREATE INDEX search_synonym_source ON search_synonym_commands(source_normalized,synonym_id,version);
CREATE VIEW search_synonyms_current AS SELECT c.* FROM search_synonym_commands c
 WHERE c.version=(SELECT max(latest.version) FROM search_synonym_commands latest WHERE latest.synonym_id=c.synonym_id);
CREATE TRIGGER search_synonym_preview_authority BEFORE INSERT ON search_synonym_previews
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='catalog.write' AND r.granted_at<=NEW.created_at
 AND(r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'synonym_authority_changed'); END;
CREATE TRIGGER search_synonym_preview_revision BEFORE INSERT ON search_synonym_previews
WHEN NEW.base_revision<>(SELECT count(*) FROM search_synonym_commands)
BEGIN SELECT RAISE(ABORT,'synonym_preview_stale'); END;
CREATE TRIGGER search_synonym_command_guard BEFORE INSERT ON search_synonym_commands
WHEN NOT EXISTS(SELECT 1 FROM search_synonym_previews p WHERE p.id=NEW.preview_id AND p.actor_id=NEW.actor_id
 AND p.hash=NEW.preview_hash AND p.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND p.created_at<=NEW.created_at
 AND p.target_id=NEW.synonym_id AND p.expected_version=NEW.expected_version
 AND p.base_revision=(SELECT count(*) FROM search_synonym_commands)
 AND p.source_normalized=NEW.source_normalized AND p.term_data=NEW.term_data
 AND json_extract(p.draft,'$.action')=NEW.action AND json_extract(p.draft,'$.active')=NEW.active
 AND json_extract(NEW.snapshot,'$.sourceTerm')=json_extract(p.draft,'$.sourceTerm')
 AND json_extract(NEW.snapshot,'$.replacements')=json_extract(p.draft,'$.replacements')
 AND json_extract(NEW.response,'$.item')=NEW.snapshot
 AND json_extract(NEW.response,'$.previewId')=NEW.preview_id
 AND json_extract(NEW.response,'$.commandId')=NEW.id)
BEGIN SELECT RAISE(ABORT,'synonym_preview_stale'); END;
CREATE TRIGGER search_synonym_command_authority BEFORE INSERT ON search_synonym_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND i.status IN('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='catalog.write' AND r.granted_at<=NEW.created_at
 AND(r.expires_at IS NULL OR r.expires_at>max(NEW.created_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')))))
BEGIN SELECT RAISE(ABORT,'synonym_authority_changed'); END;
CREATE TRIGGER search_synonym_command_cas BEFORE INSERT ON search_synonym_commands
WHEN NEW.expected_version<>COALESCE((SELECT max(version) FROM search_synonym_commands WHERE synonym_id=NEW.synonym_id),0)
 OR EXISTS(SELECT 1 FROM search_synonyms_current WHERE synonym_id=NEW.synonym_id AND action='retire')
 OR EXISTS(SELECT 1 FROM search_synonyms_current WHERE source_normalized=NEW.source_normalized AND synonym_id<>NEW.synonym_id AND action<>'retire')
 OR (NEW.expected_version=0 AND (SELECT count(*) FROM search_synonyms_current WHERE action<>'retire')>=1000)
BEGIN SELECT RAISE(ABORT,'synonym_version_conflict'); END;
CREATE TRIGGER search_synonym_command_no_update BEFORE UPDATE ON search_synonym_commands
BEGIN SELECT RAISE(ABORT,'synonym_immutable'); END;
CREATE TRIGGER search_synonym_command_no_delete BEFORE DELETE ON search_synonym_commands
BEGIN SELECT RAISE(ABORT,'synonym_immutable'); END;
CREATE TRIGGER search_synonym_preview_no_update BEFORE UPDATE ON search_synonym_previews
BEGIN SELECT RAISE(ABORT,'synonym_immutable'); END;
