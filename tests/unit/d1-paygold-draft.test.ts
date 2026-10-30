import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addOtherCustomer, payExtFixture, redsysConfig, signedEnvelope, utc } from './pay-ext-fixture'
import { BUYER_CLAIMS, CLAIMS, CUSTOMER } from './d1-returns-fixture'
import { createFakePayGoldService } from './paygold-fake-fixture'
import { configuredPayGoldDraftIssue } from '../../workers/payments/paygold-runtime'
import { processRedsysNotification } from '../../workers/catalog/payments'

const PROVIDER = 'https://paygold.example.invalid'
let f: Awaited<ReturnType<typeof payExtFixture>>
let service: ReturnType<typeof createFakePayGoldService>
let calls = 0
beforeEach(async () => {
  f = await payExtFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', 'utf8'))
  service = createFakePayGoldService(PROVIDER)
  calls = 0
})
afterEach(() => f?.sqlite.close())

const issue = () =>
  configuredPayGoldDraftIssue(
    {
      DB: f.database,
      PAYGOLD_ENABLED: 'true',
      PAYGOLD_PROVIDER_ORIGIN: PROVIDER,
      PAYGOLD_SERVICE: {
        fetch: async (request: Request) => {
          calls += 1
          return service.fetch(request)
        }
      }
    },
    redsysConfig,
    () => utc()
  )!

async function draftFor(
  over: { owner?: typeof BUYER_CLAIMS | null; draftCustomer?: string; total?: number; status?: string } = {}
) {
  const order = await f.unpaid(over.owner === undefined ? BUYER_CLAIMS : over.owner)
  const row = f.sqlite
    .prepare('SELECT total_gross_cents t, customer_id c FROM orders WHERE id=?')
    .get(order.orderId) as { t: number; c: string | null }
  const draftId = crypto.randomUUID()
  f.sqlite
    .prepare(
      `INSERT INTO draft_orders(id,draft_number,customer_id,company_name,contact_email,status,total_cents,subtotal_cents,items_json,expires_at,
         converted_order_id,version,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,'[]',?,?,3,?,?,?)`
    )
    .run(
      draftId,
      `DRF-${draftId.slice(0, 8)}`,
      over.draftCustomer ?? row.c ?? CUSTOMER,
      'Synthetic Co',
      'buyer@example.invalid',
      over.status ?? 'converted',
      over.total ?? row.t,
      over.total ?? row.t,
      utc(86_400_000),
      order.orderId,
      CLAIMS.identityId,
      utc(-30_000),
      utc(-30_000)
    )
  return { ...order, draftId, total: row.t }
}
const input = (d: { draftId: string; orderId: string; token: string }, over: Record<string, unknown> = {}) => ({
  draftId: d.draftId,
  expectedVersion: 3,
  orderId: d.orderId,
  orderToken: d.token,
  commandId: crypto.randomUUID(),
  expiresAt: utc(20 * 60_000),
  ...over
})

