import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret, hashOpaqueToken, randomOpaqueToken } from '../../server/utils/secrets'
import {
  dispatchIdentityEmailDeliveries,
  type IdentityEmailDispatchConfig
} from '../../workers/communications/identity-email-delivery'
import { renderIdentityEmail, type IdentityEmailPurpose } from '../../workers/communications/identity-email'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

const NOW = '2026-09-29T10:00:00Z'
const EXPIRES = '2026-09-29T12:00:00Z'
const EMAIL = 'customer@example.test'
const NEW_EMAIL = 'new-address@example.test'
const KEY = randomBytes(32).toString('base64')
const PEPPER = 'synthetic-unit-test-token-pepper-with-more-than-32-characters'
const enabled: IdentityEmailDispatchConfig = {
  enabled: true,
  from: 'orders@neteco.es',
  publicOrigin: 'https://shop.neteco.test',
  encryptionKey: KEY,
  tokenPepper: PEPPER,
  now: NOW
}
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

// Test-only fault mocks below cross `unknown` because overriding overloaded
// `first` erases its generic signature. This SQLite adapter has enumerable own
// closure methods; spreading preserves them, and binding reapplies the override.
function wrapped(database: D1Database, wrap: (sql: string, statement: D1PreparedStatement) => D1PreparedStatement) {
  return {
    ...database,
    prepare(sql: string) {
      const decorate = (statement: D1PreparedStatement): D1PreparedStatement =>
        ({
          ...wrap(sql, statement),
          bind: (...parameters: unknown[]) => decorate(statement.bind(...parameters))
        }) as D1PreparedStatement
      return decorate(database.prepare(sql))
    }
  } as D1Database
}

function latch() {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}

