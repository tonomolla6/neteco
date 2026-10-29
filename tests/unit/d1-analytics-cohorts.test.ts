import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, CLAIMS } from './d1-analytics-fixture'
import { readCohortsAnalytics } from '../../workers/analytics/cohorts'
import { handleCohortsAnalyticsHttp } from '../../workers/analytics/cohorts-http'
import type { AnalyticsHttpDependencies } from '../../workers/analytics/http'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})

async function setupCohortsFixture(options: { now?: string } = {}) {
  const world = await analyticsFixture({ commerce: true, refund: true })
  connections.push(world.sqlite)

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0099_analytics_cohorts.sql', import.meta.url),
    'utf8'
  )
  world.sqlite.exec(migrationSql)

  if (options.now) {
    world.setNow(options.now)
    // Keep auth session and identity valid for the test's now
    const past = new Date(Date.parse(options.now) - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const future = new Date(Date.parse(options.now) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    world.sqlite.prepare(`UPDATE auth_sessions SET created_at = ?, expires_at = ?`).run(past, future)
    world.sqlite
      .prepare(`UPDATE identities SET created_at = ?, updated_at = ?, email_verified_at = ?`)
      .run(past, past, past)
    world.sqlite.prepare(`UPDATE identity_roles SET granted_at = ?`).run(past)
    if (world.deps.policy) {
      world.deps.policy = {
        ...world.deps.policy,
        approvedAt: past
      }
    }
  }

  // Helper to insert an order directly into D1/SQLite for fast, granular scenario testing
  function insertOrder(params: {
    id: string
    customerId?: string | null
    emailHash: string
    grossCents: number
    createdAt: string
    paymentStatus?: 'paid' | 'awaiting_payment' | 'cancelled' | 'failed'
    orderStatus?: 'awaiting_payment' | 'cancelled'
    buyerCompanyName?: string | null
    buyerTaxId?: string | null
    categoryId?: string
    refundedGrossCents?: number
  }) {
    const paymentStatus = params.paymentStatus ?? 'paid'
    const orderStatus = params.orderStatus ?? 'awaiting_payment'
    const catId = params.categoryId ?? 'cat-general'

    // Ensure tax class and location exist
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from, created_at) VALUES ('standard', 'STD', 'Standard', 2100, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`
      )
      .run()
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO inventory_locations (id, code, name, kind, active, created_at) VALUES ('main', 'MAIN', 'Warehouse', 'warehouse', 1, '2020-01-01T00:00:00Z')`
      )
      .run()

    // Ensure category exists
    world.sqlite
      .prepare(`INSERT OR IGNORE INTO categories(id, name, slug) VALUES(?, ?, ?)`)
      .run(catId, `Categoria ${catId}`, `categoria-${catId}`)

    // Ensure product and variant exist
    const prodId = `prod-${catId}`
    const varId = `var-${catId}`
    const sku = `SKU-${catId}`
    world.sqlite
      .prepare(`INSERT OR IGNORE INTO products(id, category_id, name, slug) VALUES(?, ?, ?, ?)`)
      .run(prodId, catId, `Producto ${prodId}`, `prod-${prodId}`)

    const shipProfile = world.sqlite.prepare(`SELECT id FROM shipping_profiles LIMIT 1`).get() as
      { id: string } | undefined
    const shipProfileId = shipProfile?.id ?? 'sp-1'
    world.sqlite
      .prepare(`INSERT OR IGNORE INTO shipping_profiles(id, code, name, kind) VALUES(?, 'STD', 'Standard', 'parcel')`)
      .run(shipProfileId)

    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO variants(id, product_id, tax_class_id, shipping_profile_id, sku, format, price_gross_cents)
         VALUES(?, ?, 'standard', ?, ?, 'unit', ?)`
      )
      .run(varId, prodId, shipProfileId, sku, params.grossCents)

    // Insert dummy cart, quotes, attempt for FK constraints
    const dummyId = `dm-${params.id}`
    const tokenHash = Buffer.from(params.id).toString('hex').padStart(64, '0').slice(-64)
    const expiresAt = new Date(Date.parse(params.createdAt) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES(?, ?, 'active', 1, ?, 'corr-1', ?, ?)`
      )
      .run(dummyId, tokenHash, expiresAt, params.createdAt, params.createdAt)
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
         VALUES(?, ?, 1, ?, 'EUR', 0, 1, ?, 0, ?, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, params.createdAt, params.grossCents, params.grossCents, tokenHash, params.createdAt)
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
         VALUES(?, ?, 1, ?, '[]', 0, ?, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, tokenHash, tokenHash, expiresAt, params.createdAt)
    world.sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
         VALUES(?, ?, 'key-1', 'failed', 'corr-1', ?, ?, ?)`
      )
      .run(dummyId, dummyId, tokenHash, params.createdAt, params.createdAt)

    world.sqlite
      .prepare(
        `INSERT INTO orders(
           id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
           reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
           shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version,
           shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy,
           correlation_id, created_at, updated_at, customer_id, buyer_company_name, buyer_tax_id
         ) VALUES(
           ?, ?, ?, ?, ?, ?, ?, 'res-1', ?, 'EUR', ?, 0, ?,
           0, 0, 0, 'standard', 1, 1, 3, 'user@example.test', ?, 1, 1,
           'corr-1', ?, ?, ?, ?, ?
         )`
      )
      .run(
        params.id,
        dummyId,
        dummyId,
        dummyId,
        dummyId,
        tokenHash,
        orderStatus,
        params.createdAt,
        params.grossCents,
        params.grossCents,
        params.emailHash,
        params.createdAt,
        params.createdAt,
        params.customerId ?? null,
        params.buyerCompanyName ?? null,
        params.buyerTaxId ?? null
      )

    // Insert order line
    world.sqlite
      .prepare(
        `INSERT INTO order_lines(
           order_id, line_index, variant_id, sku, name, quantity, unit_gross_cents, net_cents, tax_cents, gross_cents,
           tax_rate_basis_points, price_version_id, location_id, created_at
         ) VALUES(?, 0, ?, 'SKU-1', 'Producto Test', 1, ?, ?, 0, ?, 0, 'pv-1', 'loc-main', ?)`
      )
      .run(params.id, varId, params.grossCents, params.grossCents, params.grossCents, params.createdAt)

    // Insert order payment state
    world.sqlite
      .prepare(
        `INSERT INTO order_payment_states(order_id, status, paid_gross_cents, updated_at)
         VALUES(?, ?, ?, ?)`
      )
      .run(params.id, paymentStatus, paymentStatus === 'paid' ? params.grossCents : 0, params.createdAt)

    // If refund is requested, insert into refund_contracts & refund_work
    if (params.refundedGrossCents && params.refundedGrossCents > 0) {
      world.sqlite.exec('DROP TRIGGER IF EXISTS refund_contract_source')
      world.sqlite.exec('PRAGMA foreign_keys = OFF')
      const refundId = `00000000-0000-4000-8000-${params.id.slice(0, 12).padStart(12, '0')}`
      const dummyIntentId = `pi-${params.id}`
      const dummyReturnId = `ret-${params.id}`
      const dummyPolicyId = `pol-${params.id}`
      const dummyIdentity = '00000000-0000-4000-8000-000000000001'

      world.sqlite
        .prepare(
          `INSERT OR IGNORE INTO payment_intents(id, order_id, provider, merchant_order, method, status, amount_gross_cents, currency, request_hash, redirect_envelope_hash, expires_at, correlation_id, created_at, updated_at)
        VALUES(?, ?, 'redsys', ?, 'card', 'captured', ?, 'EUR', ?, ?, ?, 'corr', ?, ?)`
        )
        .run(
          dummyIntentId,
          params.id,
          `ord${params.id.slice(0, 8)}`,
          params.grossCents,
          'b'.repeat(64),
          'c'.repeat(64),
          params.createdAt,
          params.createdAt,
          params.createdAt
        )

      world.sqlite
        .prepare(
          `INSERT INTO refund_contracts(id, order_id, payment_intent_id, return_id, return_version, policy_id, planned_by, contract_json, contract_fingerprint, idempotency_key, amount_gross_cents, validation_only, created_at)
        VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(
          refundId,
          params.id,
          dummyIntentId,
          dummyReturnId,
          dummyPolicyId,
          dummyIdentity,
          JSON.stringify({
            refundId,
            orderId: params.id,
            returnId: dummyReturnId,
            returnVersion: 1,
            policyId: dummyPolicyId,
            capture: { paymentIntentId: dummyIntentId },
            amountCents: params.refundedGrossCents,
            validationOnly: 0,
            idempotencyKey: `idem-${refundId}`,
            currency: 'EUR'
          }),
          'd'.repeat(64),
          `idem-${refundId}`,
          params.refundedGrossCents,
          params.createdAt
        )

      world.sqlite
        .prepare(
          `INSERT INTO refund_work(refund_id, status, generation, attempts, confirmed_by, confirmed_at, submitted_at, completed_at)
        VALUES(?, 'completed', 1, 1, ?, ?, ?, ?)`
        )
        .run(refundId, dummyIdentity, params.createdAt, params.createdAt, params.createdAt)
      world.sqlite.exec('PRAGMA foreign_keys = ON')
    }
  }

  return { ...world, insertOrder }
}

