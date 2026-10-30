import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeProductRecall } from '../../workers/catalog/product-recall'
import { listAvailability } from '../../workers/catalog/inventory'
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, location: string
const lotA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const lotB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ids = [1, 2, 3, 4, 5, 6].map(
  (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`
)
const options = { now: () => utc() }
const run = (lot: string, raw: unknown, id: string) => executeProductRecall(f.database, CLAIMS, lot, id, raw, options)
const sellable = async () =>
  (await listAvailability(f.database, { variantId: 'v-1-1' })).reduce((sum, row) => sum + row.sellableQuantity, 0)
const balance = () =>
  f.sqlite
    .prepare('SELECT physical_quantity p, blocked_quantity b, version v FROM inventory_balances WHERE variant_id=?')
    .get('v-1-1') as { p: number; b: number; v: number }
const addLot = (id: string, quantity: number) =>
  f.sqlite
    .prepare(
      "INSERT INTO inventory_lots(id,variant_id,lot_number,location_id,status,expires_at,initial_quantity,available_quantity,version,created_at,updated_at) VALUES(?,?,?,?,'active',?,10,?,1,?,?)"
    )
    .run(id, 'v-1-1', `lot-${id.slice(0, 4)}`, location, utc(86400000), quantity, utc(), utc())
const allocate = (lot: string, quantity: number) =>
  f.sqlite
    .prepare(
      'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,?,?,?,?)'
    )
    .run(crypto.randomUUID(), lot, orderId, CUSTOMER, quantity, 'synthetic', utc())
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  orderId = await f.order({ paid: false, delivered: false })
  location = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  addLot(lotA, 8)
  allocate(lotA, 2)
})
afterEach(() => f?.sqlite.close())
const open = (lot = lotA, id = ids[0]!) =>
  run(lot, { action: 'open', expectedVersion: 0, evidence: 'incident-case-123' }, id)
const closeLot = async (lot: string, firstId: string, ids2: [string, string]) => {
  await run(
    lot,
    { action: 'communicate', expectedVersion: 1, evidence: 'notice-case-123', orderId, lineIndex: 0 },
    ids2[0]
  )
  await run(lot, { action: 'resolve', expectedVersion: 2, evidence: 'resolution-case-123' }, ids2[1])
  void firstId
}
it('shows zero sellable stock for the whole variant while a recall is open', async () => {
  expect(await sellable()).toBeGreaterThan(0)
  const before = balance()
  await open()
  expect(await sellable()).toBe(0)
  const after = balance()
  expect(after.b).toBe(after.p)
  expect(after.v).toBe(before.v + 1)
})
it('restores the previous blocked quantity after resolution', async () => {
  f.sqlite.prepare('UPDATE inventory_balances SET blocked_quantity=1 WHERE variant_id=?').run('v-1-1')
  const before = balance()
  await open()
  await closeLot(lotA, ids[0]!, [ids[1]!, ids[2]!])
  const after = balance()
  expect(after.b).toBe(1)
  expect(after.p).toBe(before.p)
  expect(await sellable()).toBeGreaterThan(0)
  expect(f.sqlite.prepare('SELECT count(*) n FROM product_recall_stock_holds').get()).toEqual({ n: 0 })
})
it('keeps stock blocked until every open recall of the variant is resolved', async () => {
  addLot(lotB, 5)
  await open(lotA, ids[0])
  await open(lotB, ids[3])
  await closeLot(lotA, ids[0]!, [ids[1]!, ids[2]!])
  expect(await sellable()).toBe(0)
  expect(balance().b).toBe(balance().p)
})
it('blocks stock received while the recall is open', async () => {
  await open()
  f.sqlite
    .prepare('UPDATE inventory_balances SET physical_quantity=physical_quantity+50 WHERE variant_id=?')
    .run('v-1-1')
  expect(await sellable()).toBe(0)
  expect(balance().b).toBe(balance().p)
})
it('does not touch other variants', async () => {
  const other = f.sqlite
    .prepare("SELECT variant_id v, blocked_quantity b FROM inventory_balances WHERE variant_id<>'v-1-1' LIMIT 1")
    .get() as { v: string; b: number } | undefined
  await open()
  if (other)
    expect(
      f.sqlite.prepare('SELECT blocked_quantity b FROM inventory_balances WHERE variant_id=?').get(other.v)
    ).toEqual({ b: other.b })
})
it('rolls back the stock block when the recall command is rejected', async () => {
  const before = balance()
  await expect(
    run(lotA, { action: 'resolve', expectedVersion: 0, evidence: 'resolution-case-123' }, ids[0]!)
  ).rejects.toThrow()
  expect(balance()).toEqual(before)
})
