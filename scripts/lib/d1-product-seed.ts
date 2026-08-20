import { PRODUCTS } from '../../server/db/seed'
import { slugify } from '../../server/utils/slug'
import { unitsFor } from '../../server/utils/units'
import { sqlText, stableUuid } from './d1-category-seed'

function sqlNullable(value: string | null | undefined) {
  return value === null || value === undefined ? 'NULL' : sqlText(value)
}

export function renderD1ProductSeed() {
  const sourceId = stableUuid('source:neteco-demo')
  const brandId = stableUuid('brand:neteco')
  const taxClassId = stableUuid('tax:es-general-21')
  const shippingProfileId = stableUuid('shipping:parcel')
  const statements = [
    'BEGIN TRANSACTION;',
    `INSERT INTO brands (id, name, slug, status)
VALUES (${sqlText(brandId)}, 'NETECO', 'neteco', 'published')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, slug = excluded.slug, status = excluded.status;`,
    `INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from)
VALUES (${sqlText(taxClassId)}, 'ES-GENERAL-21', 'IVA general 21 %', 2100, '2020-01-01T00:00:00Z')
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  rate_basis_points = excluded.rate_basis_points,
  valid_from = excluded.valid_from;`,
    `INSERT INTO shipping_profiles (id, code, name, kind)
VALUES (${sqlText(shippingProfileId)}, 'parcel-standard', 'Paquetería estándar', 'parcel')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind;`
  ]

  for (const [productIndex, product] of PRODUCTS.entries()) {
    const productId = stableUuid(`product:${productIndex + 1}`)
    const attributes = JSON.stringify({
      badges: product.badges ?? [],
      visual: { type: product.visual[0], color: product.visual[1] },
      attrs: [],
      ...(product.image ? { image: product.image } : {})
    })
    statements.push(`INSERT INTO products (
  id, legacy_id, category_id, brand_id, source_id, name, slug, short_description,
  description, usage, series, status, featured, attributes, source_version
) VALUES (
  ${sqlText(productId)}, ${productIndex + 1}, ${sqlText(stableUuid(`category:${product.cat}`))},
  ${sqlText(brandId)}, ${sqlText(sourceId)}, ${sqlText(product.name)}, ${sqlText(slugify(product.name))},
  ${sqlText(product.short)}, ${sqlText(product.desc)}, ${sqlNullable(product.usage)}, ${sqlNullable(product.series)},
  'published', ${product.featured ? 1 : 0}, ${sqlText(attributes)}, 'demo-v1'
)
ON CONFLICT (id) DO UPDATE SET
  category_id = excluded.category_id,
  brand_id = excluded.brand_id,
  name = excluded.name,
  slug = excluded.slug,
  short_description = excluded.short_description,
  description = excluded.description,
  usage = excluded.usage,
  series = excluded.series,
  status = excluded.status,
  featured = excluded.featured,
  attributes = excluded.attributes,
  source_version = excluded.source_version,
  updated_at = CURRENT_TIMESTAMP;`)

    for (const [variantIndex, [format, euros, sourceSku]] of product.variants.entries()) {
      const variantId = stableUuid(`variant:${productIndex + 1}:${variantIndex + 1}`)
      const unit = unitsFor(format, product.name)
      const sku = sourceSku ?? `NE-${String(productIndex + 1).padStart(3, '0')}-${variantIndex + 1}`
      statements.push(`INSERT INTO variants (
  id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
  unit_label, content_quantity, price_gross_cents, weight_grams, width_mm, height_mm, depth_mm,
  source_version
) VALUES (
  ${sqlText(variantId)}, ${productIndex * 100 + variantIndex + 1}, ${sqlText(productId)},
  ${sqlText(taxClassId)}, ${sqlText(shippingProfileId)}, ${sqlText(sku)}, ${sqlText(format)}, 'published',
  ${sqlText(unit?.[1] ?? 'unidad')}, ${unit?.[0] ?? 1}, ${Math.round(euros * 100)},
  ${800 + productIndex * 75}, 300, 200, 100, 'demo-v1'
)
ON CONFLICT (id) DO UPDATE SET
  product_id = excluded.product_id,
  tax_class_id = excluded.tax_class_id,
  shipping_profile_id = excluded.shipping_profile_id,
  sku = excluded.sku,
  format = excluded.format,
  status = excluded.status,
  unit_label = excluded.unit_label,
  content_quantity = excluded.content_quantity,
  price_gross_cents = excluded.price_gross_cents,
  weight_grams = excluded.weight_grams,
  width_mm = excluded.width_mm,
  height_mm = excluded.height_mm,
  depth_mm = excluded.depth_mm,
  source_version = excluded.source_version,
  updated_at = CURRENT_TIMESTAMP;`)
    }
  }

  statements.push('COMMIT;')
  return `${statements.join('\n\n')}\n`
}
