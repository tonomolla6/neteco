ALTER TABLE feature_flags
  ADD COLUMN created_by uuid REFERENCES identities(id),
  ADD COLUMN updated_by uuid REFERENCES identities(id),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT feature_flags_key_format CHECK (key ~ '^[a-z][a-z0-9._-]{2,79}$'),
  ADD CONSTRAINT feature_flags_targeting_object CHECK (jsonb_typeof(targeting) = 'object'),
  ADD CONSTRAINT feature_flags_owner_length CHECK (length(owner) BETWEEN 2 AND 160);

CREATE INDEX feature_flags_expiry_idx ON feature_flags (expires_at, enabled);

