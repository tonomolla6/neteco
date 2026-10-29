import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  analyticsMeasurementPolicySchema,
  analyticsRangeSchema,
  analyticsSnapshotSchema,
  analyticsReconciliationSchema,
  analyticsProjectionResultSchema,
  type AnalyticsMeasurementPolicy,
  type AnalyticsProjectionResult
} from '../../shared/analytics-measurement'
import { catalogPolicyInstantSchema, catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { canonicalJson } from '../../workers/catalog/inventory'
import type { AnalyticsRetentionOptions, AnalyticsRetentionReport } from '../../workers/analytics/retention'

export interface NativeAnalyticsAuditInput {
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  origin: string
  adminCookie: string
  customerCookie: string
  /** Explicit local fixture approval, never a production policy or seed. */
  policy: AnalyticsMeasurementPolicy
  range: { from: string; to: string }
  scenario: (name: string) => void
  /** Invoke the real projector with native D1, not mocked projection rows. */
  runProjection: () => Promise<AnalyticsProjectionResult>
  /** Invoke real maintenance with this private callback clock. Do not change
   * runtime/global time, financial policies, documents or source authority. */
  runRetention: (input: AnalyticsRetentionOptions & { at: string }) => Promise<AnalyticsRetentionReport>
}
export interface NativeAnalyticsAuditEvidence {
  scenarios: number
  checks: readonly string[]
  sourceCount: number
  projected: number
  consentedEvents: number
  removedEvents: number
  financialDigest: string
  inventoryDigest: string
  retentionFactsDigest: string
  financialUnchanged: true
  inventoryUnchanged: true
  retentionFactsUnchanged: true
  validationOnly: true
  settlementCertified: false
  browserFinancialAuthority: 'none'
  httpTransport: 'native_worker_fetch'
  maintenanceTransport: 'host_worker_compatible_native_d1'
  scheduledEntrypointExercised: false
  queueEntrypointExercised: false
  providerAuthority: false
}
const inventoryQueries = [
  'SELECT * FROM inventory_locations ORDER BY id',
  'SELECT * FROM inventory_balances ORDER BY variant_id,location_id',
  'SELECT * FROM inventory_reservations ORDER BY id',
  'SELECT * FROM inventory_reservation_lines ORDER BY reservation_id,variant_id,location_id',
  'SELECT * FROM inventory_movements ORDER BY id'
] as const
const financialQueries = [
  'SELECT * FROM orders ORDER BY id',
  'SELECT * FROM order_lines ORDER BY order_id,line_index',
  'SELECT * FROM order_shipping_address ORDER BY order_id',
  'SELECT * FROM order_billing_address ORDER BY order_id',
  'SELECT * FROM order_events ORDER BY id',
  'SELECT * FROM payment_intents ORDER BY id',
  'SELECT * FROM order_payment_states ORDER BY order_id',
  'SELECT * FROM payment_commands ORDER BY order_id,command_id',
  'SELECT * FROM payment_events ORDER BY id',
  'SELECT * FROM payment_fulfilment_claims ORDER BY order_id',
  'SELECT * FROM payment_recovery_jobs ORDER BY payment_intent_id',
  'SELECT * FROM order_fulfillments ORDER BY order_id',
  'SELECT * FROM order_fulfillment_commands ORDER BY id',
  'SELECT * FROM order_fulfillment_audit ORDER BY command_id',
  'SELECT * FROM order_returns ORDER BY id',
  'SELECT * FROM order_return_commands ORDER BY id',
  'SELECT * FROM order_return_events ORDER BY command_id',
  'SELECT * FROM fiscal_outbox_events ORDER BY id',
  'SELECT * FROM fiscal_issuance_policies ORDER BY id',
  'SELECT * FROM fiscal_policy_withdrawals ORDER BY policy_id',
  'SELECT * FROM fiscal_invoice_intents ORDER BY id',
  'SELECT * FROM fiscal_issuance_work ORDER BY intent_id',
  'SELECT * FROM fiscal_provider_receipts ORDER BY intent_id',
  'SELECT * FROM fiscal_documents ORDER BY id',
  'SELECT * FROM fiscal_issuance_events ORDER BY id',
  'SELECT * FROM refund_contracts ORDER BY id',
  'SELECT * FROM financial_policies ORDER BY id',
  'SELECT * FROM financial_policy_withdrawals ORDER BY policy_id',
  'SELECT * FROM refund_work ORDER BY refund_id',
  'SELECT * FROM refund_allocations ORDER BY refund_id,line_index',
  'SELECT * FROM refund_receipts ORDER BY refund_id',
  'SELECT * FROM fiscal_credit_contracts ORDER BY id',
  'SELECT * FROM fiscal_credit_work ORDER BY credit_id',
  'SELECT * FROM fiscal_credit_receipts ORDER BY credit_id',
  'SELECT * FROM fiscal_credit_documents ORDER BY credit_id'
] as const
const factQueries = ['SELECT * FROM analytics_commerce_facts ORDER BY environment,source_kind,source_id'] as const
type Query = string | { sql: string; bindings: unknown[] }
async function rows(database: D1Database, queries: readonly Query[]) {
  const result = catalogPolicyOwnJson(
    await database.batch(
      queries.map((query) =>
        typeof query === 'string' ? database.prepare(query) : database.prepare(query.sql).bind(...query.bindings)
      )
    )
  )
  assert(Array.isArray(result) && result.length === queries.length, 'native_analytics_d1_batch_unconfirmed')
  return result.map((item) => {
    assert(item && typeof item === 'object' && !Array.isArray(item), 'native_analytics_d1_envelope_unconfirmed')
    assert.equal(Reflect.get(item, 'success'), true, 'native_analytics_d1_success_unconfirmed')
    const records = Reflect.get(item, 'results')
    assert(Array.isArray(records), 'native_analytics_d1_results_unconfirmed')
    return records
  })
}
async function digest(database: D1Database, queries: readonly string[]) {
  return createHash('sha256')
    .update(canonicalJson(await rows(database, queries)))
    .digest('hex')
}
async function responseBody(response: Response, status: number) {
  assert.equal(response.status, status, 'native_analytics_http_status')
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/, 'native_analytics_private_cache')
  assert.match(response.headers.get('vary') ?? '', /\bcookie\b/i, 'native_analytics_cookie_vary')
  assert.match(response.headers.get('x-robots-tag') ?? '', /\bnoindex\b/, 'native_analytics_noindex')
  const raw = await response.text()
  assert(raw.length > 0 && raw.length <= 262144, 'native_analytics_body_unconfirmed')
  return catalogPolicyOwnJson(JSON.parse(raw) as unknown)
}
function errorCode(value: unknown, expected: string) {
  assert.equal(canonicalJson(value), canonicalJson({ error: { code: expected } }), 'native_analytics_error_contract')
}
function jsonEqual(value: unknown, expected: unknown) {
  assert.equal(canonicalJson(value), canonicalJson(expected), 'native_analytics_json_contract')
}
function count(value: unknown) {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'native_analytics_count_unconfirmed')
  return value
}

