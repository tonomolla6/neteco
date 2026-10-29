-- Synthetic delivery evidence only: never an email provider or marketing list.
-- The runtime requires an independent local-validation opt-in and .test/.invalid
-- recipient/from/link domains. Only fingerprints and synthetic IDs are stored.
CREATE TABLE newsletter_editorial_fake_receipts (
  delivery_id TEXT PRIMARY KEY CHECK(length(delivery_id)=36 AND substr(delivery_id,9,1)='-' AND substr(delivery_id,14,1)='-' AND substr(delivery_id,19,1)='-' AND substr(delivery_id,24,1)='-' AND length(replace(delivery_id,'-',''))=32 AND replace(delivery_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  message_fingerprint TEXT NOT NULL CHECK(length(message_fingerprint)=64 AND message_fingerprint NOT GLOB '*[^0-9a-f]*'),
  provider_message_id TEXT NOT NULL UNIQUE CHECK(provider_message_id='SYNTHETIC-NEWSLETTER-' || message_fingerprint),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')) CHECK(length(created_at)=20 AND created_at=COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ',created_at),''))
) STRICT;
CREATE TRIGGER newsletter_fake_receipt_immutable_update BEFORE UPDATE ON newsletter_editorial_fake_receipts
BEGIN SELECT RAISE(ABORT,'synthetic_newsletter_receipt_immutable'); END;
CREATE TRIGGER newsletter_fake_receipt_immutable_delete BEFORE DELETE ON newsletter_editorial_fake_receipts
BEGIN SELECT RAISE(ABORT,'synthetic_newsletter_receipt_immutable'); END;
