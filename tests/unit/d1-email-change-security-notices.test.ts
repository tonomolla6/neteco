import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { registerD1Identity, requestD1EmailChange, verifyD1Email } from '../../workers/auth/lifecycle'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { decryptSecret } from '../../server/utils/secrets'
import { publishEmailOutbox, type EmailDispatchMessage } from '../../workers/communications/email-outbox'
import { receiveEmailDispatch } from '../../workers/communications/email-outbox'
import {
  dispatchTransactionalEmails,
  type TransactionalEmailSender
} from '../../workers/communications/transactional-email-delivery'
import { loginD1 } from '../../workers/auth/login'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { updateD1DeliveryPreferences } from '../../workers/auth/delivery-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { DELIVERY_PREFERENCES_POLICY_VERSION } from '../../shared/delivery-preferences'
import { testUuid, testNow } from '../support/deterministic'

const PREVIOUS = 'previous-security@example.invalid',
  CURRENT = 'current-security@example.invalid'
const PASSWORD = 'Synthetic-email-change-password-123'
let sqlite: DatabaseSync, database: D1Database, now: string
let identityId: string, sessionId: string, token: string, tokenId: string
let configuration: { password: string; tokenPepper: string; encryptionKey: string; maxAgeSeconds: number }
beforeEach(async () => {
  sqlite = await openAccountSecurityDatabase()
  database = d1OverSqlite(sqlite)
  now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  configuration = {
    password: randomBytes(32).toString('hex'),
    tokenPepper: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64'),
    maxAgeSeconds: 3600
  }
  const account = await registerD1Identity(
    database,
    { name: 'Synthetic email owner', email: PREVIOUS, password: PASSWORD, termsAccepted: true, newsletter: false },
    configuration,
    now
  )
  if (!account.ok) throw Error('synthetic_registration_failed')
  identityId = account.identityId
  sessionId = account.sessionId
  const verification = sqlite
    .prepare("SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose='verify_email'")
    .get()!
  expect(
    (
      await verifyD1Email(
        database,
        { token: decryptSecret(verification.token_envelope as string, configuration.encryptionKey) },
        configuration,
        now
      )
    ).ok
  ).toBe(true)
  const cookie = await issueD1SessionCookie(database, account, configuration)
  expect(cookie).not.toBeNull()
  expect(
    await requestD1EmailChange(
      database,
      new Request('https://neteco.invalid/api/account/email-change', { headers: { cookie: cookie!.split(';')[0]! } }),
      configuration,
      { email: CURRENT, currentPassword: PASSWORD },
      now
    )
  ).toEqual({ ok: true })
  const link = sqlite
    .prepare(
      "SELECT id,token_envelope FROM identity_lifecycle_tokens WHERE purpose='email_change' AND revoked_at IS NULL"
    )
    .get()!
  tokenId = link.id as string
  token = decryptSecret(link.token_envelope as string, configuration.encryptionKey)
})
afterEach(() => sqlite?.close())
function notices() {
  return sqlite
    .prepare(
      'SELECT id,identity_id,kind,recipient,audience,session_version,domain_event_id,created_at FROM identity_account_security_events ORDER BY session_version'
    )
    .all()
}
function changedEvents() {
  return sqlite.prepare("SELECT id FROM identity_lifecycle_events WHERE event_type='email_changed'").all()
}
function beforeBatch(change: () => void): D1Database {
  let changed = false
  return {
    ...database,
    async batch<T>(statements: D1PreparedStatement[]) {
      if (!changed) {
        changed = true
        change()
      }
      return database.batch<T>(statements)
    }
  } as D1Database
}
function assertNoCompletion() {
  expect(notices()).toEqual([])
  expect(changedEvents()).toEqual([])
  expect(sqlite.prepare('SELECT used_at FROM identity_lifecycle_tokens WHERE id=?').get(tokenId)).toEqual({
    used_at: null
  })
  expect(sqlite.prepare('SELECT count(*) n FROM identity_account_security_guards').get()?.n).toBe(0)
  expect(sqlite.prepare('SELECT count(*) n FROM identity_lifecycle_guards').get()?.n).toBe(0)
}
async function readySecurityDelivery(sourceIds = notices().map((row) => row.id)) {
  const ids = sqlite
    .prepare('SELECT id,source_event_id FROM email_outbox_events')
    .all()
    .filter((row) => sourceIds.includes(row.source_event_id))
    .map((row) => row.id)
  const queued: EmailDispatchMessage[] = []
  await publishEmailOutbox(
    database,
    {
      send: async (message) => {
        queued.push(message)
      }
    },
    { now }
  )
  for (const message of queued.filter((message) => ids.includes(message.eventId)))
    expect(await receiveEmailDispatch(database, message, now)).toBe('stored')
  expect(ids).toHaveLength(2)
  return ids
}
const deliveryConfig = () => ({ enabled: true, from: 'seguridad@neteco.es', now, appEnvironment: 'local' as const })
it('delivers both historical security recipients exactly once despite explicit marketing and delivery opt-outs', async () => {
  const claims = { identityId, sessionId, sessionVersion: 1 },
    options = { now: () => now }
  await updateD1AccountPreferences(
    database,
    claims,
    testUuid(),
    {
      expectedVersion: 0,
      preferences: { product_updates: false, replenishment: false },
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
    },
    options
  )
  await updateD1DeliveryPreferences(
    database,
    claims,
    testUuid(),
    {
      expectedVersion: 0,
      deliveryUpdates: false,
      policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION
    },
    options
  )
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  await readySecurityDelivery()
  const sent: { to: string; text: string }[] = []
  const sender: TransactionalEmailSender = {
    send: async (message) => {
      sent.push(message)
      return { messageId: `synthetic-${sent.length}` }
    }
  }
  expect(await dispatchTransactionalEmails(database, sender, deliveryConfig())).toMatchObject({
    sent: 2,
    manualReview: 0
  })
  expect(sqlite.prepare('SELECT count(*) n FROM operational_email_suppressions').get()).toEqual({ n: 0 })
  await dispatchTransactionalEmails(database, sender, deliveryConfig())
  expect(sent.map((message) => message.to).sort()).toEqual([PREVIOUS, CURRENT].sort())
  expect(sent.every((message) => message.text.includes('cambio verificado'))).toBe(true)
  for (const secret of [token, PASSWORD, configuration.encryptionKey, configuration.tokenPepper])
    expect(JSON.stringify(sent)).not.toContain(secret)
})
it('a later real email change never retargets the earlier immutable recipients', async () => {
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  const originalSources = notices().map((row) => row.id)
  const login = await loginD1(database, {
    email: CURRENT,
    password: PASSWORD,
    tokenPepper: configuration.tokenPepper,
    now
  })
  if (!login.ok || login.kind !== 'session') throw Error('synthetic_second_login_failed')
  const cookie = await issueD1SessionCookie(database, login, configuration)
  expect(cookie).not.toBeNull()
  expect(
    await requestD1EmailChange(
      database,
      new Request('https://neteco.invalid/api/account/email-change', {
        headers: { cookie: cookie!.split(';')[0]! }
      }),
      configuration,
      { email: 'third-security@example.invalid', currentPassword: PASSWORD },
      now
    )
  ).toEqual({ ok: true })
  const next = sqlite
    .prepare(
      "SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose='email_change' AND used_at IS NULL AND revoked_at IS NULL"
    )
    .get()!
  expect(
    (
      await verifyD1Email(
        database,
        { token: decryptSecret(next.token_envelope as string, configuration.encryptionKey) },
        configuration,
        now
      )
    ).ok
  ).toBe(true)
  await readySecurityDelivery(originalSources)
  const recipients: string[] = []
  expect(
    await dispatchTransactionalEmails(
      database,
      {
        send: async (message) => {
          recipients.push(message.to)
          return { messageId: `historical-${recipients.length}` }
        }
      },
      deliveryConfig()
    )
  ).toMatchObject({ sent: 2, manualReview: 0 })
  expect(recipients.sort()).toEqual([PREVIOUS, CURRENT].sort())
  expect(notices()).toHaveLength(4)
})
it('an unknown fake-provider outcome is quarantined and never automatically resent', async () => {
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  await readySecurityDelivery()
  let calls = 0
  const sender: TransactionalEmailSender = {
    send: async () => {
      calls++
      throw Error('synthetic_lost_provider_ack')
    }
  }
  expect(await dispatchTransactionalEmails(database, sender, deliveryConfig())).toMatchObject({
    sent: 0,
    manualReview: 2
  })
  await dispatchTransactionalEmails(database, sender, deliveryConfig())
  expect(calls).toBe(2)
  expect(sqlite.prepare('SELECT status,last_error_code FROM transactional_email_deliveries').all()).toEqual([
    { status: 'manual_review', last_error_code: 'provider_outcome_unknown' },
    { status: 'manual_review', last_error_code: 'provider_outcome_unknown' }
  ])
})
it('pre-send source D1 outages retry only within the existing bound and never contact the provider', async () => {
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  await readySecurityDelivery()
  const unavailable = {
    ...database,
    prepare(sql: string) {
      if (sql.includes('FROM email_outbox_events e JOIN identity_account_security_events'))
        throw Error('synthetic_source_outage')
      return database.prepare(sql)
    }
  } as D1Database
  let calls = 0
  const sender: TransactionalEmailSender = {
    send: async () => {
      calls++
      return { messageId: 'must-not-send' }
    }
  }
  let dispatchNow = now
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await dispatchTransactionalEmails(unavailable, sender, { ...deliveryConfig(), now: dispatchNow })
    expect(result).toMatchObject({ sent: 0, retryable: attempt < 10 ? 2 : 0, manualReview: attempt === 10 ? 2 : 0 })
    dispatchNow = new Date(Date.parse(dispatchNow) + Math.min(3600, 30 * 2 ** (attempt - 1)) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
  }
  await dispatchTransactionalEmails(unavailable, sender, { ...deliveryConfig(), now: dispatchNow })
  expect(calls).toBe(0)
  expect(sqlite.prepare('SELECT status,attempts,last_error_code FROM transactional_email_deliveries').all()).toEqual([
    { status: 'manual_review', attempts: 10, last_error_code: 'preparation_failed' },
    { status: 'manual_review', attempts: 10, last_error_code: 'preparation_failed' }
  ])
})
it('requesting a change or confirming the original registration never claims a completed email change', () => {
  assertNoCompletion()
  expect(sqlite.prepare('SELECT email,session_version FROM identities WHERE id=?').get(identityId)).toEqual({
    email: PREVIOUS,
    session_version: 1
  })
})
it('commits exactly two immutable, server-addressed security notices with the real email change and revocation', async () => {
  expect(await verifyD1Email(database, { token }, configuration, now)).toMatchObject({ ok: true, emailChanged: true })
  const operationId = changedEvents()[0]!.id
  const rows = notices()
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({
    identity_id: identityId,
    kind: 'email_changed',
    recipient: PREVIOUS,
    audience: 'previous',
    session_version: 1,
    domain_event_id: operationId,
    created_at: now
  })
  expect(rows[1]).toMatchObject({
    identity_id: identityId,
    kind: 'email_changed',
    recipient: CURRENT,
    audience: 'current',
    session_version: 2,
    domain_event_id: operationId,
    created_at: now
  })
  expect(rows[0]!.id).not.toBe(rows[1]!.id)
  expect(
    sqlite.prepare('SELECT email,email_verified_at,session_version FROM identities WHERE id=?').get(identityId)
  ).toEqual({ email: CURRENT, email_verified_at: now, session_version: 2 })
  expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(sessionId)).toEqual({ revoked_at: now })
  const queued = sqlite
    .prepare(
      'SELECT e.source_event_id,e.source_id,e.source_kind,d.status,d.attempts FROM email_outbox_events e JOIN identity_account_security_events s ON s.id=e.source_event_id JOIN email_outbox_delivery d ON d.event_id=e.id ORDER BY s.session_version'
    )
    .all()
  expect(queued).toEqual(
    rows.map((row) => ({
      source_event_id: row.id,
      source_id: identityId,
      source_kind: 'identity',
      status: 'ready',
      attempts: 0
    }))
  )
  expect(JSON.stringify(queued)).not.toContain(token)
  expect(() =>
    sqlite
      .prepare('UPDATE identity_account_security_events SET recipient=? WHERE id=?')
      .run('other@example.invalid', rows[0]!.id)
  ).toThrow(/immutable/)
})
it('replaying the consumed verification token does not append another notice or lifecycle completion', async () => {
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  const before = notices()
  expect(await verifyD1Email(database, { token }, configuration, now)).toEqual({ ok: false, code: 'invalid_token' })
  expect(notices()).toEqual(before)
  expect(before).toHaveLength(2)
  expect(changedEvents()).toHaveLength(1)
})
it('two contenders that already read the token still commit only one change and its two notices', async () => {
  let arrivals = 0,
    release!: () => void
  const bothRead = new Promise<void>((resolve) => {
    release = resolve
  })
  let tail: Promise<unknown> = Promise.resolve()
  const concurrent = {
    ...database,
    async batch<T>(statements: D1PreparedStatement[]) {
      if (++arrivals === 2) release()
      await bothRead
      const result = tail.then(() => database.batch<T>(statements))
      tail = result.catch(() => undefined)
      return result
    }
  } as D1Database
  const results = await Promise.all([
    verifyD1Email(concurrent, { token }, configuration, now),
    verifyD1Email(concurrent, { token }, configuration, now)
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: 'invalid_token' }])
  expect(changedEvents()).toHaveLength(1)
  expect(notices()).toHaveLength(2)
})
it('publishes each notice once to the local fake queue without recipients, tokens or another identity mutation', async () => {
  expect((await verifyD1Email(database, { token }, configuration, now)).ok).toBe(true)
  const targetIds = sqlite
    .prepare('SELECT e.id FROM email_outbox_events e JOIN identity_account_security_events s ON s.id=e.source_event_id')
    .all()
    .map((row) => row.id)
  expect(targetIds).toHaveLength(2)
  const sent: EmailDispatchMessage[] = []
  const queue = {
    send: async (message: EmailDispatchMessage) => {
      sent.push(message)
    }
  }
  await publishEmailOutbox(database, queue, { now })
  await publishEmailOutbox(database, queue, { now })
  const noticesSent = sent.filter((message) => targetIds.includes(message.eventId))
  expect(noticesSent).toHaveLength(2)
  expect(new Set(noticesSent.map((message) => message.eventId)).size).toBe(2)
  for (const message of noticesSent) expect(Object.keys(message).sort()).toEqual(['eventId', 'type', 'version'])
  for (const privateValue of [PREVIOUS, CURRENT, token]) expect(JSON.stringify(sent)).not.toContain(privateValue)
  expect(changedEvents()).toHaveLength(1)
  expect(notices()).toHaveLength(2)
  expect(sqlite.prepare('SELECT email,session_version FROM identities WHERE id=?').get(identityId)).toEqual({
    email: CURRENT,
    session_version: 2
  })
})
it('an outbox insertion failure rolls back both notices, the identity change, token use and session revocation', async () => {
  sqlite.exec(
    "CREATE TRIGGER synthetic_email_notice_failure BEFORE INSERT ON email_outbox_events WHEN EXISTS(SELECT 1 FROM identity_account_security_events WHERE id=NEW.source_event_id) BEGIN SELECT RAISE(ABORT,'synthetic_notice_outbox_failure'); END"
  )
  await expect(verifyD1Email(database, { token }, configuration, now)).rejects.toThrow(
    'synthetic_notice_outbox_failure'
  )
  assertNoCompletion()
  expect(sqlite.prepare('SELECT email,session_version FROM identities WHERE id=?').get(identityId)).toEqual({
    email: PREVIOUS,
    session_version: 1
  })
  expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(sessionId)).toEqual({ revoked_at: null })
})
it.each(['recipient', 'version', 'revoked-session'] as const)(
  'rejects a %s race before the atomic write without sending to a stale recipient',
  async (race) => {
    const raced = beforeBatch(() => {
      if (race === 'recipient')
        sqlite.prepare('UPDATE identities SET email=? WHERE id=?').run('concurrent@example.invalid', identityId)
      if (race === 'version')
        sqlite.prepare('UPDATE identities SET session_version=session_version+1 WHERE id=?').run(identityId)
      if (race === 'revoked-session')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(now, sessionId)
    })
    expect(await verifyD1Email(raced, { token }, configuration, now)).toEqual({ ok: false, code: 'invalid_token' })
    assertNoCompletion()
    expect(sqlite.prepare('SELECT email FROM identities WHERE id=?').get(identityId)?.email).toBe(
      race === 'recipient' ? 'concurrent@example.invalid' : PREVIOUS
    )
  }
)
