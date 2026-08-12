CREATE UNIQUE INDEX fulfillments_order_location_unique ON fulfillments (order_id, location_id);

ALTER TABLE refunds ADD COLUMN response_code text;
ALTER TABLE refunds ADD COLUMN failure_message text;
ALTER TABLE refunds ADD COLUMN completed_at timestamptz;

ALTER TABLE invoices ADD COLUMN return_id uuid REFERENCES returns(id);
ALTER TABLE invoices ADD COLUMN refund_id uuid REFERENCES refunds(id);
CREATE UNIQUE INDEX invoices_refund_unique ON invoices (refund_id) WHERE refund_id IS NOT NULL;
