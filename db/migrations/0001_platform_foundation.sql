-- NETECO platform foundation. Forward-only migration.
-- Domain records use immutable UUIDs; public references and mutable slugs are separate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE catalog_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  owner text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('neteco', 'supplier', 'beply', 'erp')),
  is_master boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  manufacturer_name text,
  website_url text,
  logo_asset_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id integer UNIQUE,
  parent_id uuid REFERENCES categories(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  seo_title text,
  seo_description text,
  source_id uuid REFERENCES catalog_sources(id),
  source_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  width integer,
  height integer,
  checksum_sha256 text NOT NULL,
  owner_name text,
  source_url text,
  license text,
  authorized_at timestamptz,
  rights_status text NOT NULL DEFAULT 'pending' CHECK (rights_status IN ('pending', 'approved', 'blocked', 'expired')),
  quarantine_status text NOT NULL DEFAULT 'pending' CHECK (quarantine_status IN ('pending', 'clean', 'rejected')),
  alt_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE brands ADD CONSTRAINT brands_logo_asset_fk FOREIGN KEY (logo_asset_id) REFERENCES media_assets(id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id integer UNIQUE,
  category_id uuid NOT NULL REFERENCES categories(id),
  brand_id uuid REFERENCES brands(id),
  source_id uuid REFERENCES catalog_sources(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  short_description text,
  description text,
  usage text,
  series text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  featured boolean NOT NULL DEFAULT false,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  regulatory jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version text,
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('spanish', coalesce(short_description, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('spanish', coalesce(usage, '')), 'B')
  ) STORED,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tax_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  rate_basis_points integer NOT NULL CHECK (rate_basis_points BETWEEN 0 AND 10000),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  beply_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE shipping_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parcel', 'multi_parcel', 'pallet', 'own_delivery', 'adr')),
  adr_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id integer UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tax_class_id uuid NOT NULL REFERENCES tax_classes(id),
  shipping_profile_id uuid NOT NULL REFERENCES shipping_profiles(id),
  sku text NOT NULL UNIQUE,
  ean text UNIQUE,
  gtin text UNIQUE,
  mpn text,
  format text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  unit_base text NOT NULL DEFAULT 'unit',
  unit_label text NOT NULL DEFAULT 'unidad',
  content_quantity numeric(12, 4) NOT NULL DEFAULT 1 CHECK (content_quantity > 0),
  units_per_case integer NOT NULL DEFAULT 1 CHECK (units_per_case > 0),
  cases_per_pallet integer,
  minimum_quantity integer NOT NULL DEFAULT 1 CHECK (minimum_quantity > 0),
  quantity_increment integer NOT NULL DEFAULT 1 CHECK (quantity_increment > 0),
  maximum_quantity integer CHECK (maximum_quantity IS NULL OR maximum_quantity > 0),
  price_gross_cents integer NOT NULL CHECK (price_gross_cents >= 0),
  compare_at_gross_cents integer CHECK (compare_at_gross_cents IS NULL OR compare_at_gross_cents >= 0),
  cost_net_cents integer CHECK (cost_net_cents IS NULL OR cost_net_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'EUR',
  weight_grams integer NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  width_mm integer NOT NULL DEFAULT 0 CHECK (width_mm >= 0),
  height_mm integer NOT NULL DEFAULT 0 CHECK (height_mm >= 0),
  depth_mm integer NOT NULL DEFAULT 0 CHECK (depth_mm >= 0),
  safety_stock integer NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  backorder_allowed boolean NOT NULL DEFAULT false,
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  source_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (maximum_quantity IS NULL OR maximum_quantity >= minimum_quantity)
);

CREATE TABLE product_media (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES variants(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id),
  role text NOT NULL CHECK (role IN ('primary', 'gallery', 'label', 'scale', 'datasheet', 'sds', 'certificate', 'video')),
  version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, asset_id, role, version)
);

CREATE TABLE product_relations (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('substitute', 'compatible', 'accessory', 'equivalent', 'bundle')),
  notes text,
  PRIMARY KEY (product_id, related_product_id, kind),
  CHECK (product_id <> related_product_id)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext,
  name text,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'anonymized', 'blocked')),
  merged_into_id uuid REFERENCES customers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customers_email_active_unique ON customers (email) WHERE email IS NOT NULL AND merged_into_id IS NULL;

CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
  session_version integer NOT NULL DEFAULT 1,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  trade_name text,
  tax_id text,
  country_code char(2) NOT NULL DEFAULT 'ES',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, tax_id)
);

