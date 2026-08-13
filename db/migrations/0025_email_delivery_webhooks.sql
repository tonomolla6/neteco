CREATE TABLE communication_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES communication_deliveries(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('delivered', 'hard_bounce', 'complaint')),
  occurred_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, provider_event_id)
);

CREATE INDEX communication_delivery_events_timeline_idx
  ON communication_delivery_events (delivery_id, occurred_at, id);
