import { describe, expect, it } from 'vitest'
import { pricingFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, OTHER_CLAIMS, key, utc } from './d1-pricing-fixture'
import {
  cancelPaymentSchedule,
  createPaymentSchedule,
  getCustomerPaymentSchedule,
  getScheduleReconciliation,
  recordScheduleEntry
} from '../../workers/pricing/payment-schedules'
import { testUuid } from '../support/deterministic'

const TOTAL = 100001
async function world(status = 'approved') {
  const f = await pricingFixture()
  const quoteId = testUuid()
  const at = utc(-30000)
  f.sqlite
    .prepare(
      'INSERT INTO sales_quotes(id,customer_id,current_version,created_by,created_at,updated_at) VALUES(?,?,1,?,?,?)'
    )
    .run(quoteId, CUSTOMER, CLAIMS.identityId, at, at)
  f.sqlite
    .prepare(
      'INSERT INTO sales_quote_versions(quote_id,version,status,snapshot_json,snapshot_hash,actor_id,created_at) VALUES(?,1,?,?,?,?,?)'
    )
    .run(
      quoteId,
      status,
      JSON.stringify({
        id: quoteId,
        version: 1,
        status,
        updatedAt: at,
        total: { netCents: 82645, taxCents: 17356, grossCents: TOTAL }
      }),
      'a'.repeat(64),
      CLAIMS.identityId,
      at
    )
  return { ...f, quoteId }
}
type World = Awaited<ReturnType<typeof world>>
const plan = (over: Record<string, unknown> = {}) => ({
  depositBasisPoints: 3000,
  installments: 2,
  intervalDays: 30,
  ...over
})
const create = (f: World, over: Record<string, unknown> = {}, k = key()) =>
  createPaymentSchedule(f.database, CLAIMS, { quoteId: f.quoteId, ...plan(), ...over }, k, utc())
const entry = (f: World, id: string, body: Record<string, unknown>, version: number, k = key()) =>
  recordScheduleEntry(
    f.database,
    CLAIMS,
    id,
    { externalRef: `ref-${testUuid().slice(-8)}`, ...body },
    version,
    k,
    utc()
  )
const recon = (f: World, id: string) => getScheduleReconciliation(f.database, CLAIMS, id, utc())

describe('payment schedule creation (admin)', () => {
  it('builds the plan from the approved quote total on the server and audits it', async () => {
    const f = await world()
    const r = await create(f)
    const rows = f.sqlite
      .prepare('SELECT seq, kind, due_cents FROM payment_schedule_installments ORDER BY seq')
      .all() as Array<{ due_cents: number }>
    expect(rows.map((x) => x.due_cents).reduce((a, b) => a + b, 0)).toBe(TOTAL)
    expect(rows[0]).toMatchObject({ kind: 'deposit', due_cents: 30000 })
    expect(
      f.sqlite.prepare('SELECT total_gross_cents t, customer_id c, status s FROM payment_schedules').get()
    ).toEqual({ t: TOTAL, c: CUSTOMER, s: 'active' })
    expect(f.sqlite.prepare("SELECT action FROM pricing_audit WHERE domain='payment_schedule'").all()).toEqual([
      { action: 'create' }
    ])
    expect(r.appliedVersion).toBe(1)
  })
  it('is idempotent and refuses key reuse with another payload', async () => {
    const f = await world()
    const k = key()
    const a = await create(f, {}, k)
    expect(await create(f, {}, k)).toEqual(a)
    await expect(create(f, { installments: 3 }, k)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) c FROM payment_schedules').get()).toEqual({ c: 1 })
  })
  it('rejects unapproved/unknown quotes, a second live schedule, client totals and bad plans', async () => {
    const draft = await world('draft')
    await expect(create(draft)).rejects.toMatchObject({ code: 'invalid_transition' })
    const f = await world()
    await expect(
      createPaymentSchedule(f.database, CLAIMS, { quoteId: testUuid(), ...plan() }, key(), utc())
    ).rejects.toMatchObject({ code: 'not_found' })
    await create(f)
    await expect(create(f)).rejects.toMatchObject({ code: 'conflict' })
    for (const bad of [
      { totalGrossCents: 1 },
      { depositBasisPoints: 100 },
      { installments: 0 },
      { intervalDays: 1 },
      { quoteId: 'x' }
    ])
      await expect(create(f, bad)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('requires live administrative authorization', async () => {
    const f = await world()
    await expect(
      createPaymentSchedule(f.database, OTHER_CLAIMS, { quoteId: f.quoteId, ...plan() }, key(), utc())
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      createPaymentSchedule(f.database, BUYER_CLAIMS, { quoteId: f.quoteId, ...plan() }, key(), utc())
    ).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|mfa_required/) })
  })
})

