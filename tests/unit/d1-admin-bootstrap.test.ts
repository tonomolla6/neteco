import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  applyD1AdminBootstrap,
  bootstrapWranglerArguments,
  inspectD1AdminBootstrap,
  parseBootstrapArguments,
  type BootstrapQuery
} from '../../scripts/lib/d1-admin-bootstrap'

const identityId = '10000000-0000-4000-8000-000000000083'
const sessionId = '20000000-0000-4000-8000-000000000083'
const commandId = '30000000-0000-4000-8000-000000000083'
let database: DatabaseSync
let query: BootstrapQuery
const reason = 'Primer administrador revisado por el operador.'
beforeEach(async () => {
  database = await openMigratedDatabase()
  database.exec(await readFile(new URL('../../db/d1/migrations/0083_admin_bootstrap.sql', import.meta.url), 'utf8'))
  const past = new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const future = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  database
    .prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)")
    .run(identityId, past, past)
  database
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,created_at,updated_at,customer_id) VALUES(?,'bootstrap@example.invalid','synthetic-not-a-password',?,'active',1,?,?,?)"
    )
    .run(identityId, past, past, past, identityId)
  database
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(sessionId, identityId, past, future)
  database
    .prepare(
      "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-a-secret','[]',?,?)"
    )
    .run(identityId, past, past)
  database.exec(
    "INSERT INTO roles VALUES('admin','Admin','Synthetic'); INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic'); INSERT INTO role_permissions VALUES('admin','support.manage'),('admin','administration.manage')"
  )
  query = async (sql) => database.prepare(sql).all() as Record<string, unknown>[]
})
afterEach(() => database.close())

