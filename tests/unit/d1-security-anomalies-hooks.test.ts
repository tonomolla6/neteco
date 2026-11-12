import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { TOTP, Secret } from 'otpauth'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { completeD1MfaChallenge } from '../../workers/auth/mfa-completion'
import { hashWorkerPassword } from '../../workers/auth/password'
import { encryptSecret, hashOpaqueToken } from '../../server/utils/secrets'
import { recoveryCodeHashes } from '../../server/domain/mfa'
import { planD1Refund, confirmD1Refund } from '../../workers/refunds/operations'
import { refundsCreditFixture, CLAIMS, REASON } from './d1-refunds-credit-fixture'
import { testUuid, testNow } from '../support/deterministic'

/** Same schema as openAccountSecurityDatabase minus migrations the base fixture already applied (0091). */
async function openAccountSecurityDatabase() {
  const sqlite = await openMigratedDatabase()
  const directory = new URL('../../db/d1/migrations/', import.meta.url)
  const files = (await readdir(directory))
    .filter((file) => {
      const number = Number(file.slice(0, 4))
      return number >= 63 && number <= 93 && number !== 91 && file.endsWith('.sql')
    })
    .sort()
  for (const file of files) sqlite.exec(await readFile(new URL(file, directory), 'utf8'))
  return sqlite
}

const NOW = '2026-09-08T12:00:00Z'
const IDENTITY = '10000000-0000-4000-8000-000000000093'
const CUSTOMER = '30000000-0000-4000-8000-000000000093'
const SECRET = 'JBSWY3DPEHPK3PXP'
const PEPPER = randomBytes(32).toString('hex')
const KEY = randomBytes(32).toString('base64')
const RECOVERY = 'ABCD-1234-EFAB-5678'
const IP_A = 'a'.repeat(64)
const IP_B = 'b'.repeat(64)
const UA_A = 'c'.repeat(64)
const UA_B = 'd'.repeat(64)

