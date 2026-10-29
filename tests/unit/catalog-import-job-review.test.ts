import { describe, expect, it } from 'vitest'
import {
  catalogImportJobReviewEntrySchema,
  projectCatalogImportJobReviewEntry,
  CATALOG_IMPORT_JOB_REVIEW_WARNINGS,
  CATALOG_IMPORT_JOB_REVIEW_WARNING_TEXT
} from '../../shared/catalog-import-job-review'
import { validateCatalogRecords, type CatalogImportDataset } from '../../shared/catalog-tabular-core'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'

const context = { warehouseId: ids.shipping }
const internals = {
  initialPriceId: '00570000-0000-4000-8000-000000000001',
  initialMovementId: '00570000-0000-4000-8000-000000000002',
  compensationMovementId: '00570000-0000-4000-8000-000000000003'
}
function dataset(): CatalogImportDataset {
  const validated = validateCatalogRecords([catalogRecord()])
  expect(validated.valid).toBe(true)
  return validated.dataset
}
type Kind = keyof CatalogImportDataset
function entry(kind: Kind, encoded = false) {
  const data = dataset()[kind][0]!,
    itemId =
      kind === 'media' ? JSON.stringify([ids.product, null, ids.image, 'primary', '1']) : (data as { id: string }).id
  const payload = kind === 'variants' ? { ...data, ...internals } : data
  return { kind, itemId, payload: encoded ? JSON.stringify(payload) : payload }
}
describe('pure normalized import-job real review diff', () => {
  it.each(['products', 'variants', 'assets', 'media'] as const)(
    'projects real %s source/after with create-only before:null and explicit authority warnings',
    (kind) => {
      const input = entry(kind),
        original = structuredClone(input),
        result = projectCatalogImportJobReviewEntry(input, context)
      expect(result).toMatchObject({
        source: 'cloudflare',
        outcome: 'review_entry',
        kind,
        id: input.itemId,
        before: null,
        context,
        warnings: [...CATALOG_IMPORT_JOB_REVIEW_WARNINGS]
      })
      expect(catalogImportJobReviewEntrySchema.safeParse(result).success).toBe(true)
      expect(result.after).toMatchObject({ publicationAuthority: 'not_granted' })
      expect(result.claimed).toEqual(dataset()[kind][0])
      expect(input).toEqual(original)
      expect(Object.keys(CATALOG_IMPORT_JOB_REVIEW_WARNING_TEXT)).toEqual([...CATALOG_IMPORT_JOB_REVIEW_WARNINGS])
    }
  )
  it('preserves all product source fields but forces a new draft with no publication timestamp', () => {
    const input = entry('products'),
      result = projectCatalogImportJobReviewEntry(input, context)
    if (result.kind !== 'products') throw new Error('wrong_kind')
    expect(result.claimed.status).toBe('published')
    expect(result.after).toEqual({
      ...result.claimed,
      status: 'draft',
      publishedAt: null,
      publicationAuthority: 'not_granted'
    })
    expect(result.after).toMatchObject({
      id: ids.product,
      name: 'Detergente profesional 5 L',
      sourceId: ids.source,
      sourceVersion: 'supplier-2026.08',
      categoryId: ids.category,
      brandId: ids.brand
    })
    expect(result.after.attributes).toEqual(result.claimed.attributes)
    expect(result.claimed.regulatory).toEqual({ requiresSds: false })
  })
  it('shows exact identifiers/SKU, initial price/tax and actual warehouse stock without inventing an effective date or approval', () => {
    const result = projectCatalogImportJobReviewEntry(entry('variants'), context)
    if (result.kind !== 'variants') throw new Error('wrong_kind')
    expect(result.after).toMatchObject({
      id: ids.variant,
      productId: ids.product,
      sku: 'DET-5L',
      ean: '4006381333931',
      gtin: null,
      mpn: null,
      identifierExceptionReason: null,
      status: 'draft',
      sourceVersion: 'supplier-2026.08',
      taxClassId: ids.tax,
      shippingProfileId: ids.shipping
    })
    expect(result.after.price).toEqual({
      grossCents: 1599,
      compareAtGrossCents: 1799,
      currency: 'EUR',
      taxClassId: ids.tax,
      validFrom: null,
      validFromPolicy: 'server_on_apply',
      authorization: 'requires_live_apply_authorization'
    })
    expect(result.after.inventory).toEqual({
      warehouseId: ids.shipping,
      onHand: 40,
      blocked: 2,
      safetyStock: 2,
      backorderAllowed: false,
      version: 1,
      authorization: 'requires_live_apply_authorization'
    })
    const serialized = JSON.stringify(result)
    for (const [field, id] of Object.entries(internals)) {
      expect(serialized).not.toContain(field)
      expect(serialized).not.toContain(id)
    }
  })
  it('shows explicit zero initialization for an absent source inventory without changing the claimed array', () => {
    const input = entry('variants'),
      payload = input.payload as Record<string, unknown>
    payload.inventory = []
    const result = projectCatalogImportJobReviewEntry(input, context)
    if (result.kind !== 'variants') throw new Error('wrong_kind')
    expect(result.claimed.inventory).toEqual([])
    expect(result.after.inventory).toMatchObject({
      warehouseId: ids.shipping,
      onHand: 0,
      blocked: 0,
      safetyStock: 2,
      backorderAllowed: false
    })
  })
  it('keeps declared approval/scan claims alongside mandatory pending descriptor state and no verified upload', () => {
    const result = projectCatalogImportJobReviewEntry(entry('assets'), context)
    if (result.kind !== 'assets') throw new Error('wrong_kind')
    expect(result.claimed).toMatchObject({
      rightsStatus: 'approved',
      quarantineStatus: 'clean',
      sourceUrl: `/media/${ids.image}`,
      metadata: { language: 'es', provenance: 'supplier' }
    })
    expect(result.after).toEqual({
      ...result.claimed,
      rightsStatus: 'pending',
      quarantineStatus: 'pending',
      uploadId: null,
      storageAuthority: 'unverified_descriptor',
      publicationAuthority: 'not_granted'
    })
    expect(result.after.storageKey).toBe(catalogRecord().asset_storage_key)
  })
  it('uses honest composite media identity with null variant, preserving version/sort/role and pending authority', () => {
    const input = entry('media'),
      result = projectCatalogImportJobReviewEntry(input, context)
    expect(JSON.parse(result.id)).toEqual([ids.product, null, ids.image, 'primary', '1'])
    expect(result.after).toMatchObject({
      productId: ids.product,
      variantId: null,
      assetId: ids.image,
      role: 'primary',
      version: '1',
      sortOrder: 0,
      rightsStatus: 'pending',
      quarantineStatus: 'pending',
      uploadId: null
    })
  })
  it.each(['products', 'variants', 'assets', 'media'] as const)(
    'accepts serialized original %s payload without mutating or reinterpreting source data',
    (kind) => {
      expect(projectCatalogImportJobReviewEntry(entry(kind, true), context)).toEqual(
        projectCatalogImportJobReviewEntry(entry(kind), context)
      )
    }
  )
  it('detaches source metadata and preserves unknown original data without executable hooks', () => {
    const input = entry('products'),
      payload = input.payload as Record<string, unknown>
    payload.attributes = {
      original: '<img src=x>',
      nested: { leading: '00001', flag: false, missing: null, unicode: 'á 🚀' }
    }
    const result = projectCatalogImportJobReviewEntry(input, context)
    expect(result.claimed).toMatchObject({ attributes: payload.attributes })
    ;(payload.attributes as Record<string, unknown>).original = 'changed'
    expect(result.claimed).toMatchObject({ attributes: { original: '<img src=x>' } })
  })
  it.each([
    'foreign_id',
    'extra',
    'kind',
    'bad_json',
    'missing_field',
    'coerced_price',
    'negative_stock',
    'blocked_over_physical',
    'warehouse',
    'version',
    'partial_internal_ids',
    'unknown_internal',
    'compare_below_price',
    'quantity_rules'
  ] as const)('fails closed for malformed normalized boundary %s', (problem) => {
    const input = entry('variants'),
      payload = input.payload as Record<string, unknown>
    if (problem === 'foreign_id') input.itemId = ids.product
    if (problem === 'extra') Object.assign(input, { actorId: 'private_actor' })
    if (problem === 'kind') Object.assign(input, { kind: 'receipts' })
    if (problem === 'bad_json') input.payload = '{sql_secret'
    if (problem === 'missing_field') delete payload.sku
    if (problem === 'coerced_price') payload.priceGrossCents = '1599'
    if (problem === 'negative_stock')
      payload.inventory = [{ locationId: ids.shipping, physicalQuantity: -1, blockedQuantity: 0, version: 1 }]
    if (problem === 'blocked_over_physical')
      payload.inventory = [{ locationId: ids.shipping, physicalQuantity: 1, blockedQuantity: 2, version: 1 }]
    if (problem === 'warehouse')
      payload.inventory = [{ locationId: ids.category, physicalQuantity: 40, blockedQuantity: 2, version: 1 }]
    if (problem === 'version')
      payload.inventory = [{ locationId: ids.shipping, physicalQuantity: 40, blockedQuantity: 2, version: 2 }]
    if (problem === 'partial_internal_ids') delete payload.initialMovementId
    if (problem === 'unknown_internal') payload.actorId = 'private_actor'
    if (problem === 'compare_below_price') payload.compareAtGrossCents = 1
    if (problem === 'quantity_rules') {
      payload.minimumQuantity = 10
      payload.maximumQuantity = 1
    }
    expect(() => projectCatalogImportJobReviewEntry(input, context)).toThrow('invalid_catalog_import_review')
  })
  it('rejects malformed context, mismatched product SDS declaration and invented association UUIDs', () => {
    expect(() => projectCatalogImportJobReviewEntry(entry('products'), { ...context, sessionId: 'private' })).toThrow(
      'invalid_catalog_import_review'
    )
    const input = entry('products')
    ;(input.payload as Record<string, unknown>).requiresSds = true
    expect(() => projectCatalogImportJobReviewEntry(input, context)).toThrow('invalid_catalog_import_review')
    expect(() => projectCatalogImportJobReviewEntry({ ...entry('media'), itemId: ids.product }, context)).toThrow(
      'invalid_catalog_import_review'
    )
  })
  it('does not execute payload/root/context accessors, prototypes or toJSON hooks', () => {
    let calls = 0
    const input = entry('products'),
      getter = Object.defineProperty({ ...input }, 'payload', {
        enumerable: true,
        get() {
          calls++
          return input.payload
        }
      })
    expect(() => projectCatalogImportJobReviewEntry(getter, context)).toThrow('invalid_catalog_import_review')
    const malicious = {
      ...(input.payload as object),
      toJSON() {
        calls++
        return {}
      }
    }
    expect(() => projectCatalogImportJobReviewEntry({ ...input, payload: malicious }, context)).toThrow(
      'invalid_catalog_import_review'
    )
    const payload = Object.defineProperty({ ...(input.payload as object) }, 'name', {
      enumerable: true,
      get() {
        calls++
        return 'stolen'
      }
    })
    expect(() => projectCatalogImportJobReviewEntry({ ...input, payload }, context)).toThrow(
      'invalid_catalog_import_review'
    )
    const parameters = Object.defineProperty({}, 'warehouseId', {
      enumerable: true,
      get() {
        calls++
        return ids.shipping
      }
    })
    expect(() => projectCatalogImportJobReviewEntry(input, parameters)).toThrow('invalid_catalog_import_review')
    expect(() =>
      projectCatalogImportJobReviewEntry({ ...input, payload: Object.create({ id: ids.product }) }, context)
    ).toThrow('invalid_catalog_import_review')
    expect(calls).toBe(0)
  })
  it('rejects sparse arrays, cycles, nonfinite quantities, oversized texts and aggregate encoded payloads', () => {
    const input = entry('variants'),
      payload = input.payload as Record<string, unknown>
    for (const inventory of [
      new Array(1),
      [{ locationId: ids.shipping, physicalQuantity: Infinity, blockedQuantity: 0, version: 1 }]
    ])
      expect(() =>
        projectCatalogImportJobReviewEntry({ ...input, payload: { ...payload, inventory } }, context)
      ).toThrow('invalid_catalog_import_review')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const product = entry('products')
    for (const attributes of [cyclic, { oversized: 'x'.repeat(20_001) }])
      expect(() =>
        projectCatalogImportJobReviewEntry(
          { ...product, payload: { ...(product.payload as object), attributes } },
          context
        )
      ).toThrow('invalid_catalog_import_review')
    expect(() => projectCatalogImportJobReviewEntry({ ...product, payload: ' '.repeat(900_001) }, context)).toThrow(
      'invalid_catalog_import_review'
    )
  })
  it.each(['before', 'publication', 'gross', 'warehouse', 'stock', 'claimed', 'warnings', 'upload', 'rights'] as const)(
    'rejects tampered or fake-green DTO %s',
    (change) => {
      const result = projectCatalogImportJobReviewEntry(
        entry(change === 'upload' || change === 'rights' ? 'assets' : 'variants'),
        context
      )
      const value = structuredClone(result) as unknown as Record<string, unknown>,
        after = value.after as Record<string, unknown>
      if (change === 'before') value.before = { existing: true }
      if (change === 'publication') after.publicationAuthority = 'approved'
      if (change === 'gross') (after.price as Record<string, unknown>).grossCents = 2000
      if (change === 'warehouse') (after.inventory as Record<string, unknown>).warehouseId = ids.category
      if (change === 'stock') (after.inventory as Record<string, unknown>).onHand = 999
      if (change === 'claimed') (value.claimed as Record<string, unknown>).sku = 'different'
      if (change === 'warnings') value.warnings = []
      if (change === 'upload') after.uploadId = ids.product
      if (change === 'rights') after.rightsStatus = 'approved'
      expect(catalogImportJobReviewEntrySchema.safeParse(value).success).toBe(false)
    }
  )
  it('does not treat harmless property ordering as a changed after state', () => {
    const projected = projectCatalogImportJobReviewEntry(entry('variants'), context),
      reordered = { ...projected, after: Object.fromEntries(Object.entries(projected.after).reverse()) }
    expect(catalogImportJobReviewEntrySchema.safeParse(reordered).success).toBe(true)
  })
  it('preserves the exact spelling of normalized source UUIDs, including uppercase hex', () => {
    const input = entry('products'),
      payload = input.payload as Record<string, unknown>
    payload.id = ids.product.toUpperCase()
    input.itemId = String(payload.id)
    const result = projectCatalogImportJobReviewEntry(input, context)
    expect(result.id).toBe(ids.product.toUpperCase())
    expect(result.claimed).toMatchObject({ id: ids.product.toUpperCase() })
    expect(result.after).toMatchObject({ id: ids.product.toUpperCase() })
  })
  it.each(['attributes', 'metadata', 'dense_array'] as const)(
    'preserves core-valid large original JSON structures: %s',
    (field) => {
      const source = catalogRecord(),
        wide = Object.fromEntries(Array.from({ length: 200 }, (_item, index) => ['original' + index, 'value' + index]))
      if (field === 'metadata')
        source.asset_metadata_json = JSON.stringify({ ...JSON.parse(source.asset_metadata_json), ...wide })
      else
        source.product_attributes_json = JSON.stringify({
          ...JSON.parse(source.product_attributes_json),
          ...(field === 'dense_array' ? { originalArray: Array.from({ length: 1000 }, (_item, index) => index) } : wide)
        })
      const validated = validateCatalogRecords([source])
      expect(validated.valid).toBe(true)
      const kind = field === 'metadata' ? 'assets' : 'products',
        payload = validated.dataset[kind][0]!,
        result = projectCatalogImportJobReviewEntry(
          { kind, itemId: payload.id, payload: JSON.stringify(payload) },
          context
        )
      expect(result.claimed).toEqual(payload)
      if (result.kind === 'products')
        expect(result.after.attributes).toEqual((payload as CatalogImportDataset['products'][number]).attributes)
      if (result.kind === 'assets')
        expect(result.after.metadata).toEqual((payload as CatalogImportDataset['assets'][number]).metadata)
      expect(catalogImportJobReviewEntrySchema.safeParse(result).success).toBe(true)
    }
  )
})
