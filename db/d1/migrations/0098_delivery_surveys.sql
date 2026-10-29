-- ORD-017: Encuesta postentrega y motivo de contacto.
-- Evaluacion voluntaria de experiencia tras entrega, token de un solo uso con caducidad.
-- Sin bloqueo en devoluciones, reclamaciones o reembolsos. Soporte vinculado sin duplicados.

CREATE TABLE delivery_survey_opt_outs (
  email_hash TEXT PRIMARY KEY CHECK(length(email_hash)=64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT REFERENCES customers(id),
  opted_out_at TEXT NOT NULL CHECK(opted_out_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', opted_out_at), '')),
  reason TEXT NOT NULL CHECK(reason IN ('customer_request', 'unsubscribe_link', 'delivery_updates_disabled'))
) STRICT;

CREATE TABLE delivery_survey_invitations (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  customer_id TEXT REFERENCES customers(id),
  recipient_email TEXT NOT NULL CHECK(length(trim(recipient_email)) BETWEEN 5 AND 255 AND recipient_email LIKE '%@%'),
  customer_segment TEXT NOT NULL CHECK(customer_segment IN ('particular', 'profesional')),
  token TEXT NOT NULL UNIQUE CHECK(length(token) BETWEEN 16 AND 64),
  status TEXT NOT NULL CHECK(status IN ('scheduled', 'suppressed', 'completed', 'expired')),
  suppression_reason TEXT CHECK(suppression_reason IS NULL OR suppression_reason IN ('opt_out', 'delivery_updates_disabled', 'manual_opt_out')),
  scheduled_at TEXT NOT NULL CHECK(scheduled_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_at), '')),
  expires_at TEXT NOT NULL CHECK(expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '') AND expires_at > scheduled_at),
  outbox_event_id TEXT CHECK(outbox_event_id IS NULL OR length(outbox_event_id) = 36),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  CHECK((status = 'suppressed' AND suppression_reason IS NOT NULL) OR (status <> 'suppressed' AND suppression_reason IS NULL))
) STRICT;

CREATE INDEX delivery_survey_invitations_token ON delivery_survey_invitations(token);
CREATE INDEX delivery_survey_invitations_order ON delivery_survey_invitations(order_id);
CREATE INDEX delivery_survey_invitations_status ON delivery_survey_invitations(status, scheduled_at);

CREATE TABLE delivery_survey_responses (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  invitation_id TEXT NOT NULL UNIQUE REFERENCES delivery_survey_invitations(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  arrived_good INTEGER NOT NULL CHECK(arrived_good IN (0, 1)),
  contact_reason TEXT CHECK(contact_reason IS NULL OR contact_reason IN (
    'damaged_product',
    'missing_items',
    'late_delivery',
    'wrong_product',
    'packaging_issue',
    'delivery_agent_issue',
    'billing_issue',
    'product_inquiry',
    'compliment',
    'other'
  )),
  comment TEXT CHECK(comment IS NULL OR (length(comment) <= 1000 AND comment = trim(comment))),
  customer_segment TEXT NOT NULL CHECK(customer_segment IN ('particular', 'profesional')),
  has_problem INTEGER NOT NULL CHECK(has_problem IN (0, 1)),
  support_ticket_id TEXT REFERENCES support_tickets(id),
  support_ticket_public_ref TEXT CHECK(support_ticket_public_ref IS NULL OR (length(support_ticket_public_ref)=28 AND substr(support_ticket_public_ref,1,4)='SOP-')),
  submitted_at TEXT NOT NULL CHECK(submitted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', submitted_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  CHECK(
    (has_problem = 1 AND (arrived_good = 0 OR score <= 2 OR contact_reason IN ('damaged_product', 'missing_items', 'late_delivery', 'wrong_product', 'packaging_issue', 'delivery_agent_issue', 'billing_issue')))
    OR
    (has_problem = 0 AND arrived_good = 1 AND score > 2 AND (contact_reason IS NULL OR contact_reason IN ('product_inquiry', 'compliment', 'other')))
  )
) STRICT;

CREATE INDEX delivery_survey_responses_segment_score ON delivery_survey_responses(customer_segment, score, submitted_at);
CREATE INDEX delivery_survey_responses_reason ON delivery_survey_responses(contact_reason, submitted_at);
CREATE INDEX delivery_survey_responses_order ON delivery_survey_responses(order_id);

CREATE TRIGGER delivery_survey_opt_outs_no_update BEFORE UPDATE ON delivery_survey_opt_outs
BEGIN SELECT RAISE(ABORT, 'delivery_survey_opt_outs_immutable'); END;

CREATE TRIGGER delivery_survey_opt_outs_no_delete BEFORE DELETE ON delivery_survey_opt_outs
BEGIN SELECT RAISE(ABORT, 'delivery_survey_opt_outs_immutable'); END;

CREATE TRIGGER delivery_survey_invitations_no_delete BEFORE DELETE ON delivery_survey_invitations
BEGIN SELECT RAISE(ABORT, 'delivery_survey_invitations_immutable'); END;

CREATE TRIGGER delivery_survey_response_token_guard BEFORE INSERT ON delivery_survey_responses
WHEN NOT EXISTS(
  SELECT 1 FROM delivery_survey_invitations i
  WHERE i.id = NEW.invitation_id
    AND i.order_id = NEW.order_id
    AND i.status = 'scheduled'
    AND i.expires_at >= NEW.submitted_at
)
BEGIN SELECT RAISE(ABORT, 'delivery_survey_token_invalid_or_used'); END;

CREATE TRIGGER delivery_survey_response_apply AFTER INSERT ON delivery_survey_responses
BEGIN
  UPDATE delivery_survey_invitations
  SET status = 'completed', updated_at = NEW.submitted_at
  WHERE id = NEW.invitation_id;
END;

CREATE TRIGGER delivery_survey_responses_no_update BEFORE UPDATE ON delivery_survey_responses
BEGIN SELECT RAISE(ABORT, 'delivery_survey_responses_immutable'); END;

CREATE TRIGGER delivery_survey_responses_no_delete BEFORE DELETE ON delivery_survey_responses
BEGIN SELECT RAISE(ABORT, 'delivery_survey_responses_immutable'); END;
