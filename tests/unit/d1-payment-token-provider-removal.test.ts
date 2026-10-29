import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUYER_CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { settlePaymentTokenRemoval } from '../../workers/payments/token-provider-removal'
let f: Awaited<ReturnType<typeof returnsFixture>>
const tokenId = '40000000-0000-4000-8000-000000000022',
  key = '50000000-0000-4000-8000-000000000022'
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  f.sqlite
    .prepare(
      `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`
    )
    .run(tokenId, CUSTOMER, 'provider-private-reference', utc(), utc(), utc())
  await requestPaymentTokenRemoval(
    f.database,
    BUYER_CLAIMS,
    { tokenId, expectedVersion: 1, commandId: key },
    { now: () => utc() }
  )
})
afterEach(() => f?.sqlite.close())
it('confirms provider deletion and removes the local provider reference', async () => {
  const remove = vi.fn(async () => 'deleted' as const)
  const result = await settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())
  expect(result).toEqual({ outcome: 'removed' })
  expect(remove).toHaveBeenCalledWith({
    providerToken: 'provider-private-reference',
    idempotencyKey: `payment-token-removal:${tokenId}`
  })
  expect(
    f.sqlite.prepare('SELECT status,provider_token,version FROM payment_saved_tokens WHERE id=?').get(tokenId)
  ).toMatchObject({ status: 'removed', provider_token: null, version: 3 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_provider_audit').get()).toMatchObject({ n: 1 })
})
it('keeps a pending record when provider cannot confirm, for safe retry', async () => {
  const remove = vi.fn(async () => 'pending' as const)
  expect(await settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())).toEqual({ outcome: 'pending' })
  expect(f.sqlite.prepare('SELECT status,version FROM payment_saved_tokens WHERE id=?').get(tokenId)).toMatchObject({
    status: 'removal_pending',
    version: 2
  })
})
it('preserves pending on provider failure', async () => {
  const remove = vi.fn(async () => {
    throw new Error('provider down')
  })
  await expect(settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect(f.sqlite.prepare('SELECT status FROM payment_saved_tokens WHERE id=?').get(tokenId)).toMatchObject({
    status: 'removal_pending'
  })
})
it('returns the durable result without calling the provider again', async () => {
  const remove = vi.fn(async () => 'deleted' as const)
  await settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())
  expect(await settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())).toEqual({ outcome: 'removed' })
  expect(remove).toHaveBeenCalledTimes(1)
})
it('uses one stable provider idempotency key for racing attempts', async () => {
  const remove = vi.fn(async (_input: { providerToken: string; idempotencyKey: string }) => 'already_deleted' as const)
  const values = await Promise.all([
    settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc()),
    settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())
  ])
  expect(values).toEqual([{ outcome: 'removed' }, { outcome: 'removed' }])
  expect(remove.mock.calls.every((call) => call[0].idempotencyKey === `payment-token-removal:${tokenId}`)).toBe(true)
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_provider_audit').get()).toMatchObject({ n: 1 })
})
it('rejects deletion without an authorized local removal request', async () => {
  f.sqlite.prepare("UPDATE payment_saved_tokens SET status='active',version=1 WHERE id=?").run(tokenId)
  const remove = vi.fn(async () => 'deleted' as const)
  await expect(settlePaymentTokenRemoval(f.database, tokenId, { remove }, utc())).rejects.toMatchObject({
    code: 'conflict'
  })
  expect(remove).not.toHaveBeenCalled()
})
it('keeps provider audit append-only', async () => {
  await settlePaymentTokenRemoval(f.database, tokenId, { remove: async () => 'deleted' }, utc())
  expect(() => f.sqlite.exec('DELETE FROM payment_token_provider_audit')).toThrow()
})
