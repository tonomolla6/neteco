import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { TOTP } from 'otpauth'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { completeD1MfaChallenge } from '../../workers/auth/mfa-completion'
import { encryptSecret, hashOpaqueToken } from '../../server/utils/secrets'
import { recoveryCodeHashes } from '../../server/domain/mfa'
import { hashWorkerPassword } from '../../workers/auth/password'
import { loginD1 } from '../../workers/auth/login'

const now = '2026-09-08T12:00:00Z'
const identityId = '10000000-0000-4000-8000-000000000001'
const secret = 'JBSWY3DPEHPK3PXP'
const tokenPepper = randomBytes(32).toString('hex')
const encryptionKey = randomBytes(32).toString('base64')
const recoveryCode = 'ABCD-1234-EFAB-5678'
const invalid = { ok: false, code: 'invalid_mfa_challenge' }

describe('D1 MFA challenge completion', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let challenge: string
  const code = () => new TOTP({ secret }).generate({ timestamp: Date.parse(now) })
  const complete = (value = code(), token = challenge, db = database) =>
    completeD1MfaChallenge(db, { challenge: token, code: value, tokenPepper, encryptionKey, now })
  function issue() {
    const token = randomBytes(32).toString('base64url')
    sqlite
      .prepare(
        `INSERT INTO mfa_challenges(id, identity_id, session_version, token_hash, created_at, expires_at)
      VALUES (?, ?, 1, ?, '2026-09-08T11:59:00Z', '2026-09-08T12:04:00Z')`
      )
      .run(crypto.randomUUID(), identityId, hashOpaqueToken(token, tokenPepper))
    return token
  }
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, status, created_at, updated_at)
      VALUES (?, 'mfa@example.invalid', 'not-a-login-hash', 'active', ?, ?)`
      )
      .run(identityId, now, now)
    sqlite
      .prepare(
        `INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes, verified_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        identityId,
        encryptSecret(secret, encryptionKey),
        JSON.stringify(recoveryCodeHashes([recoveryCode], tokenPepper)),
        now,
        now
      )
    challenge = issue()
  })
  afterEach(() => sqlite.close())

  it('exchanges a correct password for a hashed challenge, never a session when MFA is verified', async () => {
    const password = 'Synthetic-password-123'
    sqlite.prepare('UPDATE identities SET password_hash = ?').run(await hashWorkerPassword(password))
    const result = await loginD1(database, { email: ' MFA@example.invalid ', password, tokenPepper, now })
    expect(result).toMatchObject({ ok: true, kind: 'mfa_required', expiresAt: '2026-09-08T12:05:00Z' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 })
    if (result.ok && result.kind === 'mfa_required') {
      expect(
        sqlite
          .prepare('SELECT token_hash FROM mfa_challenges WHERE token_hash = ?')
          .get(hashOpaqueToken(result.challenge, tokenPepper))
      ).toBeDefined()
      expect(await complete(code(), result.challenge)).toMatchObject({ ok: true })
    }
    for (const email of ['mfa@example.invalid', 'absent@example.invalid'])
      expect(await loginD1(database, { email, password: 'wrong', tokenPepper, now })).toEqual({
        ok: false,
        code: 'invalid_credentials'
      })
  })

  it('creates a fresh non-MFA session per successful login and rejects reset races', async () => {
    const password = 'Synthetic-password-123'
    sqlite.prepare('UPDATE identities SET password_hash = ?').run(await hashWorkerPassword(password))
    sqlite.exec('DELETE FROM identity_mfa')
    const input = { email: 'mfa@example.invalid', password, tokenPepper, now }
    const first = await loginD1(database, input)
    const second = await loginD1(database, input)
    expect(first).toMatchObject({ ok: true, kind: 'session' })
    expect(second).toMatchObject({ ok: true, kind: 'session' })
    expect(first).not.toEqual(second)
    expect(sqlite.prepare('SELECT sum(mfa_verified) AS n FROM auth_sessions').get()).toEqual({ n: 0 })
    const racing = Object.create(database) as D1Database
    racing.prepare = (sql) => {
      if (sql.includes('INSERT INTO auth_sessions'))
        sqlite.exec('UPDATE identities SET session_version = session_version + 1')
      return database.prepare(sql)
    }
    expect(await loginD1(racing, input)).toEqual({ ok: false, code: 'invalid_credentials' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 2 })
  })

  it('creates one verified session and rejects challenge and TOTP replays', async () => {
    const result = await complete()
    expect(result).toMatchObject({ ok: true, identityId, sessionVersion: 1, expiresAt: '2026-09-08T13:00:00Z' })
    expect(await complete()).toEqual(invalid)
    expect(await complete(code(), issue())).toEqual(invalid)
    expect(sqlite.prepare('SELECT count(*) AS n, mfa_verified FROM auth_sessions').get()).toEqual({
      n: 1,
      mfa_verified: 1
    })
  })

  it('consumes recovery codes once across distinct challenges', async () => {
    expect(await complete(recoveryCode)).toMatchObject({ ok: true })
    expect(await complete(recoveryCode, issue())).toEqual(invalid)
    expect(sqlite.prepare('SELECT recovery_code_hashes, last_used_step FROM identity_mfa').get()).toEqual({
      recovery_code_hashes: '[]',
      last_used_step: null
    })
  })

  it('caps wrong attempts and denies even a correct code after six failures', async () => {
    for (let index = 0; index < 8; index++) expect(await complete('invalid-code')).toEqual(invalid)
    expect(await complete()).toEqual(invalid)
    expect(sqlite.prepare('SELECT attempts FROM mfa_challenges').get()).toEqual({ attempts: 6 })
  })

  it.each([
    "UPDATE identities SET status = 'disabled'",
    'UPDATE identities SET session_version = 2',
    'UPDATE identity_mfa SET verified_at = NULL',
    "UPDATE mfa_challenges SET expires_at = '2026-09-08T12:00:00Z'"
  ])('rejects invalidated authentication state: %s', async (sql) => {
    sqlite.exec(sql)
    expect(await complete()).toEqual(invalid)
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 })
  })

  it('rolls back challenge and recovery consumption when session persistence fails', async () => {
    sqlite.exec(
      "CREATE TRIGGER fail_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'test_session_outage'); END"
    )
    await expect(complete(recoveryCode)).rejects.toThrow('test_session_outage')
    expect(sqlite.prepare('SELECT used_at, attempts FROM mfa_challenges').get()).toEqual({ used_at: null, attempts: 0 })
    expect(sqlite.prepare('SELECT recovery_code_hashes FROM identity_mfa').get()).toEqual({
      recovery_code_hashes: JSON.stringify(recoveryCodeHashes([recoveryCode], tokenPepper))
    })
    sqlite.exec('DROP TRIGGER fail_session')
    expect(await complete(recoveryCode)).toMatchObject({ ok: true })
  })

  it.each(['totp', 'recovery'])('rejects a stale read after another challenge consumes the same %s', async (kind) => {
    const other = issue()
    const value = kind === 'totp' ? code() : recoveryCode
    // Force both reads before either mutation, then execute the winner's complete
    // batch. This tests CAS, without pretending this SQLite adapter is workerd.
    let intercepted = false
    const racing = Object.create(database) as D1Database
    racing.batch = async (statements) => {
      if (!intercepted) {
        intercepted = true
        expect(await complete(value, other)).toMatchObject({ ok: true })
      }
      return database.batch(statements)
    }
    expect(await complete(value, challenge, racing)).toEqual(invalid)
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM mfa_challenges WHERE used_at IS NOT NULL').get()).toEqual({ n: 1 })
  })
})
