import { readFile } from 'node:fs/promises'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminInvitationTokenHash } from '../../shared/admin-invitations'
import { testUuid, testNow } from '../support/deterministic'

export const ORIGIN = 'https://invitations.neteco.test'
export const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const ADMIN = {
  identityId: '10000000-0000-4000-8000-000000000082',
  sessionId: '20000000-0000-4000-8000-000000000082',
  sessionVersion: 1
}
export const RECIPIENT = {
  identityId: '10000000-0000-4000-8000-000000000083',
  sessionId: '20000000-0000-4000-8000-000000000083',
  sessionVersion: 1
}
export const FOREIGN = {
  identityId: '10000000-0000-4000-8000-000000000084',
  sessionId: '20000000-0000-4000-8000-000000000084',
  sessionVersion: 1
}
export async function invitationFixture() {
  const sqlite = await openMigratedDatabase()
  const database = d1OverSqlite(sqlite)
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0082_admin_invitations.sql', import.meta.url), 'utf8'))
  const past = utc(-60000),
    future = utc(8 * 86400000)
  for (const [claims, email] of [
    [ADMIN, 'issuer@example.invalid'],
    [RECIPIENT, 'recipient@example.invalid'],
    [FOREIGN, 'foreign@example.invalid']
  ] as const) {
    const customerId = claims.identityId === ADMIN.identityId ? null : testUuid()
    if (customerId)
      sqlite
        .prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)")
        .run(customerId, past, past)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,customer_id,created_at,updated_at) VALUES(?,?,'synthetic-password',?,'active',1,?,?,?)"
      )
      .run(claims.identityId, email, past, customerId, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(claims.sessionId, claims.identityId, past, future)
    sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
      )
      .run(claims.identityId, past, past)
  }
  sqlite.exec(
    "INSERT INTO roles VALUES('admin','Admin','Synthetic test role'),('support','Support','Synthetic test role'),('finance','Finance','Synthetic test role'),('demo_bootstrap','Forbidden demo','Synthetic excluded role'); INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic'),('finance.manage','finance','manage','Synthetic'); INSERT INTO role_permissions VALUES('admin','administration.manage'),('admin','support.manage'),('support','support.manage'),('finance','finance.manage'),('demo_bootstrap','support.manage')"
  )
  sqlite.prepare("INSERT INTO identity_roles VALUES(?,'admin',NULL,?,NULL)").run(ADMIN.identityId, past)
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const input = {
    recipientEmail: 'recipient@example.invalid',
    roleCode: 'support' as const,
    tokenHash: await adminInvitationTokenHash(token),
    expiresInHours: 24,
    reason: 'Aprobación humana explícita de soporte.'
  }
  const configuration = { password: 'synthetic-invitations-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }
  const cookie = async (claims = ADMIN) => (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
  return {
    sqlite,
    database,
    token,
    input,
    configuration,
    cookie,
    deps: {
      database,
      origin: ORIGIN,
      sessionCookieConfiguration: configuration,
      edgeGate: async () => 'allowed' as const
    }
  }
}
