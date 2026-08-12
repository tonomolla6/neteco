import type { TransactionSql } from 'postgres'
import { useDatabase } from '../db/client'
import type { ProductInput } from '../utils/productInput'
import { slugify } from '../utils/slug'
import { unitsFor } from '../utils/units'

interface CatalogActor {
  id: string
}

interface ProductIdentity {
  id: string
  legacyId: number
  name: string
  slug: string
  categoryId: string
}

async function requiredReferences(transaction: TransactionSql, categoryLegacyId: number, brandName?: string | null) {
  const [category] = await transaction<{ id: string }[]>`
    SELECT id FROM categories WHERE legacy_id = ${categoryLegacyId}
  `
  if (!category) throw createError({ statusCode: 400, statusMessage: 'La familia elegida no existe' })
  const normalizedBrand = brandName?.trim() || 'NETECO'
  const brandSlug = slugify(normalizedBrand)
  const [brand] = await transaction<{ id: string }[]>`
    INSERT INTO brands (name, slug, status)
    VALUES (${normalizedBrand}, ${brandSlug}, 'published')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    RETURNING id
  `
  const [tax] = await transaction<{ id: string }[]>`
    SELECT id FROM tax_classes
    WHERE code = 'ES-GENERAL-21' AND valid_from <= now()
      AND (valid_until IS NULL OR valid_until > now())
  `
  const [shipping] = await transaction<{ id: string }[]>`
    SELECT id FROM shipping_profiles WHERE code = 'parcel-standard'
  `
  const [location] = await transaction<{ id: string }[]>`
    SELECT id FROM inventory_locations WHERE code = 'ONT-WH-01'
  `
  if (!brand || !tax || !shipping || !location) throw new Error('Catalog reference data is incomplete')
  return { categoryId: category.id, brandId: brand.id, taxId: tax.id, shippingId: shipping.id, locationId: location.id }
}

async function uniqueProductSlug(transaction: TransactionSql, name: string, legacyId: number, currentId?: string) {
  const base = slugify(name)
  const [collision] = await transaction<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM products WHERE slug = ${base} AND (${currentId ?? null}::uuid IS NULL OR id <> ${currentId ?? null})
    ) AS exists
  `
  return collision?.exists ? `${base}-${legacyId}` : base
}

async function upsertInventory(
  transaction: TransactionSql,
  input: { variantId: string; locationId: string; stock: number; auditKey: string; actorId: string }
) {
  const [current] = await transaction<{ physicalQuantity: number }[]>`
    SELECT physical_quantity AS "physicalQuantity"
    FROM inventory_balances
    WHERE variant_id = ${input.variantId} AND location_id = ${input.locationId}
    FOR UPDATE
  `
  const previous = current?.physicalQuantity ?? 0
  if (current) {
    await transaction`
      UPDATE inventory_balances
      SET physical_quantity = ${input.stock}, version = version + 1, updated_at = now()
      WHERE variant_id = ${input.variantId} AND location_id = ${input.locationId}
    `
  } else {
    await transaction`
      INSERT INTO inventory_balances (variant_id, location_id, physical_quantity)
      VALUES (${input.variantId}, ${input.locationId}, ${input.stock})
    `
  }
  const difference = input.stock - previous
  if (difference !== 0) {
    await transaction`
      INSERT INTO inventory_movements (
        variant_id, location_id, movement_type, quantity, reference_type, actor_id,
        reason, idempotency_key
      ) VALUES (
        ${input.variantId}, ${input.locationId}, 'adjustment', ${difference}, 'catalog_admin',
        ${input.actorId}, 'Admin stock adjustment', ${input.auditKey}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
  }
}