describe('payment schedule ledger', () => {
  async function started() {
    const f = await world()
    const r = await create(f)
    return { f, id: r.targetId }
  }
  it('reconciles due, captured, remaining and invoice state through a full lifecycle', async () => {
    const { f, id } = await started()
    const due = (
      f.sqlite.prepare('SELECT due_cents d FROM payment_schedule_installments ORDER BY seq').all() as Array<{
        d: number
      }>
    ).map((x) => x.d)
    let version = 1
    version = (await entry(f, id, { entryType: 'capture', seq: 1, amountCents: due[0] }, version)).appliedVersion
    version = (await entry(f, id, { entryType: 'invoice', amountCents: due[0] }, version)).appliedVersion
    let r = await recon(f, id)
    expect(r).toMatchObject({
      capturedCents: due[0],
      remainingCents: TOTAL - due[0],
      invoicedCents: due[0],
      toInvoiceCents: 0,
      settled: false,
      consistent: true
    })
    version = (await entry(f, id, { entryType: 'capture', seq: 2, amountCents: due[1] }, version)).appliedVersion
    version = (await entry(f, id, { entryType: 'capture', seq: 3, amountCents: due[2] }, version)).appliedVersion
    r = await recon(f, id)
    expect(r).toMatchObject({ remainingCents: 0, toInvoiceCents: TOTAL - due[0], settled: false })
    version = (await entry(f, id, { entryType: 'invoice', amountCents: TOTAL - due[0] }, version)).appliedVersion
    expect(await recon(f, id)).toMatchObject({ settled: true, toInvoiceCents: 0, creditNoteDueCents: 0 })
    // refund after full invoicing demands a rectifying invoice
    version = (await entry(f, id, { entryType: 'refund', amountCents: 5000 }, version)).appliedVersion
    expect(await recon(f, id)).toMatchObject({ remainingCents: 5000, creditNoteDueCents: 5000, settled: false })
    await entry(f, id, { entryType: 'credit_note', amountCents: 5000 }, version)
    expect(await recon(f, id)).toMatchObject({ creditNoteDueCents: 0, creditedCents: 5000, consistent: true })
    expect(f.sqlite.prepare("SELECT count(*) c FROM pricing_audit WHERE domain='payment_schedule'").get()).toEqual({
      c: 1 + 7
    })
  })
  it('refuses overpayment per installment and in total', async () => {
    const { f, id } = await started()
    await expect(entry(f, id, { entryType: 'capture', seq: 1, amountCents: 30001 }, 1)).rejects.toMatchObject({
      code: 'overpayment'
    })
    await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 30000 }, 1)
    await expect(entry(f, id, { entryType: 'capture', seq: 1, amountCents: 1 }, 2)).rejects.toMatchObject({
      code: 'overpayment'
    })
    expect(f.sqlite.prepare('SELECT count(*) c FROM payment_schedule_ledger').get()).toEqual({ c: 1 })
  })
  it('refund, invoice and credit note are bounded by cash, cash and invoices', async () => {
    const { f, id } = await started()
    await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 30000 }, 1)
    await expect(entry(f, id, { entryType: 'refund', amountCents: 30001 }, 2)).rejects.toMatchObject({
      code: 'overpayment'
    })
    await expect(entry(f, id, { entryType: 'invoice', amountCents: 30001 }, 2)).rejects.toMatchObject({
      code: 'overpayment'
    })
    await expect(entry(f, id, { entryType: 'credit_note', amountCents: 1 }, 2)).rejects.toMatchObject({
      code: 'overpayment'
    })
  })
  it('a provider reference is booked once per type even under a different key', async () => {
    const { f, id } = await started()
    await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 100, externalRef: 'psp-0001' }, 1)
    await expect(
      entry(f, id, { entryType: 'capture', seq: 1, amountCents: 100, externalRef: 'psp-0001' }, 2)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect((await recon(f, id)).capturedCents).toBe(100)
  })
  it('is compare-and-set and idempotent; concurrent writers cannot double-book', async () => {
    const { f, id } = await started()
    const k = key()
    const body = { entryType: 'capture', seq: 1, amountCents: 100, externalRef: 'psp-aaaa' }
    const a = await recordScheduleEntry(f.database, CLAIMS, id, body, 1, k, utc())
    expect(await recordScheduleEntry(f.database, CLAIMS, id, body, 1, k, utc())).toEqual(a)
    await expect(entry(f, id, { entryType: 'capture', seq: 1, amountCents: 5 }, 1)).rejects.toMatchObject({
      code: 'version_conflict'
    })
    const results = await Promise.allSettled(
      [10, 20, 30].map((n) => entry(f, id, { entryType: 'capture', seq: 2, amountCents: n }, 2))
    )
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect((await recon(f, id)).consistent).toBe(true)
  })
  it('validates the entry shape and the authorization', async () => {
    const { f, id } = await started()
    for (const bad of [
      { entryType: 'capture', amountCents: 10 },
      { entryType: 'capture', seq: 9, amountCents: 10 },
      { entryType: 'refund', seq: 1, amountCents: 10 },
      { entryType: 'capture', seq: 1, amountCents: 0 },
      { entryType: 'capture', seq: 1, amountCents: 1.5 },
      { entryType: 'capture', seq: 1, amountCents: 10, externalRef: 'x' },
      { entryType: 'wire', seq: 1, amountCents: 10 },
      { entryType: 'capture', seq: 1, amountCents: 10, due: 1 }
    ])
      await expect(entry(f, id, bad, 1)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      recordScheduleEntry(
        f.database,
        OTHER_CLAIMS,
        id,
        { entryType: 'capture', seq: 1, amountCents: 1, externalRef: 'psp-zzzz' },
        1,
        key(),
        utc()
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(entry(f, testUuid(), { entryType: 'capture', seq: 1, amountCents: 1 }, 1)).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('the database enforces caps and immutability even for raw writes', async () => {
    const { f, id } = await started()
    const cmd = await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 100 }, 1)
    const raw = (type: string, seq: number | null, cents: number) =>
      f.sqlite
        .prepare(
          'INSERT INTO payment_schedule_ledger(schedule_id,seq,entry_type,amount_cents,external_ref,command_id,created_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(id, seq, type, cents, `raw-${testUuid()}`, cmd.commandId, utc())
    expect(() => raw('capture', 1, 30000)).toThrow(/pricing_overpayment/)
    expect(() => raw('refund', null, 101)).toThrow(/pricing_overrefund/)
    expect(() => raw('invoice', null, TOTAL + 1)).toThrow(/pricing_overinvoice/)
    expect(() => raw('credit_note', null, 1)).toThrow(/pricing_overcredit/)
    expect(() => f.sqlite.exec('DELETE FROM payment_schedule_ledger')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('UPDATE payment_schedule_ledger SET amount_cents = 1')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('UPDATE payment_schedule_installments SET due_cents = 1')).toThrow(/immutable/)
  })
})

describe('payment schedule cancellation and customer view', () => {
  it('cancels only when no net cash or invoice remains, and allows a new schedule afterwards', async () => {
    const f = await world()
    const id = (await create(f)).targetId
    await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 30000 }, 1)
    await expect(cancelPaymentSchedule(f.database, CLAIMS, id, 2, key(), utc())).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    await entry(f, id, { entryType: 'refund', amountCents: 30000 }, 2)
    await cancelPaymentSchedule(f.database, CLAIMS, id, 3, key(), utc())
    expect(f.sqlite.prepare('SELECT status s FROM payment_schedules').get()).toEqual({ s: 'cancelled' })
    await expect(entry(f, id, { entryType: 'capture', seq: 1, amountCents: 1 }, 4)).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    expect((await create(f)).appliedVersion).toBe(1)
  })
  it('the customer sees own schedule amounts only, never provider references', async () => {
    const f = await world()
    const id = (await create(f)).targetId
    await entry(f, id, { entryType: 'capture', seq: 1, amountCents: 30000, externalRef: 'psp-secret-123' }, 1)
    const v = await getCustomerPaymentSchedule(f.database, BUYER_CLAIMS, f.quoteId, utc())
    expect(v).toMatchObject({ dueCents: TOTAL, capturedCents: 30000, remainingCents: TOTAL - 30000 })
    expect(v.installments).toHaveLength(3)
    expect(JSON.stringify(v)).not.toMatch(/psp-secret|command|actor|identity/i)
    await expect(getCustomerPaymentSchedule(f.database, OTHER_CLAIMS, f.quoteId, utc())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    await expect(getCustomerPaymentSchedule(f.database, BUYER_CLAIMS, testUuid(), utc())).rejects.toMatchObject({
      code: 'not_found'
    })
  })
})
