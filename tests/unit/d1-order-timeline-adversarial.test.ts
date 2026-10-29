import { afterEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { readD1OrderTimeline } from '../../workers/catalog/order-timeline'
import type { DatabaseSync } from 'node:sqlite'

const opened: DatabaseSync[] = []
afterEach(() => {
  opened.splice(0).forEach((database) => database.close())
  vi.useRealTimers()
})

describe('order timeline final authorization adversarial interleaving', () => {
  it.each([
    ['admin', "UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['admin', 'DELETE FROM identity_roles', 'forbidden'],
    ['customer', "UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated']
  ] as const)(
    'refuses %s authority lost during final order existence/ownership read (%s)',
    async (audience, mutation, code) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
      const fixture = await returnsFixture()
      opened.push(fixture.sqlite)
      fixture.sqlite.function('timeline_adversarial_clock', () => utc())
      const rawPrepare = fixture.database.prepare.bind(fixture.database)
      fixture.database.prepare = (sql) => rawPrepare(sql.replaceAll("'now'", 'timeline_adversarial_clock()'))
      const orderId = await fixture.order({ paid: false, delivered: false })
      let ownershipReads = 0
      const prepare = fixture.database.prepare.bind(fixture.database)
      const database = new Proxy(fixture.database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              const statement = prepare(sql)
              if (!sql.startsWith('SELECT id FROM orders WHERE id=?1')) return statement
              return {
                bind(...values: unknown[]) {
                  const bound = statement.bind(...values)
                  return {
                    async first() {
                      // The row is real SQLite evidence, not a manufactured grant.
                      const row = await bound.first()
                      if (++ownershipReads === 2) fixture.sqlite.exec(mutation)
                      return row
                    }
                  }
                }
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      await expect(
        readD1OrderTimeline(database, audience === 'admin' ? CLAIMS : BUYER_CLAIMS, orderId, {
          audience,
          appEnvironment: 'local',
          now: () => utc()
        })
      ).rejects.toMatchObject({ code })
    }
  )
})
