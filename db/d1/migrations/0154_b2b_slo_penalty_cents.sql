-- Preserve historical report amounts while making the persisted unit explicit and integral.
ALTER TABLE b2b_slo_compliance_reports
  ADD COLUMN penalty_credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(penalty_credit_cents >= 0);
UPDATE b2b_slo_compliance_reports
SET penalty_credit_cents = CAST(ROUND(penalty_credit_eur * 100) AS INTEGER);
ALTER TABLE b2b_slo_compliance_reports DROP COLUMN penalty_credit_eur;