const apply = async () => {
  const plan = await inspectD1AdminBootstrap(identityId, query)
  return applyD1AdminBootstrap({ identityId, commandId, expectedPlanHash: plan.planHash, reason }, query)
}
describe('local-only explicit first D1 administrator bootstrap', () => {
  it('plans without creating an account, granting a role or exposing email/password/session secrets', async () => {
    const plan = await inspectD1AdminBootstrap(identityId, query)
    expect(plan).toMatchObject({
      identityId,
      sessionId,
      sessionVersion: 1,
      permissions: ['administration.manage', 'support.manage']
    })
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(plan)).not.toMatch(/bootstrap@example|synthetic|password|encrypted_secret/)
    expect(database.prepare('SELECT count(*) AS n FROM identity_roles').get()).toEqual({ n: 0 })
    expect(database.prepare('SELECT session_version FROM identities').get()).toEqual({ session_version: 1 })
  })
  it('grants once, atomically revokes all sessions, bumps the version and stores an immutable metadata receipt', async () => {
    database
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) SELECT ?,identity_id,session_version,0,created_at,expires_at FROM auth_sessions WHERE id=?'
      )
      .run(crypto.randomUUID(), sessionId)
    const receipt = await apply()
    expect(receipt).toMatchObject({ commandId, identityId, roleCode: 'admin', sessionRevoked: true })
    expect(database.prepare('SELECT role_code FROM identity_roles').all()).toEqual([{ role_code: 'admin' }])
    expect(database.prepare('SELECT session_version FROM identities').get()).toEqual({ session_version: 2 })
    expect(database.prepare('SELECT revoked_at FROM auth_sessions').get()?.revoked_at).toBeTruthy()
    expect(database.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({ n: 0 })
    expect(
      database.prepare("SELECT count(*) AS n FROM identity_security_events WHERE event_type='session_revoked'").get()
    ).toEqual({ n: 2 })
    expect(() => database.exec("UPDATE admin_bootstrap_commands SET reason='overwritten reason'")).toThrow(/immutable/)
    expect(() => database.exec('DELETE FROM admin_bootstrap_commands')).toThrow(/immutable/)
  })
  it('replays an exact command after expected session revocation, rejects another intent and never regrants', async () => {
    const plan = await inspectD1AdminBootstrap(identityId, query)
    const input = { identityId, commandId, expectedPlanHash: plan.planHash, reason }
    const first = await applyD1AdminBootstrap(input, query)
    expect(await applyD1AdminBootstrap(input, query)).toEqual(first)
    await expect(applyD1AdminBootstrap({ ...input, reason: reason + ' diferente' }, query)).rejects.toThrow(/conflict/)
    expect(database.prepare('SELECT session_version FROM identities').get()).toEqual({ session_version: 2 })
    expect(database.prepare('SELECT count(*) AS n FROM admin_bootstrap_commands').get()).toEqual({ n: 1 })
  })
  it.each([
    'UPDATE identities SET email_verified_at=NULL',
    "UPDATE identities SET status='locked'",
    "UPDATE customers SET status='blocked'",
    'DELETE FROM identity_mfa',
    'UPDATE auth_sessions SET mfa_verified=0',
    "UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+1 second')",
    "DELETE FROM role_permissions WHERE permission_code='administration.manage'",
    "INSERT INTO identity_roles(identity_id,role_code,granted_at) SELECT id,'admin',created_at FROM identities"
  ])('refuses unavailable first-admin authority: %s', async (sql) => {
    database.exec(sql)
    await expect(inspectD1AdminBootstrap(identityId, query)).rejects.toThrow(/bootstrap_not_eligible/)
  })
  it.each([
    'UPDATE identities SET session_version=2',
    'UPDATE identity_mfa SET verified_at=NULL',
    "UPDATE customers SET status='blocked'",
    "DELETE FROM role_permissions WHERE permission_code='support.manage'"
  ])('closes a race after the plan read at the final SQL statement: %s', async (drift) => {
    const plan = await inspectD1AdminBootstrap(identityId, query)
    let injected = false
    const raced: BootstrapQuery = async (sql) => {
      if (/^INSERT INTO admin_bootstrap_commands/.test(sql) && !injected) {
        injected = true
        database.exec(drift)
      }
      return query(sql)
    }
    await expect(
      applyD1AdminBootstrap({ identityId, commandId, expectedPlanHash: plan.planHash, reason }, raced)
    ).rejects.toThrow()
    expect(database.prepare('SELECT count(*) AS n FROM admin_bootstrap_commands').get()).toEqual({ n: 0 })
    expect(database.prepare('SELECT count(*) AS n FROM identity_roles').get()).toEqual({ n: 0 })
  })
  it('rolls back the grant and receipt when session revocation fails at the end of the statement', async () => {
    database.exec(
      "CREATE TRIGGER fail_bootstrap_session BEFORE UPDATE OF revoked_at ON auth_sessions BEGIN SELECT RAISE(ABORT,'synthetic_late_failure'); END"
    )
    await expect(apply()).rejects.toThrow(/synthetic_late_failure/)
    expect(database.prepare('SELECT count(*) AS n FROM admin_bootstrap_commands').get()).toEqual({ n: 0 })
    expect(database.prepare('SELECT count(*) AS n FROM identity_roles').get()).toEqual({ n: 0 })
    expect(database.prepare('SELECT session_version FROM identities').get()).toEqual({ session_version: 1 })
  })
  it('cannot bootstrap again after the first grant has later been removed', async () => {
    await apply()
    database.exec('DELETE FROM identity_roles; UPDATE auth_sessions SET session_version=2,revoked_at=NULL')
    await expect(inspectD1AdminBootstrap(identityId, query)).rejects.toThrow(/bootstrap_not_eligible/)
  })
  it('recognizes administrative authority under another role name, including an expired grant', async () => {
    database.exec(
      "INSERT INTO roles VALUES('owner','Owner','Synthetic'); INSERT INTO role_permissions VALUES('owner','administration.manage')"
    )
    database
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at,expires_at) VALUES(?,'owner','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')"
      )
      .run(identityId)
    await expect(inspectD1AdminBootstrap(identityId, query)).rejects.toThrow(/bootstrap_not_eligible/)
  })
  it('pins every Wrangler invocation to the local DB without an arbitrary remote/config target', () => {
    const args = bootstrapWranglerArguments('SELECT 1')
    expect(args).toContain('--local')
    expect(args).not.toContain('--remote')
    expect(args.slice(0, 4)).toEqual(['wrangler', 'd1', 'execute', 'DB'])
    expect(args[args.indexOf('--config') + 1]).toBe('wrangler.canary.jsonc')
    expect(args.at(-1)).toBe('SELECT 1')
  })
  it('defaults to read-only plan and requires all explicit apply approvals', () => {
    expect(parseBootstrapArguments(['--identity=' + identityId])).toEqual({ identityId, apply: false })
    expect(
      parseBootstrapArguments([
        '--identity=' + identityId,
        '--apply',
        '--command-id=' + commandId,
        '--expected-plan-hash=' + 'a'.repeat(64),
        '--reason=' + reason
      ])
    ).toMatchObject({ identityId, apply: true, commandId, expectedPlanHash: 'a'.repeat(64), reason })
    for (const args of [
      ['--remote'],
      ['--apply'],
      ['--identity=' + identityId, '--apply'],
      ['--identity=' + identityId, '--identity=' + identityId],
      ['--identity=' + identityId, '--config=production.jsonc']
    ])
      expect(() => parseBootstrapArguments(args)).toThrow()
  })
})
