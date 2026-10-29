-- Editorial approval is explicit catalog.publish + an audited reason. Drafts
-- and public releases have independent CAS heads. No grants, keys or policy are seeded.
CREATE TABLE content_publication_states (
  page_id TEXT PRIMARY KEY REFERENCES content_pages(id), revision INTEGER NOT NULL CHECK(revision>=1 AND revision<9007199254740991),
  publication_id TEXT REFERENCES content_publications(id), schedule_id TEXT REFERENCES content_schedules(id),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE TABLE content_publications (
  id TEXT PRIMARY KEY CHECK(length(id)=36), page_id TEXT NOT NULL REFERENCES content_pages(id),
  version_id TEXT NOT NULL REFERENCES content_versions(id), slug TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES identities(id), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  published_at TEXT NOT NULL CHECK(published_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',published_at),''))
) STRICT;
CREATE INDEX content_publications_slug ON content_publications(slug,page_id);
CREATE TRIGGER content_publication_version BEFORE INSERT ON content_publications
WHEN NOT EXISTS(SELECT 1 FROM content_versions WHERE id=NEW.version_id AND page_id=NEW.page_id AND json_extract(document,'$.slug')=NEW.slug)
BEGIN SELECT RAISE(ABORT,'cms_publication_version'); END;
CREATE TRIGGER content_publication_head BEFORE UPDATE ON content_publication_states
WHEN NEW.page_id<>OLD.page_id OR NEW.revision<>OLD.revision+1
 OR (NEW.publication_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_publications WHERE id=NEW.publication_id AND page_id=NEW.page_id))
 OR (NEW.schedule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_schedules WHERE id=NEW.schedule_id AND page_id=NEW.page_id))
BEGIN SELECT RAISE(ABORT,'cms_publication_head'); END;
CREATE TRIGGER content_publication_head_insert BEFORE INSERT ON content_publication_states
WHEN NEW.revision<>1 OR (NEW.publication_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_publications WHERE id=NEW.publication_id AND page_id=NEW.page_id))
 OR (NEW.schedule_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_schedules WHERE id=NEW.schedule_id AND page_id=NEW.page_id))
