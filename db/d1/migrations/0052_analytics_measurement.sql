-- First-party measurement only. No consent, identities, approval policy,
-- provider receipts, capture provenance or permission grants are seeded.
CREATE TABLE analytics_client_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=36 AND substr(event_id,9,1)='-' AND substr(event_id,14,1)='-' AND substr(event_id,19,1)='-' AND substr(event_id,24,1)='-' AND length(replace(event_id,'-',''))=32 AND replace(event_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK(name IN('page_view','catalog_viewed','search_completed','product_viewed','cart_item_added','cart_item_removed','checkout_started','web_vital')),
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 100),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  properties_json TEXT NOT NULL CHECK(json_valid(properties_json) AND json_type(properties_json)='object' AND length(properties_json)<=4096
    AND json_extract(properties_json,'$.query') IS NULL AND json_extract(properties_json,'$.email') IS NULL AND json_extract(properties_json,'$.token') IS NULL
    AND json_extract(properties_json,'$.ip') IS NULL AND json_extract(properties_json,'$.userAgent') IS NULL),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'+0 days'),'')),
  received_at TEXT NOT NULL CHECK(length(received_at)=20 AND received_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',received_at,'+0 days'),'')),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=20 AND expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at,'+0 days'),'') AND expires_at>occurred_at)
) STRICT;
CREATE INDEX analytics_client_period ON analytics_client_events(environment,occurred_at,event_id);
CREATE INDEX analytics_client_expiry ON analytics_client_events(environment,expires_at,event_id);
CREATE TRIGGER analytics_client_no_update BEFORE UPDATE ON analytics_client_events BEGIN SELECT RAISE(ABORT,'analytics_event_immutable'); END;
CREATE TRIGGER analytics_client_no_replace BEFORE INSERT ON analytics_client_events
WHEN EXISTS(SELECT 1 FROM analytics_client_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'analytics_event_key_conflict'); END;
CREATE TRIGGER analytics_client_properties_guard BEFORE INSERT ON analytics_client_events
WHEN EXISTS(SELECT 1 FROM json_each(NEW.properties_json) p WHERE
  (NEW.name='page_view' AND p.key NOT IN('path')) OR
  (NEW.name='catalog_viewed' AND p.key NOT IN('category','page','resultCount')) OR
  (NEW.name='search_completed' AND p.key NOT IN('resultCount')) OR
  (NEW.name='product_viewed' AND p.key NOT IN('productId','variantId')) OR
  (NEW.name IN('cart_item_added','cart_item_removed') AND p.key NOT IN('variantId','quantity','cartVersion')) OR
  (NEW.name='checkout_started' AND p.key NOT IN('itemCount','totalCents')) OR
  (NEW.name='web_vital' AND p.key NOT IN('metric','value','rating','path','navigationType')))
BEGIN SELECT RAISE(ABORT,'analytics_properties_prohibited'); END;

CREATE TABLE analytics_commerce_facts (
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  source_kind TEXT NOT NULL CHECK(source_kind IN('capture_applied','refund_confirmed','fiscal_issued')),
  source_id TEXT NOT NULL CHECK(length(source_id)=36 AND substr(source_id,9,1)='-' AND substr(source_id,14,1)='-' AND substr(source_id,19,1)='-' AND substr(source_id,24,1)='-' AND length(replace(source_id,'-',''))=32 AND replace(source_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL REFERENCES orders(id),
  population TEXT NOT NULL CHECK(population IN('validation','real') AND (population='real')=(environment='production')),
  currency TEXT NOT NULL CHECK(currency='EUR'),
  gross_cents INTEGER NOT NULL CHECK(gross_cents BETWEEN 0 AND 9007199254740991),
  net_cents INTEGER NOT NULL CHECK(net_cents BETWEEN 0 AND 9007199254740991),
  tax_cents INTEGER NOT NULL CHECK(tax_cents BETWEEN 0 AND 9007199254740991),
  shipping_gross_cents INTEGER NOT NULL CHECK(shipping_gross_cents BETWEEN 0 AND gross_cents),
  source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at)=20 AND occurred_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'+0 days'),'')),
  projected_at TEXT NOT NULL CHECK(length(projected_at)=20 AND projected_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',projected_at,'+0 days'),'') AND projected_at>=occurred_at),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=20 AND expires_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',expires_at,'+0 days'),'') AND expires_at>occurred_at),
  PRIMARY KEY(environment,source_kind,source_id),
  CHECK(gross_cents=net_cents+tax_cents)
) STRICT;
CREATE INDEX analytics_fact_period ON analytics_commerce_facts(environment,occurred_at,source_kind,source_id);
CREATE TRIGGER analytics_fact_no_update BEFORE UPDATE ON analytics_commerce_facts BEGIN SELECT RAISE(ABORT,'analytics_fact_immutable'); END;
CREATE TRIGGER analytics_fact_no_delete BEFORE DELETE ON analytics_commerce_facts BEGIN SELECT RAISE(ABORT,'analytics_fact_append_only'); END;
CREATE TRIGGER analytics_fact_no_replace BEFORE INSERT ON analytics_commerce_facts
WHEN EXISTS(SELECT 1 FROM analytics_commerce_facts WHERE environment=NEW.environment AND source_kind=NEW.source_kind AND source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'analytics_fact_no_replacement'); END;

