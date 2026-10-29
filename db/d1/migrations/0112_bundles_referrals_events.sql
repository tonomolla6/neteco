-- MKT-021: Bundles/kits por tarea o sector (componentes, stock agregado, IVA, precio, editable y ahorro vs compra equivalente).
-- MKT-026: Programa de referidos limitado (términos, consentimiento, atribución, fraude y recompensa tras ventana de devolución).
-- MKT-030: Webinars/demos y eventos locales (registro con consentimiento por canal, recordatorios, grabación/subtítulos, preguntas y seguimiento).

-- ============================================================================
-- MKT-021: BUNDLES / KITS
-- ============================================================================

CREATE TABLE bundles (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 2 AND 100 AND slug NOT GLOB '*[^a-z0-9_-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 3 AND 2000),
  sector TEXT NOT NULL CHECK(sector IN ('hosteleria', 'automocion', 'sanitario', 'industrial', 'oficinas', 'colectividades', 'general')),
  task TEXT NOT NULL CHECK(task IN ('desengrase_profundo', 'desinfeccion_superficies', 'lavado_vehiculos', 'lavavajillas_automatico', 'higiene_manos', 'limpieza_general', 'mantenimiento_suelos')),
  bundle_price_cents INTEGER NOT NULL CHECK(bundle_price_cents > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER bundles_no_delete BEFORE DELETE ON bundles
BEGIN SELECT RAISE(ABORT, 'bundle_immutable_delete_forbidden'); END;

CREATE TRIGGER bundles_update_guard BEFORE UPDATE ON bundles
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'bundle_version_conflict'); END;

CREATE TABLE bundle_items (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK(quantity >= 1),
  min_quantity INTEGER NOT NULL DEFAULT 1 CHECK(min_quantity >= 1),
  max_quantity INTEGER NOT NULL DEFAULT 50 CHECK(max_quantity >= min_quantity),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bundle_id, variant_id)
) STRICT;

CREATE TABLE bundle_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_bundle', 'update_bundle', 'archive_bundle')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER bundle_commands_no_update BEFORE UPDATE ON bundle_commands
BEGIN SELECT RAISE(ABORT, 'bundle_command_immutable'); END;

CREATE TRIGGER bundle_commands_no_delete BEFORE DELETE ON bundle_commands
BEGIN SELECT RAISE(ABORT, 'bundle_command_immutable'); END;

-- ============================================================================
-- MKT-026: PROGRAMA DE REFERIDOS
-- ============================================================================

CREATE TABLE referral_policies (
  id TEXT PRIMARY KEY CHECK(id = 'global'),
  version INTEGER NOT NULL CHECK(version >= 1),
  is_active INTEGER NOT NULL CHECK(is_active IN (0, 1)),
  terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 32),
  reward_cents INTEGER NOT NULL CHECK(reward_cents BETWEEN 100 AND 50000),
  referee_discount_cents INTEGER NOT NULL CHECK(referee_discount_cents BETWEEN 100 AND 50000),
  min_order_cents INTEGER NOT NULL CHECK(min_order_cents BETWEEN 500 AND 500000),
  return_window_days INTEGER NOT NULL CHECK(return_window_days BETWEEN 14 AND 60),
  max_referrals_per_advocate INTEGER NOT NULL CHECK(max_referrals_per_advocate BETWEEN 1 AND 50),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL REFERENCES identities(id)
) STRICT;

CREATE TRIGGER referral_policies_no_delete BEFORE DELETE ON referral_policies
BEGIN SELECT RAISE(ABORT, 'referral_policy_immutable_delete_forbidden'); END;

CREATE TRIGGER referral_policies_update_guard BEFORE UPDATE ON referral_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'referral_policy_version_conflict'); END;

CREATE TABLE referral_advocate_enrollments (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  referral_code TEXT NOT NULL UNIQUE CHECK(length(referral_code) BETWEEN 6 AND 32 AND referral_code NOT GLOB '*[^A-Z0-9_-]*'),
  terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 32),
  consented_at TEXT NOT NULL CHECK(consented_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', consented_at), '')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER referral_advocate_enrollments_no_delete BEFORE DELETE ON referral_advocate_enrollments
BEGIN SELECT RAISE(ABORT, 'referral_enrollment_no_delete'); END;

CREATE TRIGGER referral_advocate_enrollments_update_guard BEFORE UPDATE ON referral_advocate_enrollments
WHEN NEW.customer_id IS NOT OLD.customer_id OR NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'referral_enrollment_version_conflict'); END;

