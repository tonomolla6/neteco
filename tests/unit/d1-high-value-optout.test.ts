import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeHighValueConsent, readHighValueConsent } from '../../workers/communications/high-value-consent'
import { revokeOwnHighValueConsent, readOwnHighValueConsent } from '../../workers/communications/high-value-optout'
let f: Awaited<ReturnType<typeof returnsFixture>>
const grant = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222',
  second = '33333333-3333-4333-8333-333333333333'
const options = { now: () => utc() }
beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
})
afterEach(() => f?.sqlite.close())
const optout = (raw: unknown = { channel: 'sms', expectedVersion: 1 }, id = key, claims = BUYER_CLAIMS) =>
  revokeOwnHighValueConsent(f.database, claims, id, raw, options)
it('lets the verified customer revoke their own channel without administrative MFA', async () => {
  await executeHighValueConsent(
    f.database,
    CLAIMS,
    CUSTOMER,
    grant,
    { channel: 'sms', expectedVersion: 0, action: 'grant', proof: 'case-verified-123' },
    options
  )
  const result = await optout()
  expect(result).toMatchObject({ channel: 'sms', action: 'revoke', version: 2 })
  expect(await optout()).toEqual(result)
  expect(await readHighValueConsent(f.database, CLAIMS, CUSTOMER, 'sms', options)).toMatchObject({
    granted: false,
    version: 2
  })
  expect(await readOwnHighValueConsent(f.database, BUYER_CLAIMS, 'sms', options)).toMatchObject({
    granted: false,
    version: 2
  })
})
it('lets customers opt out before a grant and keeps channels separate', async () => {
  expect(await optout({ channel: 'whatsapp', expectedVersion: 0 })).toMatchObject({ version: 1 })
  expect(await readOwnHighValueConsent(f.database, BUYER_CLAIMS, 'sms', options)).toMatchObject({
    granted: false,
    version: 0
  })
})
it('never permits selecting a customer or granting consent via the opt-out endpoint', async () => {
  await expect(optout({ channel: 'sms', expectedVersion: 0, customerId: CUSTOMER })).rejects.toMatchObject({
    code: 'invalid_input'
  })
  await expect(optout({ channel: 'sms', expectedVersion: 0, action: 'grant' })).rejects.toMatchObject({
    code: 'invalid_input'
  })
})
it('rejects stale writes and command id reuse', async () => {
  await optout({ channel: 'sms', expectedVersion: 0 })
  await expect(optout({ channel: 'whatsapp', expectedVersion: 0 })).rejects.toMatchObject({ code: 'conflict' })
  await expect(optout({ channel: 'sms', expectedVersion: 0 }, second)).rejects.toMatchObject({ code: 'conflict' })
})
it('checks the live account session at the write', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (statements) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    return batch(statements)
  }
  await expect(optout({ channel: 'sms', expectedVersion: 0 })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_consent_commands').get()).toEqual({ n: 0 })
})
it('rejects an unverified customer and a revoked session', async () => {
  f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(BUYER_CLAIMS.identityId)
  await expect(optout({ channel: 'sms', expectedVersion: 0 })).rejects.toMatchObject({ code: 'email_unverified' })
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
  await expect(readOwnHighValueConsent(f.database, BUYER_CLAIMS, 'sms', options)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
it.each([
  {},
  { channel: 'email', expectedVersion: 0 },
  { channel: 'sms', expectedVersion: -1 },
  { channel: 'sms', expectedVersion: 0.5 }
])('rejects invalid opt-out %j', async (raw) => {
  await expect(optout(raw)).rejects.toMatchObject({ code: 'invalid_input' })
})
