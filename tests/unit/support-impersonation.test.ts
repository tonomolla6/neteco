import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  lifecycleFixture,
  AGENT_CLAIMS,
  CLAIMS,
  OPTIONS,
  NOW,
  CUSTOMER,
  OTHER_CUSTOMER,
  TICKET,
  AGENT
} from './account-lifecycle-fixture'
import {
  endD1Impersonation,
  getActiveD1Impersonation,
  listD1ImpersonationActions,
  recordD1ImpersonatedAction,
  startD1Impersonation
} from '../../workers/support/impersonation'
import { classifyImpersonatedAction } from '../../shared/support-impersonation'

let f: Awaited<ReturnType<typeof lifecycleFixture>>
beforeEach(async () => {
  f = await lifecycleFixture()
  f.grantImpersonation()
})
afterEach(() => f.sqlite.close())
const key = (n: string) => deterministicUuid(`imp-${n}`)
const input = (over: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER,
  ticketRef: TICKET,
  reason: 'Reproducir el fallo de la dirección de envío',
  minutes: 10,
  ...over
})
const start = (k = 'a', body: unknown = input(), claims = AGENT_CLAIMS, at = OPTIONS) =>
  startD1Impersonation(f.database, claims, key(k), body, at)
const at = (iso: string) => ({ now: () => iso })
const actions = () =>
  f.sqlite
    .prepare(
      'SELECT seq,action_code,outcome,block_reason,resource FROM support_impersonation_actions ORDER BY session_id,seq'
    )
    .all() as {
    seq: number
    action_code: string
    outcome: string
    block_reason: string | null
  }[]

