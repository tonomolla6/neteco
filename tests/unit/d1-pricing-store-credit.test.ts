import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pricingFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, OTHER_CLAIMS, key, utc } from './d1-pricing-fixture'
import {
  expireDueStoreCredit,
  freezeStoreCredit,
  getStoreCreditSummary,
  issueStoreCredit,
  reconcileStoreCredit,
  redeemStoreCredit,
  restoreStoreCredit,
  voidStoreCreditGrant
} from '../../workers/pricing/store-credit'
import { STORE_CREDIT_POLICY } from '../../shared/store-credit'
import { testNow, testUuid } from '../support/deterministic'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
})
afterEach(() => vi.useRealTimers())

const issue = (over: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER,
  kind: 'compensation_coupon',
  sourceRef: `case-${testUuid().slice(-8)}`,
  amountCents: 1000,
  expiresInDays: 90,
  reason: 'Compensacion por retraso en entrega',
  ...over
})
type World = Awaited<ReturnType<typeof world>>
async function world() {
  const f = await pricingFixture()
  const orderId = await f.order({ paid: false, delivered: false })
  // Time-travel scenarios (expiry sweeps) must not be cut short by session expiry.
  f.sqlite.prepare('UPDATE auth_sessions SET expires_at = ?').run(utc(400 * 86_400_000))
  const total = (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(orderId) as { t: number }).t
  return { ...f, orderId, total }
}
const grantOf = (f: World, id: string) =>
  f.sqlite.prepare('SELECT * FROM store_credit_grants WHERE id=?').get(id) as Record<string, number | string | null>
const balance = (f: World) =>
  (
    f.sqlite.prepare('SELECT balance_cents b FROM store_credit_accounts WHERE customer_id=?').get(CUSTOMER) as
      { b: number } | undefined
  )?.b

describe('store credit issuance (admin)', () => {
  it('uses distinct source references for separate synthetic grants', () => {
    expect(issue().sourceRef).not.toBe(issue().sourceRef)
  })
  it('issues a grant with expiry, ledger entry, balance, audit and idempotent replay', async () => {
    const f = await world()
    const k = key()
    const input = issue()
    const r = await issueStoreCredit(f.database, CLAIMS, input, k, utc())
    expect(await issueStoreCredit(f.database, CLAIMS, input, k, utc())).toEqual(r)
    expect(balance(f)).toBe(1000)
    const g = grantOf(f, r.result!.grantId as string)
    expect(Date.parse(g.expires_at as string) - Date.parse(g.issued_at as string)).toBe(90 * 86_400_000)
    expect(f.sqlite.prepare('SELECT entry_type, amount_cents FROM store_credit_ledger').all()).toEqual([
      { entry_type: 'issue', amount_cents: 1000 }
    ])
    expect(f.sqlite.prepare("SELECT action, outcome FROM pricing_audit WHERE domain='store_credit'").all()).toEqual([
      { action: 'issue', outcome: 'applied' }
    ])
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
  })
  it('a source can only be credited once, whatever the key', async () => {
    const f = await world()
    const input = issue({ sourceRef: 'refund-123' })
    await issueStoreCredit(f.database, CLAIMS, input, key(), utc())
    await expect(issueStoreCredit(f.database, CLAIMS, input, key(), utc())).rejects.toMatchObject({ code: 'conflict' })
    expect(balance(f)).toBe(1000)
  })
  it('requires live admin authorization and valid input', async () => {
    const f = await world()
    await expect(issueStoreCredit(f.database, OTHER_CLAIMS, issue(), key(), utc())).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(issueStoreCredit(f.database, BUYER_CLAIMS, issue(), key(), utc())).rejects.toMatchObject({
      code: expect.stringMatching(/forbidden|mfa_required/)
    })
    for (const bad of [
      { amountCents: 0 },
      { amountCents: 10.5 },
      { amountCents: -1 },
      { expiresInDays: 1 },
      { reason: 'corto' },
      { customerId: 'x' },
      { extra: 1 }
    ])
      await expect(issueStoreCredit(f.database, CLAIMS, issue(bad), key(), utc())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    await expect(
      issueStoreCredit(f.database, CLAIMS, issue({ customerId: testUuid() }), key(), utc())
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('blocks and audits fraud patterns: single cap, rolling cap, velocity', async () => {
    const f = await world()
    await expect(
      issueStoreCredit(
        f.database,
        CLAIMS,
        issue({ amountCents: STORE_CREDIT_POLICY.maxSingleIssueCents + 1 }),
        key(),
        utc()
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 50_000 }), key(), utc())
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 50_000 }), key(), utc())
    await expect(issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 1 }), key(), utc())).rejects.toMatchObject({
      code: 'limit_reached'
    })
    expect(balance(f)).toBe(100_000)
    expect(
      f.sqlite.prepare("SELECT action, outcome, detail_json FROM pricing_audit WHERE outcome='blocked'").all()
    ).toEqual([{ action: 'issue_blocked', outcome: 'blocked', detail_json: expect.stringContaining('rolling_cap') }])
    const g = await world()
    for (let i = 0; i < STORE_CREDIT_POLICY.maxIssuesPerWindow; i++)
      await issueStoreCredit(g.database, CLAIMS, issue({ amountCents: 1 }), key(), utc())
    await expect(issueStoreCredit(g.database, CLAIMS, issue({ amountCents: 1 }), key(), utc())).rejects.toMatchObject({
      code: 'limit_reached'
    })
  })
  it('a frozen account can neither receive nor spend credit', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue(), key(), utc())
    const version = (f.sqlite.prepare('SELECT version v FROM store_credit_accounts').get() as { v: number }).v
    await freezeStoreCredit(
      f.database,
      CLAIMS,
      { customerId: CUSTOMER, frozen: true, reason: 'Sospecha de fraude en cuenta' },
      version,
      key(),
      utc()
    )
    await expect(issueStoreCredit(f.database, CLAIMS, issue(), key(), utc())).rejects.toMatchObject({
      code: 'account_frozen'
    })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 100 }, key(), utc())
    ).rejects.toMatchObject({ code: 'account_frozen' })
    await expect(
      freezeStoreCredit(
        f.database,
        CLAIMS,
        { customerId: CUSTOMER, frozen: false, reason: 'Revisado sin incidencias' },
        version,
        key(),
        utc()
      )
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })
})

