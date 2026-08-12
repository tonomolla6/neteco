-- One-use email-change challenges and their destination metadata.

ALTER TABLE identity_tokens
  DROP CONSTRAINT identity_tokens_purpose_check;

ALTER TABLE identity_tokens
  ADD CONSTRAINT identity_tokens_purpose_check
  CHECK (purpose IN ('verify_email', 'password_reset', 'mfa_challenge', 'email_change'));

ALTER TABLE identity_tokens
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;
