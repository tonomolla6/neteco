CREATE TABLE refund_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  order_line_id uuid REFERENCES order_lines(id),
  component_type text NOT NULL CHECK (component_type IN ('line', 'shipping', 'adjustment')),
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_cents integer NOT NULL CHECK (gross_cents > 0),
  net_cents integer NOT NULL CHECK (net_cents >= 0),
  tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  tax_rate_basis_points integer NOT NULL CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  fiscal_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((component_type = 'line') = (order_line_id IS NOT NULL)),
  UNIQUE (refund_id, order_line_id)
);

ALTER TABLE invoices
  ADD COLUMN pdf_bytes bytea,
  ADD COLUMN pdf_size integer CHECK (pdf_size IS NULL OR pdf_size > 0),
  ADD COLUMN request_fingerprint text,
  ADD COLUMN reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_message text;

CREATE UNIQUE INDEX invoices_provider_document_unique
  ON invoices (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;

CREATE INDEX refund_lines_refund_idx ON refund_lines (refund_id);
CREATE UNIQUE INDEX refund_lines_non_line_component_unique
  ON refund_lines (refund_id, component_type)
  WHERE order_line_id IS NULL;

COMMENT ON TABLE refund_lines IS
  'Immutable fiscal allocation of a refund to contractual order lines and tax snapshots.';
COMMENT ON COLUMN invoices.pdf_bytes IS
  'Durable local copy of the exact fiscal PDF returned by the provider; protected by authenticated APIs.';
