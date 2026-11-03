import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { recordListReplenishment } from '../../workers/catalog/customer-recurring-lists'

// SECFIX-3 finding 11: replenishment must not overwrite a concurrent list change (CAS on version).
const NOW = '2026-10-29T10:00:00Z'
const LIST = '40000000-0000-4000-8000-000000000001'
let sqlite: DatabaseSync

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
  sqlite.exec(`
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-l','L',NULL,'active','${NOW}','${NOW}');
    INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('ident-l','l@cliente.es','cust-l','x','${NOW}','active','${NOW}','${NOW}');
    INSERT INTO customer_recurring_lists(id, customer_id, owner_identity_id, name, frequency, status, version, created_at, updated_at)
      VALUES('${LIST}','cust-l','ident-l','Lista','weekly','active',1,'${NOW}','${NOW}');
  `)
})

afterEach(() => sqlite.close())

function withConcurrentFrequencyChange(target: DatabaseSync): D1Database {
  const d1 = d1OverSqlite(target)
  let injected = false
  return new Proxy(d1, {
    get(object, property, receiver) {
      if (property !== 'prepare') return Reflect.get(object, property, receiver)
      return (sql: string) => {
        if (!injected && !/^\s*SELECT/i.test(sql)) {
          injected = true
          target.exec(
            `UPDATE customer_recurring_lists SET frequency = 'monthly', version = version + 1 WHERE id = '${LIST}'`
          )
        }
        return object.prepare(sql)
      }
    }
  })
}

describe('SECFIX-3 recordListReplenishment CAS', () => {
  it('rejects with version_conflict instead of writing a date computed from a stale frequency', async () => {
    await expect(
      recordListReplenishment(withConcurrentFrequencyChange(sqlite), {
        listId: LIST,
        requesterIdentityId: 'ident-l',
        replenishedAt: NOW
      })
    ).rejects.toThrow('version_conflict')
    const row = sqlite
      .prepare('SELECT frequency, version, next_suggested_date FROM customer_recurring_lists WHERE id = ?')
      .get(LIST) as { frequency: string; version: number; next_suggested_date: string | null }
    expect(row).toEqual({ frequency: 'monthly', version: 2, next_suggested_date: null })
  })

  it('records the replenishment when nothing changed concurrently', async () => {
    const result = await recordListReplenishment(d1OverSqlite(sqlite), {
      listId: LIST,
      requesterIdentityId: 'ident-l',
      replenishedAt: NOW
    })
    expect(result.nextSuggestedDate).toBe('2026-11-05')
  })
})
