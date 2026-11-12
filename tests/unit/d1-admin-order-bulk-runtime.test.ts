import { describe, expect, it, vi } from 'vitest'
import { dispatchAdminOrderBulkRequests, consumeAdminOrderBulkMessage } from '../../workers/fulfillment/bulk-runtime'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture, CLAIMS, ACTOR, REASON, utc } from './d1-fulfillment-fixture'
import { previewD1AdminOrderBulk, createD1AdminOrderBulk, readD1AdminOrderBulk } from '../../workers/fulfillment/bulk'
import { testUuid } from '../support/deterministic'

describe('bounded bulk fulfillment runtime boundary', () => {
  const forbiddenDatabase = () =>
    ({
      prepare: vi.fn(() => {
        throw new Error('unexpected_database_access')
      })
    }) as unknown as D1Database
  it('does not read D1 or enqueue when AUTH is disabled', async () => {
    const database = forbiddenDatabase(),
      queue = { send: vi.fn() }
    expect(await dispatchAdminOrderBulkRequests(database, queue, { enabled: false })).toEqual({
      selected: 0,
      sent: 0,
      failed: 0
    })
    expect(database.prepare).not.toHaveBeenCalled()
    expect(queue.send).not.toHaveBeenCalled()
  })
  it('does not process a queue message when AUTH is disabled', async () => {
    const database = forbiddenDatabase()
    expect(
      await consumeAdminOrderBulkMessage(
        database,
        { type: 'admin.order-bulk.requested', groupId: testUuid(), dispatchId: testUuid() },
        { enabled: false }
      )
    ).toBe('disabled')
    expect(database.prepare).not.toHaveBeenCalled()
  })
  it('classifies malformed and injected queue messages without any D1 mutation', async () => {
    const database = forbiddenDatabase()
    for (const raw of [
      null,
      { type: 'admin.order-bulk.requested', groupId: 'invalid', dispatchId: testUuid() },
      {
        type: 'admin.order-bulk.requested',
        groupId: testUuid(),
        dispatchId: testUuid(),
        actorId: testUuid()
      }
    ])
      expect(await consumeAdminOrderBulkMessage(database, raw, { enabled: true })).toBe('invalid')
    expect(database.prepare).not.toHaveBeenCalled()
  })
  it('recovers a real committed step after queue-send failure and never duplicates child transitions', async () => {
    const f = await fulfillmentFixture()
    try {
      f.sqlite.exec(
        'BEGIN;\n' +
          (await readFile(new URL('../../db/d1/migrations/0086_admin_order_bulk.sql', import.meta.url), 'utf8')) +
          '\nCOMMIT;'
      )
      f.sqlite
        .prepare(
          "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-only','[]',?,?)"
        )
        .run(ACTOR, utc(-60000), utc(-60000))
      const first = await f.order(),
        second = await f.order()
      const preview = await previewD1AdminOrderBulk(f.database, CLAIMS, {
        action: 'picking',
        orderIds: [first, second],
        reason: REASON
      })
      const input = {
        action: preview.action,
        orders: preview.rows.map(({ orderId, expectedVersion }) => ({ orderId, expectedVersion })),
        reason: REASON,
        previewHash: preview.previewHash
      }
      const receipt = await createD1AdminOrderBulk(f.database, CLAIMS, input, { idempotencyKey: testUuid() })
      const message = { type: 'admin.order-bulk.requested', groupId: receipt.groupId, dispatchId: receipt.dispatchId }
      const before = f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY rowid').all()
      const unavailable = {
        send: vi.fn(async () => {
          throw new Error('synthetic_queue_unavailable')
        })
      }
      expect(await consumeAdminOrderBulkMessage(f.database, message, { enabled: true, queue: unavailable })).toBe(
        'retry'
      )
      expect(unavailable.send).toHaveBeenCalledWith(message)
      expect(
        (await readD1AdminOrderBulk(f.database, CLAIMS, receipt.groupId)).rows.filter((row) => row.status === 'applied')
      ).toHaveLength(1)
      const queue = { send: vi.fn(async () => {}) }
      expect(await dispatchAdminOrderBulkRequests(f.database, queue, { enabled: true, limit: 5 })).toMatchObject({
        selected: 1,
        sent: 1,
        failed: 0
      })
      expect(queue.send).toHaveBeenCalledWith(message)
      expect(await consumeAdminOrderBulkMessage(f.database, message, { enabled: true, queue })).toBe('completed')
      expect(await consumeAdminOrderBulkMessage(f.database, message, { enabled: true, queue })).toBe('completed')
      expect(f.sqlite.prepare('SELECT count(*) n FROM order_fulfillment_commands').get()).toEqual({ n: 2 })
      expect(f.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY rowid').all()).toEqual(before)
    } finally {
      f.sqlite.close()
    }
  })
})
