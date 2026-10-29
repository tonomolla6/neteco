import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BUYER_CLAIMS, CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { listPaymentTokens, requestPaymentTokenRemoval } from '../../workers/payments/token-removal'

let f: Awaited<ReturnType<typeof returnsFixture>>
const tokenId = '40000000-0000-4000-8000-000000000022'
const key = '50000000-0000-4000-8000-000000000022'
const key2 = '50000000-0000-4000-8000-000000000023'
const opts = { now: () => utc() }
const input = { tokenId, expectedVersion: 1, commandId: key }

beforeEach(async () => {
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
  f.sqlite
    .prepare(
      `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at)
    VALUES(?,?,?,'active',1,'v1',?,?,?)`
    )
    .run(tokenId, CUSTOMER, 'provider-private-reference', utc(), utc(), utc())
})
afterEach(() => f?.sqlite.close())

it('lists only the owner safe metadata and never exposes a provider token', async () => {
  const result = await listPaymentTokens(f.database, BUYER_CLAIMS, opts)
  expect(result).toMatchObject({ tokens: [{ id: tokenId, status: 'active', version: 1 }] })
  expect(JSON.stringify(result)).not.toContain('provider-private-reference')
})
it('records removal and hides the token immediately without claiming provider deletion', async () => {
  const result = await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  expect(result).toMatchObject({ tokenId, version: 2, outcome: 'removal_pending' })
  expect(await listPaymentTokens(f.database, BUYER_CLAIMS, opts)).toMatchObject({ tokens: [] })
  expect(
    f.sqlite.prepare('SELECT status,provider_token FROM payment_saved_tokens WHERE id=?').get(tokenId)
  ).toMatchObject({ status: 'removal_pending', provider_token: 'provider-private-reference' })
})
it('replays the same command without appending another audit entry', async () => {
  const first = await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  expect(await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)).toEqual(first)
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_audit').get()).toMatchObject({ n: 1 })
})
it('rejects a reused command with a changed payload', async () => {
  await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  await expect(
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, { ...input, expectedVersion: 2 }, opts)
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('rejects a stale version without changing the token or audit', async () => {
  await expect(
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, { ...input, expectedVersion: 2 }, opts)
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_audit').get()).toMatchObject({ n: 0 })
})
it('serializes concurrent different removal commands with compare-and-swap', async () => {
  const outcomes = await Promise.allSettled([
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts),
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, { ...input, commandId: key2 }, opts)
  ])
  expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1)
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_audit').get()).toMatchObject({ n: 1 })
})
it('does not disclose another customer token', async () => {
  await expect(requestPaymentTokenRemoval(f.database, CLAIMS, input, opts)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
it('rejects removed or expired sessions before replay', async () => {
  await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
  await expect(requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
it.each([
  { tokenId: 'invalid' },
  { commandId: 'invalid' },
  { expectedVersion: 0 },
  { expectedVersion: 1.5 },
  { expectedVersion: -1 },
  { extra: true }
])('rejects invalid command %#', async (change) => {
  await expect(
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, { ...input, ...change }, opts)
  ).rejects.toMatchObject({ code: 'invalid_input' })
})
it('rejects unknown token', async () => {
  await expect(
    requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, { ...input, tokenId: key2 }, opts)
  ).rejects.toMatchObject({ code: 'not_found' })
})
it('does not leak list data if session is revoked during the read', async () => {
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    const statement = prepare(sql)
    if (sql.includes('FROM payment_saved_tokens')) {
      const all = statement.all.bind(statement)
      statement.all = async (...args: Parameters<typeof all>) => {
        const result = await all(...args)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
        return result
      }
    }
    return statement
  }
  await expect(listPaymentTokens(f.database, BUYER_CLAIMS, opts)).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('keeps audit append-only in SQL', async () => {
  await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  expect(() => f.sqlite.exec('DELETE FROM payment_token_audit')).toThrow()
  expect(() => f.sqlite.exec("UPDATE payment_token_audit SET action='changed'")).toThrow()
})
it('does not retain transient transaction guards', async () => {
  await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_guards').get()).toMatchObject({ n: 0 })
})
it('does not replay a command whose audit proof is missing', async () => {
  await requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)
  f.sqlite.exec('DROP TRIGGER payment_token_audit_no_delete; DELETE FROM payment_token_audit')
  await expect(requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)).rejects.toMatchObject({
    code: 'unavailable'
  })
})
it('rolls back the write when authority is revoked immediately before the batch', async () => {
  const batch = f.database.batch.bind(f.database)
  f.database.batch = async (...args: Parameters<typeof batch>) => {
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    return batch(...args)
  }
  await expect(requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, opts)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
  expect(f.sqlite.prepare('SELECT status,version FROM payment_saved_tokens WHERE id=?').get(tokenId)).toMatchObject({
    status: 'active',
    version: 1
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM payment_token_audit').get()).toMatchObject({ n: 0 })
})
it('does not write when the real clock has passed the session expiry during an old request', async () => {
  const old = utc(-7200000),
    expired = utc(-3600000)
  f.sqlite
    .prepare('UPDATE auth_sessions SET created_at=?,expires_at=? WHERE id=?')
    .run(utc(-10800000), expired, BUYER_CLAIMS.sessionId)
  f.sqlite.prepare('UPDATE identities SET email_verified_at=? WHERE id=?').run(utc(-10800000), BUYER_CLAIMS.identityId)
  await expect(requestPaymentTokenRemoval(f.database, BUYER_CLAIMS, input, { now: () => old })).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect(f.sqlite.prepare('SELECT status,version FROM payment_saved_tokens WHERE id=?').get(tokenId)).toMatchObject({
    status: 'active',
    version: 1
  })
})
