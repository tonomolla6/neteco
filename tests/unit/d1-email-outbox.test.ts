import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { d1OverSqlite } from '../support/d1-sqlite'
import {
  enqueueEmailOutbox,
  prepareEmailOutboxEnqueue,
  publishEmailOutbox,
  receiveEmailDispatch,
  reconcileEmailOutbox,
  type EmailDispatchMessage,
  type EmailOutboxInput
} from '../../workers/communications/email-outbox'

const MIGRATION = fileURLToPath(new URL('../../db/d1/migrations/0027_email_outbox.sql', import.meta.url))
const DELIVERY_MIGRATION = fileURLToPath(
  new URL('../../db/d1/migrations/0031_transactional_email_delivery.sql', import.meta.url)
)
const NOW = '2026-09-29T10:00:00Z'
const EVENT_A = '11111111-1111-4111-8111-111111111111'
const EVENT_B = '11111111-1111-4111-8111-111111111112'
const ORDER_A = '22222222-2222-4222-8222-222222222222'
const ORDER_B = '22222222-2222-4222-8222-222222222223'
const base: EmailOutboxInput = {
  sourceEventId: EVENT_A,
  sourceKind: 'order',
  sourceId: ORDER_A,
  eventType: 'order.created',
  now: NOW
}

const opened: DatabaseSync[] = []
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

async function world() {
  const sqlite = new DatabaseSync(':memory:')
  opened.push(sqlite)
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec(await readFile(MIGRATION, 'utf8'))
  sqlite.exec(await readFile(DELIVERY_MIGRATION, 'utf8'))
  return { sqlite, database: d1OverSqlite(sqlite) }
}

