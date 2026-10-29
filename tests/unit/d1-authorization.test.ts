import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { authorizeD1Session } from '../../workers/catalog/authorization'
import { authorizeAdministrativeRequest } from '../../workers/auth/authorize'
import { ironCrypto } from '../../workers/auth/iron-crypto'
import { defaults, seal } from 'iron-webcrypto'
import { consumeIdentityQuota } from '../../workers/auth/identity-quota'
import {
  issueD1SessionCookie,
  revokeD1Session,
  verifySessionCookie,
  clearedSessionCookie
} from '../../workers/auth/session-cookie'
import { unsealSession, createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

const identityId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const claims = { identityId, sessionId, sessionVersion: 1 }
const now = '2026-09-08T12:00:00Z'

describe('D1 authorization from verified session claims', () => {
  let sqlite: DatabaseSync
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES (?, 'fixture@example.invalid', 'test-fixture-not-a-login-hash', '2026-09-01T00:00:00Z', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`
      )
      .run(identityId)
    sqlite.exec(
      "INSERT INTO roles VALUES ('catalog_editor', 'Catalog editor', 'Test fixture'); INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'Test fixture'); INSERT INTO role_permissions VALUES ('catalog_editor', 'catalog.write')"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'catalog_editor', '2026-09-01T00:00:00Z')"
      )
      .run(identityId)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES (?, ?, 1, 1, '2026-09-08T11:00:00Z', '2026-09-08T13:00:00Z')`
      )
      .run(sessionId, identityId)
  })
  afterEach(() => {
    vi.useRealTimers()
    sqlite.close()
  })

  it('issues a secure host-only cookie readable by h3, bounded by D1 expiration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    const configuration = { password: 'test-only-session-secret-at-least-32-characters', maxAgeSeconds: 86400 }
    const cookie = await issueD1SessionCookie(d1OverSqlite(sqlite), claims, configuration)
    expect(cookie).toContain('; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax')
    expect(cookie).not.toContain('Domain=')
    const sealed = decodeURIComponent(cookie!.split(';')[0]!.slice('neteco-session='.length))
    const socket = new Socket()
    try {
      const incoming = new IncomingMessage(socket)
      const event = createEvent(incoming, new ServerResponse(incoming))
      const session = await unsealSession(
        event,
        { name: 'neteco-session', password: configuration.password, maxAge: 86400 },
        sealed
      )
      expect(session.data).toEqual({ sessionId, sessionVersion: 1, user: { id: identityId } })
    } finally {
      socket.destroy()
    }
  })

  it('revokes a signed session idempotently and refuses to reissue it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    const database = d1OverSqlite(sqlite)
    const configuration = { password: 'test-only-session-secret-at-least-32-characters', maxAgeSeconds: 60 }
    const cookie = await issueD1SessionCookie(database, claims, configuration)
    const request = new Request('https://neteco.invalid/api/auth/logout', {
      headers: { cookie: cookie!.split(';')[0]! }
    })
    expect(await verifySessionCookie(request, configuration)).toEqual(claims)
    expect(await revokeD1Session(database, request, configuration)).toBe(clearedSessionCookie)
    expect(await revokeD1Session(database, request, configuration)).toBe(clearedSessionCookie)
    expect(await issueD1SessionCookie(database, claims, configuration)).toBeNull()
    expect(await authorizeD1Session(database, claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'unauthenticated'
    })
  })

  it.each([
    "UPDATE identities SET status = 'disabled'",
    'UPDATE identities SET session_version = 2',
    "UPDATE auth_sessions SET expires_at = '2026-09-08T12:00:00Z'"
  ])('does not issue cookies for invalid session state: %s', async (sql) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite.exec(sql)
    expect(
      await issueD1SessionCookie(d1OverSqlite(sqlite), claims, {
        password: 'test-only-session-secret-at-least-32-characters',
        maxAgeSeconds: 60
      })
    ).toBeNull()
  })

  it('atomically bounds concurrent authenticated requests and saturates denied counters', async () => {
    const database = d1OverSqlite(sqlite)
    const policy = { identityId, scope: 'admin-media-upload', limit: 20, windowSeconds: 3600, now: 1000 }
    const results = await Promise.all(Array.from({ length: 30 }, () => consumeIdentityQuota(database, policy)))
    expect(results.filter((result) => result.allowed)).toHaveLength(20)
    expect(results.filter((result) => !result.allowed)).toHaveLength(10)
    expect(sqlite.prepare('SELECT used, expires_at FROM identity_rate_limits').get()).toEqual({
      used: 21,
      expires_at: 4600
    })
    expect((await consumeIdentityQuota(database, { ...policy, scope: 'another-operation' })).allowed).toBe(true)
  })

  it('resets a quota at its exact boundary without creating per-window rows', async () => {
    const database = d1OverSqlite(sqlite)
    const policy = { identityId, scope: 'admin-media-upload', limit: 1, windowSeconds: 60 }
    expect(await consumeIdentityQuota(database, { ...policy, now: 100 })).toEqual({
      allowed: true,
      remaining: 0,
      retryAfter: 60
    })
    expect(await consumeIdentityQuota(database, { ...policy, now: 159 })).toEqual({
      allowed: false,
      remaining: 0,
      retryAfter: 1
    })
    expect(await consumeIdentityQuota(database, { ...policy, now: 160 })).toEqual({
      allowed: true,
      remaining: 0,
      retryAfter: 60
    })
    expect((await consumeIdentityQuota(database, { ...policy, now: 100 })).allowed).toBe(false)
    expect(sqlite.prepare('SELECT window_started_at, expires_at FROM identity_rate_limits').get()).toEqual({
      window_started_at: 160,
      expires_at: 220
    })
    for (const patch of [{ limit: 0 }, { windowSeconds: -1 }, { now: 1.5 }, { scope: 'injected scope' }]) {
      await expect(consumeIdentityQuota(database, { ...policy, now: 160, ...patch })).rejects.toThrow('invalid_quota')
    }
  })

  it('verifies cookies before D1 access and still rechecks grants after valid signatures', async () => {
    const database = d1OverSqlite(sqlite)
    const prepare = vi.spyOn(database, 'prepare')
    const configuration = { password: 'test-only-neteco-cookie-secret-at-least-32-characters', maxAgeSeconds: 60 }
    const absent = new Request('https://neteco.invalid/api/admin/media')
    expect(await authorizeAdministrativeRequest(absent, database, configuration, 'catalog.write')).toEqual({
      allowed: false,
      code: 'unauthenticated'
    })
    expect(prepare).not.toHaveBeenCalled()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    try {
      const cookie = await seal(
        ironCrypto,
        {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          data: {
            sessionId,
            sessionVersion: 1,
            user: { id: identityId, roles: ['admin'], mfaVerified: true }
          }
        },
        configuration.password,
        { ...defaults, ttl: 60_000 }
      )
      const request = new Request(absent.url, { headers: { cookie: `neteco-session=${cookie}` } })
      expect((await authorizeAdministrativeRequest(request, database, configuration, 'catalog.write')).allowed).toBe(
        true
      )
      sqlite.exec('DELETE FROM role_permissions')
      expect(await authorizeAdministrativeRequest(request, database, configuration, 'catalog.write')).toEqual({
        allowed: false,
        code: 'forbidden'
      })
      sqlite.exec('UPDATE auth_sessions SET mfa_verified = 0')
      expect(await authorizeAdministrativeRequest(request, database, configuration, 'catalog.write')).toEqual({
        allowed: false,
        code: 'mfa_required'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires a matching live database session and grant', async () => {
    expect(await authorizeD1Session(d1OverSqlite(sqlite), claims, 'catalog.write', { now })).toEqual({
      allowed: true,
      identityId,
      sessionId
    })
    expect(await authorizeD1Session(d1OverSqlite(sqlite), claims, 'administration.manage', { now })).toEqual({
      allowed: false,
      code: 'forbidden'
    })
  })

  it.each([
    "UPDATE auth_sessions SET revoked_at = '2026-09-08T11:30:00Z'",
    "UPDATE auth_sessions SET expires_at = '2026-09-08T12:00:00Z'",
    "UPDATE auth_sessions SET created_at = '2026-09-08T12:00:01Z'",
    "UPDATE identities SET status = 'locked'",
    "UPDATE identities SET status = 'disabled'",
    'UPDATE identities SET session_version = 2',
    'UPDATE auth_sessions SET session_version = 2',
    'DELETE FROM auth_sessions'
  ])('denies stale, invalid or revoked sessions: %s', async (mutation) => {
    sqlite.exec(mutation)
    expect(await authorizeD1Session(d1OverSqlite(sqlite), claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'unauthenticated'
    })
  })

  it.each([
    { ...claims, identityId: '10000000-0000-4000-8000-000000000002' },
    { ...claims, sessionId: '20000000-0000-4000-8000-000000000002' },
    { ...claims, sessionVersion: 2 },
    { ...claims, sessionVersion: 1.5 },
    { ...claims, sessionId: "'; DROP TABLE identities;--" }
  ])('does not authorize another identity or malformed/stale claims', async (supplied) => {
    expect(await authorizeD1Session(d1OverSqlite(sqlite), supplied, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'unauthenticated'
    })
  })

  it.each([
    'DELETE FROM identity_roles',
    'DELETE FROM role_permissions',
    "UPDATE identity_roles SET expires_at = '2026-09-08T12:00:00Z'",
    "UPDATE identity_roles SET granted_at = '2026-09-08T12:00:01Z'"
  ])('does not trust roles cached in a session after grant changes: %s', async (mutation) => {
    const database = d1OverSqlite(sqlite)
    expect((await authorizeD1Session(database, claims, 'catalog.write', { now })).allowed).toBe(true)
    sqlite.exec(mutation)
    expect(await authorizeD1Session(database, claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'forbidden'
    })
  })

  it('requires verified email and MFA by default in every environment', async () => {
    const database = d1OverSqlite(sqlite)
    sqlite.exec('UPDATE identities SET email_verified_at = NULL')
    expect(await authorizeD1Session(database, claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'email_unverified'
    })
    sqlite.exec("UPDATE identities SET email_verified_at = '2026-09-09T00:00:00Z'")
    expect(await authorizeD1Session(database, claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'email_unverified'
    })
    sqlite.exec(
      "UPDATE identities SET email_verified_at = '2026-09-01T00:00:00Z'; UPDATE auth_sessions SET mfa_verified = 0"
    )
    expect(await authorizeD1Session(database, claims, 'catalog.write', { now })).toEqual({
      allowed: false,
      code: 'mfa_required'
    })
    expect((await authorizeD1Session(database, claims, 'catalog.write', { now, requireMfa: false })).allowed).toBe(true)
  })

  it('does not disguise D1 outages as permission denials', async () => {
    const database = d1OverSqlite(sqlite)
    vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error('D1 unavailable')
    })
    await expect(authorizeD1Session(database, claims, 'catalog.write', { now })).rejects.toThrow('D1 unavailable')
  })

  it('rejects invalid instants, versions, booleans and orphan grants', async () => {
    await expect(
      authorizeD1Session(d1OverSqlite(sqlite), claims, 'catalog.write', { now: '2026-13-45T99:99:99Z' })
    ).rejects.toThrow('instant')
    expect(() => sqlite.exec('UPDATE auth_sessions SET mfa_verified = 2')).toThrow()
    expect(() => sqlite.exec('UPDATE identities SET session_version = 0')).toThrow()
    expect(() => sqlite.exec("UPDATE auth_sessions SET expires_at = '2026-13-45T99:99:99Z'")).toThrow()
    expect(() => sqlite.exec("INSERT INTO role_permissions VALUES ('missing', 'catalog.write')")).toThrow()
  })
})
