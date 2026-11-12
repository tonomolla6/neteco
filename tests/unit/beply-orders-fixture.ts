import { vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { BASE_MIGRATION_NAMES } from '../support/d1-sqlite'
import { fiscalRuntimeWorld, FISCAL_RUNTIME_NOW as NOW } from './d1-fiscal-runtime-fixture'
import { dispatchBeplyOrders } from '../../workers/integrations/beply-orders'
import type { BeplyOrderAdapter } from '../../shared/beply-orders'

export async function beplyOrdersWorld(opened: DatabaseSync[]) {
  const value = await fiscalRuntimeWorld(opened)
  const directory = new URL('../../db/d1/migrations/', import.meta.url)
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    if (BASE_MIGRATION_NAMES.has(name) || name === '0047_fiscal_runtime_email_manifest.sql') continue
    try {
      value.sqlite.exec('BEGIN')
      value.sqlite.exec(
        (await readFile(new URL(name, directory), 'utf8')).replaceAll("'now'", 'synthetic_fiscal_clock()')
      )
      value.sqlite.exec('COMMIT')
    } catch (error) {
      value.sqlite.exec('ROLLBACK')
      throw new Error(name, { cause: error })
    }
  }
  const adapter = {
    createOrder: vi.fn<BeplyOrderAdapter['createOrder']>().mockResolvedValue({ providerOrderId: '71', code: 'PED71' }),
    lookupOrder: vi.fn<BeplyOrderAdapter['lookupOrder']>().mockResolvedValue(null),
    updateOrder: vi.fn<BeplyOrderAdapter['updateOrder']>().mockResolvedValue(undefined),
    readOrder: vi
      .fn<BeplyOrderAdapter['readOrder']>()
      .mockResolvedValue({ served: true, deliveryNoteIds: ['81'], invoiceIds: ['91'] })
  }
  const run = (now = NOW) => dispatchBeplyOrders(value.database, adapter, { enabled: true, now, limit: 1 })
  const row = () => value.sqlite.prepare('SELECT * FROM beply_order_sync WHERE order_id=?').get(value.order.orderId)!
  return { ...value, adapter, run, row }
}
