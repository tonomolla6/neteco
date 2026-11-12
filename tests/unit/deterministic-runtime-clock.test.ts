import { afterEach, expect, it, vi } from 'vitest'
import { testNow } from '../support/deterministic'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie, verifySessionCookie } from '../../workers/auth/session-cookie'

const moduleInstant = testNow()

afterEach(() => vi.useRealTimers())

it('fixes Date without taking over timers that a behavior test may control later', () => {
  testNow()
  expect(vi.isFakeTimers()).toBe(false)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const callback = vi.fn()
  setTimeout(callback, 10)
  vi.advanceTimersByTime(10)
  expect(callback).toHaveBeenCalledOnce()
})

it('keeps fixture timestamps coherent with real session issuance and verification', async () => {
  const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const past = new Date(testNow() - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const expires = new Date(testNow() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const sqlite = await openMigratedDatabase()
  try {
    const claims = {
      identityId: '18000000-0000-4000-8000-000000000001',
      sessionId: '28000000-0000-4000-8000-000000000001',
      sessionVersion: 1
    }
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES(?,'clock@example.invalid','synthetic',?,'active',?,?)`
      )
      .run(claims.identityId, past, past, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES(?,?,1,1,?,?)`
      )
      .run(claims.sessionId, claims.identityId, past, expires)
    const configuration = { password: 'synthetic-fixture-clock-password-32-characters', maxAgeSeconds: 60 }
    const cookie = await issueD1SessionCookie(d1OverSqlite(sqlite), claims, configuration)
    expect(cookie).toMatch(/^neteco-session=/)
    expect(
      await verifySessionCookie(
        new Request('https://clock.neteco.invalid', {
          headers: { cookie: cookie! }
        }),
        configuration
      )
    ).toEqual(claims)
    expect(sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").get()?.now).toBe(now)
  } finally {
    sqlite.close()
  }
})

it('respects an explicit test clock and keeps SQLite now on that clock', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2030-02-03T04:05:06Z')
  expect(testNow()).toBe(Date.parse('2030-02-03T04:05:06Z'))
  const sqlite = await openMigratedDatabase()
  try {
    expect(sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").get()?.now).toBe('2030-02-03T04:05:06Z')
    vi.setSystemTime('2030-02-04T04:05:06Z')
    expect(sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").get()?.now).toBe('2030-02-04T04:05:06Z')
    expect(sqlite.prepare("SELECT strftime('%Y-%m-%d','2024-02-29','+1 day') AS value").get()?.value).toBe('2024-03-01')
    expect(sqlite.prepare("SELECT strftime('%Y-%m-%d','not-a-date') AS value").get()?.value).toBeNull()
  } finally {
    sqlite.close()
  }
})

it('keeps module-level fixture instants valid in later tests without another clock read', () => {
  expect(vi.getMockedSystemTime()?.getTime()).toBeGreaterThanOrEqual(moduleInstant)
  expect(vi.getMockedSystemTime()?.getTime()).toBeLessThanOrEqual(moduleInstant + 1)
  expect(vi.isFakeTimers()).toBe(false)
})
