import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { deterministicTestData } from '../fixtures/deterministic'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { executeD1CatalogCategoryCommand } from '../../workers/catalog/admin-categories'
import { executeD1AdminInventoryCommand } from '../../workers/catalog/admin-inventory'
import { readD1AdminActivity } from '../../workers/auth/admin-activity'

describe('audited administrative activity on actual workerd D1', () => {
  it('merges real audit commands with safe permission-scoped pagination and no writes', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'admin-activity-native',
        modules: true,
        script: 'export default {fetch(){return new Response("isolated")}}',
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000045' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = (await runtime.getD1Database('DB')) as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < sql.length; index += 50)
          await database.batch(sql.slice(index, index + 50).map((statement) => database.prepare(statement)))
      }
      const seeds: D1PreparedStatement[] = []
      seedInventoryFixture({
        exec(sql: string) {
          for (const statement of splitDemoSql(sql)) seeds.push(database.prepare(statement))
        },
        prepare(sql: string) {
          return {
            run(...parameters: unknown[]) {
              seeds.push(database.prepare(sql).bind(...parameters))
            }
          }
        }
      } as unknown as DatabaseSync)
      await database.batch(seeds)
      const data = deterministicTestData('activity-native', '2030-01-02T12:00:00.000Z'),
        instant = data.date().toISOString().replace('.000Z', 'Z'),
        identity = data.uuid(),
        session = data.uuid(),
        claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
      await database.batch([
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'private-native@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity),
        database.prepare("INSERT INTO roles VALUES('activity-native','Synthetic activity operator','Synthetic')"),
        database
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'activity-native','2020-01-01T00:00:00Z')"
          )
          .bind(identity)
      ])
      for (const permission of [
        'catalog.write',
        'catalog.publish',
        'inventory.read',
        'inventory.write',
        'administration.manage',
        'support.manage'
      ]) {
        const [resource, action] = permission.split('.')
        await database.batch([
          database
            .prepare('INSERT OR IGNORE INTO permissions VALUES(?,?,?,?)')
            .bind(permission, resource, action, 'Synthetic'),
          database.prepare("INSERT INTO role_permissions VALUES('activity-native',?)").bind(permission)
        ])
      }
      for (let index = 0; index < 2; index++)
        await executeD1CatalogCategoryCommand(
          database,
          claims,
          'create_category',
          {},
          {
            name: `Synthetic hidden business label ${index}`,
            expectedVersion: 0,
            reason: 'Internal confidential activity reason'
          },
          { idempotencyKey: data.uuid(), now: instant }
        )
      // Private inventory commands require canonical UUIDs, unlike the older
      // storefront fixture IDs. Add one explicit synthetic governed SKU.
      const productId = data.uuid(),
        variantId = data.uuid()
      await database.batch([
        database
          .prepare(
            "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES(?,991,'c1','Synthetic private inventory','native-private-inventory','draft')"
          )
          .bind(productId),
        database
          .prepare(
            "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock) VALUES(?,991,?,'t21','sp1','NATIVE-INVENTORY','Caja','draft','ud',0,2)"
          )
          .bind(variantId, productId),
        database
          .prepare(
            "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES(?,'loc-main',20,0,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(variantId),
        database
          .prepare(
            "INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at) VALUES(?,?,'loc-main','initial',20,0,'synthetic','native-inventory-initial','native','2020-01-01T00:00:00Z')"
          )
          .bind(data.uuid(), variantId)
      ])
      await executeD1AdminInventoryCommand(
        database,
        claims,
        'receipt',
        { variantId: '991' },
        {
          expectedBalanceVersion: 1,
          quantity: 2,
          reason: 'Internal confidential physical decision',
          reference: 'private-reference'
        },
        { idempotencyKey: data.uuid(), now: instant }
      )
      const tables = [
        'identities',
        'auth_sessions',
        'identity_roles',
        'role_permissions',
        'catalog_category_audit',
        'catalog_category_commands',
        'categories',
        'inventory_admin_audit',
        'inventory_admin_commands',
        'inventory_balances',
        'inventory_movements'
      ]
      const snapshot = async () =>
        Promise.all(
          tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
        )
      const before = await snapshot()
      // D1's internal request bookkeeping affects connection total_changes().
      // Assert actual application rows and D1's rows_written on every read.
      const readOnly = new Proxy(database, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/)
              const prepared = target.prepare(sql)
              return {
                bind(...parameters: unknown[]) {
                  const bound = prepared.bind(...parameters)
                  const all = async () => {
                    const rows = await bound.all()
                    expect(rows.meta.rows_written).toBe(0)
                    return rows
                  }
                  return { all, first: async () => (await all()).results[0] ?? null }
                }
              }
            }
          throw new Error('Activity must only prepare read statements')
        }
      }) as D1Database
      const first = await readD1AdminActivity(readOnly, claims, { limit: 2, now: () => instant })
      const second = await readD1AdminActivity(readOnly, claims, {
        limit: 2,
        cursor: first.nextCursor!,
        now: () => instant
      })
      expect(first.items).toHaveLength(2)
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      const events = [...first.items, ...second.items]
      expect(new Set(events.map((event) => event.id)).size).toBe(3)
      expect(events.map((event) => event.kind).sort()).toEqual(['catalog_category', 'catalog_category', 'inventory'])
      expect(JSON.stringify(events)).not.toMatch(
        /private|confidential|hidden business|actor|warehouse|physicalQuantity|reference/
      )
      expect(await snapshot()).toEqual(before)
      await database
        .prepare("DELETE FROM role_permissions WHERE role_code='activity-native' AND permission_code='inventory.read'")
        .run()
      expect(
        (await readD1AdminActivity(database, claims, { limit: 20, now: () => instant })).items.map(
          (event) => event.kind
        )
      ).toEqual(['catalog_category', 'catalog_category'])
      await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(instant, session).run()
      await expect(readD1AdminActivity(database, claims, { limit: 5, now: () => instant })).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})
