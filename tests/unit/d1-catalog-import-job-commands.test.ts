import { readFile } from 'node:fs/promises'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { validateCatalogRecords, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import type { CatalogImportJob } from '../../shared/catalog-import-job'
import {
  createCatalogImportJob,
  uploadCatalogImportJobPage,
  sealCatalogImportJob,
  readCatalogImportJob
} from '../../workers/catalog/import-job'
import { executeCatalogImportJobCommand } from '../../workers/catalog/import-job-commands'
import { NativeCatalogImportError } from '../../workers/catalog/native-import'
import { testUuid, testNow } from '../support/deterministic'

const actor = '00570000-0000-4000-8000-000000000001'
const session = '00570000-0000-4000-8000-000000000002'
const warehouse = '00570000-0000-4000-8000-000000000003'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const reason = 'Synthetic whole-job apply approval, local tests only'
const revertReason = 'Synthetic whole-job stock compensation, local tests only'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const uuid = (kind: number, index: number) =>
  `0057${String(kind).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('sealed catalog jobs: whole-job atomic application and compensating reversion', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    // The adapter migration list belongs to the implementation owner. When the
    // new migration arrives first, apply it once without assuming its tables.
    const adapter = await readFile(new URL('../support/d1-sqlite.ts', import.meta.url), 'utf8')
    if (!adapter.includes("'0057_catalog_import_job_commands.sql'"))
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0057_catalog_import_job_commands.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    sqlite.limits.likePatternLength = 50
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'COMMAND-JOB','Supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,57,'Category','command-job-category','published')"
      )
      .run(ids.category)
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Brand','command-job-brand','published')")
      .run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'COMMAND-JOB-TAX','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'COMMAND-JOB-SHIP','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'COMMAND-JOB-WH','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('command-job','Job importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('command-job',?)").run(`${resource}.${action}`)
    }
    seedActor(actor, session, 'owner57@example.invalid')
  })
  afterEach(() => {
    sqlite?.close()
    vi.restoreAllMocks()
  })
  function seedActor(identity: string, sessionId: string, email: string) {
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,?,'unusable-synthetic',?,'active',?,?)"
      )
      .run(identity, email, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'command-job',?)")
      .run(identity, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(sessionId, identity, utc(-86400_000), utc(72 * 3600_000))
  }
  function record(index = 1): CatalogTabularRecord {
    const product = uuid(1, index),
      variant = uuid(2, index),
      asset = uuid(3, index)
    return {
      ...catalogRecord(),
      product_id: product,
      product_legacy_id: String(970000 + index),
      product_slug: 'command-job-product-' + index,
      variant_id: variant,
      variant_legacy_id: String(980000 + index),
      sku: 'COMMAND-JOB-' + index,
      ean: '',
      gtin: '',
      mpn: 'MPN-COMMAND-JOB-' + index,
      identifier_exception_reason: 'Supplier MPN only; import remains an unpublished draft',
      product_attributes_json: JSON.stringify({
        image: '/media/' + asset,
        imageAlt: catalogRecord().asset_alt_text,
        imageRights: {
          owner: catalogRecord().asset_owner_name,
          license: catalogRecord().asset_license,
          authorizedAt: catalogRecord().asset_authorized_at
        },
        batch: index
      }),
      inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }]),
      asset_id: asset,
      asset_storage_key: `clean/${asset}.png`,
      asset_checksum_sha256: index.toString(16).padStart(64, '0'),
      asset_source_url: '/media/' + asset,
      asset_metadata_json: JSON.stringify({ language: 'es', provenance: 'supplier', batch: index })
    }
  }
  async function sealed(records = [record()], options: { now?: string } = {}) {
    expect(validateCatalogRecords(records).valid).toBe(true)
    const parts: CatalogTabularRecord[][] = []
    for (let offset = 0; offset < records.length; offset += 201) parts.push(records.slice(offset, offset + 201))
    const job = await createCatalogImportJob(
      database,
      claims,
      { totalPages: parts.length, recordCount: records.length },
      options
    )
    for (let index = 0; index < parts.length; index++) {
      expect(new TextEncoder().encode(JSON.stringify({ records: parts[index] })).byteLength).toBeLessThanOrEqual(900000)
      expect(
        await uploadCatalogImportJobPage(database, claims, job.id, { index, records: parts[index] }, options)
      ).toMatchObject({ outcome: 'job', receivedPages: index + 1 })
    }
    const ready = await sealCatalogImportJob(database, claims, job.id, { reason }, options)
    if (ready.outcome !== 'job') throw new Error('fixture_seal_failed')
    expect(ready.status).toBe('ready')
    return ready
  }
  const rows = (table: string) => sqlite.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all()
  // Discover command/audit tables rather than prescribing the new migration's
  // implementation. FTS shadow tables are derived indexes, not domain records.
  function snapshot() {
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' ORDER BY name"
      )
      .all()
    return Object.fromEntries(tables.map(({ name }) => [String(name), rows(String(name))]))
  }
  const command = (
    job: CatalogImportJob,
    action: 'apply' | 'revert' = 'apply',
    key = testUuid(),
    db = database,
    options: { now?: string } = {}
  ) =>
    executeCatalogImportJobCommand(
      db,
      claims,
      job.id,
      action,
      { previewHash: job.hash!, reason: action === 'apply' ? reason : revertReason },
      key,
      options
    )
  function expectReceipt(receipt: unknown, job: CatalogImportJob, action: 'apply' | 'revert') {
    expect(receipt).toEqual({
      source: 'cloudflare',
      action,
      jobId: job.id,
      jobHash: job.hash,
      commandId: expect.stringMatching(uuidPattern),
      counts: job.counts,
      updated: true
    })
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
  async function conflictWithoutEffects(job: CatalogImportJob, action: 'apply' | 'revert' = 'apply', db = database) {
    const before = snapshot()
    await expect(command(job, action, testUuid(), db)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(snapshot()).toEqual(before)
  }

  it('checks unused media in real revert guards with full staging keys rather than per-row correlated lists', async () => {
    const job = await sealed([record(1), record(2)])
    await command(job)
    const captured: Array<{ sql: string; bindings: SQLInputValue[] }> = []
    const observedDatabase: D1Database = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        return {
          ...statement,
          bind(...bindings: SQLInputValue[]) {
            captured.push({ sql, bindings: [...bindings] })
            return statement.bind(...bindings)
          }
        }
      }
    }
    expectReceipt(await command(job, 'revert', testUuid(), observedDatabase), job, 'revert')
    const statements = captured.filter(
      ({ sql }) =>
        sql.includes('product_media') &&
        (sql.includes('INSERT INTO catalog_import_job_commands') ||
          sql.includes('INSERT INTO catalog_import_job_guards'))
    )
    expect(statements).toHaveLength(2)
    for (const { sql, bindings } of statements) {
      const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(...bindings)
      const media = plan.filter(({ detail }) => /^(?:SCAN|SEARCH) product_media\b/.test(String(detail)))
      expect(media).toHaveLength(1)
      const blockParent = media[0]!.parent
      const descendant = (node: (typeof plan)[number]): boolean => {
        if (node.parent === blockParent) return true
        const parent = plan.find(({ id }) => id === node.parent)
        return parent !== undefined && parent.id !== parent.parent && descendant(parent)
      }
      const block = plan.filter(descendant)
      expect(
        block.some(({ detail }) => /CORRELATED LIST SUBQUERY/.test(String(detail))),
        JSON.stringify(block)
      ).toBe(false)
      expect(
        block.filter(({ detail }) =>
          /catalog_import_job_entries_\d+ \(job_id=\? AND kind=\? AND item_id=\?\)/.test(String(detail))
        ),
        JSON.stringify(block)
      ).toHaveLength(2)
    }
  })

  it('looks up final-guard variants by primary identity rather than a nullable EAN/GTIN index', async () => {
    const job = await sealed([record(1), record(2)])
    const captured: Array<{ sql: string; bindings: SQLInputValue[] }> = []
    const observedDatabase: D1Database = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        return {
          ...statement,
          bind(...bindings: SQLInputValue[]) {
            captured.push({ sql, bindings: [...bindings] })
            return statement.bind(...bindings)
          }
        }
      }
    }
    expectReceipt(await command(job, 'apply', testUuid(), observedDatabase), job, 'apply')
    expect(rows('variants').map(({ ean, gtin }) => ({ ean, gtin }))).toEqual([
      { ean: null, gtin: null },
      { ean: null, gtin: null }
    ])
    const guards = captured.filter(
      ({ sql }) => sql.includes('live_command AS') && sql.includes('INSERT INTO catalog_import_job_guards')
    )
    expect(guards).toHaveLength(1)
    const guard = guards[0]!
    const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + guard.sql).all(...guard.bindings)
    // The first source/variant join is fullRows' value-by-value proof, not the
    // independent audit/scope checks later in this same generated guard.
    const variantsLookup = plan.find(({ detail }) =>
      /^SEARCH r USING (?:COVERING )?INDEX .*variants_/.test(String(detail))
    )
    // A rowid-directed implementation can use an INTEGER PRIMARY KEY lookup
    // plus a correlated identity lookup instead of naming a schema index.
    const identityLookups = plan.filter(({ detail }) =>
      /^SEARCH identity USING (?:COVERING )?INDEX .*variants_/.test(String(detail))
    )
    const relevant = plan.filter(({ detail }) =>
      /^(?:SCAN|SEARCH) (?:r|identity|catalog_import_job_entries)\b/.test(String(detail))
    )
    expect(
      relevant.some(({ detail }) => /\b(?:ean|gtin)=\?/.test(String(detail))),
      JSON.stringify(relevant)
    ).toBe(false)
    expect(
      (variantsLookup !== undefined && /\(id=\?\)/.test(String(variantsLookup.detail))) ||
        identityLookups.some(({ detail }) => /\(id=\?\)/.test(String(detail))),
      JSON.stringify(relevant)
    ).toBe(true)
  })

  it('applies all601 full71-column rows across3pages in one batch, preserving fields and pending-only draft authority', async () => {
    const all = Array.from({ length: 601 }, (_, index) => record(index + 1)),
      job = await sealed(all)
    expect(job).toMatchObject({
      totalPages: 3,
      receivedPages: 3,
      recordCount: 601,
      counts: { products: 601, variants: 601, assets: 601, mappings: 601 }
    })
    for (const table of [
      'products',
      'variants',
      'variant_price_versions',
      'inventory_balances',
      'inventory_movements',
      'media_assets',
      'product_media'
    ])
      expect(rows(table)).toHaveLength(0)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external network permitted'))
    const authorityBefore = ['permissions', 'role_permissions', 'identity_roles'].map(rows)
    const batch = vi.spyOn(database, 'batch'),
      receipt = await command(job)
    expectReceipt(receipt, job, 'apply')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(await readCatalogImportJob(database, claims, job.id)).toMatchObject({
      status: 'applied',
      hash: job.hash,
      counts: job.counts
    })
    for (const table of [
      'products',
      'variants',
      'variant_price_versions',
      'inventory_balances',
      'inventory_movements',
      'media_assets',
      'product_media'
    ])
      expect(rows(table)).toHaveLength(601)
    for (const source of [all[0]!, all[200]!, all[201]!, all[401]!, all[402]!, all[600]!]) {
      const product = sqlite.prepare('SELECT * FROM products WHERE id=?').get(source.product_id)!
      expect(product).toMatchObject({
        id: source.product_id,
        legacy_id: Number(source.product_legacy_id),
        category_id: ids.category,
        brand_id: ids.brand,
        source_id: ids.source,
        name: source.product_name,
        slug: source.product_slug,
        short_description: source.short_description,
        description: source.description,
        usage: source.product_usage,
        series: source.product_series,
        status: 'draft',
        featured: 1,
        attributes: source.product_attributes_json,
        regulatory: source.product_regulatory_json,
        source_version: source.source_version,
        published_at: null,
        catalog_version: 1
      })
      const variant = sqlite.prepare('SELECT * FROM variants WHERE id=?').get(source.variant_id)!
      expect(variant).toMatchObject({
        id: source.variant_id,
        legacy_id: Number(source.variant_legacy_id),
        product_id: source.product_id,
        tax_class_id: ids.tax,
        shipping_profile_id: ids.shipping,
        sku: source.sku,
        ean: null,
        gtin: null,
        mpn: source.mpn,
        identifier_exception_reason: source.identifier_exception_reason,
        format: source.format,
        status: 'draft',
        unit_base: 'l',
        unit_label: 'litro',
        content_quantity: 5,
        units_per_case: 4,
        cases_per_pallet: 30,
        minimum_quantity: 1,
        quantity_increment: 1,
        maximum_quantity: 20,
        price_gross_cents: 1599,
        compare_at_gross_cents: 1799,
        cost_net_cents: 800,
        currency: 'EUR',
        weight_grams: 5200,
        width_mm: 180,
        height_mm: 320,
        depth_mm: 130,
        safety_stock: 2,
        backorder_allowed: 0,
        lead_time_days: null,
        color: '#00AACC',
        image: source.variant_image,
        source_version: source.variant_source_version
      })
      const price = sqlite.prepare('SELECT * FROM variant_price_versions WHERE variant_id=?').get(source.variant_id)!
      expect(price).toMatchObject({
        gross_cents: 1599,
        compare_at_gross_cents: 1799,
        reference_gross_cents_30d: null,
        volume_tiers: '[]',
        status: 'approved',
        reason,
        created_by: actor,
        valid_from: variant.created_at,
        valid_until: null,
        created_at: variant.created_at,
        cancelled_by: null,
        cancelled_at: null,
        cancellation_reason: null
      })
      expect(
        sqlite.prepare('SELECT * FROM inventory_balances WHERE variant_id=?').get(source.variant_id)
      ).toMatchObject({
        location_id: warehouse,
        physical_quantity: 40,
        blocked_quantity: 2,
        version: 1,
        created_at: variant.created_at,
        updated_at: variant.created_at
      })
      expect(
        sqlite.prepare('SELECT * FROM inventory_movements WHERE variant_id=?').get(source.variant_id)
      ).toMatchObject({
        location_id: warehouse,
        movement_type: 'initial',
        physical_delta: 40,
        reserved_delta: 0,
        reference_type: 'catalog_native_import',
        reference_id: receipt.commandId,
        correlation_id: job.id,
        reason,
        created_at: variant.created_at
      })
      expect(sqlite.prepare('SELECT * FROM media_assets WHERE id=?').get(source.asset_id)).toMatchObject({
        storage_key: source.asset_storage_key,
        original_name: source.asset_original_name,
        mime_type: 'image/png',
        byte_size: 24000,
        checksum_sha256: source.asset_checksum_sha256,
        owner_name: source.asset_owner_name,
        source_url: source.asset_source_url,
        license: source.asset_license,
        authorized_at: source.asset_authorized_at,
        rights_status: 'pending',
        quarantine_status: 'pending',
        alt_text: source.asset_alt_text,
        metadata: source.asset_metadata_json,
        created_at: product.created_at
      })
      expect(sqlite.prepare('SELECT * FROM product_media WHERE product_id=?').get(source.product_id)).toMatchObject({
        variant_id: null,
        asset_id: source.asset_id,
        role: 'primary',
        version: '1',
        sort_order: 0
      })
    }
    for (const table of [
      'media_uploads',
      'media_scan_receipts',
      'media_rights_decisions',
      'product_media_publications',
      'catalog_policy_commands'
    ])
      expect(rows(table)).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(['permissions', 'role_permissions', 'identity_roles'].map(rows)).toEqual(authorityBefore)
    expect(sqlite.limits).toMatchObject({
      exprDepth: 100,
      variableNumber: 100,
      functionArg: 32,
      compoundSelect: 5,
      likePatternLength: 50
    })
  }, 60000)

  it('durably replays a lost apply response byte-for-byte, recovers status through GET and refuses changed/opposite/new-key commands', async () => {
    const job = await sealed(),
      key = testUuid(),
      receipt = await command(job, 'apply', key),
      before = snapshot()
    expectReceipt(receipt, job, 'apply')
    expect(JSON.stringify(await command(job, 'apply', key, d1OverSqlite(sqlite)))).toBe(JSON.stringify(receipt))
    expect(snapshot()).toEqual(before)
    expect(await readCatalogImportJob(d1OverSqlite(sqlite), claims, job.id)).toMatchObject({
      status: 'applied',
      hash: job.hash
    })
    for (const [action, body] of [
      ['apply', { previewHash: job.hash!, reason: reason + ' changed' }],
      ['revert', { previewHash: job.hash!, reason }]
    ] as const) {
      await expect(executeCatalogImportJobCommand(database, claims, job.id, action, body, key)).rejects.toMatchObject({
        code: 'idempotency_conflict'
      })
      expect(snapshot()).toEqual(before)
    }
    await expect(command(job)).rejects.toMatchObject({ code: 'already_applied' })
    expect(snapshot()).toEqual(before)
  })

  it('uses expiry only for first apply; allows authorized receipt replay and exact compensation after expiry', async () => {
    const now = utc(),
      job = await sealed([record()], { now }),
      key = testUuid(),
      receipt = await command(job, 'apply', key, database, { now })
    const expired = new Date(Date.parse(job.expiresAt) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      before = snapshot()
    expect(JSON.stringify(await command(job, 'apply', key, database, { now: expired }))).toBe(JSON.stringify(receipt))
    expect(snapshot()).toEqual(before)
    expectReceipt(await command(job, 'revert', testUuid(), database, { now: expired }), job, 'revert')
    expect(await readCatalogImportJob(database, claims, job.id, { now: expired })).toMatchObject({ status: 'reverted' })
  })
  it('rejects an expired first apply without effects', async () => {
    const job = await sealed(),
      before = snapshot()
    await expect(command(job, 'apply', testUuid(), database, { now: job.expiresAt })).rejects.toMatchObject({
      code: 'preview_expired'
    })
    expect(snapshot()).toEqual(before)
  })
  it.each(['2026-10-04T12:00:00.000Z', '2026-10-04T12:00:00+00:00', 'not-a-time'])(
    'rejects noncanonical command time %s without writes',
    async (now) => {
      const job = await sealed(),
        before = snapshot()
      await expect(command(job, 'apply', testUuid(), database, { now })).rejects.toMatchObject({
        code: 'invalid_input'
      })
      expect(snapshot()).toEqual(before)
    }
  )
  it('rejects missing/mismatched hashes and unsealed jobs before effects', async () => {
    const job = await sealed(),
      uploading = await createCatalogImportJob(database, claims, { totalPages: 1, recordCount: 1 }),
      before = snapshot()
    await expect(
      executeCatalogImportJobCommand(
        database,
        claims,
        job.id,
        'apply',
        { previewHash: '0'.repeat(64), reason },
        testUuid()
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeCatalogImportJobCommand(database, claims, job.id, 'apply', { reason }, testUuid())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      executeCatalogImportJobCommand(
        database,
        claims,
        uploading.id,
        'apply',
        { previewHash: '0'.repeat(64), reason },
        testUuid()
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(command(job, 'revert')).rejects.toMatchObject({ code: 'not_applied' })
    expect(snapshot()).toEqual(before)
  })
  it('keeps sealed jobs and cached command receipts private to their owner', async () => {
    const job = await sealed(),
      key = testUuid()
    await command(job, 'apply', key)
    const identityId = uuid(9, 1),
      sessionId = uuid(9, 2)
    seedActor(identityId, sessionId, 'other57@example.invalid')
    const other = { identityId, sessionId, sessionVersion: 1 },
      before = snapshot()
    await expect(readCatalogImportJob(database, other, job.id)).rejects.toMatchObject({ code: 'not_found' })
    for (const attemptKey of [key, testUuid()])
      await expect(
        executeCatalogImportJobCommand(database, other, job.id, 'apply', { previewHash: job.hash!, reason }, attemptKey)
      ).rejects.toMatchObject({ code: 'not_found' })
    expect(snapshot()).toEqual(before)
  })

  const authorityCases = [
    ['catalog.write', "DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden'],
    [
      'administration.manage',
      "DELETE FROM role_permissions WHERE permission_code='administration.manage'",
      'forbidden'
    ],
    ['inventory.write', "DELETE FROM role_permissions WHERE permission_code='inventory.write'", 'forbidden'],
    ['verified email', 'UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['MFA', 'UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['session', 'DELETE FROM auth_sessions', 'unauthenticated']
  ] as const
  it.each(authorityCases)(
    'rechecks current %s before new apply and cached apply/revert receipt replay',
    async (_name, change, code) => {
      const job = await sealed(),
        key = testUuid(),
        revertKey = testUuid()
      await command(job, 'apply', key)
      await command(job, 'revert', revertKey)
      const unapplied = await sealed([record(2)])
      sqlite.exec(change)
      const before = snapshot()
      for (const [target, action, attemptKey] of [
        [job, 'apply', key],
        [job, 'revert', revertKey],
        [unapplied, 'apply', testUuid()]
      ] as const) {
        await expect(command(target, action, attemptKey)).rejects.toMatchObject({ code })
        expect(snapshot()).toEqual(before)
      }
    }
  )
  it.each(authorityCases)(
    'rechecks current %s inside the final batch, rolling back if authority changes after reads',
    async (_name, change, code) => {
      const job = await sealed()
      let changed: ReturnType<typeof snapshot> | undefined
      const db = interpose(() => {
        sqlite.exec(change)
        changed = snapshot()
      })
      await expect(command(job, 'apply', testUuid(), db)).rejects.toMatchObject({ code })
      expect(changed).toBeDefined()
      expect(snapshot()).toEqual(changed)
    }
  )

  it.each([
    ['category', "UPDATE categories SET status='draft'"],
    ['brand', "UPDATE brands SET status='draft'"],
    ['source master', 'UPDATE catalog_sources SET is_master=0'],
    ['tax window', "UPDATE tax_classes SET valid_until='2020-02-01T00:00:00Z'"],
    ['warehouse', 'UPDATE inventory_locations SET active=0']
  ])('refuses live %s drift after seal without partial writes', async (_name, change) => {
    const job = await sealed()
    sqlite.exec(change)
    await conflictWithoutEffects(job)
  })
  it('checks references again in the batch rather than trusting preflight reads', async () => {
    const job = await sealed()
    let changed: ReturnType<typeof snapshot> | undefined
    const db = interpose(() => {
      sqlite.exec("UPDATE categories SET status='draft'")
      changed = snapshot()
    })
    await expect(command(job, 'apply', testUuid(), db)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(snapshot()).toEqual(changed)
  })
  it('refuses new identifier collisions introduced after sealing without upserting existing records', async () => {
    const recordA = record(),
      conflicting = { ...record(2), sku: recordA.sku },
      first = await sealed([recordA]),
      second = await sealed([conflicting])
    await command(first)
    await conflictWithoutEffects(second)
    expect(rows('products')).toHaveLength(1)
    expect(rows('variants')[0]).toMatchObject({ id: recordA.variant_id, sku: recordA.sku })
  })
  it('detects EAN/GTIN cross-field collisions against the live catalog after seal', async () => {
    const first = await sealed([{ ...record(), ean: '4006381333931' }]),
      second = await sealed([{ ...record(2), gtin: '4006381333931' }])
    await command(first)
    await conflictWithoutEffects(second)
  })
  it('rejects a second active warehouse at apply time and never writes multi-location balances', async () => {
    const job = await sealed()
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'OTHER-WH','Other','warehouse',1,?)"
      )
      .run(uuid(8, 1), utc())
    await conflictWithoutEffects(job)
  })
  it('refuses reuse of an actor idempotency key for a different sealed job', async () => {
    const first = await sealed(),
      second = await sealed([record(2)]),
      key = testUuid()
    await command(first, 'apply', key)
    const before = snapshot()
    await expect(command(second, 'apply', key)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(snapshot()).toEqual(before)
    expect(await readCatalogImportJob(database, claims, second.id)).toMatchObject({ status: 'ready' })
  })
  it('rejects unauthenticated claims before resolving a command receipt', async () => {
    const job = await sealed(),
      key = testUuid()
    await command(job, 'apply', key)
    const before = snapshot()
    await expect(
      executeCatalogImportJobCommand(database, null, job.id, 'apply', { previewHash: job.hash!, reason }, key)
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(snapshot()).toEqual(before)
  })

  it('rolls back every601-row mutation and counters on a late physical SQLite ABORT', async () => {
    const job = await sealed(Array.from({ length: 601 }, (_, index) => record(index + 1))),
      before = snapshot()
    sqlite.exec(
      `CREATE TRIGGER job_late_abort BEFORE INSERT ON product_media WHEN NEW.product_id='${uuid(1, 601)}' BEGIN SELECT RAISE(ABORT,'synthetic_late_job_failure'); END`
    )
    await expect(command(job)).rejects.toBeInstanceOf(Error)
    expect(snapshot()).toEqual(before)
    expect(await readCatalogImportJob(database, claims, job.id)).toMatchObject({ status: 'ready' })
  }, 60000)
  it.each([
    ['price insert', 'BEFORE INSERT ON variant_price_versions'],
    ['media insert', 'BEFORE INSERT ON product_media'],
    ['balance insert', 'BEFORE INSERT ON inventory_balances']
  ])('detects silently ignored %s and rolls back all state', async (_name, trigger) => {
    const job = await sealed(),
      before = snapshot()
    sqlite.exec(`CREATE TRIGGER job_silent_ignore ${trigger} BEGIN SELECT RAISE(IGNORE); END`)
    await conflictWithoutEffects(job)
    expect(snapshot()).toEqual(before)
  })
  it('detects a missing zero-stock balance despite there being no initial movement to check', async () => {
    const source = {
        ...record(),
        inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 0, blockedQuantity: 0, version: 1 }])
      },
      job = await sealed([source])
    sqlite.exec('CREATE TRIGGER job_zero_ignore BEFORE INSERT ON inventory_balances BEGIN SELECT RAISE(IGNORE); END')
    await conflictWithoutEffects(job)
  })
  it('rolls back apply if an audit insert replaces its null before snapshot with an object', async () => {
    const job = await sealed()
    sqlite.exec(`CREATE TRIGGER job_apply_audit_before_corruption
      BEFORE INSERT ON catalog_import_job_command_audit
      WHEN NEW.before_state IS NULL AND EXISTS(
        SELECT 1 FROM catalog_import_job_commands WHERE id=NEW.command_id AND action='apply')
      BEGIN
        INSERT INTO catalog_import_job_command_audit(command_id,kind,item_id,before_state,after_state)
        VALUES(NEW.command_id,NEW.kind,NEW.item_id,'{}',NEW.after_state);
        SELECT RAISE(IGNORE);
      END`)
    await conflictWithoutEffects(job)
  })
  it.each([
    [
      'product description',
      "AFTER INSERT ON variants BEGIN UPDATE products SET description='Unexpected trigger edit' WHERE id=NEW.product_id; END"
    ],
    ['variant cost', 'AFTER INSERT ON variants BEGIN UPDATE variants SET cost_net_cents=801 WHERE id=NEW.id; END'],
    [
      'asset metadata',
      `AFTER INSERT ON media_assets BEGIN UPDATE media_assets SET metadata='{"forged":true}' WHERE id=NEW.id; END`
    ],
    [
      'mapping sort',
      'AFTER INSERT ON product_media BEGIN UPDATE product_media SET sort_order=7 WHERE product_id=NEW.product_id; END'
    ]
  ])('detects silent %s changes and rejects partial success', async (_name, trigger) => {
    const job = await sealed()
    sqlite.exec('CREATE TRIGGER job_corruption ' + trigger)
    await conflictWithoutEffects(job)
  })
  it('allows exactly one concurrent apply of the whole601-row job', async () => {
    const job = await sealed(Array.from({ length: 601 }, (_, index) => record(index + 1)))
    // SQLite's adapter exposes one connection; serialize its physical batches
    // while leaving both command preflight reads concurrent, like D1's writer.
    let tail = Promise.resolve()
    const db = {
      ...database,
      batch: (statements: D1PreparedStatement[]) => {
        const result = tail.then(() => database.batch(statements))
        tail = result.then(
          () => undefined,
          () => undefined
        )
        return result
      }
    } as D1Database
    const results = await Promise.allSettled([
      command(job, 'apply', testUuid(), db),
      command(job, 'apply', testUuid(), db)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(NativeCatalogImportError)
    expect(['version_conflict', 'already_applied']).toContain(rejected.reason.code)
    expect(rows('products')).toHaveLength(601)
    expect(rows('variants')).toHaveLength(601)
    expect(rows('inventory_movements')).toHaveLength(601)
    expect(rows('variant_price_versions')).toHaveLength(601)
  }, 60000)

  it('compensates every601-row job atomically without deletion, retaining original ledger and monotonic counters', async () => {
    const job = await sealed(Array.from({ length: 601 }, (_, index) => record(index + 1))),
      applied = await command(job)
    const products = rows('products'),
      variants = rows('variants'),
      assets = rows('media_assets'),
      media = rows('product_media'),
      prices = rows('variant_price_versions'),
      balances = rows('inventory_balances'),
      initial = rows('inventory_movements'),
      counters = rows('catalog_draft_legacy_counters')
    const key = testUuid(),
      revertedAt = utc(60_000),
      batch = vi.spyOn(database, 'batch'),
      receipt = await command(job, 'revert', key, database, { now: revertedAt })
    expectReceipt(receipt, job, 'revert')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(await readCatalogImportJob(database, claims, job.id)).toMatchObject({
      status: 'reverted',
      hash: job.hash,
      counts: job.counts
    })
    expect(rows('products')).toEqual(
      products.map((row) => ({ ...row, status: 'discontinued', catalog_version: 2, updated_at: revertedAt }))
    )
    expect(rows('variants')).toEqual(
      variants.map((row) => ({
        ...row,
        status: 'discontinued',
        price_gross_cents: 0,
        compare_at_gross_cents: null,
        updated_at: revertedAt
      }))
    )
    expect(rows('media_assets')).toEqual(assets)
    expect(rows('product_media')).toEqual(media)
    expect(rows('variant_price_versions')).toEqual(
      prices.map((row) => ({
        ...row,
        status: 'cancelled',
        cancelled_by: actor,
        cancelled_at: revertedAt,
        cancellation_reason: revertReason
      }))
    )
    expect(rows('inventory_balances')).toEqual(
      balances.map((row) => ({
        ...row,
        physical_quantity: 0,
        blocked_quantity: 0,
        version: 2,
        updated_at: revertedAt
      }))
    )
    expect(rows('inventory_movements').filter((row) => row.reference_id === applied.commandId)).toEqual(initial)
    const compensation = rows('inventory_movements').filter((row) => row.reference_id === receipt.commandId)
    expect(compensation).toHaveLength(601)
    for (const row of compensation)
      expect(row).toMatchObject({
        location_id: warehouse,
        movement_type: 'adjustment',
        physical_delta: -40,
        reserved_delta: 0,
        reference_type: 'catalog_native_import',
        correlation_id: job.id,
        reason: revertReason,
        created_at: revertedAt
      })
    expect(sqlite.prepare('SELECT sum(physical_delta) AS n FROM inventory_movements').get()!.n).toBe(0)
    expect(rows('catalog_draft_legacy_counters')).toEqual(counters)
    expect(counters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'product', last_id: 970601 }),
        expect.objectContaining({ entity: 'variant', last_id: 980601 })
      ])
    )
    const after = snapshot()
    expect(JSON.stringify(await command(job, 'revert', key, d1OverSqlite(sqlite)))).toBe(JSON.stringify(receipt))
    await expect(command(job, 'revert')).rejects.toMatchObject({ code: 'already_reverted' })
    expect(snapshot()).toEqual(after)
  }, 60000)
  it('creates a zero-stock balance without inventing initial or compensation movements', async () => {
    const job = await sealed([
      {
        ...record(),
        inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 0, blockedQuantity: 0, version: 1 }])
      }
    ])
    await command(job)
    expect(rows('inventory_balances')).toHaveLength(1)
    expect(rows('inventory_movements')).toHaveLength(0)
    await command(job, 'revert')
    expect(rows('inventory_balances')[0]).toMatchObject({ physical_quantity: 0, blocked_quantity: 0, version: 2 })
    expect(rows('inventory_movements')).toHaveLength(0)
  })
  it('leaves another imported product, its prices and stock untouched during successful apply and compensation', async () => {
    const existing = await sealed(),
      firstReceipt = await command(existing)
    const protectedState = () => [
      sqlite.prepare('SELECT * FROM products WHERE id=?').all(record().product_id),
      sqlite.prepare('SELECT * FROM variants WHERE id=?').all(record().variant_id),
      sqlite.prepare('SELECT * FROM variant_price_versions WHERE variant_id=? ORDER BY rowid').all(record().variant_id),
      sqlite.prepare('SELECT * FROM inventory_balances WHERE variant_id=? ORDER BY rowid').all(record().variant_id),
      sqlite.prepare('SELECT * FROM inventory_movements WHERE variant_id=? ORDER BY rowid').all(record().variant_id),
      sqlite.prepare('SELECT * FROM media_assets WHERE id=?').all(record().asset_id),
      sqlite.prepare('SELECT * FROM product_media WHERE product_id=? ORDER BY rowid').all(record().product_id)
    ]
    const before = protectedState(),
      second = await sealed([record(2)])
    await command(second)
    expect(protectedState()).toEqual(before)
    await command(second, 'revert')
    expect(protectedState()).toEqual(before)
    expect(await readCatalogImportJob(database, claims, existing.id)).toMatchObject({ status: 'applied' })
    expect(firstReceipt.counts).toEqual({ products: 1, variants: 1, assets: 1, mappings: 1 })
  })
  it.each([
    ['product metadata', "UPDATE products SET series='Later retained edit'"],
    ['variant metadata', 'UPDATE variants SET cost_net_cents=801'],
    ['initial price', 'UPDATE variant_price_versions SET gross_cents=1600'],
    ['stock', 'UPDATE inventory_balances SET physical_quantity=41,version=2'],
    ['asset metadata', `UPDATE media_assets SET metadata='{"later":true}'`],
    ['mapping', 'UPDATE product_media SET sort_order=1']
  ])('refuses revert after %s changes, preserving every later row and ledger', async (_name, change) => {
    const job = await sealed()
    await command(job)
    sqlite.exec(change)
    await conflictWithoutEffects(job, 'revert')
    expect(await readCatalogImportJob(database, claims, job.id)).toMatchObject({ status: 'applied' })
  })
  it('refuses compensation once an imported variant has been used in a cart', async () => {
    const job = await sealed()
    await command(job)
    const cart = uuid(8, 2),
      now = utc()
    sqlite
      .prepare('INSERT INTO carts(id,token_hash,expires_at,correlation_id,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(cart, 'b'.repeat(64), utc(3600_000), 'local-cart-proof', now, now)
    sqlite
      .prepare('INSERT INTO cart_lines(cart_id,variant_id,quantity,created_at,updated_at) VALUES (?,?,1,?,?)')
      .run(cart, record().variant_id, now, now)
    await conflictWithoutEffects(job, 'revert')
  })
  it('rechecks the exact unused snapshot inside the compensation batch', async () => {
    const job = await sealed()
    await command(job)
    let changed: ReturnType<typeof snapshot> | undefined
    const db = interpose(() => {
      sqlite.exec('UPDATE variant_price_versions SET gross_cents=1600')
      changed = snapshot()
    })
    await expect(command(job, 'revert', testUuid(), db)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(snapshot()).toEqual(changed)
  })
  it('rechecks MFA inside compensation and does not partially cancel prices or debit stock', async () => {
    const job = await sealed()
    await command(job)
    let changed: ReturnType<typeof snapshot> | undefined
    const db = interpose(() => {
      sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      changed = snapshot()
    })
    await expect(command(job, 'revert', testUuid(), db)).rejects.toMatchObject({ code: 'mfa_required' })
    expect(snapshot()).toEqual(changed)
  })
  it.each([
    ['cancel price', 'BEFORE UPDATE ON variant_price_versions BEGIN SELECT RAISE(IGNORE); END'],
    ['empty balance', 'BEFORE UPDATE ON inventory_balances BEGIN SELECT RAISE(IGNORE); END'],
    [
      'retain descriptions',
      "AFTER UPDATE ON variants BEGIN UPDATE products SET description='Corrupt compensation edit' WHERE id=NEW.product_id; END"
    ],
    ['retain costs', 'AFTER UPDATE ON variants BEGIN UPDATE variants SET cost_net_cents=801 WHERE id=NEW.id; END']
  ])('rolls back compensation if a trigger ignores or corrupts %s', async (_name, trigger) => {
    const job = await sealed()
    await command(job)
    sqlite.exec('CREATE TRIGGER job_revert_corruption ' + trigger)
    await conflictWithoutEffects(job, 'revert')
  })
  it('rolls back compensation if an audit insert replaces its exact before snapshot with null', async () => {
    const job = await sealed()
    await command(job)
    sqlite.exec(`CREATE TRIGGER job_revert_audit_before_corruption
      BEFORE INSERT ON catalog_import_job_command_audit
      WHEN NEW.before_state IS NOT NULL AND EXISTS(
        SELECT 1 FROM catalog_import_job_commands WHERE id=NEW.command_id AND action='revert')
      BEGIN
        INSERT INTO catalog_import_job_command_audit(command_id,kind,item_id,before_state,after_state)
        VALUES(NEW.command_id,NEW.kind,NEW.item_id,NULL,NEW.after_state);
        SELECT RAISE(IGNORE);
      END`)
    await conflictWithoutEffects(job, 'revert')
  })
  it('merges601 rows into one product/asset,601 variants and301 distinct mappings across page boundaries', async () => {
    const base = record(),
      records = Array.from({ length: 601 }, (_, index) => ({
        ...base,
        variant_id: uuid(2, index + 1),
        variant_legacy_id: String(980001 + index),
        sku: 'SHARED-JOB-' + (index + 1),
        mpn: 'SHARED-MPN-' + (index + 1),
        media_variant_id: index % 2 ? uuid(2, index + 1) : ''
      }))
    const job = await sealed(records)
    expect(job.counts).toEqual({ products: 1, variants: 601, assets: 1, mappings: 301 })
    expectReceipt(await command(job), job, 'apply')
    expect(rows('products')).toHaveLength(1)
    expect(rows('variants')).toHaveLength(601)
    expect(rows('media_assets')).toHaveLength(1)
    expect(rows('product_media')).toHaveLength(301)
    expect(rows('product_media').filter((row) => row.variant_id === null)).toHaveLength(1)
    const mappings = rows('product_media')
    expectReceipt(await command(job, 'revert'), job, 'revert')
    expect(rows('product_media')).toEqual(mappings)
    expect(rows('inventory_movements')).toHaveLength(1202)
  }, 60000)
})
