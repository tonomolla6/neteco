import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { deterministicTestData } from '../fixtures/deterministic'
import { supportFixture, BUYER_CLAIMS, CLAIMS, utc, POLICY } from './d1-support-fixture'
import { executeSupportAdminCommand } from '../../workers/support/operations'
import {
  readCustomerSatisfaction,
  submitCustomerSatisfaction,
  readCustomerSatisfactionCommand,
  readAdminSatisfaction
} from '../../workers/support/satisfaction'
import { satisfactionIntentHash } from '../../shared/support-satisfaction'
import { canonicalJson, sha256Hex } from '../../workers/catalog/inventory'

describe('SUP010 authoritative optional private feedback', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let target: string
  let policyHash: string
  const data = deterministicTestData('support-satisfaction')
  const options = () => ({ now: utc(), policy: POLICY })
  const input = (version = 2) => ({
    score: 4,
    comment: 'Comentario privado sintético',
    privacyAcknowledged: true as const,
    expectedSourceVersion: version,
    expectedPolicyHash: policyHash
  })
  beforeEach(async () => {
    f = await supportFixture()
    policyHash = await sha256Hex(canonicalJson(POLICY))
    // Keep synthetic sessions alive beyond the data-retention test boundary.
    f.sqlite.prepare("UPDATE auth_sessions SET expires_at='2099-01-01T00:00:00Z'").run()
    // Baseline fixture ends at0062; feature DDL applied only after it exists.
    try {
      f.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0068_support_satisfaction.sql', import.meta.url), 'utf8')
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    target = (await f.ticket()).publicRef
  })
  afterEach(() => f.sqlite.close())
  async function resolve() {
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      target,
      {
        action: 'update',
        expectedVersion: 1,
        reason: 'Resolución sintética revisada',
        state: 'resolved',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null,
        resolution: 'Respuesta sintética completa al caso.'
      },
      { idempotencyKey: data.uuid(), now: utc() }
    )
  }
  it('offers CSAT only after real confirmed resolution using the original ticket retention', async () => {
    await resolve()
    const result = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, options())
    expect(result).toMatchObject({
      eligible: true,
      reason: null,
      target: { kind: 'support', id: target, version: 2 },
      privacy: { noticePath: '/privacidad' }
    })
    expect(result.privacy?.retentionUntil).toBe(
      (f.sqlite.prepare('SELECT retention_until FROM support_tickets').get() as { retention_until: string })
        .retention_until
    )
  })
  it('does not offer an unresolved source and does not require CSAT to continue support', async () => {
    expect(await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, options())).toMatchObject({
      eligible: false,
      reason: 'source_not_final',
      target: { version: 1 }
    })
    await resolve()
  })
  it('rejects missing/foreign customer authority before exposing eligibility', async () => {
    await expect(readCustomerSatisfaction(f.database, null, 'support', target, options())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    await expect(readCustomerSatisfaction(f.database, CLAIMS, 'support', target, options())).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('commits once, stores no raw comment in immutable receipt/command, and changes no economic source', async () => {
    await resolve()
    const before = f.economic(),
      key = data.uuid(),
      body = input()
    const receipt = await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, {
      ...options(),
      idempotencyKey: key
    })
    expect(receipt).toMatchObject({
      commandId: key,
      target: { version: 2 },
      score: 4,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    expect(JSON.stringify(receipt)).not.toContain(body.comment)
    expect(f.economic()).toEqual(before)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 1 })
    const rows = f.sqlite.prepare('SELECT * FROM support_satisfaction_commands').all()
    expect(JSON.stringify(rows)).not.toContain(body.comment)
    expect(await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, options())).toMatchObject({
      eligible: false,
      reason: 'already_submitted',
      feedback: { score: 4, comment: body.comment }
    })
  })
  it('replays the original receipt after reopening without a second feedback or retention extension', async () => {
    await resolve()
    const key = data.uuid(),
      body = input(),
      opts = { ...options(), idempotencyKey: key }
    const receipt = await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, opts)
    await executeSupportAdminCommand(
      f.database,
      CLAIMS,
      target,
      {
        action: 'update',
        expectedVersion: 2,
        reason: 'Reapertura sintética revisada',
        state: 'open',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null
      },
      { idempotencyKey: data.uuid(), now: utc() }
    )
    expect(await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, opts)).toEqual(receipt)
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, { ...body, score: 1 }, opts)
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('recovers only exact own key/hash and leaves unknown genuinely ambiguous', async () => {
    await resolve()
    const key = data.uuid(),
      body = input(),
      hash = await satisfactionIntentHash('support', target, body)
    const receipt = await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, {
      ...options(),
      idempotencyKey: key
    })
    expect(
      await readCustomerSatisfactionCommand(f.database, BUYER_CLAIMS, 'support', target, key, hash, options())
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(
      await readCustomerSatisfactionCommand(f.database, BUYER_CLAIMS, 'support', target, data.uuid(), hash, options())
    ).toEqual({ source: 'cloudflare', outcome: 'unknown' })
    await expect(
      readCustomerSatisfactionCommand(f.database, BUYER_CLAIMS, 'support', target, key, 'f'.repeat(64), options())
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('rejects stale source version and a second distinct feedback', async () => {
    await resolve()
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(1), {
        ...options(),
        idempotencyKey: data.uuid()
      })
    ).rejects.toMatchObject({ code: 'source_version_conflict' })
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(), {
      ...options(),
      idempotencyKey: data.uuid()
    })
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(), {
        ...options(),
        idempotencyKey: data.uuid()
      })
    ).rejects.toMatchObject({ code: 'already_submitted' })
  })
  it('expires access to feedback and receipts at the original retention boundary', async () => {
    await resolve()
    const key = data.uuid(),
      body = input(),
      hash = await satisfactionIntentHash('support', target, body)
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, {
      ...options(),
      idempotencyKey: key
    })
    const now = (f.sqlite.prepare('SELECT retention_until FROM support_tickets').get() as { retention_until: string })
      .retention_until
    expect(await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, { now })).toMatchObject({
      eligible: false,
      reason: 'retention_expired',
      feedback: null
    })
    await expect(
      readCustomerSatisfactionCommand(f.database, BUYER_CLAIMS, 'support', target, key, hash, { now })
    ).rejects.toMatchObject({ code: 'retention_expired' })
  })
  it('admin segments real feedback with comments opt-in and no customer identity/contact', async () => {
    await resolve()
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(), {
      ...options(),
      idempotencyKey: data.uuid()
    })
    const result = await readAdminSatisfaction(f.database, CLAIMS, { source: 'support', score: '4' }, options())
    expect(result).toMatchObject({
      total: 1,
      commentsIncluded: false,
      stats: { count: 1, average: 4 },
      items: [{ score: 4, comment: null }]
    })
    expect(JSON.stringify(result)).not.toContain(BUYER_CLAIMS.identityId)
    expect(JSON.stringify(result)).not.toContain('buyer@')
    expect(await readAdminSatisfaction(f.database, CLAIMS, { comments: 'true' }, options())).toMatchObject({
      items: [{ comment: input().comment }]
    })
  })
  it('uses the real checkout/payment/fulfillment fixture and requires an explicit delivery policy', async () => {
    expect(await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order)).toMatchObject({
      eligible: false,
      reason: 'policy_unavailable'
    })
    const state = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, options())
    expect(state).toMatchObject({ eligible: true, target: { version: 4 } })
    const before = f.economic()
    const receipt = await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, input(4), {
      ...options(),
      idempotencyKey: data.uuid()
    })
    expect(receipt.target).toEqual({ kind: 'delivery', id: f.order, version: 4 })
    expect(
      await readAdminSatisfaction(f.database, CLAIMS, { source: 'delivery', shippingMethod: 'pickup' }, options())
    ).toMatchObject({ total: 1, items: [{ shippingMethod: 'pickup', category: null }] })
    expect(f.economic()).toEqual(before)
  })
  it('does not extend previously submitted delivery feedback when configured retention later grows', async () => {
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, input(4), {
      ...options(),
      idempotencyKey: data.uuid()
    })
    const original = (await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, options())).privacy!
      .retentionUntil
    const changed = await readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, {
      now: original,
      policy: { ...POLICY, retentionDays: 90 }
    })
    expect(changed).toMatchObject({
      eligible: false,
      reason: 'retention_expired',
      feedback: null,
      privacy: { retentionUntil: original }
    })
  })
  it('rolls back the entire command if the separate comment projection cannot be inserted', async () => {
    await resolve()
    f.sqlite.exec(
      "CREATE TRIGGER synthetic_feedback_failure BEFORE INSERT ON support_satisfaction_feedback BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END"
    )
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(), {
        ...options(),
        idempotencyKey: data.uuid()
      })
    ).rejects.toMatchObject({ code: 'service_unavailable' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_guards').get()).toEqual({ n: 0 })
  })
  it('fails closed rather than fabricating final delivery from an unconfirmed projection', async () => {
    f.sqlite.exec('DROP TRIGGER order_fulfillment_audit_no_delete; DELETE FROM order_fulfillment_audit')
    await expect(
      readCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, options())
    ).rejects.toMatchObject({ code: 'service_unavailable' })
  })
  it('binds submission to the policy that the owner actually acknowledged', async () => {
    const changed = { ...POLICY, version: 2, privacyNoticePath: '/privacidad-nueva' }
    await expect(
      submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'delivery', f.order, input(4), {
        now: utc(),
        policy: changed,
        idempotencyKey: data.uuid()
      })
    ).rejects.toMatchObject({ code: 'policy_version_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').get()).toEqual({ n: 0 })
  })
  it('never labels an existing own ledger command with a corrupt projection as unknown', async () => {
    await resolve()
    const key = data.uuid(),
      body = input(),
      hash = await satisfactionIntentHash('support', target, body)
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, body, {
      ...options(),
      idempotencyKey: key
    })
    // Deliberate corruption only in the disposable fixture; production protection stays intact.
    f.sqlite.exec('DROP TRIGGER support_satisfaction_feedback_no_delete; DELETE FROM support_satisfaction_feedback')
    await expect(
      readCustomerSatisfactionCommand(f.database, BUYER_CLAIMS, 'support', target, key, hash, options())
    ).rejects.toMatchObject({ code: 'service_unavailable' })
  })
  it('fails admin aggregates closed only for corrupt feedback within the requested retained segment', async () => {
    await resolve()
    await submitCustomerSatisfaction(f.database, BUYER_CLAIMS, 'support', target, input(), {
      ...options(),
      idempotencyKey: data.uuid()
    })
    const retention = (
      f.sqlite.prepare('SELECT retention_until FROM support_satisfaction_commands').get() as { retention_until: string }
    ).retention_until
    f.sqlite.exec('DROP TRIGGER support_satisfaction_feedback_no_delete; DELETE FROM support_satisfaction_feedback')
    expect(await readAdminSatisfaction(f.database, CLAIMS, { source: 'delivery' }, options())).toMatchObject({
      total: 0
    })
    expect(await readAdminSatisfaction(f.database, CLAIMS, { score: '5' }, options())).toMatchObject({ total: 0 })
    expect(await readAdminSatisfaction(f.database, CLAIMS, {}, { now: retention })).toMatchObject({ total: 0 })
    await expect(
      readAdminSatisfaction(f.database, CLAIMS, { source: 'support', score: '4' }, options())
    ).rejects.toMatchObject({ code: 'service_unavailable' })
  })
})
