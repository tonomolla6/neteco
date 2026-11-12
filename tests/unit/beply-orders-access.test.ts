import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { beplyOrdersWorld } from './beply-orders-fixture'
import { FISCAL_RUNTIME_NOW as NOW, fiscalRuntimeClaims as claims } from './d1-fiscal-runtime-fixture'
import { readBeplyOrder } from '../../workers/integrations/beply-orders'

const opened: DatabaseSync[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
  for (const database of opened.splice(0)) database.close()
})

it('does not release ERP/tracking facts if the admin session expires during the awaited read', async () => {
  const w = await beplyOrdersWorld(opened)
  const database = {
    ...w.database,
    prepare(sql: string) {
      const statement = w.database.prepare(sql)
      if (sql !== 'SELECT * FROM beply_order_sync WHERE order_id=?1') return statement
      const wrapped = {
        ...statement,
        bind(...parameters: unknown[]) {
          statement.bind(...parameters)
          return wrapped
        },
        async first<T>() {
          const value = await statement.first<T>()
          vi.setSystemTime(new Date(Date.parse(NOW) + 7200000))
          return value
        }
      } as D1PreparedStatement
      return wrapped
    }
  } as D1Database
  await expect(readBeplyOrder(database, { kind: 'admin', claims }, w.order.orderId, NOW)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
