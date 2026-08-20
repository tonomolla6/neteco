CREATE TABLE catalog_sources (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('neteco', 'supplier', 'beply', 'erp')),
  is_master INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  manufacturer_name TEXT,
  website_url TEXT,
  logo_asset_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE,
  parent_id TEXT REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  seo_title TEXT,
  seo_description TEXT,
  source_id TEXT REFERENCES catalog_sources(id),
  source_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  brand_id TEXT REFERENCES brands(id),
  source_id TEXT REFERENCES catalog_sources(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  short_description TEXT,
  description TEXT,
  usage TEXT,
  series TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  attributes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes)),
  regulatory TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(regulatory)),
  source_version TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE tax_classes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points BETWEEN 0 AND 10000),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  beply_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
) STRICT;

CREATE TABLE shipping_profiles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('parcel', 'multi_parcel', 'pallet', 'own_delivery', 'adr')),
  adr_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(adr_data)),
  constraints TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tax_class_id TEXT NOT NULL REFERENCES tax_classes(id),
  shipping_profile_id TEXT NOT NULL REFERENCES shipping_profiles(id),
  sku TEXT NOT NULL UNIQUE,
  ean TEXT UNIQUE,
  gtin TEXT UNIQUE,
  mpn TEXT,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'hidden', 'discontinued')),
  unit_base TEXT NOT NULL DEFAULT 'unit',
  unit_label TEXT NOT NULL DEFAULT 'unidad',
  content_quantity REAL NOT NULL DEFAULT 1 CHECK (content_quantity > 0),
  units_per_case INTEGER NOT NULL DEFAULT 1 CHECK (units_per_case > 0),
  cases_per_pallet INTEGER,
  minimum_quantity INTEGER NOT NULL DEFAULT 1 CHECK (minimum_quantity > 0),
  quantity_increment INTEGER NOT NULL DEFAULT 1 CHECK (quantity_increment > 0),
  maximum_quantity INTEGER CHECK (maximum_quantity IS NULL OR maximum_quantity > 0),
  price_gross_cents INTEGER NOT NULL CHECK (price_gross_cents >= 0),
  compare_at_gross_cents INTEGER CHECK (compare_at_gross_cents IS NULL OR compare_at_gross_cents >= 0),
  cost_net_cents INTEGER CHECK (cost_net_cents IS NULL OR cost_net_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  weight_grams INTEGER NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  width_mm INTEGER NOT NULL DEFAULT 0 CHECK (width_mm >= 0),
  height_mm INTEGER NOT NULL DEFAULT 0 CHECK (height_mm >= 0),
  depth_mm INTEGER NOT NULL DEFAULT 0 CHECK (depth_mm >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  backorder_allowed INTEGER NOT NULL DEFAULT 0 CHECK (backorder_allowed IN (0, 1)),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  color TEXT CHECK (
    color IS NULL OR (
      length(color) = 7 AND
      color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
    )
  ),
  image TEXT CHECK (
    image IS NULL OR (
      image LIKE '/img/products/%' AND
      instr(image, char(13)) = 0 AND
      instr(image, char(10)) = 0
    )
  ),
  source_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (maximum_quantity IS NULL OR maximum_quantity >= minimum_quantity)
) STRICT;

CREATE INDEX categories_parent_sort_idx ON categories(parent_id, sort_order, name);
CREATE INDEX categories_published_idx ON categories(sort_order, name) WHERE status = 'published';
CREATE INDEX products_category_status_idx ON products(category_id, status, name);
CREATE INDEX products_featured_idx ON products(featured, status) WHERE featured = 1;
CREATE INDEX variants_product_status_idx ON variants(product_id, status, price_gross_cents);

CREATE VIRTUAL TABLE products_fts USING fts5(
  name,
  short_description,
  description,
  usage,
  content = 'products',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER products_fts_insert AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, short_description, description, usage)
  VALUES (new.rowid, new.name, new.short_description, new.description, new.usage);
END;

CREATE TRIGGER products_fts_delete AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, short_description, description, usage)
  VALUES ('delete', old.rowid, old.name, old.short_description, old.description, old.usage);
END;

CREATE TRIGGER products_fts_update AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, short_description, description, usage)
  VALUES ('delete', old.rowid, old.name, old.short_description, old.description, old.usage);
  INSERT INTO products_fts(rowid, name, short_description, description, usage)
  VALUES (new.rowid, new.name, new.short_description, new.description, new.usage);
END;
