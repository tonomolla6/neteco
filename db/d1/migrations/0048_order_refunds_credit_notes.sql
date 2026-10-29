-- Financial resolution is separate from immutable capture and RMA custody.
-- No credentials, policies, legal defaults, identities or grants are seeded.
CREATE TABLE financial_policies (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  scope TEXT NOT NULL CHECK(scope IN('refund','credit')),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND length(policy_json)<=16384),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  approved_at TEXT NOT NULL CHECK(approved_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',approved_at),'')),
  CHECK(COALESCE(json_extract(policy_json,'$.provider'),'') IN('local_fake','redsys','beply')),
  CHECK(COALESCE(json_extract(policy_json,'$.environment'),'') IN('local_validation','sandbox','production')),
  CHECK((json_extract(policy_json,'$.provider')='local_fake')=(json_extract(policy_json,'$.environment')='local_validation')),
  CHECK(scope<>'credit' OR COALESCE(json_extract(policy_json,'$.trigger'),'')='after_confirmed_refund')
) STRICT;
CREATE TABLE financial_policy_withdrawals (
  policy_id TEXT PRIMARY KEY REFERENCES financial_policies(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TABLE financial_commands (
  actor_id TEXT NOT NULL REFERENCES identities(id),
  command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN('policy_approve_refund','policy_approve_credit','policy_withdraw','refund_plan','refund_confirm','refund_cancel','refund_reconcile','credit_queue','credit_reconcile')),
  target_id TEXT NOT NULL CHECK(length(target_id)=36),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  response_json TEXT NOT NULL CHECK(json_valid(response_json) AND length(response_json)<=131072),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  PRIMARY KEY(actor_id,command_key)
) STRICT;
CREATE TABLE financial_events (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  scope TEXT NOT NULL CHECK(scope IN('policy','refund','credit')),
  target_id TEXT NOT NULL CHECK(length(target_id)=36),
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 60),
  actor_id TEXT REFERENCES identities(id),
  generation INTEGER CHECK(generation BETWEEN 1 AND 9007199254740991),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  evidence_ref TEXT CHECK(evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE INDEX financial_events_target ON financial_events(scope,target_id,created_at,id);
CREATE TABLE refund_contracts (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  order_id TEXT NOT NULL REFERENCES orders(id),
  payment_intent_id TEXT NOT NULL REFERENCES payment_intents(id),
  return_id TEXT NOT NULL REFERENCES order_returns(id),
  return_version INTEGER NOT NULL CHECK(return_version>=1),
  policy_id TEXT NOT NULL REFERENCES financial_policies(id),
  planned_by TEXT NOT NULL REFERENCES identities(id),
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND length(contract_json)<=131072),
  contract_fingerprint TEXT NOT NULL CHECK(length(contract_fingerprint)=64 AND contract_fingerprint NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  amount_gross_cents INTEGER NOT NULL CHECK(amount_gross_cents BETWEEN 1 AND 1000000000),
  validation_only INTEGER NOT NULL CHECK(validation_only IN(0,1)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  CHECK(COALESCE(json_extract(contract_json,'$.refundId'),'')=id AND COALESCE(json_extract(contract_json,'$.orderId'),'')=order_id
    AND COALESCE(json_extract(contract_json,'$.returnId'),'')=return_id AND COALESCE(json_extract(contract_json,'$.returnVersion'),-1)=return_version
    AND COALESCE(json_extract(contract_json,'$.policyId'),'')=policy_id AND COALESCE(json_extract(contract_json,'$.capture.paymentIntentId'),'')=payment_intent_id
    AND COALESCE(json_extract(contract_json,'$.amountCents'),-1)=amount_gross_cents AND COALESCE(json_extract(contract_json,'$.validationOnly'),-1)=validation_only
    AND COALESCE(json_extract(contract_json,'$.idempotencyKey'),'')=idempotency_key AND COALESCE(json_extract(contract_json,'$.currency'),'')='EUR')
) STRICT;
CREATE INDEX refund_contracts_order ON refund_contracts(order_id,id);
CREATE TRIGGER refund_contract_source BEFORE INSERT ON refund_contracts
WHEN NOT EXISTS(SELECT 1 FROM order_returns r JOIN financial_policies policy ON policy.id=NEW.policy_id AND policy.scope='refund'
 JOIN order_payment_states payment ON payment.order_id=r.order_id JOIN payment_intents intent ON intent.id=payment.active_intent_id
 JOIN payment_fulfilment_claims claim ON claim.order_id=r.order_id AND claim.payment_intent_id=intent.id
 JOIN payment_recovery_jobs recovery ON recovery.payment_intent_id=intent.id AND recovery.status='completed'
 WHERE r.id=NEW.return_id AND r.order_id=NEW.order_id AND r.state='resolution_ready' AND r.version=NEW.return_version
 AND payment.status='paid' AND intent.status='captured' AND intent.id=NEW.payment_intent_id AND intent.order_id=NEW.order_id
 AND payment.paid_gross_cents=intent.amount_gross_cents AND intent.currency='EUR'
 AND intent.merchant_order=json_extract(NEW.contract_json,'$.capture.merchantOrder')
 AND intent.amount_gross_cents=json_extract(NEW.contract_json,'$.capture.capturedCents')
 AND intent.redirect_envelope_hash=json_extract(NEW.contract_json,'$.capture.envelopeHash')
 AND policy.fingerprint=json_extract(NEW.contract_json,'$.policyFingerprint')
 AND json_extract(policy.policy_json,'$.provider')=json_extract(NEW.contract_json,'$.provider')
 AND json_extract(policy.policy_json,'$.environment')=json_extract(NEW.contract_json,'$.environment')
 AND json_extract(policy.policy_json,'$.maximumRefundCents')>=NEW.amount_gross_cents
 AND NOT EXISTS(SELECT 1 FROM financial_policy_withdrawals WHERE policy_id=policy.id)
 AND EXISTS(SELECT 1 FROM payment_events WHERE payment_intent_id=intent.id AND order_id=NEW.order_id AND event_type='captured')
 AND r.version=(SELECT count(*) FROM order_return_commands WHERE return_id=r.id)
 AND r.version=(SELECT count(*) FROM order_return_events WHERE return_id=r.id))
BEGIN SELECT RAISE(ABORT,'refund_source_unconfirmed'); END;
CREATE TABLE refund_work (
  refund_id TEXT PRIMARY KEY REFERENCES refund_contracts(id),
  status TEXT NOT NULL CHECK(status IN('awaiting_confirmation','queued','leased','submitting','pending_provider','uncertain','reconciling','completed','cancelled','manual_review')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  confirmed_by TEXT REFERENCES identities(id),
  confirmed_at TEXT CHECK(confirmed_at IS NULL OR confirmed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',confirmed_at),'')),
  lease_token TEXT,lease_until TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 80),
  CHECK((status IN('leased','submitting','reconciling') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR(status NOT IN('leased','submitting','reconciling') AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(status NOT IN('queued','leased','submitting','pending_provider','uncertain','reconciling','completed') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK(status NOT IN('submitting','pending_provider','uncertain','reconciling','completed') OR submitted_at IS NOT NULL),
  CHECK(status<>'completed' OR completed_at IS NOT NULL),
  CHECK(lease_token IS NULL OR length(lease_token)=36),
  CHECK(lease_until IS NULL OR lease_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',lease_until),'')),
  CHECK(submitted_at IS NULL OR submitted_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',submitted_at),'')),
  CHECK(completed_at IS NULL OR completed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',completed_at),''))
) STRICT;
CREATE INDEX refund_work_due ON refund_work(status,refund_id);
CREATE TRIGGER refund_work_no_resubmit BEFORE UPDATE ON refund_work
WHEN (OLD.submitted_at IS NOT NULL AND (NEW.submitted_at IS NOT OLD.submitted_at OR NEW.status IN('awaiting_confirmation','queued','leased','cancelled')))
 OR (OLD.status IN('completed','cancelled') AND NEW.status<>OLD.status)
 OR NEW.generation<OLD.generation
BEGIN SELECT RAISE(ABORT,'refund_transition_invalid'); END;
CREATE TABLE refund_allocations (
  refund_id TEXT NOT NULL REFERENCES refund_work(refund_id),
  component_index INTEGER NOT NULL CHECK(component_index BETWEEN 0 AND 100),
  component TEXT NOT NULL CHECK(component IN('line','shipping')),
  line_index INTEGER CHECK(line_index BETWEEN 0 AND 99),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
  unit_offset INTEGER NOT NULL CHECK(unit_offset BETWEEN 0 AND 999),
  gross_cents INTEGER NOT NULL CHECK(gross_cents BETWEEN 1 AND 1000000000),
  net_cents INTEGER NOT NULL CHECK(net_cents>=0),tax_cents INTEGER NOT NULL CHECK(tax_cents>=0),
  PRIMARY KEY(refund_id,component_index),
  CHECK(gross_cents=net_cents+tax_cents AND (component='line')=(line_index IS NOT NULL))
) STRICT;
CREATE TRIGGER refund_allocation_contract BEFORE INSERT ON refund_allocations
WHEN NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN json_each(c.contract_json,'$.components') component
 WHERE c.id=NEW.refund_id AND component.key=NEW.component_index
 AND json_extract(component.value,'$.component')=NEW.component AND json_extract(component.value,'$.lineIndex') IS NEW.line_index
 AND json_extract(component.value,'$.quantity')=NEW.quantity AND json_extract(component.value,'$.unitOffset')=NEW.unit_offset
 AND json_extract(component.value,'$.grossCents')=NEW.gross_cents AND json_extract(component.value,'$.netCents')=NEW.net_cents AND json_extract(component.value,'$.taxCents')=NEW.tax_cents)
BEGIN SELECT RAISE(ABORT,'refund_allocation_invalid'); END;
CREATE TRIGGER refund_allocation_capture_budget BEFORE INSERT ON refund_allocations
WHEN (SELECT COALESCE(sum(a.gross_cents),0) FROM refund_allocations a JOIN refund_contracts c ON c.id=a.refund_id
 JOIN refund_work w ON w.refund_id=c.id WHERE c.payment_intent_id=(SELECT payment_intent_id FROM refund_contracts WHERE id=NEW.refund_id) AND w.status<>'cancelled')+NEW.gross_cents>
 (SELECT intent.amount_gross_cents FROM refund_contracts c JOIN payment_intents intent ON intent.id=c.payment_intent_id WHERE c.id=NEW.refund_id)
BEGIN SELECT RAISE(ABORT,'refund_capture_budget_exceeded'); END;
CREATE TRIGGER refund_allocation_line_budget BEFORE INSERT ON refund_allocations
WHEN NEW.component='line' AND (
 NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN order_lines line ON line.order_id=c.order_id AND line.line_index=NEW.line_index
 JOIN order_return_lines returned ON returned.return_id=c.return_id AND returned.line_index=NEW.line_index
 WHERE c.id=NEW.refund_id AND NEW.unit_offset+NEW.quantity<=line.quantity
 AND returned.inspected_quantity>=NEW.quantity+(SELECT COALESCE(sum(a.quantity),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id
 JOIN refund_work work ON work.refund_id=other.id WHERE other.return_id=c.return_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.gross_cents>=NEW.gross_cents+(SELECT COALESCE(sum(a.gross_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.net_cents>=NEW.net_cents+(SELECT COALESCE(sum(a.net_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled')
 AND line.tax_cents>=NEW.tax_cents+(SELECT COALESCE(sum(a.tax_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled'))
 OR EXISTS(SELECT 1 FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work work ON work.refund_id=other.id
 WHERE other.order_id=(SELECT order_id FROM refund_contracts WHERE id=NEW.refund_id) AND a.component='line' AND a.line_index=NEW.line_index AND work.status<>'cancelled'
 AND NEW.unit_offset<a.unit_offset+a.quantity AND a.unit_offset<NEW.unit_offset+NEW.quantity))
BEGIN SELECT RAISE(ABORT,'refund_line_budget_exceeded'); END;
CREATE TRIGGER refund_allocation_shipping_budget BEFORE INSERT ON refund_allocations
WHEN NEW.component='shipping' AND NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN orders o ON o.id=c.order_id JOIN financial_policies p ON p.id=c.policy_id
 WHERE c.id=NEW.refund_id AND json_extract(p.policy_json,'$.shipping')='explicit_amount'
 AND o.shipping_gross_cents>=NEW.gross_cents+(SELECT COALESCE(sum(a.gross_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work w ON w.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='shipping' AND w.status<>'cancelled')
 AND o.shipping_net_cents>=NEW.net_cents+(SELECT COALESCE(sum(a.net_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work w ON w.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='shipping' AND w.status<>'cancelled')
 AND o.shipping_tax_cents>=NEW.tax_cents+(SELECT COALESCE(sum(a.tax_cents),0) FROM refund_allocations a JOIN refund_contracts other ON other.id=a.refund_id JOIN refund_work w ON w.refund_id=other.id WHERE other.order_id=c.order_id AND a.component='shipping' AND w.status<>'cancelled'))
BEGIN SELECT RAISE(ABORT,'refund_shipping_budget_exceeded'); END;
CREATE TABLE refund_receipts (
  refund_id TEXT NOT NULL REFERENCES refund_contracts(id),
  status TEXT NOT NULL CHECK(status IN('pending','succeeded')),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=16384),
  recorded_at TEXT NOT NULL CHECK(recorded_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',recorded_at),'')),
  PRIMARY KEY(refund_id,status)
) STRICT;
CREATE TRIGGER refund_receipt_contract BEFORE INSERT ON refund_receipts
WHEN NOT EXISTS(SELECT 1 FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id WHERE c.id=NEW.refund_id AND w.submitted_at IS NOT NULL
 AND json_extract(NEW.receipt_json,'$.status')=NEW.status AND json_extract(NEW.receipt_json,'$.contractFingerprint')=c.contract_fingerprint
 AND json_extract(NEW.receipt_json,'$.amountCents')=c.amount_gross_cents AND json_extract(NEW.receipt_json,'$.currency')='EUR'
 AND json_extract(NEW.receipt_json,'$.merchantOrder')=json_extract(c.contract_json,'$.capture.merchantOrder')
 AND json_extract(NEW.receipt_json,'$.validationOnly')=c.validation_only)
BEGIN SELECT RAISE(ABORT,'refund_receipt_invalid'); END;
CREATE TABLE refund_credit_obligations (
  refund_id TEXT PRIMARY KEY REFERENCES refund_contracts(id),
  source_event_id TEXT NOT NULL UNIQUE REFERENCES order_events(id),
  status TEXT NOT NULL DEFAULT 'blocked_policy' CHECK(status IN('blocked_policy','blocked_source','queued','completed')),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER refund_obligation_confirmed BEFORE INSERT ON refund_credit_obligations
WHEN NOT EXISTS(SELECT 1 FROM refund_work w JOIN refund_receipts receipt ON receipt.refund_id=w.refund_id AND receipt.status='succeeded'
 JOIN refund_contracts c ON c.id=w.refund_id JOIN order_events event ON event.id=NEW.source_event_id AND event.order_id=c.order_id
 WHERE w.refund_id=NEW.refund_id AND w.status='completed' AND event.event_type='refund.succeeded' AND event.correlation_id=c.id)
BEGIN SELECT RAISE(ABORT,'refund_completion_unconfirmed'); END;
CREATE TABLE fiscal_credit_contracts (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  refund_id TEXT NOT NULL UNIQUE REFERENCES refund_credit_obligations(refund_id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  source_invoice_id TEXT NOT NULL REFERENCES fiscal_invoice_intents(id),
  policy_id TEXT NOT NULL REFERENCES financial_policies(id),
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND length(contract_json)<=262144),
  contract_fingerprint TEXT NOT NULL CHECK(length(contract_fingerprint)=64 AND contract_fingerprint NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_gross_cents INTEGER NOT NULL CHECK(amount_gross_cents BETWEEN 1 AND 1000000000),
  validation_only INTEGER NOT NULL CHECK(validation_only IN(0,1)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  CHECK(COALESCE(json_extract(contract_json,'$.creditId'),'')=id AND COALESCE(json_extract(contract_json,'$.refundId'),'')=refund_id
   AND COALESCE(json_extract(contract_json,'$.orderId'),'')=order_id AND COALESCE(json_extract(contract_json,'$.sourceInvoiceId'),'')=source_invoice_id
   AND COALESCE(json_extract(contract_json,'$.policyId'),'')=policy_id AND COALESCE(json_extract(contract_json,'$.idempotencyKey'),'')=idempotency_key
   AND COALESCE(json_extract(contract_json,'$.amountCents'),-1)=amount_gross_cents AND COALESCE(json_extract(contract_json,'$.validationOnly'),-1)=validation_only
   AND COALESCE(json_extract(contract_json,'$.currency'),'')='EUR' AND COALESCE(json_extract(contract_json,'$.kind'),'')='credit_note')
) STRICT;
CREATE TRIGGER fiscal_credit_source BEFORE INSERT ON fiscal_credit_contracts
WHEN NOT EXISTS(SELECT 1 FROM refund_contracts refund JOIN refund_work work ON work.refund_id=refund.id AND work.status='completed'
 JOIN refund_receipts receipt ON receipt.refund_id=refund.id AND receipt.status='succeeded'
 JOIN fiscal_invoice_intents source ON source.id=NEW.source_invoice_id AND source.order_id=refund.order_id
 JOIN fiscal_issuance_work source_work ON source_work.intent_id=source.id AND source_work.status='completed'
 JOIN fiscal_provider_receipts source_receipt ON source_receipt.intent_id=source.id AND source_receipt.fiscal_status='issued'
 JOIN fiscal_documents document ON document.intent_id=source.id JOIN financial_policies policy ON policy.id=NEW.policy_id AND policy.scope='credit'
 WHERE refund.id=NEW.refund_id AND refund.order_id=NEW.order_id AND refund.amount_gross_cents=NEW.amount_gross_cents
 AND refund.validation_only=NEW.validation_only AND source.validation_only=NEW.validation_only
 AND json_extract(NEW.contract_json,'$.sourceProviderInvoiceId')=source_receipt.provider_invoice_id
 AND json_extract(NEW.contract_json,'$.sourceContractFingerprint')=source.contract_fingerprint
 AND json_extract(NEW.contract_json,'$.sourcePdfChecksum')=document.pdf_checksum
 AND json_extract(NEW.contract_json,'$.sourceContract')=source.contract_json
 AND json_extract(NEW.contract_json,'$.components')=json_extract(refund.contract_json,'$.components')
 AND json_extract(NEW.contract_json,'$.returnId')=refund.return_id
 AND json_extract(NEW.contract_json,'$.provider')=json_extract(policy.policy_json,'$.provider')
 AND json_extract(NEW.contract_json,'$.environment')=json_extract(policy.policy_json,'$.environment')
 AND json_extract(NEW.contract_json,'$.series')=json_extract(policy.policy_json,'$.series')
 AND json_extract(NEW.contract_json,'$.policyFingerprint')=policy.fingerprint
 AND NOT EXISTS(SELECT 1 FROM financial_policy_withdrawals WHERE policy_id=policy.id))
BEGIN SELECT RAISE(ABORT,'fiscal_credit_source_unconfirmed'); END;
CREATE TABLE fiscal_credit_work (
  credit_id TEXT PRIMARY KEY REFERENCES fiscal_credit_contracts(id),
  status TEXT NOT NULL CHECK(status IN('queued','leased','issuing','uncertain','reconciling','completed','manual_review')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  lease_token TEXT,lease_until TEXT,issuing_at TEXT,completed_at TEXT,last_error_code TEXT,
  CHECK((status IN('leased','issuing','reconciling') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR(status NOT IN('leased','issuing','reconciling') AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(status NOT IN('issuing','uncertain','reconciling','completed') OR issuing_at IS NOT NULL),
  CHECK(status<>'completed' OR completed_at IS NOT NULL),
  CHECK(lease_token IS NULL OR length(lease_token)=36),
  CHECK(lease_until IS NULL OR lease_until=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',lease_until),'')),
  CHECK(issuing_at IS NULL OR issuing_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',issuing_at),'')),
  CHECK(completed_at IS NULL OR completed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',completed_at),''))
) STRICT;
CREATE TRIGGER fiscal_credit_no_reissue BEFORE UPDATE ON fiscal_credit_work
WHEN (OLD.issuing_at IS NOT NULL AND (NEW.issuing_at IS NOT OLD.issuing_at OR NEW.status IN('queued','leased')))
 OR (OLD.status='completed' AND NEW.status<>'completed') OR NEW.generation<OLD.generation
BEGIN SELECT RAISE(ABORT,'fiscal_credit_transition_invalid'); END;
CREATE TABLE fiscal_credit_receipts (
  credit_id TEXT PRIMARY KEY REFERENCES fiscal_credit_contracts(id),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=16384),
  provider_invoice_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(provider_invoice_id)
) STRICT;
CREATE TRIGGER fiscal_credit_receipt_contract BEFORE INSERT ON fiscal_credit_receipts
WHEN NOT EXISTS(SELECT 1 FROM fiscal_credit_contracts c JOIN fiscal_credit_work work ON work.credit_id=c.id WHERE c.id=NEW.credit_id AND work.issuing_at IS NOT NULL
 AND json_extract(NEW.receipt_json,'$.documentKind')='credit_note' AND json_extract(NEW.receipt_json,'$.contractFingerprint')=c.contract_fingerprint
 AND json_extract(NEW.receipt_json,'$.amountCents')=c.amount_gross_cents AND json_extract(NEW.receipt_json,'$.currency')='EUR'
 AND json_extract(NEW.receipt_json,'$.sourceProviderInvoiceId')=json_extract(c.contract_json,'$.sourceProviderInvoiceId')
 AND json_extract(NEW.receipt_json,'$.providerId')=NEW.provider_invoice_id AND json_extract(NEW.receipt_json,'$.validationOnly')=c.validation_only)
BEGIN SELECT RAISE(ABORT,'fiscal_credit_receipt_invalid'); END;
CREATE TABLE fiscal_credit_documents (
  credit_id TEXT PRIMARY KEY REFERENCES fiscal_credit_receipts(credit_id),
  storage_key TEXT NOT NULL UNIQUE,pdf_checksum TEXT NOT NULL CHECK(length(pdf_checksum)=64 AND pdf_checksum NOT GLOB '*[^0-9a-f]*'),
  pdf_size INTEGER NOT NULL CHECK(pdf_size BETWEEN 16 AND 5242880),created_at TEXT NOT NULL,
  CHECK(storage_key='fiscal/'||credit_id||'/'||pdf_checksum||'.pdf')
) STRICT;
CREATE TABLE refund_fake_effects(external_key TEXT PRIMARY KEY,contract_fingerprint TEXT NOT NULL,receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))) STRICT;
CREATE TABLE fiscal_fake_credits(external_key TEXT PRIMARY KEY,contract_fingerprint TEXT NOT NULL,provider_invoice_id TEXT NOT NULL UNIQUE,receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),pdf_bytes BLOB NOT NULL CHECK(length(pdf_bytes) BETWEEN 16 AND 5242880)) STRICT;
CREATE TABLE refund_atomic_guards(id INTEGER PRIMARY KEY CHECK(id=1),passed INTEGER NOT NULL CHECK(passed=1)) STRICT;

CREATE TRIGGER financial_policy_no_update BEFORE UPDATE ON financial_policies BEGIN SELECT RAISE(ABORT,'financial_policy_immutable'); END;
CREATE TRIGGER financial_policy_no_delete BEFORE DELETE ON financial_policies BEGIN SELECT RAISE(ABORT,'financial_policy_immutable'); END;
CREATE TRIGGER financial_withdrawal_no_update BEFORE UPDATE ON financial_policy_withdrawals BEGIN SELECT RAISE(ABORT,'financial_policy_immutable'); END;
CREATE TRIGGER financial_withdrawal_no_delete BEFORE DELETE ON financial_policy_withdrawals BEGIN SELECT RAISE(ABORT,'financial_policy_immutable'); END;
CREATE TRIGGER financial_command_no_update BEFORE UPDATE ON financial_commands BEGIN SELECT RAISE(ABORT,'financial_command_immutable'); END;
CREATE TRIGGER financial_command_no_delete BEFORE DELETE ON financial_commands BEGIN SELECT RAISE(ABORT,'financial_command_immutable'); END;
CREATE TRIGGER financial_event_no_update BEFORE UPDATE ON financial_events BEGIN SELECT RAISE(ABORT,'financial_event_immutable'); END;
CREATE TRIGGER financial_event_no_delete BEFORE DELETE ON financial_events BEGIN SELECT RAISE(ABORT,'financial_event_immutable'); END;
CREATE TRIGGER refund_contract_no_update BEFORE UPDATE ON refund_contracts BEGIN SELECT RAISE(ABORT,'refund_contract_immutable'); END;
CREATE TRIGGER refund_contract_no_delete BEFORE DELETE ON refund_contracts BEGIN SELECT RAISE(ABORT,'refund_contract_immutable'); END;
CREATE TRIGGER refund_allocation_no_update BEFORE UPDATE ON refund_allocations BEGIN SELECT RAISE(ABORT,'refund_allocation_immutable'); END;
CREATE TRIGGER refund_allocation_no_delete BEFORE DELETE ON refund_allocations BEGIN SELECT RAISE(ABORT,'refund_allocation_immutable'); END;
CREATE TRIGGER refund_receipt_no_update BEFORE UPDATE ON refund_receipts BEGIN SELECT RAISE(ABORT,'refund_receipt_immutable'); END;
CREATE TRIGGER refund_receipt_no_delete BEFORE DELETE ON refund_receipts BEGIN SELECT RAISE(ABORT,'refund_receipt_immutable'); END;
CREATE TRIGGER credit_contract_no_update BEFORE UPDATE ON fiscal_credit_contracts BEGIN SELECT RAISE(ABORT,'credit_contract_immutable'); END;
CREATE TRIGGER credit_contract_no_delete BEFORE DELETE ON fiscal_credit_contracts BEGIN SELECT RAISE(ABORT,'credit_contract_immutable'); END;
CREATE TRIGGER credit_receipt_no_update BEFORE UPDATE ON fiscal_credit_receipts BEGIN SELECT RAISE(ABORT,'credit_receipt_immutable'); END;
CREATE TRIGGER credit_receipt_no_delete BEFORE DELETE ON fiscal_credit_receipts BEGIN SELECT RAISE(ABORT,'credit_receipt_immutable'); END;
CREATE TRIGGER credit_document_no_update BEFORE UPDATE ON fiscal_credit_documents BEGIN SELECT RAISE(ABORT,'credit_document_immutable'); END;
CREATE TRIGGER credit_document_no_delete BEFORE DELETE ON fiscal_credit_documents BEGIN SELECT RAISE(ABORT,'credit_document_immutable'); END;
CREATE TRIGGER refund_fake_no_update BEFORE UPDATE ON refund_fake_effects BEGIN SELECT RAISE(ABORT,'refund_fake_immutable'); END;
CREATE TRIGGER refund_fake_no_delete BEFORE DELETE ON refund_fake_effects BEGIN SELECT RAISE(ABORT,'refund_fake_immutable'); END;
CREATE TRIGGER credit_fake_no_update BEFORE UPDATE ON fiscal_fake_credits BEGIN SELECT RAISE(ABORT,'credit_fake_immutable'); END;
CREATE TRIGGER credit_fake_no_delete BEFORE DELETE ON fiscal_fake_credits BEGIN SELECT RAISE(ABORT,'credit_fake_immutable'); END;

-- INSERT OR REPLACE cannot silently replace immutable historical evidence.
CREATE TRIGGER financial_policies_no_replacement BEFORE INSERT ON financial_policies
WHEN EXISTS(SELECT 1 FROM financial_policies saved WHERE saved.id=NEW.id AND (saved.id IS NOT NEW.id OR saved.scope IS NOT NEW.scope OR saved.policy_json IS NOT NEW.policy_json OR saved.fingerprint IS NOT NEW.fingerprint OR saved.actor_id IS NOT NEW.actor_id OR saved.approved_at IS NOT NEW.approved_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER financial_policy_withdrawals_no_replacement BEFORE INSERT ON financial_policy_withdrawals
WHEN EXISTS(SELECT 1 FROM financial_policy_withdrawals saved WHERE saved.policy_id=NEW.policy_id AND (saved.policy_id IS NOT NEW.policy_id OR saved.actor_id IS NOT NEW.actor_id OR saved.reason IS NOT NEW.reason OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER financial_commands_no_replacement BEFORE INSERT ON financial_commands
WHEN EXISTS(SELECT 1 FROM financial_commands saved WHERE saved.actor_id=NEW.actor_id AND saved.command_key=NEW.command_key AND (saved.actor_id IS NOT NEW.actor_id OR saved.command_key IS NOT NEW.command_key OR saved.kind IS NOT NEW.kind OR saved.target_id IS NOT NEW.target_id OR saved.payload_hash IS NOT NEW.payload_hash OR saved.response_json IS NOT NEW.response_json OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER financial_events_no_replacement BEFORE INSERT ON financial_events
WHEN EXISTS(SELECT 1 FROM financial_events saved WHERE saved.id=NEW.id AND (saved.id IS NOT NEW.id OR saved.scope IS NOT NEW.scope OR saved.target_id IS NOT NEW.target_id OR saved.event_kind IS NOT NEW.event_kind OR saved.actor_id IS NOT NEW.actor_id OR saved.generation IS NOT NEW.generation OR saved.reason IS NOT NEW.reason OR saved.evidence_ref IS NOT NEW.evidence_ref OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER refund_contracts_no_replacement BEFORE INSERT ON refund_contracts
WHEN EXISTS(SELECT 1 FROM refund_contracts saved WHERE saved.id=NEW.id AND (saved.id IS NOT NEW.id OR saved.order_id IS NOT NEW.order_id OR saved.payment_intent_id IS NOT NEW.payment_intent_id OR saved.return_id IS NOT NEW.return_id OR saved.return_version IS NOT NEW.return_version OR saved.policy_id IS NOT NEW.policy_id OR saved.planned_by IS NOT NEW.planned_by OR saved.contract_json IS NOT NEW.contract_json OR saved.contract_fingerprint IS NOT NEW.contract_fingerprint OR saved.idempotency_key IS NOT NEW.idempotency_key OR saved.amount_gross_cents IS NOT NEW.amount_gross_cents OR saved.validation_only IS NOT NEW.validation_only OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER refund_allocations_no_replacement BEFORE INSERT ON refund_allocations
WHEN EXISTS(SELECT 1 FROM refund_allocations saved WHERE saved.refund_id=NEW.refund_id AND saved.component_index=NEW.component_index AND (saved.refund_id IS NOT NEW.refund_id OR saved.component_index IS NOT NEW.component_index OR saved.component IS NOT NEW.component OR saved.line_index IS NOT NEW.line_index OR saved.quantity IS NOT NEW.quantity OR saved.unit_offset IS NOT NEW.unit_offset OR saved.gross_cents IS NOT NEW.gross_cents OR saved.net_cents IS NOT NEW.net_cents OR saved.tax_cents IS NOT NEW.tax_cents))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER refund_receipts_no_replacement BEFORE INSERT ON refund_receipts
WHEN EXISTS(SELECT 1 FROM refund_receipts saved WHERE saved.refund_id=NEW.refund_id AND saved.status=NEW.status AND (saved.refund_id IS NOT NEW.refund_id OR saved.status IS NOT NEW.status OR saved.receipt_json IS NOT NEW.receipt_json OR saved.recorded_at IS NOT NEW.recorded_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER fiscal_credit_contracts_no_replacement BEFORE INSERT ON fiscal_credit_contracts
WHEN EXISTS(SELECT 1 FROM fiscal_credit_contracts saved WHERE saved.id=NEW.id AND (saved.id IS NOT NEW.id OR saved.refund_id IS NOT NEW.refund_id OR saved.order_id IS NOT NEW.order_id OR saved.source_invoice_id IS NOT NEW.source_invoice_id OR saved.policy_id IS NOT NEW.policy_id OR saved.contract_json IS NOT NEW.contract_json OR saved.contract_fingerprint IS NOT NEW.contract_fingerprint OR saved.idempotency_key IS NOT NEW.idempotency_key OR saved.amount_gross_cents IS NOT NEW.amount_gross_cents OR saved.validation_only IS NOT NEW.validation_only OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER fiscal_credit_receipts_no_replacement BEFORE INSERT ON fiscal_credit_receipts
WHEN EXISTS(SELECT 1 FROM fiscal_credit_receipts saved WHERE saved.credit_id=NEW.credit_id AND (saved.credit_id IS NOT NEW.credit_id OR saved.receipt_json IS NOT NEW.receipt_json OR saved.provider_invoice_id IS NOT NEW.provider_invoice_id OR saved.recorded_at IS NOT NEW.recorded_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER fiscal_credit_documents_no_replacement BEFORE INSERT ON fiscal_credit_documents
WHEN EXISTS(SELECT 1 FROM fiscal_credit_documents saved WHERE saved.credit_id=NEW.credit_id AND (saved.credit_id IS NOT NEW.credit_id OR saved.storage_key IS NOT NEW.storage_key OR saved.pdf_checksum IS NOT NEW.pdf_checksum OR saved.pdf_size IS NOT NEW.pdf_size OR saved.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER refund_fake_effects_no_replacement BEFORE INSERT ON refund_fake_effects
WHEN EXISTS(SELECT 1 FROM refund_fake_effects saved WHERE saved.external_key=NEW.external_key AND (saved.external_key IS NOT NEW.external_key OR saved.contract_fingerprint IS NOT NEW.contract_fingerprint OR saved.receipt_json IS NOT NEW.receipt_json))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;
CREATE TRIGGER fiscal_fake_credits_no_replacement BEFORE INSERT ON fiscal_fake_credits
WHEN EXISTS(SELECT 1 FROM fiscal_fake_credits saved WHERE saved.external_key=NEW.external_key AND (saved.external_key IS NOT NEW.external_key OR saved.contract_fingerprint IS NOT NEW.contract_fingerprint OR saved.provider_invoice_id IS NOT NEW.provider_invoice_id OR saved.receipt_json IS NOT NEW.receipt_json OR saved.pdf_bytes IS NOT NEW.pdf_bytes))
BEGIN SELECT RAISE(ABORT,'financial_evidence_immutable'); END;

CREATE TRIGGER refund_work_no_replacement BEFORE INSERT ON refund_work
WHEN EXISTS(SELECT 1 FROM refund_work WHERE refund_id=NEW.refund_id)
BEGIN SELECT RAISE(ABORT,'refund_work_exists'); END;
CREATE TRIGGER credit_work_no_replacement BEFORE INSERT ON fiscal_credit_work
WHEN EXISTS(SELECT 1 FROM fiscal_credit_work WHERE credit_id=NEW.credit_id)
BEGIN SELECT RAISE(ABORT,'credit_work_exists'); END;
CREATE TRIGGER refund_work_status_audit AFTER UPDATE OF status ON refund_work WHEN OLD.status<>NEW.status
BEGIN INSERT INTO financial_events(id,scope,target_id,event_kind,generation,created_at)
 VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),'refund',NEW.refund_id,'transition_'||NEW.status,NEW.generation,strftime('%Y-%m-%dT%H:%M:%SZ','now')); END;
CREATE TRIGGER credit_work_status_audit AFTER UPDATE OF status ON fiscal_credit_work WHEN OLD.status<>NEW.status
BEGIN INSERT INTO financial_events(id,scope,target_id,event_kind,generation,created_at)
 VALUES(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),'credit',NEW.credit_id,'transition_'||NEW.status,NEW.generation,strftime('%Y-%m-%dT%H:%M:%SZ','now')); END;

CREATE TRIGGER refund_obligation_no_delete BEFORE DELETE ON refund_credit_obligations
BEGIN SELECT RAISE(ABORT,'refund_obligation_durable'); END;
CREATE TRIGGER refund_obligation_no_replacement BEFORE INSERT ON refund_credit_obligations
WHEN EXISTS(SELECT 1 FROM refund_credit_obligations WHERE refund_id=NEW.refund_id)
BEGIN SELECT RAISE(ABORT,'refund_obligation_durable'); END;
CREATE TRIGGER refund_obligation_transition BEFORE UPDATE ON refund_credit_obligations
WHEN NEW.refund_id IS NOT OLD.refund_id OR NEW.source_event_id IS NOT OLD.source_event_id OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.status='completed' AND NEW.status<>'completed') OR(OLD.status='queued' AND NEW.status NOT IN('queued','completed'))
 OR(NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM fiscal_credit_contracts c JOIN fiscal_credit_work w ON w.credit_id=c.id AND w.status='completed'
 JOIN fiscal_credit_documents d ON d.credit_id=c.id JOIN fiscal_credit_receipts r ON r.credit_id=c.id WHERE c.refund_id=NEW.refund_id))
BEGIN SELECT RAISE(ABORT,'refund_obligation_transition_invalid'); END;
CREATE TRIGGER refund_completion_receipt BEFORE UPDATE ON refund_work
WHEN NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM refund_receipts WHERE refund_id=NEW.refund_id AND status='succeeded')
BEGIN SELECT RAISE(ABORT,'refund_receipt_unconfirmed'); END;
CREATE TRIGGER credit_completion_document BEFORE UPDATE ON fiscal_credit_work
WHEN NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM fiscal_credit_receipts r JOIN fiscal_credit_documents d ON d.credit_id=r.credit_id WHERE r.credit_id=NEW.credit_id)
BEGIN SELECT RAISE(ABORT,'credit_document_unconfirmed'); END;
