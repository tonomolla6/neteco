-- MKT-009 + MKT-010: administrable marketing modals engine with anti-annoyance rules.
-- Versioned modal definitions, CAS, append-only audit trail, global cooldown policy,
-- and consented anonymous visitor interaction ledger. No modal or campaign is seeded.

CREATE TABLE marketing_modals (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
 code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 64 AND code=lower(code)
   AND substr(code,1,1) GLOB '[a-z0-9]' AND code NOT GLOB '*[^a-z0-9_-]*'),
 current_version INTEGER NOT NULL CHECK(current_version>=1),
 status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
 priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 1000),
 priority_tier TEXT NOT NULL CHECK(priority_tier IN ('normal','high','critical')),
 starts_at TEXT NOT NULL CHECK(starts_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',starts_at),'')),
 ends_at TEXT CHECK(ends_at IS NULL OR (ends_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',ends_at),'') AND ends_at>starts_at)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at)
) STRICT;

CREATE INDEX idx_marketing_modals_eligibility ON marketing_modals(status, priority_tier, priority DESC, updated_at DESC);

CREATE TRIGGER marketing_modals_identity_immutable BEFORE UPDATE ON marketing_modals
WHEN NEW.id IS NOT OLD.id OR NEW.code IS NOT OLD.code OR NEW.created_at IS NOT OLD.created_at
 OR NEW.current_version<>OLD.current_version+1 OR NEW.updated_at<OLD.updated_at
 OR OLD.status='retired'
BEGIN SELECT RAISE(ABORT,'marketing_modal_identity_immutable'); END;

CREATE TRIGGER marketing_modals_no_delete BEFORE DELETE ON marketing_modals
BEGIN SELECT RAISE(ABORT,'marketing_modal_immutable'); END;

CREATE TRIGGER marketing_modals_no_replace BEFORE INSERT ON marketing_modals
WHEN EXISTS(SELECT 1 FROM marketing_modals WHERE id=NEW.id OR code=NEW.code)
BEGIN SELECT RAISE(ABORT,'marketing_modal_identity_conflict'); END;

CREATE TABLE marketing_modal_versions (
 modal_id TEXT NOT NULL REFERENCES marketing_modals(id),
 version INTEGER NOT NULL CHECK(version>=1),
 status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160 AND title NOT GLOB '*[<>]*'),
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 10 AND 2000 AND body NOT GLOB '*[<>]*'),
 cta_label TEXT NOT NULL CHECK(length(trim(cta_label)) BETWEEN 2 AND 80 AND cta_label NOT GLOB '*[<>]*'),
 cta_path TEXT NOT NULL CHECK(length(cta_path) BETWEEN 1 AND 300
   AND substr(cta_path,1,1)='/' AND substr(cta_path,1,2)<>'//'
   AND instr(cta_path,'..')=0 AND instr(cta_path,'\')=0),
 objective TEXT NOT NULL CHECK(objective IN ('newsletter_subscription','professional_lead','catalog_discovery','promotion_redemption','support_guidance')),
 ab_variant_json TEXT CHECK(ab_variant_json IS NULL OR (json_valid(ab_variant_json) AND json_type(ab_variant_json)='object')),
 trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('time_on_page','scroll_depth','exit_intent','page_views')),
 trigger_value INTEGER NOT NULL CHECK(
   (trigger_kind='time_on_page' AND trigger_value BETWEEN 5 AND 3600)
   OR (trigger_kind='scroll_depth' AND trigger_value BETWEEN 10 AND 100)
   OR (trigger_kind='exit_intent' AND trigger_value BETWEEN 5 AND 3600)
   OR (trigger_kind='page_views' AND trigger_value BETWEEN 1 AND 100)
 ),
 audience_segments_json TEXT NOT NULL CHECK(json_valid(audience_segments_json) AND json_type(audience_segments_json)='array' AND json_array_length(audience_segments_json) BETWEEN 1 AND 3),
 marketing_consent TEXT NOT NULL CHECK(marketing_consent IN ('any','with_consent','without_consent')),
 include_prefixes_json TEXT NOT NULL CHECK(json_valid(include_prefixes_json) AND json_type(include_prefixes_json)='array' AND json_array_length(include_prefixes_json) BETWEEN 1 AND 20),
 exclude_prefixes_json TEXT NOT NULL CHECK(json_valid(exclude_prefixes_json) AND json_type(exclude_prefixes_json)='array' AND json_array_length(exclude_prefixes_json) BETWEEN 0 AND 20),
 priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 1000),
 priority_tier TEXT NOT NULL CHECK(priority_tier IN ('normal','high','critical')),
 max_impressions_per_visitor INTEGER NOT NULL CHECK(max_impressions_per_visitor BETWEEN 1 AND 50),
 frequency_window_seconds INTEGER NOT NULL CHECK(frequency_window_seconds BETWEEN 60 AND 7776000),
 starts_at TEXT NOT NULL CHECK(starts_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',starts_at),'')),
 ends_at TEXT CHECK(ends_at IS NULL OR (ends_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',ends_at),'') AND ends_at>starts_at)),
 definition_json TEXT NOT NULL CHECK(length(definition_json)<=65536 AND json_valid(definition_json)
   AND json_type(definition_json)='object'
   AND COALESCE(json_extract(definition_json,'$.id')=modal_id,0)
   AND COALESCE(json_extract(definition_json,'$.version')=version,0)
   AND COALESCE(json_extract(definition_json,'$.status')=status,0)),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
 created_by TEXT NOT NULL REFERENCES identities(id),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(modal_id, version)
) STRICT;

CREATE TRIGGER marketing_modal_versions_no_update BEFORE UPDATE ON marketing_modal_versions
BEGIN SELECT RAISE(ABORT,'marketing_modal_version_immutable'); END;

CREATE TRIGGER marketing_modal_versions_no_delete BEFORE DELETE ON marketing_modal_versions
BEGIN SELECT RAISE(ABORT,'marketing_modal_version_immutable'); END;

CREATE TRIGGER marketing_modal_versions_no_replace BEFORE INSERT ON marketing_modal_versions
WHEN EXISTS(SELECT 1 FROM marketing_modal_versions WHERE modal_id=NEW.modal_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'marketing_modal_version_immutable'); END;

CREATE TABLE marketing_modal_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 modal_id TEXT NOT NULL REFERENCES marketing_modals(id),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>=1),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND definition_hash NOT GLOB '*[^0-9a-f]*'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500 AND reason NOT GLOB '*[<>]*'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 FOREIGN KEY(modal_id, applied_version) REFERENCES marketing_modal_versions(modal_id, version),
 UNIQUE(modal_id, applied_version)
) STRICT;

CREATE TABLE marketing_modal_audit (
 command_id TEXT PRIMARY KEY REFERENCES marketing_modal_commands(command_id),
 modal_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
 actor_id TEXT NOT NULL,
 definition_hash TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER marketing_modal_command_authority BEFORE INSERT ON marketing_modal_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'marketing_modal_authority_changed'); END;

CREATE TRIGGER marketing_modal_audit_matches BEFORE INSERT ON marketing_modal_audit
WHEN NOT EXISTS(SELECT 1 FROM marketing_modal_commands c JOIN marketing_modal_versions v
 ON v.modal_id=c.modal_id AND v.version=c.applied_version
 WHERE c.command_id=NEW.command_id AND c.modal_id=NEW.modal_id AND c.applied_version=NEW.version
 AND v.status=NEW.status AND c.actor_id=NEW.actor_id AND c.definition_hash=NEW.definition_hash
 AND c.payload_hash=NEW.payload_hash AND c.reason=NEW.reason AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'marketing_modal_audit_mismatch'); END;

CREATE TRIGGER marketing_modal_commands_no_update BEFORE UPDATE ON marketing_modal_commands
BEGIN SELECT RAISE(ABORT,'marketing_modal_command_immutable'); END;

CREATE TRIGGER marketing_modal_commands_no_delete BEFORE DELETE ON marketing_modal_commands
BEGIN SELECT RAISE(ABORT,'marketing_modal_command_immutable'); END;

CREATE TRIGGER marketing_modal_commands_no_replace BEFORE INSERT ON marketing_modal_commands
WHEN EXISTS(SELECT 1 FROM marketing_modal_commands WHERE command_id=NEW.command_id OR (modal_id=NEW.modal_id AND applied_version=NEW.applied_version))
BEGIN SELECT RAISE(ABORT,'marketing_modal_command_immutable'); END;

CREATE TRIGGER marketing_modal_audit_no_update BEFORE UPDATE ON marketing_modal_audit
BEGIN SELECT RAISE(ABORT,'marketing_modal_audit_immutable'); END;

CREATE TRIGGER marketing_modal_audit_no_delete BEFORE DELETE ON marketing_modal_audit
BEGIN SELECT RAISE(ABORT,'marketing_modal_audit_immutable'); END;

CREATE TRIGGER marketing_modal_audit_no_replace BEFORE INSERT ON marketing_modal_audit
WHEN EXISTS(SELECT 1 FROM marketing_modal_audit WHERE command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'marketing_modal_audit_immutable'); END;

CREATE TABLE marketing_modal_policy_commands (
 command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>=1),
 expected_version INTEGER NOT NULL CHECK(expected_version>=0),
 applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
 global_cooldown_seconds INTEGER NOT NULL CHECK(global_cooldown_seconds BETWEEN 60 AND 604800),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 500 AND reason NOT GLOB '*[<>]*'),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 UNIQUE(applied_version)
) STRICT;