CREATE TABLE company_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,
  billing_email citext,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE company_members (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id uuid REFERENCES company_locations(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('company_admin', 'buyer', 'approver', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'revoked')),
  invited_at timestamptz,
  accepted_at timestamptz,
  PRIMARY KEY (company_id, identity_id, role)
);

CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  company_location_id uuid REFERENCES company_locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('shipping', 'billing', 'both')),
  label text,
  recipient_name text NOT NULL,
  company_name text,
  tax_id text,
  line1 text NOT NULL,
  line2 text,
  postal_code text NOT NULL,
  city text NOT NULL,
  region text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'ES',
  phone text,
  instructions text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR company_location_id IS NOT NULL)
);

CREATE TABLE roles (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  resource text NOT NULL,
  action text NOT NULL,
  description text NOT NULL,
  UNIQUE (resource, action)
);

CREATE TABLE role_permissions (
  role_code text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE identity_roles (
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  granted_by uuid REFERENCES identities(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (identity_id, role_code)
);

CREATE TABLE carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token_hash text NOT NULL UNIQUE,
  customer_id uuid REFERENCES customers(id),
  company_location_id uuid REFERENCES company_locations(id),
  currency char(3) NOT NULL DEFAULT 'EUR',
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'expired', 'abandoned')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_number text NOT NULL UNIQUE,
  guest_access_hash text,
  cart_id uuid REFERENCES carts(id),
  customer_id uuid REFERENCES customers(id),
  company_location_id uuid REFERENCES company_locations(id),
  order_status text NOT NULL CHECK (order_status IN ('draft', 'awaiting_payment', 'confirmed', 'on_hold', 'cancelled', 'completed')),
  payment_status text NOT NULL CHECK (payment_status IN ('initiated', 'pending', 'authorized', 'captured', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'chargeback')),
  inventory_status text NOT NULL CHECK (inventory_status IN ('unreserved', 'reserved', 'allocated', 'picked', 'shipped', 'released', 'returned', 'damaged')),
  fulfillment_status text NOT NULL CHECK (fulfillment_status IN ('pending', 'picking', 'packed', 'ready_for_pickup', 'in_transit', 'delivered', 'exception', 'returned')),
  invoice_status text NOT NULL CHECK (invoice_status IN ('not_requested', 'queued', 'issuing', 'issued', 'fiscal_pending', 'failed', 'rectified')),
  currency char(3) NOT NULL DEFAULT 'EUR',
  subtotal_net_cents integer NOT NULL CHECK (subtotal_net_cents >= 0),
  discount_net_cents integer NOT NULL DEFAULT 0 CHECK (discount_net_cents >= 0),
  shipping_net_cents integer NOT NULL DEFAULT 0 CHECK (shipping_net_cents >= 0),
  tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  total_gross_cents integer NOT NULL CHECK (total_gross_cents >= 0),
  shipping_method text NOT NULL,
  payment_method text NOT NULL,
  billing_snapshot jsonb NOT NULL,
  shipping_snapshot jsonb NOT NULL,
  customer_snapshot jsonb NOT NULL,
  terms_snapshot jsonb NOT NULL,
  pricing_version text NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  variant_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_label text NOT NULL,
  unit_net_cents integer NOT NULL CHECK (unit_net_cents >= 0),
  discount_net_cents integer NOT NULL DEFAULT 0 CHECK (discount_net_cents >= 0),
  tax_rate_basis_points integer NOT NULL CHECK (tax_rate_basis_points BETWEEN 0 AND 10000),
  tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  total_gross_cents integer NOT NULL CHECK (total_gross_cents >= 0),
  regulatory_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  logistics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system', 'provider')),
  actor_id uuid,
  origin text NOT NULL,
  reason text,
  from_state jsonb,
  to_state jsonb,
  public_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  private_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, idempotency_key)
);

CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('warehouse', 'store', 'vehicle', 'supplier')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_balances (
  variant_id uuid NOT NULL REFERENCES variants(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  physical_quantity integer NOT NULL DEFAULT 0,
  blocked_quantity integer NOT NULL DEFAULT 0 CHECK (blocked_quantity >= 0),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, location_id)
);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES variants(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  movement_type text NOT NULL CHECK (movement_type IN ('initial', 'receipt', 'adjustment', 'reserve', 'release', 'allocate', 'ship', 'return', 'damage', 'transfer_in', 'transfer_out')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  reference_type text NOT NULL,
  reference_id uuid,
  actor_id uuid,
  reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES variants(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  cart_id uuid REFERENCES carts(id),
  order_id uuid REFERENCES orders(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('active', 'allocated', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cart_id IS NOT NULL OR order_id IS NOT NULL)
);

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  provider_reference text UNIQUE,
  method text NOT NULL,
  status text NOT NULL CHECK (status IN ('initiated', 'pending', 'authorized', 'captured', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'chargeback')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency char(3) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  provider_event_id text,
  event_type text NOT NULL,
  status text NOT NULL,
  amount_cents integer,
  response_code text,
  payload_hash text NOT NULL,
  sanitized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_intent_id, provider_event_id)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  provider_invoice_id text,
  provider_code text,
  series text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  status text NOT NULL CHECK (status IN ('queued', 'issuing', 'issued', 'fiscal_pending', 'failed', 'rectified')),
  fiscal_version integer NOT NULL DEFAULT 1,
  amount_cents integer NOT NULL,
  currency char(3) NOT NULL,
  source_invoice_id uuid REFERENCES invoices(id),
  pdf_checksum text,
  idempotency_key text NOT NULL UNIQUE,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind, fiscal_version)
);

CREATE TABLE fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  status text NOT NULL CHECK (status IN ('pending', 'picking', 'packed', 'ready_for_pickup', 'in_transit', 'delivered', 'exception', 'returned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES fulfillments(id),
  provider text NOT NULL,
  service_code text NOT NULL,
  tracking_number text,
  status text NOT NULL,
  estimated_cost_cents integer NOT NULL DEFAULT 0,
  actual_cost_cents integer,
  currency char(3) NOT NULL DEFAULT 'EUR',
  label_asset_id uuid REFERENCES media_assets(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id),
  provider_event_id text,
  status text NOT NULL,
  location text,
  description text,
  occurred_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  UNIQUE (shipment_id, provider_event_id)
);

CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  public_number text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'in_transit', 'received', 'inspected', 'resolved')),
  reason text NOT NULL,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_line_id uuid NOT NULL REFERENCES order_lines(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  condition text,
  disposition text
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id),
  return_id uuid REFERENCES returns(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL CHECK (status IN ('requested', 'pending', 'succeeded', 'failed', 'cancelled')),
  reason text NOT NULL,
  provider_reference text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'retry', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text,
  payload_hash text NOT NULL,
  sanitized_payload jsonb NOT NULL,
  signature_valid boolean NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'rejected', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, payload_hash)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  before_redacted jsonb,
  after_redacted jsonb,
  reason text,
  ip_hash text,
  session_id_hash text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id),
  anonymous_id uuid,
  purpose text NOT NULL,
  channel text NOT NULL,
  action text NOT NULL CHECK (action IN ('granted', 'withdrawn', 'updated')),
  policy_version text NOT NULL,
  text_hash text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR anonymous_id IS NOT NULL)
);

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  category text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL CHECK (status IN ('open', 'waiting_customer', 'waiting_provider', 'resolved', 'closed')),
  owner_identity_id uuid REFERENCES identities(id),
  subject text NOT NULL,
  next_action_at timestamptz,
  sla_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  description text NOT NULL,
  owner text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  targeting jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_search_document_idx ON products USING gin (search_document);
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX variants_sku_trgm_idx ON variants USING gin (sku gin_trgm_ops);
CREATE INDEX categories_parent_sort_idx ON categories (parent_id, sort_order);
CREATE INDEX cart_items_cart_idx ON cart_items (cart_id);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_status_created_idx ON orders (order_status, created_at DESC);
CREATE INDEX order_events_order_created_idx ON order_events (order_id, created_at);
CREATE INDEX inventory_reservations_active_idx ON inventory_reservations (variant_id, location_id, expires_at) WHERE status = 'active';
CREATE INDEX inventory_movements_variant_created_idx ON inventory_movements (variant_id, location_id, created_at);
CREATE INDEX payment_events_intent_created_idx ON payment_events (payment_intent_id, received_at);
CREATE INDEX outbox_ready_idx ON outbox_events (status, available_at) WHERE status IN ('pending', 'retry');
CREATE INDEX audit_resource_idx ON audit_log (resource_type, resource_id, created_at DESC);

COMMENT ON TABLE orders IS 'NETECO is source of truth for the commercial order and immutable contractual snapshots.';
COMMENT ON TABLE invoices IS 'Beply is source of truth for fiscal documents; NETECO stores identifiers, state and checksums.';
COMMENT ON TABLE inventory_movements IS 'Append-only inventory ledger. Balances are never edited without a corresponding movement.';
