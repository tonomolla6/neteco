import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { validateCatalogRecords } from './catalog-tabular'
import type {
  CatalogImportDataset,
  CatalogTabularIssue,
  CatalogTabularRecord,
  CatalogTabularValidation
} from './catalog-tabular'

export interface CatalogImportPreview {
  valid: boolean
  issues: CatalogTabularIssue[]
  creates: { products: number; variants: number; assets: number; mappings: number }
  checksumSha256: string
}

function checksum(dataset: CatalogImportDataset) {
  const ordered = {
    products: [...dataset.products].sort((left, right) => left.id.localeCompare(right.id)),
    variants: [...dataset.variants].sort((left, right) => left.id.localeCompare(right.id)),
    assets: [...dataset.assets].sort((left, right) => left.id.localeCompare(right.id)),
    media: [...dataset.media].sort((left, right) =>
      `${left.productId}:${left.variantId ?? ''}:${left.assetId}:${left.role}:${left.version}`.localeCompare(
        `${right.productId}:${right.variantId ?? ''}:${right.assetId}:${right.role}:${right.version}`
      )
    )
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

async function databaseIssues(sql: Sql | TransactionSql, dataset: CatalogImportDataset) {
  const issues: CatalogTabularIssue[] = []
  const sourceIds = [...new Set(dataset.products.map((product) => product.sourceId))]
  const categoryIds = [...new Set(dataset.products.map((product) => product.categoryId))]
  const brandIds = [...new Set(dataset.products.map((product) => product.brandId))]
  const taxClassIds = [...new Set(dataset.variants.map((variant) => variant.taxClassId))]
  const shippingProfileIds = [...new Set(dataset.variants.map((variant) => variant.shippingProfileId))]
  const locationIds = [
    ...new Set(dataset.variants.flatMap((variant) => variant.inventory.map((item) => item.locationId)))
  ]
  const eans = dataset.variants.flatMap((item) => (item.ean ? [item.ean] : []))
  const gtins = dataset.variants.flatMap((item) => (item.gtin ? [item.gtin] : []))
  const [references] = await sql<
    {
      sources: number
      categories: number
      brands: number
      taxes: number
      shippingProfiles: number
      locations: number
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM catalog_sources WHERE id IN ${sql(sourceIds)} AND is_master = true) AS sources,
      (SELECT count(*)::int FROM categories WHERE id IN ${sql(categoryIds)}) AS categories,
      (SELECT count(*)::int FROM brands WHERE id IN ${sql(brandIds)}) AS brands,
      (SELECT count(*)::int FROM tax_classes WHERE id IN ${sql(taxClassIds)}) AS taxes,
      (SELECT count(*)::int FROM shipping_profiles WHERE id IN ${sql(shippingProfileIds)}) AS "shippingProfiles",
      (SELECT count(*)::int FROM inventory_locations WHERE id IN ${sql(locationIds)}) AS locations
  `
  for (const [field, actual, expected] of [
    ['source', references!.sources, sourceIds.length],
    ['category', references!.categories, categoryIds.length],
    ['brand', references!.brands, brandIds.length],
    ['tax_class', references!.taxes, taxClassIds.length],
    ['shipping_profile', references!.shippingProfiles, shippingProfileIds.length],
    ['inventory_location', references!.locations, locationIds.length]
  ] as const) {
    if (actual !== expected) issues.push({ code: `reference.${field}`, message: `${field} references are incomplete` })
  }
  if (sourceIds.length !== 1) {
    issues.push({ code: 'reference.source_batch', message: 'Import batch requires one master source' })
  }
  const categoryStatuses = new Map(dataset.products.map((item) => [item.categoryId, item.categoryStatus]))
  const brandStatuses = new Map(dataset.products.map((item) => [item.brandId, item.brandStatus]))
  const statusRows = await sql<{ kind: string; id: string; status: string }[]>`
    SELECT 'category' AS kind, id::text, status FROM categories WHERE id IN ${sql(categoryIds)}
    UNION ALL SELECT 'brand', id::text, status FROM brands WHERE id IN ${sql(brandIds)}
  `
  for (const row of statusRows) {
    const declared = row.kind === 'category' ? categoryStatuses.get(row.id) : brandStatuses.get(row.id)
    if (declared !== row.status) {
      issues.push({ code: `reference.${row.kind}_status`, message: `${row.kind} status differs from the database` })
    }
  }

  const [conflicts] = await sql<
    {
      products: number
      productLegacyIds: number
      variants: number
      variantLegacyIds: number
      skus: number
      identifiers: number
      assets: number
      storageKeys: number
      checksums: number
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM products WHERE id IN ${sql(dataset.products.map((item) => item.id))}
        OR slug IN ${sql(dataset.products.map((item) => item.slug))}) AS products,
      (SELECT count(*)::int FROM products
        WHERE legacy_id IN ${sql(dataset.products.map((item) => item.legacyId))}) AS "productLegacyIds",
      (SELECT count(*)::int FROM variants WHERE id IN ${sql(dataset.variants.map((item) => item.id))}) AS variants,
      (SELECT count(*)::int FROM variants
        WHERE legacy_id IN ${sql(dataset.variants.map((item) => item.legacyId))}) AS "variantLegacyIds",
      (SELECT count(*)::int FROM variants WHERE sku IN ${sql(dataset.variants.map((item) => item.sku))}) AS skus,
      (SELECT count(*)::int FROM variants
        WHERE ean IN ${sql(eans.length ? eans : [''])}
           OR gtin IN ${sql(gtins.length ? gtins : [''])}) AS identifiers,
      (SELECT count(*)::int FROM media_assets WHERE id IN ${sql(dataset.assets.map((item) => item.id))}) AS assets,
      (SELECT count(*)::int FROM media_assets
        WHERE storage_key IN ${sql(dataset.assets.map((item) => item.storageKey))}) AS "storageKeys",
      (SELECT count(*)::int FROM media_assets
        WHERE checksum_sha256 IN ${sql(dataset.assets.map((item) => item.checksumSha256))}) AS checksums
  `
  for (const [field, count] of Object.entries(conflicts!)) {
    if (count) issues.push({ code: `database.${field}_conflict`, message: `${field} already exist in the catalog` })
  }
  return issues
}

async function importPreview(
  sql: Sql | TransactionSql,
  validation: CatalogTabularValidation
): Promise<CatalogImportPreview> {
  const issues = [...validation.issues]
  if (validation.valid) issues.push(...(await databaseIssues(sql, validation.dataset)))
  return {
    valid: issues.length === 0,
    issues,
    creates: {
      products: validation.dataset.products.length,
      variants: validation.dataset.variants.length,
      assets: validation.dataset.assets.length,
      mappings: validation.dataset.media.length
    },
    checksumSha256: checksum(validation.dataset)
  }
}

export async function previewCatalogImport(
  sql: Sql,
  validation: CatalogTabularValidation
): Promise<CatalogImportPreview> {
  return importPreview(sql, validation)
}

export async function applyCatalogImport(sql: Sql, validation: CatalogTabularValidation, version: string) {
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(version)) throw new Error('Catalog import version is invalid')
  const sourceVersions = [...new Set(validation.dataset.products.map((product) => product.sourceVersion))]
  const variantSourceVersions = [...new Set(validation.dataset.variants.map((variant) => variant.sourceVersion))]
  if (
    sourceVersions.length !== 1 ||
    sourceVersions[0] !== version ||
    variantSourceVersions.length !== 1 ||
    variantSourceVersions[0] !== version
  ) {
    throw new Error('Catalog import version must match every source_version value')
  }
  const dataset = validation.dataset
  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:catalog-import'))`
    const preview = await importPreview(transaction, validation)
    if (!preview.valid) throw new Error(`Catalog import validation failed: ${JSON.stringify(preview.issues)}`)
    const sourceId = dataset.products[0]!.sourceId
    const [batch] = await transaction<{ id: string }[]>`
      INSERT INTO catalog_import_batches (
        source_id, source_version, checksum_sha256, status, preview_summary, validation_report
      ) VALUES (
        ${sourceId}, ${version}, ${preview.checksumSha256}, 'validated',
        ${transaction.json({
          ...preview.creates,
          manifest: {
            productIds: dataset.products.map((item) => item.id),
            variantIds: dataset.variants.map((item) => item.id),
            assetIds: dataset.assets.map((item) => item.id),
            releaseId: null
          }
        })}, '[]'::jsonb
      ) RETURNING id
    `
    for (const asset of dataset.assets) {
      await transaction`
        INSERT INTO media_assets (
          id, storage_key, original_name, mime_type, byte_size, checksum_sha256, owner_name,
          source_url, license, authorized_at, rights_status, quarantine_status, alt_text, metadata
        ) VALUES (
          ${asset.id}, ${asset.storageKey}, ${asset.originalName}, ${asset.mimeType}, ${asset.byteSize},
          ${asset.checksumSha256}, ${asset.ownerName}, ${asset.sourceUrl}, ${asset.license}, ${asset.authorizedAt},
          ${asset.rightsStatus}, ${asset.quarantineStatus}, ${asset.altText}, ${transaction.json(asset.metadata)}
        )
      `
    }
    for (const product of dataset.products) {
      await transaction`
        INSERT INTO products (
          id, legacy_id, category_id, brand_id, source_id, name, slug, short_description, description,
          usage, series, status, featured, attributes, regulatory, source_version, published_at
        ) VALUES (
          ${product.id}, ${product.legacyId}, ${product.categoryId}, ${product.brandId}, ${product.sourceId}, ${product.name},
          ${product.slug}, ${product.shortDescription}, ${product.description}, ${product.usage}, ${product.series},
          ${product.status}, ${product.featured}, ${transaction.json(product.attributes)},
          ${transaction.json(product.regulatory)}, ${product.sourceVersion},
          ${product.status === 'published' ? new Date() : null}
        )
      `
    }
    for (const variant of dataset.variants) {
      await transaction`
        INSERT INTO variants (
          id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, ean, gtin, mpn,
          identifier_exception_reason, format, status, unit_base, unit_label, content_quantity,
          units_per_case, cases_per_pallet, minimum_quantity, quantity_increment, maximum_quantity,
          price_gross_cents, compare_at_gross_cents, cost_net_cents, currency, weight_grams,
          width_mm, height_mm, depth_mm, safety_stock, backorder_allowed, lead_time_days, color, image, source_version
        ) VALUES (
          ${variant.id}, ${variant.legacyId}, ${variant.productId}, ${variant.taxClassId}, ${variant.shippingProfileId}, ${variant.sku},
          ${variant.ean}, ${variant.gtin}, ${variant.mpn}, ${variant.identifierExceptionReason}, ${variant.format},
          ${variant.status}, ${variant.unitBase}, ${variant.unitLabel}, ${variant.contentQuantity},
          ${variant.unitsPerCase}, ${variant.casesPerPallet}, ${variant.minimumQuantity},
          ${variant.quantityIncrement}, ${variant.maximumQuantity}, ${variant.priceGrossCents},
          ${variant.compareAtGrossCents}, ${variant.costNetCents}, ${variant.currency}, ${variant.weightGrams},
          ${variant.widthMm}, ${variant.heightMm}, ${variant.depthMm}, ${variant.safetyStock},
          ${variant.backorderAllowed}, ${variant.leadTimeDays}, ${variant.color}, ${variant.image},
          ${variant.sourceVersion}
        )
      `
      for (const balance of variant.inventory) {
        await transaction`
          INSERT INTO inventory_balances (
            variant_id, location_id, physical_quantity, blocked_quantity, version
          ) VALUES (
            ${variant.id}, ${balance.locationId}, ${balance.physicalQuantity},
            ${balance.blockedQuantity}, ${balance.version}
          )
        `
      }
    }
    for (const mapping of dataset.media) {
      await transaction`
        INSERT INTO product_media (product_id, variant_id, asset_id, role, version, sort_order)
        VALUES (${mapping.productId}, ${mapping.variantId}, ${mapping.assetId}, ${mapping.role},
                ${mapping.version}, ${mapping.sortOrder})
      `
    }
    await transaction`
      UPDATE catalog_import_batches SET status = 'applied', applied_at = now() WHERE id = ${batch!.id}
    `
    const [release] = await transaction<{ id: string }[]>`
      INSERT INTO catalog_releases (
        version, checksum_sha256, import_batch_id, status, product_count, variant_count, manifest, released_at
      ) VALUES (
        ${version}, ${preview.checksumSha256}, ${batch!.id}, 'released', ${dataset.products.length},
        ${dataset.variants.length}, ${transaction.json({ format: 'neteco-catalog-tabular-v1' })}, now()
      ) RETURNING id
    `
    await transaction`
      UPDATE catalog_import_batches
      SET preview_summary = jsonb_set(preview_summary, '{manifest,releaseId}', to_jsonb(${release!.id}::text))
      WHERE id = ${batch!.id}
    `
    return { batchId: batch!.id, ...preview }
  })
}

