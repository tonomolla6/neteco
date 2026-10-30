import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { categoryCommandFixture, CATEGORY_CLAIMS, categoryUtc as utc } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleReferralsHttp } from '../../workers/marketing/referrals-http'
import {
  ReferralError,
  attributeD1ReferralOrder,
  enrollD1ReferralAdvocate,
  rejectD1ReferralAttribution,
  settleD1ReferralAttributions
} from '../../workers/marketing/referrals'
import { assessPromoFraud, decidePromoFraudCase, getPromoFraudBenefitGates } from '../../workers/security/promo-fraud'

/**
 * MKT-026 x SEC-036 integrity: identity of the referee comes from the session, orders must belong to the
 * referee, settlement is atomic and withholds benefits under a promotional-fraud hold.
 */
const DAY = 86_400_000
const PEPPER = 'p'.repeat(40)
const cookieConfig = { password: 'synthetic-referral-integrity-secret-32-characters', maxAgeSeconds: 3600 }
const origin = 'https://tienda.neteco.test'
const uuid = (n: number, group = 1) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const customerOf = (n: number) => uuid(n, 3)
let sqlite: DatabaseSync
let database: D1Database
let command = 0
const nextCommand = () => uuid(++command, 9)

function addCustomer(n: number) {
  const past = utc(-30 * DAY)
  sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customerOf(n), past, past)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
    )
    .run(uuid(n, 7), `customer${n}@example.invalid`, past, customerOf(n), past, past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(uuid(n, 8), uuid(n, 7), past, utc(DAY))
}
const claimsOf = (n: number) => ({ identityId: uuid(n, 7), sessionId: uuid(n, 8), sessionVersion: 1 })

/** `ageDays` is how long ago the order was completed (drives the return window). */
function addOrder(
  n: number,
  customer: number,
  ageDays: number,
  status = 'awaiting_payment',
  address = `Calle Unica ${n}`
) {
  const at = utc(-ageDays * DAY)
  const id = uuid(n, 5)
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite
    .prepare(
      `INSERT INTO orders (
        id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id,
        reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
        shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code,
        shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email,
        contact_email_hash, consent_tos, consent_privacy, correlation_id, customer_id, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'EUR',6000,1500,7500,0,0,0,'parcel',1,1,2,?,?,1,1,?,?,?,?)`
    )
    .run(
      id,
      `cart-${n}`,
      `quote-${n}`,
      `ship-${n}`,
      `att-${n}`,
      String(n).padStart(64, '0'),
      status,
      `res-${n}`,
      utc(DAY),
      `customer${customer}@example.invalid`,
      'e'.repeat(64),
      `corr-${n}`,
      customerOf(customer),
      at,
      at
    )
  sqlite
    .prepare(
      `INSERT INTO order_shipping_address(order_id,recipient_name,line1,city,province,postal_code,country_code,phone,created_at)
       VALUES(?,'Destinatario','${address}','Valencia','Valencia','46001','ES','600000000',?)`
    )
    .run(id, at)
  sqlite.exec('PRAGMA foreign_keys = ON')
  return id
}