BEGIN SELECT RAISE(ABORT,'cms_publication_head'); END;
CREATE TRIGGER content_archive_public BEFORE UPDATE OF status ON content_pages
WHEN NEW.status='hidden' AND EXISTS(SELECT 1 FROM content_publication_states WHERE page_id=NEW.id AND (publication_id IS NOT NULL OR schedule_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'cms_publication_active'); END;
CREATE TABLE content_schedules (
  id TEXT PRIMARY KEY CHECK(length(id)=36), page_id TEXT NOT NULL REFERENCES content_pages(id),
  version_id TEXT NOT NULL REFERENCES content_versions(id), actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  approved_publication_id TEXT REFERENCES content_publications(id),
  publish_at TEXT, unpublish_at TEXT, created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  CHECK(publish_at IS NOT NULL OR unpublish_at IS NOT NULL),
  CHECK(publish_at IS NULL OR (publish_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',publish_at),'') AND publish_at>created_at)),
  CHECK(unpublish_at IS NULL OR (unpublish_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',unpublish_at),'') AND unpublish_at>COALESCE(publish_at,created_at)))
) STRICT;
CREATE TRIGGER content_schedule_version BEFORE INSERT ON content_schedules
WHEN NOT EXISTS(SELECT 1 FROM content_versions WHERE id=NEW.version_id AND page_id=NEW.page_id)
 OR (NEW.approved_publication_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_publications WHERE id=NEW.approved_publication_id AND page_id=NEW.page_id))
BEGIN SELECT RAISE(ABORT,'cms_schedule_version'); END;
CREATE TABLE content_schedule_events (
  id TEXT PRIMARY KEY CHECK(length(id)=36), schedule_id TEXT NOT NULL REFERENCES content_schedules(id),
  phase TEXT NOT NULL CHECK(phase IN ('publish','unpublish','cancel')),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','blocked','cancelled')), code TEXT CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 100),
  publication_id TEXT REFERENCES content_publications(id), created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(schedule_id,phase), CHECK((phase='cancel')=(outcome='cancelled')),
  CHECK((outcome='blocked')=(code IS NOT NULL)), CHECK(NOT(phase='publish' AND outcome='applied') OR publication_id IS NOT NULL)
) STRICT;
CREATE TRIGGER content_schedule_event_page BEFORE INSERT ON content_schedule_events
WHEN NOT EXISTS(SELECT 1 FROM content_schedules WHERE id=NEW.schedule_id AND created_at<=NEW.created_at)
 OR (NEW.publication_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_publications p JOIN content_schedules s ON s.page_id=p.page_id WHERE p.id=NEW.publication_id AND s.id=NEW.schedule_id))
BEGIN SELECT RAISE(ABORT,'cms_schedule_event_page'); END;
CREATE INDEX content_schedules_due ON content_schedules(publish_at,unpublish_at);
CREATE TABLE content_previews (
  id TEXT PRIMARY KEY CHECK(length(id)=36), page_id TEXT NOT NULL REFERENCES content_pages(id),
  version_id TEXT NOT NULL REFERENCES content_versions(id), actor_id TEXT NOT NULL REFERENCES identities(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  device TEXT NOT NULL CHECK(device IN ('responsive','desktop','mobile')), segment TEXT NOT NULL CHECK(segment='default'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+30 minutes'))
) STRICT;
CREATE TRIGGER content_preview_version BEFORE INSERT ON content_previews
WHEN NOT EXISTS(SELECT 1 FROM content_versions WHERE id=NEW.version_id AND page_id=NEW.page_id)
BEGIN SELECT RAISE(ABORT,'cms_preview_version'); END;
CREATE TABLE content_preview_revocations (
  preview_id TEXT PRIMARY KEY REFERENCES content_previews(id), actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500), created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER content_preview_revocation_time BEFORE INSERT ON content_preview_revocations
WHEN NOT EXISTS(SELECT 1 FROM content_previews WHERE id=NEW.preview_id AND created_at<=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'cms_preview_revocation_time'); END;
-- Independent CMS associations: a product publication never grants CMS access.
CREATE TABLE content_media_links (
  id TEXT PRIMARY KEY CHECK(length(id)=36), owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('publication','preview','schedule')),
  version_id TEXT NOT NULL REFERENCES content_versions(id), block_id TEXT NOT NULL CHECK(length(block_id)=36), upload_id TEXT NOT NULL REFERENCES media_uploads(id),
  scan_receipt_id TEXT NOT NULL REFERENCES media_scan_receipts(id), rights_decision_id TEXT NOT NULL REFERENCES media_rights_decisions(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')), UNIQUE(owner_id,block_id)
) STRICT;
CREATE TRIGGER content_media_owner BEFORE INSERT ON content_media_links
WHEN NOT EXISTS(SELECT 1 FROM content_versions v,json_each(v.document,'$.blocks') b WHERE v.id=NEW.version_id
 AND json_extract(b.value,'$.id')=NEW.block_id AND json_extract(b.value,'$.type')='image' AND json_extract(b.value,'$.assetId')=NEW.upload_id)
 OR NOT EXISTS(SELECT 1 FROM media_scan_receipts WHERE id=NEW.scan_receipt_id AND upload_id=NEW.upload_id)
 OR NOT EXISTS(SELECT 1 FROM media_rights_decisions WHERE id=NEW.rights_decision_id AND upload_id=NEW.upload_id)
 OR (NEW.owner_kind='publication' AND NOT EXISTS(SELECT 1 FROM content_publications WHERE id=NEW.owner_id AND version_id=NEW.version_id))
 OR (NEW.owner_kind='preview' AND NOT EXISTS(SELECT 1 FROM content_previews WHERE id=NEW.owner_id AND version_id=NEW.version_id))
 OR (NEW.owner_kind='schedule' AND NOT EXISTS(SELECT 1 FROM content_schedules WHERE id=NEW.owner_id AND version_id=NEW.version_id))
BEGIN SELECT RAISE(ABORT,'cms_media_owner'); END;
CREATE TABLE content_publication_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36), actor_id TEXT NOT NULL REFERENCES identities(id), page_id TEXT NOT NULL REFERENCES content_pages(id),
  action TEXT NOT NULL CHECK(action IN ('publish','withdraw','schedule','cancel_schedule','preview','revoke_preview')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object' AND length(CAST(input AS BLOB))<=8192),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500), before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state) IN ('object','null')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB))<=16384),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key),
  CHECK(COALESCE(json_type(after_state,'$.revision')='integer' AND json_extract(after_state,'$.revision') BETWEEN 1 AND 9007199254740990,0)),
  CHECK(COALESCE(json_type(after_state,'$.publication_id') IN ('text','null') AND json_type(after_state,'$.schedule_id') IN ('text','null'),0)),
  CHECK(COALESCE(json_type(response,'$.publicationId') IN ('text','null') AND json_type(response,'$.scheduleId') IN ('text','null'),0)),
  CHECK((json_type(before_state)='null')=(json_extract(input,'$.expectedRevision')=0)),
  CHECK(COALESCE(json_extract(input,'$.action')=action AND json_extract(input,'$.reason')=reason AND json_type(input,'$.expectedRevision')='integer' AND json_type(input,'$.expectedVersion')='integer',0)),
  CHECK(COALESCE(json_extract(after_state,'$.revision')=json_extract(input,'$.expectedRevision')+1 AND json_extract(after_state,'$.updated_at')=created_at,0)),
  CHECK(COALESCE(json_extract(response,'$.source')='cloudflare' AND json_extract(response,'$.pageId')=page_id AND json_extract(response,'$.action')=action AND json_type(response,'$.updated')='true' AND json_extract(response,'$.revision')=json_extract(after_state,'$.revision'),0)),
  CHECK(json_extract(response,'$.publicationId') IS json_extract(after_state,'$.publication_id') AND json_extract(response,'$.scheduleId') IS json_extract(after_state,'$.schedule_id'))
) STRICT;
CREATE TABLE content_publication_audit (
  command_id TEXT PRIMARY KEY REFERENCES content_publication_commands(id), actor_id TEXT NOT NULL REFERENCES identities(id),
  page_id TEXT NOT NULL REFERENCES content_pages(id), action TEXT NOT NULL, reason TEXT NOT NULL,
  before_state TEXT NOT NULL, after_state TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER content_publication_audit_match BEFORE INSERT ON content_publication_audit
WHEN NOT EXISTS(SELECT 1 FROM content_publication_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
 AND c.page_id=NEW.page_id AND c.action=NEW.action AND c.reason=NEW.reason AND c.before_state=NEW.before_state
 AND c.after_state=NEW.after_state AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'cms_publication_audit'); END;
CREATE TABLE content_publication_guards (id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT cms_publication_guard CHECK(satisfied=1)) STRICT;
CREATE TRIGGER content_publication_states_no_delete BEFORE DELETE ON content_publication_states BEGIN SELECT RAISE(ABORT,'cms_publication_history'); END;
CREATE TRIGGER content_publications_no_update BEFORE UPDATE ON content_publications BEGIN SELECT RAISE(ABORT,'cms_publication_immutable'); END;
CREATE TRIGGER content_publications_no_delete BEFORE DELETE ON content_publications BEGIN SELECT RAISE(ABORT,'cms_publication_immutable'); END;
CREATE TRIGGER content_schedules_no_update BEFORE UPDATE ON content_schedules BEGIN SELECT RAISE(ABORT,'cms_schedule_immutable'); END;
CREATE TRIGGER content_schedules_no_delete BEFORE DELETE ON content_schedules BEGIN SELECT RAISE(ABORT,'cms_schedule_immutable'); END;
CREATE TRIGGER content_schedule_events_no_update BEFORE UPDATE ON content_schedule_events BEGIN SELECT RAISE(ABORT,'cms_schedule_event_immutable'); END;
CREATE TRIGGER content_schedule_events_no_delete BEFORE DELETE ON content_schedule_events BEGIN SELECT RAISE(ABORT,'cms_schedule_event_immutable'); END;
CREATE TRIGGER content_previews_no_update BEFORE UPDATE ON content_previews BEGIN SELECT RAISE(ABORT,'cms_preview_immutable'); END;
CREATE TRIGGER content_previews_no_delete BEFORE DELETE ON content_previews BEGIN SELECT RAISE(ABORT,'cms_preview_immutable'); END;
CREATE TRIGGER content_preview_revocations_no_update BEFORE UPDATE ON content_preview_revocations BEGIN SELECT RAISE(ABORT,'cms_preview_revocation_immutable'); END;
CREATE TRIGGER content_preview_revocations_no_delete BEFORE DELETE ON content_preview_revocations BEGIN SELECT RAISE(ABORT,'cms_preview_revocation_immutable'); END;
CREATE TRIGGER content_media_links_no_update BEFORE UPDATE ON content_media_links BEGIN SELECT RAISE(ABORT,'cms_media_immutable'); END;
CREATE TRIGGER content_media_links_no_delete BEFORE DELETE ON content_media_links BEGIN SELECT RAISE(ABORT,'cms_media_immutable'); END;
CREATE TRIGGER content_publication_commands_no_update BEFORE UPDATE ON content_publication_commands BEGIN SELECT RAISE(ABORT,'cms_command_immutable'); END;
CREATE TRIGGER content_publication_commands_no_delete BEFORE DELETE ON content_publication_commands BEGIN SELECT RAISE(ABORT,'cms_command_immutable'); END;
CREATE TRIGGER content_publication_audit_no_update BEFORE UPDATE ON content_publication_audit BEGIN SELECT RAISE(ABORT,'cms_audit_immutable'); END;
CREATE TRIGGER content_publication_audit_no_delete BEFORE DELETE ON content_publication_audit BEGIN SELECT RAISE(ABORT,'cms_audit_immutable'); END;