describe('PayGold link for a converted draft order', () => {
  it('issues an expirable link for the canonical order amount, bound to the draft', async () => {
    const d = await draftFor()
    const receipt = await issue()(BUYER_CLAIMS, input(d))
    expect(receipt).toMatchObject({ draftId: d.draftId, orderId: d.orderId, amountCents: d.total })
    expect(receipt.url.startsWith(`${PROVIDER}/link/`)).toBe(true)
    expect(f.sqlite.prepare('SELECT quote_id,amount_cents,expires_at FROM paygold_commands').get()).toMatchObject({
      quote_id: `draft:${d.draftId}`,
      amount_cents: d.total
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_audit').get()).toMatchObject({ n: 1 })
    expect(service.redeem(receipt.url, utc())).not.toBeNull()
    expect(service.redeem(receipt.url, utc(21 * 60_000))).toBeNull()
  })
  it('reconciles the signed notification exactly like checkout', async () => {
    const d = await draftFor()
    await issue()(BUYER_CLAIMS, input(d))
    const intent = f.sqlite.prepare('SELECT merchant_order m, amount_gross_cents a FROM payment_intents').get() as {
      m: string
      a: number
    }
    expect(intent.a).toBe(d.total)
    const wrong = await processRedsysNotification(
      f.database,
      await signedEnvelope(intent.m, intent.a - 1),
      redsysConfig,
      { correlationId: 'x', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(wrong.outcome).toBe('mismatch')
    const ok = await processRedsysNotification(
      f.database,
      await signedEnvelope(intent.m, intent.a),
      redsysConfig,
      { correlationId: 'x', now: utc() },
      { assign: f.inventory.assign }
    )
    expect(ok.outcome).toBe('captured')
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(d.orderId)).toMatchObject({
      status: 'paid'
    })
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'assigned' })
  })
  it('is idempotent: same command returns the same link, one provider creation, one audit row', async () => {
    const d = await draftFor()
    const body = input(d)
    const first = await issue()(BUYER_CLAIMS, body)
    const second = await issue()(BUYER_CLAIMS, body)
    expect(second.url).toBe(first.url)
    expect(second.paymentIntentId).toBe(first.paymentIntentId)
    expect(calls).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_audit').get()).toMatchObject({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 1 })
  })
  it('conflicts when the command is reused with another payload or a second command targets the same order', async () => {
    const d = await draftFor()
    const body = input(d)
    await issue()(BUYER_CLAIMS, body)
    await expect(issue()(BUYER_CLAIMS, { ...body, expiresAt: utc(10 * 60_000) })).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(issue()(BUYER_CLAIMS, input(d))).rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toBe(1)
  })
  it('serialises concurrent identical commands into a single provider call', async () => {
    const d = await draftFor()
    const body = input(d)
    const results = await Promise.allSettled([issue()(BUYER_CLAIMS, body), issue()(BUYER_CLAIMS, body)])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_commands').get()).toMatchObject({ n: 1 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 1 })
  })
  it('refuses a draft whose claimed total differs from the canonical order total', async () => {
    const d = await draftFor({ total: 1 })
    await expect(issue()(BUYER_CLAIMS, input(d))).rejects.toMatchObject({ code: 'not_payable' })
    expect(calls).toBe(0)
    expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_attempts').get()).toMatchObject({ n: 0 })
  })
  it('refuses unconverted drafts, a stale draft version and a draft of another customer', async () => {
    const pending = await draftFor({ status: 'approved' })
    await expect(issue()(BUYER_CLAIMS, input(pending))).rejects.toMatchObject({ code: 'not_payable' })
    const d = await draftFor()
    await expect(issue()(BUYER_CLAIMS, input(d, { expectedVersion: 2 }))).rejects.toMatchObject({ code: 'not_payable' })
    const other = addOtherCustomer(f.sqlite)
    const foreign = await draftFor({ draftCustomer: other.customer })
    await expect(issue()(BUYER_CLAIMS, input(foreign))).rejects.toMatchObject({ code: 'not_payable' })
    expect(calls).toBe(0)
  })
  it('refuses an order that belongs to someone else or a guest order, and a wrong order credential', async () => {
    const other = addOtherCustomer(f.sqlite)
    const theirs = await draftFor({ owner: other.claims })
    await expect(issue()(BUYER_CLAIMS, input(theirs))).rejects.toBeDefined()
    const guest = await draftFor({ owner: null })
    await expect(issue()(BUYER_CLAIMS, input(guest))).rejects.toBeDefined()
    const mine = await draftFor()
    await expect(issue()(BUYER_CLAIMS, input(mine, { orderToken: 'b'.repeat(64) }))).rejects.toBeDefined()
    expect(calls).toBe(0)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('requires a live customer session and valid, bounded expiry', async () => {
    const d = await draftFor()
    await expect(issue()(null, input(d))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(issue()(BUYER_CLAIMS, input(d, { expiresAt: utc(-1000) }))).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(issue()(BUYER_CLAIMS, input(d, { expiresAt: utc(86_400_000) }))).rejects.toMatchObject({
      code: 'not_payable'
    })
    await expect(issue()(BUYER_CLAIMS, input(d, { amountCents: 1 }))).rejects.toMatchObject({ code: 'invalid_input' })
    f.sqlite.exec('UPDATE auth_sessions SET revoked_at=created_at')
    await expect(issue()(BUYER_CLAIMS, input(d))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(calls).toBe(0)
  })
  it('refuses an order already paid, or held by a pre-authorisation', async () => {
    const paid = await draftFor()
    f.sqlite
      .prepare("INSERT INTO order_payment_states(order_id,status,paid_gross_cents,updated_at) VALUES(?,'paid',?,?)")
      .run(paid.orderId, paid.total, utc())
    await expect(issue()(BUYER_CLAIMS, input(paid))).rejects.toMatchObject({ code: 'not_payable' })
    const held = await draftFor()
    f.sqlite
      .prepare(
        `INSERT INTO payment_preauths(id,order_id,merchant_order,amount_cents,reason_code,justification,requested_by,status,version,redirect_expires_at,created_at,updated_at)
         VALUES(?,?,'7777ABCDEFGH',?,'made_to_order','Made to order item needs confirmation',?, 'requested',1,?,?,?)`
      )
      .run(crypto.randomUUID(), held.orderId, held.total, CLAIMS.identityId, utc(60_000), utc(), utc())
    await expect(issue()(BUYER_CLAIMS, input(held))).rejects.toMatchObject({ code: 'not_payable' })
    expect(calls).toBe(0)
  })
  it('resumes after an uncertain provider answer with the same provider idempotency key', async () => {
    const d = await draftFor()
    const body = input(d)
    let failOnce = true
    const flaky = configuredPayGoldDraftIssue(
      {
        DB: f.database,
        PAYGOLD_ENABLED: 'true',
        PAYGOLD_PROVIDER_ORIGIN: PROVIDER,
        PAYGOLD_SERVICE: {
          fetch: async (request: Request) => {
            const response = await service.fetch(request.clone())
            if (failOnce) {
              failOnce = false
              return new Response(null, { status: 502 })
            }
            return response
          }
        }
      },
      redsysConfig,
      () => utc()
    )!
    await expect(flaky(BUYER_CLAIMS, body)).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM paygold_attempts').get()).toMatchObject({ n: 1 })
    const receipt = await flaky(BUYER_CLAIMS, body)
    expect(receipt.amountCents).toBe(d.total)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 1 })
  })
})
