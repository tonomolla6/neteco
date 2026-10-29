-- Metadata-only, human-requested PREPARATION recovery. No sender, recipient,
-- provider receipt, new outbox event or attempt-counter reset is introduced.
CREATE TABLE communication_history_commands (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-'
 AND substr(id,19,1)='-' AND substr(id,24,1)='-' AND length(replace(id,'-',''))=32
 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*'),
 actor_id TEXT NOT NULL REFERENCES identities(id),
 session_id TEXT NOT NULL REFERENCES auth_sessions(id),
 session_version INTEGER NOT NULL CHECK(session_version>=1),
 event_id TEXT NOT NULL REFERENCES transactional_email_deliveries(event_id),
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
 input TEXT NOT NULL CHECK(json_valid(input)),
 response TEXT NOT NULL CHECK(json_valid(response)),
 created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
 CHECK(COALESCE(json_extract(input,'$.expectedAttempts') BETWEEN 0 AND 9
 AND json_type(input,'$.expectedAttempts')='integer'
 AND json_extract(input,'$.expectedAvailableAt')=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',json_extract(input,'$.expectedAvailableAt')),'')
 AND length(json_extract(input,'$.reason')) BETWEEN 10 AND 500,0)),
 CHECK(COALESCE(json_extract(response,'$.source')='cloudflare' AND json_extract(response,'$.commandId')=id
 AND json_extract(response,'$.eventId')=event_id AND json_extract(response,'$.payloadHash')=payload_hash
 AND json_extract(response,'$.previousAvailableAt')=json_extract(input,'$.expectedAvailableAt')
 AND json_extract(response,'$.attempts')=json_extract(input,'$.expectedAttempts')
 AND json_extract(response,'$.availableAt')=created_at AND json_extract(response,'$.recordedAt')=created_at
 AND json_type(response,'$.senderInvoked')='false' AND json_type(response,'$.attemptsReset')='false'
 AND json_extract(response,'$.preparation')='retry_requested',0))
) STRICT;
CREATE INDEX communication_history_actor_idx ON communication_history_commands(actor_id,created_at,id);
CREATE TRIGGER communication_history_no_update BEFORE UPDATE ON communication_history_commands
BEGIN SELECT RAISE(ABORT,'communication_history_immutable'); END;
CREATE TRIGGER communication_history_no_delete BEFORE DELETE ON communication_history_commands
BEGIN SELECT RAISE(ABORT,'communication_history_immutable'); END;
CREATE TRIGGER communication_history_guard BEFORE INSERT ON communication_history_commands
WHEN NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 WHERE s.id=NEW.session_id AND i.id=NEW.actor_id AND s.session_version=NEW.session_version
 AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND i.status IN('active','pending') AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND EXISTS(SELECT 1 FROM identity_roles ir JOIN role_permissions rp ON rp.role_code=ir.role_code
 WHERE ir.identity_id=i.id AND rp.permission_code='administration.manage'
 AND ir.granted_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND(ir.expires_at IS NULL OR ir.expires_at>strftime('%Y-%m-%dT%H:%M:%SZ','now'))))
 OR NOT EXISTS(SELECT 1 FROM transactional_email_deliveries d JOIN email_outbox_events e ON e.id=d.event_id
 WHERE d.event_id=NEW.event_id AND d.status='pending' AND d.last_error_code='preparation_failed'
 AND d.attempts=json_extract(NEW.input,'$.expectedAttempts') AND d.attempts<10
 AND d.available_at=json_extract(NEW.input,'$.expectedAvailableAt')
 AND d.lease_token IS NULL AND d.lease_until IS NULL AND d.sending_at IS NULL
 AND d.finished_at IS NULL AND d.provider_message_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM operational_email_suppressions x WHERE x.event_id=e.id)
 AND ((e.source_kind='order' AND e.event_type='order.created' AND e.schema_version=1
 AND EXISTS(SELECT 1 FROM orders o JOIN order_events occurrence ON occurrence.order_id=o.id
 WHERE o.id=e.source_id AND occurrence.id=e.source_event_id AND occurrence.event_type='order.created'
 AND o.currency='EUR' AND o.total_gross_cents>=0 AND o.shipping_gross_cents>=0
 AND length(o.contact_email) BETWEEN 3 AND 254 AND instr(o.contact_email,'@')>1
 AND(SELECT count(*) FROM order_lines l WHERE l.order_id=o.id) BETWEEN 1 AND 100
 AND NOT EXISTS(SELECT 1 FROM order_lines l WHERE l.order_id=o.id AND(l.quantity<1 OR l.gross_cents<0))))
 OR(e.source_kind='support' AND e.schema_version=1 AND e.event_type IN('support.ticket.received','support.ticket.reply')
 AND EXISTS(SELECT 1 FROM support_commands c JOIN support_events s ON s.id=c.id JOIN support_tickets t ON t.id=c.ticket_id
 JOIN support_commands first ON first.ticket_id=t.id AND first.action='created'
 LEFT JOIN identities i ON i.id=first.actor_id LEFT JOIN customers customer ON customer.id=t.customer_id
 WHERE c.id=e.source_event_id AND t.id=e.source_id AND s.ticket_id=t.id AND s.visibility='public' AND s.type=c.action
 AND((e.event_type='support.ticket.received' AND c.action='created')
 OR(e.event_type='support.ticket.reply' AND c.action='reply' AND c.actor_type='admin'))
 AND s.body IS json_extract(c.input,'$.message')
 AND t.retention_until IS NOT NULL AND t.retention_until>strftime('%Y-%m-%dT%H:%M:%SZ','now')
 AND((t.customer_id IS NULL AND length(json_extract(t.requester,'$.email')) BETWEEN 3 AND 254)
 OR(i.customer_id=t.customer_id AND i.status='active' AND i.email_verified_at IS NOT NULL
 AND i.email_verified_at<=strftime('%Y-%m-%dT%H:%M:%SZ','now') AND customer.status='active'))))))
BEGIN SELECT RAISE(ABORT,'communication_preparation_retry_guard'); END;
CREATE TRIGGER communication_history_apply AFTER INSERT ON communication_history_commands
BEGIN
 UPDATE transactional_email_deliveries SET available_at=NEW.created_at WHERE event_id=NEW.event_id;
END;
