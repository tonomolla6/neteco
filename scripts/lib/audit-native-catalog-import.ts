import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { catalogRecord } from '../../tests/support/catalog-tabular-fixture'
import {
  nativeImportInvalidSchema,
  nativeImportPreviewSchema,
  nativeImportReceiptSchema,
  type NativeImportPreview
} from '../../shared/catalog-native-import'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import { catalogImportJobSchema } from '../../shared/catalog-import-job'
import { catalogImportJobReceiptSchema } from '../../shared/catalog-import-job-commands'
import {
  catalogImportJobReviewEntrySchema,
  projectCatalogImportJobReviewEntry
} from '../../shared/catalog-import-job-review'
import type { CatalogImportJobReview } from '../../workers/catalog/import-job'
import type { CatalogTabularRecord } from '../../shared/catalog-tabular-core'

export interface NativeCatalogImportAuditInput {
  /** Existing disposable Worker dispatcher, never an external fetch. */
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  scenario: (name: string) => void
  onBrowserFixtures?: (fixtures: {
    records: CatalogTabularRecord[]
    jobRecords: CatalogTabularRecord[]
  }) => Promise<void>
}

/** Dedicated draft records only. Existing references and live permissions must
 * already be present; this proof never creates grants or publication authority. */
export async function auditNativeCatalogImport(input: NativeCatalogImportAuditInput) {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, scenario } = input
  assert.equal(origin, 'https://shop-audit.neteco.test')
  assert(adminCookie && unprivilegedCookie && adminCookie !== unprivilegedCookie)
  const root = '/api/admin/catalog/native-import'
  const references = await database
    .prepare(
      `SELECT
    (SELECT id FROM catalog_sources WHERE is_master=1 ORDER BY id LIMIT 1) AS source,
    (SELECT id FROM categories WHERE status='published' ORDER BY legacy_id LIMIT 1) AS category,
    (SELECT id FROM brands WHERE status='published' ORDER BY id LIMIT 1) AS brand,
    (SELECT id FROM tax_classes WHERE strftime('%Y-%m-%dT%H:%M:%fZ',valid_from) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (valid_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)>strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY id LIMIT 1) AS tax,
    (SELECT id FROM shipping_profiles ORDER BY id LIMIT 1) AS shipping,
    (SELECT id FROM inventory_locations WHERE active=1 AND kind='warehouse' ORDER BY id LIMIT 1) AS warehouse,
    (SELECT count(*) FROM inventory_locations WHERE active=1 AND kind='warehouse') AS warehouse_count,
    (SELECT max(legacy_id) FROM products) AS product_max,
    (SELECT max(legacy_id) FROM variants) AS variant_max,
    (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='product') AS product_counter,
    (SELECT last_id FROM catalog_draft_legacy_counters WHERE entity='variant') AS variant_counter`
    )
    .first<{
      source: string
      category: string
      brand: string
      tax: string
      shipping: string
      warehouse: string
      warehouse_count: number
      product_max: number | null
      variant_max: number | null
      product_counter: number
      variant_counter: number
    }>()
  assert(references, 'Native import proof requires the existing disposable catalog references')
  for (const field of ['source', 'category', 'brand', 'tax', 'shipping', 'warehouse'] as const)
    catalogPolicyUuidSchema.parse(references[field])
  assert.equal(references.warehouse_count, 1, 'Native import proof requires exactly one existing active warehouse')
  const warehouseId = references.warehouse
  const baseProduct = Math.max(905400000, references.product_max ?? 0, references.product_counter) + 1
  const baseVariant = Math.max(905410000, references.variant_max ?? 0, references.variant_counter) + 1
  assert(Number.isSafeInteger(baseProduct + 1) && Number.isSafeInteger(baseVariant + 1))
  const fixtures = [0, 1].map((index) => {
    const product = randomUUID(),
      variant = randomUUID(),
      asset = randomUUID()
    const record = {
      ...catalogRecord(),
      product_id: product,
      variant_id: variant,
      asset_id: asset,
      product_legacy_id: String(baseProduct + index),
      variant_legacy_id: String(baseVariant + index),
      product_name: `Importación nativa sintética ${index}`,
      product_slug: `native-import-proof-${product}`,
      product_status: 'draft',
      variant_status: 'draft',
      category_id: references.category,
      category_status: 'published',
      brand_id: references.brand,
      brand_status: 'published',
      source_id: references.source,
      source_version: 'native-audit-v1',
      variant_source_version: 'native-audit-v1',
      tax_class_id: references.tax,
      shipping_profile_id: references.shipping,
      sku: `NATIVE-AUDIT-${variant}`.toUpperCase(),
      ean: '',
      gtin: '',
      mpn: `NATIVE-PROOF-${variant}`,
      identifier_exception_reason: 'Synthetic draft has no registered global product identifier',
      inventory_json: JSON.stringify([
        { locationId: references.warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }
      ]),
      asset_storage_key: `clean/${asset}-native-audit.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
      product_attributes_json: JSON.stringify({
        image: `/media/${asset}`,
        imageAlt: 'Synthetic local import evidence',
        imageRights: {
          owner: 'NETECO',
          license: 'Synthetic metadata only, not approval',
          authorizedAt: '2026-08-13T12:00:00.000Z'
        }
      })
    }
    return { product, variant, asset, record }
  })
  const productIds = fixtures.map((fixture) => fixture.product),
    variantIds = fixtures.map((fixture) => fixture.variant),
    assetIds = fixtures.map((fixture) => fixture.asset)
  async function rows(table: string, where = '1', binds: unknown[] = []) {
    return (
      await database
        .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`)
        .bind(...binds)
        .all<Record<string, unknown>>()
    ).results
  }
  async function ownedState() {
    const values = await Promise.all([
      rows('products', 'id IN (?1,?2)', productIds),
      rows('variants', 'id IN (?1,?2)', variantIds),
      rows('variant_price_versions', 'variant_id IN (?1,?2)', variantIds),
      rows('inventory_balances', 'variant_id IN (?1,?2)', variantIds),
      rows('inventory_movements', 'variant_id IN (?1,?2)', variantIds),
      rows('media_assets', 'id IN (?1,?2)', assetIds),
      rows('product_media', 'product_id IN (?1,?2)', productIds),
      rows('catalog_native_commands'),
      rows('catalog_native_audit'),
      rows('catalog_draft_legacy_counters'),
      rows('catalog_native_guards')
    ])
    return JSON.stringify(values)
  }
  let commandJobId: string | null = null
  const outsideJob = (column: string, kind: string) =>
    `${column} NOT IN (?1,?2) AND ${column} NOT IN (SELECT item_id FROM catalog_import_job_entries WHERE job_id=?3 AND kind='${kind}')`
  async function protectedState() {
    const values = await Promise.all([
      rows('products', outsideJob('id', 'products'), [...productIds, commandJobId]),
      rows('variants', outsideJob('id', 'variants'), [...variantIds, commandJobId]),
      rows('variant_price_versions', outsideJob('variant_id', 'variants'), [...variantIds, commandJobId]),
      rows('inventory_balances', outsideJob('variant_id', 'variants'), [...variantIds, commandJobId]),
      rows('inventory_movements', outsideJob('variant_id', 'variants'), [...variantIds, commandJobId]),
      rows('media_assets', outsideJob('id', 'assets'), [...assetIds, commandJobId]),
      rows('product_media', outsideJob('product_id', 'products'), [...productIds, commandJobId]),
      ...[
        'media_uploads',
        'media_scan_receipts',
        'media_rights_decisions',
        'product_media_publications',
        'inventory_reservations',
        'orders',
        'payment_intents',
        'refund_work',
        'fiscal_invoice_intents',
        'fiscal_credit_work',
        'catalog_editorial_commands',
        'catalog_editorial_audit',
        'permissions',
        'role_permissions',
        'identity_roles',
        'catalog_sources',
        'categories',
        'brands',
        'tax_classes',
        'shipping_profiles',
        'inventory_locations'
      ].map((table) => rows(table))
    ])
    return JSON.stringify(values)
  }
  const protectedBefore = await protectedState(),
    initialOwned = await ownedState()
  const initialPreviews = (await rows('catalog_native_previews')).length
  let scenarios = 0,
    httpRequests = 0
  function mark(name: string) {
    scenario(name)
    scenarios++
  }
  async function http(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
    cookie = adminCookie,
    requestOrigin = origin
  ) {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    assert(
      target.pathname.startsWith(root) ||
        target.pathname.startsWith('/api/admin/products/') ||
        target.pathname.startsWith('/api/admin/catalog/import-jobs')
    )
    httpRequests++
    const response = await dispatch(
      new Request(target, {
        method,
        redirect: 'manual',
        headers: {
          Origin: requestOrigin,
          Cookie: cookie,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '192.0.2.156',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === undefined ? {} : { 'Idempotency-Key': key })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    return response
  }
  async function denied(response: Response, status: number, code: string) {
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: { code } })
  }
  async function preview(index: number) {
    const response = await http(`${root}/preview`, 'POST', { records: [fixtures[index]!.record] })
    assert.equal(response.status, 200)
    const result = nativeImportPreviewSchema.parse(await response.json())
    assert.deepEqual(result.counts, { products: 1, variants: 1, assets: 1, mappings: 1 })
    assert.equal(result.status, 'pending')
    assert.equal(Date.parse(result.expiresAt) - Date.parse(result.createdAt), 30 * 60_000)
    return result
  }
  const reason = 'Disposable native HTTP import audit; no publication approval'
  async function command(preview: NativeImportPreview, action: 'apply' | 'revert', key: string) {
    const response = await http(
      `${root}/previews/${preview.id}/${action}`,
      'POST',
      { previewHash: preview.hash, reason },
      key
    )
    assert.equal(response.status, 200)
    const text = await response.text(),
      receipt = nativeImportReceiptSchema.parse(JSON.parse(text))
    assert.equal(receipt.previewId, preview.id)
    assert.equal(receipt.previewHash, preview.hash)
    assert.equal(receipt.action, action)
    return { text, receipt }
  }

  mark('native_full_import_current_auth_csrf_no_domain_effects')
  await denied(
    await http(`${root}/preview`, 'POST', { records: [fixtures[0]!.record] }, undefined, ''),
    401,
    'unauthenticated'
  )
  await denied(
    await http(`${root}/preview`, 'POST', { records: [fixtures[0]!.record] }, undefined, unprivilegedCookie),
    403,
    'mfa_required'
  )
  await denied(
    await http(
      `${root}/preview`,
      'POST',
      { records: [fixtures[0]!.record] },
      undefined,
      adminCookie,
      'https://cross-site.invalid'
    ),
    403,
    'csrf_rejected'
  )
  assert.equal(await ownedState(), initialOwned)
  mark('native_full_import_inert_private_full_tabular_preview')
  const first = await preview(0)
  assert.equal(await ownedState(), initialOwned)
  assert.equal((await rows('catalog_native_previews')).length, initialPreviews + 1)
  const read = await http(`${root}/previews/${first.id}`)
  assert.equal(read.status, 200)
  assert.deepEqual(nativeImportPreviewSchema.parse(await read.json()), first)
  await denied(
    await http(`${root}/previews/${first.id}`, 'GET', undefined, undefined, unprivilegedCookie),
    403,
    'mfa_required'
  )
  mark('native_full_import_hash_mismatch_is_409_before_creation')
  await denied(
    await http(`${root}/previews/${first.id}/apply`, 'POST', { previewHash: '0'.repeat(64), reason }, randomUUID()),
    409,
    'version_conflict'
  )
  assert.equal(await ownedState(), initialOwned)
  mark('native_full_import_atomic_initial_price_stock_ledger_draft_and_pending_media')
  const key = randomUUID(),
    applied = await command(first, 'apply', key),
    fixture = fixtures[0]!
  const product = (await rows('products', 'id=?1', [fixture.product]))[0]!,
    variant = (await rows('variants', 'id=?1', [fixture.variant]))[0]!
  assert.equal(product.status, 'draft')
  assert.equal(product.published_at, null)
  assert.equal(product.description, fixture.record.description)
  assert.equal(variant.status, 'draft')
  assert.equal(variant.price_gross_cents, 1599)
  assert.equal(variant.sku, fixture.record.sku)
  const balances = await rows('inventory_balances', 'variant_id=?1', [fixture.variant]),
    prices = await rows('variant_price_versions', 'variant_id=?1', [fixture.variant])
  assert.equal(balances.length, 1)
  assert.equal(balances[0]!.location_id, references.warehouse)
  assert.equal(balances[0]!.physical_quantity, 40)
  assert.equal(balances[0]!.blocked_quantity, 2)
  assert.equal(prices.length, 1)
  assert.equal(prices[0]!.gross_cents, 1599)
  assert.equal(prices[0]!.status, 'approved')
  const initialMovements = await rows('inventory_movements', 'variant_id=?1', [fixture.variant])
  assert.equal(initialMovements.length, 1)
  assert.equal(initialMovements[0]!.physical_delta, 40)
  assert.equal(initialMovements[0]!.reference_id, applied.receipt.commandId)
  const commandRow = (await rows('catalog_native_commands', 'id=?1', [applied.receipt.commandId]))[0]!
  assert.equal(commandRow.reason, reason)
  assert.equal(prices[0]!.created_by, commandRow.actor_id)
  assert.equal(initialMovements[0]!.reason, reason)
  const asset = (await rows('media_assets', 'id=?1', [fixture.asset]))[0]!
  assert.equal(asset.rights_status, 'pending')
  assert.equal(asset.quarantine_status, 'pending')
  assert.equal((await rows('product_media', 'product_id=?1', [fixture.product])).length, 1)
  assert.equal(await protectedState(), protectedBefore)
  mark('native_full_import_durable_byte_exact_replay_without_duplicate_effects')
  const afterApply = await ownedState()
  assert.equal((await command(first, 'apply', key)).text, applied.text)
  assert.equal(await ownedState(), afterApply)
  mark('native_full_import_altered_key_payload_and_second_key_conflicts_without_effects')
  await denied(
    await http(
      `${root}/previews/${first.id}/apply`,
      'POST',
      { previewHash: first.hash, reason: 'Altered synthetic reason' },
      key
    ),
    409,
    'idempotency_conflict'
  )
  await denied(
    await http(`${root}/previews/${first.id}/apply`, 'POST', { previewHash: first.hash, reason }, randomUUID()),
    409,
    'already_applied'
  )
  assert.equal(await ownedState(), afterApply)
  mark('native_full_import_unauthorized_cookie_cannot_replay_durable_receipt')
  await denied(
    await http(
      `${root}/previews/${first.id}/apply`,
      'POST',
      { previewHash: first.hash, reason },
      key,
      unprivilegedCookie
    ),
    403,
    'mfa_required'
  )
  await denied(
    await http(`${root}/previews/${first.id}/apply`, 'POST', { previewHash: first.hash, reason }, key, ''),
    401,
    'unauthenticated'
  )
  assert.equal(await ownedState(), afterApply)
  mark('native_full_import_compensating_revert_retains_evidence_and_monotonic_counters')
  const countersBefore = await rows('catalog_draft_legacy_counters'),
    reverted = await command(first, 'revert', randomUUID())
  assert.equal((await rows('products', 'id=?1', [fixture.product]))[0]!.status, 'discontinued')
  assert.equal((await rows('variants', 'id=?1', [fixture.variant]))[0]!.status, 'discontinued')
  const compensated = await rows('inventory_movements', 'variant_id=?1', [fixture.variant])
  assert.equal(compensated.length, 2)
  assert.deepEqual(compensated[0], initialMovements[0])
  assert.equal(compensated[1]!.physical_delta, -40)
  assert.equal(compensated[1]!.reference_id, reverted.receipt.commandId)
  assert.equal((await rows('inventory_balances', 'variant_id=?1', [fixture.variant]))[0]!.physical_quantity, 0)
  assert.equal((await rows('variant_price_versions', 'variant_id=?1', [fixture.variant]))[0]!.status, 'cancelled')
  assert.deepEqual(await rows('catalog_draft_legacy_counters'), countersBefore)
  assert.equal((await rows('media_assets', 'id=?1', [fixture.asset])).length, 1)
  assert.equal(
    (
      await rows('catalog_native_audit', 'command_id IN (?1,?2)', [
        applied.receipt.commandId,
        reverted.receipt.commandId
      ])
    ).length,
    2
  )
  mark('native_full_import_later_http_draft_edit_blocks_compensation_without_partial_changes')
  const second = await preview(1)
  await command(second, 'apply', randomUUID())
  const edited = await http(
    `/api/admin/products/${fixtures[1]!.record.product_legacy_id}`,
    'PUT',
    { expectedVersion: 1, series: 'Later native audit edit must be retained', reason: 'Synthetic later HTTP edit' },
    randomUUID()
  )
  assert.equal(edited.status, 200)
  await edited.text()
  const beforeConflict = await ownedState()
  await denied(
    await http(`${root}/previews/${second.id}/revert`, 'POST', { previewHash: second.hash, reason }, randomUUID()),
    409,
    'version_conflict'
  )
  assert.equal(await ownedState(), beforeConflict)
  assert.equal(
    (await rows('products', 'id=?1', [fixtures[1]!.product]))[0]!.series,
    'Later native audit edit must be retained'
  )
  mark('native_full_import_existing_sku_rejected_and_unrelated_records_authorities_unchanged')
  const collision = await http(`${root}/preview`, 'POST', { records: [fixture.record] })
  assert.equal(collision.status, 200)
  assert.equal(nativeImportInvalidSchema.parse(await collision.json()).outcome, 'invalid')
  assert.equal(await ownedState(), beforeConflict)
  assert.equal(await protectedState(), protectedBefore)
  assert.equal((await rows('catalog_native_guards')).length, 0)
  const stagingBefore = await ownedState()
  const jobsRoot = '/api/admin/catalog/import-jobs'
  const stagedRecords = Array.from({ length: 601 }, (_unused, index) => {
    const product = randomUUID(),
      variant = randomUUID(),
      asset = randomUUID()
    return {
      ...fixture.record,
      product_status: 'published',
      variant_status: 'published',
      product_id: product,
      product_legacy_id: String(baseProduct + 2 + index),
      product_name: `Synthetic staged-only product ${index}`,
      product_slug: `native-stage-proof-${product}`,
      variant_id: variant,
      variant_legacy_id: String(baseVariant + 2 + index),
      sku: `NATIVE-STAGE-${variant}`.toUpperCase(),
      mpn: `NATIVE-STAGE-${variant}`,
      asset_id: asset,
      asset_storage_key: `clean/${asset}-staging-only.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
      product_attributes_json: JSON.stringify({
        image: `/media/${asset}`,
        imageAlt: 'Staging-only synthetic evidence',
        imageRights: {
          owner: 'NETECO',
          license: 'Unverified staging metadata, not authority',
          authorizedAt: '2026-08-13T12:00:00.000Z'
        }
      })
    }
  })
  const pages = [stagedRecords.slice(0, 201), stagedRecords.slice(201, 402), stagedRecords.slice(402)]
  assert.deepEqual(
    pages.map((page) => page.length),
    [201, 201, 199]
  )
  for (const page of pages) assert(new TextEncoder().encode(JSON.stringify({ records: page })).byteLength <= 900000)
  const createKey = randomUUID(),
    createBody = { totalPages: 3, recordCount: 601 }
  async function jobResponse(response: Response) {
    assert.equal(response.status, 200)
    return catalogImportJobSchema.parse(await response.json())
  }
  mark('native_global_import_job_601_rows_three_pages_seals_ready_without_domain_application')
  const createdJob = await jobResponse(await http(jobsRoot, 'POST', createBody, createKey))
  commandJobId = createdJob.id
  assert.equal(createdJob.status, 'uploading')
  assert.equal(createdJob.receivedPages, 0)
  for (const [index, records] of pages.entries()) {
    const uploaded = await jobResponse(
      await http(`${jobsRoot}/${createdJob.id}/pages/${index}`, 'PUT', { index, records })
    )
    assert.equal(uploaded.status, 'uploading')
    assert.equal(uploaded.receivedPages, index + 1)
    assert.equal(await ownedState(), stagingBefore)
    assert.equal(await protectedState(), protectedBefore)
  }
  const sealBody = { reason: 'Synthetic global job staging proof; intentionally not applied' }
  const sealedJob = await jobResponse(await http(`${jobsRoot}/${createdJob.id}/seal`, 'POST', sealBody))
  assert.equal(sealedJob.status, 'ready')
  assert.equal(sealedJob.receivedPages, 3)
  assert.equal(sealedJob.recordCount, 601)
  assert.deepEqual(sealedJob.counts, { products: 601, variants: 601, assets: 601, mappings: 601 })
  assert.match(sealedJob.hash ?? '', /^[0-9a-f]{64}$/)
  assert.deepEqual(await jobResponse(await http(`${jobsRoot}/${createdJob.id}`)), sealedJob)
  assert.equal(await ownedState(), stagingBefore)
  assert.equal(await protectedState(), protectedBefore)
  const jobStorage = async () =>
    JSON.stringify(
      await Promise.all([
        rows('catalog_import_jobs', 'id=?1', [createdJob.id]),
        ...[
          'catalog_import_job_pages',
          'catalog_import_job_rows',
          'catalog_import_job_entries',
          'catalog_import_job_identifiers',
          'catalog_import_job_seals'
        ].map((table) => rows(table, 'job_id=?1', [createdJob.id]))
      ])
    )
  mark('native_global_import_job_identical_create_page_seal_recovery_preserves_immutable_staging')
  const stagingStorageBefore = await jobStorage()
  assert.deepEqual(await jobResponse(await http(jobsRoot, 'POST', createBody, createKey)), sealedJob)
  for (const [index, records] of pages.entries())
    assert.deepEqual(
      await jobResponse(await http(`${jobsRoot}/${createdJob.id}/pages/${index}`, 'PUT', { index, records })),
      sealedJob
    )
  assert.deepEqual(await jobResponse(await http(`${jobsRoot}/${createdJob.id}/seal`, 'POST', sealBody)), sealedJob)
  assert.deepEqual(await jobResponse(await http(`${jobsRoot}/${createdJob.id}`)), sealedJob)
  assert.equal(await jobStorage(), stagingStorageBefore)
  assert.equal(await ownedState(), stagingBefore)
  assert.equal(await protectedState(), protectedBefore)
  assert.equal((await rows('catalog_import_job_guards')).length, 0)
  mark('native_global_import_job_bounded_claimed_vs_draft_pending_review_is_private_and_inert')
  const reviewedKinds: string[] = []
  for (const [offset, kind] of [
    [0, 'assets'],
    [601, 'media'],
    [1202, 'products'],
    [1803, 'variants']
  ] as const) {
    const response = await http(`${jobsRoot}/${createdJob.id}/review?offset=${offset}&limit=1`)
    assert.equal(response.status, 200)
    const review = (await response.json()) as CatalogImportJobReview
    assert.deepEqual(
      Object.keys(review).sort(),
      ['source', 'outcome', 'jobId', 'jobHash', 'offset', 'nextOffset', 'totalEntries', 'entries', 'policy'].sort()
    )
    assert.equal(review.source, 'cloudflare')
    assert.equal(review.outcome, 'review')
    assert.equal(review.jobId, createdJob.id)
    assert.equal(review.jobHash, sealedJob.hash)
    assert.equal(review.offset, offset)
    assert.equal(review.nextOffset, offset + 1)
    assert.equal(review.totalEntries, 2404)
    assert.equal(review.entries.length, 1)
    assert.deepEqual(review.policy, sealedJob.policy)
    const entry = catalogImportJobReviewEntrySchema.parse(review.entries[0])
    assert.equal(entry.kind, kind)
    assert.equal(entry.before, null)
    assert.equal(entry.context.warehouseId, references.warehouse)
    assert.equal(entry.after.publicationAuthority, 'not_granted')
    const staged = (
      await rows('catalog_import_job_entries', 'job_id=?1 AND kind=?2 AND item_id=?3', [createdJob.id, kind, entry.id])
    )[0]!
    assert(staged)
    assert.deepEqual(
      entry,
      projectCatalogImportJobReviewEntry(
        { kind, itemId: entry.id, payload: staged.payload },
        { warehouseId: references.warehouse }
      )
    )
    const serialized = JSON.stringify(review)
    for (const privateField of [
      'actor_id',
      'sessionId',
      'sessionVersion',
      'initialPriceId',
      'initialMovementId',
      'compensationMovementId',
      'command_id',
      'payload_hash'
    ])
      assert(!serialized.includes('"' + privateField + '"'))
    if (entry.kind === 'assets') {
      assert.equal(entry.claimed.rightsStatus, 'approved')
      assert.equal(entry.claimed.quarantineStatus, 'clean')
      assert.equal(entry.after.rightsStatus, 'pending')
      assert.equal(entry.after.quarantineStatus, 'pending')
      assert.equal(entry.after.uploadId, null)
      assert.equal(entry.after.storageAuthority, 'unverified_descriptor')
    } else if (entry.kind === 'media') {
      assert.equal(entry.after.rightsStatus, 'pending')
      assert.equal(entry.after.quarantineStatus, 'pending')
      assert.equal(entry.after.uploadId, null)
      assert.equal(entry.after.storageAuthority, 'unverified_descriptor')
    } else if (entry.kind === 'products') {
      assert.equal(entry.claimed.status, 'published')
      assert.equal(entry.after.status, 'draft')
      assert.equal(entry.after.publishedAt, null)
    } else {
      assert.equal(entry.claimed.status, 'published')
      assert.equal(entry.after.status, 'draft')
      assert.equal(entry.after.price.validFrom, null)
      assert.equal(entry.after.price.validFromPolicy, 'server_on_apply')
      assert.equal(entry.after.price.authorization, 'requires_live_apply_authorization')
      assert.equal(entry.after.inventory.warehouseId, references.warehouse)
      assert.equal(entry.after.inventory.onHand, 40)
      assert.equal(entry.after.inventory.blocked, 2)
    }
    reviewedKinds.push(entry.kind)
  }
  await denied(
    await http(`${jobsRoot}/${createdJob.id}/review?offset=0&limit=1`, 'GET', undefined, undefined, unprivilegedCookie),
    403,
    'mfa_required'
  )
  assert.equal(await jobStorage(), stagingStorageBefore)
  assert.equal(await ownedState(), stagingBefore)
  assert.equal(await protectedState(), protectedBefore)
  // The preceding checkpoint proves staging/review are inert. Commands below
  // are a separate, bounded 601-row proof, not acceptance of the 25k limit.
  const jobRows = (table: string, column: string, kind: string) =>
    rows(table, `${column} IN(SELECT item_id FROM catalog_import_job_entries WHERE job_id=?1 AND kind='${kind}')`, [
      createdJob.id
    ])
  const jobDomain = async () =>
    JSON.stringify(
      await Promise.all([
        jobRows('products', 'id', 'products'),
        jobRows('variants', 'id', 'variants'),
        jobRows('media_assets', 'id', 'assets'),
        jobRows('product_media', 'product_id', 'products'),
        jobRows('variant_price_versions', 'variant_id', 'variants'),
        jobRows('inventory_balances', 'variant_id', 'variants'),
        jobRows('inventory_movements', 'variant_id', 'variants'),
        rows('catalog_import_job_commands', 'job_id=?1', [createdJob.id]),
        rows(
          'catalog_import_job_command_audit',
          'command_id IN(SELECT id FROM catalog_import_job_commands WHERE job_id=?1)',
          [createdJob.id]
        ),
        rows('catalog_draft_legacy_counters'),
        rows('catalog_import_job_guards')
      ])
    )
  async function wholeCommand(action: 'apply' | 'revert', key: string) {
    const response = await http(
      `${jobsRoot}/${createdJob.id}/${action}`,
      'POST',
      { previewHash: sealedJob.hash, reason },
      key
    )
    assert.equal(response.status, 200)
    const text = await response.text(),
      receipt = catalogImportJobReceiptSchema.parse(JSON.parse(text))
    assert.equal(receipt.jobId, createdJob.id)
    assert.equal(receipt.jobHash, sealedJob.hash)
    assert.equal(receipt.action, action)
    assert.deepEqual(receipt.counts, sealedJob.counts)
    return { text, receipt }
  }
  async function verifyJobRows(status: 'draft' | 'discontinued') {
    const products = await jobRows('products', 'id', 'products'),
      variants = await jobRows('variants', 'id', 'variants'),
      assets = await jobRows('media_assets', 'id', 'assets'),
      mappings = await jobRows('product_media', 'product_id', 'products'),
      prices = await jobRows('variant_price_versions', 'variant_id', 'variants'),
      balances = await jobRows('inventory_balances', 'variant_id', 'variants')
    for (const collection of [products, variants, assets, mappings, prices, balances])
      assert.equal(collection.length, 601)
    for (const row of products) {
      assert.equal(row.status, status)
      assert.equal(row.published_at, null)
    }
    for (const row of variants) {
      assert.equal(row.status, status)
      assert.equal(row.price_gross_cents, status === 'draft' ? 1599 : 0)
    }
    for (const row of assets) {
      assert.equal(row.rights_status, 'pending')
      assert.equal(row.quarantine_status, 'pending')
    }
    for (const row of prices) {
      assert.equal(row.gross_cents, 1599)
      assert.equal(row.status, status === 'draft' ? 'approved' : 'cancelled')
    }
    for (const row of balances) {
      assert.equal(row.location_id, warehouseId)
      assert.equal(row.physical_quantity, status === 'draft' ? 40 : 0)
      assert.equal(row.blocked_quantity, status === 'draft' ? 2 : 0)
      assert.equal(row.version, status === 'draft' ? 1 : 2)
    }
    assert.equal(await jobStorage(), stagingStorageBefore)
    // Keep the two bounded native imports separate from whole-job evidence;
    // only their shared monotonic legacy counters may change here.
    assert.deepEqual(JSON.parse(await ownedState()).slice(0, 9), JSON.parse(stagingBefore).slice(0, 9))
    assert.equal(await protectedState(), protectedBefore)
    assert.equal((await rows('catalog_import_job_guards')).length, 0)
  }
  mark('native_global_import_job_601_atomic_apply_exact_replay_and_get_applied')
  const jobApplyKey = randomUUID(),
    jobApplied = await wholeCommand('apply', jobApplyKey)
  await verifyJobRows('draft')
  const jobInitialMovements = await jobRows('inventory_movements', 'variant_id', 'variants')
  assert.equal(jobInitialMovements.length, 601)
  for (const movement of jobInitialMovements) {
    assert.equal(movement.physical_delta, 40)
    assert.equal(movement.movement_type, 'initial')
    assert.equal(movement.reference_id, jobApplied.receipt.commandId)
  }
  const jobApplyAudits = await rows('catalog_import_job_command_audit', 'command_id=?1', [jobApplied.receipt.commandId])
  assert.equal(jobApplyAudits.length, 601 * 7)
  for (const kind of ['products', 'variants', 'assets', 'media', 'prices', 'balances', 'movements'])
    assert.equal(jobApplyAudits.filter((row) => row.kind === kind).length, 601)
  for (const audit of jobApplyAudits) {
    assert.equal(audit.before_state, null)
    assert(audit.after_state)
  }
  const jobCounters = await rows('catalog_draft_legacy_counters')
  for (const counter of jobCounters) {
    const initial = countersBefore.find((row) => row.entity === counter.entity)!
    assert(Number(counter.last_id) >= Number(initial.last_id))
    assert(Number(counter.last_id) >= (counter.entity === 'product' ? baseProduct : baseVariant) + 602)
  }
  const afterJobApply = await jobDomain()
  assert.equal((await wholeCommand('apply', jobApplyKey)).text, jobApplied.text)
  assert.equal(await jobDomain(), afterJobApply)
  assert.equal((await jobResponse(await http(`${jobsRoot}/${createdJob.id}`))).status, 'applied')
  mark('native_global_import_job_bad_mfa_cannot_replay_durable_apply_receipt')
  await denied(
    await http(
      `${jobsRoot}/${createdJob.id}/apply`,
      'POST',
      { previewHash: sealedJob.hash, reason },
      jobApplyKey,
      unprivilegedCookie
    ),
    403,
    'mfa_required'
  )
  assert.equal(await jobDomain(), afterJobApply)
  mark('native_global_import_job_601_exact_compensation_replay_and_get_reverted')
  const jobRevertKey = randomUUID(),
    jobReverted = await wholeCommand('revert', jobRevertKey)
  await verifyJobRows('discontinued')
  const jobFinalMovements = await jobRows('inventory_movements', 'variant_id', 'variants')
  assert.equal(jobFinalMovements.length, 1202)
  assert.deepEqual(
    jobFinalMovements.filter((row) => row.reference_id === jobApplied.receipt.commandId),
    jobInitialMovements
  )
  const compensation = jobFinalMovements.filter((row) => row.reference_id === jobReverted.receipt.commandId)
  assert.equal(compensation.length, 601)
  for (const movement of compensation) {
    assert.equal(movement.physical_delta, -40)
    assert.equal(movement.movement_type, 'adjustment')
  }
  assert.deepEqual(await rows('catalog_draft_legacy_counters'), jobCounters)
  const jobRevertAudits = await rows('catalog_import_job_command_audit', 'command_id=?1', [
    jobReverted.receipt.commandId
  ])
  assert.equal(jobRevertAudits.length, 601 * 8)
  const priorAudits = new Map(jobApplyAudits.map((row) => [JSON.stringify([row.kind, row.item_id]), row]))
  for (const audit of jobRevertAudits) {
    const prior = priorAudits.get(JSON.stringify([audit.kind, audit.item_id]))
    assert.equal(audit.before_state, prior?.after_state ?? null)
  }
  assert.equal((await rows('catalog_import_job_commands', 'job_id=?1', [createdJob.id])).length, 2)
  const afterJobRevert = await jobDomain()
  assert.equal((await wholeCommand('revert', jobRevertKey)).text, jobReverted.text)
  assert.equal(await jobDomain(), afterJobRevert)
  assert.equal((await jobResponse(await http(`${jobsRoot}/${createdJob.id}`))).status, 'reverted')
  assert.equal(await jobStorage(), stagingStorageBefore)
  assert.equal(await protectedState(), protectedBefore)
  const browserRecords = Array.from({ length: 602 }, (_unused, index) => {
    const record = stagedRecords[index % stagedRecords.length]!
    const product = randomUUID(),
      variant = randomUUID(),
      asset = randomUUID()
    return {
      ...record,
      product_id: product,
      variant_id: variant,
      asset_id: asset,
      product_legacy_id: String(baseProduct + 603 + index),
      variant_legacy_id: String(baseVariant + 603 + index),
      product_slug: `native-browser-proof-${product}`,
      product_status: 'draft',
      variant_status: 'draft',
      sku: `NATIVE-BROWSER-${variant}`.toUpperCase(),
      mpn: `NATIVE-BROWSER-${variant}`,
      asset_storage_key: `clean/${asset}-browser-proof.png`,
      asset_source_url: `/media/${asset}`,
      asset_checksum_sha256: createHash('sha256').update(asset).digest('hex'),
      product_attributes_json: JSON.stringify({
        ...JSON.parse(record.product_attributes_json),
        image: `/media/${asset}`
      })
    }
  })
  await input.onBrowserFixtures?.({
    records: [browserRecords[0]!],
    jobRecords: browserRecords.slice(1)
  })
  return {
    scenarios,
    httpRequests,
    profile: 'native_full_catalog_import_v1',
    productsCreated: 2,
    variantsCreated: 2,
    assetsPendingVerification: 2,
    compensatedProducts: 1,
    retainedEditedDrafts: 1,
    unauthorizedReplayBlocked: true,
    unrelatedRecordsUnchanged: true,
    publicationAuthorityCreated: false,
    externalStorageWrites: false,
    browserStatus: 'not_run',
    globalJobStaging: {
      recordCount: 601,
      pages: [201, 201, 199],
      status: 'ready',
      applied: false,
      identicalReplayVerified: true,
      domainUnchanged: true,
      full25000RowApplyAcceptance: false
    },
    globalJobReview: {
      totalEntries: 2404,
      sampledEntries: 4,
      sampledKinds: reviewedKinds,
      fullPaginationCompleted: false,
      readOnly: true,
      unauthorizedReadBlocked: true
    },
    globalJobCommands: {
      testedRecordCount: 601,
      appliedProducts: 601,
      compensatedProducts: 601,
      durableReceipts: 2,
      auditRows: 601 * 15,
      exactApplyReplayVerified: true,
      exactRevertReplayVerified: true,
      unauthorizedReplayBlocked: true,
      immutableStagingUnchanged: true,
      unrelatedRecordsUnchanged: true,
      publicationAuthorityCreated: false,
      full25000RowApplyAcceptance: false
    },
    productionAcceptance: false
  }
}