describe('store credit redemption (customer)', () => {
  it('spends earliest-expiring grants first, conserves cents and ties to the order', async () => {
    const f = await world()
    const late = await issueStoreCredit(
      f.database,
      CLAIMS,
      issue({ amountCents: 400, expiresInDays: 365 }),
      key(),
      utc()
    )
    const soon = await issueStoreCredit(
      f.database,
      CLAIMS,
      issue({ amountCents: 300, expiresInDays: 60 }),
      key(),
      utc()
    )
    const amount = Math.min(500, f.total)
    const r = await redeemStoreCredit(
      f.database,
      BUYER_CLAIMS,
      { orderId: f.orderId, amountCents: amount },
      key(),
      utc()
    )
    expect(r.result).toMatchObject({ redeemedCents: amount, balanceCents: 700 - amount })
    expect(grantOf(f, soon.result!.grantId as string).remaining_cents).toBe(0)
    expect(grantOf(f, late.result!.grantId as string).remaining_cents).toBe(400 - (amount - 300))
    expect(balance(f)).toBe(700 - amount)
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
  })
  it('is idempotent for the same key and refuses a different payload under it', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue(), key(), utc())
    const k = key()
    const a = await redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 100 }, k, utc())
    expect(
      await redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 100 }, k, utc())
    ).toEqual(a)
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 101 }, k, utc())
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(balance(f)).toBe(900)
  })
  it('cannot exceed the balance, the order total, or use another customer order', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 200 }), key(), utc())
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 201 }, key(), utc())
    ).rejects.toMatchObject({ code: 'insufficient_credit' })
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 50_000 }), key(), utc())
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: f.total + 1 }, key(), utc())
    ).rejects.toMatchObject({ code: 'overpayment' })
    const guest = await f.order({ owned: false, paid: false, delivered: false })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: guest, amountCents: 10 }, key(), utc())
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: 'missing-order', amountCents: 10 }, key(), utc())
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('the order total caps cumulative redemptions across calls', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 50_000 }), key(), utc())
    await redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: f.total }, key(), utc())
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 1 }, key(), utc())
    ).rejects.toMatchObject({ code: 'overpayment' })
  })
  it('never spends expired or voided credit', async () => {
    const f = await world()
    const a = await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 500 }), key(), utc())
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 100 }, key(), utc(91 * 86_400_000))
    ).rejects.toMatchObject({ code: 'insufficient_credit' })
    await voidStoreCreditGrant(
      f.database,
      CLAIMS,
      { grantId: a.result!.grantId, reason: 'Emitido por error de operador' },
      key(),
      utc()
    )
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 100 }, key(), utc())
    ).rejects.toMatchObject({ code: 'insufficient_credit' })
    expect(balance(f)).toBe(0)
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
  })
  it('identity comes from the session; anonymous or other sessions cannot redeem', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue(), key(), utc())
    await expect(
      redeemStoreCredit(f.database, OTHER_CLAIMS, { orderId: f.orderId, amountCents: 10 }, key(), utc())
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(
      redeemStoreCredit(
        f.database,
        BUYER_CLAIMS,
        { orderId: f.orderId, amountCents: 10, customerId: CUSTOMER },
        key(),
        utc()
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 0 }, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 1.5 }, key(), utc())
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('concurrent redemptions never overspend the balance', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 300 }), key(), utc())
    const orders = [
      f.orderId,
      await f.order({ paid: false, delivered: false }),
      await f.order({ paid: false, delivered: false })
    ]
    const results = await Promise.allSettled(
      orders.map((orderId) => redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId, amountCents: 200 }, key(), utc()))
    )
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(balance(f)).toBe(100)
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
  })
  it('repeated failed redemptions are throttled and audited', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 100 }), key(), utc())
    for (let i = 0; i < 5; i++)
      await expect(
        redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 101 }, key(), utc())
      ).rejects.toMatchObject({ code: 'insufficient_credit' })
    await expect(
      redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 50 }, key(), utc())
    ).rejects.toMatchObject({ code: 'limit_reached' })
    expect(
      (
        f.sqlite
          .prepare("SELECT count(*) c FROM pricing_audit WHERE outcome='blocked' AND action='redeem_blocked'")
          .get() as { c: number }
      ).c
    ).toBeGreaterThanOrEqual(5)
  })
})

