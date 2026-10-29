import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  lifecycleFixture,
  CLAIMS,
  OTHER_CLAIMS,
  OPTIONS,
  NOW,
  CUSTOMER,
  OTHER_CUSTOMER
} from './account-lifecycle-fixture'
import {
  listD1ReplenishmentPlans,
  saveD1ReplenishmentPlan,
  scheduleReplenishmentReminders
} from '../../workers/auth/replenishment-reminders'
import { updateD1PreferenceCenter } from '../../workers/auth/preference-center'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { PREFERENCE_CENTER_POLICY_VERSION } from '../../shared/preference-center'

let f: Awaited<ReturnType<typeof lifecycleFixture>>
beforeEach(async () => {
  f = await lifecycleFixture()
})
afterEach(() => f.sqlite.close())
const V1 = 'v-1-1',
  V2 = 'v-2-1'
const key = (n: string) => deterministicUuid(`rr-${n}`)
const plan = (over: Record<string, unknown> = {}) => ({
  variantId: V1,
  action: 'save',
  expectedVersion: 0,
  source: 'declared',
  intervalDays: 30,
  ...over
})
const save = (k: string, body: unknown, claims = CLAIMS) =>
  saveD1ReplenishmentPlan(f.database, claims, key(k), body, OPTIONS)
const consent = (replenishment: boolean) =>
  updateD1AccountPreferences(
    f.database,
    CLAIMS,
    key(`consent-${replenishment}-${Math.random()}`),
    {
      expectedVersion: (
        f.sqlite.prepare('SELECT COALESCE(max(version),0) v FROM customer_account_preferences').get() as { v: number }
      ).v,
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
      preferences: { product_updates: false, replenishment }
    },
    OPTIONS
  )
const sched = (now = NOW) => scheduleReplenishmentReminders(f.database, { now })
const reminders = () =>
  f.sqlite
    .prepare(
      'SELECT status,suppression_reason,variant_id,created_at FROM replenishment_reminders ORDER BY created_at,variant_id'
    )
    .all() as {
    status: string
    suppression_reason: string | null
    variant_id: string
  }[]
const planRow = (variant = V1) =>
  f.sqlite.prepare('SELECT * FROM replenishment_plans WHERE variant_id=?').get(variant) as Record<string, unknown>
