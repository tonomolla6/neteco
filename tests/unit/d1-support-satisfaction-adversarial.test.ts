import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, CLAIMS, BUYER_CLAIMS, POLICY } from './d1-support-fixture'
import { executeSupportAdminCommand } from '../../workers/support/operations'
import {
  submitCustomerSatisfaction,
  readAdminSatisfaction,
  readCustomerSatisfaction
} from '../../workers/support/satisfaction'

describe('CSAT authority and atomicity at the commit boundary', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let target: string
  const body = {
    score: 5,
    comment: 'Comentario sintético que no es una autorización.',
    privacyAcknowledged: true,
    expectedSourceVersion: 2,
    expectedPolicyHash: ''
  }
  beforeEach(async () => {
    f = await supportFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0068_support_satisfaction.sql', import.meta.url), 'utf8')
    )
    target = (await f.ticket()).publicRef
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      target,
      {
        action: 'update',
        expectedVersion: 1,
        reason: 'Comprobación sintética previa',
        state: 'resolved',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null,
        resolution: 'Respuesta sintética documentada antes de valorar.'
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    body.expectedPolicyHash = (
      await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target)
    ).privacy!.policyHash
  })
  afterEach(() => f?.sqlite.close())

  function beforeCommit(change: () => Promise<void> | void) {
    let reached = false
    const database = new Proxy(f.database, {
      get(db, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!reached) {
              reached = true
              await change()
            }
            return db.batch(statements)
          }
        const value = Reflect.get(db, property)
        return typeof value === 'function' ? value.bind(db) : value
      }
    })
    return { database, reached: () => reached }
  }

  it('rolls back if the customer session is revoked after preflight and before the batch', async () => {
    const before = f.economic()
    const race = beforeCommit(() => {
      f.sqlite
        .prepare("UPDATE auth_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
        .run(BUYER_CLAIMS.sessionId)
    })
    await expect(
      submitCustomerSatisfaction(race.database, BUYER_CLAIMS, 'support', target, body, {
        idempotencyKey: crypto.randomUUID(),
        policy: POLICY
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(race.reached()).toBe(true)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
    expect(f.economic()).toEqual(before)
  })

  it('does not attach a stale draft when the resolved ticket reopens immediately before commit', async () => {
    const race = beforeCommit(async () => {
      await executeSupportAdminCommand(
        f.database,
        CLAIMS,
        target,
        {
          action: 'update',
          expectedVersion: 2,
          reason: 'Nueva información sintética del caso',
          state: 'open',
          priority: 'normal',
          ownerId: null,
          nextActionAt: null,
          slaDueAt: null
        },
        { idempotencyKey: crypto.randomUUID() }
      )
    })
    await expect(
      submitCustomerSatisfaction(race.database, BUYER_CLAIMS, 'support', target, body, {
        idempotencyKey: crypto.randomUUID(),
        policy: POLICY
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(source_version_conflict|source_not_final)$/) })
    expect(race.reached()).toBe(true)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT state FROM support_tickets WHERE public_ref=?').get(target)).toEqual({
      state: 'open'
    })
  })

  it('requires current MFA and the support grant even for aggregate-only reads', async () => {
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    await expect(readAdminSatisfaction(f.database, CLAIMS, {})).rejects.toMatchObject({ code: 'mfa_required' })
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(CLAIMS.sessionId)
    f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='support.manage'")
    await expect(readAdminSatisfaction(f.database, CLAIMS, {})).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('never extends access to an existing delivery comment when the configured policy changes', async () => {
    const originalPolicy = { ...POLICY, retentionDays: 1 }
    const state = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, {
      policy: originalPolicy
    })
    expect(state.eligible).toBe(true)
    await submitCustomerSatisfaction(
      f.database,
      BUYER_CLAIMS,
      'delivery',
      f.order,
      {
        ...body,
        expectedSourceVersion: state.target.version,
        expectedPolicyHash: state.privacy!.policyHash
      },
      { policy: originalPolicy, idempotencyKey: crypto.randomUUID() }
    )
    const row = f.sqlite
      .prepare("SELECT retention_until FROM support_satisfaction_feedback WHERE kind='delivery'")
      .get() as { retention_until: string }
    // Keep the synthetic session valid so this exercises data expiry, not auth expiry.
    const sessionExpiry = new Date(Date.parse(row.retention_until) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(sessionExpiry, BUYER_CLAIMS.sessionId)
    expect(
      await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, {
        now: row.retention_until,
        policy: { ...POLICY, retentionDays: 30 }
      })
    ).toMatchObject({ eligible: false, reason: 'retention_expired', feedback: null })
  })

  it('does not treat acknowledgement of the displayed privacy policy as acceptance of a different version', async () => {
    const offered = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, { policy: POLICY })
    const changedPolicy = { ...POLICY, version: POLICY.version + 1, privacyNoticePath: '/privacidad-actualizada' }
    const draft = {
      ...body,
      expectedSourceVersion: offered.target.version,
      expectedPolicyHash: offered.privacy!.policyHash
    }
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, draft, {
        policy: changedPolicy,
        idempotencyKey: crypto.randomUUID()
      })
    ).rejects.toMatchObject({ code: 'policy_version_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
    const fresh = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, {
      policy: changedPolicy
    })
    expect(fresh.privacy!.policyHash).not.toBe(offered.privacy!.policyHash)
    await expect(
      submitCustomerSatisfaction(
        f.database,
        BUYER_CLAIMS,
        'delivery',
        f.order,
        {
          ...draft,
          expectedPolicyHash: fresh.privacy!.policyHash
        },
        { policy: changedPolicy, idempotencyKey: crypto.randomUUID() }
      )
    ).resolves.toMatchObject({ score: body.score })
  })
})
