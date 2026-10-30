-- Migration 0125: MKT-033 (Learning Centre & Certificates), MKT-035 (Targeted B2B Campaigns), MKT-036 (B2B Recurring Incentives)

-- 1. Centro de aprendizaje y certificados internos ligeros (MKT-033)
CREATE TABLE learning_courses (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 3 AND 100 AND slug NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 10 AND 2000),
  category TEXT NOT NULL CHECK(category IN ('chemical_safety', 'dosage_optimization', 'hygiene_haccp', 'industrial_cleaning', 'sustainability')),
  target_sector TEXT CHECK(target_sector IS NULL OR target_sector IN ('hosteleria', 'lavanderia_industrial', 'agroalimentario', 'automocion_taller', 'sanitario_clinicas', 'facility_services', 'general')),
  estimated_duration_minutes INTEGER NOT NULL CHECK(estimated_duration_minutes BETWEEN 5 AND 600),
  passing_score_percent INTEGER NOT NULL DEFAULT 80 CHECK(passing_score_percent BETWEEN 50 AND 100),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE TABLE learning_lessons (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  slug TEXT NOT NULL CHECK(length(slug) BETWEEN 3 AND 100),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 200),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 10 AND 500),
  content_markdown TEXT NOT NULL CHECK(length(content_markdown) BETWEEN 20 AND 20000),
  linked_product_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(linked_product_ids_json)),
  support_topic TEXT NOT NULL CHECK(length(support_topic) BETWEEN 3 AND 100),
  support_action_label TEXT NOT NULL CHECK(length(support_action_label) BETWEEN 3 AND 100),
  support_action_url TEXT NOT NULL CHECK(length(support_action_url) BETWEEN 3 AND 300),
  quiz_questions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quiz_questions_json)),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(course_id, sort_order),
  UNIQUE(course_id, slug)
) STRICT;

CREATE INDEX idx_learning_lessons_course ON learning_lessons(course_id, sort_order);

CREATE TABLE learning_customer_progress (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES learning_lessons(id) ON DELETE CASCADE,
  quiz_score_percent INTEGER CHECK(quiz_score_percent IS NULL OR quiz_score_percent BETWEEN 0 AND 100),
  passed INTEGER NOT NULL DEFAULT 0 CHECK(passed IN (0, 1)),
  answers_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(answers_json)),
  completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at) = 20 AND completed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', completed_at), ''))),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(customer_id, lesson_id)
) STRICT;

CREATE INDEX idx_learning_progress_customer ON learning_customer_progress(customer_id, course_id);