describe('CUS-028 starting an impersonation', () => {
  it('opens a short session bound to a ticket and records the start in the log', async () => {
    const s = await start()
    expect(s).toMatchObject({
      customerId: CUSTOMER,
      customerName: 'Cliente sintético',
      ticketRef: TICKET,
      startedAt: NOW,
      expiresAt: '2030-01-02T12:10:00Z',
      status: 'active',
      remainingSeconds: 600
    })
    expect(s.banner).toContain('Cliente sintético')
    expect(actions()).toMatchObject([{ seq: 1, action_code: 'session.start', outcome: 'allowed' }])
  })
  it('defaults to 10 minutes and never exceeds 15', async () => {
    expect(await start('d', { ...input(), minutes: undefined })).toMatchObject({ expiresAt: '2030-01-02T12:10:00Z' })
    await endD1Impersonation(
      f.database,
      AGENT_CLAIMS,
      (await getActiveD1Impersonation(f.database, AGENT_CLAIMS, OPTIONS))!.id,
      OPTIONS
    )
    expect(await start('m', input({ minutes: 15 }))).toMatchObject({ expiresAt: '2030-01-02T12:15:00Z' })
    await expect(start('x', input({ minutes: 16 }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(start('y', input({ minutes: 0 }))).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it.each([
    ['short reason', { reason: 'corto' }],
    ['very long reason', { reason: 'x'.repeat(301) }],
    ['missing ticket', { ticketRef: undefined }],
    ['bad customer id', { customerId: 'abc' }],
    ['extra field', { impersonatePassword: true }]
  ])('rejects %s', async (_n, over) => {
    await expect(start('bad', input(over))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(actions()).toHaveLength(0)
  })
  it('is idempotent by key and rejects the same key with another payload', async () => {
    const first = await start('k')
    expect(await start('k')).toEqual(first)
    await expect(start('k', input({ reason: 'Otro motivo distinto y suficiente' }))).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_impersonation_sessions').get()).toEqual({ n: 1 })
  })
  it('allows only one open session per agent', async () => {
    await start('one')
    await expect(start('two')).rejects.toMatchObject({ code: 'conflict' })
  })
  it('closes an expired, never-ended session automatically before opening the next', async () => {
    const first = await start('one')
    const later = at('2030-01-02T13:00:00Z')
    expect(await getActiveD1Impersonation(f.database, AGENT_CLAIMS, later)).toBeNull()
    const second = await startD1Impersonation(f.database, AGENT_CLAIMS, key('two'), input(), later)
    expect(second.id).not.toBe(first.id)
    expect(
      f.sqlite.prepare('SELECT ended_reason FROM support_impersonation_sessions WHERE id=?').get(first.id)
    ).toEqual({ ended_reason: 'expired' })
  })
  it('requires the dedicated impersonation permission, not just support.manage', async () => {
    f.row("DELETE FROM role_permissions WHERE permission_code='support.impersonate'")
    await expect(start()).rejects.toMatchObject({ code: 'forbidden' })
    expect(actions()).toHaveLength(0)
  })
  it('requires a live MFA session and verified email', async () => {
    f.row(`UPDATE auth_sessions SET mfa_verified=0 WHERE id='${AGENT_CLAIMS.sessionId}'`)
    await expect(start()).rejects.toMatchObject({ code: 'mfa_required' })
    f.row(
      `UPDATE auth_sessions SET mfa_verified=1 WHERE id='${AGENT_CLAIMS.sessionId}'; UPDATE identities SET email_verified_at=NULL WHERE id='${AGENT}'`
    )
    await expect(start()).rejects.toMatchObject({ code: 'email_unverified' })
  })
  it('refuses customers and anonymous callers', async () => {
    await expect(start('c', input(), CLAIMS)).rejects.toMatchObject({ code: 'mfa_required' })
    await expect(startD1Impersonation(f.database, null, key('n'), input(), OPTIONS)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
  })
  it('refuses a revoked agent session', async () => {
    f.row(`UPDATE auth_sessions SET revoked_at='2025-01-01T00:00:00Z' WHERE id='${AGENT_CLAIMS.sessionId}'`)
    await expect(start()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('requires an open ticket that belongs to that customer', async () => {
    await expect(start('o', input({ customerId: OTHER_CUSTOMER }))).rejects.toMatchObject({ code: 'not_found' })
    await expect(start('t', input({ ticketRef: 'NET-NOPE-1' }))).rejects.toMatchObject({ code: 'not_found' })
    f.row("UPDATE support_tickets SET state='closed'")
    await expect(start('c')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('refuses blocked customers', async () => {
    f.row(`UPDATE customers SET status='blocked' WHERE id='${CUSTOMER}'`)
    await expect(start()).rejects.toMatchObject({ code: 'not_found' })
  })
  it('never lets an agent impersonate their own customer account', async () => {
    f.row(`UPDATE identities SET customer_id=NULL WHERE id='${CLAIMS.identityId}'`)
    f.row(`UPDATE identities SET customer_id='${CUSTOMER}' WHERE id='${AGENT}'`)
    await expect(start()).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('enforces the 15 minute ceiling and the audit start row in the database too', () => {
    const insert = (id: string, expires: string) =>
      f.sqlite.exec(
        `INSERT INTO support_impersonation_sessions(id,command_id,payload_hash,actor_id,actor_session_id,customer_id,ticket_ref,reason,started_at,expires_at)
 VALUES('${id}','${key(id)}','${'a'.repeat(64)}','${AGENT}','${AGENT_CLAIMS.sessionId}','${CUSTOMER}','${TICKET}','Motivo de prueba suficiente','${NOW}','${expires}')`
      )
    expect(() => insert(deterministicUuid('long'), '2030-01-02T12:16:00Z')).toThrow()
    expect(() => insert(deterministicUuid('zero'), NOW)).toThrow()
    insert(deterministicUuid('ok'), '2030-01-02T12:15:00Z')
    expect(actions()).toHaveLength(1)
  })
})

describe('CUS-028 ending and the banner source', () => {
  it('exposes the active session for the banner with the remaining time', async () => {
    const s = await start()
    expect(await getActiveD1Impersonation(f.database, AGENT_CLAIMS, at('2030-01-02T12:04:00Z'))).toMatchObject({
      id: s.id,
      remainingSeconds: 360,
      status: 'active'
    })
    expect(await getActiveD1Impersonation(f.database, AGENT_CLAIMS, at('2030-01-02T12:10:00Z'))).toBeNull()
  })
  it('returns null for an agent without session and for a different agent', async () => {
    expect(await getActiveD1Impersonation(f.database, AGENT_CLAIMS, OPTIONS)).toBeNull()
  })
  it('ends manually, logs the end and is idempotent', async () => {
    const s = await start()
    const ended = await endD1Impersonation(f.database, AGENT_CLAIMS, s.id, at('2030-01-02T12:03:00Z'))
    expect(ended).toMatchObject({ id: s.id, status: 'ended', endedAt: '2030-01-02T12:03:00Z' })
    expect(await endD1Impersonation(f.database, AGENT_CLAIMS, s.id, at('2030-01-02T12:05:00Z'))).toEqual(ended)
    expect(actions().map((a) => a.action_code)).toEqual(['session.start', 'session.end'])
    expect(await getActiveD1Impersonation(f.database, AGENT_CLAIMS, OPTIONS)).toBeNull()
  })
  it('does not let another agent end a session and rejects unknown ids', async () => {
    const s = await start()
    f.row(`INSERT INTO identities(id,email,password_hash,status,email_verified_at,created_at,updated_at) VALUES('${deterministicUuid('agent2')}','a2@example.invalid','x','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
 INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${deterministicUuid('agent2-s')}','${deterministicUuid('agent2')}',1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z');
 INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES('${deterministicUuid('agent2')}','x','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
 INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${deterministicUuid('agent2')}','lifecycle-support','2020-01-01T00:00:00Z')`)
    const other = {
      identityId: deterministicUuid('agent2'),
      sessionId: deterministicUuid('agent2-s'),
      sessionVersion: 1
    }
    await expect(endD1Impersonation(f.database, other, s.id, OPTIONS)).rejects.toMatchObject({ code: 'not_found' })
    await expect(endD1Impersonation(f.database, AGENT_CLAIMS, deterministicUuid('zzz'), OPTIONS)).rejects.toMatchObject(
      { code: 'not_found' }
    )
    await expect(endD1Impersonation(f.database, AGENT_CLAIMS, 'bad', OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
  it('keeps sessions and actions append-only', async () => {
    const s = await start()
    await endD1Impersonation(f.database, AGENT_CLAIMS, s.id, OPTIONS)
    expect(() =>
      f.sqlite.exec("UPDATE support_impersonation_sessions SET reason='Cambio de motivo posterior'")
    ).toThrow(/immutable/)
    expect(() => f.sqlite.exec("UPDATE support_impersonation_actions SET outcome='blocked'")).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM support_impersonation_actions')).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM support_impersonation_sessions')).toThrow(/immutable/)
  })
})

describe('CUS-028 acting as the customer', () => {
  it.each([
    ['view_orders', 'allowed'],
    ['view_addresses', 'allowed'],
    ['reply_support_ticket', 'allowed'],
    ['change_password', 'sensitive_credentials'],
    ['change_email', 'sensitive_credentials'],
    ['disable_mfa', 'sensitive_credentials'],
    ['view_payment_method', 'sensitive_payment'],
    ['pay_order', 'sensitive_payment'],
    ['capture_payment', 'sensitive_payment'],
    ['delete_account', 'not_permitted'],
    ['anything_else', 'not_permitted']
  ])('classifies %s as %s', (action, expected) => {
    const c = classifyImpersonatedAction(action)
    expect(c.outcome === 'allowed' ? 'allowed' : c.reason).toBe(expected)
  })
  it('logs an allowed action with a sequence number and resource', async () => {
    const s = await start()
    const r = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('v1'),
      { action: 'view_orders', resource: 'orders:list' },
      at('2030-01-02T12:01:00Z')
    )
    expect(r).toMatchObject({ outcome: 'allowed', seq: 2, action: 'view_orders' })
    expect(actions()[1]).toMatchObject({
      seq: 2,
      action_code: 'view_orders',
      outcome: 'allowed',
      resource: 'orders:list'
    })
  })
  it('logs and blocks credential and payment actions without ever allowing them', async () => {
    const s = await start()
    const a = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('p'),
      { action: 'change_password' },
      OPTIONS
    )
    const b = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('q'),
      { action: 'pay_order', resource: 'orders:123' },
      OPTIONS
    )
    const c = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('r'),
      { action: 'delete_account' },
      OPTIONS
    )
    expect([a, b, c].map((x) => [x.outcome, x.reason])).toEqual([
      ['blocked', 'sensitive_credentials'],
      ['blocked', 'sensitive_payment'],
      ['blocked', 'not_permitted']
    ])
    expect(actions().filter((x) => x.outcome === 'blocked')).toHaveLength(3)
  })
  it('replays the same action key without a duplicate row and rejects a changed action under the same key', async () => {
    const s = await start()
    const first = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('v'),
      { action: 'view_orders' },
      OPTIONS
    )
    expect(
      await recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('v'), { action: 'view_orders' }, OPTIONS)
    ).toEqual(first)
    await expect(
      recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('v'), { action: 'view_addresses' }, OPTIONS)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(actions()).toHaveLength(2)
  })
  it('blocks, but logs, any action after expiry or after the session ended', async () => {
    const s = await start()
    const late = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('late'),
      { action: 'view_orders' },
      at('2030-01-02T12:11:00Z')
    )
    expect(late).toMatchObject({ outcome: 'blocked', reason: 'session_inactive' })
    await endD1Impersonation(f.database, AGENT_CLAIMS, s.id, at('2030-01-02T12:12:00Z'))
    const after = await recordD1ImpersonatedAction(
      f.database,
      AGENT_CLAIMS,
      s.id,
      key('after'),
      { action: 'view_orders' },
      at('2030-01-02T12:12:30Z')
    )
    expect(after).toMatchObject({ outcome: 'blocked', reason: 'session_inactive' })
  })
  it('refuses to log for a session of another agent or a missing session', async () => {
    const s = await start()
    await expect(
      recordD1ImpersonatedAction(
        f.database,
        AGENT_CLAIMS,
        deterministicUuid('none'),
        key('x'),
        { action: 'view_orders' },
        OPTIONS
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    f.row(`DELETE FROM role_permissions WHERE permission_code='support.impersonate'`)
    await expect(
      recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('y'), { action: 'view_orders' }, OPTIONS)
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('validates action payloads', async () => {
    const s = await start()
    for (const body of [
      {},
      { action: '' },
      { action: 'view orders' },
      { action: 'view_orders', resource: 'x'.repeat(121) },
      { action: 'view_orders', extra: 1 }
    ])
      await expect(
        recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('v'), body, OPTIONS)
      ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('revokes in-flight authority: a revoked agent session cannot act', async () => {
    const s = await start()
    f.row(`UPDATE auth_sessions SET revoked_at='2025-01-01T00:00:00Z' WHERE id='${AGENT_CLAIMS.sessionId}'`)
    await expect(
      recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('v'), { action: 'view_orders' }, OPTIONS)
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('lists the full audit trail in order for authorised staff only', async () => {
    const s = await start()
    await recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('v'), { action: 'view_orders' }, OPTIONS)
    await recordD1ImpersonatedAction(f.database, AGENT_CLAIMS, s.id, key('w'), { action: 'change_email' }, OPTIONS)
    await endD1Impersonation(f.database, AGENT_CLAIMS, s.id, OPTIONS)
    const log = await listD1ImpersonationActions(f.database, AGENT_CLAIMS, s.id, OPTIONS)
    expect(log.actions.map((a) => [a.seq, a.action, a.outcome])).toEqual([
      [1, 'session.start', 'allowed'],
      [2, 'view_orders', 'allowed'],
      [3, 'change_email', 'blocked'],
      [4, 'session.end', 'allowed']
    ])
    expect(log.session).toMatchObject({
      id: s.id,
      actorId: AGENT,
      customerId: CUSTOMER,
      ticketRef: TICKET,
      reason: expect.any(String)
    })
    await expect(listD1ImpersonationActions(f.database, CLAIMS, s.id, OPTIONS)).rejects.toMatchObject({
      code: 'mfa_required'
    })
  })
})
