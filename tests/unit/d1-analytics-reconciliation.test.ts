import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fulfillmentFixture, CLAIMS, utc } from './d1-fulfillment-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { collectClientAnalytics } from '../../workers/analytics/collector'
import { projectAnalyticsCommerceFacts } from '../../workers/analytics/commerce-projection'
import { readAnalyticsSnapshot } from '../../workers/analytics/read-model'
import { readAnalyticsReconciliation } from '../../workers/analytics/reconciliation'
import { dispatchAnalyticsRetention, type AnalyticsRetentionOptions } from '../../workers/analytics/retention'
import type { AnalyticsMeasurementDependencies } from '../../workers/analytics/authority'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAnalyticsHttp } from '../../workers/analytics/http'
import { auditNativeAnalytics } from '../../scripts/lib/audit-native-analytics'
import { createShopIngress } from '../../workers/runtime/shop-ingress'
import { testUuid } from '../support/deterministic'

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})
const origin = 'https://analytics.neteco.test'
const consent = JSON.stringify({ version: 'v1', analytics: true })
const maintenance: AnalyticsRetentionOptions = {
  enabled: true,
  limit: 2,
  maxBatches: 10,
  quota: { windowSeconds: 3600, maximumRequestedEvents: 10 }
}
async function world(environment: AnalyticsMeasurementDependencies['environment'] = 'local') {
  const f = await fulfillmentFixture()
  opened.push(f.sqlite)
  if (!f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='analytics_client_events'").get())
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0052_analytics_measurement.sql', import.meta.url), 'utf8')
    )
  f.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0081_promotional_analytics.sql', import.meta.url), 'utf8')
  )
  let now = utc()
  const deps: AnalyticsMeasurementDependencies = {
    database: f.database,
    origin,
    environment,
    enabled: true,
    policy: {
      reference: 'synthetic-analytics-policy',
      version: 'v1',
      purpose: 'first_party_measurement',
      consentVersion: 'v1',
      retentionDays: 1,
      environment,
      approvedAt: utc(-60000)
    },
    sessionPepper: new Uint8Array(32).fill(5),
    now: () => now
  }
  const range = { from: utc(-3600000), to: utc(3600000), page: 1, perPage: 20 }
  async function captured(bankEnvironment: 'sandbox' | 'production' = 'sandbox', legacy = false) {
    // The normal checkout and signed notification engine own payment and stock.
    // No direct paid/capture/claim/ownership SQL is used by this fixture.
    const cart = await createCart(f.database, { now, correlationId: 'synthetic-analytics-checkout' })
    const common = { cartId: cart.cartId, token: cart.token, now, correlationId: 'synthetic-analytics-checkout' }
    await setCartLine(f.database, {
      ...common,
      quantity: 1,
      variantId: 'v-1-1',
      expectedVersion: 1,
      idempotencyKey: 'line'
    })
    const shipping = await requestShippingOptions(f.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    const quote = await quoteCart(f.database, { ...common, expectedVersion: 2, idempotencyKey: 'quote' })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw Error('checkout_fixture_unconfirmed')
    const option = (
      shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    ).find((item) => item.methodCode === 'pickup')!
    const order = await placeOrder(f.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: 'checkout',
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      consentTos: true,
      consentPrivacy: true,
      contactEmail: 'analytics-buyer@example.invalid',
      contactName: 'Synthetic analytics buyer',
      shippingAddress: {
        recipientName: 'Synthetic analytics buyer',
        line1: 'Synthetic local street 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        countryCode: 'ES',
        phone: '+34600111222'
      }
    })
    if (order.outcome !== 'order_created') throw Error('order_fixture_unconfirmed')
    const configuration = {
      environment: bankEnvironment,
      merchantCode: '999008881',
      terminal: '1',
      secretKey: 'synthetic-only-analytics-signing-material',
      merchantName: 'NETECO',
      publicBaseUrl: origin
    }
    await initiateRedsysPayment(
      f.database,
      {
        orderId: String(order.body.id),
        orderToken: String(order.body.orderToken),
        idempotencyKey: 'payment',
        method: 'card',
        correlationId: 'synthetic-analytics-payment',
        now
      },
      configuration
    )
    const intent = f.sqlite
      .prepare('SELECT id,merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
      .get(String(order.body.id))!
    const parameters = encodeMerchantParameters({
      Ds_Order: String(intent.merchant_order),
      Ds_Amount: String(intent.amount_gross_cents),
      Ds_Currency: '978',
      Ds_MerchantCode: configuration.merchantCode,
      Ds_Terminal: '1',
      Ds_TransactionType: '0',
      Ds_Response: '0000'
    })
    const envelope = {
      Ds_MerchantParameters: parameters,
      Ds_SignatureVersion: 'HMAC_SHA512_V2',
      Ds_Signature: await signMerchantParameters(parameters, configuration.secretKey)
    }
    let database = f.database
    if (legacy) {
      // Simulate the old producer's absent provenance at its persistence seam.
      // Verification/capture/allocation remain the genuine engine. Historical
      // authority is intentionally incomplete, never fabricated as positive.
      database = {
        ...f.database,
        prepare(sql: string) {
          const statement = f.database.prepare(sql)
          if (!sql.includes('INSERT OR IGNORE INTO order_events')) return statement
          return {
            ...statement,
            bind(...values: unknown[]) {
              if (sql.includes("'payment_provider_authorised'") && typeof values[2] === 'string') {
                const payload = JSON.parse(values[2]) as Record<string, unknown>
                delete payload.captureSource
                values[2] = JSON.stringify(payload)
              }
              return statement.bind(...values)
            }
          }
        }
      } as D1Database
    }
    expect(
      await processRedsysNotification(database, envelope, configuration, {
        now,
        correlationId: 'synthetic-analytics-callback'
      })
    ).toEqual({ outcome: 'captured' })
    const source = f.sqlite
      .prepare('SELECT * FROM analytics_commerce_sources WHERE source_id=?')
      .get(String(intent.id))!
    expect(source.proof_valid).toBe(legacy ? 0 : 1)
    expect(source.provider_environment).toBe(legacy ? 'unknown' : bankEnvironment)
    return {
      orderId: String(order.body.id),
      intentId: String(intent.id),
      amount: Number(intent.amount_gross_cents),
      occurredAt: now
    }
  }
  async function events(count: number, overrides: Partial<AnalyticsMeasurementDependencies> = {}) {
    const ids: string[] = [],
      anonymousCookie = testUuid()
    for (let i = 0; i < count; i++) {
      const eventId = testUuid()
      expect(
        (
          await collectClientAnalytics(
            { ...deps, ...overrides },
            {
              event: {
                eventId,
                name: 'page_view',
                taxonomyVersion: 'v1',
                occurredAt: now,
                properties: { path: '/catalogo' }
              },
              consentCookie: consent,
              anonymousCookie
            }
          )
        ).accepted
      ).toBe(true)
      ids.push(eventId)
    }
    return ids
  }
  const financial = () =>
    JSON.stringify(
      [
        'orders',
        'order_lines',
        'order_events',
        'payment_intents',
        'payment_events',
        'order_payment_states',
        'payment_fulfilment_claims',
        'payment_recovery_jobs',
        'inventory_balances',
        'inventory_movements',
        'inventory_reservations',
        'inventory_reservation_lines',
        'fiscal_invoice_intents',
        'fiscal_issuance_work',
        'fiscal_provider_receipts',
        'fiscal_documents',
        'refund_contracts',
        'refund_work',
        'refund_receipts',
        'analytics_commerce_facts'
      ].map((table) => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    )
  return {
    ...f,
    deps,
    range,
    captured,
    events,
    financial,
    advance: (milliseconds: number) => {
      now = new Date(Date.parse(now) + milliseconds).toISOString().replace('.000Z', 'Z')
    }
  }
}

describe('native analytics reconciliation against genuine local financial authority', () => {
  it('wires the reusable native helper to genuine HTTP/session/payment/projector/retention engines without fixture SQL proof', async () => {
    const f = await world()
    await f.captured()
    f.deps.now = () => utc()
    const customer = {
      identityId: '30000000-0000-4000-8000-000000000052',
      sessionId: '40000000-0000-4000-8000-000000000052',
      sessionVersion: 1
    }
    const before = utc(-60000)
    f.sqlite.exec(`INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${customer.identityId}','analytics-customer@example.invalid','synthetic','${before}','active','${before}','${before}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${customer.sessionId}','${customer.identityId}',1,0,'${before}','${utc(3600000)}');`)
    const sessionCookieConfiguration = {
      password: 'synthetic-analytics-session-password-0123456789abcdef',
      maxAgeSeconds: 3600
    }
    const adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, sessionCookieConfiguration))!.split(';')[0]!
    const customerCookie = (await issueD1SessionCookie(f.database, customer, sessionCookieConfiguration))!.split(
      ';'
    )[0]!
    const scenarios: string[] = []
    const ingress = createShopIngress(
      {
        fetch: async (request) => {
          const response = await handleAnalyticsHttp(request, {
            ...f.deps,
            sessionCookieConfiguration,
            edgeGate: async () => 'allowed'
          })
          if (!response) throw Error('analytics_route_not_owned')
          return response
        }
      },
      {
        fetch: async () => {
          throw Error('No legacy analytics fallback')
        }
      }
    )
    const evidence = await auditNativeAnalytics({
      database: f.database,
      origin,
      adminCookie,
      customerCookie,
      policy: f.deps.policy!,
      range: f.range,
      scenario: (name) => {
        scenarios.push(name)
      },
      dispatch: (request) => ingress.fetch(request, { APP_ENV: 'local' } as CloudflareEnv, {} as ExecutionContext),
      runProjection: () => projectAnalyticsCommerceFacts(f.deps),
      runRetention: ({ at, ...options }) => dispatchAnalyticsRetention({ ...f.deps, now: () => at }, options)
    })
    // This is helper wiring over real SQLite, not evidence of a workerd entrypoint.
    expect(evidence.scenarios).toBe(19)
    expect(scenarios).toEqual(evidence.checks)
    expect(evidence).toMatchObject({
      sourceCount: 1,
      projected: 1,
      consentedEvents: 3,
      removedEvents: 2,
      financialUnchanged: true,
      inventoryUnchanged: true,
      retentionFactsUnchanged: true,
      settlementCertified: false,
      scheduledEntrypointExercised: false,
      queueEntrypointExercised: false
    })
  })
  it('reports pending projection with real lag, then confirms local validation without mutating authority on GET', async () => {
    const f = await world(),
      capture = await f.captured()
    f.advance(10000)
    const before = f.financial(),
      changes = f.sqlite.prepare('SELECT total_changes() AS count').get()!.count
    const pending = await readAnalyticsReconciliation(f.deps, CLAIMS, f.range)
    expect(pending.summary).toEqual({
      sourceCount: 1,
      missingCount: 1,
      mismatchCount: 0,
      unconfirmedCount: 0,
      excludedCount: 0,
      projectionLagSeconds: 10
    })
    expect(pending.issues).toEqual([
      {
        code: 'missing',
        sourceKind: 'capture_applied',
        sourceId: capture.intentId,
        occurredAt: capture.occurredAt,
        lagSeconds: 10,
        hint: 'projection_pending'
      }
    ])
    expect(f.financial()).toBe(before)
    expect(f.sqlite.prepare('SELECT total_changes() AS count').get()!.count).toBe(changes)
    expect(await projectAnalyticsCommerceFacts(f.deps, { limit: 1, maxPages: 1 })).toMatchObject({
      projected: 1,
      complete: true,
      validationOnly: true
    })
    const result = await readAnalyticsReconciliation(f.deps, CLAIMS, f.range)
    expect(result.summary).toMatchObject({
      sourceCount: 1,
      missingCount: 0,
      mismatchCount: 0,
      projectionLagSeconds: null
    })
    expect(result.issues).toEqual([])
    const summary = await readAnalyticsSnapshot(f.deps, CLAIMS, f.range)
    expect(summary.metrics).toMatchObject({
      capturedOrders: 1,
      grossCollectedCents: capture.amount,
      settlementCertified: false
    })
    expect(summary.facts[0]).toMatchObject({ sourceId: capture.intentId, population: 'validation' })
    expect(summary.browser.financialAuthority).toBe('none')
  })
  it('counts pages independently and never infers global coverage from a single page', async () => {
    const f = await world()
    await f.captured()
    await f.captured()
    await f.captured()
    const page = await readAnalyticsReconciliation(f.deps, CLAIMS, { ...f.range, page: 2, perPage: 1 })
    expect(page.summary.missingCount).toBe(3)
    expect(page.issues).toHaveLength(1)
    expect(page.pagination).toEqual({ page: 2, perPage: 1, total: 3, pages: 3 })
    const overflow = await readAnalyticsReconciliation(f.deps, CLAIMS, { ...f.range, page: 4, perPage: 1 })
    expect(overflow.issues).toEqual([])
    expect(overflow.pagination.total).toBe(3)
  })
  it('production rejects sandbox validation and does not call it real collected revenue', async () => {
    const f = await world('production')
    await f.captured('sandbox')
    expect((await readAnalyticsReconciliation(f.deps, CLAIMS, f.range)).summary).toMatchObject({
      sourceCount: 1,
      excludedCount: 1,
      missingCount: 0
    })
    expect(await projectAnalyticsCommerceFacts(f.deps)).toMatchObject({ projected: 0 })
    expect((await readAnalyticsSnapshot(f.deps, CLAIMS, f.range)).facts).toEqual([])
  })
  it('verified production provenance is eligible but is not settlement certification', async () => {
    const f = await world('production'),
      capture = await f.captured('production')
    await projectAnalyticsCommerceFacts(f.deps)
    expect((await readAnalyticsSnapshot(f.deps, CLAIMS, f.range)).metrics).toMatchObject({
      grossCollectedCents: capture.amount,
      settlementCertified: false
    })
    expect((await readAnalyticsSnapshot(f.deps, CLAIMS, f.range)).facts[0]?.population).toBe('real')
  })
  it('historical captured payment without persisted bank provenance remains unconfirmed and null, never zero', async () => {
    const f = await world('production'),
      capture = await f.captured('production', true)
    const result = await readAnalyticsReconciliation(f.deps, CLAIMS, f.range)
    expect(result.summary).toMatchObject({
      sourceCount: 1,
      unconfirmedCount: 1,
      missingCount: 0,
      projectionLagSeconds: null
    })
    expect(result.issues[0]).toMatchObject({
      sourceId: capture.intentId,
      code: 'unconfirmed',
      hint: 'capture_provenance_unavailable',
      lagSeconds: null
    })
    expect(await projectAnalyticsCommerceFacts(f.deps)).toMatchObject({
      projected: 0,
      sourceUnavailable: 1,
      complete: false
    })
    const summary = await readAnalyticsSnapshot(f.deps, CLAIMS, f.range)
    expect(summary.metrics.grossCollectedCents).toBeNull()
    expect(summary.metrics.capturedOrders).toBeNull()
    expect(summary.metrics.collectedAfterRefundsCents).toBeNull()
  })
  it.each([
    'order_id',
    'currency',
    'gross_cents',
    'net_cents',
    'tax_cents',
    'shipping_gross_cents',
    'occurred_at',
    'source_fingerprint'
  ] as const)('detects authoritative %s drift even when the other proof fields match', async (column) => {
    const f = await world()
    await f.captured()
    await projectAnalyticsCommerceFacts(f.deps)
    const fields = [
      'source_kind',
      'source_id',
      'order_id',
      'currency',
      'gross_cents',
      'net_cents',
      'tax_cents',
      'shipping_gross_cents',
      'occurred_at',
      'proof_valid',
      'provider_environment',
      'validation_only',
      'source_fingerprint'
    ]
    const expression =
      column === 'order_id'
        ? "'90000000-0000-4000-8000-000000000052'"
        : column === 'currency'
          ? "'USD'"
          : column === 'occurred_at'
            ? "strftime('%Y-%m-%dT%H:%M:%SZ',occurred_at,'-1 second')"
            : column === 'source_fingerprint'
              ? "'" + 'f'.repeat(64) + "'"
              : column + '+1'
    // A read-only adversarial source seam, derived from the real source view:
    // no replacement ledger, synthetic paid marker or dropped SQL guard.
    const source = `(SELECT ${fields.map((field) => (field === column ? `${expression} AS ${field}` : field)).join(',')} FROM analytics_commerce_sources) s`
    const database = {
      ...f.database,
      prepare: (sql: string) => f.database.prepare(sql.replace('FROM analytics_commerce_sources s', 'FROM ' + source))
    } as D1Database
    const result = await readAnalyticsReconciliation({ ...f.deps, database }, CLAIMS, f.range)
    expect(result.summary.mismatchCount).toBe(1)
    expect(result.issues[0]).toMatchObject({ code: 'mismatch', hint: 'projection_mismatch' })
  })
  it('rejects expired range rather than reporting expired immutable facts as missing', async () => {
    const f = await world()
    await expect(
      readAnalyticsReconciliation(f.deps, CLAIMS, { ...f.range, from: utc(-2 * 86400000) })
    ).rejects.toMatchObject({ code: 'period_unavailable' })
  })
  it('rejects the exact expiry boundary using the final snapshot clock after authorization awaits', async () => {
    const f = await world()
    const cutoff = new Date(Date.parse(f.deps.now!()) - 86400000).toISOString().replace('.000Z', 'Z')
    await expect(readAnalyticsReconciliation(f.deps, CLAIMS, { ...f.range, from: cutoff })).rejects.toMatchObject({
      code: 'period_unavailable'
    })
    const startsInside = new Date(Date.parse(cutoff) + 1000).toISOString().replace('.000Z', 'Z')
    let calls = 0
    f.deps.database = {
      ...f.database,
      prepare(sql: string) {
        const statement = f.database.prepare(sql)
        if (!sql.includes('FROM auth_sessions')) return statement
        return {
          ...statement,
          bind(...parameters: unknown[]) {
            const bound = statement.bind(...parameters)
            return {
              ...bound,
              async first<T>(...args: Parameters<D1PreparedStatement['first']>) {
                const result = await bound.first<T>(...args)
                if (++calls === 2) f.advance(2000)
                return result
              }
            }
          }
        }
      }
    } as D1Database
    await expect(readAnalyticsReconciliation(f.deps, CLAIMS, { ...f.range, from: startsInside })).rejects.toMatchObject(
      { code: 'period_unavailable' }
    )
  })
  it('does not include future source authority in a permitted future-ended range', async () => {
    const f = await world()
    await f.captured()
    f.deps.now = () => utc(-10000)
    expect((await readAnalyticsReconciliation(f.deps, CLAIMS, f.range)).summary.sourceCount).toBe(0)
  })
  it('rejects lost live authority after a successfully awaited read snapshot', async () => {
    const f = await world()
    const database = {
      ...f.database,
      async batch(statements: D1PreparedStatement[]) {
        const result = await f.database.batch(statements)
        f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
        return result
      }
    } as D1Database
    await expect(readAnalyticsReconciliation({ ...f.deps, database }, CLAIMS, f.range)).rejects.toMatchObject({
      code: 'forbidden'
    })
  })
  it('rejects changed server policy after read, not a mixed-policy DTO', async () => {
    const f = await world()
    f.deps.database = {
      ...f.database,
      async batch(statements: D1PreparedStatement[]) {
        const result = await f.database.batch(statements)
        f.deps.policy = { ...f.deps.policy!, version: 'v2' }
        return result
      }
    } as D1Database
    await expect(readAnalyticsReconciliation(f.deps, CLAIMS, f.range)).rejects.toMatchObject({
      code: 'configuration_unavailable'
    })
  })
  it('rejects unconfirmed D1 batch envelopes instead of returning an empty successful read', async () => {
    const f = await world()
    const database = { ...f.database, batch: async () => [{ results: [] }, { results: [] }] } as unknown as D1Database
    await expect(readAnalyticsReconciliation({ ...f.deps, database }, CLAIMS, f.range)).rejects.toMatchObject({
      code: 'read_unconfirmed'
    })
  })
})

