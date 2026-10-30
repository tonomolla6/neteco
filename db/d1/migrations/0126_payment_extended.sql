-- Provider identifiers are opaque references only; card data never enters D1.
-- A removal request disables local use before a provider deletion is attempted.
CREATE TABLE payment_saved_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  provider_token TEXT CHECK(provider_token IS NULL OR length(provider_token) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK(status IN ('active', 'removal_pending', 'removed')),
  version INTEGER NOT NULL CHECK(version >= 1),
  consent_version TEXT NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 100),
  -- The checkout payment whose signed notification issued this token (NULL only for legacy rows).
  source_intent_id TEXT UNIQUE REFERENCES payment_intents(id),
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

-- Payment links carry no card data; only a customer-authorised command can expose a link.
-- Persist the command before the first external side effect so an interrupted
-- request can be resumed using the same provider idempotency key.
CREATE TABLE paygold_attempts (
  customer_id TEXT NOT NULL REFERENCES customers(id), command_id TEXT NOT NULL,
  quote_id TEXT NOT NULL, quote_version INTEGER NOT NULL CHECK(quote_version>=1),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(customer_id,command_id)
) STRICT;
CREATE TRIGGER paygold_attempts_no_update BEFORE UPDATE ON paygold_attempts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_attempts_no_delete BEFORE DELETE ON paygold_attempts BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_attempts_no_replace BEFORE INSERT ON paygold_attempts WHEN EXISTS(SELECT 1 FROM paygold_attempts WHERE customer_id=NEW.customer_id AND command_id=NEW.command_id OR order_id=NEW.order_id) BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE paygold_commands (
  customer_id TEXT NOT NULL REFERENCES customers(id), command_id TEXT NOT NULL,
  quote_id TEXT NOT NULL, quote_version INTEGER NOT NULL CHECK(quote_version>=1),
  order_id TEXT NOT NULL REFERENCES orders(id), payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048),
  expires_at TEXT NOT NULL CHECK(expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at),'')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(customer_id,command_id), UNIQUE(payment_intent_id)
) STRICT;
CREATE TABLE paygold_audit (
  customer_id TEXT NOT NULL, command_id TEXT NOT NULL, order_id TEXT NOT NULL,
  quote_id TEXT NOT NULL, payment_intent_id TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(customer_id,command_id), FOREIGN KEY(customer_id,command_id) REFERENCES paygold_commands(customer_id,command_id)
) STRICT;
CREATE TABLE paygold_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
CREATE TRIGGER paygold_commands_no_update BEFORE UPDATE ON paygold_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_commands_no_delete BEFORE DELETE ON paygold_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_commands_no_replace BEFORE INSERT ON paygold_commands WHEN EXISTS(SELECT 1 FROM paygold_commands WHERE customer_id=NEW.customer_id AND command_id=NEW.command_id OR payment_intent_id=NEW.payment_intent_id) BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_audit_no_update BEFORE UPDATE ON paygold_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_audit_no_delete BEFORE DELETE ON paygold_audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER paygold_audit_no_replace BEFORE INSERT ON paygold_audit WHEN EXISTS(SELECT 1 FROM paygold_audit WHERE customer_id=NEW.customer_id AND command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- ---------------------------------------------------------------------------
-- PAY-019: which wallet the shopper picked and what the server resolved.
-- The payment itself stays an ordinary Redsys Redirect intent.
CREATE TABLE payment_wallet_selections (
  payment_intent_id TEXT PRIMARY KEY REFERENCES payment_intents(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  requested_method TEXT NOT NULL CHECK(requested_method IN ('apple_pay','google_pay')),
  resolved_method TEXT NOT NULL CHECK(resolved_method IN ('apple_pay','google_pay','redirect')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER payment_wallet_selections_no_update BEFORE UPDATE ON payment_wallet_selections BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_wallet_selections_no_delete BEFORE DELETE ON payment_wallet_selections BEGIN SELECT RAISE(ABORT,'append_only'); END;

-- ---------------------------------------------------------------------------
-- PAY-021: pre-authorisation, only for an explicit, justified administrator request.
CREATE TABLE payment_preauths (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  merchant_order TEXT NOT NULL UNIQUE CHECK(length(merchant_order) BETWEEN 4 AND 12 AND merchant_order NOT GLOB '*[^0-9A-Za-z]*' AND substr(merchant_order,1,4) NOT GLOB '*[^0-9]*'),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('made_to_order','stock_confirmation','assisted_sale','credit_review')),
  justification TEXT NOT NULL CHECK(length(justification) BETWEEN 20 AND 500),
  requested_by TEXT NOT NULL REFERENCES identities(id),
  status TEXT NOT NULL CHECK(status IN ('requested','authorized','capture_pending','cancel_pending','captured','cancelled','expired','failed','stock_exception')),
  version INTEGER NOT NULL CHECK(version>=1),
  provider_reference TEXT CHECK(provider_reference IS NULL OR length(provider_reference)<=100),
  redirect_expires_at TEXT NOT NULL CHECK(redirect_expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',redirect_expires_at),'')),
  authorized_until TEXT CHECK(authorized_until IS NULL OR authorized_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',authorized_until),'')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE UNIQUE INDEX payment_preauths_one_live_per_order ON payment_preauths(order_id)
  WHERE status IN ('requested','authorized','capture_pending','cancel_pending','captured','stock_exception');
CREATE INDEX payment_preauths_due ON payment_preauths(status,authorized_until,id);
CREATE TRIGGER payment_preauths_no_delete BEFORE DELETE ON payment_preauths BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_preauths_transition BEFORE UPDATE ON payment_preauths
WHEN NEW.version<>OLD.version+1 OR NEW.id<>OLD.id OR NEW.order_id<>OLD.order_id OR NEW.merchant_order<>OLD.merchant_order
  OR NEW.amount_cents<>OLD.amount_cents OR NEW.reason_code<>OLD.reason_code OR NEW.justification<>OLD.justification
  OR NEW.requested_by<>OLD.requested_by
  OR (OLD.status||'>'||NEW.status) NOT IN ('requested>authorized','requested>failed','requested>expired','authorized>capture_pending',
     'authorized>cancel_pending','authorized>expired','capture_pending>captured','capture_pending>authorized','capture_pending>stock_exception',
     'cancel_pending>cancelled','expired>cancel_pending')
BEGIN SELECT RAISE(ABORT,'invalid_preauth_transition'); END;
-- A live pre-authorisation owns the order's money: no ordinary payment intent may start.
CREATE TRIGGER payment_intents_block_live_preauth BEFORE INSERT ON payment_intents
WHEN EXISTS(SELECT 1 FROM payment_preauths WHERE order_id=NEW.order_id AND status IN ('requested','authorized','capture_pending','cancel_pending','captured','stock_exception'))
BEGIN SELECT RAISE(ABORT,'order_has_preauthorization'); END;
CREATE TABLE payment_preauth_events (
  preauth_id TEXT NOT NULL REFERENCES payment_preauths(id),
  version INTEGER NOT NULL CHECK(version>=1),
  event TEXT NOT NULL CHECK(length(event) BETWEEN 1 AND 60),
  from_status TEXT, to_status TEXT NOT NULL,
  actor_id TEXT REFERENCES identities(id),
  command_id TEXT,
  response_code TEXT CHECK(response_code IS NULL OR response_code GLOB '[0-9][0-9][0-9][0-9]'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(preauth_id,version)
) STRICT;
CREATE TRIGGER payment_preauth_events_no_update BEFORE UPDATE ON payment_preauth_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_preauth_events_no_delete BEFORE DELETE ON payment_preauth_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE payment_preauth_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  action TEXT NOT NULL CHECK(action IN ('request','capture','cancel')),
  preauth_id TEXT NOT NULL REFERENCES payment_preauths(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  result_version INTEGER NOT NULL CHECK(result_version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER payment_preauth_commands_no_update BEFORE UPDATE ON payment_preauth_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_preauth_commands_no_delete BEFORE DELETE ON payment_preauth_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE payment_preauth_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;

-- ---------------------------------------------------------------------------
-- PAY-022: explicit, revocable, audited consent. Tokens are provider references only.
CREATE TABLE payment_token_consent_requests (
  payment_intent_id TEXT PRIMARY KEY REFERENCES payment_intents(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  command_id TEXT NOT NULL,
  consent_version TEXT NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(customer_id,command_id)
) STRICT;
CREATE TRIGGER payment_token_consent_requests_no_update BEFORE UPDATE ON payment_token_consent_requests BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_consent_requests_no_delete BEFORE DELETE ON payment_token_consent_requests BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE payment_token_consent_events (
  token_id TEXT NOT NULL REFERENCES payment_saved_tokens(id),
  event TEXT NOT NULL CHECK(event IN ('granted','revoked')),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  consent_version TEXT NOT NULL CHECK(length(consent_version) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(token_id,event)
) STRICT;
CREATE TRIGGER payment_token_consent_events_no_update BEFORE UPDATE ON payment_token_consent_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER payment_token_consent_events_no_delete BEFORE DELETE ON payment_token_consent_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE payment_one_click_commands (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  token_id TEXT NOT NULL REFERENCES payment_saved_tokens(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  status TEXT NOT NULL CHECK(status IN ('started','settled','declined')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(customer_id,command_id)
) STRICT;
CREATE TRIGGER payment_one_click_commands_cas BEFORE UPDATE ON payment_one_click_commands
WHEN OLD.status<>'started' OR NEW.status='started' OR NEW.customer_id<>OLD.customer_id OR NEW.command_id<>OLD.command_id
  OR NEW.token_id<>OLD.token_id OR NEW.order_id<>OLD.order_id OR NEW.amount_cents<>OLD.amount_cents OR NEW.payload_hash<>OLD.payload_hash
BEGIN SELECT RAISE(ABORT,'invalid_one_click_transition'); END;
CREATE TRIGGER payment_one_click_commands_no_delete BEFORE DELETE ON payment_one_click_commands BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TABLE payment_one_click_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1)) STRICT;
