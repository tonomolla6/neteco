ALTER TABLE returns ADD COLUMN idempotency_key uuid;
UPDATE returns SET idempotency_key = id WHERE idempotency_key IS NULL;
ALTER TABLE returns ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE returns ADD CONSTRAINT returns_idempotency_unique UNIQUE (idempotency_key);

ALTER TABLE return_lines ADD CONSTRAINT return_lines_item_unique UNIQUE (return_id, order_line_id);

ALTER TABLE shipments ADD COLUMN provider_shipment_id text;
ALTER TABLE shipments ADD COLUMN profile text;
ALTER TABLE shipments ADD COLUMN estimated_delivery_from timestamptz;
ALTER TABLE shipments ADD COLUMN estimated_delivery_to timestamptz;
CREATE UNIQUE INDEX shipments_provider_reference_unique
  ON shipments (provider, provider_shipment_id)
  WHERE provider_shipment_id IS NOT NULL;

CREATE TABLE shipping_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  method text NOT NULL CHECK (method IN ('own_delivery', 'parcel', 'pallet', 'adr', 'pickup')),
  country_code char(2) NOT NULL DEFAULT 'ES',
  postal_prefixes text[] NOT NULL DEFAULT ARRAY[]::text[],
  weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  cutoff_local time NOT NULL DEFAULT '14:00',
  preparation_business_days integer NOT NULL DEFAULT 1 CHECK (preparation_business_days >= 0),
  transit_min_business_days integer NOT NULL DEFAULT 1 CHECK (transit_min_business_days >= 0),
  transit_max_business_days integer NOT NULL DEFAULT 2 CHECK (transit_max_business_days >= transit_min_business_days),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shipping_zones (
  code, name, method, postal_prefixes, weekdays, cutoff_local,
  preparation_business_days, transit_min_business_days, transit_max_business_days
) VALUES
  ('OWN-468', 'Reparto propio Vall d’Albaida', 'own_delivery', ARRAY['468'], ARRAY[1,2,3,4,5], '13:00', 1, 0, 1),
  ('ES-PARCEL', 'Paquetería peninsular', 'parcel', ARRAY[]::text[], ARRAY[1,2,3,4,5], '13:00', 1, 1, 2),
  ('WAREHOUSE-PICKUP', 'Recogida en almacén', 'pickup', ARRAY[]::text[], ARRAY[1,2,3,4,5], '13:00', 1, 0, 0)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE order_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_identity_id uuid NOT NULL REFERENCES identities(id),
  note text NOT NULL CHECK (length(btrim(note)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_notes_order_created_idx ON order_notes (order_id, created_at DESC);
