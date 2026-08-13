WITH chemical_families(family) AS (
  VALUES
    ('cristalin'), ('defort'), ('delenex'), ('detial'), ('kenex'),
    ('lavaper'), ('milane'), ('nettion'), ('sabomans'), ('saniolex')
), moved AS (
  SELECT p.id,
         '/img/products/' || family || '/' ||
         CASE WHEN p.slug = family THEN family ELSE substring(p.slug FROM length(family) + 2) END || '.jpg' AS path
  FROM products p
  JOIN chemical_families ON p.slug = family OR p.slug LIKE family || '-%'
  WHERE p.attributes ->> 'image' = '/img/products/' || p.slug || '.jpg'
)
UPDATE products product
SET attributes = jsonb_set(product.attributes, '{image}', to_jsonb(moved.path), true),
    updated_at = now()
FROM moved
WHERE product.id = moved.id;

WITH aliases(slug, old_path, new_path) AS (
  VALUES
    ('guante-de-nitrilo-nitriflex-blue-caja-100-uds', '/img/products/nitrilo-azul.jpg', '/img/products/guante-de-nitrilo-nitriflex-blue-caja-100-uds/principal.jpg'),
    ('guante-de-nitrilo-nitriflex-black-soft-caja-100-uds', '/img/products/nitrilo-negro.jpg', '/img/products/guante-de-nitrilo-nitriflex-black-soft-caja-100-uds/principal.jpg'),
    ('guante-de-nitrilo-dermolite-azul-caja-100-uds', '/img/products/nitrilo-azul.jpg', '/img/products/guante-de-nitrilo-dermolite-azul-caja-100-uds/principal.jpg'),
    ('guante-de-nitrilo-aachenfeel-negro-caja-100-uds', '/img/products/nitrilo-negro.jpg', '/img/products/guante-de-nitrilo-aachenfeel-negro-caja-100-uds/principal.jpg'),
    ('guante-de-vinilo-sin-polvo-caja-100-uds', '/img/products/vinilo-transparente.jpg', '/img/products/guante-de-vinilo-sin-polvo-caja-100-uds/principal.jpg'),
    ('guante-de-vinilo-con-polvo-caja-100-uds', '/img/products/vinilo-caja.jpg', '/img/products/guante-de-vinilo-con-polvo-caja-100-uds/principal.jpg'),
    ('guante-ignifugo-azul-par', '/img/products/guante-soldadura.jpg', '/img/products/guante-ignifugo-azul-par/principal.jpg'),
    ('rollo-mantel-novotex', '/img/products/rollo-mantel-novotex.jpg', '/img/products/rollo-mantel-novotex/precortado/AM.jpg')
)
UPDATE products product
SET attributes = jsonb_set(product.attributes, '{image}', to_jsonb(aliases.new_path), true),
    updated_at = now()
FROM aliases
WHERE product.slug = aliases.slug AND product.attributes ->> 'image' = aliases.old_path;

WITH novotex AS (
  SELECT variant.id,
         substring(variant.format FROM '\(([A-Z0-9]+)\)\s*$') AS code,
         CASE
           WHEN variant.format ILIKE '%Precorte cada 40%' THEN 'precortado/040'
           WHEN variant.format ILIKE '%Precorte%' THEN 'precortado'
           ELSE 'sin-precorte'
         END AS finish
  FROM variants variant
  JOIN products product ON product.id = variant.product_id
  WHERE product.slug = 'rollo-mantel-novotex' AND variant.image IS NULL
)
UPDATE variants variant
SET image = '/img/products/rollo-mantel-novotex/' || novotex.finish || '/' || novotex.code || '.jpg',
    updated_at = now()
FROM novotex
WHERE variant.id = novotex.id AND novotex.code IS NOT NULL;