CREATE TABLE learning_certificates (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  certificate_code TEXT NOT NULL UNIQUE CHECK(length(certificate_code) BETWEEN 8 AND 32),
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE RESTRICT,
  recipient_name TEXT NOT NULL CHECK(length(recipient_name) BETWEEN 2 AND 200),
  company_name TEXT CHECK(company_name IS NULL OR length(company_name) BETWEEN 2 AND 200),
  course_title TEXT NOT NULL CHECK(length(course_title) BETWEEN 3 AND 200),
  final_score_percent INTEGER NOT NULL CHECK(final_score_percent BETWEEN 50 AND 100),
  is_official_accreditation INTEGER NOT NULL DEFAULT 0 CHECK(is_official_accreditation = 0),
  legal_disclaimer TEXT NOT NULL CHECK(length(legal_disclaimer) BETWEEN 20 AND 500),
  verification_hash TEXT NOT NULL CHECK(length(verification_hash) = 64),
  issued_at TEXT NOT NULL CHECK(length(issued_at) = 20 AND issued_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', issued_at), '')),
  UNIQUE(customer_id, course_id)
) STRICT;

CREATE INDEX idx_learning_certificates_customer ON learning_certificates(customer_id);
CREATE INDEX idx_learning_certificates_code ON learning_certificates(certificate_code);

-- 2. Campañas B2B segmentadas por cliente, empresa o sector (MKT-035)
CREATE TABLE marketing_targeted_campaigns (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 3 AND 64 AND code NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 5 AND 1000),
  target_type TEXT NOT NULL CHECK(target_type IN ('customer', 'company', 'sector')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 64),
  tariff_type TEXT NOT NULL CHECK(tariff_type IN ('percentage_discount', 'fixed_price', 'rate_table', 'rebate_bonus')),
  discount_percent INTEGER CHECK(discount_percent IS NULL OR discount_percent BETWEEN 1 AND 50),
  fixed_price_cents INTEGER CHECK(fixed_price_cents IS NULL OR fixed_price_cents > 0),
  rate_table_code TEXT CHECK(rate_table_code IS NULL OR length(rate_table_code) <= 32),
  min_order_net_cents INTEGER NOT NULL DEFAULT 0 CHECK(min_order_net_cents >= 0),
  margin_floor_basis_points INTEGER NOT NULL DEFAULT 1500 CHECK(margin_floor_basis_points BETWEEN 500 AND 5000),
  start_at TEXT NOT NULL CHECK(length(start_at) = 20 AND start_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', start_at), '')),
  end_at TEXT NOT NULL CHECK(length(end_at) = 20 AND end_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', end_at), '') AND end_at >= start_at),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'completed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at)
) STRICT;

CREATE INDEX idx_mkt_campaigns_target ON marketing_targeted_campaigns(target_type, target_id, status);

CREATE TABLE marketing_campaign_dispatches (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  campaign_id TEXT NOT NULL REFERENCES marketing_targeted_campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  consent_verified INTEGER NOT NULL CHECK(consent_verified = 1),
  consent_version TEXT NOT NULL CHECK(length(consent_version) <= 64),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'portal', 'account_manager')),
  status TEXT NOT NULL CHECK(status IN ('dispatched', 'opened', 'clicked', 'converted', 'bounced', 'suppressed')),
  dispatched_at TEXT NOT NULL CHECK(length(dispatched_at) = 20 AND dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  opened_at TEXT CHECK(opened_at IS NULL OR (length(opened_at) = 20 AND opened_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', opened_at), ''))),
  clicked_at TEXT CHECK(clicked_at IS NULL OR (length(clicked_at) = 20 AND clicked_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', clicked_at), ''))),
  converted_at TEXT CHECK(converted_at IS NULL OR (length(converted_at) = 20 AND converted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', converted_at), ''))),
  converted_order_id TEXT REFERENCES orders(id),
  revenue_net_cents INTEGER NOT NULL DEFAULT 0 CHECK(revenue_net_cents >= 0),
  UNIQUE(campaign_id, customer_id)
) STRICT;

CREATE INDEX idx_mkt_dispatches_campaign ON marketing_campaign_dispatches(campaign_id, status);

-- 3. Incentivos por recurrencia B2B (MKT-036)
CREATE TABLE b2b_recurring_incentive_agreements (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contract_ref TEXT NOT NULL UNIQUE CHECK(length(contract_ref) BETWEEN 5 AND 64),
  contract_terms_version TEXT NOT NULL CHECK(length(contract_terms_version) BETWEEN 2 AND 32),
  contract_signed_at TEXT NOT NULL CHECK(length(contract_signed_at) = 20 AND contract_signed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', contract_signed_at), '')),
  period_frequency TEXT NOT NULL CHECK(period_frequency IN ('quarterly', 'annual')),
  volume_tiers_json TEXT NOT NULL CHECK(json_valid(volume_tiers_json)),
  min_gross_margin_basis_points INTEGER NOT NULL DEFAULT 2000 CHECK(min_gross_margin_basis_points BETWEEN 500 AND 5000),
  sla_punctual_payment_required INTEGER NOT NULL DEFAULT 1 CHECK(sla_punctual_payment_required IN (0, 1)),
  sla_min_avg_order_net_cents INTEGER NOT NULL DEFAULT 0 CHECK(sla_min_avg_order_net_cents >= 0),
  sla_einvoice_required INTEGER NOT NULL DEFAULT 1 CHECK(sla_einvoice_required IN (0, 1)),
  fiscal_notes TEXT NOT NULL CHECK(length(fiscal_notes) BETWEEN 10 AND 1000),
  fiscal_vat_treatment TEXT NOT NULL CHECK(fiscal_vat_treatment IN ('credit_note_art80_liva', 'commercial_discount_subsequent_invoice')),
  fiscal_review_status TEXT NOT NULL DEFAULT 'pending_review' CHECK(fiscal_review_status IN ('pending_review', 'fiscal_approved', 'fiscal_rejected')),
  fiscal_reviewed_by TEXT REFERENCES identities(id),
  fiscal_reviewed_at TEXT CHECK(fiscal_reviewed_at IS NULL OR (length(fiscal_reviewed_at) = 20 AND fiscal_reviewed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', fiscal_reviewed_at), ''))),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'suspended', 'terminated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(company_id, period_frequency)
) STRICT;

CREATE INDEX idx_b2b_incentives_company ON b2b_recurring_incentive_agreements(company_id, status);

CREATE TABLE b2b_recurring_incentive_settlements (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  agreement_id TEXT NOT NULL REFERENCES b2b_recurring_incentive_agreements(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  settlement_period TEXT NOT NULL CHECK(length(settlement_period) BETWEEN 4 AND 32),
  period_start TEXT NOT NULL CHECK(length(period_start) = 20 AND period_start = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', period_start), '')),
  period_end TEXT NOT NULL CHECK(length(period_end) = 20 AND period_end = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', period_end), '') AND period_end >= period_start),
  qualifying_turnover_net_cents INTEGER NOT NULL CHECK(qualifying_turnover_net_cents >= 0),
  margin_achieved_basis_points INTEGER NOT NULL CHECK(margin_achieved_basis_points BETWEEN 0 AND 10000),
  margin_threshold_met INTEGER NOT NULL CHECK(margin_threshold_met IN (0, 1)),
  sla_payment_met INTEGER NOT NULL CHECK(sla_payment_met IN (0, 1)),
  sla_order_size_met INTEGER NOT NULL CHECK(sla_order_size_met IN (0, 1)),
  sla_einvoice_met INTEGER NOT NULL CHECK(sla_einvoice_met IN (0, 1)),
  sla_conditions_all_met INTEGER NOT NULL CHECK(sla_conditions_all_met IN (0, 1)),
  applied_rebate_basis_points INTEGER NOT NULL CHECK(applied_rebate_basis_points BETWEEN 0 AND 3000),
  rebate_net_cents INTEGER NOT NULL CHECK(rebate_net_cents >= 0),
  vat_tax_rate_percent INTEGER NOT NULL DEFAULT 21 CHECK(vat_tax_rate_percent = 21),
  vat_tax_cents INTEGER NOT NULL CHECK(vat_tax_cents >= 0),
  total_credit_gross_cents INTEGER NOT NULL CHECK(total_credit_gross_cents >= 0),
  settlement_status TEXT NOT NULL DEFAULT 'calculated' CHECK(settlement_status IN ('calculated', 'approved', 'credit_issued', 'rejected')),
  credit_note_ref TEXT CHECK(credit_note_ref IS NULL OR length(credit_note_ref) <= 64),
  fiscal_approval_identity_id TEXT REFERENCES identities(id),
  fiscal_approval_at TEXT CHECK(fiscal_approval_at IS NULL OR (length(fiscal_approval_at) = 20 AND fiscal_approval_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', fiscal_approval_at), ''))),
  notes TEXT CHECK(notes IS NULL OR length(notes) <= 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(length(created_at) = 20 AND created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 20 AND updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '') AND updated_at >= created_at),
  UNIQUE(agreement_id, settlement_period)
) STRICT;

CREATE INDEX idx_b2b_settlements_company ON b2b_recurring_incentive_settlements(company_id, settlement_period);
