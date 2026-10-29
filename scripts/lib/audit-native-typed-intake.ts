import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { catalogRecord } from '../../tests/support/catalog-tabular-fixture'
import {
  catalogTabularColumns,
  exportCatalogCsv,
  parseCatalogCsv,
  validateCatalogRecords,
  type CatalogTabularRecord
} from '../../shared/catalog-tabular-core'
import { exportCatalogXlsx, parseCatalogXlsx } from '../../server/services/catalog-tabular'
import {
  CATALOG_TYPED_ATTRIBUTE_KINDS,
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeValue
} from '../../shared/catalog-typed-attributes'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  nativeImportPreviewSchema,
  nativeImportReceiptSchema,
  type NativeImportPreview
} from '../../shared/catalog-native-import'
import { catalogImportJobSchema } from '../../shared/catalog-import-job'

export interface NativeTypedIntakeAuditInput {
  database: D1Database
  /** Existing disposable workerd dispatcher, never an external fetch. */
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  definitions: CatalogTypedAttributeDefinition[]
  categoryUuid: string
  referenceProductUuid: string
}

/** Two one-record native lifecycles and one two-record staging-only job.
 * No grants, reference publication, scanner/rights approvals or provider calls
 * are manufactured. Existing caller-owned disposable references are required.
 * This is acceptance evidence only after the caller actually runs it. */