export async function rollbackCatalogImport(sql: Sql, batchId: string) {
  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:catalog-import'))`
    const [batch] = await transaction<
      { status: string; productIds: string[]; variantIds: string[]; assetIds: string[]; releaseId: string | null }[]
    >`
      SELECT status, ARRAY(SELECT jsonb_array_elements_text(preview_summary -> 'manifest' -> 'productIds')) AS "productIds",
        ARRAY(SELECT jsonb_array_elements_text(preview_summary -> 'manifest' -> 'variantIds')) AS "variantIds",
        ARRAY(SELECT jsonb_array_elements_text(preview_summary -> 'manifest' -> 'assetIds')) AS "assetIds",
        preview_summary #>> '{manifest,releaseId}' AS "releaseId"
      FROM catalog_import_batches WHERE id = ${batchId} FOR UPDATE
    `
    if (!batch) throw new Error('Catalog import batch was not found')
    if (batch.status !== 'applied') throw new Error('Only an applied catalog import can be rolled back')
    const [externalUses] = await transaction<{ count: number }[]>`
      SELECT (
        (SELECT count(*) FROM brands WHERE logo_asset_id IN ${transaction(batch.assetIds)}) +
        (SELECT count(*) FROM product_media
         WHERE asset_id IN ${transaction(batch.assetIds)} AND product_id NOT IN ${transaction(batch.productIds)}) +
        (SELECT count(*) FROM products external_product
         WHERE external_product.id NOT IN ${transaction(batch.productIds)}
           AND EXISTS (SELECT 1 FROM media_assets imported_asset
             WHERE imported_asset.id IN ${transaction(batch.assetIds)}
               AND external_product.attributes::text LIKE '%/media/' || imported_asset.id::text || '%'))
      )::int AS count
    `
    if (externalUses!.count) throw new Error('Imported assets are referenced outside the catalog batch')
    if (batch.releaseId) {
      await transaction`UPDATE catalog_releases SET status = 'rolled_back' WHERE id = ${batch.releaseId}`
    }
    await transaction`DELETE FROM product_media WHERE product_id IN ${transaction(batch.productIds)}`
    await transaction`DELETE FROM inventory_balances WHERE variant_id IN ${transaction(batch.variantIds)}`
    await transaction`DELETE FROM variants WHERE id IN ${transaction(batch.variantIds)}`
    await transaction`DELETE FROM products WHERE id IN ${transaction(batch.productIds)}`
    await transaction`DELETE FROM media_assets WHERE id IN ${transaction(batch.assetIds)}`
    await transaction`UPDATE catalog_import_batches SET status = 'rolled_back' WHERE id = ${batchId}`
    return { batchId, status: 'rolled_back' as const }
  })
}

