import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { TOTP, Secret } from 'otpauth'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openAccountSecurityDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { hashWorkerPassword, verifyWorkerPassword } from '../../workers/auth/password'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { testNow } from '../support/deterministic'

const ID = '10000000-0000-4000-8000-000000000071',
  CUSTOMER = '30000000-0000-4000-8000-000000000071'
const EMAIL = 'security-events@example.invalid',
  PASSWORD = 'Synthetic-original-password-123',
  NEXT = 'Synthetic-replacement-password-456'
const configuration = {
  origin: 'https://security-native.invalid',
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}
let sqlite: DatabaseSync, database: D1Database, cookie: string
const sender = { send: vi.fn(async (_message: unknown) => ({ messageId: 'synthetic-account-security' })) }
const api = (method: string, path: string, body?: unknown) =>
  handleAuthenticationHttp(
    new Request(configuration.origin + path, {
      method,
      headers: {
        Origin: configuration.origin,
        Cookie: cookie,
        'CF-Connecting-IP': '192.0.2.71',
        'Content-Type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    { database, edgeLimiter: { limit: async () => ({ success: true }) }, configuration: () => configuration }
  )
beforeEach(async () => {
  sqlite = await openAccountSecurityDatabase()
  database = d1OverSqlite(sqlite)
  const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  sqlite
    .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(CUSTOMER, 'Synthetic Customer', now, now)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,?,?,'active',?,?,?)"
    )
    .run(ID, EMAIL, await hashWorkerPassword(PASSWORD), now, CUSTOMER, now, now)
  cookie = ''
  const login = (await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }))!
  expect(login.status).toBe(200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]!
  sender.send.mockReset().mockResolvedValue({ messageId: 'synthetic-account-security' })
})
afterEach(() => sqlite?.close())
const password = () => api('PUT', '/api/account/password', { currentPassword: PASSWORD, newPassword: NEXT })
async function enrollment() {
  const response = (await api('POST', '/api/auth/mfa/setup', { currentPassword: PASSWORD }))!
  expect(response.status).toBe(200)
  return (await response.json()) as { setupId: string; manualKey: string; recoveryCodes: string[] }
}
const code = (secret: string) =>
  new TOTP({
    issuer: 'NETECO',
    label: 'account',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret)
  }).generate()
const verify = (pending: Awaited<ReturnType<typeof enrollment>>, value = code(pending.manualKey)) =>
  api('POST', '/api/auth/mfa/verify-setup', { setupId: pending.setupId, code: value })
const sources = () =>
  sqlite.prepare('SELECT kind,recipient,audience,session_version FROM identity_account_security_events').all()
const rejectOutbox = () =>
  sqlite.exec(
    "CREATE TRIGGER synthetic_account_notice_failure BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'synthetic_account_notice_failure'); END"
  )