describe('D1 transactional email outbox transport', () => {
  it('stores one immutable, PII-free reference for replayed domain events', async () => {
    const { sqlite, database } = await world()
    const first = await enqueueEmailOutbox(database, base)
    expect(first).toMatchObject({ outcome: 'enqueued' })
    expect(first.eventId).toMatch(/^email:[0-9a-f]{64}$/)
    expect(await enqueueEmailOutbox(database, { ...base, now: '2026-09-29T10:00:01Z' })).toEqual({
      outcome: 'replayed',
      eventId: first.eventId
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM email_outbox_delivery').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT status, attempts FROM email_outbox_delivery').get()).toEqual({
      status: 'ready',
      attempts: 0
    })
    expect(sqlite.prepare('SELECT * FROM email_outbox_events').get()).toEqual({
      id: first.eventId,
      source_event_id: EVENT_A,
      event_type: 'order.created',
      source_kind: 'order',
      source_id: ORDER_A,
      schema_version: 1,
      created_at: NOW
    })
    expect(() => sqlite.exec('UPDATE email_outbox_events SET source_id = source_id')).toThrow('immutable')
    expect(() => sqlite.exec('DELETE FROM email_outbox_events')).toThrow('immutable')
  })

  it('rejects changed replay references, non-opaque references and marketing events', async () => {
    const { sqlite, database } = await world()
    await enqueueEmailOutbox(database, base)
    await expect(enqueueEmailOutbox(database, { ...base, sourceId: ORDER_B })).rejects.toThrow(
      'email_outbox_replay_conflict'
    )
    await expect(enqueueEmailOutbox(database, { ...base, sourceId: 'buyer@example.invalid' })).rejects.toThrow(
      'invalid_email_outbox_reference'
    )
    await expect(enqueueEmailOutbox(database, { ...base, sourceKind: 'identity' })).rejects.toThrow(
      'invalid_email_outbox_event'
    )
    await expect(
      enqueueEmailOutbox(database, { ...base, eventType: 'newsletter.welcome' as EmailOutboxInput['eventType'] })
    ).rejects.toThrow('invalid_email_outbox_event')
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO email_outbox_events
           (id, source_event_id, event_type, source_kind, source_id, schema_version, created_at)
           VALUES (?, ?, 'order.created', 'order', ?, 1, ?)`
        )
        .run(`email:${'a'.repeat(64)}`, 'buyer@example.invalid', ORDER_A, NOW)
    ).toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()!.n).toBe(1)
  })

  it('can commit source mutation and outbox statement atomically in one D1 batch', async () => {
    const { sqlite, database } = await world()
    sqlite.exec('CREATE TABLE source_events (id TEXT PRIMARY KEY) STRICT')
    const first = await prepareEmailOutboxEnqueue(database, base)
    await database.batch([
      database.prepare('INSERT INTO source_events (id) VALUES (?1)').bind(EVENT_A),
      first.statement
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM source_events').get()!.n).toBe(1)
    const conflicting = await prepareEmailOutboxEnqueue(database, { ...base, sourceId: ORDER_B })
    await expect(
      database.batch([
        database.prepare('INSERT INTO source_events (id) VALUES (?1)').bind(EVENT_B),
        conflicting.statement
      ])
    ).rejects.toThrow('email_outbox_replay_conflict')
    expect(sqlite.prepare('SELECT count(*) AS n FROM source_events').get()!.n).toBe(1)
  })

  it('fails closed without Queue, then atomically records receipt and durable pending provider work', async () => {
    const { sqlite, database } = await world()
    const { eventId } = await enqueueEmailOutbox(database, base)
    await expect(publishEmailOutbox(database, undefined as never, { now: NOW })).rejects.toThrow(
      'email_queue_unavailable'
    )
    expect(sqlite.prepare('SELECT status, attempts FROM email_outbox_delivery').get()).toEqual({
      status: 'ready',
      attempts: 0
    })
    const message: EmailDispatchMessage = { type: 'email.dispatch.requested', version: 1, eventId }
    expect(await receiveEmailDispatch(database, message, NOW)).toBe('not_ready')
    const sent: EmailDispatchMessage[] = []
    expect(
      await publishEmailOutbox(database, { send: async (payload) => void sent.push(payload) }, { now: NOW })
    ).toEqual({ published: 1, retryable: 0, lostLease: 0, manualReview: 0 })
    expect(sent).toEqual([message])
    expect(await receiveEmailDispatch(database, sent[0], NOW)).toBe('stored')
    expect(await receiveEmailDispatch(database, sent[0], NOW)).toBe('replayed')
    expect(sqlite.prepare('SELECT status FROM email_dispatch_inbox').get()).toEqual({
      status: 'blocked_provider'
    })
    expect(sqlite.prepare('SELECT event_id, status, attempts FROM transactional_email_deliveries').get()).toEqual({
      event_id: eventId,
      status: 'pending',
      attempts: 0
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM transactional_email_deliveries').get()!.n).toBe(1)
    expect(await reconcileEmailOutbox(database, { now: '2026-09-29T11:00:00Z' })).toEqual({
      requeued: 0,
      manualReview: 0
    })
  })

  it('routes a published email message through the canary Queue consumer without sending email', async () => {
    const { sqlite, database } = await world()
    await enqueueEmailOutbox(database, base)
    const sent: EmailDispatchMessage[] = []
    await publishEmailOutbox(database, { send: async (message) => void sent.push(message) }, { now: NOW })
    const ack = vi.fn()
    const retry = vi.fn()
    await worker.queue!(
      { messages: [{ body: sent[0], ack, retry }] } as unknown as MessageBatch,
      { DB: database } as CloudflareEnv
    )
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT status FROM email_dispatch_inbox').get()).toEqual({ status: 'blocked_provider' })
  })

  it('retries Queue failures without storing thrown content, then requires manual review', async () => {
    const { sqlite, database } = await world()
    await enqueueEmailOutbox(database, base)
    const failedQueue = {
      send: async () => {
        throw new Error('secret=provider-credential recipient=buyer@example.invalid')
      }
    }
    expect(await publishEmailOutbox(database, failedQueue, { now: NOW })).toMatchObject({ retryable: 1 })
    expect(
      sqlite.prepare('SELECT status, attempts, available_at, last_error_code FROM email_outbox_delivery').get()
    ).toEqual({
      status: 'ready',
      attempts: 1,
      available_at: '2026-09-29T10:00:30Z',
      last_error_code: 'queue_send_failed'
    })
    expect(await publishEmailOutbox(database, failedQueue, { now: '2026-09-29T10:00:29Z' })).toMatchObject({
      retryable: 0
    })
    sqlite.exec("UPDATE email_outbox_delivery SET attempts = 9, available_at = '2026-09-29T10:00:00Z'")
    expect(await publishEmailOutbox(database, failedQueue, { now: NOW })).toMatchObject({ manualReview: 1 })
    const state = sqlite.prepare('SELECT status, attempts, last_error_code FROM email_outbox_delivery').get()
    expect(state).toEqual({ status: 'manual_review', attempts: 10, last_error_code: 'queue_send_failed' })
    expect(JSON.stringify(state)).not.toContain('provider-credential')
    expect(await publishEmailOutbox(database, failedQueue, { now: '2026-09-29T12:00:00Z' })).toMatchObject({
      published: 0
    })
  })

  it('reconciles lost Queue receipts and deduplicates a delayed first delivery', async () => {
    const { sqlite, database } = await world()
    const { eventId } = await enqueueEmailOutbox(database, base)
    const sent: EmailDispatchMessage[] = []
    const queue = { send: async (message: EmailDispatchMessage) => void sent.push(message) }
    await publishEmailOutbox(database, queue, { now: NOW })
    expect(await reconcileEmailOutbox(database, { now: '2026-09-29T10:09:59Z' })).toEqual({
      requeued: 0,
      manualReview: 0
    })
    expect(await reconcileEmailOutbox(database, { now: '2026-09-29T10:10:00Z' })).toEqual({
      requeued: 1,
      manualReview: 0
    })
    await publishEmailOutbox(database, queue, { now: '2026-09-29T10:10:00Z' })
    expect(sent).toEqual([
      { type: 'email.dispatch.requested', version: 1, eventId },
      { type: 'email.dispatch.requested', version: 1, eventId }
    ])
    expect(await receiveEmailDispatch(database, sent[1], '2026-09-29T10:11:00Z')).toBe('stored')
    expect(await receiveEmailDispatch(database, sent[0], '2026-09-29T10:11:01Z')).toBe('replayed')
    expect(sqlite.prepare('SELECT count(*) AS n FROM email_dispatch_inbox').get()!.n).toBe(1)
  })

  it('does not let a late sender acknowledge a replacement lease', async () => {
    const { sqlite, database } = await world()
    const { eventId } = await enqueueEmailOutbox(database, base)
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    const first = publishEmailOutbox(
      database,
      {
        send: async () => {
          entered()
          await pending
        }
      },
      { now: NOW }
    )
    await started
    const secondMessages: EmailDispatchMessage[] = []
    const second = await publishEmailOutbox(
      database,
      { send: async (message) => void secondMessages.push(message) },
      { now: '2026-09-29T10:01:00Z' }
    )
    release()
    expect(second).toMatchObject({ published: 1, lostLease: 0 })
    expect(await first).toMatchObject({ published: 0, lostLease: 1 })
    expect(secondMessages).toEqual([{ type: 'email.dispatch.requested', version: 1, eventId }])
    expect(sqlite.prepare('SELECT status, attempts FROM email_outbox_delivery').get()).toEqual({
      status: 'published',
      attempts: 2
    })
  })

  it('rejects malformed messages and keeps exhausted missing receipts for manual review', async () => {
    const { sqlite, database } = await world()
    const { eventId } = await enqueueEmailOutbox(database, base)
    const message = { type: 'email.dispatch.requested', version: 1, eventId }
    expect(await receiveEmailDispatch(database, { ...message, recipient: 'buyer@example.invalid' }, NOW)).toBe(
      'invalid'
    )
    expect(await receiveEmailDispatch(database, { ...message, version: 2 }, NOW)).toBe('invalid')
    expect(await receiveEmailDispatch(database, { ...message, eventId: 'email:missing' }, NOW)).toBe('invalid')
    sqlite.exec(
      "UPDATE email_outbox_delivery SET status = 'published', attempts = 10, published_at = '2026-09-29T10:00:00Z'"
    )
    expect(await reconcileEmailOutbox(database, { now: '2026-09-29T10:10:00Z' })).toEqual({
      requeued: 0,
      manualReview: 1
    })
    expect(sqlite.prepare('SELECT status FROM email_outbox_delivery').get()).toEqual({ status: 'manual_review' })
    expect(await receiveEmailDispatch(database, message, '2026-09-29T10:11:00Z')).toBe('stored')
    expect(sqlite.prepare('SELECT status FROM email_dispatch_inbox').get()).toEqual({
      status: 'blocked_provider'
    })
  })
})
