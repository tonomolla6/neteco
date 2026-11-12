import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { exportEditorialCsv, type EditorialCsvRow } from '../../shared/catalog-editorial-csv'
import { editorialPreviewSchema } from '../../shared/catalog-editorial-import'
import {
  executeEditorialCommand,
  exportEditorialTemplate,
  previewEditorialCsv,
  readEditorialPreview
} from '../../workers/catalog/editorial-import'
import { handleEditorialImportHttp, ownsEditorialImportNamespace } from '../../workers/catalog/editorial-import-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testNow } from '../support/deterministic'

const actor = '00530000-0000-4000-8000-000000000001'
const session = '00530000-0000-4000-8000-000000000002'
const productIds = ['00530000-0000-4000-8000-000000000011', '00530000-0000-4000-8000-000000000012']
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const password = 'editorial-test-only-session-secret-53'.repeat(2)
describe('bounded editorial CSV D1 operations', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?, 'editorial53@example.invalid', 'synthetic-unusable', ?, 'active', ?, ?)`
      )
      .run(actor, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite.exec(`INSERT INTO roles VALUES ('editorial53', 'Editor', 'Synthetic fixture');
      INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Synthetic fixture');
      INSERT INTO role_permissions VALUES ('editorial53', 'catalog.write');`)
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, 'editorial53', ?)")
      .run(actor, utc(-86400_000))
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(session, actor, utc(-86400_000), utc(3600_000))
    for (let index = 0; index < productIds.length; index++)
      sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,name,slug,status,short_description,description,usage,series)
        VALUES (?, ?, 'c1', ?, ?, 'draft', NULL, NULL, NULL, NULL)`
        )
        .run(productIds[index]!, 100 + index, 'Original draft ' + index, 'editorial-test-' + index)
  })
  afterEach(() => sqlite.close())
  function records(): EditorialCsvRow[] {
    return productIds.map((productId, index) => ({
      productId,
      legacyId: 100 + index,
      expectedVersion: 1,
      metadata: {
        name: 'Updated editorial draft ' + index,
        shortDesc: 'Updated short description',
        description: 'Updated detailed description, with comma\nand safe multiline text.',
        usage: 'Editorial usage',
        series: null,
        featured: true
      }
    }))
  }
  function product(index: number) {
    return sqlite.prepare('SELECT * FROM products WHERE id = ?').get(productIds[index]!)!
  }
  function counts() {
    return sqlite
      .prepare(
        `SELECT
      (SELECT count(*) FROM catalog_editorial_previews) AS previews,
      (SELECT count(*) FROM catalog_editorial_commands) AS commands,
      (SELECT count(*) FROM catalog_editorial_audit) AS audits,
      (SELECT count(*) FROM catalog_editorial_guards) AS guards`
      )
      .get()
  }
  async function preview(db = database) {
    const result = await previewEditorialCsv(db, claims, exportEditorialCsv(records()))
    if (result.outcome !== 'preview') throw Error('expected_valid_preview')
    return result
  }
  function interpose(action: () => void) {
    return {
      ...database,
      batch: async (statements: D1PreparedStatement[]) => {
        action()
        return database.batch(statements)
      }
    } as D1Database
  }
  it('creates preview without product writes, applies and reverts atomically without rewinding versions or fabricating nulls', async () => {
    const before = productIds.map((_id, index) => product(index))
    const p = await preview()
    expect(p.products).toHaveLength(2)
    expect(productIds.map((_id, index) => product(index))).toEqual(before)
    const receipt = await executeEditorialCommand(
      database,
      claims,
      p.id,
      'apply',
      { previewHash: p.hash, reason: 'Approved editorial changes' },
      'apply53'
    )
    expect(receipt.productCount).toBe(2)
    expect(product(0)).toMatchObject({ name: records()[0]!.metadata.name, catalog_version: 2, featured: 1 })
    expect((await readEditorialPreview(database, claims, p.id)).status).toBe('applied')
    await executeEditorialCommand(
      database,
      claims,
      p.id,
      'revert',
      { previewHash: p.hash, reason: 'Restore original editorial content' },
      'revert53'
    )
    expect(product(0)).toMatchObject({
      name: before[0]!.name,
      short_description: null,
      description: null,
      catalog_version: 3
    })
    expect((await readEditorialPreview(database, claims, p.id)).status).toBe('reverted')
    expect(counts()).toEqual({ previews: 1, commands: 2, audits: 4, guards: 0 })
  })
  it('returns the identical persisted receipt, rejects altered payloads and blocks revoked-session replay', async () => {
    const p = await preview(),
      body = { previewHash: p.hash, reason: 'Approved reason' }
    const a = await executeEditorialCommand(database, claims, p.id, 'apply', body, 'same53')
    expect(await executeEditorialCommand(database, claims, p.id, 'apply', body, 'same53')).toEqual(a)
    await expect(
      executeEditorialCommand(database, claims, p.id, 'apply', { ...body, reason: 'Different reason' }, 'same53')
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(utc(), session)
    await expect(executeEditorialCommand(database, claims, p.id, 'apply', body, 'same53')).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    expect(counts()).toMatchObject({ commands: 1, audits: 2 })
  })
  it('does not persist invalid, unknown, published, unmapped or stale input', async () => {
    expect((await previewEditorialCsv(database, claims, new TextEncoder().encode('invalid'))).outcome).toBe('invalid')
    const rows = records()
    rows[0]!.legacyId = 9999
    expect((await previewEditorialCsv(database, claims, exportEditorialCsv(rows))).outcome).toBe('invalid')
    sqlite.prepare("UPDATE products SET status = 'published' WHERE id = ?").run(productIds[0]!)
    expect((await previewEditorialCsv(database, claims, exportEditorialCsv(records()))).outcome).toBe('invalid')
    expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
  })
  it('reports safe CSV row and field diagnostics without echoing rejected values or persisting a preview', async () => {
    const rows = records()
    rows[1]!.metadata.name = 'PRIVATE_FORMULA_MARKER'
    const csv = new TextDecoder()
      .decode(exportEditorialCsv(rows))
      .replace('PRIVATE_FORMULA_MARKER', '=PRIVATE_FORMULA_MARKER')
    const result = await previewEditorialCsv(database, claims, new TextEncoder().encode(csv))
    expect(result).toEqual({
      source: 'cloudflare',
      outcome: 'invalid',
      issues: [
        {
          code: 'metadata_field_invalid',
          row: 3,
          field: 'product_name',
          message: 'Revisa el CSV y la versión actual del borrador.'
        }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FORMULA_MARKER')
    expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
  })
  it('rejects no-op previews and preserves protected product, financial and media state', async () => {
    const snapshot = (table: string) => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()
    const tables = ['variants', 'variant_price_versions', 'inventory_balances', 'inventory_movements', 'media_uploads']
    const before = tables.map(snapshot),
      p = await preview()
    await executeEditorialCommand(
      database,
      claims,
      p.id,
      'apply',
      { previewHash: p.hash, reason: 'Safe metadata only' },
      'safe53'
    )
    expect(tables.map(snapshot)).toEqual(before)
    for (let index = 0; index < productIds.length; index++)
      expect(product(index)).toMatchObject({
        id: productIds[index],
        legacy_id: 100 + index,
        category_id: 'c1',
        status: 'draft',
        regulatory: '{}',
        attributes: '{}'
      })
    const rows = records().map((row) => ({ ...row, expectedVersion: 2 }))
    expect(await previewEditorialCsv(database, claims, exportEditorialCsv(rows))).toMatchObject({
      outcome: 'invalid',
      issues: [{ code: 'no_changes' }]
    })
  })
  it('rechecks CAS in the actual batch; a late edit never partly applies the first product', async () => {
    const p = await preview(),
      first = product(0)
    const raced = interpose(() => {
      sqlite.prepare("UPDATE products SET name = 'Concurrent editorial change' WHERE id = ?").run(productIds[1]!)
    })
    await expect(
      executeEditorialCommand(
        raced,
        claims,
        p.id,
        'apply',
        { previewHash: p.hash, reason: 'Race should reject all' },
        'race53'
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(product(0)).toEqual(first)
    expect(counts()).toMatchObject({ commands: 0, audits: 0, guards: 0 })
  })
  it('a failure during UPDATE rolls back every command, audit and product mutation', async () => {
    const p = await preview(),
      before = productIds.map((_id, index) => product(index))
    sqlite.exec(`CREATE TRIGGER simulate_editorial_failure BEFORE UPDATE ON products
      WHEN NEW.id = '${productIds[1]}' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`)
    await expect(
      executeEditorialCommand(
        database,
        claims,
        p.id,
        'apply',
        { previewHash: p.hash, reason: 'Storage failure must rollback' },
        'fail53'
      )
    ).rejects.toThrow('simulated')
    expect(productIds.map((_id, index) => product(index))).toEqual(before)
    expect(counts()).toMatchObject({ commands: 0, audits: 0, guards: 0 })
  })
  it('reversion refuses any subsequent metadata edit and cannot lose later work', async () => {
    const p = await preview()
    await executeEditorialCommand(
      database,
      claims,
      p.id,
      'apply',
      { previewHash: p.hash, reason: 'Apply once' },
      'before-revert53'
    )
    sqlite.prepare("UPDATE products SET series = 'Later work' WHERE id = ?").run(productIds[1]!)
    const before = productIds.map((_id, index) => product(index))
    await expect(
      executeEditorialCommand(
        database,
        claims,
        p.id,
        'revert',
        { previewHash: p.hash, reason: 'Do not overwrite later work' },
        'bad-revert53'
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(productIds.map((_id, index) => product(index))).toEqual(before)
    expect(counts()).toMatchObject({ commands: 1, audits: 2 })
  })
  it('requires live MFA and permission at execution, even after an earlier preview', async () => {
    const p = await preview(),
      body = { previewHash: p.hash, reason: 'Denied late grant' }
    const revoked = interpose(() => sqlite.exec("DELETE FROM role_permissions WHERE role_code = 'editorial53'"))
    await expect(executeEditorialCommand(revoked, claims, p.id, 'apply', body, 'denied53')).rejects.toMatchObject({
      code: 'forbidden'
    })
    expect(product(0).catalog_version).toBe(1)
    sqlite.exec("INSERT INTO role_permissions VALUES ('editorial53','catalog.write')")
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified = 0 WHERE id = ?').run(session)
    await expect(readEditorialPreview(database, claims, p.id)).rejects.toMatchObject({ code: 'mfa_required' })
    await expect(readEditorialPreview(database, null, p.id)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('immutable previews, commands and audits resist UPDATE, DELETE and REPLACE', async () => {
    const p = await preview()
    await executeEditorialCommand(
      database,
      claims,
      p.id,
      'apply',
      { previewHash: p.hash, reason: 'Immutable ledger' },
      'immutable53'
    )
    for (const table of ['catalog_editorial_previews', 'catalog_editorial_commands', 'catalog_editorial_audit']) {
      const column =
        table === 'catalog_editorial_previews'
          ? 'hash'
          : table === 'catalog_editorial_commands'
            ? 'reason'
            : 'after_metadata'
      expect(() => sqlite.exec('UPDATE ' + table + ' SET ' + column + ' = ' + column)).toThrow('immutable')
      expect(() => sqlite.exec('DELETE FROM ' + table)).toThrow('immutable')
      expect(() => sqlite.exec('INSERT OR REPLACE INTO ' + table + ' SELECT * FROM ' + table)).toThrow('immutable')
    }
  })
  it('exports incomplete drafts faithfully without making them import-valid or including published products', async () => {
    const csv = new TextDecoder().decode(await exportEditorialTemplate(database, claims))
    expect(csv).toContain('catalog_version')
    expect(csv).toContain(productIds[0])
    expect(csv).not.toContain('p-1')
    expect((await previewEditorialCsv(database, claims, new TextEncoder().encode(csv))).outcome).toBe('invalid')
  })
  it('own-data DTOs refuse accessors without executing them', () => {
    let calls = 0
    const data = Object.defineProperty({}, 'source', {
      get: () => {
        calls++
        return 'cloudflare'
      },
      enumerable: true
    })
    expect(editorialPreviewSchema.safeParse(data).success).toBe(false)
    expect(calls).toBe(0)
  })
  it('HTTP uses sealed sessions, exact CSRF, no-store and does not disguise outages as conflicts', async () => {
    const cookie = await issueD1SessionCookie(database, claims, { password, maxAgeSeconds: 3600 })
    const env = {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://editorial.invalid',
      NUXT_SESSION_PASSWORD: password
    }
    const base = env.AUTH_ORIGIN + '/api/admin/catalog/editorial-import'
    const headers = { Cookie: cookie!.split(';')[0]!, Origin: env.AUTH_ORIGIN, 'Content-Type': 'application/json' }
    const response = await handleEditorialImportHttp(
      new Request(base + '/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ csv: new TextDecoder().decode(exportEditorialCsv(records())) })
      }),
      env
    )
    expect(response!.status).toBe(200)
    expect(response!.headers.get('cache-control')).toContain('no-store')
    expect((await response!.json()) as object).toMatchObject({ outcome: 'preview' })
    expect(
      (await handleEditorialImportHttp(new Request(base + '/template', { headers: { Cookie: headers.Cookie } }), env))!
        .status
    ).toBe(200)
    expect(
      (await handleEditorialImportHttp(
        new Request(base + '/preview', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://attacker.invalid' },
          body: '{}'
        }),
        env
      ))!.status
    ).toBe(403)
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw Error('private SQL outage')
        }
      } as unknown as D1Database
    }
    const failure = await handleEditorialImportHttp(
      new Request(base + '/template', { headers: { Cookie: headers.Cookie } }),
      broken
    )
    expect(failure!.status).toBe(503)
    expect(await failure!.text()).toBe('{"error":{"code":"service_unavailable"}}')
    expect(ownsEditorialImportNamespace('/api/admin/catalog/%65ditorial-import/preview')).toBe(true)
  })
})