beforeEach(async () => {
  ;({ sqlite, database } = await categoryCommandFixture())
  for (const file of ['0112_bundles_referrals_events.sql', '0149_category_merchandising_promo_fraud.sql'])
    sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${file}`, import.meta.url), 'utf8'))
  for (const n of [1, 2, 3, 4, 5, 6, 7]) addCustomer(n)
  sqlite
    .prepare(
      `INSERT INTO referral_policies(id,version,is_active,terms_version,reward_cents,referee_discount_cents,min_order_cents,return_window_days,max_referrals_per_advocate,updated_at,updated_by)
       VALUES('global',1,1,'terms-v1',1500,1000,5000,14,10,?,?)`
    )
    .run(utc(-DAY), uuid(1, 7))
  command = 0
})
afterEach(() => sqlite.close())

async function enrolled(n = 1) {
  return (await enrollD1ReferralAdvocate(database, claimsOf(n), { termsVersion: 'terms-v1', now: utc() })).referralCode
}
const attribute = (code: string, referee: number, orderId: string, extra: Record<string, unknown> = {}) =>
  attributeD1ReferralOrder(
    database,
    {
      commandId: nextCommand(),
      idempotencyKey: `idem-${command}-${referee}`,
      referralCode: code,
      refereeCustomerId: customerOf(referee),
      orderId,
      now: utc(),
      ...extra
    },
    { fraudPepper: PEPPER }
  )
const settle = () =>
  settleD1ReferralAttributions(database, CATEGORY_CLAIMS, {
    commandId: nextCommand(),
    idempotencyKey: `idem-settle-${command}`,
    now: utc()
  })
const statusOf = (id: string) =>
  (sqlite.prepare('SELECT status FROM referral_attributions WHERE id=?').get(id) as { status: string }).status

describe('referral attribution is wired to promotional-fraud assessment (SEC-036)', () => {
  it('assesses the referee with server-derived pseudonymised signals and never stores raw data', async () => {
    const code = await enrolled(1)
    const attribution = await attribute(code, 2, addOrder(2, 2, 20))
    const row = sqlite.prepare("SELECT * FROM promo_fraud_cases WHERE context='referral'").get() as {
      ref_id: string
      customer_id: string
      decision: string
    }
    expect(row).toMatchObject({ ref_id: attribution.id, customer_id: customerOf(2), decision: 'clear' })
    const kinds = sqlite.prepare('SELECT kind, signal_hash FROM promo_fraud_signals ORDER BY kind').all() as Array<{
      kind: string
      signal_hash: string
    }>
    expect(kinds.map((signal) => signal.kind)).toEqual(['address', 'identity'])
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM promo_fraud_signals').all())
    expect(stored).not.toContain('customer2@example.invalid')
    expect(stored).not.toContain('Calle Unica 2')
    expect(attribution.status).toBe('pending_window')
  })

  it('fails closed before creating anything when no pepper is configured', async () => {
    const code = await enrolled(1)
    const orderId = addOrder(2, 2, 20)
    await expect(
      attributeD1ReferralOrder(
        database,
        {
          commandId: nextCommand(),
          idempotencyKey: 'idem-no-pepper',
          referralCode: code,
          refereeCustomerId: customerOf(2),
          orderId,
          now: utc()
        },
        { fraudPepper: 'short' }
      )
    ).rejects.toMatchObject({ code: 'security_configuration_missing' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM referral_attributions').get()).toEqual({ n: 0 })
  })

  async function seedSharedFootprint(withIdentity = true) {
    // Others sharing referee 2's normalised e-mail (identity) and, as three other customers, the address.
    const shared = { identity: 'customer2@example.invalid', address: 'Calle Compartida 1, 46001, Valencia' }
    for (const n of [3, 4, 5]) {
      await assessPromoFraud(
        database,
        {
          commandId: nextCommand(),
          context: 'promotion',
          refId: `seed-${n}`,
          customerId: customerOf(n),
          signals: n === 3 && withIdentity ? shared : { address: shared.address }
        },
        { now: utc(-DAY), pepper: PEPPER }
      )
    }
  }

  it('a hold (two independent signals) keeps the attribution pending and withholds the reward', async () => {
    await seedSharedFootprint()
    const code = await enrolled(1)
    const attribution = await attribute(code, 2, addOrder(2, 2, 30, 'awaiting_payment', 'Calle Compartida 1'))
    const gate = (await getPromoFraudBenefitGates(database, 'referral', [attribution.id])).get(attribution.id)
    expect(gate).toMatchObject({ blocked: true, status: 'open' })

    expect(await settle()).toEqual({ settledCount: 0, settledRewardCentsTotal: 0 })
    expect(statusOf(attribution.id)).toBe('pending_window')

    // A human release lets the very same attribution settle.
    const caseId = gate!.caseId!
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      caseId,
      { expectedVersion: 1, outcome: 'release', note: 'Verificado: misma familia' },
      { now: utc() }
    )
    expect(await settle()).toEqual({ settledCount: 1, settledRewardCentsTotal: 1500 })
    expect(statusOf(attribution.id)).toBe('rewarded')
  })

  it('an upheld case never pays', async () => {
    await seedSharedFootprint()
    const code = await enrolled(1)
    const attribution = await attribute(code, 2, addOrder(2, 2, 30, 'awaiting_payment', 'Calle Compartida 1'))
    const gate = (await getPromoFraudBenefitGates(database, 'referral', [attribution.id])).get(attribution.id)!
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      gate.caseId!,
      { expectedVersion: 1, outcome: 'uphold', note: 'Abuso confirmado' },
      { now: utc() }
    )
    expect(await settle()).toEqual({ settledCount: 0, settledRewardCentsTotal: 0 })
    expect(statusOf(attribution.id)).toBe('pending_window')
  })

  it('a single exceeded signal only requests review and does not block settlement', async () => {
    await seedSharedFootprint(false)
    const code = await enrolled(1)
    // Only the address is shared with three others (one exceeded kind).
    const attribution = await attribute(code, 2, addOrder(2, 2, 30, 'awaiting_payment', 'Calle Compartida 1'))
    const gate = (await getPromoFraudBenefitGates(database, 'referral', [attribution.id])).get(attribution.id)
    expect(gate).toMatchObject({ blocked: false, status: 'open' })
    expect(await settle()).toEqual({ settledCount: 1, settledRewardCentsTotal: 1500 })
  })
})

describe('referral settlement is atomic', () => {
  it('two concurrent settlements pay each attribution exactly once', async () => {
    const code = await enrolled(1)
    const a = await attribute(code, 2, addOrder(2, 2, 30))
    const b = await attribute(code, 3, addOrder(3, 3, 30))
    const [first, second] = await Promise.all([settle(), settle()])
    expect(first.settledCount + second.settledCount).toBe(2)
    expect(first.settledRewardCentsTotal + second.settledRewardCentsTotal).toBe(3000)
    expect(statusOf(a.id)).toBe('rewarded')
    expect(statusOf(b.id)).toBe('rewarded')
  })

  it('rejects instead of paying a returned or cancelled order, and leaves the rest pending', async () => {
    const code = await enrolled(1)
    const cancelled = await attribute(code, 2, addOrder(2, 2, 30, 'cancelled'))
    const open = await attribute(code, 3, addOrder(3, 3, 5))
    expect(await settle()).toEqual({ settledCount: 0, settledRewardCentsTotal: 0 })
    expect(statusOf(cancelled.id)).toBe('rejected')
    expect(statusOf(open.id)).toBe('pending_window')
  })

  it('a rewarded attribution cannot be rejected afterwards', async () => {
    const code = await enrolled(1)
    const paid = await attribute(code, 2, addOrder(2, 2, 30))
    await settle()
    await expect(
      rejectD1ReferralAttribution(database, CATEGORY_CLAIMS, {
        commandId: nextCommand(),
        idempotencyKey: 'idem-reject-paid',
        attributionId: paid.id,
        reason: 'late_reason',
        now: utc()
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(statusOf(paid.id)).toBe('rewarded')
  })

  it('requires an MFA-verified administrator for money-moving commands', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_CLAIMS.sessionId)
    await expect(settle()).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      rejectD1ReferralAttribution(database, CATEGORY_CLAIMS, {
        commandId: nextCommand(),
        idempotencyKey: 'idem-reject-nomfa',
        attributionId: uuid(99, 6),
        reason: 'x',
        now: utc()
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('requires a live administrator', async () => {
    await expect(
      settleD1ReferralAttributions(database, claimsOf(2), {
        commandId: nextCommand(),
        idempotencyKey: 'idem-settle-x',
        now: utc()
      })
    ).rejects.toBeInstanceOf(ReferralError)
  })
})

describe('referral HTTP never trusts client identity or time', () => {
  async function call(n: number, path: string, body: unknown, deps: Record<string, unknown> = {}) {
    const issued = await issueD1SessionCookie(database, claimsOf(n), cookieConfig)
    const response = await handleReferralsHttp(
      new Request(origin + path, {
        method: 'POST',
        headers: { cookie: issued!.split(';')[0]!, 'content-type': 'application/json', origin },
        body: JSON.stringify(body)
      }),
      { database, sessionCookieConfiguration: cookieConfig, fraudPepper: PEPPER, ...deps }
    )
    return {
      status: response.status,
      body: (await response.json()) as { attribution: { refereeCustomerId: string }; error: { code: string } }
    }
  }
  const attributeBody = (code: string, orderId: string, extra: Record<string, unknown> = {}) => ({
    commandId: nextCommand(),
    idempotencyKey: `idem-http-${command}`,
    referralCode: code,
    orderId,
    ...extra
  })

  it('ignores a client-supplied refereeCustomerId and uses the session customer', async () => {
    const code = await enrolled(1)
    const mine = addOrder(2, 2, 20)
    const response = await call(2, '/api/account/referrals/attribute', {
      ...attributeBody(code, mine),
      refereeCustomerId: customerOf(3)
    })
    expect(response.status).toBe(201)
    expect(response.body.attribution.refereeCustomerId).toBe(customerOf(2))
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM referral_attributions WHERE referee_customer_id=?').get(customerOf(3))
    ).toEqual({ n: 0 })
  })

  it("refuses to attribute somebody else's order", async () => {
    const code = await enrolled(1)
    const foreign = addOrder(3, 3, 20)
    const response = await call(2, '/api/account/referrals/attribute', attributeBody(code, foreign))
    expect(response.status).toBe(404)
    expect(sqlite.prepare('SELECT count(*) AS n FROM referral_attributions').get()).toEqual({ n: 0 })
  })

  it('answers 503 when the fraud pepper is not configured instead of paying unassessed', async () => {
    const code = await enrolled(1)
    const response = await call(2, '/api/account/referrals/attribute', attributeBody(code, addOrder(2, 2, 20)), {
      fraudPepper: undefined
    })
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe('security_configuration_missing')
    expect(sqlite.prepare('SELECT count(*) AS n FROM referral_attributions').get()).toEqual({ n: 0 })
  })

  it('stamps consent with the server clock, not the client consentedAt', async () => {
    const before = Date.now()
    const response = await call(2, '/api/account/referrals/enroll', {
      termsVersion: 'terms-v1',
      consentedAt: '2020-01-01T00:00:00Z'
    })
    expect(response.status).toBe(200)
    const row = sqlite
      .prepare('SELECT consented_at FROM referral_advocate_enrollments WHERE customer_id=?')
      .get(customerOf(2)) as {
      consented_at: string
    }
    expect(Date.parse(row.consented_at)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
  })
})
