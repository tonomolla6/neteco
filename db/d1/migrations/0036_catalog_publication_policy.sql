-- Explicit, reviewed product-type rules; no guessed regulatory defaults or
-- synthetic acceptance are seeded. Records and withdrawals are append-only.
CREATE TABLE catalog_publication_policies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_-]*'),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 160),
  required_fields TEXT NOT NULL CHECK (json_valid(required_fields) AND json_type(required_fields) = 'array' AND json_array_length(required_fields) <= 20),
  required_media_roles TEXT NOT NULL CHECK (json_valid(required_media_roles) AND json_type(required_media_roles) = 'array' AND json_array_length(required_media_roles) <= 6),
  identifier_exceptions_allowed INTEGER NOT NULL CHECK (identifier_exceptions_allowed IN (0,1)),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  valid_from TEXT NOT NULL CHECK (valid_from = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_from), '')),
  valid_until TEXT CHECK (valid_until IS NULL OR (valid_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_until), '') AND valid_until > valid_from)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (code,version)
) STRICT;
CREATE TABLE catalog_publication_policy_withdrawals (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL UNIQUE REFERENCES catalog_publication_policies(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE TABLE catalog_product_publication_policies (
  seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq > 0),
  id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id),
  policy_id TEXT NOT NULL REFERENCES catalog_publication_policies(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX catalog_product_policy_current_idx ON catalog_product_publication_policies(product_id,seq DESC);
CREATE TABLE catalog_variant_identifier_exceptions (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  evidence_reference TEXT NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 3 AND 200),
  valid_from TEXT NOT NULL CHECK (valid_from = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_from), '')),
  valid_until TEXT CHECK (valid_until IS NULL OR (valid_until = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', valid_until), '') AND valid_until > valid_from)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
CREATE INDEX catalog_variant_exception_current_idx ON catalog_variant_identifier_exceptions(variant_id,valid_from DESC,created_at DESC,id DESC);
CREATE TABLE catalog_variant_identifier_exception_withdrawals (
  id TEXT PRIMARY KEY,
  exception_id TEXT NOT NULL UNIQUE REFERENCES catalog_variant_identifier_exceptions(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;
-- REPLACE performs an implicit deletion without DELETE triggers when recursive
-- triggers are disabled. Reject duplicate inserts independently of that pragma.
CREATE TRIGGER catalog_policies_no_replace BEFORE INSERT ON catalog_publication_policies
WHEN EXISTS (SELECT 1 FROM catalog_publication_policies WHERE id=NEW.id OR (code=NEW.code AND version=NEW.version))
BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_policy_withdrawals_no_replace BEFORE INSERT ON catalog_publication_policy_withdrawals
WHEN EXISTS (SELECT 1 FROM catalog_publication_policy_withdrawals WHERE id=NEW.id OR policy_id=NEW.policy_id)
BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_product_policies_no_replace BEFORE INSERT ON catalog_product_publication_policies
WHEN EXISTS (SELECT 1 FROM catalog_product_publication_policies WHERE id=NEW.id OR (NEW.seq>0 AND seq=NEW.seq))
BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_identifier_exceptions_no_replace BEFORE INSERT ON catalog_variant_identifier_exceptions
WHEN EXISTS (SELECT 1 FROM catalog_variant_identifier_exceptions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
CREATE TRIGGER catalog_identifier_withdrawals_no_replace BEFORE INSERT ON catalog_variant_identifier_exception_withdrawals
WHEN EXISTS (SELECT 1 FROM catalog_variant_identifier_exception_withdrawals WHERE id=NEW.id OR exception_id=NEW.exception_id)
BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
CREATE TRIGGER catalog_policies_no_update BEFORE UPDATE ON catalog_publication_policies BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_policies_no_delete BEFORE DELETE ON catalog_publication_policies BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_policy_withdrawals_no_update BEFORE UPDATE ON catalog_publication_policy_withdrawals BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_policy_withdrawals_no_delete BEFORE DELETE ON catalog_publication_policy_withdrawals BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_product_policies_no_update BEFORE UPDATE ON catalog_product_publication_policies BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_product_policies_no_delete BEFORE DELETE ON catalog_product_publication_policies BEGIN SELECT RAISE(ABORT,'catalog_publication_policy_immutable'); END;
CREATE TRIGGER catalog_identifier_exceptions_no_update BEFORE UPDATE ON catalog_variant_identifier_exceptions BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
CREATE TRIGGER catalog_identifier_exceptions_no_delete BEFORE DELETE ON catalog_variant_identifier_exceptions BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
CREATE TRIGGER catalog_identifier_withdrawals_no_update BEFORE UPDATE ON catalog_variant_identifier_exception_withdrawals BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
CREATE TRIGGER catalog_identifier_withdrawals_no_delete BEFORE DELETE ON catalog_variant_identifier_exception_withdrawals BEGIN SELECT RAISE(ABORT,'catalog_identifier_exception_immutable'); END;
