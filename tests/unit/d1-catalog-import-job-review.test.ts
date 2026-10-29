import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CatalogTabularRecord } from '../../shared/catalog-tabular-core'
import {
  createCatalogImportJob,
  uploadCatalogImportJobPage,
  sealCatalogImportJob,
  readCatalogImportJobReview
} from '../../workers/catalog/import-job'

const actor = '00550000-0000-4000-8000-000000000001'
const session = '00550000-0000-4000-8000-000000000002'
const warehouse = '00550000-0000-4000-8000-000000000003'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const reason = 'Synthetic whole-job review; local staging tests only'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const uuid = (kind: number, index: number) =>
  `0055${String(kind).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`

describe('private sealed catalog job review pagination', () => {
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
      product_status: 'published',
      variant_status: 'published',
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

  async function sealed(records = [record()]) {
    const parts = []
    for (let index = 0; index < records.length; index += 201) parts.push(records.slice(index, index + 201))
    const job = await createCatalogImportJob(database, claims, {
      totalPages: parts.length,
      recordCount: records.length
    })
    for (let index = 0; index < parts.length; index++)
      expect(
        await uploadCatalogImportJobPage(database, claims, job.id, { index, records: parts[index] })
      ).toMatchObject({ outcome: 'job' })
    const ready = await sealCatalogImportJob(database, claims, job.id, { reason })
    expect(ready.outcome).toBe('job')
    if (ready.outcome !== 'job') throw new Error('fixture_seal_failed')
    return ready
  }
  const review = (id: string, offset = 0, limit = 25, db = database) =>
    readCatalogImportJobReview(db, claims, id, { offset, limit })
  const snapshot = () =>
    Object.fromEntries(
      [
        'products',
        'variants',
        'variant_price_versions',
        'inventory_balances',
        'inventory_movements',
        'media_assets',
        'product_media',
        'catalog_import_jobs',
        'catalog_import_job_pages',
        'catalog_import_job_rows',
        'catalog_import_job_entries',
        'catalog_import_job_identifiers',
        'catalog_import_job_seals'
      ].map((table) => [table, sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])
    )
  function interceptRead(
    change: (
      result: D1Result<Record<string, unknown>>
    ) => D1Result<Record<string, unknown>> | Promise<D1Result<Record<string, unknown>>>
  ) {
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return {
        ...statement,
        bind: (...args: unknown[]) => wrap(statement.bind(...args)),
        all: async () => change(await statement.all<Record<string, unknown>>())
      } as D1PreparedStatement
    }
    return {
      ...database,
      prepare: (query: string) =>
        query.includes('bounded AS') ? wrap(database.prepare(query)) : database.prepare(query)
    } as D1Database
  }
  it('projects all four entities with before null, declared published/verified claims and safe draft/pending initialization', async () => {
    const source = record(),
      job = await sealed([source]),
      before = snapshot(),
      result = await review(job.id)
    expect(result).toMatchObject({
      source: 'cloudflare',
      outcome: 'review',
      jobId: job.id,
      jobHash: job.hash,
      offset: 0,
      nextOffset: null,
      totalEntries: 4
    })
    expect(result.entries.map((entry) => entry.kind)).toEqual(['assets', 'media', 'products', 'variants'])
    expect(result.policy).toEqual(job.policy)
    for (const entry of result.entries) {
      expect(entry.before).toBeNull()
      expect(entry.context).toEqual({ warehouseId: warehouse })
      expect(entry.warnings).toContain('new_records_only')
      expect(entry.after.publicationAuthority).toBe('not_granted')
    }
    const product = result.entries.find((entry) => entry.kind === 'products')!
    expect(product.claimed).toMatchObject({
      status: 'published',
      name: source.product_name,
      description: source.description,
      sourceVersion: source.source_version
    })
    expect(product.after).toMatchObject({ status: 'draft', publishedAt: null })
    const variant = result.entries.find((entry) => entry.kind === 'variants')!
    expect(variant.claimed).toMatchObject({
      status: 'published',
      priceGrossCents: 1599,
      inventory: [{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }]
    })
    expect(variant.after).toMatchObject({
      status: 'draft',
      price: {
        grossCents: 1599,
        validFrom: null,
        validFromPolicy: 'server_on_apply',
        authorization: 'requires_live_apply_authorization'
      },
      inventory: {
        warehouseId: warehouse,
        onHand: 40,
        blocked: 2,
        version: 1,
        authorization: 'requires_live_apply_authorization'
      }
    })
    for (const kind of ['assets', 'media']) {
      const entry = result.entries.find((item) => item.kind === kind)!
      expect(entry.after).toMatchObject({
        rightsStatus: 'pending',
        quarantineStatus: 'pending',
        uploadId: null,
        storageAuthority: 'unverified_descriptor'
      })
    }
    expect(result.entries.find((entry) => entry.kind === 'assets')!.claimed).toMatchObject({
      rightsStatus: 'approved',
      quarantineStatus: 'clean'
    })
    expect(JSON.stringify(result)).not.toMatch(
      /initialPriceId|initialMovementId|compensationMovementId|actor_id|payload_hash|sessionId/
    )
    expect(snapshot()).toEqual(before)
  })
  it('paginates all2404 entities from601 full rows once, in stable SQL order without fake completion or writes', async () => {
    const job = await sealed(Array.from({ length: 601 }, (_, index) => record(index + 1))),
      before = snapshot()
    const expected = sqlite
      .prepare('SELECT kind,item_id FROM catalog_import_job_entries WHERE job_id=? ORDER BY kind,item_id')
      .all(job.id)
    const actual: Array<{ kind: string; item_id: string }> = []
    let offset: number | null = 0
    while (offset !== null) {
      const result = await review(job.id, offset, 50)
      expect(result.jobHash).toBe(job.hash)
      expect(result.totalEntries).toBe(2404)
      expect(result.offset).toBe(offset)
      expect(result.entries.length).toBeGreaterThan(0)
      expect(result.entries.length).toBeLessThanOrEqual(50)
      for (const entry of result.entries) actual.push({ kind: entry.kind, item_id: entry.id })
      const next = result.nextOffset
      if (next !== null) expect(next).toBe(offset + result.entries.length)
      offset = next
      expect(actual.length).toBeLessThanOrEqual(2404)
    }
    expect(actual).toEqual(expected)
    expect(new Set(actual.map((entry) => entry.kind + ':' + entry.item_id)).size).toBe(2404)
    expect(await review(job.id, 2404, 50)).toMatchObject({ entries: [], nextOffset: null, totalEntries: 2404 })
    expect(snapshot()).toEqual(before)
  }, 30000)
  it('returns shorter explicit pages for large quoted payloads, preserving the next offset until all evidence is shown', async () => {
    const records = Array.from({ length: 15 }, (_, index) => ({ ...record(index + 1), description: '"'.repeat(20000) }))
    const job = await sealed(records)
    // Assets and media come first; offset30 begins the large product payloads.
    const first = await review(job.id, 30, 50)
    expect(first.entries.length).toBeGreaterThan(0)
    expect(first.entries.length).toBeLessThan(15)
    expect(first.nextOffset).toBe(30 + first.entries.length)
    const captured: string[] = []
    let offset: number | null = 30
    while (offset !== null) {
      const current = await review(job.id, offset, 50)
      captured.push(...current.entries.map((entry) => entry.kind + ':' + entry.id))
      offset = current.nextOffset
      expect(captured.length).toBeLessThanOrEqual(30)
    }
    expect(captured).toHaveLength(30)
    expect(new Set(captured).size).toBe(30)
  })
  it('fails internally for corrupted payload hashes rather than projecting untrusted entry evidence', async () => {
    const job = await sealed(),
      before = snapshot()
    const corrupted = interceptRead((result) => ({
      ...result,
      results: result.results.map((row, index) => (index === 0 ? { ...row, payload_hash: 'f'.repeat(64) } : row))
    }))
    await expect(review(job.id, 0, 25, corrupted)).rejects.toThrow('catalog_import_review_integrity')
    expect(snapshot()).toEqual(before)
  })
  it.each(['read', 'sha256'])(
    'rechecks current authorization after asynchronous%s work before returning any review evidence',
    async (phase) => {
      const job = await sealed()
      const revoke = () => sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
      let db = database
      if (phase === 'read')
        db = interceptRead((result) => {
          revoke()
          return result
        })
      else {
        const digest = crypto.subtle.digest.bind(crypto.subtle)
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
          const value = await digest(algorithm, data)
          revoke()
          return value
        })
      }
      await expect(review(job.id, 0, 25, db)).rejects.toMatchObject({ code: 'unauthenticated' })
    }
  )
  it('rejects unsealed, malformed, unsigned and out-of-range review reads', async () => {
    const job = await createCatalogImportJob(database, claims, { totalPages: 1, recordCount: 1 })
    await expect(review(job.id)).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(readCatalogImportJobReview(database, null, job.id, { offset: 0, limit: 25 })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    const ready = await sealed()
    for (const raw of [
      { offset: -1, limit: 25 },
      { offset: 0, limit: 51 },
      { offset: 5, limit: 1 },
      { offset: 0, limit: 1, now: utc() },
      { limit: 25 },
      Object.assign(Object.create({ offset: 0 }), { limit: 25 })
    ])
      await expect(readCatalogImportJobReview(database, claims, ready.id, raw)).rejects.toMatchObject({
        code: 'invalid_input'
      })
    const getter = vi.fn(() => 0)
    await expect(
      readCatalogImportJobReview(
        database,
        claims,
        ready.id,
        Object.defineProperty({ limit: 25 }, 'offset', { enumerable: true, get: getter })
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(getter).not.toHaveBeenCalled()
  })
})
