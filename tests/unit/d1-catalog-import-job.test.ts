import { readFile } from 'node:fs/promises'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { validateCatalogRecords, type CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import { catalogImportJobSchema, type CatalogImportJob } from '../../shared/catalog-import-job'
import {
  createCatalogImportJob,
  uploadCatalogImportJobPage,
  sealCatalogImportJob,
  readCatalogImportJob
} from '../../workers/catalog/import-job'
import { testNow } from '../support/deterministic'

const actor = '00550000-0000-4000-8000-000000000001'
const session = '00550000-0000-4000-8000-000000000002'
const warehouse = '00550000-0000-4000-8000-000000000003'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const reason = 'Synthetic whole-job review; local staging tests only'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const uuid = (kind: number, index: number) =>
  `0055${String(kind).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`

describe('D1 complete catalog jobs: staging and immutable whole-job sealing only', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_import_jobs'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0055_catalog_import_jobs.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'JOB-TEST','Supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,55,'Category','job-category','published')"
      )
      .run(ids.category)
    sqlite.prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Brand','job-brand','published')").run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'JOB-TAX','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'JOB-SHIP','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'JOB-WH','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'jobs55@example.invalid','unusable-synthetic',?,'active',?,?)"
      )
      .run(actor, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('jobs55','Job importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('jobs55',?)").run(`${resource}.${action}`)
    }
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'jobs55',?)")
      .run(actor, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(session, actor, utc(-86400_000), utc(72 * 3600_000))
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function record(index = 1): CatalogTabularRecord {
    const productId = uuid(1, index),
      variantId = uuid(2, index),
      assetId = uuid(3, index)
    return {
      ...catalogRecord(),
      product_id: productId,
      variant_id: variantId,
      asset_id: assetId,
      product_legacy_id: String(950000 + index),
      variant_legacy_id: String(960000 + index),
      product_slug: 'job-product-' + index,
      sku: 'JOB-' + index,
      ean: '',
      gtin: '',
      mpn: 'MPN-JOB-' + index,
      product_status: 'draft',
      variant_status: 'draft',
      product_attributes_json: JSON.stringify({
        image: '/media/' + assetId,
        imageAlt: 'Synthetic image',
        imageRights: { owner: 'NETECO', license: 'Own photo', authorizedAt: '2026-08-13T12:00:00.000Z' }
      }),
      asset_storage_key: `clean/${assetId}.png`,
      asset_checksum_sha256: index.toString(16).padStart(64, '0'),
      asset_source_url: '/media/' + assetId,
      inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }])
    }
  }
  const page = (index: number, records: CatalogTabularRecord[]) => ({ index, records })
  const create = (totalPages = 1, recordCount = 1, options = {}) =>
    createCatalogImportJob(database, claims, { totalPages, recordCount }, options)
  const upload = (job: CatalogImportJob, index: number, records = [record()], db = database, options = {}) =>
    uploadCatalogImportJobPage(db, claims, job.id, page(index, records), options)
  const seal = (job: CatalogImportJob, db = database, options = {}) =>
    sealCatalogImportJob(db, claims, job.id, { reason }, options)
  const rows = (table: string) => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
  const stage = () =>
    Object.fromEntries(
      [
        'catalog_import_jobs',
        'catalog_import_job_pages',
        'catalog_import_job_rows',
        'catalog_import_job_entries',
        'catalog_import_job_identifiers',
        'catalog_import_job_seals',
        'catalog_import_job_guards'
      ].map((table) => [table, rows(table)])
    )
  const domain = () =>
    Object.fromEntries(
      [
        'products',
        'variants',
        'variant_price_versions',
        'inventory_balances',
        'inventory_movements',
        'media_assets',
        'product_media',
        'catalog_draft_legacy_counters'
      ].map((table) => [table, rows(table)])
    )
  async function rejected(promise: Promise<unknown>) {
    let result: { outcome?: string; issues?: unknown[] } | undefined
    let failure: unknown
    try {
      result = (await promise) as { outcome?: string; issues?: unknown[] }
    } catch (error) {
      failure = error
    }
    if (failure !== undefined) expect(failure).toBeInstanceOf(Error)
    else {
      expect(result?.outcome).toBe('invalid')
      expect(result?.issues?.length).toBeGreaterThan(0)
    }
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
  it.each(['observed entries', 'entry guard comparison', 'identifier matching'] as const)(
    'drives %s from the incoming page before a complete staging primary-key lookup',
    async (family) => {
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
      const job = await create(2, 2)
      const records = [
        { ...record(1), ean: catalogRecord().ean },
        { ...record(2), gtin: '01234567890128' }
      ]
      expect(validateCatalogRecords(records).valid).toBe(true)
      const pageQueries: Array<typeof captured> = []
      for (let index = 0; index < records.length; index++) {
        captured.length = 0
        expect(await upload(job, index, [records[index]!], observedDatabase)).toMatchObject({
          status: 'uploading',
          receivedPages: index + 1
        })
        pageQueries.push([...captured])
      }
      expect(rows('catalog_import_job_identifiers')).toHaveLength(2)
      for (const queries of pageQueries) {
        const matching = queries.filter(({ sql }) => {
          if (family === 'observed entries')
            return sql.includes('catalog_import_job_entries e') && sql.includes('SELECT count(*) AS n')
          if (family === 'entry guard comparison')
            return sql.includes('catalog_import_job_guards') && sql.includes('e.payload=json_extract')
          return sql.includes('catalog_import_job_identifiers e') && sql.includes('AS matching')
        })
        expect(matching, family + ' must be captured from each real upload').toHaveLength(1)
        for (const { sql, bindings } of matching) {
          // Explain the exact generated statement and original bound values,
          // including guards, without executing any copied/simplified SQL.
          const plan = sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(...bindings)
          const itemIndex = plan.findIndex(({ detail }) => /^SCAN item\b/.test(String(detail)))
          expect(itemIndex, JSON.stringify(plan)).toBeGreaterThanOrEqual(0)
          const item = plan[itemIndex]!
          const key =
            family === 'identifier matching'
              ? /\(job_id=\? AND identifier=\?\)/
              : /\(job_id=\? AND kind=\? AND item_id=\?\)/
          const lookupIndex = plan.findIndex(
            ({ parent, detail }) =>
              parent === item.parent &&
              /^SEARCH e USING (?:COVERING )?INDEX\b/.test(String(detail)) &&
              key.test(String(detail))
          )
          expect(lookupIndex, family + ': ' + JSON.stringify(plan)).toBeGreaterThan(itemIndex)
        }
      }
    }
  )
  it('stages and seals every one of601 full rows across three pages without any catalog writes', async () => {
    const all = Array.from({ length: 601 }, (_, index) => record(index + 1))
    expect(validateCatalogRecords(all).valid).toBe(true)
    const before = domain(),
      job = await create(3, 601)
    expect(job).toMatchObject({
      source: 'cloudflare',
      outcome: 'job',
      status: 'uploading',
      totalPages: 3,
      receivedPages: 0,
      recordCount: 601,
      hash: null
    })
    expect(Date.parse(job.expiresAt) - Date.parse(job.createdAt)).toBe(24 * 3600_000)
    for (const [index, records] of [
      [0, all.slice(0, 201)],
      [1, all.slice(201, 402)],
      [2, all.slice(402)]
    ] as const) {
      expect(new TextEncoder().encode(JSON.stringify({ records })).byteLength).toBeLessThanOrEqual(900000)
      expect(await upload(job, index, records)).toMatchObject({ status: 'uploading', receivedPages: index + 1 })
    }
    const ready = await seal(job)
    expect(ready).toMatchObject({
      status: 'ready',
      receivedPages: 3,
      recordCount: 601,
      counts: { products: 601, variants: 601, assets: 601, mappings: 601 }
    })
    expect(catalogImportJobSchema.safeParse(ready).success).toBe(true)
    expect(ready).toHaveProperty('hash', expect.stringMatching(/^[0-9a-f]{64}$/))
    expect(rows('catalog_import_job_rows')).toHaveLength(601)
    expect(rows('catalog_import_job_entries')).toHaveLength(601 * 4)
    expect(domain()).toEqual(before)
    // This single acceptance spans three full uploads and sealing, not one
    // production query. Keep a bounded budget independent of host contention.
  }, 60000)
  it('replays a lost page response durably, refusing changed content and exact-row duplicates across pages', async () => {
    const job = await create(2, 2),
      data = [record()]
    const first = await upload(job, 0, data),
      persisted = stage()
    expect(await upload(job, 0, data)).toEqual(first)
    expect(stage()).toEqual(persisted)
    await expect(upload(job, 0, [{ ...record(), product_name: 'Changed page' }])).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(stage()).toEqual(persisted)
    expect(await upload(job, 1, data)).toMatchObject({
      outcome: 'invalid',
      issues: [expect.objectContaining({ code: 'catalog_page_conflict' })]
    })
    expect(stage()).toEqual(persisted)
    data[0]!.sku = 'Caller changed source'
    expect(JSON.stringify(stage())).not.toContain('Caller changed source')
  })

  it('creates one durable job per explicit key and rejects altered creation or revoked-key replay', async () => {
    const options = { idempotencyKey: 'create-job55' }
    const job = await create(2, 2, options)
    const before = stage()
    expect(await create(2, 2, options)).toEqual(job)
    expect(stage()).toEqual(before)
    await rejected(create(3, 3, options))
    expect(stage()).toEqual(before)
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
    await expect(create(2, 2, options)).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(stage()).toEqual(before)
  })
  it('deduplicates equal product/asset entries across pages but rejects divergent equal IDs atomically', async () => {
    const first = record(),
      second = { ...first, variant_id: uuid(2, 2), variant_legacy_id: '960002', sku: 'JOB-2', mpn: 'MPN-JOB-2' }
    const job = await create(2, 2)
    await upload(job, 0, [first])
    const before = stage()
    expect(await upload(job, 1, [{ ...second, product_name: 'Divergent same product' }])).toMatchObject({
      outcome: 'invalid',
      issues: [expect.objectContaining({ code: 'catalog_page_conflict' })]
    })
    expect(stage()).toEqual(before)
    expect(await upload(job, 1, [second])).toMatchObject({ receivedPages: 2 })
    expect(await seal(job)).toMatchObject({
      status: 'ready',
      counts: { products: 1, variants: 2, assets: 1, mappings: 1 }
    })
  })
  it('rejects missing, out-of-order and out-of-range pages and declared row count mismatches', async () => {
    const job = await create(2, 3),
      before = stage()
    await rejected(upload(job, 1, [record(2)]))
    expect(stage()).toEqual(before)
    await rejected(upload(job, 2, [record(3)]))
    expect(stage()).toEqual(before)
    await rejected(seal(job))
    expect(stage()).toEqual(before)
    await upload(job, 0, [record()])
    const partial = stage()
    await rejected(seal(job))
    expect(stage()).toEqual(partial)
    await upload(job, 1, [record(2)])
    const complete = stage()
    await rejected(seal(job))
    expect(stage()).toEqual(complete)
    expect(rows('catalog_import_job_seals')).toHaveLength(0)
  })
  it('bounds page UTF8 bytes and strict71-column input, rejecting whole pages without partial state', async () => {
    const job = await create(),
      before = stage(),
      huge = record()
    for (const key of Object.keys(huge).slice(0, 30) as Array<keyof CatalogTabularRecord>) huge[key] = 'á'.repeat(20000)
    expect(new TextEncoder().encode(JSON.stringify({ records: [huge] })).byteLength).toBeGreaterThan(900000)
    await rejected(upload(job, 0, [huge]))
    expect(stage()).toEqual(before)
    const validOversized = Array.from({ length: 30 }, (_, index) => ({
      ...record(index + 1),
      description: 'á'.repeat(20000)
    }))
    expect(validateCatalogRecords(validOversized).valid).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify({ records: validOversized })).byteLength).toBeGreaterThan(900000)
    await rejected(upload(job, 0, validOversized))
    expect(stage()).toEqual(before)
    await rejected(uploadCatalogImportJobPage(database, claims, job.id, { index: 0, records: [record()], now: utc() }))
    expect(stage()).toEqual(before)
    const getter = vi.fn(() => record())
    await rejected(
      uploadCatalogImportJobPage(database, claims, job.id, {
        index: 0,
        records: Object.defineProperty([], '0', { enumerable: true, get: getter })
      })
    )
    expect(stage()).toEqual(before)
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['catalog.write', 'administration.manage', 'inventory.write'])(
    'rechecks live%s permission before staging, replay, read and seal',
    async (permission) => {
      const job = await create()
      await upload(job, 0)
      const before = stage()
      sqlite.prepare('DELETE FROM role_permissions WHERE permission_code=?').run(permission)
      for (const operation of [
        () => create(),
        () => upload(job, 0),
        () => readCatalogImportJob(database, claims, job.id),
        () => seal(job)
      ])
        await expect(operation()).rejects.toMatchObject({ code: 'forbidden' })
      expect(stage()).toEqual(before)
    }
  )
  it.each(['mfa', 'email', 'revoked'])(
    'rechecks%s state rather than trusting existing job ownership',
    async (drift) => {
      const job = await create()
      await upload(job, 0)
      const before = stage()
      if (drift === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
      if (drift === 'email') sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(actor)
      if (drift === 'revoked') sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
      const code = drift === 'mfa' ? 'mfa_required' : drift === 'email' ? 'email_unverified' : 'unauthenticated'
      await expect(upload(job, 0)).rejects.toMatchObject({ code })
      await expect(seal(job)).rejects.toMatchObject({ code })
      expect(stage()).toEqual(before)
    }
  )
  it('rejects global media references to an absent or foreign-product variant at whole-job seal', async () => {
    const job = await create(2, 2),
      first = { ...record(), media_variant_id: uuid(2, 2) }
    await upload(job, 0, [first])
    await upload(job, 1, [record(2)])
    const before = stage()
    await rejected(seal(job))
    expect(stage()).toEqual(before)
    const orphan = await create()
    await upload(orphan, 0, [{ ...record(3), media_variant_id: uuid(2, 999) }])
    const snapshot = stage()
    await rejected(seal(orphan))
    expect(stage()).toEqual(snapshot)
  })

  it('allows a media reference resolved by a later page for the same product, validating the graph at seal', async () => {
    const first = { ...record(), media_variant_id: uuid(2, 2) }
    const second = { ...first, variant_id: uuid(2, 2), variant_legacy_id: '960002', sku: 'JOB-2', mpn: 'MPN-JOB-2' }
    const job = await create(2, 2)
    expect(await upload(job, 0, [first])).toMatchObject({ outcome: 'job', receivedPages: 1 })
    expect(await upload(job, 1, [second])).toMatchObject({ outcome: 'job', receivedPages: 2 })
    expect(await seal(job)).toMatchObject({
      status: 'ready',
      counts: { products: 1, variants: 2, assets: 1, mappings: 1 }
    })
  })
  it('rejects cross-page EAN-to-GTIN collisions, not merely duplicate identifiers inside one page', async () => {
    const job = await create(2, 2)
    await upload(job, 0, [{ ...record(), ean: '4006381333931' }])
    const before = stage()
    expect(await upload(job, 1, [{ ...record(2), gtin: '4006381333931' }])).toMatchObject({
      outcome: 'invalid',
      issues: [expect.objectContaining({ code: 'catalog_page_conflict' })]
    })
    expect(stage()).toEqual(before)
  })

  it('stages a valid quoted page even when normalized entry-envelope expansion requires multiple bounded bindings', async () => {
    const records = Array.from({ length: 15 }, (_, index) => ({ ...record(index + 1), description: '"'.repeat(20000) }))
    expect(validateCatalogRecords(records).valid).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify({ records })).byteLength).toBeLessThan(900000)
    const before = domain(),
      job = await create(1, 15)
    expect(await upload(job, 0, records)).toMatchObject({
      outcome: 'job',
      receivedPages: 1,
      counts: { products: 15, variants: 15, assets: 15, mappings: 15 }
    })
    expect(rows('catalog_import_job_entries')).toHaveLength(60)
    expect(rows('catalog_import_job_guards')).toHaveLength(0)
    expect(domain()).toEqual(before)
  })

  it('rolls back every normalized entry chunk when an IGNORE trigger suppresses a later chunk entry', async () => {
    const records = Array.from({ length: 15 }, (_, index) => ({ ...record(index + 1), description: '"'.repeat(20000) }))
    const job = await create(1, 15),
      before = stage(),
      protectedBefore = domain()
    sqlite.exec(`CREATE TRIGGER simulate_late_job_entry_ignore BEFORE INSERT ON catalog_import_job_entries
      WHEN NEW.kind='products' AND NEW.item_id='${uuid(1, 15)}' BEGIN SELECT RAISE(IGNORE); END`)
    expect(await upload(job, 0, records)).toMatchObject({
      outcome: 'invalid',
      issues: [expect.objectContaining({ code: 'catalog_page_conflict' })]
    })
    expect(stage()).toEqual(before)
    expect(domain()).toEqual(protectedBefore)
  })
  it('rejects cross-page source versions that disagree for the same product', async () => {
    const first = record(),
      second = {
        ...first,
        variant_id: uuid(2, 2),
        variant_legacy_id: '960002',
        sku: 'JOB-2',
        mpn: 'MPN-JOB-2',
        variant_source_version: 'other-source-version'
      }
    const job = await create(2, 2)
    await upload(job, 0, [first])
    // An earlier whole-page rejection is also safe; otherwise sealing must fail.
    const result = await upload(job, 1, [second])
    if (result.outcome === 'invalid') expect(result.issues.length).toBeGreaterThan(0)
    else {
      const before = stage()
      await rejected(seal(job))
      expect(stage()).toEqual(before)
    }
    expect(rows('catalog_import_job_seals')).toHaveLength(0)
  })
  it.each(['source', 'category', 'warehouse'])(
    'checks current%s reference state at seal, not just at create/upload',
    async (drift) => {
      const job = await create()
      await upload(job, 0)
      if (drift === 'source') sqlite.prepare('UPDATE catalog_sources SET is_master=0 WHERE id=?').run(ids.source)
      if (drift === 'category') sqlite.prepare("UPDATE categories SET status='hidden' WHERE id=?").run(ids.category)
      if (drift === 'warehouse') sqlite.prepare('UPDATE inventory_locations SET active=0 WHERE id=?').run(warehouse)
      const before = stage()
      await rejected(seal(job))
      expect(stage()).toEqual(before)
    }
  )
  it('refuses a second active warehouse and expired24h staging, with immutable30min ready seal', async () => {
    const now = utc(),
      job = await create(1, 1, { now })
    await rejected(upload(job, 0, [record()], database, { now: utc(24 * 3600_000) }))
    expect(rows('catalog_import_job_pages')).toHaveLength(0)
    await upload(job, 0, [record()], database, { now })
    const ready = await seal(job, database, { now })
    expect(ready.outcome).toBe('job')
    if (ready.outcome === 'job') expect(Date.parse(ready.expiresAt) - Date.parse(now)).toBe(30 * 60_000)
    const before = stage()
    expect(await seal(job, database, { now })).toEqual(ready)
    expect(stage()).toEqual(before)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'OTHER-WH','Other','warehouse',1,?)"
      )
      .run(uuid(9, 1), utc(-1000))
    await rejected(create())
    expect(stage()).toEqual(before)
  })
  it.each(['ABORT', 'IGNORE'])(
    'rolls back all page staging on trigger%s rather than leaving an acknowledged partial page',
    async (action) => {
      const job = await create(),
        before = stage(),
        protectedBefore = domain()
      sqlite.exec(
        `CREATE TRIGGER simulate_job_staging_failure BEFORE INSERT ON catalog_import_job_entries WHEN NEW.kind='variants' BEGIN SELECT RAISE(${action}${action === 'ABORT' ? ", 'synthetic stage failure'" : ''}); END`
      )
      await rejected(upload(job, 0))
      expect(stage()).toEqual(before)
      expect(domain()).toEqual(protectedBefore)
    }
  )
  it('rechecks authority inside page batch and rejects late revocation without partial staging', async () => {
    const job = await create(),
      before = stage()
    const raced = interpose(() =>
      sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
    )
    await rejected(upload(job, 0, [record()], raced))
    expect(stage()).toEqual(before)
  })
  it('persists immutable original page data, entries and seal evidence', async () => {
    const job = await create()
    await upload(job, 0)
    await seal(job)
    for (const table of [
      'catalog_import_job_pages',
      'catalog_import_job_rows',
      'catalog_import_job_entries',
      'catalog_import_job_seals'
    ]) {
      const before = rows(table)
      expect(() => sqlite.exec('DELETE FROM ' + table)).toThrow()
      expect(rows(table)).toEqual(before)
      expect(() => sqlite.exec('UPDATE ' + table + ' SET job_id=job_id')).toThrow()
      expect(rows(table)).toEqual(before)
    }
  })

  it('rejects missing records and missing record counts at the direct SQLite page boundary', async () => {
    const job = await create(),
      before = stage(),
      payload = '{}',
      hash = 'a'.repeat(64)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_import_job_pages(job_id,page_index,payload_hash,payload,byte_length,record_count,created_at)
      VALUES (?,0,?,?,?,1,?)`
        )
        .run(job.id, hash, payload, new TextEncoder().encode(payload).byteLength, utc())
    ).toThrow()
    expect(stage()).toEqual(before)
    const valid = JSON.stringify({ records: [record()] })
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO catalog_import_job_pages(job_id,page_index,payload_hash,payload,byte_length,created_at)
      VALUES (?,0,?,?,?,?)`
        )
        .run(job.id, hash, valid, new TextEncoder().encode(valid).byteLength, utc())
    ).toThrow()
    expect(stage()).toEqual(before)
  })

  it('requires all four nonnull seal counts at the direct SQLite evidence boundary', async () => {
    const job = await create()
    await upload(job, 0)
    const before = stage(),
      valid = { products: 1, variants: 1, assets: 1, mappings: 1 }
    for (const key of Object.keys(valid)) {
      const missing = Object.fromEntries(Object.entries(valid).filter(([field]) => field !== key))
      for (const counts of [missing, { ...valid, [key]: null }]) {
        expect(() =>
          sqlite
            .prepare(
              `INSERT INTO catalog_import_job_seals(job_id,hash,counts,reason,created_at,expires_at)
          VALUES (?,?,?,?,?,?)`
            )
            .run(job.id, 'a'.repeat(64), JSON.stringify(counts), reason, utc(), utc(1800_000))
        ).toThrow()
        expect(stage()).toEqual(before)
      }
    }
  })

  it.each(['media', 'identifier'])(
    'rejects an unrequested extra%s inserted by a variant trigger and rolls back the entire page',
    async (kind) => {
      const job = await create(),
        before = stage(),
        protectedBefore = domain()
      const insertion =
        kind === 'media'
          ? `INSERT INTO catalog_import_job_entries(job_id,kind,item_id,payload,payload_hash,first_page)
         VALUES(NEW.job_id,'media','unrequested-media','{}','${'a'.repeat(64)}',NEW.first_page);`
          : `INSERT INTO catalog_import_job_identifiers(job_id,identifier,variant_id,first_page)
         VALUES(NEW.job_id,'UNREQUESTED-IDENTIFIER',NEW.item_id,NEW.first_page);`
      sqlite.exec(`CREATE TRIGGER inject_unrequested_job_${kind} AFTER INSERT ON catalog_import_job_entries
      WHEN NEW.kind='variants' BEGIN ${insertion} END`)
      expect(await upload(job, 0)).toMatchObject({
        outcome: 'invalid',
        issues: [expect.objectContaining({ code: 'catalog_page_conflict' })]
      })
      expect(stage()).toEqual(before)
      expect(domain()).toEqual(protectedBefore)
    }
  )
})
