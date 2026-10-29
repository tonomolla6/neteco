import { afterEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { enqueueEmailOutbox } from '../../workers/communications/email-outbox'

const NOW = '2030-01-02T12:00:00Z'
afterEach(() => vi.restoreAllMocks())
async function world(failedSql: string) {
  const sqlite = await openMigratedDatabase(),
    database = d1OverSqlite(sqlite)
  // A real persisted transport obligation. Domain event atomicity is exercised
  // by checkout/payment tests; this reproduction isolates scheduled dispatch.
  const { eventId } = await enqueueEmailOutbox(database, {
    sourceEventId: '10000000-0000-4000-8000-000000000002',
    sourceKind: 'order',
    sourceId: '20000000-0000-4000-8000-000000000002',
    eventType: 'order.created',
    now: NOW
  })
  const fault = vi.fn(),
    send = vi.fn(async () => undefined),
    provider = vi.fn(),
    outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_forbidden'))
  let failed = false
  const isolatedDatabase = {
    ...database,
    prepare(sql: string) {
      if (!failed && sql.includes(failedSql)) {
        failed = true
        fault()
        throw new Error('synthetic_independent_stage_unavailable')
      }
      return database.prepare(sql)
    }
  } as D1Database
  const env = {
    APP_ENV: 'local',
    AUTH_ENABLED: 'false',
    DB: isolatedDatabase,
    ASYNC_JOBS: { send },
    MEDIA: {},
    EMAIL: { send: provider },
    NEWSLETTER_EMAIL: { send: provider },
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    AUTH_EMAIL_ENABLED: 'false',
    NEWSLETTER_ENABLED: 'false'
  } as unknown as CloudflareEnv
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const tick = (seconds = 0) =>
    worker.scheduled({ scheduledTime: Date.parse(NOW) + seconds * 1000 } as ScheduledController, env)
  return { sqlite, eventId, fault, send, provider, outbound, log, tick }
}
it('a fiscal D1 failure remains observable but cannot starve an independently committed email outbox', async () => {
  const f = await world('UPDATE fiscal_outbox_delivery')
  try {
    const failure = await f.tick().catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('scheduled_jobs_failed:fiscal.outbox')
    expect((failure as AggregateError).errors).toHaveLength(1)
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: 'synthetic_independent_stage_unavailable' })
    expect(f.fault).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'email.dispatch.requested', version: 1, eventId: f.eventId })
    expect(f.sqlite.prepare('SELECT status,attempts FROM email_outbox_delivery').get()).toEqual({
      status: 'published',
      attempts: 1
    })
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.outbound).not.toHaveBeenCalled()
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('synthetic_independent_stage_unavailable')
  } finally {
    f.sqlite.close()
  }
})
it('a failure after email publication rejects the tick, permits later independent work, and never republishes on the next tick', async () => {
  const f = await world('UPDATE identity_lifecycle_deliveries')
  try {
    await expect(f.tick()).rejects.toThrow('scheduled_jobs_failed:email.identity')
    expect(f.fault).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'email.dispatch.requested', version: 1, eventId: f.eventId })
    expect(
      f.log.mock.calls.some(([value]) => JSON.parse(String(value)).event === 'analytics.maintenance.dispatch')
    ).toBe(true)
    await expect(f.tick(60)).resolves.toBeUndefined()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.sqlite.prepare('SELECT status,attempts FROM email_outbox_delivery').get()).toEqual({
      status: 'published',
      attempts: 1
    })
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.outbound).not.toHaveBeenCalled()
  } finally {
    f.sqlite.close()
  }
})