async function deliver(secrets: string[] = []) {
  const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    messages: unknown[] = []
  await publishEmailOutbox(
    database,
    {
      send: async (message) => {
        messages.push(message)
      }
    },
    { now }
  )
  expect(messages).toHaveLength(1)
  expect(JSON.stringify(messages)).not.toContain(EMAIL)
  expect(await receiveEmailDispatch(database, messages[0], now)).toBe('stored')
  expect(await receiveEmailDispatch(database, messages[0], now)).toBe('replayed')
  const config = { enabled: true, from: 'seguridad@neteco.es', now, appEnvironment: 'local' as const }
  expect(await dispatchTransactionalEmails(database, sender, config)).toMatchObject({ sent: 1, manualReview: 0 })
  const message = sender.send.mock.calls[0]![0] as { to: string }
  expect(message.to).toBe(EMAIL)
  for (const secret of [PASSWORD, NEXT, configuration.encryptionKey, configuration.tokenPepper, ...secrets])
    expect(JSON.stringify(message)).not.toContain(secret)
  await dispatchTransactionalEmails(database, sender, config)
  expect(sender.send).toHaveBeenCalledTimes(1)
}
it('records and delivers exactly one authenticated password-change security notice', async () => {
  expect((await password())!.status).toBe(200)
  expect(sources()).toEqual([{ kind: 'password_changed', recipient: EMAIL, audience: 'current', session_version: 2 }])
  await deliver()
  expect((await password())!.status).toBe(401)
  expect(sources()).toHaveLength(1)
})
it('records and delivers exactly one successful MFA activation notice, with no secret/code material', async () => {
  const pending = await enrollment()
  expect(sources()).toEqual([])
  expect((await verify(pending))!.status).toBe(200)
  expect(sources()).toEqual([{ kind: 'mfa_enabled', recipient: EMAIL, audience: 'current', session_version: 1 }])
  const source = sqlite.prepare('SELECT id,domain_event_id FROM identity_account_security_events').get()
  expect(source).toMatchObject({
    id: expect.any(String),
    domain_event_id: expect.any(String)
  })
  expect(source!.domain_event_id).toBe(source!.id)
  await deliver([pending.manualKey, ...pending.recoveryCodes])
  expect((await verify(pending))!.status).toBe(401)
  expect(sources()).toHaveLength(1)
})
it('does not notify invalid password, same password, MFA setup or an invalid MFA code', async () => {
  expect((await api('PUT', '/api/account/password', { currentPassword: 'incorrect', newPassword: NEXT }))!.status).toBe(
    401
  )
  expect(
    (await api('PUT', '/api/account/password', { currentPassword: PASSWORD, newPassword: PASSWORD }))!.status
  ).toBe(400)
  const pending = await enrollment(),
    actual = code(pending.manualKey)
  expect((await verify(pending, actual === '000000' ? '111111' : '000000'))!.status).toBe(401)
  expect(sources()).toEqual([])
  expect(sqlite.prepare('SELECT count(*) n FROM email_outbox_events').get()).toEqual({ n: 0 })
  expect(sender.send).not.toHaveBeenCalled()
})
it('rolls back password rotation and session changes if notice outbox cannot be persisted', async () => {
  const before = sqlite.prepare('SELECT * FROM auth_sessions').all()
  rejectOutbox()
  expect((await password())!.status).toBe(500)
  const identity = sqlite.prepare('SELECT password_hash,session_version FROM identities').get()!
  expect(identity.session_version).toBe(1)
  expect(await verifyWorkerPassword(identity.password_hash as string, PASSWORD)).toBe(true)
  expect(sqlite.prepare('SELECT * FROM auth_sessions').all()).toEqual(before)
  expect(sources()).toEqual([])
})
it('rolls back factor activation, session flags and enrollment consumption if outbox fails', async () => {
  const pending = await enrollment(),
    before = sqlite.prepare('SELECT * FROM mfa_enrollments').all()
  rejectOutbox()
  expect((await verify(pending))!.status).toBe(500)
  expect(sqlite.prepare('SELECT count(*) n FROM identity_mfa').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('SELECT mfa_verified FROM auth_sessions').get()).toEqual({ mfa_verified: 0 })
  expect(sqlite.prepare('SELECT * FROM mfa_enrollments').all()).toEqual(before)
  expect(sources()).toEqual([])
})
it.each(['password', 'mfa'] as const)(
  'rejects %s notice recipient drift before the effect batch without partial commit',
  async (kind) => {
    const pending = kind === 'mfa' ? await enrollment() : null,
      original = database
    let raced = false
    database = {
      ...original,
      batch: async (statements) => {
        if (!raced) {
          raced = true
          sqlite.exec("UPDATE identities SET email='foreign@example.invalid'")
        }
        return original.batch(statements)
      }
    } as D1Database
    const response = kind === 'password' ? await password() : await verify(pending!)
    expect(response!.ok).toBe(false)
    expect(raced).toBe(true)
    expect(sources()).toEqual([])
    expect(sqlite.prepare('SELECT session_version FROM identities').get()).toEqual({ session_version: 1 })
    expect(sqlite.prepare('SELECT count(*) n FROM identity_mfa').get()).toEqual({ n: 0 })
  }
)