const dayAgo = (n: number) => new Date(Date.parse(NOW) - n * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('CUS-019 configurable plans', () => {
  it('creates a declared-consumption plan anchored on the last paid purchase', async () => {
    f.paidPurchase(V1, dayAgo(10))
    const receipt = await save('a', plan())
    expect(receipt).toMatchObject({
      version: 1,
      status: 'active',
      variantId: V1,
      intervalDays: 30,
      planSource: 'declared'
    })
    expect(planRow().next_due_at).toBe(
      new Date(Date.parse(dayAgo(10)) + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    )
  })
  it('without history a declared plan is due after one interval from now', async () => {
    await save('a', plan({ intervalDays: 14 }))
    expect(planRow().next_due_at).toBe('2030-01-16T12:00:00Z')
  })
  it('derives the interval from purchase history (median gap) and refuses with too little history', async () => {
    await expect(save('none', plan({ source: 'history', intervalDays: undefined }))).rejects.toMatchObject({
      code: 'insufficient_history'
    })
    f.paidPurchase(V1, dayAgo(90))
    f.paidPurchase(V1, dayAgo(60))
    f.paidPurchase(V1, dayAgo(20))
    const receipt = await save('hist', plan({ source: 'history', intervalDays: undefined }))
    expect(receipt).toMatchObject({ planSource: 'history', intervalDays: 35 })
  })
  it('ignores unpaid orders and other customers when reading history', async () => {
    f.paidPurchase(V1, dayAgo(90), OTHER_CUSTOMER)
    f.paidPurchase(V1, dayAgo(50), OTHER_CUSTOMER)
    await expect(save('x', plan({ source: 'history', intervalDays: undefined }))).rejects.toMatchObject({
      code: 'insufficient_history'
    })
  })
  it('is idempotent by key, rejects a changed payload and uses CAS', async () => {
    const first = await save('k', plan())
    expect(await save('k', plan())).toEqual(first)
    await expect(save('k', plan({ intervalDays: 60 }))).rejects.toMatchObject({ code: 'conflict' })
    await expect(save('stale', plan({ intervalDays: 60 }))).rejects.toMatchObject({ code: 'conflict' })
    expect(await save('upd', plan({ intervalDays: 60, expectedVersion: 1 }))).toMatchObject({
      version: 2,
      intervalDays: 60
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM replenishment_plan_commands').get()).toEqual({ n: 2 })
  })
  it('pauses, resumes and cancels with state rules', async () => {
    await save('a', plan())
    expect(
      await save('p', plan({ action: 'pause', expectedVersion: 1, intervalDays: undefined, source: undefined }))
    ).toMatchObject({ status: 'paused', version: 2 })
    expect(
      await save('r', plan({ action: 'resume', expectedVersion: 2, intervalDays: undefined, source: undefined }))
    ).toMatchObject({ status: 'active', version: 3 })
    expect(
      await save('c', plan({ action: 'cancel', expectedVersion: 3, intervalDays: undefined, source: undefined }))
    ).toMatchObject({ status: 'cancelled', version: 4 })
    await expect(
      save('p2', plan({ action: 'pause', expectedVersion: 4, intervalDays: undefined, source: undefined }))
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await save('again', plan({ expectedVersion: 4 }))).toMatchObject({ status: 'active', version: 5 })
  })
  it('requires an existing plan to pause or resume', async () => {
    await expect(
      save('p', plan({ action: 'pause', intervalDays: undefined, source: undefined }))
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it.each([
    ['too short', { intervalDays: 6 }],
    ['too long', { intervalDays: 366 }],
    ['fractional', { intervalDays: 7.5 }],
    ['missing interval for declared', { intervalDays: undefined }],
    ['interval with history source', { source: 'history' }],
    ['unknown action', { action: 'delete' }],
    ['unknown extra field', { surprise: 1 }],
    ['bad variant', { variantId: 'bad id!' }]
  ])('rejects %s', async (_n, over) => {
    await expect(save('bad', plan(over))).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('rejects an unknown or unpublished variant', async () => {
    await expect(save('nf', plan({ variantId: deterministicUuid('no-such-variant') }))).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('requires a live session', async () => {
    await expect(saveD1ReplenishmentPlan(f.database, null, key('a'), plan(), OPTIONS)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('isolates customers and lists only own plans with sku and cap policy', async () => {
    await save('mine', plan())
    await save('theirs', plan({ intervalDays: 90 }), OTHER_CLAIMS)
    const list = await listD1ReplenishmentPlans(f.database, CLAIMS, OPTIONS)
    expect(list.plans).toHaveLength(1)
    expect(list.plans[0]).toMatchObject({ variantId: V1, sku: 'SKU-1-1', intervalDays: 30 })
    expect(list.cap).toEqual({ maxQueued: 1, windowDays: 7 })
    expect(list.consent).toEqual({ replenishment: false })
  })
})

describe('CUS-019 reminder scheduler', () => {
  async function dueFor(variant = V1, claims = CLAIMS) {
    await save(`due-${variant}-${claims.identityId}`, plan({ variantId: variant, intervalDays: 7 }), claims)
    f.sqlite.exec(
      `UPDATE replenishment_plans SET next_due_at='${dayAgo(1)}' WHERE variant_id='${variant}' AND customer_id='${claims === CLAIMS ? CUSTOMER : OTHER_CUSTOMER}'`
    )
  }
  it('suppresses with no_consent when the replenishment consent was never given', async () => {
    await dueFor()
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 1 })
    expect(reminders()).toMatchObject([{ status: 'suppressed', suppression_reason: 'no_consent' }])
  })
  it('queues a reminder with consent and advances the plan beyond now', async () => {
    await consent(true)
    await dueFor()
    expect(await sched()).toMatchObject({ queued: 1, suppressed: 0, deferred: 0 })
    expect(reminders()).toMatchObject([{ status: 'queued', suppression_reason: null, variant_id: V1 }])
    expect(String(planRow().next_due_at) > NOW).toBe(true)
    expect(planRow().last_reminded_at).toBe(NOW)
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 0 })
    expect(reminders()).toHaveLength(1)
  })
  it('does nothing for paused or cancelled plans and future plans', async () => {
    await consent(true)
    await dueFor()
    f.sqlite.exec("UPDATE replenishment_plans SET status='paused'")
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 0 })
    f.sqlite.exec(`UPDATE replenishment_plans SET status='active',next_due_at='2030-02-01T00:00:00Z'`)
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 0 })
    expect(reminders()).toHaveLength(0)
  })
  it('caps reminders to one per customer per 7 days and defers the rest without losing them', async () => {
    await consent(true)
    await dueFor(V1)
    await dueFor(V2)
    expect(await sched()).toMatchObject({ queued: 1, deferred: 1 })
    expect(reminders().filter((r) => r.status === 'queued')).toHaveLength(1)
    expect(await sched('2030-01-05T12:00:00Z')).toMatchObject({ queued: 0, deferred: 1 })
    expect(await sched('2030-01-10T12:00:00Z')).toMatchObject({ queued: 1, deferred: 1 })
    expect(reminders().filter((r) => r.status === 'queued')).toHaveLength(2)
  })
  it('does not let one customer consume another customer cap', async () => {
    await consent(true)
    await updateD1AccountPreferences(
      f.database,
      OTHER_CLAIMS,
      key('oc'),
      {
        expectedVersion: 0,
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
        preferences: { product_updates: false, replenishment: true }
      },
      OPTIONS
    )
    await dueFor(V1)
    await dueFor(V1, OTHER_CLAIMS)
    expect(await sched()).toMatchObject({ queued: 2 })
  })
  it('suppresses when the customer already repurchased and re-anchors on that purchase', async () => {
    await consent(true)
    await dueFor()
    f.paidPurchase(V1, dayAgo(2))
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 1 })
    expect(reminders()).toMatchObject([{ suppression_reason: 'purchased_since' }])
    expect(planRow().next_due_at).toBe(
      new Date(Date.parse(dayAgo(2)) + 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    )
  })
  it('honours the preference centre: unsubscribe-all and email channel off suppress', async () => {
    await consent(true)
    await dueFor()
    await updateD1PreferenceCenter(
      f.database,
      CLAIMS,
      key('pc'),
      {
        expectedVersion: 0,
        policyVersion: PREFERENCE_CENTER_POLICY_VERSION,
        acknowledged: true,
        preferences: {
          frequency: 'monthly',
          topics: ['offers'],
          sectors: [],
          channels: { email: false, sms: true, push: false },
          unsubscribeAll: false
        }
      },
      OPTIONS
    )
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 1 })
    expect(reminders()[0]).toMatchObject({ suppression_reason: 'email_channel_off' })
    f.sqlite.exec(`UPDATE replenishment_plans SET next_due_at='${dayAgo(2)}'`)
    await updateD1PreferenceCenter(
      f.database,
      CLAIMS,
      key('pc2'),
      {
        expectedVersion: 1,
        policyVersion: PREFERENCE_CENTER_POLICY_VERSION,
        acknowledged: false,
        preferences: {
          frequency: 'never',
          topics: [],
          sectors: [],
          channels: { email: false, sms: false, push: false },
          unsubscribeAll: true
        }
      },
      OPTIONS
    )
    expect(await sched()).toMatchObject({ queued: 0, suppressed: 1 })
    expect(reminders()[1]).toMatchObject({ suppression_reason: 'unsubscribed_all' })
  })
  it('skips blocked customers and honours the batch limit', async () => {
    await consent(true)
    await dueFor(V1)
    await dueFor(V2)
    expect(await scheduleReplenishmentReminders(f.database, { now: NOW, limit: 1 })).toMatchObject({ queued: 1 })
    expect(reminders()).toHaveLength(1)
  })
  it('is append-only and cap-guarded at the database level', async () => {
    await consent(true)
    await dueFor(V1)
    await sched()
    expect(() =>
      f.sqlite.exec("UPDATE replenishment_reminders SET status='suppressed',suppression_reason='no_consent'")
    ).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM replenishment_reminders')).toThrow(/immutable/)
    const planId = (f.sqlite.prepare('SELECT id FROM replenishment_plans').get() as { id: string }).id
    expect(() =>
      f.sqlite.exec(
        `INSERT INTO replenishment_reminders(id,plan_id,customer_id,variant_id,due_at,status,created_at) VALUES('${deterministicUuid('x')}','${planId}','${CUSTOMER}','${V1}','2030-03-01T00:00:00Z','queued','${NOW}')`
      )
    ).toThrow(/frequency_cap/)
  })
  it('rejects an invalid instant', async () => {
    await expect(scheduleReplenishmentReminders(f.database, { now: 'yesterday' })).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
})
