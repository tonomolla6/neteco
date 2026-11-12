import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  NativeCatalogImportError,
  previewNativeCatalogImport,
  readNativeCatalogImportPreview,
  executeNativeCatalogImportCommand
} from '../../workers/catalog/native-import'
import { executeD1CatalogDraftAuthoringCommand } from '../../workers/catalog/admin-catalog-authoring'
import { testUuid, testNow } from '../support/deterministic'

const actor = '00540000-0000-4000-8000-000000000001'
const session = '00540000-0000-4000-8000-000000000002'
const warehouse = '00540000-0000-4000-8000-000000000003'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const reason = 'Synthetic native import approval, local tests only'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('native D1 catalog import: private previews and compensating transactions', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_native_previews'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0054_catalog_native_import.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    sqlite.limits.likePatternLength = 50
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'NATIVE-TEST','Synthetic supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,54,'Native category','native-category','published')"
      )
      .run(ids.category)
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Native brand','native-brand','published')")
      .run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'NATIVE-TAX','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'NATIVE-SHIP','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'NATIVE-WH','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'native54@example.invalid','unusable-synthetic',?,'active',?,?)"
      )
      .run(actor, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('native54','Native importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('native54',?)").run(`${resource}.${action}`)
    }
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native54',?)")
      .run(actor, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(session, actor, utc(-86400_000), utc(7200_000))
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function record() {
    return {
      ...catalogRecord(),
      inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }])
    }
  }
  async function preview(db = database, records = [record()]) {
    const result = await previewNativeCatalogImport(db, claims, { records })
    if (result.outcome !== 'preview') throw new Error(`expected_valid_preview: ${JSON.stringify(result)}`)
    return result
  }
  function rows(table: string) {
    return sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  }
  function state() {
    return Object.fromEntries(
      [
        'products',
        'variants',
        'variant_price_versions',
        'inventory_balances',
        'inventory_movements',
        'media_assets',
        'product_media',
        'catalog_native_commands',
        'catalog_native_audit',
        'catalog_draft_legacy_counters'
      ].map((table) => [table, rows(table)])
    )
  }
  function command(
    p: { id: string; hash: string },
    action: 'apply' | 'revert' = 'apply',
    key = testUuid(),
    db = database
  ) {
    return executeNativeCatalogImportCommand(db, claims, p.id, action, { previewHash: p.hash, reason }, key)
  }
  function interpose(effect: () => void) {
    return {
      ...database,
      batch: async (statements: D1PreparedStatement[]) => {
        effect()
        return database.batch(statements)
      }
    } as D1Database
  }

  it('previews without domain mutations; applies complete fields as drafts without rights, scans, storage or publication authority', async () => {
    const before = state(),
      p = await preview()
    expect(state()).toEqual(before)
    expect(p).toMatchObject({ source: 'cloudflare', outcome: 'preview', status: 'pending' })
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(30 * 60_000)
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(p).not.toHaveProperty('items')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external I/O forbidden'))
    const receipt = await command(p)
    expect(receipt).toMatchObject({ counts: { products: 1, variants: 1, assets: 1, mappings: 1 } })
    expect(receipt).not.toHaveProperty('items')
    expect(rows('products')[0]).toMatchObject({
      id: ids.product,
      legacy_id: 900001,
      category_id: ids.category,
      brand_id: ids.brand,
      source_id: ids.source,
      name: record().product_name,
      short_description: record().short_description,
      description: record().description,
      usage: record().product_usage,
      series: record().product_series,
      featured: 1,
      attributes: record().product_attributes_json,
      regulatory: record().product_regulatory_json,
      source_version: record().source_version,
      status: 'draft',
      published_at: null
    })
    expect(rows('variants')[0]).toMatchObject({
      id: ids.variant,
      legacy_id: 910001,
      sku: 'DET-5L',
      ean: '4006381333931',
      gtin: null,
      tax_class_id: ids.tax,
      shipping_profile_id: ids.shipping,
      status: 'draft',
      price_gross_cents: 1599,
      compare_at_gross_cents: 1799,
      cost_net_cents: 800,
      unit_base: 'l',
      content_quantity: 5,
      units_per_case: 4,
      cases_per_pallet: 30,
      minimum_quantity: 1,
      quantity_increment: 1,
      maximum_quantity: 20,
      weight_grams: 5200,
      width_mm: 180,
      height_mm: 320,
      depth_mm: 130,
      safety_stock: 2,
      backorder_allowed: 0,
      color: '#00AACC',
      image: record().variant_image,
      source_version: record().variant_source_version
    })
    expect(rows('variant_price_versions')[0]).toMatchObject({
      variant_id: ids.variant,
      gross_cents: 1599,
      compare_at_gross_cents: 1799,
      status: 'approved',
      created_by: actor,
      reason
    })
    expect(rows('inventory_balances')[0]).toMatchObject({
      variant_id: ids.variant,
      location_id: warehouse,
      physical_quantity: 40,
      blocked_quantity: 2,
      version: 1
    })
    expect(rows('inventory_movements')[0]).toMatchObject({
      variant_id: ids.variant,
      physical_delta: 40,
      reserved_delta: 0,
      reference_type: 'catalog_native_import',
      reference_id: receipt.commandId,
      reason
    })
    expect(sqlite.prepare('SELECT actor_id FROM catalog_native_commands WHERE id=?').get(receipt.commandId)).toEqual({
      actor_id: actor
    })
    expect(rows('media_assets')[0]).toMatchObject({
      id: ids.image,
      storage_key: record().asset_storage_key,
      original_name: record().asset_original_name,
      mime_type: record().asset_mime_type,
      byte_size: 24000,
      checksum_sha256: record().asset_checksum_sha256,
      owner_name: record().asset_owner_name,
      source_url: record().asset_source_url,
      license: record().asset_license,
      authorized_at: record().asset_authorized_at,
      alt_text: record().asset_alt_text,
      metadata: record().asset_metadata_json,
      rights_status: 'pending',
      quarantine_status: 'pending'
    })
    expect(rows('product_media')).toEqual([
      { product_id: ids.product, variant_id: null, asset_id: ids.image, role: 'primary', version: '1', sort_order: 0 }
    ])
    expect(rows('media_uploads')).toHaveLength(0)
    expect(rows('media_scan_receipts')).toHaveLength(0)
    expect(rows('media_rights_decisions')).toHaveLength(0)
    expect(rows('product_media_publications')).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('applied')
  })

  it('persists identical idempotent receipt but rejects payload/key collision', async () => {
    const p = await preview(),
      receipt = await command(p, 'apply', 'native-key'),
      before = state()
    expect(await command(p, 'apply', 'native-key')).toEqual(receipt)
    await expect(
      executeNativeCatalogImportCommand(
        database,
        claims,
        p.id,
        'apply',
        { previewHash: p.hash, reason: 'Different approval reason' },
        'native-key'
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(state()).toEqual(before)
  })

  it.each(['catalog.write', 'administration.manage', 'inventory.write'])(
    'requires current %s before cached replay',
    async (permission) => {
      const p = await preview()
      await command(p, 'apply', 'cached')
      const before = state()
      sqlite.prepare("DELETE FROM role_permissions WHERE role_code='native54' AND permission_code=?").run(permission)
      await expect(command(p, 'apply', 'cached')).rejects.toMatchObject({ code: 'forbidden' })
      expect(state()).toEqual(before)
    }
  )
  it.each([
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ["UPDATE auth_sessions SET revoked_at='2026-01-01T00:00:00Z'", 'unauthenticated']
  ])('rejects revoked authorization: %s', async (sql, code) => {
    const p = await preview()
    await command(p, 'apply', 'cached')
    const before = state()
    sqlite.exec(sql)
    await expect(command(p, 'apply', 'cached')).rejects.toMatchObject({ code })
    expect(state()).toEqual(before)
  })
  it('keeps previews owner private even for another fully privileged identity', async () => {
    const p = await preview(),
      other = testUuid(),
      otherSession = testUuid()
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'other54@example.invalid','unusable',?,'active',?,?)"
      )
      .run(other, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native54',?)")
      .run(other, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(otherSession, other, utc(-86400_000), utc(7200_000))
    const otherClaims = { identityId: other, sessionId: otherSession, sessionVersion: 1 }
    await expect(readNativeCatalogImportPreview(database, otherClaims, p.id)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(
      executeNativeCatalogImportCommand(database, otherClaims, p.id, 'apply', { previewHash: p.hash, reason }, 'stolen')
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(rows('products')).toHaveLength(0)
  })
  it('rejects wrong hash and expired preview without mutations', async () => {
    const p = await preview(),
      before = state()
    await expect(command({ ...p, hash: '0'.repeat(64) })).rejects.toBeInstanceOf(NativeCatalogImportError)
    await expect(
      executeNativeCatalogImportCommand(database, claims, p.id, 'apply', { previewHash: p.hash, reason }, 'expired', {
        now: utc(31 * 60_000)
      })
    ).rejects.toMatchObject({ code: 'preview_expired' })
    expect(state()).toEqual(before)
  })
  it('makes preview manifest and hash immutable at the storage boundary', async () => {
    const p = await preview()
    expect(() =>
      sqlite.prepare('UPDATE catalog_native_previews SET hash=? WHERE id=?').run('0'.repeat(64), p.id)
    ).toThrow()
    expect(() => sqlite.prepare('DELETE FROM catalog_native_previews WHERE id=?').run(p.id)).toThrow()
    expect((await readNativeCatalogImportPreview(database, claims, p.id)).hash).toBe(p.hash)
  })
  it('expires previews exactly at the deadline and rejects unsupported millisecond clock input', async () => {
    const p = await preview(),
      before = state()
    expect((await readNativeCatalogImportPreview(database, claims, p.id, { now: p.expiresAt })).status).toBe('expired')
    await expect(
      executeNativeCatalogImportCommand(database, claims, p.id, 'apply', { previewHash: p.hash, reason }, 'deadline', {
        now: p.expiresAt
      })
    ).rejects.toMatchObject({ code: 'preview_expired' })
    const milliseconds = new Date(Date.parse(p.expiresAt)).toISOString()
    await expect(readNativeCatalogImportPreview(database, claims, p.id, { now: milliseconds })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(state()).toEqual(before)
  })
  it.each(['catalog.write', 'administration.manage', 'inventory.write'])(
    'checks %s again inside the apply transaction',
    async (permission) => {
      const p = await preview(),
        before = state()
      const racing = interpose(() =>
        sqlite.prepare("DELETE FROM role_permissions WHERE role_code='native54' AND permission_code=?").run(permission)
      )
      await expect(command(p, 'apply', 'authorization-race', racing)).rejects.toBeInstanceOf(NativeCatalogImportError)
      expect(state()).toEqual(before)
    }
  )
  it.each([
    "UPDATE categories SET status='discontinued'",
    "UPDATE brands SET status='archived'",
    'UPDATE catalog_sources SET is_master=0',
    'UPDATE inventory_locations SET active=0',
    "UPDATE tax_classes SET valid_until='2021-01-01T00:00:00Z'"
  ])('rechecks changed master references before apply: %s', async (sql) => {
    const p = await preview()
    sqlite.exec(sql)
    const before = state()
    await expect(command(p)).rejects.toBeInstanceOf(NativeCatalogImportError)
    expect(state()).toEqual(before)
  })
  it('rechecks references inside atomic batch, not only preflight', async () => {
    const p = await preview(),
      before = state()
    await expect(
      command(
        p,
        'apply',
        'race',
        interpose(() => sqlite.exec('UPDATE inventory_locations SET active=0'))
      )
    ).rejects.toBeInstanceOf(NativeCatalogImportError)
    expect(state()).toEqual(before)
  })
  it('rolls back every domain, command and audit write if a late audit fails', async () => {
    const p = await preview(),
      before = state()
    sqlite.exec(
      "CREATE TRIGGER native_test_abort BEFORE INSERT ON catalog_native_audit BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END"
    )
    await expect(command(p)).rejects.toThrow()
    expect(state()).toEqual(before)
    expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('pending')
  })
  it('allows only one apply when two independent keys race', async () => {
    const p = await preview()
    const results = await Promise.allSettled([command(p, 'apply', 'race-a'), command(p, 'apply', 'race-b')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(rows('products')).toHaveLength(1)
    expect(rows('variants')).toHaveLength(1)
    expect(rows('catalog_native_commands')).toHaveLength(1)
  })
  it('reverts by compensation and retains imported records and append-only evidence', async () => {
    const p = await preview()
    await command(p)
    const originalMovement = rows('inventory_movements')[0]
    const receipt = await command(p, 'revert')
    expect(rows('products')[0]).toMatchObject({ status: 'discontinued' })
    expect(rows('variants')[0]).toMatchObject({ status: 'discontinued' })
    expect(rows('inventory_balances')[0]).toMatchObject({ physical_quantity: 0, blocked_quantity: 0 })
    expect(rows('inventory_movements')[0]).toEqual(originalMovement)
    expect(rows('inventory_movements')[1]).toMatchObject({
      physical_delta: -40,
      reserved_delta: 0,
      reference_type: 'catalog_native_import',
      reference_id: receipt.commandId,
      reason
    })
    expect(rows('variant_price_versions')[0]).toMatchObject({
      status: 'cancelled',
      cancelled_by: actor,
      cancellation_reason: reason
    })
    expect(rows('media_assets')).toHaveLength(1)
    expect(rows('product_media')).toHaveLength(1)
    expect(rows('catalog_native_commands')).toHaveLength(2)
    expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('reverted')
  })
  it.each([
    "UPDATE products SET description='Edited afterwards'",
    "UPDATE variants SET format='Changed afterwards'",
    'UPDATE inventory_balances SET physical_quantity=41,version=2',
    'UPDATE variant_price_versions SET gross_cents=1600',
    "UPDATE media_assets SET alt_text='Changed afterwards'"
  ])('refuses revert after post-state mutation: %s', async (sql) => {
    const p = await preview()
    await command(p)
    sqlite.exec(sql)
    const before = state()
    await expect(command(p, 'revert')).rejects.toBeInstanceOf(NativeCatalogImportError)
    expect(state()).toEqual(before)
  })
  it('refuses revert for a reserved imported variant even when physical balance is unchanged', async () => {
    const p = await preview()
    await command(p)
    sqlite
      .prepare(
        "INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,expires_at,created_at,updated_at) VALUES ('native-reservation','native-reservation',?,'reserved','test',?,?,?)"
      )
      .run('b'.repeat(64), utc(3600_000), utc(), utc())
    sqlite
      .prepare(
        "INSERT INTO inventory_reservation_lines(reservation_id,variant_id,location_id,quantity) VALUES ('native-reservation',?,?,1)"
      )
      .run(ids.variant, warehouse)
    const before = state()
    await expect(command(p, 'revert')).rejects.toBeInstanceOf(NativeCatalogImportError)
    expect(state()).toEqual(before)
  })
  it.each([
    'product_id',
    'product_legacy_id',
    'product_slug',
    'variant_id',
    'variant_legacy_id',
    'sku',
    'ean',
    'asset_id',
    'asset_checksum_sha256',
    'asset_storage_key'
  ] as const)('rejects existing %s rather than upserting', async (field) => {
    const p = await preview()
    await command(p)
    const next = {
      ...record(),
      product_id: testUuid(),
      product_legacy_id: '900002',
      product_slug: 'new-product',
      variant_id: testUuid(),
      variant_legacy_id: '910002',
      sku: 'NEW-SKU',
      ean: '5901234123457',
      asset_id: testUuid(),
      asset_checksum_sha256: 'b'.repeat(64),
      asset_storage_key: 'clean/new-product.png'
    }
    next[field] = record()[field]
    const before = state()
    expect((await previewNativeCatalogImport(database, claims, { records: [next] })).outcome).toBe('invalid')
    expect(state()).toEqual(before)
  })
  it('checks EAN against existing GTIN across identifier columns', async () => {
    const p = await preview()
    await command(p)
    sqlite.prepare('UPDATE variants SET gtin=ean,ean=NULL WHERE id=?').run(ids.variant)
    const next = {
      ...record(),
      product_id: testUuid(),
      product_legacy_id: '900002',
      product_slug: 'new-product',
      variant_id: testUuid(),
      variant_legacy_id: '910002',
      sku: 'NEW-SKU',
      asset_id: testUuid(),
      asset_checksum_sha256: 'b'.repeat(64),
      asset_storage_key: 'clean/new.png'
    }
    expect((await previewNativeCatalogImport(database, claims, { records: [next] })).outcome).toBe('invalid')
  })
  it('rejects identifiers taken after preview and leaves the winner untouched', async () => {
    const first = await preview(),
      second = await preview()
    await command(first)
    const before = state()
    await expect(command(second)).rejects.toBeInstanceOf(NativeCatalogImportError)
    expect(state()).toEqual(before)
  })
  it('rejects multiple inventory warehouses and non-warehouse balances', async () => {
    const secondWarehouse = testUuid()
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'SECOND-WH','Second warehouse','warehouse',1,?)"
      )
      .run(secondWarehouse, utc(-86400_000))
    const inventory = [
      { locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 },
      { locationId: secondWarehouse, physicalQuantity: 5, blockedQuantity: 0, version: 1 }
    ]
    expect(
      (
        await previewNativeCatalogImport(database, claims, {
          records: [{ ...record(), inventory_json: JSON.stringify(inventory) }]
        })
      ).outcome
    ).toBe('invalid')
    sqlite.prepare("UPDATE inventory_locations SET kind='store' WHERE id=?").run(warehouse)
    expect((await previewNativeCatalogImport(database, claims, { records: [record()] })).outcome).toBe('invalid')
    expect(rows('catalog_native_previews')).toHaveLength(0)
  })
  it('deduplicates consistent product and asset descriptors across multiple new variants', async () => {
    const second = {
      ...record(),
      variant_id: testUuid(),
      variant_legacy_id: '910002',
      sku: 'DET-5L-SECOND',
      ean: '5901234123457'
    }
    const p = await preview(database, [record(), second])
    expect(p.counts).toEqual({ products: 1, variants: 2, assets: 1, mappings: 1 })
    await command(p)
    expect(rows('products')).toHaveLength(1)
    expect(rows('variants')).toHaveLength(2)
    expect(rows('media_assets')).toHaveLength(1)
    expect(rows('product_media')).toHaveLength(1)
    expect(rows('inventory_balances')).toHaveLength(2)
    expect(rows('variant_price_versions')).toHaveLength(2)
  })
  it('requires all 71 columns and rejects unsupported additional fields', async () => {
    const incomplete: Record<string, string> = { ...record() }
    delete incomplete.cost_net_cents
    for (const input of [incomplete, { ...record(), injectedField: 'forbidden' }]) {
      expect((await previewNativeCatalogImport(database, claims, { records: [input] })).outcome).toBe('invalid')
    }
    expect(rows('catalog_native_previews')).toHaveLength(0)
  })
  it('initializes zero stock without fabricating a forbidden zero initial movement', async () => {
    const empty = {
      ...record(),
      inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 0, blockedQuantity: 0, version: 1 }])
    }
    const p = await preview(database, [empty])
    await command(p)
    expect(rows('inventory_balances')[0]).toMatchObject({ physical_quantity: 0, blocked_quantity: 0 })
    expect(rows('inventory_movements')).toHaveLength(0)
    await command(p, 'revert')
    expect(rows('inventory_movements')).toHaveLength(0)
    expect(rows('variants')[0]).toMatchObject({ status: 'discontinued' })
  })
  it('advances shared native-authoring legacy counters and never rewinds them on compensation', async () => {
    const p = await preview()
    await command(p)
    const counters = [
      { entity: 'product', last_id: 900001 },
      { entity: 'variant', last_id: 910001 }
    ]
    expect(rows('catalog_draft_legacy_counters')).toEqual(counters)
    await command(p, 'revert')
    expect(rows('catalog_draft_legacy_counters')).toEqual(counters)
    const receipt = await executeD1CatalogDraftAuthoringCommand(
      database,
      claims,
      'create_draft',
      {},
      {
        expectedVersion: 0,
        reason,
        name: 'Next native authored draft',
        categoryId: 54,
        brandId: ids.brand,
        shortDesc: 'Synthetic next draft description',
        description: 'Local-only authoring after native import compensation',
        usage: null,
        series: null,
        featured: false,
        badges: [],
        visual: { type: 'botella', color: '#00aa00' },
        attrs: [],
        initialVariant: {
          sku: 'NATIVE-NEXT-AUTHORED',
          format: 'Botella 1 L',
          ean: null,
          gtin: null,
          mpn: null,
          taxClassId: ids.tax,
          shippingProfileId: ids.shipping,
          unitBase: 'L',
          unitLabel: 'litro',
          contentQuantity: 1,
          unitsPerCase: 6,
          casesPerPallet: null,
          minimumQuantity: 1,
          quantityIncrement: 1,
          maximumQuantity: null,
          weightGrams: 1100,
          widthMm: 100,
          heightMm: 200,
          depthMm: 100,
          backorderAllowed: false,
          leadTimeDays: null,
          color: null
        }
      },
      { idempotencyKey: 'native-next-authored' }
    )
    expect(receipt).toMatchObject({ productId: 900002, variantId: 910002 })
  })
  it('rolls back a compensating revert when its final audit write fails', async () => {
    const p = await preview()
    await command(p)
    const before = state()
    sqlite.exec(
      "CREATE TRIGGER native_revert_test_abort BEFORE INSERT ON catalog_native_audit WHEN EXISTS(SELECT 1 FROM catalog_native_commands WHERE id=NEW.command_id AND action='revert') BEGIN SELECT RAISE(ABORT,'synthetic revert fault'); END"
    )
    await expect(command(p, 'revert')).rejects.toThrow()
    expect(state()).toEqual(before)
    expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('applied')
  })
  it.each(['variant_price_versions', 'product_media', 'inventory_balances'])(
    'rejects silent ignored %s inserts and rolls back the whole apply',
    async (table) => {
      const empty = {
        ...record(),
        inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 0, blockedQuantity: 0, version: 1 }])
      }
      const p = await preview(database, [empty]),
        before = state()
      sqlite.exec(`CREATE TRIGGER native_ignore_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`)
      await expect(command(p)).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
      expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('pending')
    }
  )
  it.each([
    ['products', "description='Synthetic trigger corruption'"],
    ['variants', "format='Synthetic trigger corruption'"],
    ['media_assets', "metadata='{}'"],
    ['inventory_balances', 'blocked_quantity=0'],
    ['variant_price_versions', 'gross_cents=1600']
  ])('rejects silently altered %s post-state rather than auditing corruption as success', async (table, mutation) => {
    const p = await preview(),
      before = state()
    // Alter products only after their FTS insert trigger has completed. Updating
    // an FTS-backed product from its own insert trigger corrupts the test index
    // before the import's postcondition can be reached.
    const triggerTable = table === 'products' ? 'variants' : table
    sqlite.exec(
      `CREATE TRIGGER native_corrupt_insert AFTER INSERT ON ${triggerTable} BEGIN UPDATE ${table} SET ${mutation}; END`
    )
    await expect(command(p)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(state()).toEqual(before)
  })
  it.each(['inventory_balances', 'variant_price_versions'])(
    'rejects silent ignored %s compensation instead of returning a partial revert',
    async (table) => {
      const p = await preview()
      await command(p)
      const before = state()
      sqlite.exec(`CREATE TRIGGER native_ignore_compensation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`)
      await expect(command(p, 'revert')).rejects.toMatchObject({ code: 'version_conflict' })
      expect(state()).toEqual(before)
      expect((await readNativeCatalogImportPreview(database, claims, p.id)).status).toBe('applied')
    }
  )
  it.each([
    ['products', "description='Corrupted during compensation'"],
    ['variants', "format='Corrupted during compensation'"],
    ['media_assets', "metadata='{}'"],
    ['variant_price_versions', 'gross_cents=1600']
  ])('preserves unchanged %s fields during compensation or rolls everything back', async (table, mutation) => {
    const p = await preview()
    await command(p)
    const before = state()
    sqlite.exec(
      `CREATE TRIGGER native_corrupt_compensation AFTER UPDATE ON inventory_balances BEGIN UPDATE ${table} SET ${mutation}; END`
    )
    await expect(command(p, 'revert')).rejects.toMatchObject({ code: 'version_conflict' })
    expect(state()).toEqual(before)
  })
  it.each([
    "UPDATE tax_classes SET valid_from='not-an-instant'",
    "UPDATE tax_classes SET valid_until='not-an-instant'",
    "UPDATE tax_classes SET valid_from='2099-01-01T00:00:00Z'"
  ])('rejects unparseable or future live tax windows: %s', async (sql) => {
    sqlite.exec(sql)
    expect((await previewNativeCatalogImport(database, claims, { records: [record()] })).outcome).toBe('invalid')
    expect(rows('catalog_native_previews')).toHaveLength(0)
  })
  it.each([
    { minimum_quantity: '10', maximum_quantity: '5', quantity_increment: '3' },
    { price_gross_cents: '0' },
    { compare_at_gross_cents: '1500' }
  ])('rejects impossible initialization values even for draft-status tabular input', async (overrides) => {
    const malformed = {
      ...record(),
      product_status: 'draft',
      variant_status: 'draft',
      ...overrides
    }
    expect((await previewNativeCatalogImport(database, claims, { records: [malformed] })).outcome).toBe('invalid')
    expect(rows('catalog_native_previews')).toHaveLength(0)
  })
  it('treats forged media metadata as unverified data, never as scanner or rights approval', async () => {
    const forged = {
      ...record(),
      asset_metadata_json: JSON.stringify({
        scanStatus: 'clean',
        rightsStatus: 'approved',
        published: true,
        scannerReceipt: { approved: true },
        publicUrl: 'https://example.invalid/fake-clean.png'
      })
    }
    const p = await preview(database, [forged])
    await command(p)
    expect(rows('media_assets')[0]).toMatchObject({ rights_status: 'pending', quarantine_status: 'pending' })
    for (const table of [
      'media_uploads',
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications'
    ])
      expect(rows(table)).toHaveLength(0)
  })
  it('initializes and reverts many variants under real D1 SQL limits with bounded bindings', async () => {
    const count = 40
    const records = Array.from({ length: count }, (_unused, index) => ({
      ...record(),
      variant_id: testUuid(),
      variant_legacy_id: String(910001 + index),
      sku: `NATIVE-BOUND-${index}`,
      ean: '',
      gtin: '',
      mpn: `MPN-${index}`,
      identifier_exception_reason: 'Synthetic supplier has no globally registered code'
    }))
    const bindingCounts: number[] = []
    const traced = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        return {
          ...statement,
          bind(...values: unknown[]) {
            bindingCounts.push(values.length)
            return statement.bind(...values)
          }
        }
      }
    } as D1Database
    const p = await preview(traced, records)
    expect(p.counts.variants).toBe(count)
    await command(p, 'apply', 'bounded-apply', traced)
    await command(p, 'revert', 'bounded-revert', traced)
    expect(rows('variants')).toHaveLength(count)
    expect(rows('variants').every((row) => row.status === 'discontinued')).toBe(true)
    expect(Math.max(...bindingCounts)).toBeLessThanOrEqual(100)
    expect(sqlite.limits.exprDepth).toBe(100)
    expect(sqlite.limits.variableNumber).toBe(100)
    expect(sqlite.limits.functionArg).toBe(32)
    expect(sqlite.limits.compoundSelect).toBe(5)
    expect(sqlite.limits.likePatternLength).toBe(50)
  })
  it.each([
    { variant_source_version: 'mismatched-source' },
    {
      inventory_json: JSON.stringify([{ locationId: testUuid(), physicalQuantity: 40, blockedQuantity: 2, version: 1 }])
    },
    { price_gross_cents: '-1' },
    { product_attributes_json: '{invalid' }
  ])('rejects malformed/unsupported full tabular records without persisting previews', async (overrides) => {
    const before = state()
    expect(
      (await previewNativeCatalogImport(database, claims, { records: [{ ...record(), ...overrides }] })).outcome
    ).toBe('invalid')
    expect(rows('catalog_native_previews')).toHaveLength(0)
    expect(state()).toEqual(before)
  })
  it('bounds record count and JSON bytes before persistence without leaking values', async () => {
    const tooMany = await previewNativeCatalogImport(database, claims, {
      records: Array.from({ length: 501 }, () => record())
    })
    expect(tooMany.outcome).toBe('invalid')
    const secret = 'PRIVATE_NATIVE_MARKER'
    const tooLarge = await previewNativeCatalogImport(database, claims, {
      records: [{ ...record(), description: secret + 'x'.repeat(900001) }]
    })
    expect(tooLarge.outcome).toBe('invalid')
    expect(JSON.stringify(tooLarge)).not.toContain(secret)
    expect(rows('catalog_native_previews')).toHaveLength(0)
  })
})