CREATE TABLE marketing_modal_policies (
 id TEXT PRIMARY KEY CHECK(id='default'),
 version INTEGER NOT NULL CHECK(version>=1),
 global_cooldown_seconds INTEGER NOT NULL CHECK(global_cooldown_seconds BETWEEN 60 AND 604800),
 updated_by TEXT NOT NULL REFERENCES identities(id),
 updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
 command_id TEXT NOT NULL UNIQUE REFERENCES marketing_modal_policy_commands(command_id)
) STRICT;

CREATE TRIGGER marketing_modal_policy_command_authority BEFORE INSERT ON marketing_modal_policy_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND s.identity_id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=NEW.created_at AND s.expires_at>NEW.created_at
 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=NEW.created_at
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=NEW.created_at
 AND (r.expires_at IS NULL OR r.expires_at>NEW.created_at)))
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_authority_changed'); END;

CREATE TRIGGER marketing_modal_policy_commands_no_update BEFORE UPDATE ON marketing_modal_policy_commands
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_command_immutable'); END;

CREATE TRIGGER marketing_modal_policy_commands_no_delete BEFORE DELETE ON marketing_modal_policy_commands
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_command_immutable'); END;

CREATE TRIGGER marketing_modal_policy_commands_no_replace BEFORE INSERT ON marketing_modal_policy_commands
WHEN EXISTS(SELECT 1 FROM marketing_modal_policy_commands WHERE command_id=NEW.command_id OR applied_version=NEW.applied_version)
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_command_immutable'); END;

