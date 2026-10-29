-- Native operational support. No role/grant, service promise, retention policy,
-- customer/order claim, fiscal result or stock mutation is provisioned.
CREATE TABLE support_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  nonce TEXT NOT NULL UNIQUE CHECK(length(nonce)=36),
  actor_key TEXT NOT NULL CHECK(length(actor_key) BETWEEN 3 AND 200),
  actor_id TEXT REFERENCES identities(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('anonymous','customer','admin')),
  ticket_id TEXT NOT NULL CHECK(length(ticket_id)=36),
  public_ref TEXT NOT NULL CHECK(length(public_ref)=28 AND substr(public_ref,1,4)='SOP-' AND substr(public_ref,5) NOT GLOB '*[^0-9A-F]*'),
  action TEXT NOT NULL CHECK(action IN ('created','update','reply','note','call','attachment')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input TEXT NOT NULL CHECK(json_valid(input) AND json_type(input)='object'),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot) AND json_type(snapshot)='object'),
  expected_version INTEGER NOT NULL CHECK(expected_version BETWEEN 0 AND 9007199254740990),
  result_version INTEGER NOT NULL CHECK(result_version=expected_version+1),
  from_state TEXT CHECK(from_state IN ('open','waiting_customer','waiting_provider','resolved','closed')),
  to_state TEXT NOT NULL CHECK(to_state IN ('open','waiting_customer','waiting_provider','resolved','closed')),
  response TEXT NOT NULL CHECK(json_valid(response)
    AND COALESCE(json_extract(response,'$.commandId')=id,0)
    AND COALESCE(json_extract(response,'$.publicRef')=public_ref,0)
    AND COALESCE(json_extract(response,'$.version')=result_version,0)
    AND COALESCE(json_extract(response,'$.state')=to_state,0)
    AND COALESCE(json_extract(response,'$.inventoryEffect')='none',0)
    AND COALESCE(json_extract(response,'$.economicEffect')='none',0)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_key,idempotency_key),UNIQUE(ticket_id,result_version),
  CHECK((actor_type='anonymous' AND actor_id IS NULL AND action='created') OR (actor_type<>'anonymous' AND actor_id IS NOT NULL)),
  CHECK((action='created' AND expected_version=0 AND from_state IS NULL AND to_state='open') OR (action<>'created' AND expected_version>=1 AND from_state IS NOT NULL)),
  CHECK(actor_type='admin' OR action IN ('created','reply','attachment'))
) STRICT;
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY CHECK(length(id)=36),public_ref TEXT NOT NULL UNIQUE,
  customer_id TEXT REFERENCES customers(id),order_id TEXT REFERENCES orders(id),
  category TEXT NOT NULL CHECK(category IN ('product','order','shipping','payment','invoice','return','account','other')),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 5 AND 200),
  requester TEXT NOT NULL CHECK(json_valid(requester)),
  declared_order_reference TEXT,product_slug TEXT,category_slug TEXT,
  state TEXT NOT NULL CHECK(state IN ('open','waiting_customer','waiting_provider','resolved','closed')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  owner_id TEXT REFERENCES identities(id),
  next_action_at TEXT CHECK(next_action_at IS NULL OR next_action_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',next_action_at),'')),
  sla_due_at TEXT CHECK(sla_due_at IS NULL OR sla_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',sla_due_at),'')),
  policy TEXT CHECK(policy IS NULL OR json_valid(policy)),retention_until TEXT,
  version INTEGER NOT NULL CHECK(version>=1),
  last_command_id TEXT NOT NULL UNIQUE REFERENCES support_commands(id),
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL CHECK(updated_at>=created_at),
  CHECK(customer_id IS NOT NULL OR order_id IS NULL)
) STRICT;
CREATE INDEX support_tickets_customer ON support_tickets(customer_id,updated_at DESC,id);
CREATE INDEX support_tickets_queue ON support_tickets(state,priority,next_action_at,updated_at,id);
CREATE TRIGGER support_commands_cas BEFORE INSERT ON support_commands
WHEN (NEW.action='created' AND EXISTS(SELECT 1 FROM support_tickets WHERE id=NEW.ticket_id OR public_ref=NEW.public_ref))
 OR (NEW.action<>'created' AND NOT EXISTS(SELECT 1 FROM support_tickets WHERE id=NEW.ticket_id AND public_ref=NEW.public_ref AND version=NEW.expected_version AND state=NEW.from_state))
BEGIN SELECT RAISE(ABORT,'support_version_conflict'); END;
CREATE TRIGGER support_commands_transition BEFORE INSERT ON support_commands
WHEN NEW.action='update' AND (
 (NEW.from_state='closed' AND NEW.to_state NOT IN ('closed','open'))
 OR (NEW.from_state='resolved' AND NEW.to_state NOT IN ('resolved','open','closed'))
 OR (NEW.from_state IN ('open','waiting_customer','waiting_provider') AND NEW.to_state='closed')
 OR (NEW.to_state IN ('resolved','closed') AND COALESCE(length(trim(json_extract(NEW.input,'$.resolution'))),0)<10))
 OR (NEW.action IN ('note','call','attachment') AND NEW.to_state<>NEW.from_state)
 OR (NEW.action='reply' AND NEW.actor_type='customer' AND (NEW.from_state IN ('resolved','closed') OR NEW.to_state<>'open'))
BEGIN SELECT RAISE(ABORT,'support_invalid_transition'); END;
CREATE TRIGGER support_commands_no_update BEFORE UPDATE ON support_commands
BEGIN SELECT RAISE(ABORT,'support_command_immutable'); END;
CREATE TRIGGER support_commands_no_delete BEFORE DELETE ON support_commands
BEGIN SELECT RAISE(ABORT,'support_command_immutable'); END;
CREATE TRIGGER support_tickets_proof_insert BEFORE INSERT ON support_tickets
WHEN NOT EXISTS(SELECT 1 FROM support_commands c WHERE c.id=NEW.last_command_id AND c.ticket_id=NEW.id
 AND c.public_ref=NEW.public_ref AND c.action='created' AND c.result_version=NEW.version
 AND c.to_state=NEW.state AND c.created_at=NEW.updated_at AND NEW.created_at=NEW.updated_at
 AND json_extract(c.snapshot,'$.priority')=NEW.priority
 AND json_extract(c.snapshot,'$.customerId') IS NEW.customer_id
 AND json_extract(c.snapshot,'$.orderId') IS NEW.order_id)
BEGIN SELECT RAISE(ABORT,'support_projection_invalid'); END;
CREATE TRIGGER support_tickets_proof_update BEFORE UPDATE ON support_tickets
WHEN NEW.id<>OLD.id OR NEW.public_ref<>OLD.public_ref OR NEW.customer_id IS NOT OLD.customer_id
 OR NEW.order_id IS NOT OLD.order_id OR NEW.category<>OLD.category OR NEW.subject<>OLD.subject
 OR NEW.requester<>OLD.requester OR NEW.created_at<>OLD.created_at OR NEW.policy IS NOT OLD.policy
 OR NEW.retention_until IS NOT OLD.retention_until OR NEW.declared_order_reference IS NOT OLD.declared_order_reference
 OR NEW.product_slug IS NOT OLD.product_slug OR NEW.category_slug IS NOT OLD.category_slug
 OR NEW.version<>OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM support_commands c WHERE c.id=NEW.last_command_id AND c.ticket_id=NEW.id
 AND c.expected_version=OLD.version AND c.result_version=NEW.version AND c.from_state=OLD.state
 AND c.to_state=NEW.state AND c.created_at=NEW.updated_at
 AND json_extract(c.snapshot,'$.priority')=NEW.priority
 AND json_extract(c.snapshot,'$.ownerId') IS NEW.owner_id
 AND json_extract(c.snapshot,'$.nextActionAt') IS NEW.next_action_at
 AND json_extract(c.snapshot,'$.slaDueAt') IS NEW.sla_due_at)
BEGIN SELECT RAISE(ABORT,'support_projection_invalid'); END;
CREATE TRIGGER support_tickets_no_delete BEFORE DELETE ON support_tickets
BEGIN SELECT RAISE(ABORT,'support_projection_immutable'); END;
CREATE TABLE support_events (
  id TEXT PRIMARY KEY REFERENCES support_commands(id),ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  actor_type TEXT NOT NULL,actor_id TEXT REFERENCES identities(id),
  type TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')),
  body TEXT CHECK(body IS NULL OR length(body) BETWEEN 1 AND 5000),
  state TEXT NOT NULL,occurred_at TEXT,created_at TEXT NOT NULL,
  UNIQUE(ticket_id,id)
) STRICT;
CREATE INDEX support_events_timeline ON support_events(ticket_id,created_at,id);
CREATE TRIGGER support_events_proof BEFORE INSERT ON support_events
WHEN NOT EXISTS(SELECT 1 FROM support_commands c JOIN support_tickets t ON t.last_command_id=c.id
 WHERE c.id=NEW.id AND c.ticket_id=NEW.ticket_id AND c.actor_type=NEW.actor_type AND c.actor_id IS NEW.actor_id
 AND c.action=NEW.type AND c.to_state=NEW.state AND c.created_at=NEW.created_at)
 OR (NEW.type IN ('note','call') AND NEW.visibility<>'internal')
 OR (NEW.type IN ('created','reply') AND NEW.visibility<>'public')
 OR (NEW.type IN ('created','reply','note','call') AND NOT EXISTS(
   SELECT 1 FROM support_commands c WHERE c.id=NEW.id AND json_extract(c.input,'$.message') IS NEW.body))
BEGIN SELECT RAISE(ABORT,'support_event_invalid'); END;
CREATE TRIGGER support_events_no_update BEFORE UPDATE ON support_events
BEGIN SELECT RAISE(ABORT,'support_event_immutable'); END;
CREATE TRIGGER support_events_no_delete BEFORE DELETE ON support_events
BEGIN SELECT RAISE(ABORT,'support_event_immutable'); END;
CREATE TABLE support_guards(id TEXT PRIMARY KEY,satisfied INTEGER NOT NULL CHECK(satisfied=1)) STRICT;
CREATE TABLE support_intake_limits(
  subject_hash TEXT PRIMARY KEY CHECK(length(subject_hash)=64),used INTEGER NOT NULL CHECK(used>0),expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE support_attachments (
  id TEXT PRIMARY KEY CHECK(length(id)=36),ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  object_key TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL CHECK(length(checksum)=64),
  filename TEXT NOT NULL,mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','application/pdf')),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')),
  state TEXT NOT NULL DEFAULT 'staging' CHECK(state IN ('staging','quarantined')),
  stored_at TEXT,created_at TEXT NOT NULL,command_id TEXT REFERENCES support_commands(id),
  UNIQUE(actor_id,idempotency_key)
) STRICT;
CREATE TRIGGER support_attachments_update BEFORE UPDATE ON support_attachments
WHEN NEW.id<>OLD.id OR NEW.ticket_id<>OLD.ticket_id OR NEW.actor_id<>OLD.actor_id
 OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload_hash<>OLD.payload_hash OR NEW.object_key<>OLD.object_key
 OR NEW.checksum<>OLD.checksum OR NEW.filename<>OLD.filename OR NEW.mime_type<>OLD.mime_type
 OR NEW.byte_size<>OLD.byte_size OR NEW.visibility<>OLD.visibility OR NEW.created_at<>OLD.created_at
 OR OLD.state<>'staging' OR NEW.state<>'quarantined' OR NEW.stored_at IS NULL OR NEW.command_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM support_commands c JOIN support_events e ON e.id=c.id
   WHERE c.id=NEW.command_id AND c.ticket_id=NEW.ticket_id AND c.action='attachment'
     AND json_extract(c.input,'$.attachmentId')=NEW.id AND e.visibility=NEW.visibility)
BEGIN SELECT RAISE(ABORT,'support_attachment_immutable'); END;
CREATE TRIGGER support_attachments_no_delete BEFORE DELETE ON support_attachments
BEGIN SELECT RAISE(ABORT,'support_attachment_immutable'); END;
CREATE TABLE support_attachment_scans (
  id TEXT PRIMARY KEY CHECK(length(id)=36),attachment_id TEXT NOT NULL REFERENCES support_attachments(id),
  checksum TEXT NOT NULL,byte_size INTEGER NOT NULL,verdict TEXT NOT NULL CHECK(verdict IN ('clean','infected')),
  scanner_version TEXT NOT NULL,scanned_at TEXT NOT NULL,expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,received_at TEXT NOT NULL,seq INTEGER NOT NULL UNIQUE
) STRICT;
CREATE TRIGGER support_scans_no_update BEFORE UPDATE ON support_attachment_scans
BEGIN SELECT RAISE(ABORT,'support_scan_immutable'); END;
CREATE TRIGGER support_scans_no_delete BEFORE DELETE ON support_attachment_scans
BEGIN SELECT RAISE(ABORT,'support_scan_immutable'); END;
