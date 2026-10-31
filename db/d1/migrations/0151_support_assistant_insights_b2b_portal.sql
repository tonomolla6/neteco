-- Migration: 0151_support_assistant_insights_b2b_portal.sql
-- SUP-012 limited FAQ assistant (approved knowledge only, citations, human handoff)
-- SUP-014 contact-rate analysis with root-cause taxonomy feeding a backlog
-- SUP-015 repeated questions -> reviewed education content -> measured deflection
-- SUP-017 B2B requests portal (quote, product onboarding, documentation, credit, claim) with status/SLA.
-- No provider, price, credit decision or SLA promise is seeded: SLA hours are stored per request when created.

CREATE TABLE support_insight_commands (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  scope TEXT NOT NULL CHECK(scope IN ('faq_handoff','contact_classify','contact_backlog','education','b2b_request','b2b_admin')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  subject_id TEXT NOT NULL CHECK(length(subject_id)=36),
  receipt TEXT NOT NULL CHECK(json_valid(receipt) AND json_type(receipt)='object'),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(actor_id,idempotency_key)
) STRICT;
CREATE TRIGGER support_insight_commands_no_update BEFORE UPDATE ON support_insight_commands BEGIN SELECT RAISE(ABORT,'support_insight_commands_immutable'); END;
CREATE TRIGGER support_insight_commands_no_delete BEFORE DELETE ON support_insight_commands BEGIN SELECT RAISE(ABORT,'support_insight_commands_immutable'); END;

-- ===== SUP-012 / SUP-015 assistant turns =====
CREATE TABLE support_faq_turns (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  idempotency_hash TEXT NOT NULL UNIQUE CHECK(length(idempotency_hash)=64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  customer_id TEXT REFERENCES customers(id),
  question TEXT NOT NULL CHECK(length(question) BETWEEN 3 AND 300),
  category TEXT CHECK(category IS NULL OR category IN ('envios','pagos','facturas','devoluciones','cuenta','productos','seguridad')),
  outcome TEXT NOT NULL CHECK(outcome IN ('answered','uncertain','handoff_required')),
  reason TEXT NOT NULL CHECK(reason IN ('grounded','no_match','low_confidence','chemical_safety','emergency','knowledge_unavailable')),
  confidence_bp INTEGER NOT NULL CHECK(confidence_bp BETWEEN 0 AND 10000),
  sources TEXT NOT NULL CHECK(json_valid(sources) AND json_type(sources)='array'),
  answer TEXT CHECK(answer IS NULL OR length(answer) BETWEEN 1 AND 1200),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  CHECK((outcome='answered')=(answer IS NOT NULL AND json_array_length(sources)>=1))
) STRICT;
CREATE INDEX support_faq_turns_outcome ON support_faq_turns(outcome,created_at);
CREATE TRIGGER support_faq_turns_no_update BEFORE UPDATE ON support_faq_turns BEGIN SELECT RAISE(ABORT,'support_faq_turns_immutable'); END;
CREATE TRIGGER support_faq_turns_no_delete BEFORE DELETE ON support_faq_turns BEGIN SELECT RAISE(ABORT,'support_faq_turns_immutable'); END;

CREATE TABLE support_faq_feedback (
  turn_id TEXT PRIMARY KEY REFERENCES support_faq_turns(id),
  helpful INTEGER NOT NULL CHECK(helpful IN (0,1)),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER support_faq_feedback_no_update BEFORE UPDATE ON support_faq_feedback BEGIN SELECT RAISE(ABORT,'support_faq_feedback_immutable'); END;
CREATE TRIGGER support_faq_feedback_no_delete BEFORE DELETE ON support_faq_feedback BEGIN SELECT RAISE(ABORT,'support_faq_feedback_immutable'); END;

CREATE TABLE support_faq_handoffs (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  turn_id TEXT NOT NULL UNIQUE REFERENCES support_faq_turns(id),
  customer_id TEXT REFERENCES customers(id),
  contact_email TEXT CHECK(contact_email IS NULL OR (length(contact_email) BETWEEN 6 AND 254 AND contact_email LIKE '%_@_%.__%')),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  status TEXT NOT NULL CHECK(status IN ('open','claimed','resolved')),
  owner_id TEXT REFERENCES identities(id),
  sla_due_at TEXT NOT NULL CHECK(sla_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',sla_due_at),'')),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')) CHECK(updated_at>=created_at),
  resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',resolved_at),'')),
  CHECK(customer_id IS NOT NULL OR contact_email IS NOT NULL),
  CHECK((status='open')=(owner_id IS NULL)),
  CHECK((status='resolved')=(resolved_at IS NOT NULL))
) STRICT;
CREATE INDEX support_faq_handoffs_queue ON support_faq_handoffs(status,sla_due_at,id);
CREATE TRIGGER support_faq_handoffs_no_delete BEFORE DELETE ON support_faq_handoffs BEGIN SELECT RAISE(ABORT,'support_faq_handoffs_immutable'); END;

-- ===== SUP-015 education pipeline =====
CREATE TABLE support_education_candidates (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  cluster_key TEXT NOT NULL UNIQUE CHECK(length(cluster_key)=64),
  sample_question TEXT NOT NULL CHECK(length(sample_question) BETWEEN 3 AND 300),
  rep_tokens TEXT NOT NULL CHECK(json_valid(rep_tokens) AND json_type(rep_tokens)='array' AND json_array_length(rep_tokens) BETWEEN 1 AND 30),
  occurrences INTEGER NOT NULL CHECK(occurrences>=1),
  first_seen_at TEXT NOT NULL CHECK(first_seen_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',first_seen_at),'')),
  last_seen_at TEXT NOT NULL CHECK(last_seen_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',last_seen_at),'')),
  status TEXT NOT NULL CHECK(status IN ('detected','in_review','approved','published','rejected')),
  target_kind TEXT CHECK(target_kind IS NULL OR target_kind IN ('faq','guide','pdp')),
  target_page_id TEXT CHECK(target_page_id IS NULL OR length(target_page_id)=36),
  target_product_slug TEXT CHECK(target_product_slug IS NULL OR length(target_product_slug) BETWEEN 1 AND 160),
  reviewer_id TEXT REFERENCES identities(id),
  review_notes TEXT CHECK(review_notes IS NULL OR length(trim(review_notes)) BETWEEN 10 AND 2000),
  safety_reviewed INTEGER NOT NULL DEFAULT 0 CHECK(safety_reviewed IN (0,1)),
  reviewed_at TEXT CHECK(reviewed_at IS NULL OR reviewed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',reviewed_at),'')),
  published_at TEXT CHECK(published_at IS NULL OR published_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',published_at),'')),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  CHECK(status IN ('detected','in_review') OR reviewer_id IS NOT NULL),
  CHECK(status NOT IN ('approved','published') OR (review_notes IS NOT NULL AND target_kind IS NOT NULL)),
  CHECK((status='published')=(published_at IS NOT NULL))
) STRICT;
CREATE INDEX support_education_candidates_queue ON support_education_candidates(status,occurrences DESC,id);
CREATE TABLE support_education_events (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  candidate_id TEXT NOT NULL REFERENCES support_education_candidates(id),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('start_review','approve','reject','publish')),
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK(result_version>=2),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(candidate_id,result_version)
) STRICT;
CREATE TRIGGER support_education_events_no_update BEFORE UPDATE ON support_education_events BEGIN SELECT RAISE(ABORT,'support_education_events_immutable'); END;
CREATE TRIGGER support_education_events_no_delete BEFORE DELETE ON support_education_events BEGIN SELECT RAISE(ABORT,'support_education_events_immutable'); END;

-- ===== SUP-014 contact analysis =====
CREATE TABLE support_contact_classifications (
  ticket_id TEXT PRIMARY KEY REFERENCES support_tickets(id),
  root_cause TEXT NOT NULL CHECK(root_cause IN ('delivery_delay','transit_damage','wrong_item','missing_item','stock_unavailable','product_information','safety_usage_question','payment_issue','invoice_issue','return_process','account_access','other')),
  classified_by TEXT NOT NULL REFERENCES identities(id),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),''))
) STRICT;
CREATE TABLE support_contact_backlog_items (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  dimension TEXT NOT NULL CHECK(dimension IN ('order','product','carrier','category','root_cause')),
  dimension_key TEXT NOT NULL CHECK(length(dimension_key) BETWEEN 1 AND 160),
  root_cause TEXT NOT NULL CHECK(root_cause IN ('delivery_delay','transit_damage','wrong_item','missing_item','stock_unavailable','product_information','safety_usage_question','payment_issue','invoice_issue','return_process','account_access','other','unclassified')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 5 AND 200),
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='object'),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
  status TEXT NOT NULL CHECK(status IN ('open','planned','done','dismissed')),
  rca_id TEXT REFERENCES support_operational_rcas(id),
  window_from TEXT NOT NULL CHECK(window_from=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',window_from),'')),
  window_to TEXT NOT NULL CHECK(window_to=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',window_to),'')) CHECK(window_to>window_from),
  version INTEGER NOT NULL CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')),
  UNIQUE(dimension,dimension_key,root_cause,window_from,window_to)
) STRICT;
CREATE INDEX support_contact_backlog_status ON support_contact_backlog_items(status,priority,created_at);

-- ===== SUP-017 B2B portal =====
CREATE TABLE support_b2b_requests (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  public_ref TEXT NOT NULL UNIQUE CHECK(length(public_ref)=24 AND substr(public_ref,1,4)='B2B-' AND substr(public_ref,5) NOT GLOB '*[^0-9A-F]*'),
  company_id TEXT NOT NULL REFERENCES companies(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK(kind IN ('quote','product_onboarding','documentation','credit','claim')),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 5 AND 200),
  details TEXT NOT NULL CHECK(json_valid(details) AND json_type(details)='object'),
  order_id TEXT REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('submitted','in_review','waiting_customer','approved','rejected','resolved','cancelled')),
  priority TEXT NOT NULL CHECK(priority IN ('normal','high')),
  sla_hours INTEGER NOT NULL CHECK(sla_hours BETWEEN 1 AND 720),
  sla_due_at TEXT NOT NULL CHECK(sla_due_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',sla_due_at),'')),
  first_response_at TEXT CHECK(first_response_at IS NULL OR first_response_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',first_response_at),'')),
  closed_at TEXT CHECK(closed_at IS NULL OR closed_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',closed_at),'')),
  owner_id TEXT REFERENCES identities(id),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  updated_at TEXT NOT NULL CHECK(updated_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',updated_at),'')) CHECK(updated_at>=created_at),
  CHECK((kind='claim')=(order_id IS NOT NULL)),
  CHECK((status IN ('approved','rejected','resolved','cancelled'))=(closed_at IS NOT NULL))
) STRICT;
CREATE INDEX support_b2b_requests_company ON support_b2b_requests(company_id,created_at DESC,id);
CREATE INDEX support_b2b_requests_queue ON support_b2b_requests(status,sla_due_at,id);
CREATE TRIGGER support_b2b_requests_no_delete BEFORE DELETE ON support_b2b_requests BEGIN SELECT RAISE(ABORT,'support_b2b_requests_immutable'); END;
CREATE TABLE support_b2b_request_events (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  request_id TEXT NOT NULL REFERENCES support_b2b_requests(id),
  seq INTEGER NOT NULL CHECK(seq>=1),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('customer','admin')),
  actor_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('submitted','reply','status','assign','document','cancel')),
  from_status TEXT, to_status TEXT NOT NULL,
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(request_id,seq)
) STRICT;
CREATE TRIGGER support_b2b_request_events_no_update BEFORE UPDATE ON support_b2b_request_events BEGIN SELECT RAISE(ABORT,'support_b2b_request_events_immutable'); END;
CREATE TRIGGER support_b2b_request_events_no_delete BEFORE DELETE ON support_b2b_request_events BEGIN SELECT RAISE(ABORT,'support_b2b_request_events_immutable'); END;

CREATE TABLE support_b2b_request_documents (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  request_id TEXT NOT NULL REFERENCES support_b2b_requests(id),
  kind TEXT NOT NULL CHECK(kind IN ('safety_data_sheet','technical_sheet','certificate','tax_document','credit_report','claim_evidence','other')),
  file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 120 AND file_name=trim(file_name) AND file_name NOT GLOB '*[/\\]*'),
  content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','infected')),
  created_by TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL CHECK(created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),'')),
  UNIQUE(request_id,sha256)
) STRICT;
CREATE TRIGGER support_b2b_request_documents_no_update BEFORE UPDATE ON support_b2b_request_documents BEGIN SELECT RAISE(ABORT,'support_b2b_request_documents_immutable'); END;
CREATE TRIGGER support_b2b_request_documents_no_delete BEFORE DELETE ON support_b2b_request_documents BEGIN SELECT RAISE(ABORT,'support_b2b_request_documents_immutable'); END;

