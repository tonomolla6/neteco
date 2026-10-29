import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCatalogSnapshot } from '../../workers/catalog/catalog-export'
import {
  CATALOG_EXPORT_MAX_BYTES,
  CATALOG_EXPORT_MAX_CELL_CHARACTERS,
  CATALOG_EXPORT_MAX_PRODUCTS,
  CATALOG_EXPORT_MAX_ROWS,
  CATALOG_EXPORT_PROFILE,
  catalogExportHash,
  catalogExportOwnJson,
  catalogExportSnapshotSchema,
  exportCatalogSnapshotCsv,
  type CatalogExportSnapshot
} from '../../shared/catalog-export'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { fulfillmentFixture, CLAIMS as fulfillmentClaims } from './d1-fulfillment-fixture'
import ExcelJS from 'exceljs'
import { exportCatalogSnapshotXlsx } from '../../app/utils/catalog-export-xlsx.client'

const claims = {
  identityId: '0053ce00-0000-4000-8000-000000000001',
  sessionId: '0053ce00-0000-4000-8000-000000000002',
  sessionVersion: 1
}
const role = 'catalog-export-adversarial'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('read-only catalog snapshot independent SQLite authority audit', () => {
  let sqlite: DatabaseSync, database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
         VALUES (?, 'catalog-export-audit@example.invalid', 'synthetic-unusable', ?, 'active', ?, ?)`
      )
      .run(claims.identityId, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite
      .prepare('INSERT INTO roles(code,name,description) VALUES (?, ?, ?)')
      .run(role, 'Synthetic export auditor', 'Local fixture only')
    sqlite.exec(`INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic fixture'),
      ('administration.manage','administration','manage','Synthetic fixture');`)
    sqlite
      .prepare("INSERT INTO role_permissions VALUES (?, 'catalog.write'), (?, 'administration.manage')")
      .run(role, role)
    sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, ?, ?)')
      .run(claims.identityId, role, utc(-86400_000))
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(claims.sessionId, claims.identityId, utc(-86400_000), utc(3600_000))
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function records(snapshot: CatalogExportSnapshot, name: string): Record<string, unknown>[] {
    const sheet = snapshot.sheets.find((value) => value.name === name)
    if (!sheet) throw Error('missing_test_sheet')
    return sheet.rows.map((row) => {
      const value: unknown = JSON.parse(row.at(-1)!)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_test_record')
      return value as Record<string, unknown>
    })
  }

  function allTables(db = sqlite) {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    return JSON.stringify(
      tables.map(({ name }) => {
        if (typeof name !== 'string') throw Error('invalid_test_table')
        return [
          name,
          db
            .prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"')
            .all()
            .map((row) => JSON.stringify(row))
            .sort()
        ]
      })
    )
  }

  function afterBatch(action: () => void): D1Database {
    return {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await database.batch<T>(statements)
        action()
        return result
      }
    }
  }

  function corruptBatch(action: (result: D1Result<unknown>[]) => void): D1Database {
    return {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await database.batch<T>(statements)
        action(result)
        return result
      }
    }
  }

  function trace() {
    const queries: string[] = [],
      binds: number[] = [],
      batches: number[] = []
    const observed: D1Database = {
      ...database,
      prepare(sql) {
        queries.push(sql)
        const statement = database.prepare(sql),
          bind = statement.bind
        statement.bind = (...parameters: unknown[]) => {
          binds.push(parameters.length)
          bind(...parameters)
          return statement
        }
        return statement
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        batches.push(statements.length)
        return database.batch<T>(statements)
      }
    }
    return { database: observed, queries, binds, batches }
  }

  function addProducts(count: number, start = 100) {
    sqlite
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
      INSERT INTO products(id,legacy_id,category_id,name,slug,status)
      SELECT 'export-extra-'||(?2+n),?2+n,'c1','Extra product '||(?2+n),'export-extra-'||(?2+n),'draft' FROM seq`
      )
      .run(count, start)
  }

  function addPrices(count: number, start = 0) {
    sqlite
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?1)
      INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,reason,created_at)
      SELECT 'export-price-'||CAST(?2+n AS INTEGER),'v-1-1',500,'2020-01-01T00:00:00Z','Synthetic price history','2020-01-01T00:00:00Z' FROM seq`
      )
      .run(count, start)
  }

  it('reads six complete sheets from actual SQLite under the D1 expression and binding limits', async () => {
    const snapshot = await readCatalogSnapshot(database, claims, {})
    expect(snapshot.counts).toMatchObject({ products: 6, variants: 6, inventory: 6 })
    expect(snapshot.sheets).toHaveLength(6)
    expect(sqlite.limits.exprDepth).toBe(100)
    expect(sqlite.limits.variableNumber).toBe(100)
    expect(sqlite.limits.functionArg).toBe(32)
    expect(sqlite.limits.compoundSelect).toBe(5)
  })

  it('creates a server UUID/time and verifiable hash with exactly 15 SELECTs plus three joint authority reads, never writes', async () => {
    const before = allTables(),
      observed = trace(),
      start = utc()
    const snapshot = await readCatalogSnapshot(observed.database, claims, {})
    expect(snapshot.profile).toBe(CATALOG_EXPORT_PROFILE)
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(snapshot.observedAt >= start && snapshot.observedAt <= utc()).toBe(true)
    expect(snapshot.hash).toBe(await catalogExportHash(snapshot))
    expect(catalogExportSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(observed.batches).toEqual([15])
    expect(observed.queries).toHaveLength(18)
    expect(Math.max(...observed.binds)).toBe(4)
    for (const query of observed.queries)
      expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b|\bREPLACE\s+INTO\b/i)
    expect(allTables()).toBe(before)
    expect((await readCatalogSnapshot(database, claims, {})).snapshotId).not.toBe(snapshot.snapshotId)
  })

  it.each(['catalog.write', 'administration.manage'] as const)(
    'requires %s as a live grant, not an administrator-looking role',
    async (permission) => {
      sqlite.prepare('DELETE FROM role_permissions WHERE role_code=? AND permission_code=?').run(role, permission)
      const observed = trace()
      await expect(readCatalogSnapshot(observed.database, claims, {})).rejects.toMatchObject({ code: 'forbidden' })
      expect(observed.batches).toEqual([])
    }
  )

  it('a valid unprivileged customer or cross-identity claims cannot read private catalog records', async () => {
    const customer = {
      identityId: '0053ce00-0000-4000-8000-000000000003',
      sessionId: '0053ce00-0000-4000-8000-000000000004',
      sessionVersion: 1
    }
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?,'export-customer@example.invalid','synthetic-unusable',?,'active',?,?)`
      )
      .run(customer.identityId, utc(-3600000), utc(-3600000), utc(-3600000))
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?,?,1,1,?,?)`
      )
      .run(customer.sessionId, customer.identityId, utc(-3600000), utc(3600000))
    const observed = trace()
    await expect(readCatalogSnapshot(observed.database, customer, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      readCatalogSnapshot(observed.database, { ...claims, identityId: customer.identityId }, {})
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(readCatalogSnapshot(observed.database, null, {})).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(observed.batches).toEqual([])
  })

  it.each([
    ['grant', 'forbidden'],
    ['administration', 'forbidden'],
    ['session', 'unauthenticated'],
    ['generation', 'unauthenticated'],
    ['mfa', 'mfa_required'],
    ['email', 'email_unverified']
  ] as const)('rechecks %s authority after the actual read batch', async (loss, code) => {
    const before = sqlite.prepare('SELECT * FROM products ORDER BY id').all()
    const revoked = afterBatch(() => {
      if (loss === 'grant' || loss === 'administration')
        sqlite
          .prepare('DELETE FROM role_permissions WHERE role_code=? AND permission_code=?')
          .run(role, loss === 'grant' ? 'catalog.write' : 'administration.manage')
      if (loss === 'session')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), claims.sessionId)
      if (loss === 'generation')
        sqlite.prepare('UPDATE identities SET session_version=session_version+1 WHERE id=?').run(claims.identityId)
      if (loss === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(claims.sessionId)
      if (loss === 'email')
        sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(claims.identityId)
    })
    await expect(readCatalogSnapshot(revoked, claims, {})).rejects.toMatchObject({ code })
    expect(sqlite.prepare('SELECT * FROM products ORDER BY id').all()).toEqual(before)
  })

  it.each(['catalog.write', 'administration.manage', 'session'] as const)(
    'rechecks %s authority after the WebCrypto await before releasing bytes',
    async (loss) => {
      const original = crypto.subtle.digest.bind(crypto.subtle)
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const hash = await original(algorithm, input)
        if (loss === 'session')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), claims.sessionId)
        else sqlite.prepare('DELETE FROM role_permissions WHERE role_code=? AND permission_code=?').run(role, loss)
        return hash
      })
      await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({
        code: loss === 'session' ? 'unauthenticated' : 'forbidden'
      })
    }
  )

  it.each(['session', 'grant'] as const)(
    'uses a fresh server clock when the %s expires during hashing',
    async (kind) => {
      const at = utc(),
        deadline = new Date(Date.parse(at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(at))
      if (kind === 'session')
        sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(deadline, claims.sessionId)
      else sqlite.prepare('UPDATE identity_roles SET expires_at=? WHERE identity_id=?').run(deadline, claims.identityId)
      const original = crypto.subtle.digest.bind(crypto.subtle)
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const hash = await original(algorithm, input)
        vi.setSystemTime(new Date(deadline))
        return hash
      })
      await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({
        code: kind === 'session' ? 'unauthenticated' : 'forbidden'
      })
    }
  )

  it('matches accents, hidden variant SKU and literal percent/underscore without SQL wildcard meaning', async () => {
    sqlite.exec(`UPDATE products SET name='ÁCIDO ÚTIL 100%_literal',status='review' WHERE id='p-1';
      UPDATE variants SET sku='Hidden-Ñandú%_SKU',status='hidden' WHERE id='v-1-1';
      UPDATE products SET name='Acido util 100xxliteral' WHERE id='p-2';`)
    for (const q of ['acido util 100%_', 'ÁCIDO ÚTIL 100%_', 'hidden-nandu%_sku', '%_', '_literal']) {
      const snapshot = await readCatalogSnapshot(database, claims, { q })
      expect(records(snapshot, 'Products').map((record) => record.id)).toEqual(['p-1'])
      expect(records(snapshot, 'Variants')[0]).toMatchObject({ id: 'v-1-1', status: 'hidden' })
    }
    expect((await readCatalogSnapshot(database, claims, { q: "' OR 1=1 --" })).counts.products).toBe(0)
    expect((await readCatalogSnapshot(database, claims, { q: '\\%' })).counts.products).toBe(0)
  })

  it('includes unmapped products/categories, exact nullable metadata, all variant states and JSON attributes without editor fallbacks', async () => {
    sqlite.exec(`INSERT INTO categories(id,name,slug,status) VALUES('export-unmapped','Unmapped parent','export-unmapped','draft');
      INSERT INTO categories(id,legacy_id,parent_id,name,slug,status) VALUES('export-child',88,'export-unmapped','Mapped child','export-child','review');
      UPDATE products SET legacy_id=NULL,category_id='export-unmapped',brand_id=NULL,description='',short_description=NULL,
        attributes='{"attrs":[{"k":"Detalle","v":"á,\\"valor\\""}],"unknownPreserved":true}' WHERE id='p-1';
      UPDATE products SET category_id='export-child',status='hidden' WHERE id='p-2';
      UPDATE variants SET legacy_id=NULL,status='hidden' WHERE id='v-1-1';`)
    for (const [index, status] of ['draft', 'review', 'published', 'hidden', 'discontinued'].entries())
      sqlite
        .prepare(
          `INSERT INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
        VALUES (?,'p-1','t21','sp1',?,'Synthetic format',?,500)`
        )
        .run('export-state-' + index, 'export-state-' + index, status)
    const snapshot = await readCatalogSnapshot(database, claims, {}),
      p = records(snapshot, 'Products').find((record) => record.id === 'p-1')!
    expect(snapshot.counts.products).toBe(6)
    expect(p).toMatchObject({
      legacy_id: null,
      category_id: 'export-unmapped',
      brand_id: null,
      short_description: null,
      description: ''
    })
    expect(p.attributes).toBe(sqlite.prepare("SELECT attributes FROM products WHERE id='p-1'").get()!.attributes)
    expect(
      records(snapshot, 'Variants')
        .filter((record) => record.product_id === 'p-1')
        .map((record) => record.status)
        .sort()
    ).toEqual(['draft', 'hidden', 'hidden', 'published', 'review', 'discontinued'].sort())
    const filtered = await readCatalogSnapshot(database, claims, { category: 88, status: 'hidden' })
    expect(records(filtered, 'Products').map((record) => record.id)).toEqual(['p-2'])
    expect(
      records(filtered, 'References')
        .filter((record) => record.kind === 'category')
        .map((record) => record.id)
    ).toEqual(['export-child', 'export-unmapped'])
  })

  it('exports exact stock, every governed price window and retained withdrawn media associations without approvals or provider I/O', async () => {
    const validity = await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: utc(-3600000),
        validUntil: utc(7 * 86400_000)
      }),
      publication = validity.mainPublications.get('p-1')!
    sqlite
      .prepare(
        `INSERT INTO product_media_publication_events(id,publication_id,event_type,reason,actor_id,created_at,idempotency_key,payload_hash)
      VALUES (?,?,'withdrawn','Synthetic local withdrawal',?,?,?,?)`
      )
      .run(crypto.randomUUID(), publication.id, claims.identityId, utc(), crypto.randomUUID(), 'a'.repeat(64))
    addPrices(2)
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,valid_until,reason,created_at)
      VALUES ('export-upcoming','v-1-1',777,?,?, 'Synthetic upcoming',?)`
      )
      .run(utc(3600000), utc(7200000), utc())
    const before = allTables(),
      snapshot = await readCatalogSnapshot(database, claims, {})
    expect(records(snapshot, 'Inventory').find((record) => record.variant_id === 'v-1-1')).toMatchObject({
      physical_quantity: 25,
      blocked_quantity: 0,
      version: 1,
      sellable_quantity: 24
    })
    expect(records(snapshot, 'Prices').map((record) => record.id)).toEqual([
      'export-price-1',
      'export-price-2',
      'export-upcoming'
    ])
    expect(records(snapshot, 'Media')).toEqual([
      expect.objectContaining({
        id: publication.id,
        upload_id: publication.uploadId,
        variant_id: null,
        withdrawn_at: expect.any(String)
      })
    ])
    expect(records(snapshot, 'References').find((record) => record.kind === 'media_metadata')).toMatchObject({
      id: publication.uploadId
    })
    expect(allTables()).toBe(before)
  })

  it('keeps nonempty pending orders, financial state, reservations and all audit tables byte-identical', async () => {
    const w = await fulfillmentFixture()
    try {
      await w.order('pickup', false)
      w.sqlite.exec(`INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic export fixture');
        INSERT INTO role_permissions VALUES('operator','catalog.write');`)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM orders').get()!.n).toBe(1)
      expect(w.sqlite.prepare('SELECT count(*) AS n FROM inventory_reservation_lines').get()!.n).toBeGreaterThan(0)
      const before = allTables(w.sqlite),
        snapshot = await readCatalogSnapshot(w.database, fulfillmentClaims, {})
      expect(snapshot.counts.products).toBe(6)
      expect(allTables(w.sqlite)).toBe(before)
      expect(w.sqlite.prepare("SELECT count(*) AS n FROM order_payment_states WHERE status='paid'").get()!.n).toBe(0)
    } finally {
      w.sqlite.close()
    }
  })

  function pendingMediaFixture() {
    const assetIds = [1, 2, 3, 4].map((number) => '0054ce00-0000-4000-8000-' + String(number).padStart(12, '0'))
    const metadata = ' { "original" : "á, 🚀", "nested" : {"unknown":null}, "approved":true } '
    for (const [index, id] of assetIds.entries())
      sqlite
        .prepare(
          `INSERT INTO media_assets(id,storage_key,original_name,mime_type,byte_size,checksum_sha256,
        owner_name,source_url,license,authorized_at,rights_status,quarantine_status,alt_text,metadata,created_at)
        VALUES (?, ?, ?, 'image/png', 71, ?, 'Original owner', NULL, 'Original license', ?, 'pending', 'pending', '', ?, ?)`
        )
        .run(id, `pending/${index}.png`, `Original ${index}.png`, String(index + 1).repeat(64), utc(), metadata, utc())
    const mappings = [
      ['p-1', null, assetIds[0], 'primary', 'v,"1'],
      ['p-1', 'v-1-1', assetIds[0], 'gallery', 'v2'],
      ['p-1', 'v-1-1', assetIds[1], 'label', 'v3'],
      ['p-2', 'v-2-1', assetIds[0], 'primary', 'foreign-shared'],
      ['p-2', null, assetIds[2], 'primary', 'foreign-only']
    ]
    for (const row of mappings)
      sqlite
        .prepare(
          'INSERT INTO product_media(product_id,variant_id,asset_id,role,version,sort_order) VALUES (?, ?, ?, ?, ?, 0)'
        )
        .run(...row)
    sqlite.prepare("UPDATE products SET name='Pending native selected' WHERE id='p-1'").run()
    sqlite
      .prepare("UPDATE variants SET identifier_exception_reason=? WHERE id='v-1-1'")
      .run('Explicación original, no aprobación 🚀')
    return { assetIds, metadata }
  }

  it('retains pending import descriptors and honest composite associations, scoped to selected native products', async () => {
    const { assetIds, metadata } = pendingMediaFixture(),
      before = allTables()
    const snapshot = await readCatalogSnapshot(database, claims, { q: 'Pending native selected' })
    const references = records(snapshot, 'References'),
      assets = references.filter((row) => row.kind === 'imported_asset'),
      media = references.filter((row) => row.kind === 'imported_media')
    expect(assets.map((row) => row.id)).toEqual(assetIds.slice(0, 2))
    for (const asset of assets) {
      expect(asset.data).toEqual(sqlite.prepare('SELECT * FROM media_assets WHERE id=?').get(String(asset.id)))
      expect(asset.data).toMatchObject({
        metadata,
        source_url: null,
        rights_status: 'pending',
        quarantine_status: 'pending'
      })
    }
    expect(media).toHaveLength(3)
    const original = sqlite
      .prepare(
        "SELECT * FROM product_media WHERE product_id='p-1' ORDER BY product_id,variant_id,asset_id,role,version"
      )
      .all()
    expect(media.map((row) => row.data)).toEqual(original)
    expect(media.map((row) => row.id)).toEqual(
      original.map((row) => JSON.stringify([row.product_id, row.variant_id, row.asset_id, row.role, row.version]))
    )
    expect(new Set(media.map((row) => row.id)).size).toBe(3)
    expect(JSON.parse(String(media[0]!.id))[1]).toBeNull()
    expect(media.every((row) => !Object.hasOwn(row.data as object, 'id'))).toBe(true)
    expect(records(snapshot, 'Media')).toEqual([])
    expect(records(snapshot, 'Variants')[0]).toMatchObject({
      identifier_exception_reason: 'Explicación original, no aprobación 🚀'
    })
    const full = await readCatalogSnapshot(database, claims, {})
    expect(
      records(full, 'References')
        .filter((row) => row.kind === 'imported_asset')
        .map((row) => row.id)
    ).toEqual(assetIds.slice(0, 3))
    expect(records(full, 'References').filter((row) => row.kind === 'imported_media')).toHaveLength(5)
    expect(records(full, 'Variants').find((row) => row.id === 'v-2-1')).toMatchObject({
      identifier_exception_reason: null
    })
    expect(allTables()).toBe(before)
  })

  it('preserves pending record_json bytes and verified snapshot hash in CSV and XLSX without mutating the source', async () => {
    pendingMediaFixture()
    const before = allTables(),
      snapshot = await readCatalogSnapshot(database, claims, { q: 'Pending native selected' }),
      referenceSheet = snapshot.sheets.find((sheet) => sheet.name === 'References')!
    expect(snapshot.hash).toBe(await catalogExportHash(snapshot))
    expect(await catalogExportHash(structuredClone(snapshot))).toBe(snapshot.hash)
    const csv = parseCatalogCsvCells(new TextDecoder().decode(await exportCatalogSnapshotCsv(snapshot)))
    expect(csv.filter((row) => row[0] === 'References').map((row) => row[2])).toEqual(
      referenceSheet.rows.map((row) => row.at(-1))
    )
    const workbook = new ExcelJS.Workbook(),
      bytes = await exportCatalogSnapshotXlsx(snapshot)
    await workbook.xlsx.load(bytes.slice().buffer as never)
    const sheet = workbook.getWorksheet('References')!
    expect(referenceSheet.rows.map((_row, index) => sheet.getRow(index + 2).getCell(4).value)).toEqual(
      referenceSheet.rows.map((row) => row.at(-1))
    )
    expect(workbook.getWorksheet('Manifest')!.getRow(8).getCell(2).value).toBe(snapshot.hash)
    expect(allTables()).toBe(before)
  })

  it('counts imported descriptors and associations against the common row budget and rejects the next association', async () => {
    pendingMediaFixture()
    const initial = await readCatalogSnapshot(database, claims, {}),
      total = Object.values(initial.counts).reduce((sum, count) => sum + count, 0)
    addPrices(CATALOG_EXPORT_MAX_ROWS - total)
    expect(
      Object.values((await readCatalogSnapshot(database, claims, {})).counts).reduce((sum, count) => sum + count, 0)
    ).toBe(CATALOG_EXPORT_MAX_ROWS)
    sqlite.exec(
      "INSERT INTO product_media SELECT product_id,variant_id,asset_id,role,'extra-budget-version',sort_order FROM product_media WHERE product_id='p-1' AND variant_id IS NULL"
    )
    const before = allTables()
    await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({ code: 'too_large' })
    expect(allTables()).toBe(before)
  })

  it('rejects an over-8MB pending-descriptor projection inside SQL before returning any large rows', async () => {
    const metadata = JSON.stringify({ original: 'x'.repeat(19_000) })
    sqlite
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<450)
      INSERT INTO media_assets(id,storage_key,original_name,mime_type,byte_size,checksum_sha256,owner_name,
        source_url,license,authorized_at,rights_status,quarantine_status,alt_text,metadata,created_at)
      SELECT '0054ba00-0000-4000-8000-'||printf('%012d',n),'budget-pending-'||n,'Original.png','image/png',1,
        printf('%064d',n),'Owner',NULL,'Original license',?1,'pending','pending','',?2,?1 FROM seq`
      )
      .run(utc(), metadata)
    sqlite.exec(`INSERT INTO product_media(product_id,variant_id,asset_id,role,version,sort_order)
      SELECT 'p-1',NULL,id,'primary','budget-original',0 FROM media_assets`)
    let totals: Record<string, unknown> | undefined,
      returnedCounts: number[] = []
    const observed = trace(),
      guarded: D1Database = {
        ...observed.database,
        async batch<T>(statements: D1PreparedStatement[]) {
          const result = await observed.database.batch<T>(statements)
          totals = result[0]!.results[0] as Record<string, unknown>
          returnedCounts = result.map((group) => group.results.length)
          return result
        }
      }
    const before = allTables()
    await expect(readCatalogSnapshot(guarded, claims, {})).rejects.toMatchObject({ code: 'too_large' })
    expect(totals!.raw_bytes).toBeGreaterThan(CATALOG_EXPORT_MAX_BYTES)
    expect(returnedCounts).toEqual([1, ...Array.from({ length: 14 }, () => 0)])
    expect(allTables()).toBe(before)
  })

  it('preserves formula-looking values inside JSON and CSV escaping never turns them into executable spreadsheet cells', async () => {
    sqlite
      .prepare("UPDATE products SET name=?,description=? WHERE id='p-1'")
      .run('=SUM(1,2)', '+CMD("synthetic@example.invalid")\nMultiline')
    const snapshot = await readCatalogSnapshot(database, claims, {}),
      csv = await exportCatalogSnapshotCsv(snapshot),
      cells = parseCatalogCsvCells(new TextDecoder().decode(csv))
    const productRecord = cells.find((row) => row[0] === 'Products' && JSON.parse(row[2]!).id === 'p-1')!
    expect(JSON.parse(productRecord[2]!)).toMatchObject({
      name: '=SUM(1,2)',
      description: '+CMD("synthetic@example.invalid")\nMultiline'
    })
    for (const row of cells) for (const value of row) expect(value).not.toMatch(/^[=+\-@]/)
    expect(csv.byteLength).toBeLessThan(CATALOG_EXPORT_MAX_BYTES)
  })

  it('accepts 1000 products without per-product queries and rejects product1001 instead of truncating', async () => {
    addProducts(CATALOG_EXPORT_MAX_PRODUCTS - 6)
    const observed = trace(),
      snapshot = await readCatalogSnapshot(observed.database, claims, {})
    expect(snapshot.counts.products).toBe(1000)
    expect(records(snapshot, 'Products')).toHaveLength(1000)
    expect(observed.queries).toHaveLength(18)
    expect(observed.batches).toEqual([15])
    expect(Math.max(...observed.binds)).toBe(4)
    addProducts(1, 2000)
    await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({ code: 'too_large' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM products').get()!.n).toBe(1001)
  })

  it('counts all six sheets against 10000 total rows and rejects the next real price record', async () => {
    const initial = await readCatalogSnapshot(database, claims, {}),
      initialCount = Object.values(initial.counts).reduce((a, b) => a + b, 0)
    addPrices(CATALOG_EXPORT_MAX_ROWS - initialCount)
    const snapshot = await readCatalogSnapshot(database, claims, {})
    expect(Object.values(snapshot.counts).reduce((a, b) => a + b, 0)).toBe(10000)
    expect(snapshot.counts.prices).toBe(CATALOG_EXPORT_MAX_ROWS - initialCount)
    addPrices(1, 20000)
    await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({ code: 'too_large' })
  })

  it('rejects a cell over20K and an aggregate over8MB without returning a smaller apparent snapshot', async () => {
    sqlite
      .prepare("UPDATE products SET description=? WHERE id='p-1'")
      .run('x'.repeat(CATALOG_EXPORT_MAX_CELL_CHARACTERS + 1))
    await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({ code: 'too_large' })
    sqlite.prepare("UPDATE products SET description=NULL WHERE id='p-1'").run()
    addProducts(400)
    sqlite.prepare("UPDATE products SET description=? WHERE id LIKE 'export-extra-%'").run('🧽'.repeat(3000))
    await expect(readCatalogSnapshot(database, claims, {})).rejects.toMatchObject({ code: 'too_large' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM products').get()!.n).toBe(406)
  })

  it('real SQLite groups individually below8MB but cumulatively above8MB return no data rows and reject before stringify/hash', async () => {
    const wide = '🧽'.repeat(3000)
    addProducts(350)
    sqlite.prepare("UPDATE products SET description=? WHERE id LIKE 'export-extra-%'").run(wide)
    sqlite
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<350)
         INSERT INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
         SELECT 'export-budget-variant-'||n,'p-1','t21','sp1','export-budget-sku-'||n,?1,'hidden',500 FROM seq`
      )
      .run(wide)
    const rawGroups = [
      sqlite.prepare('SELECT * FROM products ORDER BY id').all(),
      sqlite.prepare('SELECT * FROM variants ORDER BY id').all()
    ]
    const groupBytes = rawGroups.map((group) => new TextEncoder().encode(JSON.stringify(group)).byteLength)
    for (const group of rawGroups) expect(() => catalogExportOwnJson(group)).not.toThrow()
    for (const bytes of groupBytes) expect(bytes).toBeLessThan(CATALOG_EXPORT_MAX_BYTES)
    expect(groupBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(CATALOG_EXPORT_MAX_BYTES)

    const observed = trace()
    let returnedCounts: number[] = [],
      totals: unknown
    const real: D1Database = {
      ...observed.database,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await observed.database.batch<T>(statements)
        returnedCounts = result.map((group) => group.results.length)
        totals = result[0]!.results[0]
        return result
      }
    }
    const stringify = vi.spyOn(JSON, 'stringify'),
      digest = vi.spyOn(crypto.subtle, 'digest')
    let failure: unknown
    try {
      await readCatalogSnapshot(real, claims, {})
    } catch (error) {
      failure = error
    }
    // Capture before Vitest itself formats assertions: these are core calls.
    const stringifyCalls = stringify.mock.calls.length,
      digestCalls = digest.mock.calls.length
    stringify.mockRestore()
    expect(failure).toMatchObject({ code: 'too_large' })
    expect(totals).toMatchObject({ n: 356, raw_bytes: expect.any(Number), row_n: expect.any(Number) })
    if (!totals || typeof totals !== 'object' || !('raw_bytes' in totals) || typeof totals.raw_bytes !== 'number')
      throw Error('missing_real_sqlite_budget')
    expect(totals.raw_bytes).toBeGreaterThan(CATALOG_EXPORT_MAX_BYTES)
    expect(returnedCounts).toEqual([1, ...Array.from({ length: 14 }, () => 0)])
    expect(observed.batches).toEqual([15])
    expect(observed.queries).toHaveLength(16)
    expect(observed.binds.every((count) => count === 4)).toBe(true)
    expect(stringifyCalls).toBe(0)
    expect(digestCalls).toBe(0)
  })

  it('negative injected transport with low claimed totals cannot reset the cumulative8MB own-data budget between groups', async () => {
    // This is ONLY a transport-corruption negative. A genuine small SQLite
    // snapshot supplies row shapes; injected large groups never prove D1 data.
    const baseline = await readCatalogSnapshot(database, claims, {}),
      product = records(baseline, 'Products')[0]!,
      variant = records(baseline, 'Variants')[0]!,
      wide = '🧽'.repeat(3000),
      products = Array.from({ length: 350 }, (_value, index) => ({
        ...product,
        id: 'injected-product-' + index,
        description: wide
      })),
      variants = Array.from({ length: 350 }, (_value, index) => ({
        ...variant,
        id: 'injected-variant-' + index,
        format: wide
      }))
    const groupBytes = [products, variants].map((group) => new TextEncoder().encode(JSON.stringify(group)).byteLength)
    for (const group of [products, variants]) expect(() => catalogExportOwnJson(group)).not.toThrow()
    for (const bytes of groupBytes) expect(bytes).toBeLessThan(CATALOG_EXPORT_MAX_BYTES)
    expect(groupBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(CATALOG_EXPORT_MAX_BYTES)
    let claimedTotals: unknown
    const corrupted = corruptBatch((result) => {
      claimedTotals = result[0]!.results[0]
      result[1]!.results = products
      result[2]!.results = variants
    })
    const stringify = vi.spyOn(JSON, 'stringify'),
      digest = vi.spyOn(crypto.subtle, 'digest')
    let failure: unknown
    try {
      await readCatalogSnapshot(corrupted, claims, {})
    } catch (error) {
      failure = error
    }
    const stringifyCalls = stringify.mock.calls.length,
      digestCalls = digest.mock.calls.length
    stringify.mockRestore()
    expect(claimedTotals).toMatchObject({ n: 6, row_n: expect.any(Number), raw_bytes: expect.any(Number) })
    if (
      !claimedTotals ||
      typeof claimedTotals !== 'object' ||
      !('raw_bytes' in claimedTotals) ||
      typeof claimedTotals.raw_bytes !== 'number'
    )
      throw Error('missing_injected_transport_budget')
    expect(claimedTotals.raw_bytes).toBeLessThan(CATALOG_EXPORT_MAX_BYTES)
    expect(failure).toMatchObject({ code: 'too_large' })
    expect(stringifyCalls).toBe(0)
    expect(digestCalls).toBe(0)
  })

  it.each([
    { page: 1 },
    { observedAt: '2099-01-01T00:00:00Z' },
    { category: '7' },
    { category: 0 },
    { status: 'archived' },
    { q: 'x'.repeat(161) }
  ])('rejects unsupported or coercive client filters %j before SQL', async (filters) => {
    const observed = trace()
    await expect(readCatalogSnapshot(observed.database, claims, filters)).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(observed.queries).toEqual([])
  })

  it('does not execute getters or coercion hooks from operator filters or verified-claim inputs', async () => {
    const effect = vi.fn(() => {
        throw Error('untrusted_operator_effect')
      }),
      filters = Object.defineProperty({}, 'q', { enumerable: true, get: effect }),
      forged = Object.defineProperty({ ...claims }, 'identityId', { enumerable: true, get: effect })
    await expect(readCatalogSnapshot(database, claims, filters)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(readCatalogSnapshot(database, forged, {})).rejects.toThrow()
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(['missing-sheet', 'sparse-batch', 'sparse-rows', 'failed', 'missing-field', 'object-cell'] as const)(
    'a %s transport corruption is unavailable, never an empty successful export',
    async (kind) => {
      const corrupted = corruptBatch((result) => {
        if (kind === 'missing-sheet') result.pop()
        if (kind === 'sparse-batch') Reflect.deleteProperty(result, '1')
        if (kind === 'sparse-rows') Reflect.deleteProperty(result[1]!.results, '0')
        if (kind === 'failed') Object.defineProperty(result[1]!, 'success', { value: false })
        if (kind === 'missing-field') Reflect.deleteProperty(result[1]!.results[0]!, 'name')
        if (kind === 'object-cell')
          Object.defineProperty(result[1]!.results[0]!, 'name', { value: { unexpected: true }, enumerable: true })
      })
      await expect(readCatalogSnapshot(corrupted, claims, {})).rejects.toThrow('catalog_export_unavailable')
    }
  )

  it('a storage outage propagates as unavailable data rather than becoming zero products', async () => {
    const offline: D1Database = {
      ...database,
      batch: async () => {
        throw Error('synthetic_sqlite_storage_outage')
      }
    }
    await expect(readCatalogSnapshot(offline, claims, {})).rejects.toThrow('synthetic_sqlite_storage_outage')
  })

  it('rejects accessor-backed result indices without executing the operator getter', async () => {
    // Fault injection starts AFTER a genuine SQLite batch. This is a transport
    // boundary negative, never evidence that a fabricated database succeeded.
    const effect = vi.fn()
    const corrupted: D1Database = {
      ...database,
      async batch<T>(statements: D1PreparedStatement[]) {
        const result = await database.batch<T>(statements),
          products = result[1]!.results,
          original = products[0]
        Object.defineProperty(products, '0', {
          enumerable: true,
          get: () => {
            effect()
            return original
          }
        })
        return result
      }
    }
    const observed = readCatalogSnapshot(corrupted, claims, {})
    await expect(observed).rejects.toThrow('catalog_export_unavailable')
    expect(effect).not.toHaveBeenCalled()
  })
})
