import type { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { refundsCreditFixture, CLAIMS, REASON, utc } from './d1-refunds-credit-fixture'
import type { PromotionRule } from '../../shared/promotions'
import { readRefundContract } from '../../workers/refunds/operations'
import { capturedSource } from '../../workers/refunds/source'
import { queueD1CreditNote, readCreditContract, dispatchD1CreditNotes } from '../../workers/fiscal/credit-notes'
import { creditProviderRequest } from '../../shared/fiscal-credit'
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})
function rule(grossCents: number): PromotionRule {
  return {
    id: crypto.randomUUID(),
    version: 1,
    code: 'REFUND-COUPON',
    status: 'active',
    channel: 'online',
    startsAt: utc(-60000),
    endsAt: null,
    benefit: { kind: 'fixed', grossCents },
    scope: { kind: 'all' },
    segment: 'registered',
    totalLimit: null,
    perCustomerLimit: null,
    volumeMode: 'stack_volume'
  }
}
async function world(discount = 3, shipping = false) {
  const fixture = await refundsCreditFixture({ couponRule: rule(discount), shipping })
  opened.push(fixture.sqlite)
  return fixture
}
it('refunds discounted captured cents deterministically across repeated partials, without over-refunding or changing stock', async () => {
  const f = await world(),
    stock = f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()
  expect(
    f.sqlite
      .prepare(
        'SELECT unit_gross_cents,discount_gross_cents,net_cents,tax_cents,gross_cents FROM order_lines WHERE order_id=?'
      )
      .get(f.orderId)
  ).toEqual({ unit_gross_cents: 500, discount_gross_cents: 3, net_cents: 824, tax_cents: 173, gross_cents: 997 })
  const key = crypto.randomUUID(),
    first = await f.plan(1, key)
  expect(await f.plan(1, key)).toEqual(first)
  await f.confirm(first.id, first.generation, first.contractFingerprint)
  expect(await f.dispatch()).toMatchObject({ completed: 1 })
  const second = await f.completed()
  const contracts = await Promise.all([first.id, second.id].map((id) => readRefundContract(f.database, id)))
  expect(contracts.map((value) => value.contract.components[0])).toMatchObject([
    { quantity: 1, unitOffset: 0, netCents: 412, taxCents: 86, grossCents: 498 },
    { quantity: 1, unitOffset: 1, netCents: 412, taxCents: 87, grossCents: 499 }
  ])
  expect(contracts.reduce((sum, value) => sum + value.contract.amountCents, 0)).toBe(997)
  await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
  expect(f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all()).toEqual(stock)
})
it('credits only the actual discounted refund and preserves the original pre-discount fiscal base', async () => {
  const f = await world(),
    refund = await f.completed(2)
  const queued = await queueD1CreditNote(f.database, CLAIMS, refund.id, {
    idempotencyKey: crypto.randomUUID(),
    policyId: f.creditPolicy.id,
    reason: REASON,
    evidenceRef: 'synthetic-coupon-credit'
  })
  const { contract } = await readCreditContract(f.database, queued.id)
  expect(contract.sourceContract.lines[0]).toMatchObject({
    lineNetCents: 826,
    discountNetCents: 2,
    netCents: 824,
    taxCents: 173,
    grossCents: 997
  })
  expect(contract.amountCents).toBe(997)
  expect(creditProviderRequest(contract).lines[0]).toMatchObject({ lineNetCents: 824, discountNetCents: 0 })
  expect(
    await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
      now: utc(),
      appEnvironment: 'local',
      policyId: f.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    })
  ).toMatchObject({ completed: 1 })
  expect(
    await dispatchD1CreditNotes(f.database, f.creditProvider, f.storage, {
      now: utc(),
      appEnvironment: 'local',
      policyId: f.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    })
  ).toMatchObject({ completed: 0 })
  await expect(f.plan()).rejects.toMatchObject({ code: 'quantity_unavailable' })
})
it('accepts a genuinely free discounted merchandise line while refusing to refund money never charged for it', async () => {
  const f = await world(1000, true)
  const source = await capturedSource(f.database, f.orderId)
  expect(source.lines[0]).toMatchObject({ net_cents: 0, tax_cents: 0, gross_cents: 0 })
  expect(source.capture.capturedCents).toBe(110)
  await expect(f.plan()).rejects.toMatchObject({ code: 'amount_unavailable' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM refund_contracts').get()).toEqual({ n: 0 })
})
