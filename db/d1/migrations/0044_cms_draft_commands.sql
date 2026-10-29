-- Port of the existing typed CMS draft domain. No public version, preview token,
-- publication schedule, default identity or permission grant is created here.
CREATE TABLE content_pages (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 160 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
  status TEXT NOT NULL CHECK(status IN ('draft','hidden')),
  page_version INTEGER NOT NULL CHECK(page_version BETWEEN 1 AND 9007199254740990),
  draft_version INTEGER NOT NULL CHECK(draft_version BETWEEN 0 AND page_version),
  draft_version_id TEXT REFERENCES content_versions(id),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'') AND updated_at>=created_at),
  archived_at TEXT CHECK(archived_at IS NULL OR archived_at=updated_at),
  CHECK((status='hidden')=(archived_at IS NOT NULL)),
  CHECK((draft_version=0)=(draft_version_id IS NULL))
) STRICT;
CREATE TABLE content_versions (
  id TEXT PRIMARY KEY CHECK(length(id)=36), page_id TEXT NOT NULL REFERENCES content_pages(id),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740990),
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object' AND length(CAST(document AS BLOB))<=262144),
  based_on_id TEXT REFERENCES content_versions(id),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(page_id,version)
) STRICT;
CREATE INDEX content_pages_editorial ON content_pages(updated_at DESC,id);
CREATE INDEX content_versions_history ON content_versions(page_id,version DESC);
CREATE TRIGGER content_pages_identity BEFORE UPDATE OF id,created_by,created_at ON content_pages
BEGIN SELECT RAISE(ABORT,'cms_page_identity_immutable'); END;
CREATE TRIGGER content_pages_duplicate BEFORE INSERT ON content_pages
WHEN EXISTS(SELECT 1 FROM content_pages WHERE id=NEW.id OR slug=NEW.slug)
BEGIN SELECT RAISE(ABORT,'cms_page_duplicate'); END;
CREATE TRIGGER content_pages_version BEFORE UPDATE ON content_pages
WHEN NEW.page_version<OLD.page_version OR NEW.page_version>OLD.page_version+1
BEGIN SELECT RAISE(ABORT,'cms_page_version'); END;
CREATE TRIGGER content_pages_draft_pointer BEFORE UPDATE ON content_pages
WHEN NEW.draft_version_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM content_versions v WHERE v.id=NEW.draft_version_id AND v.page_id=NEW.id AND v.version=NEW.draft_version
  AND json_extract(v.document,'$.title')=NEW.title AND json_extract(v.document,'$.slug')=NEW.slug)
BEGIN SELECT RAISE(ABORT,'cms_draft_pointer'); END;
CREATE TRIGGER content_pages_no_delete BEFORE DELETE ON content_pages
BEGIN SELECT RAISE(ABORT,'cms_page_immutable_history'); END;
CREATE TRIGGER content_versions_duplicate BEFORE INSERT ON content_versions
WHEN EXISTS(SELECT 1 FROM content_versions WHERE id=NEW.id OR (page_id=NEW.page_id AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'cms_version_immutable'); END;
CREATE TRIGGER content_versions_parent BEFORE INSERT ON content_versions
WHEN (NEW.based_on_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM content_versions WHERE id=NEW.based_on_id AND page_id=NEW.page_id))
  OR (NEW.version=1 AND NEW.based_on_id IS NOT NULL)
  OR (NEW.version>1 AND NEW.based_on_id IS NULL)
BEGIN SELECT RAISE(ABORT,'cms_version_parent'); END;
CREATE TRIGGER content_versions_media BEFORE INSERT ON content_versions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.document,'$.blocks') block WHERE json_extract(block.value,'$.type')='image'
  AND NOT EXISTS(SELECT 1 FROM media_uploads asset WHERE asset.id=json_extract(block.value,'$.assetId')
    AND asset.storage_status='quarantined' AND asset.content_type IN ('image/png','image/jpeg')))
BEGIN SELECT RAISE(ABORT,'cms_media_reference'); END;
CREATE TRIGGER content_versions_no_update BEFORE UPDATE ON content_versions
BEGIN SELECT RAISE(ABORT,'cms_version_immutable'); END;
CREATE TRIGGER content_versions_no_delete BEFORE DELETE ON content_versions
BEGIN SELECT RAISE(ABORT,'cms_version_immutable'); END;
CREATE TRIGGER content_media_in_use BEFORE DELETE ON media_uploads
WHEN EXISTS(SELECT 1 FROM content_versions version,json_each(version.document,'$.blocks') block
  WHERE json_extract(block.value,'$.type')='image' AND json_extract(block.value,'$.assetId')=OLD.id)
BEGIN SELECT RAISE(ABORT,'cms_media_in_use'); END;

-- Historical slugs remain reserved to the same page. These are not redirects
-- and do not enable a public content route or resurrect an archived draft.
CREATE TABLE content_slug_claims (
  slug TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES content_pages(id),
  created_by TEXT NOT NULL REFERENCES identities(id), created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER content_slug_claims_duplicate BEFORE INSERT ON content_slug_claims
WHEN EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=NEW.slug)
BEGIN SELECT RAISE(ABORT,'cms_slug_immutable'); END;
CREATE TRIGGER content_slug_claims_no_update BEFORE UPDATE ON content_slug_claims
BEGIN SELECT RAISE(ABORT,'cms_slug_immutable'); END;
CREATE TRIGGER content_slug_claims_no_delete BEFORE DELETE ON content_slug_claims
BEGIN SELECT RAISE(ABORT,'cms_slug_immutable'); END;
CREATE TRIGGER content_pages_slug_insert BEFORE INSERT ON content_pages
WHEN EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=NEW.slug AND page_id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'cms_slug_conflict'); END;
CREATE TRIGGER content_pages_slug_update BEFORE UPDATE OF slug ON content_pages
WHEN EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=NEW.slug AND page_id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'cms_slug_conflict'); END;