CREATE TABLE analytics_projection_runs (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  examined INTEGER NOT NULL CHECK(examined BETWEEN 0 AND 100),
  projected INTEGER NOT NULL CHECK(projected BETWEEN 0 AND examined),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+0 days'),''))
) STRICT;
CREATE TRIGGER analytics_projection_no_update BEFORE UPDATE ON analytics_projection_runs BEGIN SELECT RAISE(ABORT,'analytics_projection_immutable'); END;
CREATE TRIGGER analytics_projection_no_delete BEFORE DELETE ON analytics_projection_runs BEGIN SELECT RAISE(ABORT,'analytics_projection_immutable'); END;
CREATE TABLE analytics_retention_runs (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
  environment TEXT NOT NULL CHECK(environment IN('local','preview','production')),
  policy_fingerprint TEXT NOT NULL CHECK(length(policy_fingerprint)=64 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*'),
  policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 100),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 80),
  cutoff_at TEXT NOT NULL CHECK(length(cutoff_at)=20 AND cutoff_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',cutoff_at,'+0 days'),'')),
  requested_limit INTEGER NOT NULL CHECK(requested_limit BETWEEN 1 AND 100),
  removed_count INTEGER NOT NULL CHECK(removed_count BETWEEN 0 AND requested_limit),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+0 days'),''))
) STRICT;
CREATE INDEX analytics_retention_budget ON analytics_retention_runs(environment,created_at,id);
CREATE TRIGGER analytics_retention_no_update BEFORE UPDATE ON analytics_retention_runs BEGIN SELECT RAISE(ABORT,'analytics_retention_immutable'); END;
CREATE TRIGGER analytics_retention_no_delete BEFORE DELETE ON analytics_retention_runs BEGIN SELECT RAISE(ABORT,'analytics_retention_immutable'); END;
CREATE TRIGGER analytics_projection_no_replace BEFORE INSERT ON analytics_projection_runs
WHEN EXISTS(SELECT 1 FROM analytics_projection_runs WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'analytics_projection_immutable'); END;
CREATE TRIGGER analytics_retention_no_replace BEFORE INSERT ON analytics_retention_runs
WHEN EXISTS(SELECT 1 FROM analytics_retention_runs WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'analytics_retention_immutable'); END;
CREATE TABLE analytics_atomic_guards(id INTEGER PRIMARY KEY CHECK(id=1),passed INTEGER NOT NULL CHECK(passed=1)) STRICT;

