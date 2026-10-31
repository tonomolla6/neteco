-- MKT-014: Browse and product abandonment recovery with incrementality measurement and sensitive category protection.
-- MKT-016: Administrable welcome coupon with single-use per identity, anti-fraud rules, expiry, exclusions and reference price.
-- MKT-020: Rule-based recommendation engine with compatibility, sector, co-purchase, margin, manual fallback, diversity and measurement.

-- MKT-014: Policies
CREATE TABLE marketing_browse_recovery_policies (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  version INTEGER NOT NULL CHECK (version >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  abandonment_window_minutes INTEGER NOT NULL CHECK (abandonment_window_minutes BETWEEN 15 AND 1440),
  cooldown_hours INTEGER NOT NULL CHECK (cooldown_hours BETWEEN 1 AND 720),
  holdout_percent INTEGER NOT NULL CHECK (holdout_percent BETWEEN 0 AND 50),
  attribution_window_days INTEGER NOT NULL CHECK (attribution_window_days BETWEEN 1 AND 30),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL
) STRICT;

CREATE TRIGGER marketing_browse_recovery_policies_no_delete BEFORE DELETE ON marketing_browse_recovery_policies
BEGIN SELECT RAISE(ABORT, 'marketing_browse_policy_immutable'); END;

CREATE TRIGGER marketing_browse_recovery_policies_update_guard BEFORE UPDATE ON marketing_browse_recovery_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

-- MKT-014: Customer browse recovery preferences (explicit consent)
CREATE TABLE marketing_browse_preferences (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  browse_recovery_opt_in INTEGER NOT NULL CHECK (browse_recovery_opt_in IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TRIGGER marketing_browse_preferences_no_delete BEFORE DELETE ON marketing_browse_preferences
BEGIN SELECT RAISE(ABORT, 'marketing_browse_preferences_no_delete'); END;

CREATE TRIGGER marketing_browse_preferences_update_guard BEFORE UPDATE ON marketing_browse_preferences
WHEN NEW.customer_id IS NOT OLD.customer_id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

-- MKT-014: Browse events recorded from storefront
CREATE TABLE marketing_browse_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  view_duration_seconds INTEGER NOT NULL CHECK (view_duration_seconds >= 0),
  event_at TEXT NOT NULL CHECK (event_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', event_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_browse_events_cust_prod ON marketing_browse_events(customer_id, product_id, event_at DESC);

CREATE TRIGGER marketing_browse_events_no_update BEFORE UPDATE ON marketing_browse_events
BEGIN SELECT RAISE(ABORT, 'browse_events_immutable'); END;

CREATE TRIGGER marketing_browse_events_no_delete BEFORE DELETE ON marketing_browse_events
BEGIN SELECT RAISE(ABORT, 'browse_events_immutable'); END;

-- MKT-014: Dispatches / exposures (Treatment vs Control holdout)
CREATE TABLE marketing_browse_dispatches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  group_type TEXT NOT NULL CHECK (group_type IN ('treatment', 'control')),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'control_holdout', 'suppressed_sensitive', 'suppressed_cooldown', 'suppressed_active_cart', 'suppressed_recent_purchase', 'suppressed_opt_out', 'suppressed_inactive')),
  recipient_email_hash TEXT NOT NULL CHECK (length(recipient_email_hash) = 64 AND recipient_email_hash NOT GLOB '*[^0-9a-f]*'),
  attribution_expires_at TEXT NOT NULL CHECK (attribution_expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', attribution_expires_at), '')),
  dispatched_at TEXT NOT NULL CHECK (dispatched_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', dispatched_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_browse_dispatches_cust ON marketing_browse_dispatches(customer_id, dispatched_at DESC);
CREATE INDEX idx_browse_dispatches_attr ON marketing_browse_dispatches(customer_id, group_type, attribution_expires_at);

CREATE TRIGGER marketing_browse_dispatches_no_update BEFORE UPDATE ON marketing_browse_dispatches
BEGIN SELECT RAISE(ABORT, 'browse_dispatches_immutable'); END;

CREATE TRIGGER marketing_browse_dispatches_no_delete BEFORE DELETE ON marketing_browse_dispatches
BEGIN SELECT RAISE(ABORT, 'browse_dispatches_immutable'); END;

-- MKT-014: Attributed incrementality conversions
CREATE TABLE marketing_browse_conversions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  dispatch_id TEXT NOT NULL REFERENCES marketing_browse_dispatches(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  group_type TEXT NOT NULL CHECK (group_type IN ('treatment', 'control')),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),
  converted_at TEXT NOT NULL CHECK (converted_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', converted_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE (dispatch_id, order_id)
) STRICT;

CREATE TRIGGER marketing_browse_conversions_no_update BEFORE UPDATE ON marketing_browse_conversions
BEGIN SELECT RAISE(ABORT, 'browse_conversions_immutable'); END;

CREATE TRIGGER marketing_browse_conversions_no_delete BEFORE DELETE ON marketing_browse_conversions
BEGIN SELECT RAISE(ABORT, 'browse_conversions_immutable'); END;


-- MKT-016: Administrable Welcome Coupon Policies
CREATE TABLE welcome_coupon_policies (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  code_prefix TEXT NOT NULL CHECK (length(code_prefix) BETWEEN 2 AND 16),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 50),
  max_discount_cents INTEGER NOT NULL CHECK (max_discount_cents BETWEEN 100 AND 50000),
  min_order_cents INTEGER NOT NULL CHECK (min_order_cents BETWEEN 0 AND 100000),
  validity_days INTEGER NOT NULL CHECK (validity_days BETWEEN 1 AND 90),
  excluded_category_ids TEXT NOT NULL CHECK (json_valid(excluded_category_ids) AND json_type(excluded_category_ids) = 'array'),
  excluded_product_ids TEXT NOT NULL CHECK (json_valid(excluded_product_ids) AND json_type(excluded_product_ids) = 'array'),
  exclude_already_discounted INTEGER NOT NULL CHECK (exclude_already_discounted IN (0, 1)),
  margin_floor_basis_points INTEGER NOT NULL CHECK (margin_floor_basis_points BETWEEN 1000 AND 5000),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL
) STRICT;

CREATE TRIGGER welcome_coupon_policies_no_delete BEFORE DELETE ON welcome_coupon_policies
BEGIN SELECT RAISE(ABORT, 'welcome_coupon_policy_immutable'); END;

CREATE TRIGGER welcome_coupon_policies_update_guard BEFORE UPDATE ON welcome_coupon_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

-- MKT-016: Welcome coupon grants (strictly 1 grant issued per customer)
CREATE TABLE welcome_coupon_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  coupon_code TEXT NOT NULL UNIQUE CHECK (length(coupon_code) BETWEEN 3 AND 32 AND coupon_code NOT GLOB '*[^A-Z0-9_-]*'),
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  canonical_email_hash TEXT NOT NULL CHECK (length(canonical_email_hash) = 64 AND canonical_email_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_phone_hash TEXT CHECK (canonical_phone_hash IS NULL OR (length(canonical_phone_hash) = 64 AND canonical_phone_hash NOT GLOB '*[^0-9a-f]*')),
  tax_id_hash TEXT CHECK (tax_id_hash IS NULL OR (length(tax_id_hash) = 64 AND tax_id_hash NOT GLOB '*[^0-9a-f]*')),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 50),
  max_discount_cents INTEGER NOT NULL CHECK (max_discount_cents >= 100),
  min_order_cents INTEGER NOT NULL CHECK (min_order_cents >= 0),
  expires_at TEXT NOT NULL CHECK (expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', expires_at), '')),
  status TEXT NOT NULL CHECK (status IN ('active', 'redeemed', 'expired', 'revoked')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_welcome_grants_email ON welcome_coupon_grants(canonical_email_hash);
CREATE INDEX idx_welcome_grants_phone ON welcome_coupon_grants(canonical_phone_hash);
CREATE INDEX idx_welcome_grants_tax ON welcome_coupon_grants(tax_id_hash);

CREATE TRIGGER welcome_coupon_grants_no_delete BEFORE DELETE ON welcome_coupon_grants
BEGIN SELECT RAISE(ABORT, 'welcome_coupon_grant_immutable'); END;

-- MKT-016: Welcome coupon redemptions (strictly 1 use per customer identity/email/phone/tax_id, anti-fraud enforcement, reference price verification)
CREATE TABLE welcome_coupon_redemptions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  grant_id TEXT NOT NULL UNIQUE REFERENCES welcome_coupon_grants(id),
  coupon_code TEXT NOT NULL CHECK (length(coupon_code) BETWEEN 3 AND 32),
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  canonical_email_hash TEXT NOT NULL UNIQUE CHECK (length(canonical_email_hash) = 64 AND canonical_email_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_phone_hash TEXT CHECK (canonical_phone_hash IS NULL OR (length(canonical_phone_hash) = 64 AND canonical_phone_hash NOT GLOB '*[^0-9a-f]*')),
  tax_id_hash TEXT CHECK (tax_id_hash IS NULL OR (length(tax_id_hash) = 64 AND tax_id_hash NOT GLOB '*[^0-9a-f]*')),
  device_fingerprint_hash TEXT CHECK (device_fingerprint_hash IS NULL OR (length(device_fingerprint_hash) = 64 AND device_fingerprint_hash NOT GLOB '*[^0-9a-f]*')),
  discount_applied_cents INTEGER NOT NULL CHECK (discount_applied_cents > 0),
  gross_order_cents INTEGER NOT NULL CHECK (gross_order_cents >= 0),
  reference_price_gross_cents INTEGER NOT NULL CHECK (reference_price_gross_cents >= 0),
  redeemed_at TEXT NOT NULL CHECK (redeemed_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', redeemed_at), '')),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE UNIQUE INDEX idx_welcome_redemptions_phone ON welcome_coupon_redemptions(canonical_phone_hash) WHERE canonical_phone_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_welcome_redemptions_tax ON welcome_coupon_redemptions(tax_id_hash) WHERE tax_id_hash IS NOT NULL;

CREATE TRIGGER welcome_coupon_redemptions_no_update BEFORE UPDATE ON welcome_coupon_redemptions
BEGIN SELECT RAISE(ABORT, 'welcome_coupon_redemptions_immutable'); END;

CREATE TRIGGER welcome_coupon_redemptions_no_delete BEFORE DELETE ON welcome_coupon_redemptions
BEGIN SELECT RAISE(ABORT, 'welcome_coupon_redemptions_immutable'); END;


-- MKT-020: Rule-based Recommendation Engine Policies
CREATE TABLE recommendation_engine_policies (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  version INTEGER NOT NULL CHECK (version >= 1),
  weight_compatibility INTEGER NOT NULL CHECK (weight_compatibility BETWEEN 0 AND 100),
  weight_sector INTEGER NOT NULL CHECK (weight_sector BETWEEN 0 AND 100),
  weight_copurchase INTEGER NOT NULL CHECK (weight_copurchase BETWEEN 0 AND 100),
  weight_margin INTEGER NOT NULL CHECK (weight_margin BETWEEN 0 AND 100),
  margin_floor_basis_points INTEGER NOT NULL CHECK (margin_floor_basis_points BETWEEN 0 AND 5000),
  max_per_category INTEGER NOT NULL CHECK (max_per_category BETWEEN 1 AND 10),
  manual_fallback_product_ids TEXT NOT NULL CHECK (json_valid(manual_fallback_product_ids) AND json_type(manual_fallback_product_ids) = 'array'),
  updated_at TEXT NOT NULL CHECK (updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  updated_by TEXT NOT NULL
) STRICT;

CREATE TRIGGER recommendation_engine_policies_no_delete BEFORE DELETE ON recommendation_engine_policies
BEGIN SELECT RAISE(ABORT, 'recommendation_policy_immutable'); END;

CREATE TRIGGER recommendation_engine_policies_update_guard BEFORE UPDATE ON recommendation_engine_policies
WHEN NEW.id IS NOT OLD.id OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

-- MKT-020: Co-purchases matrix
CREATE TABLE catalog_co_purchases (
  product_a_id TEXT NOT NULL REFERENCES products(id),
  product_b_id TEXT NOT NULL REFERENCES products(id),
  co_purchase_count INTEGER NOT NULL CHECK (co_purchase_count >= 1),
  last_purchased_at TEXT NOT NULL CHECK (last_purchased_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', last_purchased_at), '')),
  PRIMARY KEY (product_a_id, product_b_id)
) STRICT;

CREATE INDEX idx_co_purchases_rev ON catalog_co_purchases(product_b_id, product_a_id, co_purchase_count DESC);

-- MKT-020: Impressions for performance tracking
CREATE TABLE recommendation_impressions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  customer_id TEXT REFERENCES customers(id),
  target_product_id TEXT REFERENCES products(id),
  sector TEXT,
  items_json TEXT NOT NULL CHECK (json_valid(items_json)),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_rec_impressions_cust ON recommendation_impressions(customer_id, created_at DESC);
CREATE INDEX idx_rec_impressions_target ON recommendation_impressions(target_product_id, created_at DESC);

CREATE TRIGGER recommendation_impressions_no_update BEFORE UPDATE ON recommendation_impressions
BEGIN SELECT RAISE(ABORT, 'rec_impressions_immutable'); END;

CREATE TRIGGER recommendation_impressions_no_delete BEFORE DELETE ON recommendation_impressions
BEGIN SELECT RAISE(ABORT, 'rec_impressions_immutable'); END;

-- MKT-020: Events (clicks, conversions) for measurement
CREATE TABLE recommendation_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  impression_id TEXT NOT NULL REFERENCES recommendation_impressions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('click', 'conversion')),
  product_id TEXT NOT NULL REFERENCES products(id),
  order_id TEXT REFERENCES orders(id),
  gross_cents INTEGER CHECK (gross_cents IS NULL OR gross_cents >= 0),
  position INTEGER CHECK (position IS NULL OR position >= 0),
  created_at TEXT NOT NULL CHECK (created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_rec_events_imp ON recommendation_events(impression_id, event_type);
CREATE INDEX idx_rec_events_prod ON recommendation_events(product_id, event_type);

CREATE TRIGGER recommendation_events_no_update BEFORE UPDATE ON recommendation_events
BEGIN SELECT RAISE(ABORT, 'rec_events_immutable'); END;

CREATE TRIGGER recommendation_events_no_delete BEFORE DELETE ON recommendation_events
BEGIN SELECT RAISE(ABORT, 'rec_events_immutable'); END;
