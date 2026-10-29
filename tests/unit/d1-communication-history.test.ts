import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { communicationHistoryFixture, CLAIMS, utc } from './d1-communication-history-fixture'
import { BUYER_CLAIMS } from './d1-support-fixture'
import {
  readCommunicationHistory,
  retryCommunicationPreparation,
  readCommunicationRetryCommand
} from '../../workers/communications/history'
import { communicationHistorySchema, communicationRetryIntentHash } from '../../shared/communication-history'

describe('COM-011 metadata and explicit pre-send preparation recovery', () => {
  let f: Awaited<ReturnType<typeof communicationHistoryFixture>>
  beforeEach(async () => {
    f = await communicationHistoryFixture()
  })
  afterEach(() => f.sqlite.close())
  const retry = (key = crypto.randomUUID(), input = f.input) =>
    retryCommunicationPreparation(f.database, CLAIMS, f.eventId, input, { idempotencyKey: key })
  it('reads bounded real work metadata without recipient, body, source identity or provider identifiers', async () => {
    const before = f.economic(),
      result = communicationHistorySchema.parse(await readCommunicationHistory(f.database, CLAIMS, {}))
    expect(result.items.find((item) => item.eventId === f.eventId)).toMatchObject({
      status: 'pending',
      attempts: 2,
      canRetry: true
    })
    expect(JSON.stringify(result)).not.toMatch(
      /buyer@example|contact_email|provider_message|sourceId|session|token|recipient/
    )
    expect(f.economic()).toEqual(before)
  })
  it('rearms only preparation timing with immutable exact receipt, no reset or new event', async () => {
    const before = f.economic(),
      key = crypto.randomUUID(),
      count = f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()
    const receipt = await retry(key)
    expect(receipt).toMatchObject({
      commandId: key,
      eventId: f.eventId,
      attempts: 2,
      senderInvoked: false,
      attemptsReset: false,
      preparation: 'retry_requested'
    })
    expect(Date.parse(receipt.availableAt)).toBeLessThan(Date.parse(f.input.expectedAvailableAt))
    expect(await retry(key)).toEqual(receipt)
    expect(
      await readCommunicationRetryCommand(
        f.database,
        CLAIMS,
        key,
        await communicationRetryIntentHash(f.eventId, f.input)
      )
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual(count)
    expect(f.economic()).toEqual(before)
    await expect(
      retry(key, { ...f.input, reason: 'Otra intención de revisión operacional explícita.' })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('rejects stale attempts/availability CAS without a command or state change', async () => {
    f.sqlite.prepare('UPDATE transactional_email_deliveries SET attempts=3 WHERE event_id=?').run(f.eventId)
    await expect(retry()).rejects.toMatchObject({ code: 'version_conflict' })
    expect(
      f.sqlite
        .prepare('SELECT attempts,available_at FROM transactional_email_deliveries WHERE event_id=?')
        .get(f.eventId)
    ).toMatchObject({ attempts: 3, available_at: f.input.expectedAvailableAt })
  })
  it('never rearms sending, ambiguous review, sent or exhausted work', async () => {
    for (const [status, error, attempts, lease, provider] of [
      ['manual_review', 'provider_outcome_unknown', 2, null, null],
      ['sent', null, 2, null, 'synthetic-provider-receipt'],
      ['sending', null, 2, 'synthetic-lease', null],
      ['pending', 'preparation_failed', 10, null, null]
    ] as const) {
      f.sqlite
        .prepare(
          'UPDATE transactional_email_deliveries SET status=?,last_error_code=?,attempts=?,lease_token=?,lease_until=?,sending_at=?,finished_at=?,provider_message_id=? WHERE event_id=?'
        )
        .run(
          status,
          error,
          attempts,
          lease,
          lease ? utc(3600000) : null,
          status === 'sending' ? utc() : null,
          status === 'sent' || status === 'manual_review' ? utc() : null,
          provider,
          f.eventId
        )
      await expect(retry()).rejects.toMatchObject({ code: 'not_retryable' })
    }
  })
  it('denies support-only and customer grants and reauthorizes an applied receipt', async () => {
    const key = crypto.randomUUID()
    await retry(key)
    f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage'")
    await expect(readCommunicationHistory(f.database, CLAIMS, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      readCommunicationRetryCommand(f.database, CLAIMS, key, await communicationRetryIntentHash(f.eventId, f.input))
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(readCommunicationHistory(f.database, BUYER_CLAIMS, {})).rejects.toMatchObject({ code: 'mfa_required' })
  })
  it('fails closed on a missing immutable order occurrence', async () => {
    f.sqlite.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER order_events_no_delete')
    f.sqlite.prepare("DELETE FROM order_events WHERE order_id=? AND event_type='order.created'").run(f.order)
    expect(
      (await readCommunicationHistory(f.database, CLAIMS, {})).items.find((item) => item.eventId === f.eventId)
        ?.canRetry
    ).toBe(false)
    await expect(retry()).rejects.toMatchObject({ code: 'not_retryable' })
  })
  it('reports outage rather than an empty history', async () => {
    const broken = {
      prepare() {
        throw new Error('synthetic-private-database-detail')
      }
    } as unknown as D1Database
    await expect(readCommunicationHistory(broken, CLAIMS, {})).rejects.toMatchObject({ code: 'service_unavailable' })
  })
  it('rejects oversized pages and recipient-search rather than expanding metadata access', async () => {
    await expect(readCommunicationHistory(f.database, CLAIMS, { perPage: 26 })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      readCommunicationHistory(f.database, CLAIMS, { recipient: 'buyer@example.invalid' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('filters an exact public metadata event identifier for post-receipt confirmation', async () => {
    const result = await readCommunicationHistory(f.database, CLAIMS, { eventId: f.eventId })
    expect(result.total).toBe(1)
    expect(result.items.map((item) => item.eventId)).toEqual([f.eventId])
    expect((await readCommunicationHistory(f.database, CLAIMS, { eventId: 'email:' + 'f'.repeat(64) })).items).toEqual(
      []
    )
    await expect(
      readCommunicationHistory(f.database, CLAIMS, { eventId: 'private@example.invalid' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
