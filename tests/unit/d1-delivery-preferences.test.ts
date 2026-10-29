import { beforeEach, afterEach, expect, it } from 'vitest'
import {
  deliveryPreferencesFixture,
  CLAIMS,
  OPTIONS,
  KEY,
  ACTOR,
  CUSTOMER,
  SESSION,
  NOW,
  BEFORE
} from './d1-delivery-preferences-fixture'
import {
  readD1DeliveryPreferences,
  updateD1DeliveryPreferences,
  readD1DeliveryPreferenceCommand
} from '../../workers/auth/delivery-preferences'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  deliveryPreferenceIntentHash
} from '../../shared/delivery-preferences'
import { deterministicUuid } from '../fixtures/deterministic'
let f: Awaited<ReturnType<typeof deliveryPreferencesFixture>>
beforeEach(async () => {
  f = await deliveryPreferencesFixture()
})
afterEach(() => f?.sqlite.close())
const INPUT = { expectedVersion: 0, deliveryUpdates: false, policyVersion: POLICY }
const execute = (input: unknown = INPUT, key = KEY) =>
  updateD1DeliveryPreferences(f.database, CLAIMS, key, input, OPTIONS)

it('reads delivery defaults without mutating commercial consent, queues or creating preference history', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(await readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    source: 'cloudflare',
    version: 0,
    deliveryUpdates: true,
    updatedAt: null
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('records explicit operational opt-out atomically, replays exactly and recovers without a second write', async () => {
  const receipt = await execute()
  expect(receipt).toMatchObject({
    commandId: KEY,
    expectedVersion: 0,
    version: 1,
    deliveryUpdates: false,
    policyVersion: POLICY
  })
  expect(await execute()).toEqual(receipt)
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(
    await readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
  ).toMatchObject({ outcome: 'applied', receipt })
  expect(await readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    version: 1,
    deliveryUpdates: false
  })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  expect(f.sqlite.prepare('SELECT count(*) n FROM delivery_preference_commands').get()).toEqual({ n: 1 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM newsletter_subscriptions').get()).toEqual({ n: 0 })
})
it('distinguishes genuine stale CAS from changed same-key input and mismatched receipt hash', async () => {
  await execute()
  await expect(execute({ ...INPUT, deliveryUpdates: true })).rejects.toMatchObject({ code: 'conflict' })
  await expect(execute(INPUT, deterministicUuid('delivery-stale'))).rejects.toMatchObject({ code: 'version_conflict' })
  await expect(readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, '0'.repeat(64), OPTIONS)).rejects.toMatchObject(
    { code: 'conflict' }
  )
  await execute({ ...INPUT, expectedVersion: 1, deliveryUpdates: true }, deterministicUuid('delivery-reenable'))
  expect(await readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    version: 2,
    deliveryUpdates: true
  })
  expect(await execute()).toMatchObject({ version: 1, deliveryUpdates: false })
})
it('unknown is readonly and never creates defaults or proves absence', async () => {
  const before = f.sqlite.prepare('SELECT total_changes() n').get()
  expect(
    await readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
  ).toEqual({ source: 'cloudflare', commandId: KEY, outcome: 'unknown', receipt: null })
  expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it.each(['session', 'email', 'customer', 'identity', 'mfa'] as const)(
  'rejects current %s authority before writes and receipt reads',
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
    await expect(execute()).rejects.toMatchObject({
      code: kind === 'email' ? 'email_unverified' : kind === 'mfa' ? 'mfa_required' : 'unauthenticated'
    })
    await expect(
      readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
    ).rejects.toBeDefined()
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  }
)
it.each(['revoke', 'cas', 'rollback'] as const)(
  'rejects %s at the atomic batch without partial history',
  async (kind) => {
    const batch = f.database.batch.bind(f.database)
    f.database.batch = async (statements) => {
      if (kind === 'revoke') f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
      if (kind === 'cas')
        await updateD1DeliveryPreferences(
          { ...f.database, batch } as D1Database,
          CLAIMS,
          deterministicUuid('delivery-race'),
          INPUT,
          OPTIONS
        )
      if (kind === 'rollback')
        f.sqlite.exec(
          "CREATE TRIGGER delivery_test_abort BEFORE INSERT ON delivery_preferences BEGIN SELECT RAISE(ABORT,'synthetic_failure');END"
        )
      return batch(statements)
    }
    await expect(execute()).rejects.toMatchObject({
      code: kind === 'revoke' ? 'unauthenticated' : kind === 'cas' ? 'version_conflict' : 'unavailable'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM delivery_preference_commands WHERE command_id=?').get(KEY)).toEqual(
      { n: 0 }
    )
    expect(f.sqlite.prepare('SELECT count(*) n FROM delivery_preferences').get()).toEqual({ n: kind === 'cas' ? 1 : 0 })
  }
)
it('recovers an actual commit after its batch response is lost', async () => {
  const batch = f.database.batch.bind(f.database)
  let calls = 0
  f.database.batch = async (statements) => {
    calls++
    await batch(statements)
    throw new Error('synthetic_lost_response')
  }
  expect(await execute()).toMatchObject({ version: 1 })
  expect(calls).toBe(1)
})
it.each(['snapshot', 'receipt'] as const)('rechecks authority after the private %s read', async (kind) => {
  if (kind === 'receipt') await execute()
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    const st = prepare(sql)
    if (sql.includes(kind === 'snapshot' ? 'SELECT COALESCE(p.version' : 'SELECT command_id,payload_hash')) {
      const first = st.first.bind(st)
      st.first = async (...args: Parameters<typeof first>) => {
        const row = await first(...args)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
        return row
      }
    }
    return st
  }
  await expect(
    kind === 'snapshot'
      ? readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)
      : readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
  ).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('reassignment hides previous customer history instead of reusing defaults or receipts across owners', async () => {
  await execute()
  const other = deterministicUuid('delivery-other-customer')
  f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(other, BEFORE, BEFORE)
  f.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(other, ACTOR)
  expect(await readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)).toMatchObject({
    version: 0,
    deliveryUpdates: true
  })
  expect(
    await readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
  ).toMatchObject({ outcome: 'unknown', receipt: null })
})
it('never returns default true or unknown for corrupted recorded history', async () => {
  await execute()
  f.sqlite.exec('DROP TRIGGER delivery_preference_snapshot_no_delete;DELETE FROM delivery_preferences')
  await expect(readD1DeliveryPreferences(f.database, CLAIMS, OPTIONS)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(
    readD1DeliveryPreferenceCommand(f.database, CLAIMS, KEY, await deliveryPreferenceIntentHash(INPUT), OPTIONS)
  ).rejects.toMatchObject({ code: 'unavailable' })
})
it('schema enforces actor authority, immutable commands and confirmed projections', async () => {
  await execute()
  expect(() => f.sqlite.exec('DELETE FROM delivery_preference_commands')).toThrow(/immutable/)
  expect(() => f.sqlite.exec("UPDATE delivery_preference_commands SET payload_hash='bad'")).toThrow(/immutable/)
  expect(() => f.sqlite.exec('UPDATE delivery_preferences SET delivery_updates=1')).toThrow(/unconfirmed/)
  f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO delivery_preference_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        CUSTOMER,
        deterministicUuid('delivery-forged'),
        ACTOR,
        SESSION,
        1,
        'a'.repeat(64),
        1,
        2,
        1,
        POLICY,
        'b'.repeat(64),
        NOW
      )
  ).toThrow(/conflict/)
})
it('checks final live authority before returning a known stale-version rejection', async () => {
  await execute()
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql) => {
    const st = prepare(sql)
    if (sql.startsWith('SELECT 1 present FROM delivery_preference_commands WHERE customer_id=?1 AND command_id=?2')) {
      const first = st.first.bind(st)
      st.first = async (...args: Parameters<typeof first>) => {
        const row = await first(...args)
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
        return row
      }
    }
    return st
  }
  await expect(execute(INPUT, deterministicUuid('delivery-stale-revoked'))).rejects.toMatchObject({
    code: 'unauthenticated'
  })
})
