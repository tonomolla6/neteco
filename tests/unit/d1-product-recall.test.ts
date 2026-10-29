import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeProductRecall, readProductRecall } from '../../workers/catalog/product-recall'
import { assignReservation, reserveInventory } from '../../workers/catalog/inventory'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string
const lot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const key = '11111111-1111-4111-8111-111111111111'
const key2 = '22222222-2222-4222-8222-222222222222'
const options = { now: () => utc() }
const start = { action: 'open', expectedVersion: 0, evidence: 'incident-case-123' } as const
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  orderId = await f.order({ paid: false, delivered: false })
  const location = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  f.sqlite
    .prepare(
      "INSERT INTO inventory_lots(id,variant_id,lot_number,location_id,status,expires_at,initial_quantity,available_quantity,version,created_at,updated_at) VALUES(?,?,'case-lot',?,'active',?,10,8,1,?,?)"
    )
    .run(lot, 'v-1-1', location, utc(86400000), utc(), utc())
  f.sqlite
    .prepare(
      'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,?,2,?,?)'
    )
    .run(crypto.randomUUID(), lot, orderId, CUSTOMER, 'synthetic', utc())
})
afterEach(() => f?.sqlite.close())
const save = (raw: unknown = start, id = key) => executeProductRecall(f.database, CLAIMS, lot, id, raw, options)
it('opens an audited recall and identifies affected order lines and customers', async () => {
  const result = await save()
  expect(result).toMatchObject({ action: 'open', version: 1 })
  expect(await save()).toEqual(result)
  expect(await readProductRecall(f.database, CLAIMS, lot, options)).toMatchObject({
    version: 1,
    open: true,
    affected: [{ orderId, lineIndex: 0, customerId: CUSTOMER, quantity: 2 }]
  })
})
it('records communications and resolution with compare-and-swap', async () => {
  await save()
  await save({ action: 'communicate', expectedVersion: 1, evidence: 'notice-case-123', orderId, lineIndex: 0 }, key2)
  await save(
    { action: 'resolve', expectedVersion: 2, evidence: 'resolution-case-123' },
    '33333333-3333-4333-8333-333333333333'
  )
  expect(await readProductRecall(f.database, CLAIMS, lot, options)).toMatchObject({ version: 3, open: false })
  expect(() => f.sqlite.exec('DELETE FROM product_recall_commands')).toThrow()
})
it('blocks new reservations even for backorder while recall is open', async () => {
  await save()
  f.sqlite.prepare('UPDATE variants SET backorder_allowed=1 WHERE id=?').run('v-1-1')
  const location = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  await expect(
    reserveInventory(f.database, {
      idempotencyKey: 'recall-reservation',
      correlationId: 'recall-test',
      now: utc(),
      expiresAt: utc(600000),
      lines: [{ variantId: 'v-1-1', locationId: location, quantity: 1 }]
    })
  ).rejects.toThrow()
})
it('rejects conflicting keys and stale versions', async () => {
  await save()
  await expect(save({ ...start, evidence: 'different-case-123' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(save(start, key2)).rejects.toMatchObject({ code: 'conflict' })
})
it.each([{}, { ...start, action: 'resolve' }, { ...start, evidence: 'pii@example.invalid' }, { ...start, extra: 1 }])(
  'rejects invalid commands %j',
  async (input) => {
    await expect(save(input)).rejects.toMatchObject({ code: 'invalid_input' })
  }
)
it('denies non-admin access', async () => {
  await expect(readProductRecall(f.database, BUYER_CLAIMS, lot, options)).rejects.toMatchObject({
    code: 'mfa_required'
  })
})
it('checks revoked authority at commit', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM product_recall_commands').get()).toEqual({ n: 0 })
})

it('blocks assignment of a reservation made before the recall', async () => {
  const order = f.sqlite.prepare('SELECT reservation_id FROM orders WHERE id=?').get(orderId) as {
    reservation_id: string
  }
  await save()
  await expect(
    assignReservation(f.database, { idempotencyKey: order.reservation_id, correlationId: 'recall-test', now: utc() })
  ).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT status FROM inventory_reservations WHERE id=?').get(order.reservation_id)).toEqual({
    status: 'reserved'
  })
})
it('blocks fulfillment of an already paid order with the recalled variant', async () => {
  const paidOrder = await f.order({ paid: true, delivered: false })
  await save()
  await expect(
    executeD1AdminFulfillmentCommand(
      f.database,
      CLAIMS,
      paidOrder,
      { action: 'picking', expectedVersion: 0, reason: 'Synthetic recall safety test' },
      { idempotencyKey: 'recall-fulfillment-test' }
    )
  ).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT count(*) n FROM order_fulfillment_commands WHERE order_id=?').get(paidOrder)).toEqual(
    { n: 0 }
  )
})
it('permits a new reservation once the recall is resolved', async () => {
  await save()
  await save({ action: 'communicate', expectedVersion: 1, evidence: 'notice-case-123', orderId, lineIndex: 0 }, key2)
  await save(
    { action: 'resolve', expectedVersion: 2, evidence: 'resolution-case-123' },
    '33333333-3333-4333-8333-333333333333'
  )
  const location = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  expect(
    await reserveInventory(f.database, {
      idempotencyKey: 'recall-after-resolution',
      correlationId: 'recall-test',
      now: utc(),
      expiresAt: utc(600000),
      lines: [{ variantId: 'v-1-1', locationId: location, quantity: 1 }]
    })
  ).toMatchObject({ outcome: 'reserved' })
})
it('prevents allocating recalled stock to another order during an active recall', async () => {
  await save()
  expect(() =>
    f.sqlite
      .prepare(
        'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,?,1,?,?)'
      )
      .run(crypto.randomUUID(), lot, orderId, CUSTOMER, 'synthetic', utc())
  ).toThrow()
})

