import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite } from '../support/d1-sqlite'
import {
  enqueueEmailOutbox,
  publishEmailOutbox,
  receiveEmailDispatch,
  type EmailOutboxInput
} from '../../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'

const NOW = '2026-09-29T10:00:00Z'
const SOURCE_EVENT = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'
const FROM = 'pedidos@neteco.es'
const enabled = { enabled: true, from: FROM, now: NOW }
const input: EmailOutboxInput = {
  sourceEventId: SOURCE_EVENT,
  sourceId: ORDER,
  sourceKind: 'order',
  eventType: 'order.created',
  now: NOW
}
const opened: DatabaseSync[] = []
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

async function migration(sqlite: DatabaseSync, name: string) {
  sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
  if (name === '0031_transactional_email_delivery.sql')
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0070_delivery_preferences.sql', import.meta.url), 'utf8')
    )
}

async function world(options: { event?: Partial<EmailOutboxInput>; migrateDelivery?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  opened.push(sqlite)
  sqlite.exec('PRAGMA foreign_keys = ON')
  await migration(sqlite, '0027_email_outbox.sql')
  if (options.migrateDelivery !== false) await migration(sqlite, '0031_transactional_email_delivery.sql')
  // Source contract fixture, not a mocked D1 implementation. Joins, FK,
  // transactions, leases and delivery constraints execute in real SQLite.
  sqlite.exec(`
    CREATE TABLE orders (id TEXT PRIMARY KEY, contact_email TEXT NOT NULL, contact_name TEXT,
      currency TEXT NOT NULL, total_gross_cents INTEGER NOT NULL, shipping_gross_cents INTEGER NOT NULL) STRICT;
    CREATE TABLE order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), event_type TEXT NOT NULL) STRICT;
    CREATE TABLE order_lines (order_id TEXT REFERENCES orders(id), line_index INTEGER, name TEXT, sku TEXT, quantity INTEGER, gross_cents INTEGER) STRICT;
    CREATE TABLE newsletter_suppressions (email_hash TEXT PRIMARY KEY, reason TEXT) STRICT;
  `)
  sqlite
    .prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)')
    .run(ORDER, 'buyer@example.invalid', 'Ana <img src=x onerror="alert(1)"> & Co', 'EUR', 1499, 499)
  sqlite.prepare('INSERT INTO order_events VALUES (?, ?, ?)').run(SOURCE_EVENT, ORDER, 'order.created')
  sqlite
    .prepare('INSERT INTO order_lines VALUES (?, 0, ?, ?, 2, 1000)')
    .run(ORDER, 'Jabón <script>alert(1)</script>', 'SKU & "uno"')
  const database = d1OverSqlite(sqlite)
  const { eventId } = await enqueueEmailOutbox(database, { ...input, ...options.event })
  const messages: unknown[] = []
  await publishEmailOutbox(
    database,
    {
      send: async (message) => {
        messages.push(message)
      }
    },
    { now: NOW }
  )
  expect(await receiveEmailDispatch(database, messages[0], NOW)).toBe('stored')
  const sender = {
    send: vi.fn(async (_message: Parameters<TransactionalEmailSender['send']>[0]) => ({ messageId: 'cf-message-01' }))
  }
  return { sqlite, database, eventId, message: messages[0], sender }
}

function wrapped(
  database: D1Database,
  interceptor: (sql: string, statement: D1PreparedStatement) => D1PreparedStatement
): D1Database {
  return {
    ...database,
    prepare: (sql: string) => {
      const decorate = (statement: D1PreparedStatement): D1PreparedStatement =>
        ({
          ...interceptor(sql, statement),
          bind: (...parameters: unknown[]) => decorate(statement.bind(...parameters))
        }) as unknown as D1PreparedStatement
      return decorate(database.prepare(sql))
    }
  } as D1Database
}
function state(sqlite: DatabaseSync) {
  return sqlite.prepare('SELECT * FROM transactional_email_deliveries').get()!
}