CREATE TRIGGER marketing_modal_policies_no_delete BEFORE DELETE ON marketing_modal_policies
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_immutable'); END;

CREATE TRIGGER marketing_modal_policies_update_guard BEFORE UPDATE ON marketing_modal_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
BEGIN SELECT RAISE(ABORT,'marketing_modal_policy_version_conflict'); END;

CREATE TABLE marketing_modal_interactions (
 event_id TEXT PRIMARY KEY CHECK(length(event_id)=36),
 visitor_hash TEXT NOT NULL CHECK(length(visitor_hash)=64 AND visitor_hash NOT GLOB '*[^0-9a-f]*'),
 modal_id TEXT NOT NULL REFERENCES marketing_modals(id),
 modal_version INTEGER NOT NULL CHECK(modal_version>=1),
 variant_key TEXT NOT NULL CHECK(variant_key IN ('A','B')),
 event_type TEXT NOT NULL CHECK(event_type IN ('impression','dismiss','convert')),
 objective TEXT NOT NULL CHECK(objective IN ('newsletter_subscription','professional_lead','catalog_discovery','promotion_redemption','support_guidance')),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 occurred_at TEXT NOT NULL CHECK(occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at),'')),
 FOREIGN KEY(modal_id, modal_version) REFERENCES marketing_modal_versions(modal_id, version)
) STRICT;

CREATE INDEX idx_marketing_modal_interactions_visitor ON marketing_modal_interactions(visitor_hash, occurred_at DESC);
CREATE INDEX idx_marketing_modal_interactions_modal ON marketing_modal_interactions(visitor_hash, modal_id, event_type, occurred_at DESC);

CREATE TRIGGER marketing_modal_interactions_no_update BEFORE UPDATE ON marketing_modal_interactions
BEGIN SELECT RAISE(ABORT,'marketing_modal_interaction_immutable'); END;

CREATE TRIGGER marketing_modal_interactions_no_delete BEFORE DELETE ON marketing_modal_interactions
BEGIN SELECT RAISE(ABORT,'marketing_modal_interaction_immutable'); END;

CREATE TABLE marketing_modal_guards (
 command_id TEXT PRIMARY KEY,
 valid INTEGER NOT NULL CHECK(valid=1)
) STRICT;