describe('SEC-035 emission hooks: MFA completion (new device and recovery code)', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const signals = () =>
    sqlite
      .prepare(
        'SELECT signal_type, severity, reason_code, actor_id, object_id, ip_hash, user_agent_hash FROM security_anomaly_signals ORDER BY created_at, rowid'
      )
      .all() as Array<Record<string, string>>

  function issue() {
    const token = randomBytes(32).toString('base64url')
    sqlite
      .prepare(
        `INSERT INTO mfa_challenges(id, identity_id, session_version, token_hash, created_at, expires_at)
         VALUES (?, ?, 1, ?, '2026-09-08T11:59:00Z', '2026-09-08T12:04:00Z')`
      )
      .run(testUuid(), IDENTITY, hashOpaqueToken(token, PEPPER))
    return token
  }
  const code = () => new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) })
  const complete = (extra: Record<string, unknown> = {}, value = code(), at = NOW) =>
    completeD1MfaChallenge(database, {
      challenge: issue(),
      code: value,
      tokenPepper: PEPPER,
      encryptionKey: KEY,
      now: at,
      ...extra
    })

  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, status, created_at, updated_at)
         VALUES (?, 'hook-admin@example.invalid', 'not-a-login-hash', 'active', ?, ?)`
      )
      .run(IDENTITY, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO identity_mfa(identity_id, encrypted_secret, recovery_code_hashes, verified_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(IDENTITY, encryptSecret(SECRET, KEY), JSON.stringify(recoveryCodeHashes([RECOVERY], PEPPER)), NOW, NOW)
    sqlite.exec("INSERT INTO roles VALUES('admin','Admin','Synthetic'),('support','Support','Synthetic')")
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_by,granted_at,expires_at) VALUES(?,'support',NULL,'2026-09-01T00:00:00Z',NULL)"
      )
      .run(IDENTITY)
  })
  afterEach(() => sqlite.close())

  it('raises a medium signal for the first device and none for the same device afterwards', async () => {
    expect(await complete({ ipHash: IP_A, userAgentHash: UA_A })).toMatchObject({ ok: true })
    expect(signals()).toEqual([
      expect.objectContaining({
        signal_type: 'admin_new_device_login',
        severity: 'medium',
        reason_code: 'admin_login_new_device_fingerprint',
        actor_id: IDENTITY,
        ip_hash: IP_A,
        user_agent_hash: UA_A
      })
    ])
    // Same fingerprint, later TOTP step: known device, no new signal.
    expect(
      await complete(
        { ipHash: IP_A, userAgentHash: UA_A },
        new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) + 60_000 }),
        '2026-09-08T12:01:00Z'
      )
    ).toMatchObject({ ok: true })
    expect(signals()).toHaveLength(1)
    expect(sqlite.prepare('SELECT seen_count FROM security_admin_known_devices').get()).toEqual({ seen_count: 2 })
  })

  it('raises a high signal for a second, different device (IP or user agent changes)', async () => {
    await complete({ ipHash: IP_A, userAgentHash: UA_A })
    await complete(
      { ipHash: IP_B, userAgentHash: UA_A },
      new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) + 60_000 }),
      '2026-09-08T12:01:00Z'
    )
    await complete(
      { ipHash: IP_A, userAgentHash: UA_B },
      new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) + 120_000 }),
      '2026-09-08T12:02:00Z'
    )
    expect(signals().map((row) => row.severity)).toEqual(['medium', 'high', 'high'])
    expect(sqlite.prepare('SELECT count(*) n FROM security_admin_known_devices').get()).toEqual({ n: 3 })
  })

  it('raises mfa_recovery_code_used (high for admins) plus the device signal when a recovery code logs in', async () => {
    expect(await complete({ ipHash: IP_A, userAgentHash: UA_A }, RECOVERY)).toMatchObject({ ok: true })
    const rows = signals()
    expect(rows.map((row) => row.reason_code).sort()).toEqual([
      'admin_login_new_device_fingerprint',
      'mfa_recovery_code_used'
    ])
    expect(rows.find((row) => row.reason_code === 'mfa_recovery_code_used')).toMatchObject({
      severity: 'high',
      signal_type: 'mfa_change'
    })
  })

  it('stays silent for identities without any role and for logins without network evidence', async () => {
    expect(await complete({})).toMatchObject({ ok: true })
    expect(signals()).toEqual([])
    sqlite.prepare('DELETE FROM identity_roles').run()
    expect(
      await complete(
        { ipHash: IP_A, userAgentHash: UA_A },
        new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) + 60_000 }),
        '2026-09-08T12:01:00Z'
      )
    ).toMatchObject({ ok: true })
    expect(signals()).toEqual([])
    expect(sqlite.prepare('SELECT count(*) n FROM auth_sessions').get()).toEqual({ n: 2 })
  })

  it('never breaks authentication on malformed hashes or a failing signal store', async () => {
    expect(await complete({ ipHash: 'not-a-hash', userAgentHash: UA_A })).toMatchObject({ ok: true })
    expect(signals()).toEqual([])
    sqlite.exec(
      "CREATE TRIGGER fail_signal BEFORE INSERT ON security_anomaly_signals BEGIN SELECT RAISE(ABORT,'synthetic_signal_failure'); END"
    )
    expect(await complete({ ipHash: IP_B, userAgentHash: UA_B }, RECOVERY)).toMatchObject({ ok: true })
    sqlite.exec('DROP TRIGGER fail_signal; DROP TABLE security_admin_known_devices')
    expect(
      await complete(
        { ipHash: IP_B, userAgentHash: UA_B },
        new TOTP({ secret: SECRET }).generate({ timestamp: Date.parse(NOW) + 60_000 }),
        '2026-09-08T12:01:00Z'
      )
    ).toMatchObject({ ok: true })
    expect(sqlite.prepare('SELECT count(*) n FROM auth_sessions').get()).toEqual({ n: 3 })
  })
})

describe('SEC-035 emission hook: MFA enrollment over HTTP', () => {
  const password = 'Synthetic-enrollment-password-123'
  const configuration = {
    password: randomBytes(32).toString('hex'),
    maxAgeSeconds: 3600,
    origin: 'https://neteco.invalid',
    tokenPepper: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64')
  }
  let sqlite: DatabaseSync
  let database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  const api = (method: string, path: string, cookie = '', body?: unknown) =>
    new Request(`${configuration.origin}${path}`, {
      method,
      headers: {
        cookie,
        origin: configuration.origin,
        'cf-connecting-ip': '192.0.2.93',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const handle = (request: Request) =>
    handleAuthenticationHttp(request, { database, edgeLimiter: limiter, configuration: () => configuration })
  async function enroll() {
    const login = (await handle(
      api('POST', '/api/auth/login', '', { email: 'hook-enroll@example.invalid', password })
    ))!
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const setup = (await (await handle(
      api('POST', '/api/auth/mfa/setup', cookie, { currentPassword: password })
    ))!.json()) as {
      setupId: string
      manualKey: string
    }
    const token = new TOTP({ secret: Secret.fromBase32(setup.manualKey) }).generate()
    return (await handle(api('POST', '/api/auth/mfa/verify-setup', cookie, { setupId: setup.setupId, code: token })))!
  }
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    database = d1OverSqlite(sqlite)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(CUSTOMER, 'Cliente', now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
         VALUES (?, 'hook-enroll@example.invalid', ?, ?, 'active', ?, ?, ?)`
      )
      .run(IDENTITY, await hashWorkerPassword(password), now, CUSTOMER, now, now)
  })
  afterEach(() => sqlite.close())

  it('raises mfa_reenrolled (high) for an administrative identity', async () => {
    sqlite.exec("INSERT INTO roles VALUES('support','Support','Synthetic')")
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_by,granted_at,expires_at) VALUES(?,'support',NULL,'2026-01-01T00:00:00Z',NULL)"
      )
      .run(IDENTITY)
    expect((await enroll()).status).toBe(200)
    expect(
      sqlite.prepare('SELECT signal_type, severity, reason_code, actor_id FROM security_anomaly_signals').all()
    ).toEqual([{ signal_type: 'mfa_change', severity: 'high', reason_code: 'mfa_reenrolled', actor_id: IDENTITY }])
  })

  it('stays silent for an ordinary customer and never breaks enrollment when the signal store fails', async () => {
    expect((await enroll()).status).toBe(200)
    expect(sqlite.prepare('SELECT count(*) n FROM security_anomaly_signals').get()).toEqual({ n: 0 })
    // Admin whose signal store is down: enrollment still succeeds.
    sqlite.exec("INSERT INTO roles VALUES('support','Support','Synthetic')")
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_by,granted_at,expires_at) VALUES(?,'support',NULL,'2026-01-01T00:00:00Z',NULL)"
      )
      .run(IDENTITY)
    sqlite.exec('DELETE FROM identity_mfa; DROP TABLE security_anomaly_commands; DROP TABLE security_anomaly_signals')
    expect((await enroll()).status).toBe(200)
  })
})