describe('D1 transactional email provider delivery', () => {
  it('backfills already acknowledged receipts and keeps replay receipts immutable', async () => {
    const { sqlite, database, message } = await world({ migrateDelivery: false })
    await migration(sqlite, '0031_transactional_email_delivery.sql')
    expect(state(sqlite)).toMatchObject({ status: 'pending', available_at: NOW })
    expect(await receiveEmailDispatch(database, message, NOW)).toBe('replayed')
    expect(sqlite.prepare('SELECT count(*) AS n FROM transactional_email_deliveries').get()!.n).toBe(1)
    expect(() => sqlite.exec('UPDATE email_dispatch_inbox SET status = status')).toThrow('immutable')
  })

  it('defaults off and validates enabled binding/from before claiming work', async () => {
    const { sqlite, database, sender } = await world()
    expect(await dispatchTransactionalEmails(database, undefined, { now: NOW })).toEqual({
      disabled: true,
      sent: 0,
      retryable: 0,
      manualReview: 0,
      lostLease: 0
    })
    await expect(dispatchTransactionalEmails(database, undefined, enabled)).rejects.toThrow('sender_unavailable')
    for (const from of ['sender@example.invalid\r\nBcc: evil@example.invalid', 'NETECO <pedidos@neteco.es>', '']) {
      await expect(dispatchTransactionalEmails(database, sender, { ...enabled, from })).rejects.toThrow(
        'invalid_transactional_email_from'
      )
    }
    expect(sender.send).not.toHaveBeenCalled()
    expect(state(sqlite)).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('rejects invalid dispatch instants and bounds before changing delivery state', async () => {
    const { sqlite, database, sender } = await world()
    for (const config of [
      { ...enabled, now: '2026-09-29T10:00:00.000Z' },
      { ...enabled, now: 'invalid' },
      { ...enabled, limit: 0 },
      { ...enabled, limit: 101 },
      { ...enabled, limit: 1.5 }
    ]) {
      await expect(dispatchTransactionalEmails(database, sender, config)).rejects.toThrow(
        'invalid_transactional_email_dispatch_input'
      )
    }
    expect(state(sqlite)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('renders authoritative order/recipient with escaped HTML and no access tokens or marketing dependency', async () => {
    const { sqlite, database, sender, eventId, message } = await world()
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('buyer@example.invalid'))),
      (b) => b.toString(16).padStart(2, '0')
    ).join('')
    sqlite.prepare('INSERT INTO newsletter_suppressions VALUES (?, ?)').run(hash, 'unsubscribe')
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ sent: 1, disabled: false })
    expect(sender.send).toHaveBeenCalledOnce()
    const delivered = sender.send.mock.calls[0]![0] as unknown as {
      to: string
      from: string
      html: string
      text: string
      subject: string
    }
    expect(delivered).toMatchObject({
      to: 'buyer@example.invalid',
      from: FROM,
      subject: `NETECO: pedido recibido ${ORDER}`
    })
    expect(delivered.html).toContain('Ana &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co')
    expect(delivered.html).toContain('Jabón &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(delivered.html).not.toContain('<script>')
    expect(delivered.text).toContain('Total (IVA incluido): 14,99 €')
    expect(delivered.text).toContain('pendiente de pago')
    expect(delivered.html).not.toMatch(/token=|href=|unsubscribe|newsletter/)
    expect(state(sqlite)).toMatchObject({
      status: 'sent',
      provider_message_id: 'cf-message-01',
      attempts: 1,
      lease_token: null
    })
    expect(JSON.stringify(state(sqlite))).not.toContain('buyer@')
    expect(JSON.stringify(message)).toBe(JSON.stringify({ type: 'email.dispatch.requested', version: 1, eventId }))
    expect(await receiveEmailDispatch(database, message, NOW)).toBe('replayed')
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    ).toMatchObject({ sent: 0 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('fails closed for unimplemented transactional event types', async () => {
    const { sqlite, database, sender } = await world({ event: { eventType: 'order.shipped' } })
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1, sent: 0 })
    expect(state(sqlite)).toMatchObject({ status: 'manual_review', last_error_code: 'unsupported_event' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not trust an outbox reference without the matching persisted source event', async () => {
    const { sqlite, database, sender } = await world({
      event: { sourceEventId: '11111111-1111-4111-8111-111111111112' }
    })
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ last_error_code: 'source_not_found' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it.each([
    'buyer@example.invalid\r\nBcc: evil@example.invalid',
    'Display <buyer@example.invalid>',
    'buyer@example.invalid\n',
    'bad email',
    'buyer@example..invalid',
    '.buyer@example.invalid',
    'buyer@-example.invalid'
  ])('rejects invalid recipients before provider invocation: %j', async (recipient) => {
    const { sqlite, database, sender } = await world()
    sqlite.prepare('UPDATE orders SET contact_email = ?').run(recipient)
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ last_error_code: 'invalid_source' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('rejects inconsistent monetary snapshots before sending', async () => {
    const { sqlite, database, sender } = await world()
    sqlite.exec('UPDATE orders SET total_gross_cents = 1')
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('rejects missing contractual lines before sending', async () => {
    const { sqlite, database, sender } = await world()
    sqlite.exec('DELETE FROM order_lines')
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ last_error_code: 'invalid_source' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('retries only pre-provider preparation failures with bounded backoff and sanitized codes', async () => {
    const { sqlite, database, sender } = await world()
    const failsRead = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT event_type')
        ? ({
            ...statement,
            first: async () => {
              throw new Error('token=secret recipient=buyer@example.invalid')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchTransactionalEmails(failsRead, sender, enabled)).toMatchObject({ retryable: 1 })
    expect(state(sqlite)).toMatchObject({
      status: 'pending',
      available_at: '2026-09-29T10:00:30Z',
      last_error_code: 'preparation_failed'
    })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:00:29Z' })
    ).toMatchObject({ sent: 0 })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:00:30Z' })
    ).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('stops automatic retries when pre-send preparation attempts are exhausted', async () => {
    const { sqlite, database, sender } = await world()
    sqlite.exec('UPDATE transactional_email_deliveries SET attempts = 10')
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ status: 'manual_review', last_error_code: 'preparation_attempts_exhausted' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('never sends when the durable sending marker cannot be written; a pre-send lease is reclaimable', async () => {
    const { sqlite, database, sender } = await world()
    const failsSending = wrapped(database, (sql, statement) =>
      sql.includes("SET status = 'sending'")
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    await expect(dispatchTransactionalEmails(failsSending, sender, enabled)).rejects.toThrow('D1 unavailable')
    expect(sender.send).not.toHaveBeenCalled()
    expect(state(sqlite)).toMatchObject({ status: 'leased' })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:00:59Z' })
    ).toMatchObject({ sent: 0 })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 1 })
  })

  it('does not duplicate an in-flight provider call under concurrent dispatch', async () => {
    const { sqlite, database } = await world()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const sender = {
      send: vi.fn(async () => {
        enter()
        await pending
        return { messageId: 'accepted' }
      })
    }
    const first = dispatchTransactionalEmails(database, sender, enabled)
    await entered
    expect(state(sqlite)).toMatchObject({ status: 'sending' })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 0 })
    release()
    expect(await first).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('never lets late provider acceptance revive a crashed/stale sending job or trigger a second send', async () => {
    const { sqlite, database } = await world()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const sender = {
      send: vi.fn(async () => {
        enter()
        await pending
        return { messageId: 'late-accepted' }
      })
    }
    const first = dispatchTransactionalEmails(database, sender, enabled)
    await entered
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:15:00Z' })
    ).toMatchObject({ manualReview: 1, sent: 0 })
    release()
    expect(await first).toMatchObject({ manualReview: 1, sent: 0 })
    expect(state(sqlite)).toMatchObject({
      status: 'manual_review',
      last_error_code: 'sending_lease_expired',
      provider_message_id: null
    })
    await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('rejects acknowledgement from a preparation worker whose lease was replaced', async () => {
    const { database, sender } = await world()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const slowRead = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT event_type')
        ? ({
            ...statement,
            first: async () => {
              if (!held) {
                held = true
                enter()
                await pending
              }
              return statement.first()
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    const old = dispatchTransactionalEmails(slowRead, sender, enabled)
    await entered
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 1 })
    release()
    expect(await old).toMatchObject({ sent: 0, lostLease: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines thrown provider outcomes without persisting exception contents', async () => {
    const { sqlite, database } = await world()
    const sender = {
      send: vi.fn(async () => {
        throw new Error('accepted? secret=token buyer@example.invalid')
      })
    }
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ status: 'manual_review', last_error_code: 'provider_outcome_unknown' })
    expect(JSON.stringify(state(sqlite))).not.toContain('secret')
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    ).toMatchObject({ sent: 0 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines malformed or potentially PII-bearing provider receipts', async () => {
    const { sqlite, database } = await world()
    const sender = { send: vi.fn(async () => ({ messageId: 'buyer@example.invalid\r\nsecret' })) }
    expect(await dispatchTransactionalEmails(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({
      status: 'manual_review',
      last_error_code: 'provider_receipt_invalid',
      provider_message_id: null
    })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines acceptance plus D1 acknowledgement failure instead of automatically retrying', async () => {
    const { sqlite, database, sender } = await world()
    const failsAck = wrapped(database, (sql, statement) =>
      sql.includes("SET status = 'sent'")
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 ack unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchTransactionalEmails(failsAck, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ status: 'manual_review', last_error_code: 'provider_ack_failed' })
    await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('retains non-retryable sending after provider acceptance plus total D1 outage; disabled sweep quarantines stale work', async () => {
    const { sqlite, database, sender } = await world()
    const failsWrites = wrapped(database, (sql, statement) =>
      sql.includes("SET status = 'sent'") ||
      (sql.includes("SET status = 'manual_review'") && sql.includes('lease_token = ?2'))
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 unavailable')
            },
            run: async () => {
              throw new Error('D1 unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchTransactionalEmails(failsWrites, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ status: 'sending' })
    expect(
      await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-29T10:14:59Z' })
    ).toMatchObject({ sent: 0, manualReview: 0 })
    expect(await dispatchTransactionalEmails(database, undefined, { now: '2026-09-29T10:15:00Z' })).toMatchObject({
      disabled: true,
      manualReview: 1
    })
    expect(state(sqlite)).toMatchObject({ status: 'manual_review', last_error_code: 'sending_lease_expired' })
    await dispatchTransactionalEmails(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })
})
