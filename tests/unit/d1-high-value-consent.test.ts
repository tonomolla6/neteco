import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeHighValueConsent, readHighValueConsent } from '../../workers/communications/high-value-consent'

let f: Awaited<ReturnType<typeof returnsFixture>>
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const options = { now: () => utc() }
const valid = { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-verified-123' } as const
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
})
afterEach(() => f?.sqlite.close())
const save = (input: unknown = valid, id = first) =>
  executeHighValueConsent(f.database, CLAIMS, CUSTOMER, id, input, options)
it('persists a grant and returns the same receipt on replay', async () => {
  const receipt = await save()
  expect(receipt).toMatchObject({ version: 1, action: 'grant', channel: 'sms' })
  expect(await save()).toEqual(receipt)
  expect(await readHighValueConsent(f.database, CLAIMS, CUSTOMER, 'sms', options)).toMatchObject({
    version: 1,
    granted: true
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 1 })
})
it('starts with no consent independently for each channel', async () => {
  await save()
  expect(await readHighValueConsent(f.database, CLAIMS, CUSTOMER, 'whatsapp', options)).toMatchObject({
    version: 0,
    granted: false
  })
})
it('revokes consent with a versioned immutable opt-out', async () => {
  await save()
  await save({ channel: 'sms', expectedVersion: 1, action: 'revoke', proof: 'case-opt-out-123' }, second)
  expect(await readHighValueConsent(f.database, CLAIMS, CUSTOMER, 'sms', options)).toMatchObject({
    version: 2,
    granted: false
  })
  expect(() => f.sqlite.exec('DELETE FROM high_value_consent_commands')).toThrow()
  expect(() => f.sqlite.exec("UPDATE high_value_consent_commands SET action='grant' ")).toThrow()
})
it('rejects a reused command id with a different payload', async () => {
  await save()
  await expect(save({ ...valid, proof: 'another-proof-123' })).rejects.toMatchObject({ code: 'conflict' })
})
it('rejects a stale version without changing the journal', async () => {
  await save()
  await expect(save(valid, second)).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 1 })
})
it.each([
  {},
  { ...valid, channel: 'email' },
  { ...valid, expectedVersion: -1 },
  { ...valid, expectedVersion: 1.5 },
  { ...valid, action: 'erase' },
  { ...valid, proof: '' },
  { ...valid, proof: 'name@example.invalid' },
  { ...valid, proof: 'https://example.invalid' },
  { ...valid, extra: 1 }
])('rejects malformed command %j', async (input) => {
  await expect(save(input)).rejects.toMatchObject({ code: 'invalid_input' })
})
it('requires live administrative authority for writes and reads', async () => {
  await expect(
    executeHighValueConsent(f.database, BUYER_CLAIMS, CUSTOMER, first, valid, options)
  ).rejects.toMatchObject({ code: 'mfa_required' })
  await expect(readHighValueConsent(f.database, BUYER_CLAIMS, CUSTOMER, 'sms', options)).rejects.toMatchObject({
    code: 'mfa_required'
  })
})
it('rechecks live authority at the atomic write', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 0 })
})
it('detects a competing writer atomically', async () => {
  const batch = f.database.batch.bind(f.database)
  let firstBatch = true
  f.database.batch = async (statements) => {
    if (firstBatch) {
      firstBatch = false
      await save({ ...valid, proof: 'case-race-winner' }, second)
    }
    return batch(statements)
  }
  await expect(save()).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 1 })
})
it('denies a replay after the session is revoked', async () => {
  await save()
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
  await expect(save()).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('returns not found for an unknown customer', async () => {
  await expect(
    readHighValueConsent(f.database, CLAIMS, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sms', options)
  ).rejects.toMatchObject({ code: 'not_found' })
})
