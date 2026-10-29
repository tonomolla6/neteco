import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import { lifecycleFixture, CLAIMS, OTHER_CLAIMS, OPTIONS, NOW, CUSTOMER } from './account-lifecycle-fixture'
import { readD1PreferenceCenter, updateD1PreferenceCenter } from '../../workers/auth/preference-center'
import { createFakePreferenceSyncAdapter, runPreferenceCenterSync } from '../../workers/auth/preference-center-sync'
import {
  PREFERENCE_CENTER_POLICY_VERSION as POLICY,
  preferenceCenterValuesSchema
} from '../../shared/preference-center'

let f: Awaited<ReturnType<typeof lifecycleFixture>>
beforeEach(async () => {
  f = await lifecycleFixture()
})
afterEach(() => f.sqlite.close())
const key = (n: string) => deterministicUuid(`pc-${n}`)
const prefs = (over: Record<string, unknown> = {}) => ({
  frequency: 'monthly',
  topics: ['offers', 'product_news'],
  sectors: ['hospitality'],
  channels: { email: true, sms: false, push: false },
  unsubscribeAll: false,
  ...over
})
const input = (over: Record<string, unknown> = {}, expectedVersion = 0, acknowledged = true) => ({
  expectedVersion,
  policyVersion: POLICY,
  acknowledged,
  preferences: prefs(over)
})
const save = (k: string, body: unknown) => updateD1PreferenceCenter(f.database, CLAIMS, key(k), body, OPTIONS)
const count = (table: string) => (f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n

describe('CUS-015 preference centre', () => {
  it('reads opt-out defaults without writing anything (no pre-ticked options)', async () => {
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const snapshot = await readD1PreferenceCenter(f.database, CLAIMS, OPTIONS)
    expect(snapshot).toMatchObject({
      version: 0,
      updatedAt: null,
      preferences: { frequency: 'never', topics: [], sectors: [], unsubscribeAll: false },
      sync: { esp: null, cmp: null }
    })
    expect(Object.values(snapshot.preferences.channels)).toEqual([false, false, false])
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('stores frequency, topics, sectors and channels with a receipt and queues one ESP and one CMP job', async () => {
    const receipt = await save('a', input())
    expect(receipt).toMatchObject({
      version: 1,
      expectedVersion: 0,
      preferences: { frequency: 'monthly', topics: ['offers', 'product_news'], sectors: ['hospitality'] },
      sync: { esp: 'pending', cmp: 'pending' }
    })
    expect(await readD1PreferenceCenter(f.database, CLAIMS, OPTIONS)).toMatchObject({ version: 1, updatedAt: NOW })
    expect(count('preference_center_sync_jobs')).toBe(2)
  })
  it('normalises topic order so equivalent submissions hash identically', async () => {
    const a = await save('same', input({ topics: ['product_news', 'offers'] }))
    const b = await save('same', input({ topics: ['offers', 'product_news'] }))
    expect(b).toEqual(a)
    expect(count('preference_center_commands')).toBe(1)
  })
  it('replays the same key exactly and rejects the same key with another payload', async () => {
    const first = await save('r', input())
    expect(await save('r', input())).toEqual(first)
    await expect(save('r', input({ frequency: 'weekly' }))).rejects.toMatchObject({ code: 'conflict' })
    expect(count('preference_center_commands')).toBe(1)
  })
  it('uses CAS on the version', async () => {
    await save('v1', input())
    await expect(save('stale', input({ frequency: 'weekly' }, 0))).rejects.toMatchObject({ code: 'conflict' })
    expect(await save('v2', input({ frequency: 'weekly' }, 1))).toMatchObject({ version: 2 })
  })
  it('requires explicit acknowledgement only when something is newly switched on', async () => {
    await expect(save('noack', input({}, 0, false))).rejects.toMatchObject({ code: 'consent_required' })
    await save('ok', input())
    // Narrowing and unchanged consents need no acknowledgement.
    expect(await save('narrow', input({ topics: ['offers'] }, 1, false))).toMatchObject({ version: 2 })
    await expect(save('widen', input({ topics: ['offers', 'usage_tips'] }, 2, false))).rejects.toMatchObject({
      code: 'consent_required'
    })
    await expect(
      save('sms', input({ channels: { email: true, sms: true, push: false } }, 2, false))
    ).rejects.toMatchObject({ code: 'consent_required' })
  })
  it('withdraws everything in one step with unsubscribeAll and no acknowledgement', async () => {
    await save('on', input())
    const out = await save(
      'off',
      input(
        {
          unsubscribeAll: true,
          frequency: 'never',
          topics: [],
          sectors: [],
          channels: { email: false, sms: false, push: false }
        },
        1,
        false
      )
    )
    expect(out).toMatchObject({ version: 2, preferences: { unsubscribeAll: true, frequency: 'never', topics: [] } })
  })
  it.each([
    ['unsubscribeAll mixed with topics', { unsubscribeAll: true }],
    ['topics with frequency never', { frequency: 'never' }],
    ['topics without any channel', { channels: { email: false, sms: false, push: false } }],
    ['unknown topic', { topics: ['spam'] }],
    ['duplicate topic', { topics: ['offers', 'offers'] }],
    ['unknown sector', { sectors: ['mars'] }],
    ['unknown frequency', { frequency: 'daily' }],
    ['unknown channel field', { channels: { email: true, sms: false, push: false, whatsapp: true } }]
  ])('rejects %s', async (_name, over) => {
    await expect(save('bad', input(over))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(count('preference_center_commands')).toBe(0)
  })
  it('rejects extra fields, a wrong policy and a malformed key', async () => {
    await expect(save('x', { ...input(), extra: 1 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(save('x', { ...input(), policyVersion: 'old' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(updateD1PreferenceCenter(f.database, CLAIMS, 'not-a-uuid', input(), OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('requires a live authenticated customer session', async () => {
    await expect(readD1PreferenceCenter(f.database, null, OPTIONS)).rejects.toMatchObject({ code: 'unauthenticated' })
    f.sqlite.exec(`UPDATE auth_sessions SET revoked_at='2025-01-01T00:00:00Z' WHERE id='${CLAIMS.sessionId}'`)
    await expect(save('revoked', input())).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(count('preference_center_commands')).toBe(0)
  })
  it('refuses unverified email', async () => {
    f.sqlite.exec(`UPDATE identities SET email_verified_at=NULL WHERE id='${CLAIMS.identityId}'`)
    await expect(save('unverified', input())).rejects.toMatchObject({ code: 'email_unverified' })
  })
  it('isolates customers and never reuses another customer key', async () => {
    await save('mine', input())
    expect(await readD1PreferenceCenter(f.database, OTHER_CLAIMS, OPTIONS)).toMatchObject({ version: 0 })
    const theirs = await updateD1PreferenceCenter(
      f.database,
      OTHER_CLAIMS,
      key('mine'),
      input({ frequency: 'weekly' }),
      OPTIONS
    )
    expect(theirs).toMatchObject({ version: 1, preferences: { frequency: 'weekly' } })
    expect(count('preference_center_commands')).toBe(2)
  })
  it('keeps commands append-only and database-guarded against forged versions', () => {
    f.sqlite.exec(
      `INSERT INTO preference_center_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,applied_version,frequency,topics,sectors,channel_email,channel_sms,channel_push,unsubscribe_all,policy_version,recorded_at)
 VALUES('${CUSTOMER}','${key('raw')}','${CLAIMS.identityId}','${CLAIMS.sessionId}',1,'${'a'.repeat(64)}',0,1,'never','[]','[]',0,0,0,0,'${POLICY}','${NOW}')`
    )
    expect(() => f.sqlite.exec("UPDATE preference_center_commands SET frequency='weekly'")).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM preference_center_commands')).toThrow(/immutable/)
    expect(() =>
      f.sqlite.exec(
        `INSERT INTO preference_center_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,applied_version,frequency,topics,sectors,channel_email,channel_sms,channel_push,unsubscribe_all,policy_version,recorded_at)
 VALUES('${CUSTOMER}','${key('forged')}','${CLAIMS.identityId}','${CLAIMS.sessionId}',1,'${'b'.repeat(64)}',5,6,'never','[]','[]',0,0,0,0,'${POLICY}','${NOW}')`
      )
    ).toThrow(/conflict/)
  })
  it('exposes the schema rules to the UI', () => {
    expect(preferenceCenterValuesSchema.safeParse(prefs({ topics: ['offers'] })).success).toBe(true)
    expect(preferenceCenterValuesSchema.safeParse(prefs({ unsubscribeAll: true })).success).toBe(false)
  })
})

describe('CUS-015 ESP/CMP synchronisation', () => {
  const run = (adapter: ReturnType<typeof createFakePreferenceSyncAdapter>, now = NOW) =>
    runPreferenceCenterSync(f.database, adapter, { now })
  it('delivers both targets once with an idempotency key and marks them synced', async () => {
    await save('s', input())
    const adapter = createFakePreferenceSyncAdapter()
    expect(await run(adapter)).toEqual({ synced: 2, failed: 0, skipped: 0 })
    expect(adapter.calls.map((c) => c.target).sort()).toEqual(['cmp', 'esp'])
    expect(JSON.stringify([...adapter.applied.values()])).not.toContain('@')
    expect(await readD1PreferenceCenter(f.database, CLAIMS, OPTIONS)).toMatchObject({
      sync: { esp: 'synced', cmp: 'synced' }
    })
    expect(await run(adapter)).toEqual({ synced: 0, failed: 0, skipped: 0 })
  })
  it('retries a failed target with backoff without resending the one that succeeded', async () => {
    await save('s', input())
    const adapter = createFakePreferenceSyncAdapter({ esp: 'esp_unavailable' })
    expect(await run(adapter)).toEqual({ synced: 1, failed: 1, skipped: 0 })
    expect(await run(adapter)).toEqual({ synced: 0, failed: 0, skipped: 0 })
    adapter.failures.esp = undefined
    expect(await run(adapter, '2030-01-02T12:02:00Z')).toEqual({ synced: 1, failed: 0, skipped: 0 })
    expect(
      f.sqlite.prepare("SELECT status,last_error_code FROM preference_center_sync_jobs WHERE target='esp'").get()
    ).toMatchObject({
      status: 'synced',
      last_error_code: null
    })
  })
  it('never sends a superseded version: the newest consent always wins', async () => {
    await save('one', input())
    await save('two', input({ frequency: 'weekly' }, 1))
    const adapter = createFakePreferenceSyncAdapter()
    await run(adapter)
    expect([...adapter.applied.values()].map((p) => p.version)).toEqual([2, 2])
    expect(count('preference_center_sync_jobs')).toBe(4)
  })
  it('turns an adapter exception into a retryable failure', async () => {
    await save('s', input())
    const adapter = { apply: async () => Promise.reject(new Error('boom')) }
    expect(await runPreferenceCenterSync(f.database, adapter, { now: NOW })).toEqual({
      synced: 0,
      failed: 2,
      skipped: 0
    })
  })
})
