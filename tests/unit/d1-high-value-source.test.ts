import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { assertHighValueEventSource } from '../../workers/communications/high-value-source'
import { executeProductRecall } from '../../workers/catalog/product-recall'
import { testUuid } from '../support/deterministic'
let f: Awaited<ReturnType<typeof returnsFixture>>
const security = '11111111-1111-4111-8111-111111111111',
  recall = '22222222-2222-4222-8222-222222222222',
  lot = '33333333-3333-4333-8333-333333333333',
  opts = { now: () => utc() }
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'password_changed',?)"
    )
    .run(security, BUYER_CLAIMS.identityId, utc())
})
afterEach(() => f?.sqlite.close())
it('recognises a security event belonging to the customer without returning PII', async () => {
  expect(
    await assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, { event: 'security_alert', eventId: security }, opts)
  ).toEqual({ eligible: true })
})
it('rejects a missing event, different customer or mismatched type', async () => {
  await expect(
    assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, { event: 'recall', eventId: security }, opts)
  ).rejects.toMatchObject({ code: 'event_unavailable' })
  await expect(
    assertHighValueEventSource(
      f.database,
      CLAIMS,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { event: 'security_alert', eventId: security },
      opts
    )
  ).rejects.toMatchObject({ code: 'not_found' })
})
it('identifies a customer with an allocated line in an open recall', async () => {
  const order = await f.order({ paid: false, delivered: false })
  // An open recall now removes real sellable stock, so the second customer order must exist beforehand.
  const other = await f.order({ paid: false, delivered: false })
  const loc = (
    f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
      location_id: string
    }
  ).location_id
  f.sqlite
    .prepare(
      "INSERT INTO inventory_lots(id,variant_id,lot_number,location_id,status,expires_at,initial_quantity,available_quantity,version,created_at,updated_at) VALUES(?,?,'event-lot',?,'active',?,10,8,1,?,?)"
    )
    .run(lot, 'v-1-1', loc, utc(86400000), utc(), utc())
  f.sqlite
    .prepare(
      'INSERT INTO inventory_lot_allocations(id,lot_id,order_id,order_line_index,customer_id,quantity,correlation_id,created_at) VALUES(?,?,?,0,?,2,?,?)'
    )
    .run(testUuid(), lot, order, CUSTOMER, 'synthetic', utc())
  await executeProductRecall(
    f.database,
    CLAIMS,
    lot,
    recall,
    { action: 'open', expectedVersion: 0, evidence: 'case-recall-123' },
    opts
  )
  expect(
    await assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, { event: 'recall', eventId: recall }, opts)
  ).toEqual({ eligible: true })
  await executeProductRecall(
    f.database,
    CLAIMS,
    lot,
    '44444444-4444-4444-8444-444444444444',
    {
      action: 'trace',
      expectedVersion: 1,
      evidence: 'trace-case-123',
      orderId: other,
      lineIndex: 0,
      targetLotId: lot,
      quantity: 2
    },
    opts
  )
  expect(
    await assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, { event: 'recall', eventId: recall }, opts)
  ).toEqual({ eligible: true })
  expect(
    f.sqlite
      .prepare(
        "SELECT count(DISTINCT customer_id) n FROM high_value_event_sources WHERE event_type='recall' AND event_id=? AND customer_id=?"
      )
      .get(recall, CUSTOMER)
  ).toEqual({ n: 1 })
})
it('requires live administrative authority', async () => {
  await expect(
    assertHighValueEventSource(f.database, BUYER_CLAIMS, CUSTOMER, { event: 'security_alert', eventId: security }, opts)
  ).rejects.toMatchObject({ code: 'mfa_required' })
})
it.each([
  { event: 'marketing', eventId: security },
  { event: 'security_alert', eventId: 'bad' },
  { event: 'security_alert', eventId: security, recipient: 'someone' }
])('rejects untrusted input %j', async (raw) => {
  await expect(assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, raw, opts)).rejects.toMatchObject({
    code: 'invalid_input'
  })
})
it('accepts native 32-hex identity security event identifiers', async () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  f.sqlite
    .prepare(
      "INSERT INTO identity_security_events(id,identity_id,event_type,created_at) VALUES(?,?,'password_changed',?)"
    )
    .run(id, BUYER_CLAIMS.identityId, utc())
  expect(
    await assertHighValueEventSource(f.database, CLAIMS, CUSTOMER, { event: 'security_alert', eventId: id }, opts)
  ).toEqual({ eligible: true })
})
