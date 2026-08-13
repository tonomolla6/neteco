ALTER TABLE variants
  ADD COLUMN color text,
  ADD COLUMN image text,
  ADD CONSTRAINT variants_color_hex_check
    CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
  ADD CONSTRAINT variants_image_path_check
    CHECK (image IS NULL OR (image LIKE '/img/products/%' AND image !~ '[\\r\\n]'));

CREATE INDEX variants_product_color_idx
  ON variants (product_id, color)
  WHERE status = 'published' AND color IS NOT NULL;