describe('store credit lifecycle', () => {
  it('restores the credit of a cancelled order exactly once', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 500 }), key(), utc())
    await redeemStoreCredit(f.database, BUYER_CLAIMS, { orderId: f.orderId, amountCents: 300 }, key(), utc())
    await expect(restoreStoreCredit(f.database, CLAIMS, { orderId: f.orderId }, key(), utc())).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    f.sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(f.orderId)
    const r = await restoreStoreCredit(f.database, CLAIMS, { orderId: f.orderId }, key(), utc())
    expect(r.result).toMatchObject({ restoredCents: 300 })
    expect(balance(f)).toBe(500)
    await expect(restoreStoreCredit(f.database, CLAIMS, { orderId: f.orderId }, key(), utc())).rejects.toMatchObject({
      code: 'not_found'
    })
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, utc())).consistent).toBe(true)
  })
  it('expires due grants once, writing the ledger, without touching live ones', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 400, expiresInDays: 30 }), key(), utc())
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 600, expiresInDays: 400 }), key(), utc())
    const later = utc(31 * 86_400_000)
    expect((await expireDueStoreCredit(f.database, CLAIMS, key(), later)).result).toMatchObject({
      expiredGrants: 1,
      expiredCents: 400
    })
    expect(balance(f)).toBe(600)
    expect((await expireDueStoreCredit(f.database, CLAIMS, key(), later)).result).toMatchObject({ expiredGrants: 0 })
    expect((await reconcileStoreCredit(f.database, CLAIMS, CUSTOMER, later)).consistent).toBe(true)
    await expect(expireDueStoreCredit(f.database, OTHER_CLAIMS, key(), later)).rejects.toMatchObject({
      code: 'forbidden'
    })
  })
  it('the customer sees only spendable balance and own movements', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 400, expiresInDays: 30 }), key(), utc())
    await issueStoreCredit(f.database, CLAIMS, issue({ amountCents: 600, expiresInDays: 400 }), key(), utc())
    const s = await getStoreCreditSummary(f.database, BUYER_CLAIMS, utc())
    expect(s.balanceCents).toBe(1000)
    expect(s.grants).toHaveLength(2)
    expect((await getStoreCreditSummary(f.database, BUYER_CLAIMS, utc(31 * 86_400_000))).balanceCents).toBe(600)
    expect(JSON.stringify(s)).not.toMatch(/issued_by|identity|reason|sourceRef/i)
    await expect(getStoreCreditSummary(f.database, OTHER_CLAIMS, utc())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('ledger and grants are append-only at the database level', async () => {
    const f = await world()
    await issueStoreCredit(f.database, CLAIMS, issue(), key(), utc())
    expect(() => f.sqlite.exec('DELETE FROM store_credit_ledger')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('UPDATE store_credit_ledger SET amount_cents = 5')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('UPDATE store_credit_grants SET amount_cents = 99999')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('UPDATE store_credit_grants SET remaining_cents = 99999')).toThrow(/CHECK/)
  })
})
