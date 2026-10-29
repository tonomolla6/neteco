import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EDITORIAL_CSV_COLUMNS, exportEditorialCsv, type EditorialCsvRow } from '../../shared/catalog-editorial-csv'
import type { EditorialPreview } from '../../shared/catalog-editorial-import'
import {
  executeEditorialCommand,
  exportEditorialTemplate,
  previewEditorialCsv,
  readEditorialPreview
} from '../../workers/catalog/editorial-import'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const owner = {
  identityId: '0053ad00-0000-4000-8000-000000000001',
  sessionId: '0053ad00-0000-4000-8000-000000000002',
  sessionVersion: 1
}
const other = {
  identityId: '0053ad00-0000-4000-8000-000000000003',
  sessionId: '0053ad00-0000-4000-8000-000000000004',
  sessionVersion: 1
}
const role = 'editorial-adversarial53'
const productId = (index: number) => '0053ad10-0000-4000-8000-' + String(index + 1).padStart(12, '0')
const reason = 'Synthetic local editorial approval, no publication authority'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

// Every query and batch still executes against SQLite with all 53 migrations.
// These wrappers observe or interpose a real competing transaction; they never
// manufacture a query result, a successful batch, or parallel Durable Objects.
function observe(database: D1Database) {
  const queries: string[] = [],
    bindings: number[] = [],
    batches: number[] = []
  const observed: D1Database = {
    ...database,
    prepare(sql) {
      queries.push(sql)
      const statement = database.prepare(sql),
        bind = statement.bind
      statement.bind = (...parameters: unknown[]) => {
        bindings.push(parameters.length)
        bind(...parameters)
        return statement
      }
      return statement
    },
    async batch(statements) {
      batches.push(statements.length)
      return database.batch(statements)
    }
  }
  return { database: observed, queries, bindings, batches }
}