CREATE TABLE content_draft_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36), claim_nonce TEXT NOT NULL UNIQUE CHECK(length(claim_nonce)=36),
  actor_id TEXT NOT NULL REFERENCES identities(id), action TEXT NOT NULL CHECK(action IN ('create_draft','update_draft','restore_draft','archive_draft')),
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  page_id TEXT NOT NULL CHECK(length(page_id)=36),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740989),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  before_state TEXT NOT NULL CHECK(json_valid(before_state) AND json_type(before_state) IN ('object','null')),
  before_revision TEXT NOT NULL CHECK(json_valid(before_revision) AND json_type(before_revision) IN ('object','null')),
  source_revision TEXT NOT NULL CHECK(json_valid(source_revision) AND json_type(source_revision) IN ('object','null')),
  after_state TEXT NOT NULL CHECK(json_valid(after_state) AND json_type(after_state)='object'),
  after_revision TEXT NOT NULL CHECK(json_valid(after_revision) AND json_type(after_revision) IN ('object','null')),
  response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object'
    AND COALESCE(json_extract(response,'$.source')='cloudflare',0)
    AND COALESCE(json_extract(response,'$.action')=action,0)
    AND COALESCE(json_extract(response,'$.pageId')=page_id,0)
    AND COALESCE(json_extract(response,'$.pageVersion')=result_version,0)
    AND COALESCE(json_extract(response,'$.versionId')=json_extract(after_state,'$.draft_version_id'),0)
    AND COALESCE(json_extract(response,'$.draftVersion')=json_extract(after_state,'$.draft_version'),0)
    AND COALESCE(json_extract(response,'$.slug')=json_extract(after_state,'$.slug'),0)
    AND COALESCE(json_extract(response,'$.status')=json_extract(after_state,'$.status'),0)
    AND COALESCE(json_type(response,'$.updated')='true',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key), UNIQUE(page_id,result_version),
  CHECK((action='create_draft')=(expected_version=0)),
  CHECK(json_extract(after_state,'$.id')=page_id AND json_extract(after_state,'$.page_version')=result_version),
  CHECK(reason=COALESCE(json_extract(input,'$.changeSummary'),json_extract(input,'$.reason')))
) STRICT;
CREATE TRIGGER content_draft_commands_duplicate BEFORE INSERT ON content_draft_commands
WHEN EXISTS(SELECT 1 FROM content_draft_commands WHERE id=NEW.id OR claim_nonce=NEW.claim_nonce
  OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key) OR (page_id=NEW.page_id AND result_version=NEW.result_version))
BEGIN SELECT RAISE(ABORT,'cms_command_immutable'); END;
CREATE TRIGGER content_draft_commands_no_update BEFORE UPDATE ON content_draft_commands
BEGIN SELECT RAISE(ABORT,'cms_command_immutable'); END;
CREATE TRIGGER content_draft_commands_no_delete BEFORE DELETE ON content_draft_commands
BEGIN SELECT RAISE(ABORT,'cms_command_immutable'); END;
CREATE TABLE content_draft_audit (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES content_draft_commands(id),
  actor_id TEXT NOT NULL REFERENCES identities(id), action TEXT NOT NULL,target TEXT NOT NULL,input TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES content_pages(id),expected_version INTEGER NOT NULL,result_version INTEGER NOT NULL,
  reason TEXT NOT NULL,before_state TEXT NOT NULL,before_revision TEXT NOT NULL,source_revision TEXT NOT NULL,
  after_state TEXT NOT NULL,after_revision TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER content_draft_audit_duplicate BEFORE INSERT ON content_draft_audit
WHEN EXISTS(SELECT 1 FROM content_draft_audit WHERE id=NEW.id OR command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'cms_audit_immutable'); END;
CREATE TRIGGER content_draft_audit_command BEFORE INSERT ON content_draft_audit
WHEN NOT EXISTS(SELECT 1 FROM content_draft_commands c WHERE c.id=NEW.command_id AND c.actor_id=NEW.actor_id
  AND c.action=NEW.action AND c.target=NEW.target AND c.input=NEW.input AND c.page_id=NEW.page_id
  AND c.expected_version=NEW.expected_version AND c.result_version=NEW.result_version AND c.reason=NEW.reason
  AND c.before_state=NEW.before_state AND c.before_revision=NEW.before_revision AND c.source_revision=NEW.source_revision
  AND c.after_state=NEW.after_state AND c.after_revision=NEW.after_revision AND c.response=NEW.response AND c.created_at=NEW.created_at)
BEGIN SELECT RAISE(ABORT,'cms_audit_command'); END;
CREATE TRIGGER content_draft_audit_no_update BEFORE UPDATE ON content_draft_audit
BEGIN SELECT RAISE(ABORT,'cms_audit_immutable'); END;
CREATE TRIGGER content_draft_audit_no_delete BEFORE DELETE ON content_draft_audit
BEGIN SELECT RAISE(ABORT,'cms_audit_immutable'); END;
CREATE TABLE content_draft_guards (
  id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CONSTRAINT cms_atomic_guard CHECK(satisfied=1)
) STRICT;
