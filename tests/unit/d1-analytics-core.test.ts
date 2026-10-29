import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, CLAIMS, BUYER_CLAIMS, ANALYTICS_CONSENT, pageEvent, utc } from './d1-analytics-fixture'
import {
  analyticsMeasurementPolicySchema,
  analyticsRangeSchema,
  analyticsSnapshotSchema
} from '../../shared/analytics-measurement'
import { collectClientAnalytics, withdrawAnalyticsSession } from '../../workers/analytics/collector'
import { analyticsPolicyFingerprint } from '../../workers/analytics/authority'
import {
  analyticsSourceClassificationSql,
  projectAnalyticsCommerceFacts
} from '../../workers/analytics/commerce-projection'
import { readAnalyticsSnapshot } from '../../workers/analytics/read-model'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  vi.restoreAllMocks()
})
async function fixture(options: Parameters<typeof analyticsFixture>[0] = {}) {
  const world = await analyticsFixture(options)
  connections.push(world.sqlite)
  return world
}
describe('first-party D1 analytics collector', () => {
  it.each(['/recursos', '/recursos/guia-publicada'])(
    'collects an explicitly consented canonical resource page %s exactly once',
    async (path) => {
      const world = await fixture(),
        event = pageEvent({ path })
      const result = await collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })
      expect(result).toMatchObject({ accepted: true, reason: 'accepted' })
      expect(result.cookie).not.toBeNull()
      expect(
        await collectClientAnalytics(world.deps, {
          event,
          consentCookie: ANALYTICS_CONSENT,
          anonymousCookie: result.cookie!.value
        })
      ).toMatchObject({ accepted: true, cookie: null })
      const rows = world.sqlite.prepare('SELECT name,properties_json,session_hash FROM analytics_client_events').all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        name: 'page_view',
        properties_json: JSON.stringify({ path }),
        session_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
      expect(JSON.stringify(rows)).not.toContain(result.cookie!.value)
    }
  )
  it.each(['/Recursos/guia-publicada', '/recursos-extra/guia-publicada', '/recursos/guia-publicada/privado'])(
    'does not widen resource measurement to noncanonical aliases %s',
    async (path) => {
      const world = await fixture()
      expect(
        await collectClientAnalytics(world.deps, {
          event: pageEvent({ path }),
          consentCookie: ANALYTICS_CONSENT
        })
      ).toMatchObject({ accepted: false, reason: 'event_excluded', cookie: null })
      expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_client_events').get()).toMatchObject({
        total: 0
      })
    }
  )
  it('keeps resource measurement consent-required and OFF without creating an anonymous session or event', async () => {
    const world = await fixture(),
      event = pageEvent({ path: '/recursos/guia-publicada' })
    expect(
      await collectClientAnalytics(world.deps, {
        event,
        consentCookie: JSON.stringify({ version: 'v1', analytics: false })
      })
    ).toMatchObject({ accepted: false, reason: 'consent_required', cookie: null })
    world.deps.enabled = false
    expect(await collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })).toMatchObject({
      accepted: false,
      reason: 'disabled',
      cookie: null
    })
    expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_client_events').get()).toMatchObject({
      total: 0
    })
  })
  it('OFF inspects neither payload nor database and never supplies a cookie; withdrawal still works', async () => {
    const world = await fixture()
    world.deps.enabled = false
    const prepare = vi.spyOn(world.deps.database, 'prepare'),
      batch = vi.spyOn(world.deps.database, 'batch')
    const input = {
      get event(): unknown {
        throw new Error('payload_inspected')
      }
    }
    expect(await collectClientAnalytics(world.deps, input)).toEqual({
      accepted: false,
      reason: 'disabled',
      cookie: null
    })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      enabled: false,
      complete: false,
      projected: 0
    })
    expect(withdrawAnalyticsSession()).toEqual({ name: 'neteco-analytics-id', value: '', maxAgeSeconds: 0 })
    expect(prepare).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
    expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_client_events').get()).toMatchObject({
      total: 0
    })
    expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_projection_runs').get()).toMatchObject({
      total: 0
    })
  })
  it.each([
    undefined,
    '',
    JSON.stringify({ version: 'v1', analytics: false }),
    JSON.stringify({ version: 'v2', analytics: true })
  ])('requires explicit v1 analytics consent %s', async (consentCookie) => {
    const world = await fixture()
    expect(await collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie })).toMatchObject({
      accepted: false,
      reason: 'consent_required',
      cookie: null
    })
  })
  it('stores a dedicated hashed pseudonym, no raw UUID/UA/PII; exact replay is idempotent', async () => {
    const world = await fixture(),
      event = pageEvent(),
      result = await collectClientAnalytics(world.deps, {
        event,
        consentCookie: ANALYTICS_CONSENT,
        userAgent: 'Synthetic browser'
      })
    expect(result.accepted).toBe(true)
    expect(result.cookie?.maxAgeSeconds).toBe(30 * 86400)
    expect(
      await collectClientAnalytics(world.deps, {
        event,
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: result.cookie!.value
      })
    ).toMatchObject({ accepted: true, cookie: null })
    const rows = world.sqlite.prepare('SELECT * FROM analytics_client_events').all()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(result.cookie!.value)
    expect(JSON.stringify(rows)).not.toContain('Synthetic browser')
    expect(rows[0]).toMatchObject({
      session_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      properties_json: '{"path":"/catalogo"}'
    })
  })
  it('does not reassign a replay without its original anonymous cookie to a new session', async () => {
    const world = await fixture(),
      event = pageEvent()
    await collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })
    await expect(collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })).rejects.toMatchObject(
      { code: 'idempotency_conflict' }
    )
  })
  it('conflicting payload for the same event ID cannot overwrite the original event', async () => {
    const world = await fixture(),
      event = pageEvent(),
      result = await collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })
    await expect(
      collectClientAnalytics(world.deps, {
        event: { ...event, properties: { path: '/buscar' } },
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: result.cookie!.value
      })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(world.sqlite.prepare('SELECT properties_json FROM analytics_client_events').get()).toMatchObject({
      properties_json: '{"path":"/catalogo"}'
    })
  })
  it('normalizes UUID casing accepted by the existing Node taxonomy without making a second event', async () => {
    const world = await fixture(),
      event = pageEvent(),
      result = await collectClientAnalytics(world.deps, {
        event: { ...event, eventId: event.eventId.toUpperCase() },
        consentCookie: ANALYTICS_CONSENT
      })
    expect(
      await collectClientAnalytics(world.deps, {
        event,
        consentCookie: ANALYTICS_CONSENT,
        anonymousCookie: result.cookie!.value
      })
    ).toMatchObject({ accepted: true, cookie: null })
    expect(world.sqlite.prepare('SELECT event_id FROM analytics_client_events').get()).toMatchObject({
      event_id: event.eventId
    })
  })
  it('accepts the existing search taxonomy without retaining free-form queries', async () => {
    const world = await fixture(),
      event = { ...pageEvent(), name: 'search_completed', properties: { query: 'limpiador sintético', resultCount: 2 } }
    await collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })
    expect(world.sqlite.prepare('SELECT properties_json FROM analytics_client_events').get()).toMatchObject({
      properties_json: '{"resultCount":2}'
    })
    expect(JSON.stringify(world.sqlite.prepare('SELECT * FROM analytics_client_events').all())).not.toContain(
      'limpiador'
    )
  })
  it.each(['/admin', '/cuenta/pedidos', '/newsletter/preferencias', '/preview', '/checkout', '/login'])(
    'excludes private/unknown route %s',
    async (path) => {
      const world = await fixture()
      expect(
        await collectClientAnalytics(world.deps, { event: pageEvent({ path }), consentCookie: ANALYTICS_CONSENT })
      ).toMatchObject({ accepted: false, reason: 'event_excluded', cookie: null })
    }
  )
  it.each(['buyer@example.invalid', '+34600111222', '12345678Z'])(
    'rejects likely PII in taxonomy input %s',
    async (query) => {
      const world = await fixture()
      await expect(
        collectClientAnalytics(world.deps, {
          event: { ...pageEvent(), name: 'search_completed', properties: { query, resultCount: 0 } },
          consentCookie: ANALYTICS_CONSENT
        })
      ).rejects.toMatchObject({ code: 'prohibited_data' })
    }
  )
  it('rejects invented financial events, extra fields, queries and stale timestamps', async () => {
    const world = await fixture()
    for (const event of [
      { ...pageEvent(), name: 'purchase' },
      { ...pageEvent(), email: 'buyer@example.invalid' },
      pageEvent({ path: '/catalogo?token=secret' })
    ])
      await expect(
        collectClientAnalytics(world.deps, { event, consentCookie: ANALYTICS_CONSENT })
      ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      collectClientAnalytics(world.deps, {
        event: { ...pageEvent(), occurredAt: utc(-2 * 86400000) },
        consentCookie: ANALYTICS_CONSENT
      })
    ).rejects.toMatchObject({ code: 'invalid_timestamp' })
  })
  it.each(['Googlebot/2.1', 'Bingbot/2.0', 'NativeAuditBot', 'Lighthouse', 'DuckDuckBot'])(
    'excludes known bot markers %s without storing UA',
    async (userAgent) => {
      const world = await fixture()
      expect(
        await collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT, userAgent })
      ).toMatchObject({ reason: 'bot_excluded', cookie: null })
      expect(world.sqlite.prepare('SELECT count(*) AS count FROM analytics_client_events').get()).toMatchObject({
        count: 0
      })
    }
  )
  it('excludes bots and fails closed on missing dedicated pseudonym key/policy', async () => {
    const world = await fixture()
    expect(
      await collectClientAnalytics(world.deps, {
        event: pageEvent(),
        consentCookie: ANALYTICS_CONSENT,
        userAgent: 'Googlebot crawler'
      })
    ).toMatchObject({ reason: 'bot_excluded', cookie: null })
    world.deps.sessionPepper = undefined
    await expect(
      collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT })
    ).rejects.toMatchObject({ code: 'configuration_unavailable' })
    world.deps.policy = null
    await expect(
      collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT })
    ).rejects.toMatchObject({ code: 'configuration_unavailable' })
  })
})
describe('authoritative commerce projection and read model', () => {
  it('projects actual sandbox capture/refund/fiscal contracts only into validation, with exact distinct definitions', async () => {
    const world = await fixture({ commerce: true, refund: true }),
      before = world.financialDigest()
    const projected = await projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 10 })
    expect(projected).toMatchObject({ projected: 3, pages: 3, remaining: 0, complete: true, validationOnly: true })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({ projected: 0, pages: 0, complete: true })
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(snapshot.coverage.status).toBe('complete')
    expect(snapshot.facts).toHaveLength(3)
    expect(snapshot.metrics).toMatchObject({
      grossCollectedCents: 1000,
      refundedCents: 500,
      collectedAfterRefundsCents: 500,
      issuedFiscalCents: 1000,
      settlementCertified: false
    })
    expect(snapshot.definitions.find((item) => item.key === 'collectedAfterRefundsCents')?.definition).toContain(
      'NO ventas netas'
    )
    expect(world.financialDigest()).toBe(before)
  })
  it('pagination gives global totals and all stable facts without truncating or recomputing from a slice', async () => {
    const world = await fixture({ commerce: true, refund: true })
    await projectAnalyticsCommerceFacts(world.deps)
    const first = await readAnalyticsSnapshot(world.deps, CLAIMS, { ...world.range(), perPage: 1 }),
      second = await readAnalyticsSnapshot(world.deps, CLAIMS, { ...world.range(), perPage: 1, page: 2 }),
      third = await readAnalyticsSnapshot(world.deps, CLAIMS, { ...world.range(), perPage: 1, page: 3 })
    expect(first.pagination).toMatchObject({ total: 3, pages: 3 })
    expect(second.metrics).toEqual(first.metrics)
    expect(
      new Set([...first.facts, ...second.facts, ...third.facts].map((fact) => `${fact.sourceKind}:${fact.sourceId}`))
        .size
    ).toBe(3)
    expect((await readAnalyticsSnapshot(world.deps, CLAIMS, { ...world.range(), perPage: 1, page: 4 })).facts).toEqual(
      []
    )
  })
  it('bounded projection leaves measurable backlog, unavailable values instead of false zero, then resumes', async () => {
    const world = await fixture({ commerce: true, refund: true })
    expect(await projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 1 })).toMatchObject({
      projected: 1,
      remaining: 2,
      complete: false
    })
    const partial = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(partial.coverage.status).toBe('partial')
    expect(partial.coverage.streams.reduce((count, stream) => count + stream.backlogCount, 0)).toBe(2)
    expect(
      [partial.metrics.grossCollectedCents, partial.metrics.refundedCents, partial.metrics.issuedFiscalCents].filter(
        (value) => value === null
      )
    ).toHaveLength(2)
    expect(await projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 10 })).toMatchObject({
      projected: 2,
      remaining: 0,
      complete: true
    })
  })
  it('production excludes authenticated sandbox and synthetic fiscal/refund sources; APP_ENV cannot turn them real', async () => {
    const world = await fixture({ commerce: true, refund: true })
    world.deps.environment = 'production'
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, environment: 'production' })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      projected: 0,
      remaining: 0,
      sourceUnavailable: 0
    })
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(snapshot.population).toEqual({ environment: 'production', validationOnly: false })
    expect(snapshot.facts).toEqual([])
    expect(snapshot.coverage.streams.every((stream) => stream.excludedCount === 1)).toBe(true)
    expect(snapshot.metrics.grossCollectedCents).toBe(0)
  })
  it('an unpaid order and browser event cannot create a server capture fact', async () => {
    const world = await fixture()
    await world.order({ paid: false })
    await collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({ projected: 0 })
    expect((await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())).metrics.capturedOrders).toBe(0)
  })
  it('concurrent projectors preserve one append-only fact per source', async () => {
    const world = await fixture({ commerce: true, refund: true })
    await Promise.all([
      projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 10 }),
      projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 10 })
    ])
    expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_commerce_facts').get()).toMatchObject({
      total: 3
    })
    expect(() => world.sqlite.exec('UPDATE analytics_commerce_facts SET gross_cents=0')).toThrow(
      'analytics_fact_immutable'
    )
    expect(() => world.sqlite.exec('DELETE FROM analytics_commerce_facts')).toThrow('analytics_fact_append_only')
  })
  it('requires live admin permission/MFA and does not write on any GET', async () => {
    const world = await fixture({ commerce: true }),
      before = world.financialDigest()
    await expect(readAnalyticsSnapshot(world.deps, BUYER_CLAIMS, world.range())).rejects.toMatchObject({
      code: 'mfa_required'
    })
    await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(world.sqlite.prepare('SELECT count(*) AS total FROM analytics_commerce_facts').get()).toMatchObject({
      total: 0
    })
    expect(world.financialDigest()).toBe(before)
    world.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
    await expect(readAnalyticsSnapshot(world.deps, CLAIMS, world.range())).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('rejects unavailable historical periods, invalid query shapes and invalid policy/environment', async () => {
    const world = await fixture()
    await expect(
      readAnalyticsSnapshot(world.deps, CLAIMS, {
        from: utc(-31 * 86400000),
        to: utc(-30 * 86400000),
        page: 1,
        perPage: 20
      })
    ).rejects.toMatchObject({ code: 'period_unavailable' })
    expect(analyticsRangeSchema.safeParse({ ...world.range(), perPage: 51 }).success).toBe(false)
    expect(analyticsRangeSchema.safeParse({ ...world.range(), from: '2026-02-30T00:00:00Z' }).success).toBe(false)
    world.deps.environment = 'production'
    await expect(projectAnalyticsCommerceFacts(world.deps)).rejects.toMatchObject({ code: 'configuration_unavailable' })
  })
  it('schemas bind validation population, nullable coverage and exact period facts', async () => {
    const world = await fixture({ commerce: true })
    await projectAnalyticsCommerceFacts(world.deps)
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(
      analyticsSnapshotSchema.safeParse({ ...snapshot, population: { environment: 'local', validationOnly: false } })
        .success
    ).toBe(false)
    expect(
      analyticsSnapshotSchema.safeParse({
        ...snapshot,
        facts: [{ ...snapshot.facts[0], occurredAt: world.range().to }]
      }).success
    ).toBe(false)
    expect(await analyticsPolicyFingerprint(world.deps.policy!)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('retention expires at the exact cutoff, rejects its inclusive period, and accepts +1 second', async () => {
    const world = await fixture({ commerce: true })
    const source = world.sqlite
      .prepare("SELECT occurred_at FROM analytics_commerce_sources WHERE source_kind='capture_applied'")
      .get()!
    const occurredAt = String(source.occurred_at),
      at = new Date(Date.parse(occurredAt) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, retentionDays: 1 })
    world.setNow(at)
    world.sqlite
      .prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?')
      .run(new Date(Date.parse(at) + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'), CLAIMS.sessionId)
    // Fiscal issuance can occur a second after capture while this real fixture
    // crosses a wall-clock boundary. It may still be retained; the assertion
    // concerns the capture's exact expiry, not every other source's lifetime.
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({ remaining: 0 })
    expect(
      world.sqlite
        .prepare("SELECT count(*) AS total FROM analytics_commerce_facts WHERE source_kind='capture_applied'")
        .get()
    ).toMatchObject({ total: 0 })
    expect(
      world.sqlite.prepare('SELECT count(*) AS total FROM analytics_commerce_facts WHERE expires_at<=?').get(at)
    ).toMatchObject({ total: 0 })
    const exact = { from: occurredAt, to: at, page: 1, perPage: 20 }
    await expect(readAnalyticsSnapshot(world.deps, CLAIMS, exact)).rejects.toMatchObject({ code: 'period_unavailable' })
    const inside = new Date(Date.parse(occurredAt) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect((await readAnalyticsSnapshot(world.deps, CLAIMS, { ...exact, from: inside })).metrics.capturedOrders).toBe(0)
  })
  it('rechecks retention with a fresh clock after source selection and never appends an already expired fact', async () => {
    const world = await fixture({ commerce: true })
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, retentionDays: 1 })
    const sourceAt = String(
      world.sqlite.prepare('SELECT min(occurred_at) AS at FROM analytics_commerce_sources').get()!.at
    )
    const expiry = new Date(Date.parse(sourceAt) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    world.setNow(new Date(Date.parse(expiry) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    const prepare = world.deps.database.prepare.bind(world.deps.database)
    vi.spyOn(world.deps.database, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (sql.includes('SELECT s.source_kind AS sourceKind')) {
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation(async <T>() => {
          const rows = await all<T>()
          world.setNow(expiry)
          return rows
        })
      }
      return statement
    })
    await projectAnalyticsCommerceFacts(world.deps, { limit: 1, maxPages: 1 })
    expect(
      world.sqlite.prepare('SELECT count(*) AS count FROM analytics_commerce_facts WHERE expires_at<=?').get(expiry)
    ).toMatchObject({ count: 0 })
  })
  it('a second authorization marker makes provenance unavailable rather than silently ignoring contradictions', async () => {
    const world = await fixture({ commerce: true })
    const original = world.sqlite
      .prepare(
        "SELECT order_id,payload_json,created_at FROM order_events WHERE event_type='payment_provider_authorised'"
      )
      .get()!
    world.sqlite
      .prepare(
        "INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at) VALUES(?,?,'payment_provider_authorised',?,'synthetic-contradiction',?)"
      )
      .run(
        `order-event:${crypto.randomUUID()}`,
        String(original.order_id),
        String(original.payload_json),
        String(original.created_at)
      )
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      projected: 1,
      sourceUnavailable: 1,
      complete: false
    })
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(snapshot.metrics.grossCollectedCents).toBeNull()
    expect(snapshot.metrics.capturedOrders).toBeNull()
    expect(snapshot.coverage.streams.find((stream) => stream.kind === 'capture_applied')).toMatchObject({
      unconfirmedCount: 1,
      projectedCount: 0,
      provenance: 'legacy_capture_unavailable'
    })
  })
  it('expired client events are not counted even before a separately governed retention run', async () => {
    const world = await fixture()
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, retentionDays: 1 })
    const result = await collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT })
    const expiry = String(world.sqlite.prepare('SELECT expires_at FROM analytics_client_events').get()!.expires_at)
    world.setNow(expiry)
    world.sqlite
      .prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?')
      .run(new Date(Date.parse(expiry) + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'), CLAIMS.sessionId)
    const from = new Date(Date.parse(expiry) - 86399000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      to = new Date(Date.parse(expiry) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, { from, to, page: 1, perPage: 20 })
    expect(snapshot.browser.uniqueSessions).toBe(0)
    expect(snapshot.browser.eventCounts.every((event) => event.count === 0)).toBe(true)
    expect(result.cookie!.maxAgeSeconds).toBe(86400)
  })
  it.each(['2026-02-30T00:00:00Z', '2026-10-03T24:00:00Z', '2026-10-03T01:00:00+01:00', 'not-a-date'])(
    'SQLite rejects NULL-passing/noncanonical instant %s',
    async (instant) => {
      const world = await fixture()
      expect(() =>
        world.sqlite
          .prepare(
            'INSERT INTO analytics_projection_runs(id,environment,policy_fingerprint,examined,projected,created_at) VALUES(?,?,?,0,0,?)'
          )
          .run(crypto.randomUUID(), 'local', 'a'.repeat(64), instant)
      ).toThrow()
    }
  )
  it.each(['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), ''])(
    'SQLite rejects malformed hash %s',
    async (fingerprint) => {
      const world = await fixture()
      expect(() =>
        world.sqlite
          .prepare(
            'INSERT INTO analytics_projection_runs(id,environment,policy_fingerprint,examined,projected,created_at) VALUES(?,?,?,0,0,?)'
          )
          .run(crypto.randomUUID(), 'local', fingerprint, utc())
      ).toThrow()
    }
  )
  it('SQLite preserves append-only dedup rows against direct REPLACE and rejects extra/PII property keys', async () => {
    const world = await fixture()
    await collectClientAnalytics(world.deps, { event: pageEvent(), consentCookie: ANALYTICS_CONSENT })
    expect(() =>
      world.sqlite.exec('INSERT OR REPLACE INTO analytics_client_events SELECT * FROM analytics_client_events')
    ).toThrow('analytics_event_key_conflict')
    expect(() => world.sqlite.exec('UPDATE analytics_client_events SET session_hash=payload_hash')).toThrow(
      'analytics_event_immutable'
    )
    const columns =
      'event_id,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at'
    for (const properties of [
      '{"query":null}',
      '{"email":"buyer@example.invalid"}',
      '{"path":"/catalogo","unknown":"bearer-value"}'
    ])
      expect(() =>
        world.sqlite
          .prepare(
            `INSERT INTO analytics_client_events(${columns}) SELECT ?,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,?,payload_hash,occurred_at,received_at,expires_at FROM analytics_client_events LIMIT 1`
          )
          .run(crypto.randomUUID(), properties)
      ).toThrow()
  })
  it('direct fact insertion cannot claim a foreign ID or production population from a synthetic source', async () => {
    const world = await fixture({ commerce: true })
    await projectAnalyticsCommerceFacts(world.deps)
    expect(() =>
      world.sqlite.exec(
        "INSERT INTO analytics_commerce_facts SELECT 'production',source_kind,source_id,order_id,'real',currency,gross_cents,net_cents,tax_cents,shipping_gross_cents,source_fingerprint,policy_fingerprint,occurred_at,projected_at,expires_at FROM analytics_commerce_facts LIMIT 1"
      )
    ).toThrow('analytics_source_unconfirmed')
    expect(() =>
      world.sqlite
        .prepare(
          'INSERT INTO analytics_commerce_facts SELECT environment,source_kind,?,order_id,population,currency,gross_cents,net_cents,tax_cents,shipping_gross_cents,source_fingerprint,policy_fingerprint,occurred_at,projected_at,expires_at FROM analytics_commerce_facts LIMIT 1'
        )
        .run(crypto.randomUUID())
    ).toThrow('analytics_source_unconfirmed')
  })
  it('a longer new policy cannot revive expired append-only facts or claim a complete projection', async () => {
    const world = await fixture({ commerce: true })
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, retentionDays: 1 })
    await projectAnalyticsCommerceFacts(world.deps)
    const at = String(world.sqlite.prepare('SELECT max(expires_at) AS at FROM analytics_commerce_facts').get()!.at)
    world.setNow(at)
    world.sqlite
      .prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?')
      .run(new Date(Date.parse(at) + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'), CLAIMS.sessionId)
    world.deps.policy = analyticsMeasurementPolicySchema.parse({
      ...world.deps.policy,
      version: 'fixture-v2',
      retentionDays: 30
    })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      projected: 0,
      remaining: 2,
      complete: false
    })
    const from = new Date(Date.parse(at) - 2 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      to = new Date(Date.parse(at) + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, { from, to, page: 1, perPage: 20 })
    expect(snapshot.metrics.grossCollectedCents).toBeNull()
    expect(snapshot.metrics.issuedFiscalCents).toBeNull()
    expect(snapshot.coverage.status).toBe('unavailable')
    expect(world.sqlite.prepare('SELECT count(*) AS count FROM analytics_commerce_facts').get()).toMatchObject({
      count: 2
    })
  })
  it('revocation after the native snapshot prevents private data release without manufacturing an empty permitted view', async () => {
    const world = await fixture({ commerce: true })
    await projectAnalyticsCommerceFacts(world.deps)
    const batch = world.deps.database.batch.bind(world.deps.database)
    vi.spyOn(world.deps.database, 'batch').mockImplementation(async (statements) => {
      const result = await batch(statements)
      world.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
      return result
    })
    await expect(readAnalyticsSnapshot(world.deps, CLAIMS, world.range())).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('strong snapshot DTO rejects non-null cash with incomplete coverage and invented settlement definitions', async () => {
    const world = await fixture({ commerce: true })
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(
      analyticsSnapshotSchema.safeParse({
        ...snapshot,
        metrics: { ...snapshot.metrics, grossCollectedCents: 0, capturedOrders: 0 }
      }).success
    ).toBe(false)
    expect(
      analyticsSnapshotSchema.safeParse({
        ...snapshot,
        definitions: snapshot.definitions.map((item) =>
          item.key === 'grossCollectedCents' ? { ...item, definition: 'Bank settlement certified.' } : item
        )
      }).success
    ).toBe(false)
  })
  it.each(['planned', 'confirmed'] as const)(
    'an unsubmitted refund %s is not invented as an ambiguous provider effect',
    async (stage) => {
      const world = await fixture({ commerce: true })
      await world.refundScenario(stage)
      expect(world.sqlite.prepare('SELECT submitted_at FROM refund_work').get()).toMatchObject({ submitted_at: null })
      await projectAnalyticsCommerceFacts(world.deps)
      const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
      expect(snapshot.metrics.refundedCents).toBe(0)
      expect(snapshot.coverage.streams.find((stream) => stream.kind === 'refund_confirmed')).toMatchObject({
        sourceCount: 0,
        unconfirmedCount: 0
      })
    }
  )
  it('production excludes synthetic ambiguity before proof checks, while unknown capture still blocks real totals', async () => {
    const world = await fixture({ commerce: true })
    await world.refundScenario('ambiguous')
    world.deps.environment = 'production'
    world.deps.policy = analyticsMeasurementPolicySchema.parse({ ...world.deps.policy, environment: 'production' })
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      projected: 0,
      sourceUnavailable: 0,
      complete: true
    })
    expect(
      (await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())).coverage.streams.every(
        (stream) => stream.excludedCount === 1
      )
    ).toBe(true)
    const original = world.sqlite
      .prepare(
        "SELECT order_id,payload_json,created_at FROM order_events WHERE event_type='payment_provider_authorised'"
      )
      .get()!
    world.sqlite
      .prepare(
        "INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at) VALUES(?,?,'payment_provider_authorised',?,'synthetic-unknown-authority',?)"
      )
      .run(
        `order-event:${crypto.randomUUID()}`,
        String(original.order_id),
        String(original.payload_json),
        String(original.created_at)
      )
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(snapshot.metrics.grossCollectedCents).toBeNull()
    expect(snapshot.metrics.refundedCents).toBe(0)
    expect(snapshot.metrics.collectedAfterRefundsCents).toBeNull()
    expect(snapshot.coverage.streams.find((stream) => stream.kind === 'capture_applied')).toMatchObject({
      unconfirmedCount: 1,
      excludedCount: 0
    })
  })
  it.each(['unexpected', 'unknown', null])(
    'unrecognized provider authority %s is never eligible or silently excluded',
    async (providerEnvironment) => {
      const world = await fixture()
      const row = world.sqlite
        .prepare(
          `WITH s AS (SELECT 1 AS proof_valid,? AS provider_environment,0 AS validation_only)
      SELECT ${analyticsSourceClassificationSql('production')} AS classification FROM s`
        )
        .get(providerEnvironment)
      expect(row).toMatchObject({ classification: 'unconfirmed' })
    }
  )
  it('a genuinely submitted refund with a lost provider response blocks cash totals without automatic retry or fake success', async () => {
    const world = await fixture({ commerce: true })
    await world.refundScenario('ambiguous')
    expect(world.sqlite.prepare('SELECT status,submitted_at FROM refund_work').get()).toMatchObject({
      status: 'uncertain',
      submitted_at: expect.any(String)
    })
    expect(world.sqlite.prepare('SELECT count(*) AS count FROM refund_fake_effects').get()).toMatchObject({ count: 1 })
    const before = world.financialDigest()
    expect(await projectAnalyticsCommerceFacts(world.deps)).toMatchObject({
      projected: 2,
      sourceUnavailable: 1,
      complete: false
    })
    const snapshot = await readAnalyticsSnapshot(world.deps, CLAIMS, world.range())
    expect(snapshot.metrics).toMatchObject({
      grossCollectedCents: 1000,
      refundedCents: null,
      confirmedRefunds: null,
      collectedAfterRefundsCents: null,
      issuedFiscalCents: 1000
    })
    expect(snapshot.coverage.streams.find((stream) => stream.kind === 'refund_confirmed')).toMatchObject({
      sourceCount: 1,
      unconfirmedCount: 1,
      projectedCount: 0
    })
    expect(world.financialDigest()).toBe(before)
    expect(world.sqlite.prepare('SELECT count(*) AS count FROM refund_fake_effects').get()).toMatchObject({ count: 1 })
  })
})