export async function createCatalogProduct(input: ProductInput, actor: CatalogActor, correlationId: string) {
  const sql = useDatabase()
  return sql.begin(async (transaction) => {
    const references = await requiredReferences(transaction, input.categoryId, input.brand)
    const [next] = await transaction<{ legacyId: number }[]>`
      SELECT COALESCE(max(legacy_id), 0)::int + 1 AS "legacyId" FROM products FOR UPDATE
    `
    if (!next) throw new Error('Could not allocate product identifier')
    const slug = await uniqueProductSlug(transaction, input.name, next.legacyId)
    const [product] = await transaction<{ id: string }[]>`
      INSERT INTO products (
        legacy_id, category_id, brand_id, name, slug, short_description, description,
        usage, series, status, featured, attributes, source_version, published_at
      ) VALUES (
        ${next.legacyId}, ${references.categoryId}, ${references.brandId}, ${input.name}, ${slug},
        ${input.shortDesc}, ${input.description}, ${input.usage || null}, ${input.series || null},
        ${input.active ? 'published' : 'draft'}, ${input.featured},
        ${transaction.json({ badges: input.badges, visual: input.visual })}, 'admin-v1',
        ${input.active ? new Date() : null}
      ) RETURNING id
    `
    if (!product) throw new Error('Product insert returned no row')
    for (const [index, variant] of input.variants.entries()) {
      const [nextVariant] = await transaction<{ legacyId: number }[]>`
        SELECT COALESCE(max(legacy_id), 0)::int + 1 AS "legacyId" FROM variants FOR UPDATE
      `
      if (!nextVariant) throw new Error('Could not allocate variant identifier')
      const unit = unitsFor(variant.format, input.name)
      const sku = variant.sku?.trim() || `NE-${next.legacyId}-${index + 1}`
      const [created] = await transaction<{ id: string }[]>`
        INSERT INTO variants (
          legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
          unit_label, content_quantity, price_gross_cents, source_version
        ) VALUES (
          ${nextVariant.legacyId}, ${product.id}, ${references.taxId}, ${references.shippingId},
          ${sku}, ${variant.format}, ${input.active ? 'published' : 'draft'},
          ${unit?.[1] ?? 'unidad'}, ${unit?.[0] ?? 1}, ${Math.round(variant.price * 100)}, 'admin-v1'
        ) RETURNING id
      `
      if (!created) throw new Error('Variant insert returned no row')
      await upsertInventory(transaction, {
        variantId: created.id,
        locationId: references.locationId,
        stock: variant.stock,
        actorId: actor.id,
        auditKey: `catalog:${correlationId}:stock:${created.id}`
      })
    }
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, after_redacted, correlation_id
      ) VALUES (
        'staff', ${actor.id}, 'product.create', 'product', ${String(next.legacyId)},
        ${transaction.json({ name: input.name, categoryId: input.categoryId, variants: input.variants.length })},
        ${correlationId}
      )
    `
    return { id: next.legacyId, slug }
  })
}

export async function updateCatalogProduct(
  legacyId: number,
  input: ProductInput,
  actor: CatalogActor,
  correlationId: string
) {
  const sql = useDatabase()
  return sql.begin(async (transaction) => {
    const [current] = await transaction<ProductIdentity[]>`
      SELECT id, legacy_id AS "legacyId", name, slug, category_id AS "categoryId"
      FROM products WHERE legacy_id = ${legacyId} FOR UPDATE
    `
    if (!current) return null
    const references = await requiredReferences(transaction, input.categoryId, input.brand)
    const slug =
      input.name === current.name
        ? current.slug
        : await uniqueProductSlug(transaction, input.name, legacyId, current.id)
    await transaction`
      UPDATE products SET
        category_id = ${references.categoryId}, brand_id = ${references.brandId}, name = ${input.name},
        slug = ${slug}, short_description = ${input.shortDesc}, description = ${input.description},
        usage = ${input.usage || null}, series = ${input.series || null},
        status = ${input.active ? 'published' : 'draft'}, featured = ${input.featured},
        attributes = ${transaction.json({ badges: input.badges, visual: input.visual })},
        source_version = 'admin-v1', published_at = CASE WHEN ${input.active} THEN COALESCE(published_at, now()) ELSE published_at END,
        updated_at = now()
      WHERE id = ${current.id}
    `
    const existingVariants = await transaction<{ id: string; legacyId: number }[]>`
      SELECT id, legacy_id AS "legacyId" FROM variants WHERE product_id = ${current.id} FOR UPDATE
    `
    const byLegacyId = new Map(existingVariants.map((variant) => [variant.legacyId, variant.id]))
    const kept = new Set<string>()
    for (const [index, variant] of input.variants.entries()) {
      const existingUuid = variant.id === undefined ? undefined : byLegacyId.get(variant.id)
      const unit = unitsFor(variant.format, input.name)
      const sku = variant.sku?.trim() || `NE-${legacyId}-${index + 1}`
      let variantUuid: string
      if (existingUuid) {
        await transaction`
          UPDATE variants SET
            tax_class_id = ${references.taxId}, shipping_profile_id = ${references.shippingId},
            sku = ${sku}, format = ${variant.format}, status = ${input.active ? 'published' : 'draft'},
            unit_label = ${unit?.[1] ?? 'unidad'}, content_quantity = ${unit?.[0] ?? 1},
            price_gross_cents = ${Math.round(variant.price * 100)}, source_version = 'admin-v1', updated_at = now()
          WHERE id = ${existingUuid}
        `
        variantUuid = existingUuid
      } else {
        const [nextVariant] = await transaction<{ legacyId: number }[]>`
          SELECT COALESCE(max(legacy_id), 0)::int + 1 AS "legacyId" FROM variants FOR UPDATE
        `
        const [created] = await transaction<{ id: string }[]>`
          INSERT INTO variants (
            legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
            unit_label, content_quantity, price_gross_cents, source_version
          ) VALUES (
            ${nextVariant!.legacyId}, ${current.id}, ${references.taxId}, ${references.shippingId},
            ${sku}, ${variant.format}, ${input.active ? 'published' : 'draft'},
            ${unit?.[1] ?? 'unidad'}, ${unit?.[0] ?? 1}, ${Math.round(variant.price * 100)}, 'admin-v1'
          ) RETURNING id
        `
        variantUuid = created!.id
      }
      kept.add(variantUuid)
      await upsertInventory(transaction, {
        variantId: variantUuid,
        locationId: references.locationId,
        stock: variant.stock,
        actorId: actor.id,
        auditKey: `catalog:${correlationId}:stock:${variantUuid}`
      })
    }
    for (const variant of existingVariants) {
      if (kept.has(variant.id)) continue
      const [referenced] = await transaction<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM order_lines WHERE variant_id = ${variant.id}) AS exists
      `
      if (referenced?.exists) {
        await transaction`UPDATE variants SET status = 'discontinued', updated_at = now() WHERE id = ${variant.id}`
      } else {
        await transaction`DELETE FROM variants WHERE id = ${variant.id}`
      }
    }
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, correlation_id
      ) VALUES (
        'staff', ${actor.id}, 'product.update', 'product', ${String(legacyId)},
        ${transaction.json({ name: current.name })},
        ${transaction.json({ name: input.name, categoryId: input.categoryId, variants: input.variants.length })},
        ${correlationId}
      )
    `
    return { id: legacyId, slug }
  })
}
