-- Support conversations and durable transactional email delivery evidence.

ALTER TABLE orders
  ADD COLUMN guest_access_expires_at timestamptz,
  ADD COLUMN guest_access_consumed_at timestamptz;

UPDATE orders
SET guest_access_expires_at = created_at + interval '30 days'
WHERE guest_access_hash IS NOT NULL AND guest_access_expires_at IS NULL;

CREATE TABLE order_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, token_hash)
);

CREATE INDEX order_access_sessions_active_idx ON order_access_sessions (order_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE support_tickets
  ADD COLUMN requester_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('customer', 'staff', 'system')),
  author_id uuid,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  private boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_ticket_messages_timeline_idx
  ON support_ticket_messages (ticket_id, created_at, id);

CREATE TABLE communication_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id),
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email')),
  status text NOT NULL CHECK (status IN ('accepted', 'delivered', 'bounced', 'complained', 'suppressed')),
  recipient_hash text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_event_id),
  UNIQUE (provider, provider_message_id)
);

CREATE TABLE communication_suppressions (
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  destination_hash text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'legal')),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, destination_hash)
);

COMMENT ON TABLE communication_deliveries IS
  'Durable provider acknowledgement for idempotent transactional communications; raw recipient addresses are not stored.';
