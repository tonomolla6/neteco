-- Migration: 0102_support_live_chat_and_account_managers.sql
-- SUP-011: Live human support chat with queue, expectation, transcript/consent, and handoff (no bot).
-- SUP-016: Dedicated account manager and commercial CRM per customer (assignment, SLA, notes, opportunities, calendar with permission).

CREATE TABLE support_live_chat_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  public_ref TEXT NOT NULL UNIQUE CHECK (length(public_ref) = 24 AND substr(public_ref, 1, 5) = 'CHAT-'),
  customer_id TEXT REFERENCES customers(id),
  guest_token_hash TEXT CHECK (guest_token_hash IS NULL OR length(guest_token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('waiting_operator', 'in_progress', 'transferred', 'resolved', 'closed', 'escalated_ticket', 'expired_inactivity')),
  department TEXT NOT NULL CHECK (department IN ('general', 'technical', 'logistics', 'sales', 'billing')),
  operator_id TEXT REFERENCES identities(id),
  operator_name TEXT CHECK (operator_name IS NULL OR length(operator_name) BETWEEN 1 AND 120),
  consent_given_at TEXT NOT NULL CHECK (consent_given_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  consent_policy_hash TEXT NOT NULL CHECK (length(consent_policy_hash) = 64),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  closed_at TEXT CHECK (closed_at IS NULL OR closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  closure_reason TEXT,
  ticket_id TEXT REFERENCES support_tickets(id),
  waited_seconds INTEGER CHECK (waited_seconds IS NULL OR waited_seconds >= 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
) STRICT;

CREATE INDEX idx_chat_queue ON support_live_chat_sessions(status, created_at) WHERE status = 'waiting_operator';
CREATE INDEX idx_chat_customer ON support_live_chat_sessions(customer_id, created_at DESC);

CREATE TABLE support_live_chat_messages (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  session_id TEXT NOT NULL REFERENCES support_live_chat_sessions(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'operator', 'system')),
  sender_id TEXT,
  sender_name TEXT NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 120),
  is_human INTEGER NOT NULL CHECK (is_human IN (0, 1)),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  UNIQUE (session_id, sequence),
  CHECK ((sender_type IN ('customer', 'operator') AND is_human = 1) OR (sender_type = 'system' AND is_human = 0))
) STRICT;

CREATE INDEX idx_chat_messages_session ON support_live_chat_messages(session_id, sequence ASC);

CREATE TABLE support_live_chat_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  session_id TEXT NOT NULL REFERENCES support_live_chat_sessions(id),
  actor_id TEXT REFERENCES identities(id),
  action TEXT NOT NULL CHECK (action IN ('request', 'claim', 'message', 'handoff', 'escalate', 'close')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  UNIQUE (session_id, result_version)
) STRICT;

CREATE TRIGGER support_chat_command_immutable_update BEFORE UPDATE ON support_live_chat_commands
BEGIN SELECT RAISE(ABORT, 'support_chat_command_immutable'); END;

CREATE TRIGGER support_chat_command_immutable_delete BEFORE DELETE ON support_live_chat_commands
BEGIN SELECT RAISE(ABORT, 'support_chat_command_immutable'); END;

CREATE TRIGGER support_chat_message_immutable_update BEFORE UPDATE ON support_live_chat_messages
BEGIN SELECT RAISE(ABORT, 'support_chat_message_immutable'); END;

CREATE TRIGGER support_chat_message_immutable_delete BEFORE DELETE ON support_live_chat_messages
BEGIN SELECT RAISE(ABORT, 'support_chat_message_immutable'); END;

-- SUP-016 Customer Account Manager & CRM tables
CREATE TABLE customer_account_managers (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id),
  manager_identity_id TEXT NOT NULL REFERENCES identities(id),
  manager_name TEXT NOT NULL CHECK (length(manager_name) BETWEEN 2 AND 120),
  manager_email TEXT NOT NULL CHECK (length(manager_email) BETWEEN 5 AND 160),
  manager_phone TEXT CHECK (manager_phone IS NULL OR length(manager_phone) BETWEEN 5 AND 40),
  availability_schedule TEXT NOT NULL CHECK (length(availability_schedule) BETWEEN 3 AND 200),
  sla_tier TEXT NOT NULL CHECK (sla_tier IN ('standard', 'priority', 'vip', 'custom')),
  sla_response_hours INTEGER NOT NULL CHECK (sla_response_hours BETWEEN 1 AND 168),
  sla_description TEXT,
  is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  assigned_by TEXT NOT NULL REFERENCES identities(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE TABLE customer_commercial_notes (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  author_id TEXT NOT NULL REFERENCES identities(id),
  category TEXT NOT NULL CHECK (category IN ('commercial', 'credit', 'logistics', 'operations', 'general')),
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('internal_sales', 'admin_only')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 3 AND 4000),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE INDEX idx_commercial_notes_customer ON customer_commercial_notes(customer_id, created_at DESC);

CREATE TABLE customer_opportunities (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  estimated_value_cents INTEGER NOT NULL CHECK (estimated_value_cents >= 0),
  stage TEXT NOT NULL CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  probability_percent INTEGER NOT NULL CHECK (probability_percent BETWEEN 0 AND 100),
  expected_close_date TEXT CHECK (expected_close_date IS NULL OR expected_close_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  assigned_manager_id TEXT REFERENCES identities(id),
  notes TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE INDEX idx_opportunities_customer ON customer_opportunities(customer_id, stage, created_at DESC);

CREATE TABLE customer_calendar_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  manager_identity_id TEXT NOT NULL REFERENCES identities(id),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  scheduled_at TEXT NOT NULL CHECK (scheduled_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  channel TEXT NOT NULL CHECK (channel IN ('phone', 'video', 'in_person')),
  customer_consent_verified INTEGER NOT NULL CHECK (customer_consent_verified = 1),
  consent_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'rescheduled')),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
) STRICT;

CREATE INDEX idx_calendar_events_customer ON customer_calendar_events(customer_id, scheduled_at ASC);

CREATE TABLE customer_account_manager_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('manager', 'opportunity', 'calendar')),
  entity_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK (action IN ('assign', 'unassign', 'create_opp', 'update_opp_stage', 'schedule_event', 'update_event_status')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  UNIQUE (entity_type, entity_id, result_version)
) STRICT;

CREATE TRIGGER customer_am_command_immutable_update BEFORE UPDATE ON customer_account_manager_commands
BEGIN SELECT RAISE(ABORT, 'customer_am_command_immutable'); END;

CREATE TRIGGER customer_am_command_immutable_delete BEFORE DELETE ON customer_account_manager_commands
BEGIN SELECT RAISE(ABORT, 'customer_am_command_immutable'); END;

CREATE TRIGGER customer_note_immutable_update BEFORE UPDATE ON customer_commercial_notes
BEGIN SELECT RAISE(ABORT, 'customer_note_immutable'); END;

CREATE TRIGGER customer_note_immutable_delete BEFORE DELETE ON customer_commercial_notes
BEGIN SELECT RAISE(ABORT, 'customer_note_immutable'); END;