it('does not resolve until every affected order line has a recorded communication', async () => {
  await save()
  await expect(
    save({ action: 'resolve', expectedVersion: 1, evidence: 'resolution-case-123' }, key2)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect((await readProductRecall(f.database, CLAIMS, lot, options)).open).toBe(true)
})
it('does not record communications for unrelated order lines', async () => {
  await save()
  await expect(
    save({ action: 'communicate', expectedVersion: 1, evidence: 'notice-case-123', orderId, lineIndex: 99 }, key2)
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('does not release a recall when an order line of that variant has incomplete lot traceability', async () => {
  await f.order({ paid: false, delivered: false })
  await save()
  await save({ action: 'communicate', expectedVersion: 1, evidence: 'notice-case-123', orderId, lineIndex: 0 }, key2)
  await expect(
    save(
      { action: 'resolve', expectedVersion: 2, evidence: 'resolution-case-123' },
      '33333333-3333-4333-8333-333333333333'
    )
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('paginates affected lines without losing other customers', async () => {
 const other = await f.order({ paid: false, delivered: false })
 f.sqlite.prepare('INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,?,2,?,?)').run(crypto.randomUUID(),lot,other,CUSTOMER,'synthetic',utc())
 const firstPage = await readProductRecall(f.database, CLAIMS, lot, { ...options, limit: 1 })
 expect(firstPage.affected).toHaveLength(1)
 expect(firstPage.nextCursor).toBeTruthy()
 const next = await readProductRecall(f.database, CLAIMS, lot, { ...options, limit: 1, after: firstPage.nextCursor! })
 expect(next.affected).toHaveLength(1)
 expect(next.affected[0]!.orderId).not.toEqual(firstPage.affected[0]!.orderId)
 expect(next.nextCursor).toBeNull()
})
it.each([{ limit: 0 }, { limit: 101 }, { after: 'invalid' }])('rejects invalid pagination %j', async query => {
 await expect(readProductRecall(f.database, CLAIMS, lot, { ...options, ...query })).rejects.toMatchObject({ code: 'invalid_input' })
})
