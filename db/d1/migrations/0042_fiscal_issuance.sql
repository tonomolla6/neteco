-- No policy, series, permission grant or provider configuration is seeded.
-- Payment/evaluation is an obligation, never BEP-002 approval. All documents
-- remain distinguishable as synthetic local validation or provider facts.
CREATE TABLE fiscal_issuance_policies (
  id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND length(policy_json) <= 16384),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  provider TEXT NOT NULL CHECK (provider IN ('local_fake','beply')),
  environment TEXT NOT NULL CHECK (environment IN ('local_validation','sandbox','production')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  approved_at TEXT NOT NULL CHECK (approved_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',approved_at),'')),
  CHECK ((provider='local_fake')=(environment='local_validation')),
  CHECK (COALESCE(json_extract(policy_json,'$.provider'),'')=provider
    AND COALESCE(json_extract(policy_json,'$.environment'),'')=environment)
) STRICT;
CREATE TABLE fiscal_policy_withdrawals (
  policy_id TEXT PRIMARY KEY REFERENCES fiscal_issuance_policies(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE fiscal_invoice_intents (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES fiscal_evaluation_inbox(event_id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  fiscal_version INTEGER NOT NULL CHECK (fiscal_version=1),
  kind TEXT NOT NULL CHECK (kind='ordinary'),
  policy_id TEXT NOT NULL REFERENCES fiscal_issuance_policies(id),
  provider TEXT NOT NULL CHECK (provider IN ('local_fake','beply')),
  validation_only INTEGER NOT NULL CHECK (validation_only IN (0,1)),
  contract_json TEXT NOT NULL CHECK (json_valid(contract_json) AND length(contract_json) <= 131072),
  contract_fingerprint TEXT NOT NULL CHECK (length(contract_fingerprint)=64 AND contract_fingerprint NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  amount_gross_cents INTEGER NOT NULL CHECK (amount_gross_cents BETWEEN 1 AND 1000000000),
  currency TEXT NOT NULL CHECK (currency='EUR'),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(order_id,fiscal_version,kind),
  CHECK (validation_only=(provider='local_fake')),
  CHECK (COALESCE(json_extract(contract_json,'$.orderId'),'')=order_id
    AND COALESCE(json_extract(contract_json,'$.policyId'),'')=policy_id
    AND COALESCE(json_extract(contract_json,'$.provider'),'')=provider
    AND COALESCE(json_extract(contract_json,'$.idempotencyKey'),'')=idempotency_key
    AND COALESCE(json_extract(contract_json,'$.totalGrossCents'),-1)=amount_gross_cents
    AND COALESCE(json_extract(contract_json,'$.validationOnly'),-1)=validation_only
    AND COALESCE(json_extract(contract_json,'$.kind'),'')=kind
    AND COALESCE(json_extract(contract_json,'$.fiscalVersion'),-1)=fiscal_version)
) STRICT;
CREATE TABLE fiscal_issuance_work (
  intent_id TEXT PRIMARY KEY REFERENCES fiscal_invoice_intents(id),
  status TEXT NOT NULL CHECK (status IN ('queued','leased','issuing','uncertain','reconciling','completed','manual_review')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  lease_token TEXT,
  lease_until TEXT CHECK (lease_until IS NULL OR lease_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',lease_until),'')),
  available_at TEXT NOT NULL CHECK (available_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',available_at),'')),
  issuing_at TEXT CHECK (issuing_at IS NULL OR issuing_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',issuing_at),'')),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',completed_at),'')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  CHECK ((status IN ('leased','issuing','reconciling') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status NOT IN ('leased','issuing','reconciling') AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK (status NOT IN ('issuing','uncertain','reconciling','completed') OR issuing_at IS NOT NULL),
  CHECK (status<>'completed' OR completed_at IS NOT NULL)
) STRICT;
CREATE INDEX fiscal_issuance_due_idx ON fiscal_issuance_work(status,available_at,intent_id);
CREATE INDEX fiscal_issuance_lease_idx ON fiscal_issuance_work(status,lease_until,intent_id);
CREATE TABLE fiscal_provider_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES fiscal_invoice_intents(id),
  provider TEXT NOT NULL CHECK (provider IN ('local_fake','beply')),
  provider_invoice_id TEXT NOT NULL CHECK (length(provider_invoice_id) BETWEEN 1 AND 200 AND provider_invoice_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
  fiscal_status TEXT NOT NULL CHECK (fiscal_status IN ('issued','fiscal_pending')),
  amount_gross_cents INTEGER NOT NULL CHECK (amount_gross_cents BETWEEN 1 AND 1000000000),
  currency TEXT NOT NULL CHECK (currency='EUR'),
  contract_fingerprint TEXT NOT NULL CHECK (length(contract_fingerprint)=64 AND contract_fingerprint NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL CHECK (recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
  UNIQUE(provider,provider_invoice_id)
) STRICT;
CREATE TABLE fiscal_documents (
  id TEXT PRIMARY KEY REFERENCES fiscal_invoice_intents(id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES fiscal_provider_receipts(intent_id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 300),
  pdf_checksum TEXT NOT NULL CHECK (length(pdf_checksum)=64 AND pdf_checksum NOT GLOB '*[^0-9a-f]*'),
  pdf_size INTEGER NOT NULL CHECK (pdf_size BETWEEN 16 AND 5242880),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE fiscal_issuance_events (
  id TEXT PRIMARY KEY,
  intent_id TEXT REFERENCES fiscal_invoice_intents(id),
  policy_id TEXT REFERENCES fiscal_issuance_policies(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('policy_approved','policy_withdrawn','queued','issuing','uncertain','preparation_blocked','completed','reconciliation_started','reconciled','reconciliation_blocked')),
  actor_id TEXT REFERENCES identities(id),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 200),
  generation INTEGER CHECK (generation IS NULL OR generation BETWEEN 1 AND 9007199254740991),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  CHECK (intent_id IS NOT NULL OR policy_id IS NOT NULL)
) STRICT;
CREATE TABLE fiscal_reconciliation_commands (
  intent_id TEXT NOT NULL REFERENCES fiscal_invoice_intents(id),
  command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','blocked')),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(intent_id,command_key)
) STRICT;
CREATE TABLE fiscal_admin_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('policy_approve','policy_withdraw','invoice_queue')),
  target_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_key)
) STRICT;
-- Guard insert is always deliberately invalid, and used only when a batch's
-- mutation/authorization/fence postcondition is false. Thus D1 rolls back ALL.
CREATE TABLE fiscal_atomic_guards (id INTEGER PRIMARY KEY CHECK (id=1), passed INTEGER NOT NULL CHECK (passed=1)) STRICT;
CREATE TRIGGER fiscal_receipt_contract_guard BEFORE INSERT ON fiscal_provider_receipts
WHEN NOT EXISTS(SELECT 1 FROM fiscal_invoice_intents i WHERE i.id=NEW.intent_id AND i.provider=NEW.provider
  AND i.amount_gross_cents=NEW.amount_gross_cents AND i.currency=NEW.currency AND i.contract_fingerprint=NEW.contract_fingerprint)
BEGIN SELECT RAISE(ABORT,'fiscal_receipt_contract_mismatch'); END;
CREATE TRIGGER fiscal_document_contract_guard BEFORE INSERT ON fiscal_documents
WHEN NEW.id<>NEW.intent_id OR NOT EXISTS(SELECT 1 FROM fiscal_invoice_intents i
  JOIN fiscal_provider_receipts r ON r.intent_id=i.id WHERE i.id=NEW.intent_id AND i.order_id=NEW.order_id)
BEGIN SELECT RAISE(ABORT,'fiscal_document_contract_mismatch'); END;
-- The crash sweeper and fenced failures cannot change the fiscal state without
-- recording its transition in the SAME SQLite/D1 transaction.
CREATE TRIGGER fiscal_work_uncertainty_event AFTER UPDATE OF status ON fiscal_issuance_work
WHEN NEW.status='uncertain' AND OLD.status<>'uncertain'
BEGIN
  INSERT INTO fiscal_issuance_events(id,intent_id,event_type,generation,error_code,created_at)
  VALUES('uncertain:'||NEW.intent_id||':'||NEW.generation,NEW.intent_id,'uncertain',NEW.generation,NEW.last_error_code,
    strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;
CREATE TRIGGER fiscal_work_preparation_block_event AFTER UPDATE OF status ON fiscal_issuance_work
WHEN NEW.status='manual_review' AND OLD.status<>'manual_review'
BEGIN
  INSERT INTO fiscal_issuance_events(id,intent_id,event_type,generation,error_code,created_at)
  VALUES('preparation-blocked:'||NEW.intent_id||':'||NEW.generation,NEW.intent_id,'preparation_blocked',NEW.generation,NEW.last_error_code,
    strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;

-- Persistent fake evidence is local-only and NEVER a Beply acceptance claim.
CREATE TABLE fiscal_fake_customers (external_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE fiscal_fake_invoices (
  external_key TEXT PRIMARY KEY, contract_fingerprint TEXT NOT NULL,
  provider_invoice_id TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  pdf_bytes BLOB NOT NULL CHECK (length(pdf_bytes) BETWEEN 16 AND 5242880)
) STRICT;

CREATE TRIGGER fiscal_policy_no_update BEFORE UPDATE ON fiscal_issuance_policies BEGIN SELECT RAISE(ABORT,'fiscal_policy_immutable'); END;
CREATE TRIGGER fiscal_policy_no_delete BEFORE DELETE ON fiscal_issuance_policies BEGIN SELECT RAISE(ABORT,'fiscal_policy_immutable'); END;
CREATE TRIGGER fiscal_withdrawal_no_update BEFORE UPDATE ON fiscal_policy_withdrawals BEGIN SELECT RAISE(ABORT,'fiscal_withdrawal_immutable'); END;
CREATE TRIGGER fiscal_withdrawal_no_delete BEFORE DELETE ON fiscal_policy_withdrawals BEGIN SELECT RAISE(ABORT,'fiscal_withdrawal_immutable'); END;
CREATE TRIGGER fiscal_intent_no_update BEFORE UPDATE ON fiscal_invoice_intents BEGIN SELECT RAISE(ABORT,'fiscal_intent_immutable'); END;
CREATE TRIGGER fiscal_intent_no_delete BEFORE DELETE ON fiscal_invoice_intents BEGIN SELECT RAISE(ABORT,'fiscal_intent_immutable'); END;
CREATE TRIGGER fiscal_receipt_no_update BEFORE UPDATE ON fiscal_provider_receipts BEGIN SELECT RAISE(ABORT,'fiscal_receipt_immutable'); END;
CREATE TRIGGER fiscal_receipt_no_delete BEFORE DELETE ON fiscal_provider_receipts BEGIN SELECT RAISE(ABORT,'fiscal_receipt_immutable'); END;
CREATE TRIGGER fiscal_document_no_update BEFORE UPDATE ON fiscal_documents BEGIN SELECT RAISE(ABORT,'fiscal_document_immutable'); END;
CREATE TRIGGER fiscal_document_no_delete BEFORE DELETE ON fiscal_documents BEGIN SELECT RAISE(ABORT,'fiscal_document_immutable'); END;
CREATE TRIGGER fiscal_event_no_update BEFORE UPDATE ON fiscal_issuance_events BEGIN SELECT RAISE(ABORT,'fiscal_event_immutable'); END;
CREATE TRIGGER fiscal_event_no_delete BEFORE DELETE ON fiscal_issuance_events BEGIN SELECT RAISE(ABORT,'fiscal_event_immutable'); END;
CREATE TRIGGER fiscal_command_no_update BEFORE UPDATE ON fiscal_reconciliation_commands BEGIN SELECT RAISE(ABORT,'fiscal_command_immutable'); END;
CREATE TRIGGER fiscal_command_no_delete BEFORE DELETE ON fiscal_reconciliation_commands BEGIN SELECT RAISE(ABORT,'fiscal_command_immutable'); END;
CREATE TRIGGER fiscal_admin_command_no_update BEFORE UPDATE ON fiscal_admin_commands BEGIN SELECT RAISE(ABORT,'fiscal_admin_command_immutable'); END;
CREATE TRIGGER fiscal_admin_command_no_delete BEFORE DELETE ON fiscal_admin_commands BEGIN SELECT RAISE(ABORT,'fiscal_admin_command_immutable'); END;
CREATE TRIGGER fiscal_fake_invoice_no_update BEFORE UPDATE ON fiscal_fake_invoices BEGIN SELECT RAISE(ABORT,'fiscal_fake_invoice_immutable'); END;
CREATE TRIGGER fiscal_fake_invoice_no_delete BEFORE DELETE ON fiscal_fake_invoices BEGIN SELECT RAISE(ABORT,'fiscal_fake_invoice_immutable'); END;
CREATE TRIGGER fiscal_fake_customer_no_update BEFORE UPDATE ON fiscal_fake_customers BEGIN SELECT RAISE(ABORT,'fiscal_fake_customer_immutable'); END;
CREATE TRIGGER fiscal_fake_customer_no_delete BEFORE DELETE ON fiscal_fake_customers BEGIN SELECT RAISE(ABORT,'fiscal_fake_customer_immutable'); END;