-- The marker is the first provider-authorised order event, never reconstructed
-- from current APP_ENV or backfilled on replay. Recovery capture hashes differ
-- from the original signed notification, so provenance binds to the original
-- authorised payment event. Several contradictory authority events are unknown.
CREATE VIEW analytics_commerce_sources AS
WITH capture_candidates AS (
  SELECT p.*,o.total_net_cents,o.total_tax_cents,o.total_gross_cents,o.shipping_gross_cents,
    e.created_at AS captured_at,e.id AS capture_event_id,
    CASE WHEN p.status='captured' AND e.id IS NOT NULL AND e.order_id=p.order_id
      AND p.amount_gross_cents=o.total_gross_cents AND p.currency=o.currency
      AND EXISTS(SELECT 1 FROM order_payment_states st WHERE st.order_id=p.order_id AND st.active_intent_id=p.id AND st.status='paid' AND st.paid_gross_cents=p.amount_gross_cents)
      AND EXISTS(SELECT 1 FROM payment_fulfilment_claims winner WHERE winner.order_id=p.order_id AND winner.payment_intent_id=p.id)
      AND EXISTS(SELECT 1 FROM payment_recovery_jobs job WHERE job.order_id=p.order_id AND job.payment_intent_id=p.id AND job.status='completed')
      AND EXISTS(SELECT 1 FROM order_events marker WHERE marker.order_id=p.order_id AND marker.event_type='payment_captured'
        AND json_extract(marker.payload_json,'$.intentId')=p.id AND json_extract(marker.payload_json,'$.amountGrossCents')=p.amount_gross_cents)
      THEN 1 ELSE 0 END AS applied_proof
  FROM payment_intents p JOIN orders o ON o.id=p.order_id
  LEFT JOIN payment_events e ON e.payment_intent_id=p.id AND e.order_id=p.order_id AND e.event_type='captured'
    AND e.provider_event_id='intent:'||p.id||':local:captured'
  WHERE p.status='captured' OR EXISTS(SELECT 1 FROM payment_events observed WHERE observed.payment_intent_id=p.id AND observed.event_type='captured')
    OR EXISTS(SELECT 1 FROM order_payment_states observed WHERE observed.order_id=p.order_id AND observed.active_intent_id=p.id AND observed.status='paid')
), capture_authority AS (
  SELECT candidate.id,
    (SELECT count(*) FROM order_events total WHERE total.order_id=candidate.order_id AND total.event_type='payment_provider_authorised'
      AND json_extract(total.payload_json,'$.intentId')=candidate.id) AS event_count,
    count(authority.id) AS proof_count,
    min(json_extract(authority.payload_json,'$.captureSource.bankEnvironment')) AS bank_environment
  FROM capture_candidates candidate
  LEFT JOIN order_events authority ON authority.order_id=candidate.order_id AND authority.event_type='payment_provider_authorised'
    AND json_extract(authority.payload_json,'$.intentId')=candidate.id
    AND json_type(authority.payload_json,'$.captureSource')='object'
    AND json_extract(authority.payload_json,'$.captureSource.schemaVersion')=1
    AND json_type(authority.payload_json,'$.captureSource.schemaVersion')='integer'
    AND json_extract(authority.payload_json,'$.captureSource.provider')='redsys'
    AND json_extract(authority.payload_json,'$.captureSource.bankEnvironment') IN('sandbox','production')
    AND json_extract(authority.payload_json,'$.captureSource.verifiedAt')=authority.created_at
    AND authority.created_at<=candidate.captured_at
    AND length(json_extract(authority.payload_json,'$.captureSource.payloadHash'))=64
    AND json_extract(authority.payload_json,'$.captureSource.payloadHash') NOT GLOB '*[^0-9a-f]*'
    AND length(json_extract(authority.payload_json,'$.captureSource.signatureFingerprint'))=64
    AND json_extract(authority.payload_json,'$.captureSource.signatureFingerprint') NOT GLOB '*[^0-9a-f]*'
    AND (SELECT count(*) FROM json_each(authority.payload_json,'$.captureSource'))=6
    AND EXISTS(SELECT 1 FROM payment_events bank WHERE bank.order_id=candidate.order_id AND bank.payment_intent_id=candidate.id
      AND bank.event_type='provider_authorised' AND bank.payload_hash=json_extract(authority.payload_json,'$.captureSource.payloadHash')
      AND bank.created_at=authority.created_at AND authority.id='order-event:'||bank.provider_event_id||':authorised')
  GROUP BY candidate.id
)
SELECT 'capture_applied' AS source_kind,c.id AS source_id,c.order_id,'EUR' AS currency,
  c.amount_gross_cents AS gross_cents,c.total_net_cents AS net_cents,c.total_tax_cents AS tax_cents,c.shipping_gross_cents,
  COALESCE(c.captured_at,c.updated_at) AS occurred_at,
  CASE WHEN c.applied_proof=1 AND a.event_count=1 AND a.proof_count=1 THEN 1 ELSE 0 END AS proof_valid,
  CASE WHEN a.event_count=1 AND a.proof_count=1 THEN a.bank_environment ELSE 'unknown' END AS provider_environment,
  0 AS validation_only,c.redirect_envelope_hash AS source_fingerprint
