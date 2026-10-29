import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  catalogRelationsInputSchema,
  catalogRelationsIntentHash,
  publicCatalogRelationsSchema
} from '../../shared/catalog-relations'
import {
  readD1AdminCatalogRelations,
  updateD1CatalogRelations,
  readD1CatalogRelationsCommand,
  readD1ProductRelations
} from '../../workers/catalog/catalog-relations'

const actor = '10000000-0000-4000-8000-000000000076'
const session = '20000000-0000-4000-8000-000000000076'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const key = '30000000-0000-4000-8000-000000000076'
const body = (expectedVersion = 0) => ({
  expectedVersion,
  relations: [{ targetProductId: 2, kind: 'accessory' as const }],
  reason: 'Synthetic manually reviewed catalog relation',
  reviewReference: 'LOCAL-REVIEW-76'
})

describe('Directed catalog relations on actual D1 SQLite adapter', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    const migration = await readFile(
      new URL('../../db/d1/migrations/0076_catalog_relations.sql', import.meta.url),
      'utf8'
    )
    await database.batch(splitDemoSql(migration).map((sql) => database.prepare(sql)))
    seedInventoryFixture(sqlite)
    const past = new Date(Date.now() - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const future = new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?,'relations-editor@example.invalid','synthetic-not-login',?,'active',?,?)`
      )
      .run(actor, past, past, past)
    sqlite.exec(`INSERT INTO roles VALUES ('relations_editor','Editor','Synthetic fixture');
      INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic fixture');
      INSERT INTO role_permissions VALUES ('relations_editor','catalog.write');`)
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'relations_editor',?)`)
      .run(actor, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?,?,1,1,?,?)`
      )
      .run(session, actor, past, future)
    await provisionPublicationValidityFixture(database, { productIds: ['p-1', 'p-2', 'p-3'] })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    sqlite.close()
  })

  it('returns version zero for an existing product without curated relations', async () => {
    expect(await readD1AdminCatalogRelations(database, claims, 1)).toEqual({
      source: 'cloudflare',
      productId: 1,
      version: 0,
      items: [],
      updatedAt: null
    })
  })
  it('records a manually reviewed directed snapshot and correlates original receipt recovery', async () => {
    const receipt = await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    expect(receipt).toMatchObject({
      source: 'cloudflare',
      commandId: key,
      productId: 1,
      expectedVersion: 0,
      version: 1,
      payloadHash: await catalogRelationsIntentHash(1, body())
    })
    expect(await readD1AdminCatalogRelations(database, claims, 1)).toMatchObject({
      version: 1,
      items: body().relations
    })
    expect(await readD1CatalogRelationsCommand(database, claims, 1, key, receipt.payloadHash)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
  })
  it('replays exactly without another revision and rejects changed payload under the same key', async () => {
    const receipt = await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    expect(await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })).toEqual(receipt)
    await expect(
      updateD1CatalogRelations(
        database,
        claims,
        1,
        { ...body(), reviewReference: 'OTHER-REVIEW' },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await readD1AdminCatalogRelations(database, claims, 1)).toMatchObject({ version: 1 })
  })
  it('does not infer reciprocal relations or turn same-category recommendations into equivalence', async () => {
    await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    const result = publicCatalogRelationsSchema.parse(
      await readD1ProductRelations(database, ['producto-1', 'producto-2', 'producto-3'])
    )
    expect(result.groups.find((group) => group.productId === 1)?.items).toEqual([
      expect.objectContaining({ kind: 'accessory', productId: 2, slug: 'producto-2', minPrice: 500, formats: 1 })
    ])
    expect(result.groups.find((group) => group.productId === 2)?.items).toEqual([])
    expect(result.groups.find((group) => group.productId === 3)?.items).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/reviewReference|LOCAL-REVIEW|password|cost_net_cents/)
  })
  it('filters unpublished targets and omits unpublished or nonexistent source groups', async () => {
    await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    sqlite.exec("UPDATE products SET status='hidden' WHERE id='p-2'")
    const result = await readD1ProductRelations(database, ['producto-1', 'producto-2', 'does-not-exist'])
    expect(result.groups).toEqual([{ productId: 1, productSlug: 'producto-1', items: [] }])
  })
  it('requires current verified MFA catalog authority even when replaying an immutable command', async () => {
    await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    sqlite.exec("DELETE FROM role_permissions WHERE role_code='relations_editor'")
    await expect(updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(readD1AdminCatalogRelations(database, null, 1)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('rejects self edges, nonexistent targets and stale writes without replacing the original snapshot', async () => {
    await expect(
      updateD1CatalogRelations(
        database,
        claims,
        1,
        { ...body(), relations: [{ targetProductId: 1, kind: 'equivalent' }] },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      updateD1CatalogRelations(
        database,
        claims,
        1,
        { ...body(), relations: [{ targetProductId: 999, kind: 'equivalent' }] },
        { idempotencyKey: key }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    await expect(
      updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(await readD1AdminCatalogRelations(database, claims, 1)).toMatchObject({
      version: 1,
      items: body().relations
    })
  })
  it('allows an explicit empty revision while preserving the original command receipt', async () => {
    const original = await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    await updateD1CatalogRelations(
      database,
      claims,
      1,
      { ...body(1), relations: [] },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(await readD1AdminCatalogRelations(database, claims, 1)).toMatchObject({ version: 2, items: [] })
    expect(await readD1CatalogRelationsCommand(database, claims, 1, key, original.payloadHash)).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt: original
    })
  })
  it('reads unknown own commands honestly without writing inventory or creating a relation', async () => {
    const before = sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()
    expect(
      await readD1CatalogRelationsCommand(database, claims, 1, key, await catalogRelationsIntentHash(1, body()))
    ).toEqual({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await readD1ProductRelations(database, ['producto-1'])
    expect(sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()).toEqual(before)
  })
  it('enforces bounded explicit manual review and binds normalized origin in the intent hash', async () => {
    expect(
      catalogRelationsInputSchema.safeParse({ ...body(), relations: [...body().relations, ...body().relations] })
        .success
    ).toBe(false)
    expect(catalogRelationsInputSchema.safeParse({ ...body(), reviewReference: '' }).success).toBe(false)
    expect(catalogRelationsInputSchema.safeParse({ ...body(), reason: '\n' + body().reason }).success).toBe(false)
    expect(await catalogRelationsIntentHash(1, body())).not.toBe(await catalogRelationsIntentHash(2, body()))
    expect(await catalogRelationsIntentHash(1, { ...body(), reason: ' ' + body().reason + ' ' })).toBe(
      await catalogRelationsIntentHash(1, body())
    )
  })
  it('omits a source without a currently published variant instead of fabricating an empty public group', async () => {
    sqlite.exec("UPDATE variants SET status='hidden' WHERE product_id='p-1'")
    expect(await readD1ProductRelations(database, ['producto-1'])).toEqual({ source: 'cloudflare', groups: [] })
  })
  it('rolls back the complete snapshot and command when the immutable revision cannot be inserted', async () => {
    sqlite.exec(`CREATE TRIGGER synthetic_relation_revision_failure BEFORE INSERT ON catalog_relation_revisions
      BEGIN SELECT RAISE(ABORT,'synthetic_revision_failure'); END;`)
    await expect(updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    for (const table of ['catalog_relation_commands', 'catalog_relation_revisions', 'catalog_relation_heads'])
      expect(sqlite.prepare(`SELECT count(*) total FROM ${table}`).get()).toEqual({ total: 0 })
  })
  it('revalidates live permission inside the transaction without leaving a partial revision', async () => {
    const original = database.batch.bind(database)
    vi.spyOn(database, 'batch').mockImplementationOnce(async (statements) => {
      sqlite.exec("DELETE FROM role_permissions WHERE role_code='relations_editor'")
      return original(statements)
    })
    await expect(updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(sqlite.prepare('SELECT count(*) total FROM catalog_relation_commands').get()).toEqual({ total: 0 })
  })
  it('never releases withdrawn target data observed before the final coherent public read', async () => {
    await updateD1CatalogRelations(database, claims, 1, body(), { idempotencyKey: key })
    const original = database.prepare.bind(database)
    let reads = 0
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('WITH sources AS MATERIALIZED') && ++reads === 2)
        sqlite.exec("UPDATE products SET status='hidden' WHERE id='p-2'")
      return original(sql)
    })
    await expect(readD1ProductRelations(database, ['producto-1'])).rejects.toMatchObject({
      code: 'service_unavailable'
    })
  })
})
