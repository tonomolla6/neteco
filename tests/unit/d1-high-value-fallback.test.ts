import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeHighValueConsent } from '../../workers/communications/high-value-consent'
import { prepareHighValueMessage } from '../../workers/communications/high-value-fallback'
let f: Awaited<ReturnType<typeof returnsFixture>>
const id = '11111111-1111-4111-8111-111111111111',
  event = '22222222-2222-4222-8222-222222222222',
  consentId = '33333333-3333-4333-8333-333333333333'
const input = { eventId: event, event: 'recall', channel: 'sms', consentVersion: 0 } as const
const opts = () => ({
  now: () => utc(),
  pricing: { smsCostMinor: 5, dailyBudgetMinor: 5 },
  transport: 'local-fake' as const
})
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
})
afterEach(() => f?.sqlite.close())
const run = (raw: unknown = input, key = id, claims = CLAIMS) =>
  prepareHighValueMessage(f.database, claims, CUSTOMER, key, raw, opts())
it('records an auditable manual fallback when consent is absent', async () => {
  const result = await run()
  expect(result).toMatchObject({ status: 'fallback', fallback: 'manual', reason: 'consent_required' })
  expect(await run()).toEqual(result)
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_fallback_commands').get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_delivery_commands').get()).toEqual({ n: 0 })
  expect(() => f.sqlite.exec('DELETE FROM high_value_fallback_commands')).toThrow()
})
it('cannot turn a fallback into a later duplicate simulation after consent is granted', async () => {
  await run()
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    consentId,
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-verified-123' },
    opts()
  )
  const result = await run()
  expect(result.status).toBe('fallback')
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_delivery_commands').get()).toEqual({ n: 0 })
})
it('rejects command id or event reuse with different input', async () => {
  await run()
  await expect(run({ ...input, event: 'security_alert' })).rejects.toMatchObject({ code: 'conflict' })
  await expect(run(input, '44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({ code: 'conflict' })
})
it('does not allow a customer to create or read a fallback', async () => {
  await expect(run(input, id, BUYER_CLAIMS)).rejects.toMatchObject({ code: 'mfa_required' })
})
it('uses simulated SMS when consent and budget allow it', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    consentId,
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-verified-123' },
    opts()
  )
  expect(await run({ ...input, consentVersion: 1 })).toMatchObject({ status: 'simulated' })
})
it('does not create a fallback for malformed input', async () => {
  await expect(run({ ...input, event: 'marketing' })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_fallback_commands').get()).toEqual({ n: 0 })
})
it('records a manual fallback when the daily budget is exhausted', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    consentId,
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-verified-123' },
    opts()
  )
  await run({ ...input, consentVersion: 1 })
  const later = { ...input, consentVersion: 1, eventId: '55555555-5555-4555-8555-555555555555' }
  expect(await run(later, '44444444-4444-4444-8444-444444444444')).toMatchObject({
    status: 'fallback',
    reason: 'budget_exceeded',
    fallback: 'manual'
  })
  expect(f.sqlite.prepare('SELECT sum(cost_minor) total FROM high_value_delivery_commands').get()).toEqual({ total: 5 })
})
it('records manual fallback when simulation is disabled', async () => {
  expect(
    await prepareHighValueMessage(f.database, CLAIMS, CUSTOMER, id, input, { ...opts(), transport: 'disabled' })
  ).toMatchObject({ status: 'fallback', reason: 'delivery_disabled' })
})
it('denies creating fallback if authority is revoked during commit', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(run()).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_fallback_commands').get()).toEqual({ n: 0 })
})