describe('SEC-035 emission hook: refunds (plan and confirm)', () => {
  const opened: DatabaseSync[] = []
  afterEach(() => {
    for (const db of opened.splice(0)) db.close()
  })
  async function world() {
    const fixture = await refundsCreditFixture()
    await applyDeliveryPreferencesMigration(fixture.sqlite)
    if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='security_anomaly_signals'").get())
      fixture.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0093_security_anomaly_signals.sql', import.meta.url), 'utf8')
      )
    opened.push(fixture.sqlite)
    const input = (quantity = 1) => ({
      idempotencyKey: testUuid(),
      policyId: fixture.policy.id,
      returnPublicRef: fixture.returnRef,
      expectedReturnVersion: 5,
      reason: REASON,
      evidenceRef: 'documented-local-case',
      lines: [{ lineIndex: 0, quantity }]
    })
    const rows = () =>
      fixture.sqlite
        .prepare(
          'SELECT signal_type, severity, reason_code, object_type, object_id, context_json FROM security_anomaly_signals ORDER BY rowid'
        )
        .all() as Array<Record<string, string>>
    return { ...fixture, input, rows }
  }

  it('emits no signal below the amount threshold and one per stage at and above it (idempotent on replay)', async () => {
    const f = await world()
    const planInput = f.input()
    const planned = await planD1Refund(f.database, CLAIMS, planInput, {
      anomalyThresholds: { refundAmountThresholdCents: 100_000 }
    })
    expect(f.rows()).toEqual([])
    const amount = (
      f.sqlite.prepare('SELECT amount_gross_cents a FROM refund_contracts WHERE id=?').get(planned.id) as { a: number }
    ).a
    expect(amount).toBeGreaterThan(0)

    const second = await planD1Refund(f.database, CLAIMS, f.input(), {
      anomalyThresholds: { refundAmountThresholdCents: amount }
    })
    expect(f.rows()).toHaveLength(1)
    expect(f.rows()[0]).toMatchObject({
      signal_type: 'refund_anomaly',
      reason_code: 'refund_amount_threshold_exceeded',
      object_type: 'refund',
      object_id: second.id
    })
    expect(JSON.parse(f.rows()[0]!.context_json)).toMatchObject({
      stage: 'plan',
      grossCents: amount,
      amountThresholdCents: amount
    })

    // Exact replay of the same command is served from the ledger and emits nothing new.
    await planD1Refund(
      f.database,
      CLAIMS,
      { ...f.input(), idempotencyKey: planInput.idempotencyKey },
      { anomalyThresholds: { refundAmountThresholdCents: 1 } }
    ).catch(() => undefined)
    await planD1Refund(f.database, CLAIMS, planInput, { anomalyThresholds: { refundAmountThresholdCents: 1 } })
    expect(f.rows()).toHaveLength(1)

    const confirmed = await confirmD1Refund(
      f.database,
      CLAIMS,
      second.id,
      {
        idempotencyKey: testUuid(),
        expectedGeneration: second.generation,
        contractFingerprint: second.contractFingerprint,
        reason: REASON,
        evidenceRef: 'confirmed-local-case'
      },
      { anomalyThresholds: { refundAmountThresholdCents: amount } }
    )
    expect(confirmed.action).toBe('confirmed')
    expect(f.rows().map((row) => JSON.parse(row.context_json).stage)).toEqual(['plan', 'confirm'])
  })

  it('flags a burst of refunds by the same actor and never breaks the refund when the signal store fails', async () => {
    const f = await world()
    const burst = {
      refundAmountThresholdCents: 10_000_000,
      refundBurstCountThreshold: 2,
      refundBurstWindowSeconds: 3600
    }
    await planD1Refund(f.database, CLAIMS, f.input(), { anomalyThresholds: burst })
    expect(f.rows()).toEqual([])
    await planD1Refund(f.database, CLAIMS, f.input(), { anomalyThresholds: burst })
    expect(f.rows()).toHaveLength(1)
    expect(f.rows()[0]).toMatchObject({ reason_code: 'refund_actor_burst_exceeded', severity: 'high' })

    const second = f.sqlite.prepare('SELECT id FROM refund_contracts ORDER BY rowid DESC LIMIT 1').get() as {
      id: string
    }
    const work = f.sqlite.prepare('SELECT generation FROM refund_work WHERE refund_id=?').get(second.id) as {
      generation: number
    }
    const fingerprint = (
      f.sqlite.prepare('SELECT contract_fingerprint c FROM refund_contracts WHERE id=?').get(second.id) as { c: string }
    ).c
    f.sqlite.exec(
      "CREATE TRIGGER fail_signal BEFORE INSERT ON security_anomaly_signals BEGIN SELECT RAISE(ABORT,'synthetic_signal_failure'); END"
    )
    const survived = await confirmD1Refund(
      f.database,
      CLAIMS,
      second.id,
      {
        idempotencyKey: testUuid(),
        expectedGeneration: work.generation,
        contractFingerprint: fingerprint,
        reason: REASON,
        evidenceRef: 'confirmed-local-case'
      },
      { anomalyThresholds: { refundAmountThresholdCents: 1 } }
    )
    expect(survived.action).toBe('confirmed')
    expect(f.rows()).toHaveLength(1)
  })
})
