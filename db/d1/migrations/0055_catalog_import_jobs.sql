-- Immutable, owner-private upload workspaces. Upload and seal never change
-- catalogue, prices, balances, media storage or publication authority.
CREATE TABLE catalog_import_jobs (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 warehouse_id TEXT NOT NULL REFERENCES inventory_locations(id),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 total_pages INTEGER NOT NULL CHECK(total_pages BETWEEN 1 AND 1000),
 record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 25000),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at>created_at),
 UNIQUE(actor_id,idempotency_key)
) STRICT;
CREATE INDEX catalog_import_jobs_actor ON catalog_import_jobs(actor_id,created_at);
CREATE TABLE catalog_import_job_pages (
 job_id TEXT NOT NULL REFERENCES catalog_import_jobs(id),
 page_index INTEGER NOT NULL CHECK(page_index BETWEEN 0 AND 999),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object'
   AND COALESCE(json_type(payload,'$.records')='array',0)
   AND COALESCE(json_array_length(payload,'$.records') BETWEEN 1 AND 500,0)),
 byte_length INTEGER NOT NULL CHECK(byte_length=length(CAST(payload AS BLOB)) AND byte_length BETWEEN 1 AND 900000),
 record_count INTEGER NOT NULL CHECK(record_count BETWEEN 1 AND 500 AND COALESCE(record_count=json_array_length(payload,'$.records'),0)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 PRIMARY KEY(job_id,page_index)
) STRICT;
CREATE TABLE catalog_import_job_rows (
 job_id TEXT NOT NULL REFERENCES catalog_import_jobs(id),
 row_index INTEGER NOT NULL CHECK(row_index BETWEEN 0 AND 24999),
 page_index INTEGER NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(job_id,row_index), UNIQUE(job_id,payload_hash),
 FOREIGN KEY(job_id,page_index) REFERENCES catalog_import_job_pages(job_id,page_index)
) STRICT;
CREATE TABLE catalog_import_job_entries (
 job_id TEXT NOT NULL REFERENCES catalog_import_jobs(id),
 kind TEXT NOT NULL CHECK(kind IN ('products','variants','assets','media')),
 item_id TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object' AND length(CAST(payload AS BLOB))<=900000),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 first_page INTEGER NOT NULL,
 legacy_id INTEGER GENERATED ALWAYS AS (CASE WHEN kind IN ('products','variants') THEN json_extract(payload,'$.legacyId') END) STORED,
 slug TEXT GENERATED ALWAYS AS (CASE WHEN kind='products' THEN json_extract(payload,'$.slug') END) STORED,
 sku TEXT GENERATED ALWAYS AS (CASE WHEN kind='variants' THEN json_extract(payload,'$.sku') END) STORED,
 storage_key TEXT GENERATED ALWAYS AS (CASE WHEN kind='assets' THEN json_extract(payload,'$.storageKey') END) STORED,
 checksum TEXT GENERATED ALWAYS AS (CASE WHEN kind='assets' THEN json_extract(payload,'$.checksumSha256') END) STORED,
 PRIMARY KEY(job_id,kind,item_id),
 FOREIGN KEY(job_id,first_page) REFERENCES catalog_import_job_pages(job_id,page_index)
) STRICT;
CREATE UNIQUE INDEX catalog_import_entry_legacy ON catalog_import_job_entries(job_id,kind,legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX catalog_import_entry_slug ON catalog_import_job_entries(job_id,slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX catalog_import_entry_sku ON catalog_import_job_entries(job_id,sku) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX catalog_import_entry_storage ON catalog_import_job_entries(job_id,storage_key) WHERE storage_key IS NOT NULL;
CREATE UNIQUE INDEX catalog_import_entry_checksum ON catalog_import_job_entries(job_id,checksum) WHERE checksum IS NOT NULL;
CREATE TABLE catalog_import_job_identifiers (
 job_id TEXT NOT NULL REFERENCES catalog_import_jobs(id),
 identifier TEXT NOT NULL,
 variant_id TEXT NOT NULL,
 first_page INTEGER NOT NULL,
 PRIMARY KEY(job_id,identifier),
 FOREIGN KEY(job_id,first_page) REFERENCES catalog_import_job_pages(job_id,page_index)
) STRICT;
CREATE TRIGGER catalog_import_job_identifiers_no_update BEFORE UPDATE ON catalog_import_job_identifiers
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_identifiers_no_delete BEFORE DELETE ON catalog_import_job_identifiers
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_identifiers_no_replace BEFORE INSERT ON catalog_import_job_identifiers
WHEN EXISTS(SELECT 1 FROM catalog_import_job_identifiers WHERE job_id=NEW.job_id AND identifier=NEW.identifier)
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TABLE catalog_import_job_seals (
 job_id TEXT PRIMARY KEY REFERENCES catalog_import_jobs(id),
 hash TEXT NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
 counts TEXT NOT NULL CHECK(json_valid(counts) AND json_type(counts)='object'
   AND COALESCE(json_extract(counts,'$.products') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_extract(counts,'$.variants') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_extract(counts,'$.assets') BETWEEN 1 AND 25000,0)
   AND COALESCE(json_extract(counts,'$.mappings') BETWEEN 1 AND 25000,0)),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'') AND expires_at>created_at)
) STRICT;
CREATE TABLE catalog_import_job_guards (
 id TEXT PRIMARY KEY,
 satisfied INTEGER NOT NULL CONSTRAINT import_job_atomic_guard CHECK(satisfied=1)
) STRICT;
CREATE TRIGGER catalog_import_jobs_no_update BEFORE UPDATE ON catalog_import_jobs
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_jobs_no_delete BEFORE DELETE ON catalog_import_jobs
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_jobs_no_replace BEFORE INSERT ON catalog_import_jobs
WHEN EXISTS(SELECT 1 FROM catalog_import_jobs WHERE id=NEW.id OR (actor_id=NEW.actor_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_pages_no_update BEFORE UPDATE ON catalog_import_job_pages
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_pages_no_delete BEFORE DELETE ON catalog_import_job_pages
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_pages_no_replace BEFORE INSERT ON catalog_import_job_pages
WHEN EXISTS(SELECT 1 FROM catalog_import_job_pages WHERE job_id=NEW.job_id AND page_index=NEW.page_index)
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_rows_no_update BEFORE UPDATE ON catalog_import_job_rows
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_rows_no_delete BEFORE DELETE ON catalog_import_job_rows
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_rows_no_replace BEFORE INSERT ON catalog_import_job_rows
WHEN EXISTS(SELECT 1 FROM catalog_import_job_rows WHERE job_id=NEW.job_id AND (row_index=NEW.row_index OR payload_hash=NEW.payload_hash))
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_entries_no_update BEFORE UPDATE ON catalog_import_job_entries
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_entries_no_delete BEFORE DELETE ON catalog_import_job_entries
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_entries_no_replace BEFORE INSERT ON catalog_import_job_entries
WHEN EXISTS(SELECT 1 FROM catalog_import_job_entries WHERE job_id=NEW.job_id AND kind=NEW.kind AND item_id=NEW.item_id)
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_seals_no_update BEFORE UPDATE ON catalog_import_job_seals
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_seals_no_delete BEFORE DELETE ON catalog_import_job_seals
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
CREATE TRIGGER catalog_import_job_seals_no_replace BEFORE INSERT ON catalog_import_job_seals
WHEN EXISTS(SELECT 1 FROM catalog_import_job_seals WHERE job_id=NEW.job_id)
BEGIN SELECT RAISE(ABORT,'import_job_immutable'); END;
