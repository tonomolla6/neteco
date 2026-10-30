import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUYER_CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { recoverPaymentTokenRemovals } from '../../workers/payments/token-removal-recovery'

let fixture: Awaited<ReturnType<typeof returnsFixture>>
const ids = ['40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000022']
beforeEach(async () => {
  fixture = await returnsFixture()
  fixture.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  for (const [index, id] of ids.entries()) {
    fixture.sqlite
      .prepare(
        `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`
      )
      .run(id, CUSTOMER, `reference-${index}`, utc(), utc(), utc())
    await requestPaymentTokenRemoval(
      fixture.database,
      BUYER_CLAIMS,
      { tokenId: id, commandId: `50000000-0000-4000-8000-00000000002${index + 1}`, expectedVersion: 1 },
      { now: () => utc() }
    )
  }
})
afterEach(() => fixture?.sqlite.close())
it('persists a recovery job atomically with every removal request', () => {
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM payment_token_removal_jobs WHERE status='pending'").get()
  ).toMatchObject({ n: 2 })
})
it('processes bounded due jobs and confirms provider deletion', async () => {
  const remove = vi.fn(async (_input: { providerToken: string; idempotencyKey: string }) => 'deleted' as const)
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 1 })).toEqual({
    claimed: 1,
    removed: 1,
    pending: 0,
    failed: 0
  })
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM payment_saved_tokens WHERE status='removed'").get()
  ).toMatchObject({ n: 1 })
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM payment_token_removal_jobs WHERE status='done'").get()
  ).toMatchObject({ n: 1 })
  expect(remove).toHaveBeenCalledTimes(1)
})
it('postpones failures so they do not starve other jobs and retries with the same key', async () => {
  const remove = vi.fn(async (input: { providerToken: string; idempotencyKey: string }) => {
    if (input.providerToken === 'reference-0') throw new Error('unavailable')
    return 'deleted' as const
  })
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 1 })).toEqual({
    claimed: 1,
    removed: 0,
    pending: 0,
    failed: 1
  })
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 1 })).toEqual({
    claimed: 1,
    removed: 1,
    pending: 0,
    failed: 0
  })
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(61000), limit: 1 })).toEqual({
    claimed: 1,
    removed: 0,
    pending: 0,
    failed: 1
  })
  expect(remove.mock.calls[0]![0].idempotencyKey).toBe(remove.mock.calls[2]![0].idempotencyKey)
})
it('preserves pending when provider has not confirmed and does not immediately retry', async () => {
  const remove = vi.fn(async () => 'pending' as const)
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 2 })).toEqual({
    claimed: 2,
    removed: 0,
    pending: 2,
    failed: 0
  })
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 2 })).toEqual({
    claimed: 0,
    removed: 0,
    pending: 0,
    failed: 0
  })
})
it('claims each job only once under concurrent sweeps', async () => {
  const remove = vi.fn(async () => 'deleted' as const)
  const results = await Promise.all([
    recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 2 }),
    recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 2 })
  ])
  expect(results.reduce((sum, x) => sum + x.claimed, 0)).toBe(2)
  expect(remove).toHaveBeenCalledTimes(2)
})
it.each([0, -1, 26, 1.5])('rejects invalid limit %s', async (limit) => {
  await expect(
    recoverPaymentTokenRemovals(fixture.database, { remove: async () => 'deleted' }, { now: utc(), limit })
  ).rejects.toMatchObject({ code: 'invalid_input' })
})
it('rejects an invalid instant and does not call the adapter', async () => {
  const remove = vi.fn(async () => 'deleted' as const)
  await expect(
    recoverPaymentTokenRemovals(fixture.database, { remove }, { now: 'tomorrow', limit: 2 })
  ).rejects.toMatchObject({ code: 'invalid_input' })
  expect(remove).not.toHaveBeenCalled()
})
it('finishes a job after a crash between confirmed deletion and queue completion without contacting provider again', async () => {
  const { settlePaymentTokenRemoval } = await import('../../workers/payments/token-provider-removal')
  const remove = vi.fn(async () => 'deleted' as const)
  await settlePaymentTokenRemoval(fixture.database, ids[0]!, { remove }, utc())
  expect(await recoverPaymentTokenRemovals(fixture.database, { remove }, { now: utc(), limit: 1 })).toEqual({
    claimed: 1,
    removed: 1,
    pending: 0,
    failed: 0
  })
  expect(remove).toHaveBeenCalledTimes(1)
  expect(
    fixture.sqlite.prepare('SELECT status FROM payment_token_removal_jobs WHERE token_id=?').get(ids[0]!)
  ).toMatchObject({ status: 'done' })
})