export async function catalogRecordsFromDatabase(
  sql: Sql,
  filters: { status?: string; sourceId?: string } = {}
): Promise<CatalogTabularRecord[]> {
  const records = await sql<CatalogTabularRecord[]>`
    SELECT product.id::text AS product_id, product.legacy_id::text AS product_legacy_id,
      product.name AS product_name, product.slug AS product_slug,
      product.status AS product_status, COALESCE(product.short_description, '') AS short_description,
      COALESCE(product.description, '') AS description, category.id::text AS category_id,
      category.status AS category_status, brand.id::text AS brand_id, brand.status AS brand_status,
      product.source_id::text AS source_id, COALESCE(product.source_version, '') AS source_version,
      COALESCE(product.usage, '') AS product_usage, COALESCE(product.series, '') AS product_series,
      product.featured::text AS product_featured, product.attributes::text AS product_attributes_json,
      product.regulatory::text AS product_regulatory_json,
      variant.id::text AS variant_id, variant.legacy_id::text AS variant_legacy_id,
      variant.sku, COALESCE(variant.ean, '') AS ean,
      COALESCE(variant.gtin, '') AS gtin, COALESCE(variant.mpn, '') AS mpn,
      COALESCE(variant.identifier_exception_reason, '') AS identifier_exception_reason, variant.format,
      variant.status AS variant_status, COALESCE(variant.source_version, '') AS variant_source_version,
      variant.tax_class_id::text AS tax_class_id,
      variant.shipping_profile_id::text AS shipping_profile_id, variant.price_gross_cents::text,
      COALESCE(variant.compare_at_gross_cents::text, '') AS compare_at_gross_cents,
      COALESCE(variant.cost_net_cents::text, '') AS cost_net_cents, variant.currency,
      variant.unit_base, variant.unit_label, variant.content_quantity::text,
      variant.units_per_case::text AS units_per_case,
      COALESCE(variant.cases_per_pallet::text, '') AS cases_per_pallet, variant.minimum_quantity::text,
      variant.quantity_increment::text, COALESCE(variant.maximum_quantity::text, '') AS maximum_quantity,
      variant.weight_grams::text, variant.width_mm::text, variant.height_mm::text, variant.depth_mm::text,
      variant.safety_stock::text AS safety_stock,
      variant.backorder_allowed::text, COALESCE(variant.lead_time_days::text, '') AS lead_time_days,
      COALESCE(variant.color, '') AS variant_color, COALESCE(variant.image, '') AS variant_image,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'locationId', balance.location_id, 'physicalQuantity', balance.physical_quantity,
          'blockedQuantity', balance.blocked_quantity, 'version', balance.version
        ) ORDER BY balance.location_id)::text
        FROM inventory_balances balance WHERE balance.variant_id = variant.id
      ), '[]') AS inventory_json,
      CASE WHEN product.regulatory ->> 'requiresSds' = 'true' THEN 'true' ELSE 'false' END AS requires_sds,
      asset.id::text AS asset_id, asset.storage_key AS asset_storage_key, asset.original_name AS asset_original_name,
      asset.mime_type AS asset_mime_type, asset.byte_size::text AS asset_byte_size,
      asset.checksum_sha256 AS asset_checksum_sha256, COALESCE(asset.owner_name, '') AS asset_owner_name,
      COALESCE(asset.source_url, '') AS asset_source_url, COALESCE(asset.license, '') AS asset_license,
      to_char(asset.authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS asset_authorized_at,
      asset.rights_status AS asset_rights_status,
      asset.quarantine_status AS asset_quarantine_status, COALESCE(asset.alt_text, '') AS asset_alt_text,
      asset.metadata::text AS asset_metadata_json,
      media.role AS media_role, COALESCE(media.variant_id::text, '') AS media_variant_id,
      media.version AS media_version, media.sort_order::text AS media_sort_order
    FROM products product
    JOIN categories category ON category.id = product.category_id
    JOIN brands brand ON brand.id = product.brand_id
    JOIN variants variant ON variant.product_id = product.id
    JOIN product_media media ON media.product_id = product.id
      AND (media.variant_id IS NULL OR media.variant_id = variant.id)
    JOIN media_assets asset ON asset.id = media.asset_id
    WHERE (${filters.status ?? null}::text IS NULL OR product.status = ${filters.status ?? null})
      AND (${filters.sourceId ?? null}::uuid IS NULL OR product.source_id = ${filters.sourceId ?? null}::uuid)
    ORDER BY product.slug, variant.sku, media.sort_order, asset.storage_key
  `
  const selected = await sql<{ id: string }[]>`
    SELECT id::text FROM products
    WHERE (${filters.status ?? null}::text IS NULL OR status = ${filters.status ?? null})
      AND (${filters.sourceId ?? null}::uuid IS NULL OR source_id = ${filters.sourceId ?? null}::uuid)
  `
  const represented = new Set(records.map((record) => record.product_id))
  const omitted = selected.filter((product) => !represented.has(product.id))
  if (omitted.length) throw new Error(`Catalog export omitted ${omitted.length} products without complete relations`)
  const selectedVariants = await sql<{ id: string }[]>`
    SELECT variant.id::text
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    WHERE (${filters.status ?? null}::text IS NULL OR product.status = ${filters.status ?? null})
      AND (${filters.sourceId ?? null}::uuid IS NULL OR product.source_id = ${filters.sourceId ?? null}::uuid)
  `
  const representedVariants = new Set(records.map((record) => record.variant_id))
  const omittedVariants = selectedVariants.filter((variant) => !representedVariants.has(variant.id))
  if (omittedVariants.length) {
    throw new Error(`Catalog export omitted ${omittedVariants.length} variants without media mappings`)
  }
  if (records.length) {
    const validation = validateCatalogRecords(records)
    if (!validation.valid) throw new Error(`Catalog export validation failed: ${JSON.stringify(validation.issues)}`)
  }
  return records
}