async function world(purpose: IdentityEmailPurpose = 'verify_email') {
  const sqlite = await openMigratedDatabase()
  opened.push(sqlite)
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_lifecycle_tokens'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0032_identity_lifecycle.sql', import.meta.url), 'utf8'))
  sqlite
    .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('customer-1', 'Ana <img src=x onerror="alert(1)">\n & Co', NOW, NOW)
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status,
         customer_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'identity-1',
      EMAIL,
      'synthetic-password-hash-not-sent',
      purpose === 'verify_email' ? null : NOW,
      purpose === 'verify_email' ? 'pending' : 'active',
      'customer-1',
      NOW,
      NOW
    )
  sqlite
    .prepare(
      `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES ('session-1', 'identity-1', 1, 0, ?, ?)`
    )
    .run(NOW, '2026-10-01T10:00:00Z')
  const token = randomOpaqueToken()
  const tokenId = crypto.randomUUID()
  const recipient = purpose === 'email_change' ? NEW_EMAIL : EMAIL
  sqlite
    .prepare(
      `INSERT INTO identity_lifecycle_tokens(id, identity_id, purpose, token_hash, token_envelope,
         recipient, session_version, created_at, expires_at, authorization_session_id)
       VALUES (?, 'identity-1', ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      tokenId,
      purpose,
      hashOpaqueToken(token, PEPPER),
      encryptSecret(token, KEY),
      recipient,
      NOW,
      EXPIRES,
      purpose === 'email_change' ? 'session-1' : null
    )
  const database = d1OverSqlite(sqlite)
  const sender = { send: vi.fn(async () => ({ messageId: 'cf-identity-message-01' })) }
  return { sqlite, database, sender, token, tokenId, recipient }
}

function state(sqlite: DatabaseSync, tokenId?: string) {
  return (
    tokenId
      ? sqlite.prepare('SELECT * FROM identity_lifecycle_deliveries WHERE token_id = ?').get(tokenId)
      : sqlite.prepare('SELECT * FROM identity_lifecycle_deliveries').get()
  ) as {
    state: string
    attempts: number
    next_attempt_at: string
    lease_token: string | null
    lease_until: string | null
    provider_message_id: string | null
    last_error_code: string | null
  }
}

describe('D1 durable identity email delivery', () => {
  it('keeps requests durable and makes no provider call when disabled, missing or not strictly true', async () => {
    const { sqlite, database, sender } = await world()
    for (const config of [{ now: NOW }, { ...enabled, enabled: false }, { ...enabled, enabled: 'true' as never }]) {
      expect(await dispatchIdentityEmailDeliveries(database, sender, config)).toEqual({
        sent: 0,
        retryable: 0,
        manualReview: 0,
        cancelled: 0,
        lostLease: 0,
        disabled: true
      })
    }
    expect(await dispatchIdentityEmailDeliveries(database, undefined, { now: NOW })).toMatchObject({ disabled: true })
    expect(state(sqlite)).toMatchObject({ state: 'pending', attempts: 0, lease_token: null })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('validates all enabled dependencies before touching any durable job', async () => {
    const { sqlite, database, sender } = await world()
    sqlite
      .prepare("UPDATE identity_lifecycle_deliveries SET state='sending', lease_token='old', lease_until=?")
      .run(NOW)
    const initial = state(sqlite)
    const invalid: Partial<IdentityEmailDispatchConfig>[] = [
      { from: undefined },
      { from: 'Display <orders@neteco.es>' },
      { from: 'orders@neteco.es\r\nBcc: bad@example.test' },
      { publicOrigin: undefined },
      { publicOrigin: 'http://shop.neteco.test' },
      { publicOrigin: 'https://shop.neteco.test/' },
      { publicOrigin: 'https://shop.neteco.test/evil' },
      { publicOrigin: 'https://name:password@shop.neteco.test' },
      { publicOrigin: 'https://shop.neteco.test?redirect=https://evil.test' },
      { publicOrigin: 'https://example.invalid' },
      { publicOrigin: 'not a url' },
      { encryptionKey: undefined },
      { encryptionKey: 'bad' },
      { encryptionKey: Buffer.alloc(32).toString('base64') },
      { tokenPepper: undefined },
      { tokenPepper: 'short' },
      { tokenPepper: 'local-only-'.padEnd(40, 'x') },
      { tokenPepper: 'x'.repeat(1025) }
    ]
    for (const configuration of invalid)
      await expect(
        dispatchIdentityEmailDeliveries(database, sender, { ...enabled, ...configuration })
      ).rejects.toThrow()
    await expect(dispatchIdentityEmailDeliveries(database, undefined, enabled)).rejects.toThrow(
      'identity_email_sender_unavailable'
    )
    await expect(dispatchIdentityEmailDeliveries(database, {} as never, enabled)).rejects.toThrow(
      'identity_email_sender_unavailable'
    )
    expect(state(sqlite)).toEqual(initial)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('rejects invalid dates and unbounded limits without claiming work', async () => {
    const { sqlite, database, sender } = await world()
    for (const input of [
      { now: 'invalid' },
      { now: '2026-09-29T10:00:00.000Z' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.2 }
    ])
      await expect(dispatchIdentityEmailDeliveries(database, sender, { ...enabled, ...input })).rejects.toThrow(
        'invalid_identity_email_dispatch_input'
      )
    expect(state(sqlite)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it.each(['verify_email', 'password_reset', 'email_change'] as const)(
    'sends exactly one authoritative %s link after a durable sending marker',
    async (purpose) => {
      const { sqlite, database, token, tokenId, recipient } = await world(purpose)
      const sender = {
        send: vi.fn(async (message: { to: string; from: string; subject: string; html: string; text: string }) => {
          expect(state(sqlite)).toMatchObject({ state: 'sending', attempts: 1 })
          const link = message.text.split('\n').find((line) => line.startsWith('https://'))!
          expect(new URL(link).origin).toBe(enabled.publicOrigin)
          expect(new URL(link).pathname).toBe(purpose === 'password_reset' ? '/restablecer-clave' : '/verificar-email')
          expect(new URL(link).searchParams.get('token')).toBe(token)
          expect(message.to).toBe(recipient)
          expect(message.from).toBe('orders@neteco.es')
          expect(message.html).toContain('Ana &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co')
          expect(message.html).toContain(`href="${link}"`)
          expect(message.html).not.toContain('<img')
          expect(message.text).toContain('Ana <img src=x onerror="alert(1)"> & Co')
          expect(message.text).toContain('Si no has solicitado esta acción')
          expect(message.subject).not.toContain(token)
          expect(message.html).not.toMatch(/newsletter|unsubscribe|synthetic-password-hash|redirect=/)
          return { messageId: 'cf-identity-message-01' }
        })
      }
      const tokenRow = sqlite.prepare('SELECT * FROM identity_lifecycle_tokens').get() as {
        token_hash: string
        token_envelope: string
      }
      expect(tokenRow.token_hash).toBe(hashOpaqueToken(token, PEPPER))
      expect(decryptSecret(tokenRow.token_envelope, KEY)).toBe(token)
      expect(JSON.stringify(tokenRow)).not.toContain(token)
      expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toEqual({
        sent: 1,
        retryable: 0,
        manualReview: 0,
        cancelled: 0,
        lostLease: 0,
        disabled: false
      })
      expect(state(sqlite)).toMatchObject({
        state: 'sent',
        provider_message_id: 'cf-identity-message-01',
        lease_token: null
      })
      expect(JSON.stringify(state(sqlite))).not.toContain(recipient)
      expect(JSON.stringify(state(sqlite))).not.toContain(token)
      expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ sent: 0 })
      expect(sender.send).toHaveBeenCalledOnce()
      expect(state(sqlite, tokenId).attempts).toBe(1)
    }
  )

  it.each([
    'expired',
    'used',
    'revoked',
    'session_version',
    'locked',
    'disabled',
    'blocked',
    'anonymized',
    'recipient_changed',
    'already_verified'
  ])('cancels %s work before the provider call', async (reason) => {
    const { sqlite, database, sender } = await world()
    if (reason === 'expired')
      sqlite.prepare('UPDATE identity_lifecycle_tokens SET expires_at=?').run('2026-09-29T10:00:01Z')
    if (reason === 'used') sqlite.prepare('UPDATE identity_lifecycle_tokens SET used_at=?').run(NOW)
    if (reason === 'revoked') sqlite.prepare('UPDATE identity_lifecycle_tokens SET revoked_at=?').run(NOW)
    if (reason === 'session_version') sqlite.exec('UPDATE identities SET session_version=2')
    if (reason === 'locked' || reason === 'disabled') sqlite.prepare('UPDATE identities SET status=?').run(reason)
    if (reason === 'blocked' || reason === 'anonymized') sqlite.prepare('UPDATE customers SET status=?').run(reason)
    if (reason === 'recipient_changed') sqlite.prepare('UPDATE identities SET email=?').run(NEW_EMAIL)
    if (reason === 'already_verified') sqlite.prepare('UPDATE identities SET email_verified_at=?').run(NOW)
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:00:02Z' })
    ).toMatchObject({ cancelled: 1, sent: 0 })
    expect(state(sqlite)).toMatchObject({ state: 'cancelled', lease_token: null })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('sends only the replacement when an older request was superseded', async () => {
    const { sqlite, database, sender, tokenId } = await world()
    sqlite.prepare('UPDATE identity_lifecycle_tokens SET revoked_at=?').run(NOW)
    const replacement = randomOpaqueToken()
    sqlite
      .prepare(
        `INSERT INTO identity_lifecycle_tokens(id, identity_id, purpose, token_hash, token_envelope,
      recipient, session_version, created_at, expires_at) VALUES ('replacement', 'identity-1', 'verify_email', ?, ?, ?, 1, ?, ?)`
      )
      .run(hashOpaqueToken(replacement, PEPPER), encryptSecret(replacement, KEY), EMAIL, NOW, EXPIRES)
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ cancelled: 1, sent: 1 })
    expect(state(sqlite, tokenId).state).toBe('cancelled')
    expect(state(sqlite, 'replacement').state).toBe('sent')
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('matches a normalized contractual recipient against a legacy mixed-case identity email', async () => {
    const { sqlite, database, sender } = await world()
    sqlite.prepare('UPDATE identities SET email=?').run('Customer@Example.Test')
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it.each([
    'same_address',
    'occupied_address',
    'source_revoked',
    'source_expired',
    'source_version',
    'mfa_enrolled',
    'mfa_unverified'
  ])('cancels email-change links with %s authorization', async (reason) => {
    const { sqlite, database, sender } = await world('email_change')
    if (reason === 'same_address') sqlite.prepare('UPDATE identity_lifecycle_tokens SET recipient=?').run(EMAIL)
    if (reason === 'occupied_address')
      sqlite
        .prepare(
          `INSERT INTO identities(id,email,password_hash,created_at,updated_at)
        VALUES ('other',?,'synthetic',?,?)`
        )
        .run(NEW_EMAIL, NOW, NOW)
    if (reason === 'source_revoked') sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
    if (reason === 'source_expired') sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run('2026-09-29T10:00:01Z')
    if (reason === 'source_version') sqlite.exec('UPDATE auth_sessions SET session_version=2')
    if (reason === 'mfa_enrolled' || reason === 'mfa_unverified') {
      sqlite
        .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
        .run('identity-1', 'synthetic-encrypted-factor', NOW, NOW)
      if (reason === 'mfa_unverified')
        sqlite.prepare('UPDATE identity_lifecycle_tokens SET authorization_mfa_verified_at=?').run(NOW)
    }
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:00:02Z' })
    ).toMatchObject({ cancelled: 1 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('allows email-change only with the same current verified factor and an MFA-verified source session', async () => {
    const { sqlite, database, sender } = await world('email_change')
    sqlite
      .prepare('INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES (?,?,?,?)')
      .run('identity-1', 'synthetic-encrypted-factor', NOW, NOW)
    sqlite.prepare('UPDATE identity_lifecycle_tokens SET authorization_mfa_verified_at=?').run(NOW)
    sqlite.exec('UPDATE auth_sessions SET mfa_verified=1')
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it.each([
    'corrupted_envelope',
    'wrong_hmac',
    'different_encrypted_token',
    'invalid_recipient',
    'wrong_key',
    'wrong_pepper'
  ])('quarantines %s without sending or storing raw exception contents', async (reason) => {
    const { sqlite, database, sender, token } = await world()
    if (reason === 'corrupted_envelope') {
      const envelope = (
        sqlite.prepare('SELECT token_envelope FROM identity_lifecycle_tokens').get() as { token_envelope: string }
      ).token_envelope
      const parts = envelope.split('.')
      parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`
      sqlite.prepare('UPDATE identity_lifecycle_tokens SET token_envelope=?').run(parts.join('.'))
    }
    if (reason === 'wrong_hmac') sqlite.prepare('UPDATE identity_lifecycle_tokens SET token_hash=?').run('f'.repeat(64))
    if (reason === 'different_encrypted_token')
      sqlite
        .prepare('UPDATE identity_lifecycle_tokens SET token_envelope=?')
        .run(encryptSecret(randomOpaqueToken(), KEY))
    if (reason === 'invalid_recipient')
      sqlite.prepare('UPDATE identity_lifecycle_tokens SET recipient=?').run('bad..address@example.test')
    const config = {
      ...enabled,
      ...(reason === 'wrong_key' ? { encryptionKey: randomBytes(32).toString('base64') } : {}),
      ...(reason === 'wrong_pepper' ? { tokenPepper: 'a-different-synthetic-token-pepper-at-least-32-bytes' } : {})
    }
    const report = await dispatchIdentityEmailDeliveries(database, sender, config)
    expect(report).toMatchObject({ manualReview: 1, sent: 0 })
    expect(state(sqlite).state).toBe('manual_review')
    expect(JSON.stringify(state(sqlite))).not.toContain(token)
    expect(JSON.stringify(report)).not.toContain(EMAIL)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not claim work created after the dispatch timestamp', async () => {
    const { sqlite, database, sender } = await world()
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T09:59:59Z' })
    ).toMatchObject({ sent: 0 })
    expect(state(sqlite)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('retries only pre-provider reads with bounded backoff and sanitized codes', async () => {
    const { sqlite, database, sender, token } = await world()
    const failing = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT t.id')
        ? ({
            ...statement,
            first: async () => {
              throw new Error(`sensitive ${EMAIL} token=${token}`)
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(failing, sender, enabled)).toMatchObject({ retryable: 1 })
    expect(state(sqlite)).toMatchObject({
      state: 'retryable',
      attempts: 1,
      next_attempt_at: '2026-09-29T10:00:30Z',
      last_error_code: 'preparation_failed'
    })
    expect(JSON.stringify(state(sqlite))).not.toContain(token)
    expect(JSON.stringify(state(sqlite))).not.toContain(EMAIL)
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:00:29Z' })
    ).toMatchObject({ sent: 0 })
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:00:30Z' })
    ).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines exhausted preparation attempts, including the last failed read', async () => {
    const { sqlite, database, sender } = await world()
    sqlite.exec('UPDATE identity_lifecycle_deliveries SET attempts=9')
    const failing = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT t.id')
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(failing, sender, enabled)).toMatchObject({
      manualReview: 1,
      retryable: 0
    })
    expect(state(sqlite)).toMatchObject({ state: 'manual_review', attempts: 10 })
    sqlite.exec("UPDATE identity_lifecycle_deliveries SET state='retryable'")
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite).last_error_code).toBe('preparation_attempts_exhausted')
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not call the provider when persisting the sending marker fails, then safely reclaims preparation', async () => {
    const { sqlite, database, sender } = await world()
    const failing = wrapped(database, (sql, statement) =>
      sql.includes("SET state = 'sending'")
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 write unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    await expect(dispatchIdentityEmailDeliveries(failing, sender, enabled)).rejects.toThrow('D1 write unavailable')
    expect(state(sqlite)).toMatchObject({ state: 'preparing', attempts: 1 })
    expect(sender.send).not.toHaveBeenCalled()
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:00:59Z' })
    ).toMatchObject({ sent: 0 })
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 1 })
  })

  it('rechecks revocation at the atomic send boundary after preparing the message', async () => {
    const { sqlite, database, sender } = await world()
    const revoking = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT t.id')
        ? ({
            ...statement,
            first: async () => {
              const row = await statement.first()
              sqlite.prepare('UPDATE identity_lifecycle_tokens SET revoked_at=?').run(NOW)
              return row
            }
          } as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(revoking, sender, enabled)).toMatchObject({ cancelled: 1, sent: 0 })
    expect(state(sqlite)).toMatchObject({ state: 'cancelled', last_error_code: 'token_no_longer_eligible' })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('rechecks email-change source-session revocation at the atomic send boundary', async () => {
    const { sqlite, database, sender } = await world('email_change')
    const revoking = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT t.id')
        ? ({
            ...statement,
            first: async () => {
              const row = await statement.first()
              sqlite.prepare('UPDATE auth_sessions SET revoked_at=?').run(NOW)
              return row
            }
          } as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(revoking, sender, enabled)).toMatchObject({ cancelled: 1, sent: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('allows at most one send during simultaneous claims and while a provider call is in flight', async () => {
    const { sqlite, database } = await world()
    const entered = latch()
    const release = latch()
    const sender = {
      send: vi.fn(async () => {
        entered.release()
        await release.waiting
        return { messageId: 'accepted' }
      })
    }
    const first = dispatchIdentityEmailDeliveries(database, sender, enabled)
    const second = dispatchIdentityEmailDeliveries(database, sender, enabled)
    await entered.waiting
    expect(state(sqlite).state).toBe('sending')
    expect(await second).toMatchObject({ sent: 0 })
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 0 })
    release.release()
    expect(await first).toMatchObject({ sent: 1 })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('rejects a preparing worker whose lease has been replaced without overwriting the final state', async () => {
    const { sqlite, database, sender } = await world()
    const entered = latch()
    const release = latch()
    let paused = false
    const slow = wrapped(database, (sql, statement) =>
      sql.startsWith('SELECT t.id')
        ? ({
            ...statement,
            first: async () => {
              const row = await statement.first()
              if (!paused) {
                paused = true
                entered.release()
                await release.waiting
              }
              return row
            }
          } as D1PreparedStatement)
        : statement
    )
    const old = dispatchIdentityEmailDeliveries(slow, sender, enabled)
    await entered.waiting
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:01:00Z' })
    ).toMatchObject({ sent: 1 })
    release.release()
    expect(await old).toMatchObject({ lostLease: 1, sent: 0 })
    expect(state(sqlite)).toMatchObject({ state: 'sent', attempts: 2, provider_message_id: 'cf-identity-message-01' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines stale sending even when disabled, and ignores a late provider acceptance', async () => {
    const { sqlite, database } = await world()
    const entered = latch()
    const release = latch()
    const sender = {
      send: vi.fn(async () => {
        entered.release()
        await release.waiting
        return { messageId: 'late-accepted' }
      })
    }
    const first = dispatchIdentityEmailDeliveries(database, sender, enabled)
    await entered.waiting
    expect(await dispatchIdentityEmailDeliveries(database, undefined, { now: '2026-09-29T10:15:00Z' })).toMatchObject({
      manualReview: 1,
      disabled: true
    })
    release.release()
    expect(await first).toMatchObject({ sent: 0, lostLease: 1 })
    expect(state(sqlite)).toMatchObject({
      state: 'manual_review',
      last_error_code: 'sending_lease_expired',
      provider_message_id: null
    })
    await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('documents the residual external-network revocation race without reviving or consuming the revoked token', async () => {
    const { sqlite, database, tokenId } = await world()
    const sender = {
      send: vi.fn(async () => {
        sqlite.prepare('UPDATE identity_lifecycle_tokens SET revoked_at=? WHERE id=?').run(NOW, tokenId)
        return { messageId: 'accepted-before-revocation' }
      })
    }
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ sent: 1 })
    expect(sqlite.prepare('SELECT revoked_at, used_at FROM identity_lifecycle_tokens').get()).toEqual({
      revoked_at: NOW,
      used_at: null
    })
    expect(state(sqlite).state).toBe('sent')
    await dispatchIdentityEmailDeliveries(database, sender, enabled)
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('quarantines an ambiguous provider exception without storing it or blindly resending', async () => {
    const { sqlite, database, token } = await world()
    const sender = {
      send: vi.fn(async () => {
        throw new Error(`provider accepted? recipient=${EMAIL} token=${token}`)
      })
    }
    expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ state: 'manual_review', last_error_code: 'provider_outcome_unknown' })
    expect(JSON.stringify(state(sqlite))).not.toContain(token)
    expect(JSON.stringify(state(sqlite))).not.toContain(EMAIL)
    await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it.each(['empty', 'recipient', 'token', 'envelope', 'long', 'whitespace'])(
    'rejects a %s provider receipt without persisting sensitive data',
    async (reason) => {
      const { sqlite, database, token } = await world()
      const envelope = (
        sqlite.prepare('SELECT token_envelope FROM identity_lifecycle_tokens').get() as { token_envelope: string }
      ).token_envelope
      const value = {
        empty: '',
        recipient: EMAIL,
        token,
        envelope,
        long: 'x'.repeat(201),
        whitespace: 'message\r\nsecret'
      }[reason]!
      const sender = { send: vi.fn(async () => ({ messageId: value })) }
      expect(await dispatchIdentityEmailDeliveries(database, sender, enabled)).toMatchObject({ manualReview: 1 })
      expect(state(sqlite)).toMatchObject({
        state: 'manual_review',
        last_error_code: 'provider_receipt_invalid',
        provider_message_id: null
      })
      expect(JSON.stringify(state(sqlite))).not.toContain(token)
      expect(sender.send).toHaveBeenCalledOnce()
    }
  )

  it('quarantines provider acceptance followed by a D1 acknowledgement failure', async () => {
    const { sqlite, database, sender } = await world()
    const failing = wrapped(database, (sql, statement) =>
      sql.includes("SET state = 'sent'")
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 acknowledgement unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(failing, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite)).toMatchObject({ state: 'manual_review', last_error_code: 'provider_ack_failed' })
    await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-30T10:00:00Z' })
    expect(sender.send).toHaveBeenCalledOnce()
  })

  it('retains non-retryable sending on a total post-provider D1 outage until a later safe sweep', async () => {
    const { sqlite, database, sender } = await world()
    const failing = wrapped(database, (sql, statement) =>
      sql.includes("SET state = 'sent'") ||
      (sql.includes("SET state = 'manual_review'") && sql.includes('lease_token = ?2'))
        ? ({
            ...statement,
            first: async () => {
              throw new Error('D1 unavailable')
            }
          } as unknown as D1PreparedStatement)
        : statement
    )
    expect(await dispatchIdentityEmailDeliveries(failing, sender, enabled)).toMatchObject({ manualReview: 1 })
    expect(state(sqlite).state).toBe('sending')
    expect(
      await dispatchIdentityEmailDeliveries(database, sender, { ...enabled, now: '2026-09-29T10:14:59Z' })
    ).toMatchObject({ sent: 0, manualReview: 0 })
    expect(await dispatchIdentityEmailDeliveries(database, undefined, { now: '2026-09-29T10:15:00Z' })).toMatchObject({
      manualReview: 1
    })
    expect(state(sqlite).state).toBe('manual_review')
    expect(sender.send).toHaveBeenCalledOnce()
  })
})

describe('identity transactional templates', () => {
  const snapshot = {
    purpose: 'verify_email' as const,
    token: 'a'.repeat(43),
    publicOrigin: 'https://shop.neteco.test',
    expiresAt: EXPIRES
  }
  it('escapes HTML and safely flattens multiline display names without changing the HTTPS link', () => {
    const rendered = renderIdentityEmail({ ...snapshot, displayName: 'A & "B" <script>\n\tC\rD\u2028E' })
    expect(rendered.html).toContain('A &amp; &quot;B&quot; &lt;script&gt; C D E')
    expect(rendered.text).toContain('Hola A & "B" <script> C D E,')
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.text).toContain(`https://shop.neteco.test/verificar-email?token=${snapshot.token}`)
    expect(rendered.subject).toBe('NETECO: Verifica tu correo electrónico')
  })
  it.each(['x'.repeat(201), 'name\u0001unsafe', 'name\u007funsafe', ''])(
    'rejects out-of-bounds or control-bearing display content',
    (displayName) => {
      expect(() => renderIdentityEmail({ ...snapshot, displayName })).toThrow('invalid_identity_email_content')
    }
  )
  it('rejects token injections, unsupported purposes, malformed expiry and uncontrolled origins', () => {
    for (const invalid of [
      { token: `${'a'.repeat(43)}&redirect=https://evil.test` },
      { purpose: 'newsletter' as never },
      { expiresAt: 'invalid' },
      { publicOrigin: 'http://shop.neteco.test' },
      { publicOrigin: 'https://evil.test/path' }
    ])
      expect(() => renderIdentityEmail({ ...snapshot, ...invalid })).toThrow()
    expect(renderIdentityEmail(snapshot).text.startsWith('Hola,')).toBe(true)
  })
})