describe('D1 editorial import adversarial authority and atomicity', () => {
  let sqlite: DatabaseSync, database: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite
      .prepare('INSERT INTO roles(code,name,description) VALUES (?, ?, ?)')
      .run(role, 'Synthetic editorial auditors', 'Ephemeral local fixture only')
    sqlite.exec("INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Synthetic fixture')")
    sqlite.prepare("INSERT INTO role_permissions VALUES (?, 'catalog.write')").run(role)
    for (const [index, claims] of [owner, other].entries()) {
      sqlite
        .prepare(
          `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
           VALUES (?, ?, 'synthetic-unusable', ?, 'active', ?, ?)`
        )
        .run(
          claims.identityId,
          `editorial-adversarial-${index}@example.invalid`,
          utc(-86400_000),
          utc(-86400_000),
          utc(-86400_000)
        )
      sqlite
        .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, ?, ?)')
        .run(claims.identityId, role, utc(-86400_000))
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
           VALUES (?, ?, 1, 1, ?, ?)`
        )
        .run(claims.sessionId, claims.identityId, utc(-86400_000), utc(3600_000))
    }
    seedProducts(0, 2)
  })

  afterEach(() => sqlite.close())

  function seedProducts(start: number, count: number) {
    for (let index = start; index < start + count; index++)
      sqlite
        .prepare(
          `INSERT INTO products(id,legacy_id,category_id,name,slug,status,short_description,description,usage,series)
           VALUES (?, ?, 'c1', ?, ?, ?, NULL, '', NULL, '')`
        )
        .run(
          productId(index),
          1000 + index,
          `Original draft ${index}`,
          `adversarial-editorial-${index}`,
          index % 2 ? 'review' : 'draft'
        )
  }

  function records(count = 2, start = 0): EditorialCsvRow[] {
    return Array.from({ length: count }, (_value, offset) => {
      const index = start + offset
      return {
        productId: productId(index),
        legacyId: 1000 + index,
        expectedVersion: 1,
        metadata: {
          name: `Updated draft ${index}`,
          shortDesc: `Editorial short description ${index}`,
          description: `Editorial description ${index}, with comma\nand multiline content.`,
          usage: index % 2 ? 'Safe editorial usage\nSecond line' : null,
          series: index % 2 ? 'Editorial series' : null,
          featured: Boolean(index % 2)
        }
      }
    })
  }

  function products() {
    return sqlite.prepare("SELECT * FROM products WHERE id LIKE '0053ad10-%' ORDER BY id").all()
  }

  function counts() {
    return sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM catalog_editorial_previews) AS previews,
                (SELECT count(*) FROM catalog_editorial_commands) AS commands,
                (SELECT count(*) FROM catalog_editorial_audit) AS audits,
                (SELECT count(*) FROM catalog_editorial_guards) AS guards`
      )
      .get()
  }

  async function preview(db = database, rows = records()): Promise<EditorialPreview> {
    const result = await previewEditorialCsv(db, owner, exportEditorialCsv(rows))
    if (result.outcome !== 'preview') throw new Error('expected_valid_preview')
    return result
  }

  function execute(p: EditorialPreview, key: string, action: 'apply' | 'revert' = 'apply', db = database) {
    return executeEditorialCommand(db, owner, p.id, action, { previewHash: p.hash, reason }, key)
  }

  function beforeBatch(action: () => void): D1Database {
    return {
      ...database,
      async batch(statements) {
        action()
        return database.batch(statements)
      }
    }
  }

  function afterTemplateRead(action: () => void): D1Database {
    return {
      ...database,
      prepare(sql) {
        const statement = database.prepare(sql)
        if (sql.includes('FROM actor JOIN products p') && sql.includes('LIMIT 101')) {
          const all = statement.all
          statement.all = async <T>() => {
            const result = await all<T>()
            action()
            return result
          }
        }
        return statement
      }
    }
  }

  function historicalPreview(p: EditorialPreview, expires: 'now' | '-1 minute') {
    const id = crypto.randomUUID()
    // Represent an already stored historical preview, without UPDATE/DELETE of
    // the immutable ledger or changing SQLite's/server's clocks or triggers.
    sqlite
      .prepare(
        `INSERT INTO catalog_editorial_previews(id,actor_id,hash,manifest,created_at,expires_at)
         SELECT ?, actor_id, hash, manifest,
           strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
           strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
         FROM catalog_editorial_previews WHERE id = ?`
      )
      .run(id, expires === 'now' ? '-30 minutes' : '-31 minutes', expires === 'now' ? '+0 seconds' : expires, p.id)
    return id
  }

  it('previews, applies and reverses 100 real rows under D1 limits without per-product SQL', async () => {
    seedProducts(2, 98)
    const before = products(),
      protectedBefore = sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id').all(),
      tracedPreview = observe(database),
      p = await preview(tracedPreview.database, records(100))
    expect(p.products).toHaveLength(100)
    expect(products()).toEqual(before)
    expect(tracedPreview.queries.filter((sql) => sql.includes('FROM actor JOIN products p'))).toHaveLength(1)
    expect(tracedPreview.queries).toHaveLength(10)
    expect(tracedPreview.batches).toEqual([3])

    const tracedApply = observe(database),
      applied = await execute(p, 'hundred-apply53', 'apply', tracedApply.database)
    expect(applied.productCount).toBe(100)
    expect(products().every((row) => row.catalog_version === 2)).toBe(true)
    for (const [index, row] of products().entries())
      expect(row).toMatchObject({
        name: records(100)[index]!.metadata.name,
        short_description: records(100)[index]!.metadata.shortDesc,
        category_id: 'c1',
        status: index % 2 ? 'review' : 'draft'
      })
    expect(tracedApply.queries.filter((sql) => sql.startsWith('UPDATE products SET'))).toHaveLength(1)
    expect(tracedApply.queries).toHaveLength(12)
    expect(tracedApply.batches).toEqual([5])

    const tracedRevert = observe(database)
    expect((await execute(p, 'hundred-revert53', 'revert', tracedRevert.database)).productCount).toBe(100)
    expect(products().map(({ catalog_version, updated_at, ...row }) => row)).toEqual(
      before.map(({ catalog_version, updated_at, ...row }) => row)
    )
    expect(products().every((row) => row.catalog_version === 3)).toBe(true)
    expect(tracedRevert.queries.filter((sql) => sql.startsWith('UPDATE products SET'))).toHaveLength(1)
    expect(tracedRevert.queries).toHaveLength(12)
    expect(tracedRevert.batches).toEqual([5])
    for (const trace of [tracedPreview, tracedApply, tracedRevert])
      expect(Math.max(...trace.bindings)).toBeLessThanOrEqual(12)
    expect(sqlite.limits.variableNumber).toBe(100)
    expect(sqlite.limits.exprDepth).toBe(100)
    expect(sqlite.limits.functionArg).toBe(32)
    expect(counts()).toEqual({ previews: 1, commands: 2, audits: 200, guards: 0 })
    expect(sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id').all()).toEqual(protectedBefore)
  })

  it('rejects 101 CSV rows before catalog SQL and never silently truncates a 101-product template', async () => {
    seedProducts(2, 99)
    const hundred = new TextDecoder().decode(exportEditorialCsv(records(100))),
      extra = new TextDecoder().decode(exportEditorialCsv(records(1, 100))),
      bytes = new TextEncoder().encode(hundred + extra.slice(extra.indexOf('\r\n') + 2)),
      traced = observe(database),
      before = products()
    expect(await previewEditorialCsv(traced.database, owner, bytes)).toMatchObject({
      outcome: 'invalid',
      issues: [{ code: 'invalid_csv' }]
    })
    expect(traced.queries.filter((sql) => sql.includes('JOIN products'))).toHaveLength(0)
    expect(traced.batches).toEqual([])
    await expect(exportEditorialTemplate(database, owner)).rejects.toMatchObject({ code: 'export_too_large' })
    expect(products()).toEqual(before)
    expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
  })

  it('a second live MFA-authorized editor cannot read, apply or replay the owner preview', async () => {
    const p = await preview(),
      before = products(),
      body = { previewHash: p.hash, reason }
    expect(new TextDecoder().decode(await exportEditorialTemplate(database, other))).toContain(EDITORIAL_CSV_COLUMNS[0])
    await expect(readEditorialPreview(database, other, p.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      executeEditorialCommand(database, other, p.id, 'apply', body, 'owner-private53')
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(products()).toEqual(before)
    const receipt = await execute(p, 'owner-private53')
    await expect(
      executeEditorialCommand(database, other, p.id, 'apply', body, 'owner-private53')
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      executeEditorialCommand(database, other, p.id, 'revert', body, 'other-revert53')
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await execute(p, 'owner-private53')).toEqual(receipt)
    expect(counts()).toEqual({ previews: 1, commands: 1, audits: 2, guards: 0 })
  })

  it('pending previews have exactly 30 minutes of durable validity', async () => {
    const p = await preview()
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(30 * 60 * 1000)
    expect(p.status).toBe('pending')
    expect((await readEditorialPreview(database, owner, p.id)).status).toBe('pending')
    expect(counts()).toEqual({ previews: 1, commands: 0, audits: 0, guards: 0 })
  })

  it.each(['now', '-1 minute'] as const)('an uncommitted preview expiring at %s cannot apply', async (at) => {
    const p = await preview(),
      id = historicalPreview(p, at),
      before = products()
    const expired = await readEditorialPreview(database, owner, id)
    expect(expired.status).toBe('expired')
    expect(Date.parse(expired.expiresAt) - Date.parse(expired.createdAt)).toBe(30 * 60 * 1000)
    await expect(execute(expired, 'expired-preview53')).rejects.toMatchObject({ code: 'preview_expired' })
    expect(products()).toEqual(before)
    expect(counts()).toEqual({ previews: 2, commands: 0, audits: 0, guards: 0 })
  })

  it.each(['metadata', 'session', 'grant'] as const)(
    'a trigger changing %s between UPDATE and the final guard rolls back the entire apply',
    async (change) => {
      const p = await preview(),
        before = products(),
        sessionBefore = sqlite.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(owner.sessionId),
        grantsBefore = sqlite.prepare('SELECT * FROM role_permissions WHERE role_code = ?').all(role)
      const mutation =
        change === 'metadata'
          ? `UPDATE products SET series = 'Injected after update' WHERE id = NEW.id;`
          : change === 'session'
            ? `UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = '${owner.sessionId}';`
            : `DELETE FROM role_permissions WHERE role_code = '${role}';`
      sqlite.exec(`CREATE TRIGGER editorial_post_update_interference AFTER UPDATE OF name ON products
      WHEN NEW.id = '${productId(1)}' AND NEW.catalog_version = 2 BEGIN ${mutation} END;`)
      await expect(execute(p, `post-update-${change}53`)).rejects.toMatchObject({ code: 'version_conflict' })
      expect(products()).toEqual(before)
      expect(sqlite.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(owner.sessionId)).toEqual(sessionBefore)
      expect(sqlite.prepare('SELECT * FROM role_permissions WHERE role_code = ?').all(role)).toEqual(grantsBefore)
      expect(counts()).toEqual({ previews: 1, commands: 0, audits: 0, guards: 0 })
      expect((await readEditorialPreview(database, owner, p.id)).status).toBe('pending')
    }
  )

  it.each(['metadata', 'session'] as const)(
    'a trigger changing %s during revert preserves the prior apply and all its audit evidence',
    async (change) => {
      const p = await preview()
      await execute(p, 'before-trigger-revert53')
      const before = products(),
        commandsBefore = sqlite.prepare('SELECT * FROM catalog_editorial_commands').all(),
        auditsBefore = sqlite.prepare('SELECT * FROM catalog_editorial_audit ORDER BY product_id').all()
      const mutation =
        change === 'metadata'
          ? `UPDATE products SET series = 'Injected during revert' WHERE id = NEW.id;`
          : `UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = '${owner.sessionId}';`
      sqlite.exec(`CREATE TRIGGER editorial_post_revert_interference AFTER UPDATE OF name ON products
      WHEN NEW.id = '${productId(1)}' AND NEW.catalog_version = 3 BEGIN ${mutation} END;`)
      await expect(execute(p, 'revert-post-update53', 'revert')).rejects.toMatchObject({ code: 'version_conflict' })
      expect(products()).toEqual(before)
      expect(sqlite.prepare('SELECT * FROM catalog_editorial_commands').all()).toEqual(commandsBefore)
      expect(sqlite.prepare('SELECT * FROM catalog_editorial_audit ORDER BY product_id').all()).toEqual(auditsBefore)
      expect(counts()).toEqual({ previews: 1, commands: 1, audits: 2, guards: 0 })
      expect((await readEditorialPreview(database, owner, p.id)).status).toBe('applied')
    }
  )

  it.each(['metadata', 'version', 'status'] as const)(
    'a %s race after the snapshot but before preview persistence leaves no stale preview or importer product writes',
    async (change) => {
      const before = products()
      let competingState = before,
        calls = 0
      const raced = beforeBatch(() => {
        calls++
        const update =
          change === 'metadata'
            ? "UPDATE products SET series = 'Concurrent series without version bump' WHERE id = ?"
            : change === 'version'
              ? 'UPDATE products SET catalog_version = catalog_version + 1 WHERE id = ?'
              : "UPDATE products SET status = 'published' WHERE id = ?"
        sqlite.prepare(update).run(productId(1))
        competingState = products()
      })
      await expect(preview(raced)).rejects.toMatchObject({ code: 'version_conflict' })
      expect(calls).toBe(1)
      expect(products()).toEqual(competingState)
      expect(products()[0]).toEqual(before[0])
      expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
    }
  )

  it('an idempotency key belongs to its exact preview envelope, not another pending preview', async () => {
    const first = await preview(database, records(1)),
      second = await preview(database, records(1, 1)),
      beforeSecond = products()[1],
      receipt = await execute(first, 'cross-preview53')
    await expect(execute(second, 'cross-preview53')).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(products()[1]).toEqual(beforeSecond)
    expect((await readEditorialPreview(database, owner, second.id)).status).toBe('pending')
    expect(await execute(first, 'cross-preview53')).toEqual(receipt)
    expect(counts()).toEqual({ previews: 2, commands: 1, audits: 1, guards: 0 })
    expect((await execute(second, 'fresh-cross-preview53')).productCount).toBe(1)
    expect(counts()).toEqual({ previews: 2, commands: 2, audits: 2, guards: 0 })
  })

  it.each(['before-read', 'after-read'] as const)(
    'session revocation %s prevents template export rather than returning private draft bytes',
    async (phase) => {
      const before = products(),
        revoke = () =>
          sqlite
            .prepare("UPDATE auth_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .run(owner.sessionId)
      const db = phase === 'after-read' ? afterTemplateRead(revoke) : database
      if (phase === 'before-read') revoke()
      await expect(exportEditorialTemplate(db, owner)).rejects.toMatchObject({ code: 'unauthenticated' })
      expect(products()).toEqual(before)
      expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
    }
  )

  it('permission withdrawal after the catalog read prevents template export even while the session remains valid', async () => {
    const revoked = afterTemplateRead(() =>
      sqlite.prepare('DELETE FROM role_permissions WHERE role_code = ?').run(role)
    )
    await expect(exportEditorialTemplate(revoked, owner)).rejects.toMatchObject({ code: 'forbidden' })
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').get(owner.sessionId)).toEqual({
      revoked_at: null
    })
    expect(counts()).toEqual({ previews: 0, commands: 0, audits: 0, guards: 0 })
  })
})
