-- COM-015: Orquestación multicanal con prioridades (email, SMS, WhatsApp)
-- COM-016: Centro de notificaciones en cuenta (pedido, factura, stock, soporte)
-- Cloudflare D1 (SQLite) STRICT tables, immutable commands and logs, CAS, audit trail

-- Customer channel preferences for priority order and channel enablement
CREATE TABLE customer_channel_preferences (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  priority_order TEXT NOT NULL CHECK(json_valid(priority_order)),
  email_enabled INTEGER NOT NULL DEFAULT 1 CHECK(email_enabled IN (0,1)),
  sms_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sms_enabled IN (0,1)),
  whatsapp_enabled INTEGER NOT NULL DEFAULT 1 CHECK(whatsapp_enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740990),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  command_id TEXT NOT NULL CHECK(length(command_id)=36)
) STRICT;

-- Versioned, immutable audit log of customer channel preference commands
CREATE TABLE customer_channel_preference_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  applied_version INTEGER NOT NULL CHECK(applied_version=expected_version+1),
  priority_order TEXT NOT NULL CHECK(json_valid(priority_order)),
  email_enabled INTEGER NOT NULL CHECK(email_enabled IN (0,1)),
  sms_enabled INTEGER NOT NULL CHECK(sms_enabled IN (0,1)),
  whatsapp_enabled INTEGER NOT NULL CHECK(whatsapp_enabled IN (0,1)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(customer_id, applied_version)
) STRICT;

CREATE TRIGGER customer_channel_preference_commands_no_update BEFORE UPDATE ON customer_channel_preference_commands
BEGIN SELECT RAISE(ABORT, 'customer_channel_preference_commands_immutable'); END;

CREATE TRIGGER customer_channel_preference_commands_no_delete BEFORE DELETE ON customer_channel_preference_commands
BEGIN SELECT RAISE(ABORT, 'customer_channel_preference_commands_immutable'); END;

-- Multichannel orchestration log: records dispatch cause and results, cross-channel dedup
CREATE TABLE multichannel_orchestration_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  dedup_key TEXT NOT NULL CHECK(length(dedup_key) BETWEEN 1 AND 150),
  category TEXT NOT NULL CHECK(category IN ('pedido','factura','stock','soporte')),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 80),
  selected_channel TEXT CHECK(selected_channel IS NULL OR selected_channel IN ('email','sms','whatsapp')),
  priority_order TEXT NOT NULL CHECK(json_valid(priority_order)),
  status TEXT NOT NULL CHECK(status IN ('delivered','suppressed','fallback','failed','skipped')),
  cause TEXT NOT NULL CHECK(length(cause) BETWEEN 1 AND 120),
  results TEXT NOT NULL CHECK(json_valid(results)),
  mandatory INTEGER NOT NULL DEFAULT 0 CHECK(mandatory IN (0,1)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(customer_id, dedup_key)
) STRICT;

CREATE INDEX idx_multichannel_orchestration_customer ON multichannel_orchestration_commands(customer_id, created_at DESC);
CREATE INDEX idx_multichannel_orchestration_status ON multichannel_orchestration_commands(status, created_at DESC);
CREATE INDEX idx_multichannel_orchestration_category ON multichannel_orchestration_commands(category, created_at DESC);

CREATE TRIGGER multichannel_orchestration_no_update BEFORE UPDATE ON multichannel_orchestration_commands
BEGIN SELECT RAISE(ABORT, 'multichannel_orchestration_immutable'); END;

CREATE TRIGGER multichannel_orchestration_no_delete BEFORE DELETE ON multichannel_orchestration_commands
BEGIN SELECT RAISE(ABORT, 'multichannel_orchestration_immutable'); END;

-- In-account notification center: read/unread notifications by category
-- Non-replacement of mandatory communications is enforced by mandatory flag and audit tracking
CREATE TABLE customer_notifications (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  category TEXT NOT NULL CHECK(category IN ('pedido','factura','stock','soporte')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  link TEXT CHECK(link IS NULL OR length(link) BETWEEN 1 AND 500),
  read_status INTEGER NOT NULL DEFAULT 0 CHECK(read_status IN (0,1)),
  read_at TEXT CHECK(read_at IS NULL OR (length(read_at)=20 AND read_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',read_at),''))),
  mandatory INTEGER NOT NULL DEFAULT 0 CHECK(mandatory IN (0,1)),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)),
  dedup_key TEXT CHECK(dedup_key IS NULL OR length(dedup_key) BETWEEN 1 AND 150),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=20 AND updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;

CREATE INDEX idx_customer_notifications_lookup ON customer_notifications(customer_id, read_status, created_at DESC);
CREATE INDEX idx_customer_notifications_category ON customer_notifications(customer_id, category, created_at DESC);
CREATE UNIQUE INDEX idx_customer_notifications_dedup ON customer_notifications(customer_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- Commands for customer notifications (e.g. mark as read)
CREATE TABLE customer_notification_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  action TEXT NOT NULL CHECK(action IN ('mark_read','mark_all_read')),
  notification_ids TEXT NOT NULL CHECK(json_valid(notification_ids)),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  affected_count INTEGER NOT NULL DEFAULT 0 CHECK(affected_count>=0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;

CREATE TRIGGER customer_notification_commands_no_update BEFORE UPDATE ON customer_notification_commands
BEGIN SELECT RAISE(ABORT, 'customer_notification_commands_immutable'); END;

CREATE TRIGGER customer_notification_commands_no_delete BEFORE DELETE ON customer_notification_commands
BEGIN SELECT RAISE(ABORT, 'customer_notification_commands_immutable'); END;
