import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invitationFixture, ADMIN, RECIPIENT, FOREIGN, utc } from './d1-admin-invitations-fixture'
import {
  createD1AdminInvitation as create,
  revokeD1AdminInvitation as revoke,
  acceptD1AdminInvitation as accept,
  previewD1AdminInvitation as preview,
  readD1AdminInvitations as list,
  readD1AdminInvitationCommand as command
} from '../../workers/auth/admin-invitations'
import { adminInvitationIntentHash } from '../../shared/admin-invitations'

describe('ADM-004 D1 invitations with live delegation and atomic grants', () => {
  let f: Awaited<ReturnType<typeof invitationFixture>>
  beforeEach(async () => {
    f = await invitationFixture()
  })
  afterEach(() => f.sqlite.close())
  const issue = (input?: unknown, key = crypto.randomUUID(), db?: D1Database) =>
    create(db ?? f.database, ADMIN, input ?? f.input, { idempotencyKey: key })
  it('lists only existing roles within the live issuer permission set, without provisioning anything', async () => {
    const result = await list(f.database, ADMIN, {})
    expect(result.roles.map((r) => r.code)).toEqual(['admin', 'support'])
    expect(result.items).toEqual([])
    expect(f.sqlite.prepare('SELECT count(*) n FROM identity_roles').get()?.n).toBe(1)
  })
  it('creates metadata only, replays exactly and manually recovers the original receipt', async () => {
    const key = crypto.randomUUID(),
      receipt = await issue(undefined, key)
    expect(receipt).toMatchObject({ action: 'create', version: 1, sessionRevoked: false, commandId: key })
    expect(await issue(undefined, key)).toEqual(receipt)
    const hash = await adminInvitationIntentHash('create', null, f.input)
    expect(await command(f.database, ADMIN, key, hash, { audience: 'admin' })).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(JSON.stringify(await list(f.database, ADMIN, {}))).not.toContain(f.input.tokenHash)
    expect(JSON.stringify(f.sqlite.prepare('SELECT * FROM admin_invitation_commands').all())).not.toContain(f.token)
    await expect(issue({ ...f.input, reason: 'Otra aprobación humana explícita.' }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })
  it('previews exact permissions without any grant, then accepts once and revokes every old session', async () => {
    const issued = await issue()
    expect(await preview(f.database, RECIPIENT, { token: f.token })).toMatchObject({
      invitationId: issued.invitationId,
      roleCode: 'support',
      permissions: ['support.manage']
    })
    expect(
      f.sqlite.prepare('SELECT count(*) n FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)?.n
    ).toBe(0)
    const receipt = await accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    expect(receipt).toMatchObject({ action: 'accept', version: 2, sessionRevoked: true })
    expect(
      f.sqlite.prepare('SELECT session_version FROM identities WHERE id=?').get(RECIPIENT.identityId)?.session_version
    ).toBe(2)
    expect(
      f.sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(RECIPIENT.sessionId)?.revoked_at
    ).toBeTruthy()
    expect(
      f.sqlite.prepare('SELECT role_code FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)?.role_code
    ).toBe('support')
  })
  it('recovers accepted intent only through a newly authenticated MFA session of the same identity', async () => {
    await issue()
    const key = crypto.randomUUID(),
      body = { token: f.token },
      receipt = await accept(f.database, RECIPIENT, body, { idempotencyKey: key })
    const hash = await adminInvitationIntentHash('accept', null, body)
    await expect(command(f.database, RECIPIENT, key, hash, { audience: 'account' })).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    const fresh = { ...RECIPIENT, sessionId: crypto.randomUUID(), sessionVersion: 2 }
    f.sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,2,1,?,?)'
      )
      .run(fresh.sessionId, fresh.identityId, utc(-1000), utc(3600000))
    expect(await command(f.database, fresh, key, hash, { audience: 'account' })).toEqual({
      source: 'cloudflare',
      outcome: 'applied',
      receipt
    })
    expect(await accept(f.database, fresh, body, { idempotencyKey: key })).toEqual(receipt)
    await expect(command(f.database, FOREIGN, key, hash, { audience: 'account' })).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('rejects expiration, wrong recipient and revoked invitations uniformly without granting', async () => {
    const receipt = await issue()
    await expect(preview(f.database, FOREIGN, { token: f.token })).rejects.toMatchObject({
      code: 'invitation_unavailable'
    })
    await expect(preview(f.database, RECIPIENT, { token: f.token }, { now: utc(25 * 3600000) })).rejects.toMatchObject({
      code: 'invitation_unavailable'
    })
    await revoke(
      f.database,
      ADMIN,
      receipt.invitationId,
      { expectedVersion: 1, reason: 'Invitación retirada por el emisor.' },
      { idempotencyKey: crypto.randomUUID() }
    )
    await expect(
      accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'invitation_unavailable' })
  })
  it('requires a real verified MFA enrollment, not merely the session flag', async () => {
    await issue()
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(RECIPIENT.identityId)
    await expect(preview(f.database, RECIPIENT, { token: f.token })).rejects.toMatchObject({ code: 'mfa_required' })
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(ADMIN.identityId)
    await expect(list(f.database, ADMIN, {})).rejects.toMatchObject({ code: 'mfa_required' })
  })
  it('denies privilege escalation and role permission drift before acceptance', async () => {
    await expect(issue({ ...f.input, roleCode: 'finance' })).rejects.toMatchObject({ code: 'forbidden' })
    await issue()
    f.sqlite.exec("INSERT INTO role_permissions VALUES('support','finance.manage')")
    await expect(
      accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'invitation_unavailable' })
  })
  it('rejects issuer session-version revocation and changed verified recipient email', async () => {
    await issue()
    f.sqlite.prepare("UPDATE identities SET email='changed@example.invalid' WHERE id=?").run(RECIPIENT.identityId)
    await expect(preview(f.database, RECIPIENT, { token: f.token })).rejects.toMatchObject({
      code: 'invitation_unavailable'
    })
    f.sqlite.prepare("UPDATE identities SET email='recipient@example.invalid' WHERE id=?").run(RECIPIENT.identityId)
    f.sqlite.prepare('UPDATE identities SET session_version=session_version+1 WHERE id=?').run(ADMIN.identityId)
    await expect(preview(f.database, RECIPIENT, { token: f.token })).rejects.toMatchObject({
      code: 'invitation_unavailable'
    })
  })
  it('does not extend or replace a pre-existing role grant', async () => {
    await issue()
    f.sqlite
      .prepare("INSERT INTO identity_roles VALUES(?,'support',NULL,?,?)")
      .run(RECIPIENT.identityId, utc(-1000), utc(3600000))
    const before = f.sqlite.prepare('SELECT * FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)
    await expect(
      accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'role_already_granted' })
    expect(f.sqlite.prepare('SELECT * FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)).toEqual(
      before
    )
  })
  it('checks issuer grants again at commit and rolls back every write on a race', async () => {
    await issue()
    const db = {
      ...f.database,
      batch: async (statements: D1PreparedStatement[]) => {
        f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='admin' AND permission_code='support.manage'")
        return f.database.batch(statements)
      }
    } as D1Database
    await expect(
      accept(db, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'invitation_unavailable' })
    expect(
      f.sqlite.prepare('SELECT count(*) n FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)?.n
    ).toBe(0)
    expect(
      f.sqlite.prepare('SELECT session_version FROM identities WHERE id=?').get(RECIPIENT.identityId)?.session_version
    ).toBe(1)
  })
  it('rolls back grant, session revocation and invitation consumption if audit persistence fails', async () => {
    await issue()
    f.sqlite.exec(
      "CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON admin_invitation_commands WHEN NEW.action='accept' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END"
    )
    await expect(
      accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'service_unavailable' })
    expect(f.sqlite.prepare('SELECT status FROM admin_invitations').get()?.status).toBe('pending')
    expect(
      f.sqlite.prepare('SELECT session_version FROM identities WHERE id=?').get(RECIPIENT.identityId)?.session_version
    ).toBe(1)
    expect(
      f.sqlite.prepare('SELECT count(*) n FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)?.n
    ).toBe(0)
  })
  it('allows only one of two concurrent acceptance intentions', async () => {
    await issue()
    const results = await Promise.allSettled(
      [1, 2].map(() => accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() }))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(f.sqlite.prepare("SELECT count(*) n FROM admin_invitation_commands WHERE action='accept'").get()?.n).toBe(1)
  })
  it.each(['blocked', 'anonymized'])(
    'denies acceptance for a %s customer despite a live verified MFA identity',
    async (status) => {
      await issue()
      f.sqlite
        .prepare('UPDATE customers SET status=? WHERE id=(SELECT customer_id FROM identities WHERE id=?)')
        .run(status, RECIPIENT.identityId)
      await expect(preview(f.database, RECIPIENT, { token: f.token })).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      await expect(
        accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'unauthenticated' })
      expect(
        f.sqlite.prepare('SELECT count(*) n FROM identity_roles WHERE identity_id=?').get(RECIPIENT.identityId)?.n
      ).toBe(0)
    }
  )
  it('rejects a terminal invitation without its required audit timestamp at the SQL boundary', async () => {
    await issue()
    expect(() =>
      f.sqlite
        .prepare(
          `INSERT INTO admin_invitations(id,issuer_id,issuer_session_id,issuer_session_version,recipient_id,recipient_email,role_code,permissions_json,permissions_hash,token_hash,version,status,created_at,expires_at,accepted_at,revoked_at,command_id)
      SELECT ?,issuer_id,issuer_session_id,issuer_session_version,recipient_id,recipient_email,role_code,permissions_json,permissions_hash,?,2,'accepted',created_at,expires_at,NULL,NULL,? FROM admin_invitations LIMIT 1`
        )
        .run(crypto.randomUUID(), 'd'.repeat(64), crypto.randomUUID())
    ).toThrow()
  })
  it.each(['logout', 'expiry'])('preserves invitation TTL after the issuer original session %s', async (event) => {
    const invitation = await issue()
    if (event === 'logout')
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), ADMIN.sessionId)
    else f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(-1000), ADMIN.sessionId)
    expect(await preview(f.database, RECIPIENT, { token: f.token })).toMatchObject({
      invitationId: invitation.invitationId,
      roleCode: 'support'
    })
    expect(
      await accept(f.database, RECIPIENT, { token: f.token }, { idempotencyKey: crypto.randomUUID() })
    ).toMatchObject({ invitationId: invitation.invitationId, action: 'accept', sessionRevoked: true })
  })
})