CREATE TABLE referral_attributions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  referral_code TEXT NOT NULL,
  advocate_customer_id TEXT NOT NULL REFERENCES customers(id),
  referee_customer_id TEXT NOT NULL REFERENCES customers(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_amount_cents INTEGER NOT NULL CHECK(order_amount_cents > 0),
  order_completed_at TEXT NOT NULL CHECK(order_completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', order_completed_at), '')),
  return_window_ends_at TEXT NOT NULL CHECK(return_window_ends_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', return_window_ends_at), '')),
  status TEXT NOT NULL DEFAULT 'pending_window' CHECK(status IN ('pending_window', 'rewarded', 'rejected', 'clawback')),
  rejection_reason TEXT CHECK(rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 255),
  fraud_check_passed INTEGER NOT NULL CHECK(fraud_check_passed IN (0, 1)),
  fraud_reasons TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(fraud_reasons) AND json_type(fraud_reasons) = 'array'),
  reward_cents INTEGER NOT NULL CHECK(reward_cents >= 0),
  reward_issued_at TEXT CHECK(reward_issued_at IS NULL OR reward_issued_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reward_issued_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(referee_customer_id),
  UNIQUE(order_id)
) STRICT;

CREATE TRIGGER referral_attributions_no_delete BEFORE DELETE ON referral_attributions
BEGIN SELECT RAISE(ABORT, 'referral_attribution_immutable_delete_forbidden'); END;

CREATE TABLE referral_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('update_policy', 'enroll_advocate', 'attribute_referral', 'settle_rewards', 'reject_attribution')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER referral_commands_no_update BEFORE UPDATE ON referral_commands
BEGIN SELECT RAISE(ABORT, 'referral_command_immutable'); END;

CREATE TRIGGER referral_commands_no_delete BEFORE DELETE ON referral_commands
BEGIN SELECT RAISE(ABORT, 'referral_command_immutable'); END;

-- ============================================================================
-- MKT-030: EVENTOS, WEBINARS Y DEMOS LOCALES
-- ============================================================================

CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 2 AND 100 AND slug NOT GLOB '*[^a-z0-9_-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 3 AND 2000),
  type TEXT NOT NULL CHECK(type IN ('webinar', 'demo', 'local_event')),
  sector TEXT NOT NULL CHECK(sector IN ('hosteleria', 'automocion', 'sanitario', 'industrial', 'oficinas', 'colectividades', 'general')),
  location_type TEXT NOT NULL CHECK(location_type IN ('online', 'in_person')),
  location_details TEXT NOT NULL CHECK(length(location_details) BETWEEN 3 AND 500),
  scheduled_at TEXT NOT NULL CHECK(scheduled_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', scheduled_at), '')),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 15 AND 480),
  max_attendees INTEGER NOT NULL CHECK(max_attendees BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'live', 'completed', 'cancelled')),
  recording_url TEXT CHECK(recording_url IS NULL OR length(recording_url) BETWEEN 5 AND 1000),
  subtitles_url TEXT CHECK(subtitles_url IS NULL OR length(subtitles_url) BETWEEN 5 AND 1000),
  recording_duration_seconds INTEGER CHECK(recording_duration_seconds IS NULL OR recording_duration_seconds > 0),
  recording_published_at TEXT CHECK(recording_published_at IS NULL OR recording_published_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', recording_published_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event_immutable_delete_forbidden'); END;

CREATE TRIGGER events_update_guard BEFORE UPDATE ON events
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'event_version_conflict'); END;

CREATE TABLE event_registrations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id),
  attendee_name TEXT NOT NULL CHECK(length(attendee_name) BETWEEN 2 AND 100),
  attendee_email TEXT NOT NULL CHECK(length(attendee_email) BETWEEN 3 AND 150 AND attendee_email LIKE '%@%'),
  attendee_phone TEXT CHECK(attendee_phone IS NULL OR (length(attendee_phone) BETWEEN 5 AND 30)),
  consent_email_reminder INTEGER NOT NULL CHECK(consent_email_reminder IN (0, 1)),
  consent_sms_reminder INTEGER NOT NULL CHECK(consent_sms_reminder IN (0, 1)),
  consent_followup INTEGER NOT NULL CHECK(consent_followup IN (0, 1)),
  consent_terms_version TEXT NOT NULL CHECK(length(consent_terms_version) BETWEEN 1 AND 32),
  consented_at TEXT NOT NULL CHECK(consented_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', consented_at), '')),
  attendance_status TEXT NOT NULL DEFAULT 'registered' CHECK(attendance_status IN ('registered', 'attended', 'no_show', 'cancelled')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(event_id, attendee_email)
) STRICT;

CREATE TRIGGER event_registrations_no_delete BEFORE DELETE ON event_registrations
BEGIN SELECT RAISE(ABORT, 'event_registration_no_delete'); END;

CREATE TABLE event_reminders (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES event_registrations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('email', 'sms')),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('24h_before', '1h_before', 'starting_now')),
  status TEXT NOT NULL CHECK(status IN ('dispatched', 'suppressed_no_consent', 'skipped')),
  dispatched_at TEXT NOT NULL CHECK(dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(registration_id, trigger_type, channel)
) STRICT;

