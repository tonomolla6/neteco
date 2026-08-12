CREATE TABLE shipment_documents (
  shipment_id uuid PRIMARY KEY REFERENCES shipments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('label', 'return_label', 'manifest', 'pod')),
  content_type text NOT NULL,
  bytes bytea NOT NULL,
  checksum_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shipment_events_occurred_idx ON shipment_events (shipment_id, occurred_at DESC);
