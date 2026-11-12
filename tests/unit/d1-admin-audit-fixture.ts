import { readFile, readdir } from 'node:fs/promises'
import { ADMIN, RECIPIENT, utc } from './d1-admin-invitations-fixture'
import { createD1AdminInvitation } from '../../workers/auth/admin-invitations'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminInvitationTokenHash } from '../../shared/admin-invitations'
import { testUuid } from '../support/deterministic'

export { ADMIN, RECIPIENT, utc }
export const ADMIN_AUDIT_CONFIGURATION = {
  password: 'synthetic-invitations-cookie-password-0123456789abcdef',
  maxAgeSeconds: 3600
}
export async function adminAuditFixture() {
  const sqlite = await openMigratedDatabase(),
    database = d1OverSqlite(sqlite)
  const directory = new URL('../../db/d1/migrations/', import.meta.url)
  const files = (await readdir(directory))
    .filter((file) => {
      const number = Number(file.slice(0, 4))
      return number >= 63 && number <= 84 && file.endsWith('.sql')
    })
    .sort()
  const statements = await Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')))
  sqlite.exec(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`)
  const past = utc(-60000),
    future = utc(8 * 86400000)
  for (const [claims, email] of [
    [ADMIN, 'issuer@example.invalid'],
    [RECIPIENT, 'recipient@example.invalid']
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
    "INSERT INTO roles VALUES('admin','Admin','Synthetic test role'),('support','Support','Synthetic test role'); INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic'); INSERT INTO role_permissions VALUES('admin','administration.manage'),('admin','support.manage'),('support','support.manage')"
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
  const configuration = { ...ADMIN_AUDIT_CONFIGURATION }
  const cookie = async (claims = ADMIN) => (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
  const fixture = {
    sqlite,
    database,
    token,
    input,
    configuration,
    cookie,
    deps: {
      database,
      origin: 'https://audit.neteco.test',
      sessionCookieConfiguration: configuration,
      edgeGate: async () => 'allowed' as const
    }
  }
  async function source() {
    const uniqueToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const uniqueInput = { ...fixture.input, tokenHash: await adminInvitationTokenHash(uniqueToken) }
    const receipt = await createD1AdminInvitation(fixture.database, ADMIN, uniqueInput, {
      idempotencyKey: testUuid()
    })
    return { receipt, id: `admin_invitation:${receipt.commandId}` }
  }
  return { ...fixture, source }
}
