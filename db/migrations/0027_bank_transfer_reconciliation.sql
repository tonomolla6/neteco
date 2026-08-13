CREATE TABLE bank_transfer_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_id text NOT NULL,
  booked_at timestamptz NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  reference text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'needs_review', 'matched')),
  review_reason text,
  matched_order_id uuid REFERENCES orders(id),
  match_mode text CHECK (match_mode IN ('automatic', 'manual')),
  reconciled_by uuid REFERENCES identities(id),
  correlation_id uuid NOT NULL,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id),
  CHECK (
    (status = 'matched' AND matched_order_id IS NOT NULL AND match_mode IS NOT NULL AND reconciled_at IS NOT NULL)
    OR (status <> 'matched' AND matched_order_id IS NULL AND match_mode IS NULL AND reconciled_at IS NULL)
  )
);

CREATE UNIQUE INDEX bank_transfer_movements_matched_order_unique
  ON bank_transfer_movements (matched_order_id)
  WHERE status = 'matched';

CREATE INDEX bank_transfer_movements_review_idx
  ON bank_transfer_movements (status, booked_at, id)
  WHERE status = 'needs_review';
