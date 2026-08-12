import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { CATEGORIES, PRODUCTS } from '../server/db/seed'
import { slugify } from '../server/utils/slug'
import { unitsFor } from '../server/utils/units'

const environment = process.env.APP_ENV ?? 'local'
const connection = process.env.DATABASE_URL?.trim()

if (!connection) throw new Error('DATABASE_URL is required')
if (!['local', 'test', 'demo', 'preview'].includes(environment)) {
  throw new Error(`Synthetic seed is forbidden in ${environment}`)
}

function stableUuid(value: string) {
  const bytes = createHash('sha256').update(`neteco:${value}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const sql = postgres(connection, { max: 1, connect_timeout: 10 })

try {
  await sql.begin(async (transaction) => {
    const sourceId = stableUuid('source:neteco-demo')
    const brandId = stableUuid('brand:neteco')
    const taxClassId = stableUuid('tax:es-general-21')
    const shippingProfileId = stableUuid('shipping:parcel')
    const warehouseId = stableUuid('location:ontinyent')

    await transaction`
      INSERT INTO catalog_sources (id, code, name, owner, kind, is_master)
      VALUES (${sourceId}, 'neteco-demo', 'Catálogo sintético NETECO', 'Producto', 'neteco', true)
      ON CONFLICT (code) DO NOTHING
    `
    await transaction`
      INSERT INTO brands (id, name, slug, status)
      VALUES (${brandId}, 'NETECO', 'neteco', 'published')
      ON CONFLICT (slug) DO NOTHING
    `
    await transaction`
      INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from)
      VALUES (${taxClassId}, 'ES-GENERAL-21', 'IVA general 21 %', 2100, '2020-01-01T00:00:00Z')
      ON CONFLICT (code) DO NOTHING
    `
    await transaction`
      INSERT INTO shipping_profiles (id, code, name, kind)
      VALUES (${shippingProfileId}, 'parcel-standard', 'Paquetería estándar', 'parcel')
      ON CONFLICT (code) DO NOTHING
    `
    await transaction`
      INSERT INTO inventory_locations (id, code, name, kind)
      VALUES (${warehouseId}, 'ONT-WH-01', 'Almacén Ontinyent', 'warehouse')
      ON CONFLICT (code) DO NOTHING
    `

    for (const [legacyId, name, parentLegacyId] of CATEGORIES) {
      const id = stableUuid(`category:${legacyId}`)
      const parentId = parentLegacyId === null ? null : stableUuid(`category:${parentLegacyId}`)
      await transaction`
        INSERT INTO categories (id, legacy_id, parent_id, name, slug, status, sort_order, source_id, source_version)
        VALUES (${id}, ${legacyId}, ${parentId}, ${name}, ${slugify(name)}, 'published', ${legacyId}, ${sourceId}, 'demo-v1')
        ON CONFLICT (id) DO NOTHING
      `
    }

    for (const [productIndex, product] of PRODUCTS.entries()) {
      const productId = stableUuid(`product:${productIndex + 1}`)
      await transaction`
        INSERT INTO products (
          id, legacy_id, category_id, brand_id, source_id, name, slug, short_description,
          description, usage, series, status, featured, attributes, source_version
        ) VALUES (
          ${productId}, ${productIndex + 1}, ${stableUuid(`category:${product.cat}`)}, ${brandId}, ${sourceId},
          ${product.name}, ${slugify(product.name)}, ${product.short}, ${product.desc}, ${product.usage ?? null},
          ${product.series ?? null}, 'published', ${product.featured ?? false},
          ${transaction.json({ badges: product.badges ?? [], visual: { type: product.visual[0], color: product.visual[1] } })},
          'demo-v1'
        ) ON CONFLICT (id) DO UPDATE SET
          category_id = EXCLUDED.category_id,
          brand_id = EXCLUDED.brand_id,
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          short_description = EXCLUDED.short_description,
          description = EXCLUDED.description,
          usage = EXCLUDED.usage,
          series = EXCLUDED.series,
          status = EXCLUDED.status,
          featured = EXCLUDED.featured,
          attributes = EXCLUDED.attributes,
          source_version = EXCLUDED.source_version,
          updated_at = now()
      `

      for (const [variantIndex, [format, euros, sourceSku]] of product.variants.entries()) {
        const variantId = stableUuid(`variant:${productIndex + 1}:${variantIndex + 1}`)
        const unit = unitsFor(format, product.name)
        const sku = sourceSku ?? `NE-${String(productIndex + 1).padStart(3, '0')}-${variantIndex + 1}`
        const grossCents = Math.round(euros * 100)

        await transaction`
          INSERT INTO variants (
            id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
            unit_label, content_quantity, price_gross_cents, weight_grams, width_mm, height_mm, depth_mm,
            source_version
          ) VALUES (
            ${variantId}, ${productIndex * 100 + variantIndex + 1}, ${productId}, ${taxClassId}, ${shippingProfileId},
            ${sku}, ${format}, 'published', ${unit?.[1] ?? 'unidad'}, ${unit?.[0] ?? 1}, ${grossCents},
            ${800 + productIndex * 75}, 300, 200, 100, 'demo-v1'
          ) ON CONFLICT (id) DO UPDATE SET
            product_id = EXCLUDED.product_id,
            tax_class_id = EXCLUDED.tax_class_id,
            shipping_profile_id = EXCLUDED.shipping_profile_id,
            sku = EXCLUDED.sku,
            format = EXCLUDED.format,
            status = EXCLUDED.status,
            unit_label = EXCLUDED.unit_label,
            content_quantity = EXCLUDED.content_quantity,
            price_gross_cents = EXCLUDED.price_gross_cents,
            weight_grams = EXCLUDED.weight_grams,
            width_mm = EXCLUDED.width_mm,
            height_mm = EXCLUDED.height_mm,
            depth_mm = EXCLUDED.depth_mm,
            source_version = EXCLUDED.source_version,
            updated_at = now()
        `
        await transaction`
          INSERT INTO inventory_balances (variant_id, location_id, physical_quantity)
          VALUES (${variantId}, ${warehouseId}, 100)
          ON CONFLICT (variant_id, location_id) DO NOTHING
        `
        await transaction`
          INSERT INTO inventory_movements (
            variant_id, location_id, movement_type, quantity, reference_type, reason, idempotency_key
          ) VALUES (${variantId}, ${warehouseId}, 'initial', 100, 'seed', 'Synthetic demo inventory', ${`seed:${variantId}`})
          ON CONFLICT (idempotency_key) DO NOTHING
        `
      }
    }

    const roles = [
      ['customer', 'Cliente', 'Acceso a recursos propios'],
      ['support', 'Soporte', 'Atención a clientes e incidencias'],
      ['warehouse', 'Almacén', 'Inventario y fulfillment'],
      ['catalog_editor', 'Editor de catálogo', 'Catálogo y contenido en borrador'],
      ['publisher', 'Publicador', 'Aprobación y publicación'],
      ['finance', 'Finanzas', 'Pagos, reembolsos y facturación'],
      ['admin', 'Administrador', 'Administración sin acceso implícito a secretos']
    ] as const
    for (const [code, name, description] of roles) {
      await transaction`
        INSERT INTO roles (code, name, description) VALUES (${code}, ${name}, ${description})
        ON CONFLICT (code) DO NOTHING
      `
    }
  })
} finally {
  await sql.end({ timeout: 5 })
}

process.stdout.write(`seeded synthetic catalog for ${environment}\n`)
