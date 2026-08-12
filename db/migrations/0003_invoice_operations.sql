ALTER TABLE invoices ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX invoices_provider_lookup_idx ON invoices (provider, provider_invoice_id);
CREATE INDEX invoices_status_created_idx ON invoices (status, created_at);