describe('DAT-014 Customer repetition cohorts and lifecycle', () => {
  it('correctly aggregates cohort by first purchase month and computes 30/60/90/180-day repeat rates', async () => {
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps, insertOrder } = fixture

    // Customer 1: First purchase 2026-01-10. Second purchase 2026-01-25 (15 days later, <= 30d)
    const email1 = '1'.repeat(64)
    insertOrder({ id: 'ord-1-1', emailHash: email1, grossCents: 5000, createdAt: '2026-01-10T10:00:00Z' })
    insertOrder({ id: 'ord-1-2', emailHash: email1, grossCents: 6000, createdAt: '2026-01-25T10:00:00Z' })

    // Customer 2: First purchase 2026-01-15. Second purchase 2026-02-25 (41 days later, >30d and <=60d)
    const email2 = '2'.repeat(64)
    insertOrder({ id: 'ord-2-1', emailHash: email2, grossCents: 4000, createdAt: '2026-01-15T10:00:00Z' })
    insertOrder({ id: 'ord-2-2', emailHash: email2, grossCents: 4500, createdAt: '2026-02-25T10:00:00Z' })

    // Customer 3: First purchase 2026-01-20. Second purchase 2026-04-10 (80 days later, >60d and <=90d)
    const email3 = '3'.repeat(64)
    insertOrder({ id: 'ord-3-1', emailHash: email3, grossCents: 8000, createdAt: '2026-01-20T10:00:00Z' })
    insertOrder({ id: 'ord-3-2', emailHash: email3, grossCents: 9000, createdAt: '2026-04-10T10:00:00Z' })

    // Customer 4: First purchase 2026-01-22. Second purchase 2026-06-01 (130 days later, >90d and <=180d)
    const email4 = '4'.repeat(64)
    insertOrder({ id: 'ord-4-1', emailHash: email4, grossCents: 3000, createdAt: '2026-01-22T10:00:00Z' })
    insertOrder({ id: 'ord-4-2', emailHash: email4, grossCents: 3500, createdAt: '2026-06-01T10:00:00Z' })

    // Customer 5: First purchase 2026-01-25. No second purchase.
    const email5 = '5'.repeat(64)
    insertOrder({ id: 'ord-5-1', emailHash: email5, grossCents: 7000, createdAt: '2026-01-25T10:00:00Z' })

    const result = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z',
      churnDays: 90
    })

    expect(result.definitionVersion).toBe('2026-10-v1')
    expect(result.definitions).toHaveProperty('cohort')
    expect(result.definitions).toHaveProperty('validOrders')
    expect(result.definitions).toHaveProperty('churn')

    const cohortJan = result.cohorts.find((c) => c.cohort === '2026-01')
    expect(cohortJan).toBeDefined()
    expect(cohortJan!.size).toBe(5)

    // Repeat at 30 days: only Customer 1 (1 / 5 = 20%)
    expect(cohortJan!.repeat30Days.count).toBe(1)
    expect(cohortJan!.repeat30Days.rate).toBeCloseTo(0.2, 2)

    // Repeat at 60 days: Customer 1 & 2 (2 / 5 = 40%)
    expect(cohortJan!.repeat60Days.count).toBe(2)
    expect(cohortJan!.repeat60Days.rate).toBeCloseTo(0.4, 2)

    // Repeat at 90 days: Customer 1, 2, 3 (3 / 5 = 60%)
    expect(cohortJan!.repeat90Days.count).toBe(3)
    expect(cohortJan!.repeat90Days.rate).toBeCloseTo(0.6, 2)

    // Repeat at 180 days: Customer 1, 2, 3, 4 (4 / 5 = 80%)
    expect(cohortJan!.repeat180Days.count).toBe(4)
    expect(cohortJan!.repeat180Days.rate).toBeCloseTo(0.8, 2)
  })

  it('calculates median days to second purchase with even and odd counts', async () => {
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps, insertOrder } = fixture

    // 3 repeating customers with intervals: 10 days, 20 days, 60 days -> median is 20 days
    const emailA = 'a'.repeat(64)
    insertOrder({ id: 'ord-a-1', emailHash: emailA, grossCents: 2000, createdAt: '2026-02-01T10:00:00Z' })
    insertOrder({ id: 'ord-a-2', emailHash: emailA, grossCents: 2000, createdAt: '2026-02-11T10:00:00Z' }) // 10 days

    const emailB = 'b'.repeat(64)
    insertOrder({ id: 'ord-b-1', emailHash: emailB, grossCents: 2000, createdAt: '2026-02-01T10:00:00Z' })
    insertOrder({ id: 'ord-b-2', emailHash: emailB, grossCents: 2000, createdAt: '2026-02-21T10:00:00Z' }) // 20 days

    const emailC = 'c'.repeat(64)
    insertOrder({ id: 'ord-c-1', emailHash: emailC, grossCents: 2000, createdAt: '2026-02-01T10:00:00Z' })
    insertOrder({ id: 'ord-c-2', emailHash: emailC, grossCents: 2000, createdAt: '2026-04-02T10:00:00Z' }) // 60 days

    const resOdd = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-02-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z'
    })
    const febCohort = resOdd.cohorts.find((c) => c.cohort === '2026-02')
    expect(febCohort?.medianDaysToRepurchase).toBe(20)

    // Add 4th customer with interval: 40 days -> intervals [10, 20, 40, 60] -> median is (20 + 40) / 2 = 30 days
    const emailD = 'd'.repeat(64)
    insertOrder({ id: 'ord-d-1', emailHash: emailD, grossCents: 2000, createdAt: '2026-02-01T10:00:00Z' })
    insertOrder({ id: 'ord-d-2', emailHash: emailD, grossCents: 2000, createdAt: '2026-03-13T10:00:00Z' }) // 40 days

    const resEven = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-02-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z'
    })
    const febCohortEven = resEven.cohorts.find((c) => c.cohort === '2026-02')
    expect(febCohortEven?.medianDaysToRepurchase).toBe(30)
  })

  it('strictly excludes cancelled orders, unpaid orders and fully refunded orders', async () => {
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps, insertOrder } = fixture

    // Customer with ONLY cancelled order -> should not exist in cohorts
    const emailCancelled = 'e'.repeat(64)
    insertOrder({
      id: 'ord-canc-1',
      emailHash: emailCancelled,
      grossCents: 5000,
      createdAt: '2026-03-01T10:00:00Z',
      orderStatus: 'cancelled',
      paymentStatus: 'cancelled'
    })

    // Customer with ONLY unpaid order -> should not exist in cohorts
    const emailUnpaid = 'f'.repeat(64)
    insertOrder({
      id: 'ord-unpaid-1',
      emailHash: emailUnpaid,
      grossCents: 5000,
      createdAt: '2026-03-02T10:00:00Z',
      paymentStatus: 'awaiting_payment'
    })

    // Customer with fully refunded order (refund >= total_gross_cents) -> excluded!
    const emailRefunded = '10'.repeat(32)
    insertOrder({
      id: 'ord-refund-full',
      emailHash: emailRefunded,
      grossCents: 5000,
      refundedGrossCents: 5000,
      createdAt: '2026-03-03T10:00:00Z'
    })

    // Customer with PARTIAL refund (refund < total_gross_cents) -> remains valid!
    const emailPartialRefund = '11'.repeat(32)
    insertOrder({
      id: 'ord-refund-partial',
      emailHash: emailPartialRefund,
      grossCents: 5000,
      refundedGrossCents: 2000,
      createdAt: '2026-03-04T10:00:00Z'
    })

    const res = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-31T23:59:59Z'
    })
    const marchCohort = res.cohorts.find((c) => c.cohort === '2026-03')
    expect(marchCohort).toBeDefined()
    // Only emailPartialRefund should be in the cohort
    expect(marchCohort?.size).toBe(1)
  })

  it('correctly calculates churn with configurable churnDays', async () => {
    // Current time is 2026-10-29T12:00:00Z
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps, insertOrder } = fixture

    // Customer Active: bought 2026-04-01 and again 2026-09-15 (44 days ago, <= 90d -> NOT churned)
    const emailActive = '12'.repeat(32)
    insertOrder({ id: 'ord-act-1', emailHash: emailActive, grossCents: 4000, createdAt: '2026-04-01T10:00:00Z' })
    insertOrder({ id: 'ord-act-2', emailHash: emailActive, grossCents: 4000, createdAt: '2026-09-15T10:00:00Z' })

    // Customer Churned: bought 2026-04-01, no purchase since (211 days ago, > 90d -> churned)
    const emailChurned = '13'.repeat(32)
    insertOrder({ id: 'ord-chu-1', emailHash: emailChurned, grossCents: 4000, createdAt: '2026-04-01T10:00:00Z' })

    const res90 = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-30T23:59:59Z',
      churnDays: 90
    })
    const aprCohort = res90.cohorts.find((c) => c.cohort === '2026-04')
    expect(aprCohort?.size).toBe(2)
    expect(aprCohort?.churn.days).toBe(90)
    expect(aprCohort?.churn.count).toBe(1)
    expect(aprCohort?.churn.rate).toBeCloseTo(0.5, 2)

    // With churnDays = 30: customerActive bought 44 days ago (> 30d) -> both are churned!
    const res30 = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-30T23:59:59Z',
      churnDays: 30
    })
    const aprCohort30 = res30.cohorts.find((c) => c.cohort === '2026-04')
    expect(aprCohort30?.churn.count).toBe(2)
    expect(aprCohort30?.churn.rate).toBeCloseTo(1.0, 2)
  })

  it('segments cohort by particular vs professional and provides category breakdown', async () => {
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps, insertOrder } = fixture

    // Customer Particular: no company, no buyerTaxId
    const emailPart = '14'.repeat(32)
    insertOrder({
      id: 'ord-part-1',
      emailHash: emailPart,
      grossCents: 3000,
      createdAt: '2026-05-01T10:00:00Z',
      categoryId: 'cat-hogar'
    })
    insertOrder({
      id: 'ord-part-2',
      emailHash: emailPart,
      grossCents: 3000,
      createdAt: '2026-05-20T10:00:00Z',
      categoryId: 'cat-hogar'
    })

    // Customer Professional via buyerCompanyName & buyerTaxId
    const emailPro = '15'.repeat(32)
    insertOrder({
      id: 'ord-pro-1',
      emailHash: emailPro,
      grossCents: 15000,
      createdAt: '2026-05-05T10:00:00Z',
      buyerCompanyName: 'Hotel Limpio SL',
      buyerTaxId: 'B12345678',
      categoryId: 'cat-hosteleria'
    })

    const res = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T23:59:59Z'
    })
    const mayCohort = res.cohorts.find((c) => c.cohort === '2026-05')
    expect(mayCohort?.size).toBe(2)
    expect(mayCohort?.segments.particular.count).toBe(1)
    expect(mayCohort?.segments.particular.repeatCount).toBe(1)
    expect(mayCohort?.segments.professional.count).toBe(1)
    expect(mayCohort?.segments.professional.repeatCount).toBe(0)

    // Breakdown includes categories
    expect(mayCohort?.topCategories.length).toBeGreaterThanOrEqual(1)
    const hogarCat = mayCohort?.topCategories.find((c) => c.categoryId === 'cat-hogar')
    expect(hogarCat?.customerCount).toBe(1)
  })

  it('handles empty cohorts and zero orders gracefully', async () => {
    const fixture = await setupCohortsFixture({ now: '2026-10-29T12:00:00Z' })
    const { deps } = fixture

    const res = await readCohortsAnalytics(deps, CLAIMS, {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-30T23:59:59Z'
    })
    expect(res.cohorts).toEqual([])
    expect(res.summary.totalCustomers).toBe(0)
    expect(res.summary.medianDaysToRepurchase).toBeNull()
  })

  it('enforces admin authorization and CSRF via HTTP endpoint', async () => {
    const fixture = await setupCohortsFixture()
    const { deps } = fixture

    const httpDeps: AnalyticsHttpDependencies = {
      ...deps,
      sessionCookieConfiguration: { password: 'session-secret-password-32-chars-long!', maxAgeSeconds: 3600 }
    }

    // Unauthenticated GET
    const unauthReq = new Request('https://analytics-fixture.neteco.test/api/admin/analytics/cohorts', {
      method: 'GET',
      headers: { Origin: 'https://analytics-fixture.neteco.test' }
    })
    const unauthRes = await handleCohortsAnalyticsHttp(unauthReq, httpDeps)
    expect(unauthRes?.status).toBe(401)

    // Cross-site request rejected
    const csrfReq = new Request('https://analytics-fixture.neteco.test/api/admin/analytics/cohorts', {
      method: 'GET',
      headers: { 'Sec-Fetch-Site': 'cross-site' }
    })
    const csrfRes = await handleCohortsAnalyticsHttp(csrfReq, httpDeps)
    expect(csrfRes?.status).toBe(403)
  })
})
