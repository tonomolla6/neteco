-- Provider identifiers are opaque references only; card data never enters D1.
-- A removal request disables local use before a provider deletion is attempted.
CREATE TABLE payment_saved_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  provider_token TEXT CHECK(provider_token IS NULL OR length(provider_token) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK(status IN ('active', 'removal_pending', 'removed')),
  version INTEGER NOT NULL CHECK(version >= 1),
  consent_version TEXT NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 100),
  consented_at TEXT NOT NULL CHECK(consented_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',consented_at),'')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  CHECK((status='removed' AND provider_token IS NULL) OR (status<>'removed' AND provider_token IS NOT NULL))
) STRICT;
CREATE INDEX payment_saved_tokens_customer_idx ON payment_saved_tokens(customer_id,status,id);
CREATE TABLE payment_token_commands (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  token_id TEXT NOT NULL REFERENCES payment_saved_tokens(id),
  version INTEGER NOT NULL CHECK(version>=2),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(customer_id,command_id)
) STRICT;
CREATE TABLE payment_token_audit (
  customer_id TEXT NOT NULL, command_id TEXT NOT NULL, token_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action='removal_requested'),
  version INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(customer_id,command_id),
  FOREIGN KEY(customer_id,command_id) REFERENCES payment_token_commands(customer_id,command_id)
) STRICT;
CREATE TABLE payment_token_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE TRIGGER payment_token_audit_no_update BEFORE UPDATE ON payment_token_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_audit_no_delete BEFORE DELETE ON payment_token_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_audit_no_replace BEFORE INSERT ON payment_token_audit
WHEN EXISTS(SELECT 1 FROM payment_token_audit WHERE customer_id=NEW.customer_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_commands_no_update BEFORE UPDATE ON payment_token_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_commands_no_delete BEFORE DELETE ON payment_token_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_commands_no_replace BEFORE INSERT ON payment_token_commands
WHEN EXISTS(SELECT 1 FROM payment_token_commands WHERE customer_id=NEW.customer_id AND command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'append_only'); END;

CREATE TABLE payment_token_provider_audit (
  token_id TEXT PRIMARY KEY REFERENCES payment_saved_tokens(id),
  version INTEGER NOT NULL CHECK(version>=3),
  outcome TEXT NOT NULL CHECK(outcome IN ('deleted','already_deleted')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER payment_token_provider_audit_no_update BEFORE UPDATE ON payment_token_provider_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_provider_audit_no_delete BEFORE DELETE ON payment_token_provider_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_provider_audit_no_replace BEFORE INSERT ON payment_token_provider_audit
WHEN EXISTS(SELECT 1 FROM payment_token_provider_audit WHERE token_id=NEW.token_id)
BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- A bounded, leased retry queue; no provider identifiers are repeated here.
CREATE TABLE payment_token_removal_jobs (
  token_id TEXT PRIMARY KEY REFERENCES payment_saved_tokens(id),
  status TEXT NOT NULL CHECK(status IN ('pending','done')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  due_at TEXT NOT NULL CHECK(due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',due_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE INDEX payment_token_removal_jobs_due ON payment_token_removal_jobs(status,due_at,token_id);