describe('approved native analytics retention, bounded and financially inert', () => {
  it('disabled maintenance requires no SQL, policy, clock or pepper', async () => {
    const f = await world()
    const deps = {
      ...f.deps,
      database: {
        prepare: () => {
          throw Error('no disabled SQL')
        }
      } as unknown as D1Database,
      now: () => {
        throw Error('no disabled clock')
      }
    }
    Object.defineProperty(deps, 'policy', {
      get: () => {
        throw Error('no disabled policy')
      }
    })
    expect(await dispatchAnalyticsRetention(deps, { ...maintenance, enabled: false })).toMatchObject({
      enabled: false,
      removed: 0,
      remainingExpired: null,
      generatedAt: null
    })
  })
  it.each([null, { reference: 'not-approved' }])(
    'requires a complete approved policy without inventing defaults (%j)',
    async (policy) => {
      const f = await world()
      await expect(
        dispatchAnalyticsRetention({ ...f.deps, policy } as AnalyticsMeasurementDependencies, maintenance)
      ).rejects.toMatchObject({ code: 'configuration_unavailable' })
    }
  )
  it('deletes actual expired consented events while acquisition is OFF and preserves every financial record', async () => {
    const f = await world()
    await f.captured()
    await projectAnalyticsCommerceFacts(f.deps)
    await f.events(5)
    const before = f.financial()
    f.advance(2 * 86400000)
    f.deps.enabled = false
    expect(await dispatchAnalyticsRetention(f.deps, maintenance)).toMatchObject({
      enabled: true,
      batches: 3,
      requested: 6,
      removed: 5,
      remainingExpired: 0,
      quotaExhausted: false,
      financialContractsTouched: false
    })
    expect(f.financial()).toBe(before)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(0)
    expect(f.sqlite.prepare('SELECT sum(removed_count) AS count FROM analytics_retention_runs').get()!.count).toBe(5)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_commerce_facts').get()!.count).toBe(1)
  })
  it('preserves not-expired events and other policy/environment partitions', async () => {
    const f = await world()
    await f.events(1)
    const alternate = { ...f.deps.policy!, reference: 'different-approved-policy' }
    await f.events(1, { policy: alternate })
    await f.events(1, { environment: 'preview', policy: { ...f.deps.policy!, environment: 'preview' } })
    f.advance(2 * 86400000)
    await f.events(1)
    expect(await dispatchAnalyticsRetention(f.deps, maintenance)).toMatchObject({ removed: 1, remainingExpired: 0 })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(3)
  })
  it('durable request quota prevents a second batch and never resets by policy version', async () => {
    const f = await world()
    await f.events(5)
    f.advance(2 * 86400000)
    const options = { ...maintenance, quota: { windowSeconds: 3600, maximumRequestedEvents: 2 } }
    expect(await dispatchAnalyticsRetention(f.deps, options)).toMatchObject({
      removed: 2,
      batches: 1,
      requested: 2,
      quotaExhausted: true,
      remainingExpired: 3
    })
    f.deps.policy = { ...f.deps.policy!, version: 'v2' }
    expect(await dispatchAnalyticsRetention(f.deps, options)).toMatchObject({
      removed: 0,
      batches: 0,
      quotaExhausted: true,
      remainingExpired: 3
    })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_retention_runs').get()!.count).toBe(1)
  })
  it('maxBatches is an actual bounded deletion budget with truthful remaining count', async () => {
    const f = await world()
    await f.events(5)
    f.advance(2 * 86400000)
    expect(await dispatchAnalyticsRetention(f.deps, { ...maintenance, maxBatches: 1 })).toMatchObject({
      removed: 2,
      batches: 1,
      remainingExpired: 3,
      quotaExhausted: false
    })
  })
  it('a competing committed worker consumes quota before this batch without double deletion', async () => {
    const f = await world()
    await f.events(3)
    f.advance(2 * 86400000)
    const options = { ...maintenance, maxBatches: 1, quota: { windowSeconds: 3600, maximumRequestedEvents: 2 } }
    let raced = false
    const database = {
      ...f.database,
      async batch(statements: D1PreparedStatement[]) {
        if (!raced) {
          raced = true
          expect(await dispatchAnalyticsRetention(f.deps, options)).toMatchObject({ removed: 2, batches: 1 })
        }
        return f.database.batch(statements)
      }
    } as D1Database
    expect(await dispatchAnalyticsRetention({ ...f.deps, database }, options)).toMatchObject({
      removed: 0,
      batches: 0,
      remainingExpired: 1,
      quotaExhausted: true
    })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_retention_runs').get()!.count).toBe(1)
  })
  it('a late native batch failure rolls back both deletion and immutable run ledger', async () => {
    const f = await world()
    await f.events(3)
    f.advance(2 * 86400000)
    const database = {
      ...f.database,
      batch: (statements: D1PreparedStatement[]) =>
        f.database.batch([
          ...statements,
          f.database.prepare('INSERT INTO analytics_atomic_guards(id,passed) VALUES(1,0)')
        ])
    } as D1Database
    await expect(dispatchAnalyticsRetention({ ...f.deps, database }, maintenance)).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(3)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_retention_runs').get()!.count).toBe(0)
  })
  it('an ambiguous committed batch is not reported as zero and is never retried', async () => {
    const f = await world()
    await f.events(3)
    f.advance(2 * 86400000)
    let calls = 0
    const database = {
      ...f.database,
      async batch(statements: D1PreparedStatement[]) {
        calls++
        await f.database.batch(statements)
        throw Error('transport lost after commit')
      }
    } as D1Database
    await expect(dispatchAnalyticsRetention({ ...f.deps, database }, maintenance)).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    expect(calls).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_retention_runs').get()!.count).toBe(1)
  })
  it('empty successful batch envelopes cannot prove a maintenance deletion', async () => {
    const f = await world()
    await f.events(1)
    f.advance(2 * 86400000)
    const database = { ...f.database, batch: async () => [] } as unknown as D1Database
    await expect(dispatchAnalyticsRetention({ ...f.deps, database }, maintenance)).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()!.count).toBe(1)
  })
  it('changed policy during a committed batch fails closed rather than returning mixed-policy success', async () => {
    const f = await world()
    await f.events(3)
    f.advance(2 * 86400000)
    let calls = 0
    f.deps.database = {
      ...f.database,
      async batch(statements: D1PreparedStatement[]) {
        calls++
        const result = await f.database.batch(statements)
        f.deps.policy = { ...f.deps.policy!, version: 'v2' }
        return result
      }
    } as D1Database
    await expect(dispatchAnalyticsRetention(f.deps, maintenance)).rejects.toMatchObject({
      code: 'configuration_unavailable'
    })
    expect(calls).toBe(1)
  })
  it.each([
    { limit: 0 },
    { limit: 101 },
    { maxBatches: 11 },
    { quota: { windowSeconds: 0, maximumRequestedEvents: 10 } }
  ])('rejects invalid maintenance budget %j without writes', async (change) => {
    const f = await world()
    await expect(dispatchAnalyticsRetention(f.deps, { ...maintenance, ...change })).rejects.toMatchObject({
      code: 'service_unavailable'
    })
    expect(f.sqlite.prepare('SELECT count(*) AS count FROM analytics_retention_runs').get()!.count).toBe(0)
  })
})