export async function auditNativeTypedIntake(input: NativeTypedIntakeAuditInput) {
  const { database, dispatch, origin, adminCookie, definitions, categoryUuid, referenceProductUuid } = input
  assert.equal(origin, 'https://shop-audit.neteco.test')
  assert(adminCookie)
  catalogPolicyUuidSchema.parse(categoryUuid)
  catalogPolicyUuidSchema.parse(referenceProductUuid)
  assert.equal(definitions.length, 6)
  assert.deepEqual(
    [...definitions.map((definition) => definition.kind)].sort(),
    [...CATALOG_TYPED_ATTRIBUTE_KINDS].sort()
  )
  for (const definition of definitions) {
    assert.equal(definition.categoryUuid, categoryUuid)
    assert.equal(definition.status, 'active')
  }
  assert.equal(catalogTabularColumns.length, 71)
  const references = await database
    .prepare(
      `SELECT
    (SELECT id FROM catalog_sources WHERE is_master=1 ORDER BY id LIMIT 1) AS source,
    (SELECT id FROM brands WHERE status='published' ORDER BY id LIMIT 1) AS brand,
    (SELECT id FROM tax_classes WHERE valid_from<=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      AND (valid_until IS NULL OR valid_until>strftime('%Y-%m-%dT%H:%M:%SZ','now')) ORDER BY id LIMIT 1) AS tax,
    (SELECT id FROM shipping_profiles ORDER BY id LIMIT 1) AS shipping,
    (SELECT id FROM inventory_locations WHERE active=1 AND kind='warehouse' ORDER BY id LIMIT 1) AS warehouse,
    (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse') AS warehouses,
    (SELECT max(legacy_id) FROM products) AS product_max,
    (SELECT max(legacy_id) FROM variants) AS variant_max,
    (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='product') AS product_counter,
    (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='variant') AS variant_counter`
    )
    .first<{
      source: string
      brand: string
      tax: string
      shipping: string
      warehouse: string
      warehouses: number
      product_max: number | null
      variant_max: number | null
      product_counter: number
      variant_counter: number
    }>()
  assert(references, 'Typed intake requires existing disposable catalogue references')
  for (const field of ['source', 'brand', 'tax', 'shipping', 'warehouse'] as const)
    catalogPolicyUuidSchema.parse(references[field])
  assert.equal(references.warehouses, 1)
  const productBase = Math.max(906000000, references.product_max ?? 0, references.product_counter) + 1
  const variantBase = Math.max(906010000, references.variant_max ?? 0, references.variant_counter) + 1
  assert(Number.isSafeInteger(productBase + 3) && Number.isSafeInteger(variantBase + 3))
  const typed = {
    version: 1,
    values: definitions.map((definition) => {
      let value: CatalogTypedAttributeValue
      switch (definition.kind) {
        case 'text':
          value = 'Ñ 😀'
          break
        case 'number':
          value = 0
          break
        case 'unit':
          value = { quantity: 0, unit: definition.config.units[0]! }
          break
        case 'boolean':
          value = false
          break
        case 'list': {
          const option = definition.config.options.find((option) => option.status === 'active')
          assert(option)
          value = [option.code]
          break
        }
        case 'reference':
          value = referenceProductUuid
          break
      }
      return { definitionId: definition.id, revision: definition.revision, value }
    })
  }
  const fixtures = Array.from({ length: 4 }, (_, index) => {
    const product = randomUUID(),
      variant = randomUUID(),
      asset = randomUUID()
    const attributes = {
      image: `/media/${asset}`,
      imageAlt: 'Synthetic typed intake image metadata',
      imageRights: {
        owner: 'NETECO',
        license: 'Synthetic metadata only, not approval',
        authorizedAt: '2026-08-13T12:00:00.000Z'
      },
      attrs: [{ k: 'Legado', v: 'Conservar Ñ 😀' }],
      custom: { values: [0, false, null] },
      typed
    }
    assert(
      validateTypedAttributeValues(typed, definitions, {
        categoryId: definitions[0]!.categoryId,
        productId: product,
        mode: 'write'
      }).success
    )
    const record: CatalogTabularRecord = {
      ...catalogRecord(),
      product_id: product,
      variant_id: variant,
      asset_id: asset,
      product_legacy_id: String(productBase + index),
      variant_legacy_id: String(variantBase + index),
      product_name: `Synthetic typed intake ${index}`,
      product_slug: `typed-intake-${product}`,
      product_status: 'draft',
      variant_status: 'draft',
      category_id: categoryUuid,
      category_status: 'published',
      brand_id: references.brand,
      brand_status: 'published',
      source_id: references.source,
      source_version: 'typed-intake-v1',
      variant_source_version: 'typed-intake-v1',
      tax_class_id: references.tax,
      shipping_profile_id: references.shipping,
      sku: `TYPED-INTAKE-${variant}`.toUpperCase(),
      ean: '',
      gtin: '',
      mpn: `TYPED-INTAKE-${variant}`,
      identifier_exception_reason: 'Synthetic draft only, no publication approval',
      inventory_json: JSON.stringify([
        { locationId: references.warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }
      ]),
      asset_storage_key: `clean/${asset}-typed-intake.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
      asset_license: 'Synthetic metadata only, not approval',
      product_attributes_json: JSON.stringify(attributes)
    }
    assert.deepEqual(validateCatalogRecords([record]).issues, [])
    return { product, variant, asset, attributes, record }
  })
  async function rows(table: string, where = '1', binds: unknown[] = []) {
    return (
      await database
        .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`)
        .bind(...binds)
        .all<Record<string, unknown>>()
    ).results
  }
  const native = fixtures.slice(0, 2)
  const productIds = native.map((fixture) => fixture.product),
    variantIds = native.map((fixture) => fixture.variant),
    assetIds = native.map((fixture) => fixture.asset)
  async function protectedState() {
    return JSON.stringify(
      await Promise.all([
        rows('products', 'id NOT IN (?1,?2)', productIds),
        rows('variants', 'id NOT IN (?1,?2)', variantIds),
        rows('variant_price_versions', 'variant_id NOT IN (?1,?2)', variantIds),
        rows('inventory_balances', 'variant_id NOT IN (?1,?2)', variantIds),
        rows('inventory_movements', 'variant_id NOT IN (?1,?2)', variantIds),
        rows('media_assets', 'id NOT IN (?1,?2)', assetIds),
        rows('product_media', 'product_id NOT IN (?1,?2)', productIds),
        ...[
          'catalog_sources',
          'categories',
          'brands',
          'tax_classes',
          'shipping_profiles',
          'inventory_locations',
          'catalog_typed_attribute_definitions',
          'catalog_typed_attribute_revisions',
          'catalog_typed_attribute_commands',
          'catalog_typed_attribute_audit',
          'permissions',
          'role_permissions',
          'identity_roles',
          'media_uploads',
          'media_scan_receipts',
          'media_rights_decisions',
          'product_media_publications',
          'inventory_reservations',
          'orders',
          'payment_intents',
          'refund_work',
          'fiscal_invoice_intents',
          'fiscal_credit_work'
        ].map((table) => rows(table))
      ])
    )
  }
  const protectedBefore = await protectedState()
  let httpRequests = 0
  async function http(path: string, method = 'GET', body?: unknown, key?: string) {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    assert(
      target.pathname.startsWith('/api/admin/catalog/native-import/') ||
        target.pathname.startsWith('/api/admin/catalog/import-jobs')
    )
    httpRequests++
    const response = await dispatch(
      new Request(target, {
        method,
        redirect: 'manual',
        headers: {
          Origin: origin,
          Cookie: adminCookie,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.155',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === undefined ? {} : { 'Idempotency-Key': key })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.status, 200, `${method} ${target.pathname}: ${await response.clone().text()}`)
    return response
  }
  const auditState = z
    .object({ products: z.array(z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))])) })
    .passthrough()
  function auditedProducts(raw: unknown) {
    assert.equal(typeof raw, 'string')
    assert(typeof raw === 'string')
    return auditState
      .parse(JSON.parse(raw))
      .products.map((row) =>
        Array.isArray(row) ? row.reduce<Record<string, unknown>>((merged, chunk) => ({ ...merged, ...chunk }), {}) : row
      )
  }
  const root = '/api/admin/catalog/native-import'
  async function command(preview: NativeImportPreview, action: 'apply' | 'revert', key: string) {
    const response = await http(
      `${root}/previews/${preview.id}/${action}`,
      'POST',
      {
        previewHash: preview.hash,
        reason: 'Disposable typed CSV/XLSX intake proof, not publication authority'
      },
      key
    )
    const text = await response.text(),
      receipt = nativeImportReceiptSchema.parse(JSON.parse(text))
    assert.equal(receipt.action, action)
    assert.equal(receipt.previewId, preview.id)
    assert.equal(receipt.previewHash, preview.hash)
    return { text, receipt }
  }
  async function lifecycleState(fixture: (typeof fixtures)[number], previewId: string) {
    return JSON.stringify(
      await Promise.all([
        rows('products', 'id=?1', [fixture.product]),
        rows('variants', 'id=?1', [fixture.variant]),
        rows('media_assets', 'id=?1', [fixture.asset]),
        rows('product_media', 'product_id=?1', [fixture.product]),
        rows('variant_price_versions', 'variant_id=?1', [fixture.variant]),
        rows('inventory_balances', 'variant_id=?1', [fixture.variant]),
        rows('inventory_movements', 'variant_id=?1', [fixture.variant]),
        rows('catalog_native_commands', 'preview_id=?1', [previewId]),
        rows('catalog_native_audit', 'command_id IN (SELECT id FROM catalog_native_commands WHERE preview_id=?1)', [
          previewId
        ]),
        rows('catalog_draft_legacy_counters')
      ])
    )
  }
  for (const [index, format] of ['csv', 'xlsx'].entries()) {
    const fixture = native[index]!
    const decoded =
      format === 'csv'
        ? parseCatalogCsv(exportCatalogCsv([fixture.record]))
        : await parseCatalogXlsx(await exportCatalogXlsx([fixture.record]))
    assert.deepEqual(decoded, [fixture.record])
    assert.deepEqual(validateCatalogRecords(decoded).dataset.products[0]!.attributes, fixture.attributes)
    assert.equal((await rows('products', 'id=?1', [fixture.product])).length, 0)
    const preview = nativeImportPreviewSchema.parse(
      await (await http(`${root}/preview`, 'POST', { records: decoded })).json()
    )
    assert.equal(preview.status, 'pending')
    assert.equal((await rows('products', 'id=?1', [fixture.product])).length, 0)
    const applyKey = randomUUID(),
      applied = await command(preview, 'apply', applyKey)
    const product = (await rows('products', 'id=?1', [fixture.product]))[0]!
    assert.equal(product.status, 'draft')
    assert.equal(product.published_at, null)
    assert.equal(typeof product.attributes, 'string')
    assert(typeof product.attributes === 'string')
    assert.deepEqual(JSON.parse(product.attributes), fixture.attributes)
    const asset = (await rows('media_assets', 'id=?1', [fixture.asset]))[0]!
    assert.equal(asset.rights_status, 'pending')
    assert.equal(asset.quarantine_status, 'pending')
    const appliedState = await lifecycleState(fixture, preview.id)
    assert.equal((await command(preview, 'apply', applyKey)).text, applied.text)
    assert.equal(await lifecycleState(fixture, preview.id), appliedState)
    const applyAudit = (await rows('catalog_native_audit', 'command_id=?1', [applied.receipt.commandId]))[0]!
    assert.equal(applyAudit.before_state, null)
    assert.equal(auditedProducts(applyAudit.after_state)[0]!.attributes, product.attributes)
    const revertKey = randomUUID(),
      reverted = await command(preview, 'revert', revertKey)
    const compensated = (await rows('products', 'id=?1', [fixture.product]))[0]!
    assert.equal(compensated.status, 'discontinued')
    assert.equal(compensated.attributes, product.attributes)
    assert.equal((await rows('variants', 'id=?1', [fixture.variant]))[0]!.status, 'discontinued')
    assert.equal((await rows('inventory_balances', 'variant_id=?1', [fixture.variant]))[0]!.physical_quantity, 0)
    assert.equal((await rows('variant_price_versions', 'variant_id=?1', [fixture.variant]))[0]!.status, 'cancelled')
    const revertAudit = (await rows('catalog_native_audit', 'command_id=?1', [reverted.receipt.commandId]))[0]!
    assert.equal(revertAudit.before_state, applyAudit.after_state)
    assert.equal(auditedProducts(revertAudit.before_state)[0]!.attributes, product.attributes)
    assert.equal(auditedProducts(revertAudit.after_state)[0]!.attributes, product.attributes)
    const revertedState = await lifecycleState(fixture, preview.id)
    assert.equal((await command(preview, 'revert', revertKey)).text, reverted.text)
    assert.equal(await lifecycleState(fixture, preview.id), revertedState)
    assert.equal((await rows('catalog_native_commands', 'preview_id=?1', [preview.id])).length, 2)
    assert.equal(await protectedState(), protectedBefore)
  }
  const stagingBefore = JSON.stringify(
    await Promise.all(
      [
        'products',
        'variants',
        'variant_price_versions',
        'inventory_balances',
        'inventory_movements',
        'media_assets',
        'product_media'
      ].map((table) => rows(table))
    )
  )
  const jobsRoot = '/api/admin/catalog/import-jobs'
  const created = catalogImportJobSchema.parse(
    await (await http(jobsRoot, 'POST', { totalPages: 2, recordCount: 2 }, randomUUID())).json()
  )
  for (const [index, fixture] of fixtures.slice(2).entries()) {
    const staged = catalogImportJobSchema.parse(
      await (await http(`${jobsRoot}/${created.id}/pages/${index}`, 'PUT', { index, records: [fixture.record] })).json()
    )
    assert.equal(staged.receivedPages, index + 1)
  }
  const sealed = catalogImportJobSchema.parse(
    await (
      await http(`${jobsRoot}/${created.id}/seal`, 'POST', { reason: 'Synthetic typed staging only, not applied' })
    ).json()
  )
  assert.equal(sealed.status, 'ready')
  assert.deepEqual(sealed.counts, { products: 2, variants: 2, assets: 2, mappings: 2 })
  assert.match(sealed.hash ?? '', /^[0-9a-f]{64}$/)
  for (const fixture of fixtures.slice(2)) {
    const entry = await database
      .prepare("SELECT payload FROM catalog_import_job_entries WHERE job_id=?1 AND kind='products' AND item_id=?2")
      .bind(created.id, fixture.product)
      .first<{ payload: string }>()
    assert(entry)
    assert.deepEqual(JSON.parse(entry.payload).attributes, fixture.attributes)
    assert.equal((await rows('products', 'id=?1', [fixture.product])).length, 0)
  }
  assert.equal(
    JSON.stringify(
      await Promise.all(
        [
          'products',
          'variants',
          'variant_price_versions',
          'inventory_balances',
          'inventory_movements',
          'media_assets',
          'product_media'
        ].map((table) => rows(table))
      )
    ),
    stagingBefore
  )
  assert.equal(await protectedState(), protectedBefore)
  return {
    formats: ['csv', 'xlsx'],
    columns: 71,
    kinds: definitions.map((definition) => definition.kind),
    rowsPerFormat: 1,
    nativeLifecycles: 2,
    replayChecks: 4,
    httpRequests,
    stagedJob: { recordCount: 2, totalPages: 2, status: sealed.status },
    productionAcceptance: false
  }
}
