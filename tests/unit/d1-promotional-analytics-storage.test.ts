import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { analyticsFixture, ANALYTICS_CONSENT, CLAIMS, pageEvent, utc } from './d1-analytics-fixture'
import { collectClientAnalytics } from '../../workers/analytics/collector'
import { readAnalyticsSnapshot } from '../../workers/analytics/read-model'
import { dispatchAnalyticsRetention } from '../../workers/analytics/retention'
import { testUuid } from '../support/deterministic'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
})
const migration = new URL('../../db/d1/migrations/0081_promotional_analytics.sql', import.meta.url)
const anonymousCookie = '20000000-0000-4000-8000-000000000091'
const pageId = '20000000-0000-4000-8000-000000000092'
const publicationId = '20000000-0000-4000-8000-000000000093'
function promotionalEvent(name = 'promotional_impression') {
  return {
    eventId: testUuid(),
    taxonomyVersion: 'v1',
    name,
    occurredAt: utc(),
    properties: {
      pageId,
      publicationId,
      version: 1,
      placement: 'home',
      blockId: name === 'promotional_impression' ? null : '20000000-0000-4000-8000-000000000094'
    }
  }
}
async function fixture() {
  const f = await analyticsFixture()
  connections.push(f.sqlite)
  if (
    existsSync(migration) &&
    !f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='analytics_promotional_events'").get()
  )
    f.sqlite.exec(await readFile(migration, 'utf8'))
  return f
}
const maintenance = {
  enabled: true,
  limit: 3,
  maxBatches: 1,
  quota: { windowSeconds: 3600, maximumRequestedEvents: 100 }
}
function collect(f: Awaited<ReturnType<typeof fixture>>, event: unknown) {
  return collectClientAnalytics(f.deps, { event, consentCookie: ANALYTICS_CONSENT, anonymousCookie })
}
describe('additive promotional telemetry storage and global retention', () => {
  it('adds the separate table/view without rebuilding or changing historical client rows', async () => {
    const f = await analyticsFixture({ promotional: false })
    connections.push(f.sqlite)
    // Populate the pre-migration table through the existing strict row contract.
    // The current collector requires the new global view, so seed this isolated
    // legacy storage row directly before applying the additive migration.
    f.sqlite
      .prepare(
        `INSERT INTO analytics_client_events VALUES(?, 'page_view', ?, 'local', 'synthetic-local-measurement', 'fixture-v1', ?, '{"path":"/catalogo"}', ?, ?, ?, ?)`
      )
      .run(testUuid(), 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), utc(), utc(), utc(86400000))
    const schema = f.sqlite
      .prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='analytics_client_events' ORDER BY name")
      .all()
    const before = f.sqlite.prepare('SELECT * FROM analytics_client_events ORDER BY event_id').all()
    if (existsSync(migration)) f.sqlite.exec(await readFile(migration, 'utf8'))
    expect(
      f.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name='analytics_promotional_events'").get()
    ).toBeDefined()
    const currentSchema = f.sqlite
      .prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='analytics_client_events' ORDER BY name")
      .all()
    expect(currentSchema.filter((row) => row.name !== 'analytics_client_cross_key')).toEqual(schema)
    expect(currentSchema.filter((row) => row.name === 'analytics_client_cross_key')).toEqual([
      expect.objectContaining({ type: 'trigger', name: 'analytics_client_cross_key' })
    ])
    expect(f.sqlite.prepare('SELECT * FROM analytics_client_events ORDER BY event_id').all()).toEqual(before)
    expect(f.sqlite.prepare('SELECT * FROM analytics_browser_events ORDER BY event_id').all()).toEqual(before)
  })
  it('routes both new names without changing legacy rows, and exact replay is globally idempotent', async () => {
    const f = await fixture()
    await collect(f, pageEvent())
    const old = f.sqlite.prepare('SELECT * FROM analytics_client_events').all()
    for (const name of ['promotional_impression', 'promotional_click']) {
      const event = promotionalEvent(name)
      expect(await collect(f, event)).toMatchObject({ accepted: true, cookie: null })
      expect(await collect(f, event)).toMatchObject({ accepted: true, cookie: null })
    }
    expect(f.sqlite.prepare('SELECT * FROM analytics_client_events').all()).toEqual(old)
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_promotional_events').get()).toEqual({ n: 2 })
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_browser_events').get()).toEqual({ n: 3 })
    expect(() => f.sqlite.exec("UPDATE analytics_promotional_events SET name='promotional_click'")).toThrow()
  })
  it('rejects cross-name event ID reuse in both directions without inserting a second row', async () => {
    const f = await fixture(),
      original = pageEvent()
    await collect(f, original)
    await expect(collect(f, { ...promotionalEvent(), eventId: original.eventId })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    const promo = promotionalEvent()
    await collect(f, promo)
    await expect(collect(f, { ...pageEvent(), eventId: promo.eventId })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_browser_events').get()).toEqual({ n: 2 })
    const columns =
      'event_id,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at'
    expect(() =>
      f.sqlite.exec(
        `INSERT INTO analytics_promotional_events(${columns}) SELECT event_id,'promotional_impression',session_hash,environment,policy_reference,policy_version,policy_fingerprint,'${JSON.stringify(promotionalEvent().properties)}',payload_hash,occurred_at,received_at,expires_at FROM analytics_client_events`
      )
    ).toThrow()
    expect(() =>
      f.sqlite.exec(
        `INSERT INTO analytics_client_events(${columns}) SELECT event_id,'page_view',session_hash,environment,policy_reference,policy_version,policy_fingerprint,'{"path":"/"}',payload_hash,occurred_at,received_at,expires_at FROM analytics_promotional_events`
      )
    ).toThrow()
  })
  it('keeps promotional properties bounded and whitelisted at the database boundary', async () => {
    const f = await fixture()
    await collect(f, promotionalEvent())
    const insert = f.sqlite.prepare(
      `INSERT INTO analytics_promotional_events SELECT ?,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,?,payload_hash,occurred_at,received_at,expires_at FROM analytics_promotional_events LIMIT 1`
    )
    for (const properties of [
      { ...promotionalEvent().properties, url: '/private' },
      { ...promotionalEvent().properties, version: 0 },
      { ...promotionalEvent().properties, blockId: publicationId },
      { ...promotionalEvent().properties, placement: 'unknown' }
    ])
      expect(() => insert.run(testUuid(), JSON.stringify(properties))).toThrow()
  })
  it('reads both families as client-reported counts with one anonymous session and no financial authority', async () => {
    const f = await fixture()
    await collect(f, pageEvent())
    await collect(f, promotionalEvent())
    await collect(f, promotionalEvent('promotional_click'))
    const before = f.financialDigest()
    const read = await readAnalyticsSnapshot(f.deps, CLAIMS, f.range())
    expect(read.browser).toMatchObject({ uniqueSessions: 1, financialAuthority: 'none' })
    for (const name of ['page_view', 'promotional_impression', 'promotional_click'])
      expect(read.browser.eventCounts.find((row) => row.name === name)?.count).toBe(1)
    expect(f.financialDigest()).toBe(before)
  })
  it('uses one global retention limit across both tables and preserves financial rows', async () => {
    const f = await fixture()
    for (let index = 0; index < 5; index++) await collect(f, index % 2 ? promotionalEvent() : pageEvent())
    const before = f.financialDigest()
    f.setNow(utc(31 * 86400000))
    expect(await dispatchAnalyticsRetention(f.deps, maintenance)).toMatchObject({
      removed: 3,
      remainingExpired: 2,
      requested: 3
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_browser_events').get()).toEqual({ n: 2 })
    expect(await dispatchAnalyticsRetention(f.deps, maintenance)).toMatchObject({ removed: 2, remainingExpired: 0 })
    expect(f.financialDigest()).toBe(before)
  })
  it('rolls back both deletions and retention evidence if the second family delete fails', async () => {
    const f = await fixture()
    await collect(f, pageEvent())
    await collect(f, promotionalEvent())
    const before = f.sqlite.prepare('SELECT * FROM analytics_browser_events ORDER BY event_id').all()
    f.setNow(utc(31 * 86400000))
    f.sqlite.exec(
      "CREATE TRIGGER synthetic_promotional_delete_failure BEFORE DELETE ON analytics_promotional_events BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END"
    )
    await expect(dispatchAnalyticsRetention(f.deps, maintenance)).rejects.toMatchObject({ code: 'service_unavailable' })
    expect(f.sqlite.prepare('SELECT * FROM analytics_browser_events ORDER BY event_id').all()).toEqual(before)
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_retention_runs').get()).toEqual({ n: 0 })
  })
  it('caps one mixed-family retention batch at exactly 100 selected events', async () => {
    const f = await fixture()
    await collect(f, pageEvent())
    await collect(f, promotionalEvent())
    for (let index = 0; index < 99; index++) {
      const table = index % 2 ? 'analytics_client_events' : 'analytics_promotional_events'
      f.sqlite
        .prepare(
          `INSERT INTO ${table} SELECT ?,name,session_hash,environment,policy_reference,policy_version,policy_fingerprint,properties_json,payload_hash,occurred_at,received_at,expires_at FROM ${table} LIMIT 1`
        )
        .run(testUuid())
    }
    f.setNow(utc(31 * 86400000))
    expect(await dispatchAnalyticsRetention(f.deps, { ...maintenance, limit: 100 })).toMatchObject({
      removed: 100,
      remainingExpired: 1
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM analytics_browser_events').get()).toEqual({ n: 1 })
    expect(f.sqlite.prepare('SELECT requested_limit,removed_count FROM analytics_retention_runs').get()).toEqual({
      requested_limit: 100,
      removed_count: 100
    })
  })
})