CREATE TRIGGER event_reminders_no_update BEFORE UPDATE ON event_reminders
BEGIN SELECT RAISE(ABORT, 'event_reminder_immutable'); END;

CREATE TRIGGER event_reminders_no_delete BEFORE DELETE ON event_reminders
BEGIN SELECT RAISE(ABORT, 'event_reminder_immutable'); END;

CREATE TABLE event_questions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id),
  author_name TEXT NOT NULL CHECK(length(author_name) BETWEEN 2 AND 100),
  question_text TEXT NOT NULL CHECK(length(question_text) BETWEEN 5 AND 1000),
  answer_text TEXT CHECK(answer_text IS NULL OR length(answer_text) BETWEEN 1 AND 2000),
  answered_by TEXT REFERENCES identities(id),
  answered_at TEXT CHECK(answered_at IS NULL OR answered_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', answered_at), '')),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK(is_public IN (0, 1)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE TRIGGER event_questions_no_delete BEFORE DELETE ON event_questions
BEGIN SELECT RAISE(ABORT, 'event_question_no_delete'); END;

CREATE TABLE event_followups (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES event_registrations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK(channel = 'email'),
  summary_notes TEXT NOT NULL CHECK(length(summary_notes) BETWEEN 5 AND 2000),
  recording_included INTEGER NOT NULL CHECK(recording_included IN (0, 1)),
  technical_sheets_included INTEGER NOT NULL CHECK(technical_sheets_included IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('dispatched', 'suppressed_no_consent')),
  dispatched_at TEXT NOT NULL CHECK(dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(registration_id, event_id)
) STRICT;

CREATE TRIGGER event_followups_no_update BEFORE UPDATE ON event_followups
BEGIN SELECT RAISE(ABORT, 'event_followup_immutable'); END;

CREATE TRIGGER event_followups_no_delete BEFORE DELETE ON event_followups
BEGIN SELECT RAISE(ABORT, 'event_followup_immutable'); END;

CREATE TABLE event_commands (
  command_id TEXT PRIMARY KEY CHECK(length(command_id) = 36 AND replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('create_event', 'update_event', 'publish_recording', 'register_attendee', 'dispatch_reminder', 'submit_question', 'answer_question', 'dispatch_followup', 'cancel_event')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
  applied_version INTEGER NOT NULL CHECK(applied_version >= 1),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(actor_id, idempotency_key)
) STRICT;

CREATE TRIGGER event_commands_no_update BEFORE UPDATE ON event_commands
BEGIN SELECT RAISE(ABORT, 'event_command_immutable'); END;

CREATE TRIGGER event_commands_no_delete BEFORE DELETE ON event_commands
BEGIN SELECT RAISE(ABORT, 'event_command_immutable'); END;