/** All positive authority is existing real checkout/payment/refund/fiscal
 * history. This helper never inserts paid rows, ownership, facts or proofs. */
export async function auditNativeAnalytics(input: NativeAnalyticsAuditInput): Promise<NativeAnalyticsAuditEvidence> {
  const origin = new URL(input.origin),
    policy = analyticsMeasurementPolicySchema.parse(input.policy)
  assert(
    origin.protocol === 'https:' &&
      origin.origin === input.origin &&
      (origin.hostname.endsWith('.test') || origin.hostname.endsWith('.invalid')),
    'native_analytics_local_origin_required'
  )
  assert.equal(policy.environment, 'local', 'native_analytics_local_policy_required')
  const range = analyticsRangeSchema.parse({ ...input.range, page: 1, perPage: 20 })
  for (const cookie of [input.adminCookie, input.customerCookie])
    assert(
      typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 16384 && !/[\r\n]/.test(cookie),
      'native_analytics_cookie_invalid'
    )
  const checks: string[] = [],
    ids: string[] = [],
    query =
      '?' +
      new URLSearchParams({
        from: range.from,
        to: range.to,
        page: String(range.page),
        perPage: String(range.perPage)
      }),
    consent = 'neteco-consent-v1=' + encodeURIComponent(JSON.stringify({ version: 'v1', analytics: true }))
  async function check<T>(name: string, run: () => Promise<T>) {
    const label = 'native_analytics_' + name
    input.scenario(label)
    const result = await run()
    checks.push(label)
    return result
  }
  function request(path: string, method = 'GET', body?: unknown, cookie = '', extra: Record<string, string> = {}) {
    return new Request(input.origin + path, {
      method,
      headers: {
        origin: input.origin,
        'cf-connecting-ip': '192.0.2.52',
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }
  async function summary() {
    return analyticsSnapshotSchema.parse(
      await responseBody(
        await input.dispatch(request('/api/admin/analytics' + query, 'GET', undefined, input.adminCookie)),
        200
      )
    )
  }
  async function reconciliation(customQuery = query) {
    return analyticsReconciliationSchema.parse(
      await responseBody(
        await input.dispatch(
          request('/api/admin/analytics/reconciliation' + customQuery, 'GET', undefined, input.adminCookie)
        ),
        200
      )
    )
  }
  const beforeInventory = await digest(input.database, inventoryQueries),
    beforeFinancial = await digest(input.database, financialQueries)
  await check('sealed_admin_not_browser_consent', async () => {
    errorCode(
      await responseBody(await input.dispatch(request('/api/admin/analytics' + query, 'GET', undefined, consent)), 401),
      'unauthenticated'
    )
    const response = await input.dispatch(
      request('/api/admin/analytics' + query, 'GET', undefined, input.customerCookie)
    )
    assert([401, 403].includes(response.status), 'native_analytics_customer_admin_denial_required')
    await responseBody(response, response.status)
  })
  await check('canonical_router_no_legacy_fallback', async () => {
    const outer = await input.dispatch(request('/API/Analytics/events'))
    assert.equal(outer.status, 400)
    assert.equal(outer.headers.get('cache-control'), 'no-store')
    assert.equal(outer.headers.get('x-content-type-options'), 'nosniff')
    errorCode(catalogPolicyOwnJson(await outer.json()), 'invalid_path')
    for (const path of ['/api/%61nalytics/events', '/api/admin/analytics%2Freconciliation'])
      errorCode(
        await responseBody(await input.dispatch(request(path, 'GET', undefined, input.adminCookie)), 400),
        'invalid_input'
      )
    errorCode(
      await responseBody(
        await input.dispatch(request('/api/admin/analytics' + query, 'POST', {}, input.adminCookie)),
        405
      ),
      'method_not_allowed'
    )
  })
  await check('bounded_canonical_range', async () => {
    const invalid = '?' + new URLSearchParams({ from: range.from.replace('Z', '.000Z'), to: range.to })
    errorCode(
      await responseBody(
        await input.dispatch(request('/api/admin/analytics' + invalid, 'GET', undefined, input.adminCookie)),
        400
      ),
      'invalid_input'
    )
    errorCode(
      await responseBody(
        await input.dispatch(request('/api/admin/analytics' + query + '&page=2', 'GET', undefined, input.adminCookie)),
        400
      ),
      'invalid_input'
    )
  })
  const pending = await check('readonly_real_source_coverage', async () => {
    const result = await reconciliation(),
      snapshot = await summary()
    assert.deepEqual(result.policy, {
      reference: policy.reference,
      version: policy.version,
      purpose: policy.purpose,
      retentionDays: policy.retentionDays
    })
    assert.deepEqual(result.period, { from: range.from, to: range.to })
    assert.deepEqual(result.population, { environment: 'local', validationOnly: true })
    assert.equal(result.readOnly, true)
    assert.equal(result.settlementCertified, false)
    const sourceRows = (
      await rows(input.database, [
        {
          sql: 'SELECT count(*) AS count FROM analytics_commerce_sources WHERE occurred_at>=?1 AND occurred_at<?2 AND occurred_at<=?3',
          bindings: [range.from, range.to, result.generatedAt]
        }
      ])
    )[0]!
    assert.equal(result.summary.sourceCount, count(Reflect.get(sourceRows[0]!, 'count')))
    assert(
      result.summary.sourceCount > 0 &&
        snapshot.coverage.streams.some((stream) => stream.kind === 'capture_applied' && stream.eligibleCount > 0),
      'native_analytics_real_captured_source_required'
    )
    assert(result.summary.missingCount > 0, 'native_analytics_real_pending_projection_required')
    assert.equal(await digest(input.database, inventoryQueries), beforeInventory)
    assert.equal(await digest(input.database, financialQueries), beforeFinancial)
    return result
  })
  await check('real_paginated_counts', async () => {
    const page = await reconciliation(
      '?' + new URLSearchParams({ from: range.from, to: range.to, page: '1', perPage: '1' })
    )
    assert.equal(page.pagination.total, pending.pagination.total)
    assert.equal(page.issues.length, Math.min(1, pending.pagination.total))
    assert.equal(page.pagination.pages, pending.pagination.total)
  })
  const projection = await check('explicit_real_projection_host_callback', async () => {
    const result = analyticsProjectionResultSchema.parse(await input.runProjection())
    assert.equal(result.enabled, true)
    assert.equal(result.environment, 'local')
    assert.equal(result.validationOnly, true)
    assert(result.projected >= pending.summary.missingCount, 'native_analytics_projection_did_not_record_sources')
    assert.equal(result.remaining, 0)
    return result
  })
  const confirmed = await check('projection_reconciliation_and_financial_authority', async () => {
    const result = await reconciliation(),
      snapshot = await summary()
    assert.equal(result.summary.sourceCount, pending.summary.sourceCount)
    assert.equal(result.summary.missingCount, 0)
    assert.equal(result.summary.mismatchCount, 0)
    assert.equal(result.summary.unconfirmedCount, pending.summary.unconfirmedCount)
    assert.equal(result.summary.projectionLagSeconds, null)
    const capture = snapshot.coverage.streams.find((stream) => stream.kind === 'capture_applied')!
    const amounts = (
      await rows(input.database, [
        {
          sql: "SELECT count(*) AS count,COALESCE(sum(gross_cents),0) AS cents FROM analytics_commerce_facts WHERE environment='local' AND source_kind='capture_applied' AND occurred_at>=?1 AND occurred_at<?2 AND expires_at>?3",
          bindings: [range.from, range.to, snapshot.generatedAt]
        }
      ])
    )[0]![0]!
    assert.equal(
      snapshot.metrics.grossCollectedCents,
      capture.unconfirmedCount || capture.backlogCount ? null : count(Reflect.get(amounts, 'cents'))
    )
    assert.equal(
      snapshot.metrics.capturedOrders,
      capture.unconfirmedCount || capture.backlogCount ? null : count(Reflect.get(amounts, 'count'))
    )
    assert.equal(snapshot.metrics.settlementCertified, false)
    assert.equal(snapshot.browser.financialAuthority, 'none')
    assert(snapshot.facts.every((fact) => fact.population === 'validation'))
    assert.equal(await digest(input.database, inventoryQueries), beforeInventory)
    assert.equal(await digest(input.database, financialQueries), beforeFinancial)
    return snapshot
  })
  const event = {
    eventId: randomUUID(),
    name: 'search_completed',
    taxonomyVersion: 'v1',
    occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    properties: { query: 'detergente native audit', resultCount: 7 }
  }
  await check('consent_required_before_collection', async () => {
    errorCode(
      await responseBody(await input.dispatch(request('/api/analytics/events', 'POST', event)), 403),
      'consent_required'
    )
    assert.equal(
      (
        await rows(input.database, [
          { sql: 'SELECT event_id FROM analytics_client_events WHERE event_id=?', bindings: [event.eventId] }
        ])
      )[0]!.length,
      0
    )
  })
  const anonymous = await check('genuine_consented_event_private_pseudonym', async () => {
    const response = await input.dispatch(request('/api/analytics/events', 'POST', event, consent))
    jsonEqual(await responseBody(response, 202), { accepted: true })
    const instruction = response.headers.get('set-cookie') ?? ''
    assert.match(
      instruction,
      /^neteco-analytics-id=[0-9a-f-]{36}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/
    )
    ids.push(event.eventId)
    const cookie = instruction.split(';')[0]!,
      value = cookie.split('=')[1]!
    const stored = (
      await rows(input.database, [
        {
          sql: 'SELECT session_hash,properties_json,payload_hash,environment,expires_at FROM analytics_client_events WHERE event_id=?',
          bindings: [event.eventId]
        }
      ])
    )[0]![0]!
    assert.equal(Reflect.get(stored, 'environment'), 'local')
    assert.deepEqual(JSON.parse(String(Reflect.get(stored, 'properties_json'))), { resultCount: 7 })
    assert.match(String(Reflect.get(stored, 'session_hash')), /^[0-9a-f]{64}$/)
    const serialized = canonicalJson(stored)
    for (const privateValue of [value, event.properties.query, '192.0.2.52', input.adminCookie, input.customerCookie])
      assert(!serialized.includes(privateValue), 'native_analytics_private_value_persisted')
    return cookie
  })
  const browserCookie = consent + '; ' + anonymous
  await check('exact_event_replay_without_duplicate', async () => {
    jsonEqual(
      await responseBody(await input.dispatch(request('/api/analytics/events', 'POST', event, browserCookie)), 202),
      { accepted: true }
    )
    assert.equal(
      (
        await rows(input.database, [
          { sql: 'SELECT event_id FROM analytics_client_events WHERE event_id=?', bindings: [event.eventId] }
        ])
      )[0]!.length,
      1
    )
  })
  await check('conflicting_event_identity_is_not_overwritten', async () => {
    errorCode(
      await responseBody(
        await input.dispatch(
          request(
            '/api/analytics/events',
            'POST',
            { ...event, properties: { ...event.properties, resultCount: 8 } },
            browserCookie
          )
        ),
        409
      ),
      'idempotency_conflict'
    )
  })
  await check('pii_query_rejected_not_persisted', async () => {
    const eventId = randomUUID()
    errorCode(
      await responseBody(
        await input.dispatch(
          request(
            '/api/analytics/events',
            'POST',
            { ...event, eventId, properties: { query: 'private-buyer@example.invalid', resultCount: 1 } },
            browserCookie
          )
        ),
        400
      ),
      'prohibited_data'
    )
    assert.equal(
      (
        await rows(input.database, [
          { sql: 'SELECT event_id FROM analytics_client_events WHERE event_id=?', bindings: [eventId] }
        ])
      )[0]!.length,
      0
    )
  })
  await check('bots_and_private_paths_excluded', async () => {
    jsonEqual(
      await responseBody(
        await input.dispatch(
          request('/api/analytics/events', 'POST', { ...event, eventId: randomUUID() }, browserCookie, {
            'user-agent': 'Googlebot/2.1'
          })
        ),
        202
      ),
      { accepted: false }
    )
    jsonEqual(
      await responseBody(
        await input.dispatch(
          request(
            '/api/analytics/events',
            'POST',
            {
              eventId: randomUUID(),
              name: 'page_view',
              taxonomyVersion: 'v1',
              occurredAt: event.occurredAt,
              properties: { path: '/cuenta/pedidos' }
            },
            browserCookie
          )
        ),
        202
      ),
      { accepted: false }
    )
  })
  await check('bounded_json_and_same_origin', async () => {
    errorCode(
      await responseBody(
        await input.dispatch(
          request(
            '/api/analytics/events',
            'POST',
            { ...event, properties: { query: 'x'.repeat(9000), resultCount: 1 } },
            browserCookie
          )
        ),
        413
      ),
      'body_too_large'
    )
    errorCode(
      await responseBody(
        await input.dispatch(
          request('/api/analytics/events', 'POST', event, browserCookie, { origin: 'https://foreign.example.invalid' })
        ),
        403
      ),
      'csrf_rejected'
    )
  })
  await check('additional_consented_events_and_readonly_browser_counts', async () => {
    for (let i = 0; i < 2; i++) {
      const eventId = randomUUID()
      ids.push(eventId)
      jsonEqual(
        await responseBody(
          await input.dispatch(
            request(
              '/api/analytics/events',
              'POST',
              {
                eventId,
                name: 'page_view',
                taxonomyVersion: 'v1',
                occurredAt: event.occurredAt,
                properties: { path: '/catalogo' }
              },
              browserCookie
            )
          ),
          202
        ),
        { accepted: true }
      )
    }
    const after = await summary()
    assert.deepEqual(after.metrics, confirmed.metrics)
    assert.equal(
      after.browser.eventCounts.find((item) => item.name === 'search_completed')!.count,
      confirmed.browser.eventCounts.find((item) => item.name === 'search_completed')!.count + 1
    )
    assert.equal(
      after.browser.eventCounts.find((item) => item.name === 'page_view')!.count,
      confirmed.browser.eventCounts.find((item) => item.name === 'page_view')!.count + 2
    )
  })
  await check('withdrawal_clears_cookie_only_without_identity', async () => {
    const response = await input.dispatch(request('/api/analytics/session', 'DELETE', undefined, browserCookie))
    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
    assert.equal(
      response.headers.get('set-cookie'),
      'neteco-analytics-id=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
    )
    const result = (
      await rows(input.database, [
        { sql: 'SELECT count(*) AS count FROM analytics_client_events WHERE event_id IN(?,?,?)', bindings: ids }
      ])
    )[0]![0]!
    assert.equal(count(Reflect.get(result, 'count')), 3)
  })
  const retentionFactsDigest = await digest(input.database, factQueries)
  const expiry = (
    await rows(input.database, [
      {
        sql: "SELECT max(expires_at) AS latest FROM analytics_client_events WHERE environment='local' AND policy_reference=?",
        bindings: [policy.reference]
      }
    ])
  )[0]![0]!
  const latest = catalogPolicyInstantSchema.parse(Reflect.get(expiry, 'latest'))
  const at = new Date(Date.parse(latest) + 1000).toISOString().replace('.000Z', 'Z')
  const options = {
    enabled: true,
    at,
    limit: 1,
    maxBatches: 1,
    quota: { windowSeconds: 3600, maximumRequestedEvents: 2 }
  }
  const expiredCount = async () => {
    const result = (
      await rows(input.database, [
        {
          sql: "SELECT count(*) AS count FROM analytics_client_events WHERE environment='local' AND policy_reference=?1 AND expires_at<=?2",
          bindings: [policy.reference, at]
        }
      ])
    )[0]![0]!
    return count(Reflect.get(result, 'count'))
  }
  const beforeExpired = await expiredCount()
  assert(beforeExpired >= 3, 'native_analytics_genuine_expired_events_required')
  await check('explicit_approved_retention_real_bounded_batch_host_callback', async () => {
    const result = await input.runRetention(options)
    assert.deepEqual(result, {
      enabled: true,
      environment: 'local',
      generatedAt: at,
      batches: 1,
      requested: 1,
      removed: 1,
      remainingExpired: beforeExpired - 1,
      quotaExhausted: false,
      financialContractsTouched: false
    })
    assert.equal(await expiredCount(), beforeExpired - 1)
  })
  await check('durable_retention_quota_not_a_claimed_zero', async () => {
    const result = await input.runRetention({ ...options, maxBatches: 2 })
    assert.deepEqual(result, {
      enabled: true,
      environment: 'local',
      generatedAt: at,
      batches: 1,
      requested: 1,
      removed: 1,
      remainingExpired: beforeExpired - 2,
      quotaExhausted: true,
      financialContractsTouched: false
    })
    const replay = await input.runRetention(options)
    assert.deepEqual(replay, {
      enabled: true,
      environment: 'local',
      generatedAt: at,
      batches: 0,
      requested: 0,
      removed: 0,
      remainingExpired: beforeExpired - 2,
      quotaExhausted: true,
      financialContractsTouched: false
    })
    const ledger = (
      await rows(input.database, [
        {
          sql: "SELECT count(*) AS count,COALESCE(sum(requested_limit),0) AS requested,COALESCE(sum(removed_count),0) AS removed FROM analytics_retention_runs WHERE environment='local' AND created_at=?",
          bindings: [at]
        }
      ])
    )[0]![0]!
    assert.equal(count(Reflect.get(ledger, 'count')), 2)
    assert.equal(count(Reflect.get(ledger, 'requested')), 2)
    assert.equal(count(Reflect.get(ledger, 'removed')), 2)
  })
  await check('financial_inventory_and_immutable_facts_unchanged_by_retention', async () => {
    assert.equal(await digest(input.database, inventoryQueries), beforeInventory)
    assert.equal(await digest(input.database, financialQueries), beforeFinancial)
    assert.equal(await digest(input.database, factQueries), retentionFactsDigest)
  })
  return {
    scenarios: checks.length,
    checks,
    sourceCount: pending.summary.sourceCount,
    projected: projection.projected,
    consentedEvents: ids.length,
    removedEvents: 2,
    financialDigest: beforeFinancial,
    inventoryDigest: beforeInventory,
    retentionFactsDigest,
    financialUnchanged: true,
    inventoryUnchanged: true,
    retentionFactsUnchanged: true,
    validationOnly: true,
    settlementCertified: false,
    browserFinancialAuthority: 'none',
    httpTransport: 'native_worker_fetch',
    maintenanceTransport: 'host_worker_compatible_native_d1',
    scheduledEntrypointExercised: false,
    queueEntrypointExercised: false,
    providerAuthority: false
  }
}