FROM capture_candidates c JOIN capture_authority a ON a.id=c.id
UNION ALL
SELECT 'refund_confirmed',c.id,c.order_id,'EUR',c.amount_gross_cents,
  COALESCE((SELECT sum(net_cents) FROM refund_allocations WHERE refund_id=c.id),0),
  COALESCE((SELECT sum(tax_cents) FROM refund_allocations WHERE refund_id=c.id),0),
  COALESCE((SELECT sum(gross_cents) FROM refund_allocations WHERE refund_id=c.id AND component='shipping'),0),
  COALESCE(receipt.recorded_at,w.completed_at,w.submitted_at,c.created_at),
  CASE WHEN w.status='completed' AND receipt.status='succeeded'
    AND json_extract(receipt.receipt_json,'$.contractFingerprint')=c.contract_fingerprint
    AND json_extract(receipt.receipt_json,'$.amountCents')=c.amount_gross_cents
    AND json_extract(receipt.receipt_json,'$.currency')='EUR'
    AND json_extract(receipt.receipt_json,'$.validationOnly')=c.validation_only
    AND c.amount_gross_cents=(SELECT sum(gross_cents) FROM refund_allocations WHERE refund_id=c.id)
    AND EXISTS(SELECT 1 FROM order_events event WHERE event.order_id=c.order_id AND event.event_type='refund.succeeded' AND event.correlation_id=c.id)
    THEN 1 ELSE 0 END,
  COALESCE(json_extract(c.contract_json,'$.environment'),'unknown'),c.validation_only,c.contract_fingerprint
FROM refund_contracts c JOIN refund_work w ON w.refund_id=c.id LEFT JOIN refund_receipts receipt ON receipt.refund_id=c.id AND receipt.status='succeeded'
WHERE w.status='completed' OR receipt.status='succeeded' OR w.submitted_at IS NOT NULL
UNION ALL
SELECT 'fiscal_issued',i.id,i.order_id,'EUR',i.amount_gross_cents,o.total_net_cents,o.total_tax_cents,o.shipping_gross_cents,
  COALESCE(r.recorded_at,w.completed_at,i.created_at),
  CASE WHEN w.status='completed' AND r.fiscal_status='issued' AND d.id IS NOT NULL
    AND r.provider=i.provider AND r.amount_gross_cents=i.amount_gross_cents AND r.currency=i.currency
    AND r.contract_fingerprint=i.contract_fingerprint AND i.amount_gross_cents=o.total_gross_cents
    AND length(d.pdf_checksum)=64 AND d.pdf_checksum NOT GLOB '*[^0-9a-f]*' AND d.pdf_size BETWEEN 16 AND 5242880
    AND d.order_id=i.order_id THEN 1 ELSE 0 END,
  policy.environment,i.validation_only,i.contract_fingerprint
FROM fiscal_invoice_intents i JOIN orders o ON o.id=i.order_id JOIN fiscal_issuance_policies policy ON policy.id=i.policy_id
JOIN fiscal_issuance_work w ON w.intent_id=i.id LEFT JOIN fiscal_provider_receipts r ON r.intent_id=i.id
LEFT JOIN fiscal_documents d ON d.intent_id=i.id
WHERE w.status='completed' OR r.fiscal_status='issued';

CREATE TRIGGER analytics_fact_source_guard BEFORE INSERT ON analytics_commerce_facts
WHEN NOT EXISTS(SELECT 1 FROM analytics_commerce_sources s WHERE s.source_kind=NEW.source_kind AND s.source_id=NEW.source_id
  AND s.order_id=NEW.order_id AND s.currency=NEW.currency AND s.gross_cents=NEW.gross_cents AND s.net_cents=NEW.net_cents
  AND s.tax_cents=NEW.tax_cents AND s.shipping_gross_cents=NEW.shipping_gross_cents AND s.occurred_at=NEW.occurred_at
  AND s.source_fingerprint=NEW.source_fingerprint AND s.proof_valid=1
  AND (NEW.environment<>'production' OR (s.provider_environment='production' AND s.validation_only=0)))
BEGIN SELECT RAISE(ABORT,'analytics_source_unconfirmed'); END;
