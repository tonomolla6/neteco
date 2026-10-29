import { afterEach, beforeEach, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  readD1AccountPreferences,
  updateD1AccountPreferences,
  readD1AccountPreferenceCommand
} from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION as POLICY } from '../../shared/account-preferences'
import {
  preferencesFixture,
  CLAIMS,
  OPTIONS,
  KEY,
  ACTOR,
  CUSTOMER,
  SESSION,
  NOW,
  BEFORE
} from './d1-account-preferences-fixture'
let f: Awaited<ReturnType<typeof preferencesFixture>>
beforeEach(async () => {
  f = await preferencesFixture(true)
})
afterEach(() => f.sqlite.close())
it('reads opted-out defaults without creating consent, subscriptions, preferences or quota writes', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    source: 'cloudflare',
    version: 0,
    preferences: { product_updates: false, replenishment: false },
    updatedAt: null
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
const INPUT = {
  expectedVersion: 0,
  policyVersion: POLICY,
  preferences: { product_updates: true, replenishment: false }
}
it('rejects unsupported channels, newsletter, wrong policy, incomplete or nonboolean preferences', async () => {
  for (const input of [
    { ...INPUT, extra: 1 },
    { ...INPUT, policyVersion: 'other' },
    { ...INPUT, expectedVersion: -1 },
    { ...INPUT, preferences: { product_updates: true } },
    { ...INPUT, preferences: { ...INPUT.preferences, newsletter: true } },
    { ...INPUT, preferences: { ...INPUT.preferences, replenishment: 'yes' } },
    { ...INPUT, channel: 'sms' }
  ])
    await expect(updateD1AccountPreferences(f.database, CLAIMS, KEY, input, OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
})
it('unknown receipt is read-only and never proves absence', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await readD1AccountPreferenceCommand(f.database, CLAIMS, KEY, OPTIONS)).toMatchObject({
    outcome: 'unknown',
    receipt: null
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('rejects stale version and changed same-key payload; records withdrawal and defaults without touching newsletter', async () => {
  await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)
  await expect(
    updateD1AccountPreferences(
      f.database,
      CLAIMS,
      KEY,
      { ...INPUT, preferences: { product_updates: false, replenishment: false } },
      OPTIONS
    )
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    updateD1AccountPreferences(f.database, CLAIMS, deterministicUuid('stale-preferences'), INPUT, OPTIONS)
  ).rejects.toMatchObject({ code: 'conflict' })
  await updateD1AccountPreferences(
    f.database,
    CLAIMS,
    deterministicUuid('withdraw-preferences'),
    { ...INPUT, expectedVersion: 1, preferences: { product_updates: false, replenishment: false } },
    OPTIONS
  )
  expect(await readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    version: 2,
    preferences: { product_updates: false, replenishment: false }
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 2 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM newsletter_subscriptions').get()).toEqual({ n: 0 })
})
it.each(['session', 'email', 'customer', 'identity', 'mfa'] as const)(
  'rejects current %s authority without writes',
  async (kind) => {
    if (kind === 'session') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
    if (kind === 'email') f.sqlite.exec('UPDATE identities SET email_verified_at=NULL')
    if (kind === 'customer') f.sqlite.exec("UPDATE customers SET status='blocked'")
    if (kind === 'identity') f.sqlite.exec("UPDATE identities SET status='locked'")
    if (kind === 'mfa')
      f.sqlite
        .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,?,?,?)')
        .run(ACTOR, 'synthetic', BEFORE, BEFORE)
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    await expect(readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).rejects.toMatchObject({
      code: kind === 'email' ? 'email_unverified' : kind === 'mfa' ? 'mfa_required' : 'unauthenticated'
    })
    await expect(updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)).rejects.toBeDefined()
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  }
)
it.each(['snapshot', 'receipt'] as const)(
  'revocation after %s read blocks the final private response',
  async (kind) => {
    if (kind === 'receipt') await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)
    const prepare = f.database.prepare.bind(f.database)
    f.database.prepare = (sql: string) => {
      const statement = prepare(sql)
      if (sql.includes(kind === 'snapshot' ? 'preference_snapshot' : 'preference_receipt')) {
        const first = statement.first.bind(statement)
        statement.first = async (...args: Parameters<typeof first>) => {
          const row = await first(...args)
          f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
          return row
        }
      }
      return statement
    }
    await expect(
      kind === 'snapshot'
        ? readD1AccountPreferences(f.database, CLAIMS, OPTIONS)
        : readD1AccountPreferenceCommand(f.database, CLAIMS, KEY, OPTIONS)
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  }
)
it.each(['revoke', 'cas', 'rollback'] as const)(
  'atomic command rejects %s race without partial consent',
  async (kind) => {
    const batch = f.database.batch.bind(f.database)
    f.database.batch = async (statements) => {
      if (kind === 'revoke') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
      if (kind === 'cas')
        await updateD1AccountPreferences(
          { ...f.database, batch } as D1Database,
          CLAIMS,
          deterministicUuid('other-preference-command'),
          INPUT,
          OPTIONS
        )
      if (kind === 'rollback')
        f.sqlite.exec(
          "CREATE TRIGGER preferences_test_abort BEFORE INSERT ON customer_account_preferences BEGIN SELECT RAISE(ABORT,'injected_failure');END"
        )
      return batch(statements)
    }
    await expect(updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)).rejects.toMatchObject({
      code: kind === 'revoke' ? 'unauthenticated' : kind === 'cas' ? 'conflict' : 'unavailable'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM account_preference_commands WHERE command_id=?').get(KEY)).toEqual({
      n: 0
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM customer_account_preferences').get()).toEqual({
      n: kind === 'cas' ? 1 : 0
    })
  }
)
it('recovers a committed batch whose response was lost without issuing another write', async () => {
  const batch = f.database.batch.bind(f.database)
  let calls = 0
  f.database.batch = async (s) => {
    calls++
    await batch(s)
    throw new Error('lost_after_commit')
  }
  expect(await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)).toMatchObject({ version: 1 })
  expect(calls).toBe(1)
})
it('customer reassignment never exposes the old customer snapshot or receipt', async () => {
  await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)
  const other = deterministicUuid('other-preferences-customer')
  f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(other, BEFORE, BEFORE)
  f.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(other, ACTOR)
  expect(await readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({ version: 0 })
  expect(await readD1AccountPreferenceCommand(f.database, CLAIMS, KEY, OPTIONS)).toMatchObject({
    outcome: 'unknown',
    receipt: null
  })
})
it('rejects invalid/corrupt snapshot instead of presenting opted-out defaults', async () => {
  await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => {
    const st = prepare(sql)
    if (sql.includes('preference_snapshot')) {
      const first = st.first.bind(st)
      st.first = async (...args: Parameters<typeof first>) =>
        ({ ...((await first(...args)) as Record<string, unknown>), productUpdates: 2 }) as never
    }
    return st
  }
  await expect(readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).rejects.toBeDefined()
})
it('schema prevents malformed consent commands and deletion or mutation of the immutable ledger', async () => {
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
  // A structurally complete direct write is still rejected without current authority.
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO account_preference_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(CUSTOMER, KEY, ACTOR, SESSION, 1, 'a'.repeat(64), 0, 1, 1, 0, POLICY, 'b'.repeat(64), NOW)
  ).toThrow()
  f.sqlite.exec('UPDATE auth_sessions SET revoked_at=NULL')
  await updateD1AccountPreferences(f.database, CLAIMS, KEY, INPUT, OPTIONS)
  expect(() => f.sqlite.exec('DELETE FROM account_preference_commands')).toThrow(/immutable/)
  expect(() => f.sqlite.exec("UPDATE account_preference_commands SET text_hash='bad'")).toThrow(/immutable/)
})
it('records explicit choices atomically with CAS and recovers the exact original receipt', async () => {
  const input = {
    expectedVersion: 0,
    policyVersion: POLICY,
    preferences: { product_updates: true, replenishment: false }
  }
  const receipt = await updateD1AccountPreferences(f.database, CLAIMS, KEY, input, OPTIONS)
  expect(receipt).toMatchObject({
    source: 'cloudflare',
    commandId: KEY,
    expectedVersion: 0,
    version: 1,
    preferences: input.preferences
  })
  expect(await updateD1AccountPreferences(f.database, CLAIMS, KEY, input, OPTIONS)).toEqual(receipt)
  expect(await readD1AccountPreferenceCommand(f.database, CLAIMS, KEY, OPTIONS)).toMatchObject({
    outcome: 'applied',
    receipt
  })
  expect(await readD1AccountPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    version: 1,
    preferences: input.preferences
  })
})
