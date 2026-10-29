import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { readD1AdminCapabilities, handleAdminCapabilitiesHttp } from '../../workers/auth/admin-capabilities'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminNavigationGroups, canNavigateAdmin } from '../../shared/admin-navigation'

const identityId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const claims = { identityId, sessionId, sessionVersion: 1 }
const now = '2026-10-08T12:00:00Z'
const configuration = { password: 'synthetic-cookie-password-not-for-production-32', maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite
    .prepare(
      `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
    VALUES (?,'staff@example.invalid','not-a-password','2026-10-01T00:00:00Z','active','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`
    )
    .run(identityId)
  sqlite
    .prepare(
      `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
    VALUES (?,?,1,1,'2026-10-08T11:00:00Z','2026-10-08T13:00:00Z')`
    )
    .run(sessionId, identityId)
  sqlite.exec(`INSERT OR IGNORE INTO roles VALUES ('support','Support','Synthetic');
    INSERT OR IGNORE INTO permissions VALUES ('support.manage','support','manage','Synthetic');
    INSERT OR IGNORE INTO role_permissions VALUES ('support','support.manage');`)
  sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'support','2026-10-01T00:00:00Z')")
    .run(identityId)
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

describe('live read-only administrative navigation capabilities', () => {
  it('admits the professional customer page only for ready administrative authority, not invented child routes', () => {
    const caps = {
      source: 'cloudflare' as const,
      ...claims,
      state: 'ready' as const,
      permissions: ['administration.manage' as const]
    }
    expect(canNavigateAdmin('/admin/clientes', caps)).toBe(true)
    expect(canNavigateAdmin('/admin/clientes/inventado', caps)).toBe(false)
    expect(canNavigateAdmin('/admin/clientes-falso', caps)).toBe(false)
    expect(canNavigateAdmin('/admin/clientes', { ...caps, permissions: ['support.manage'] })).toBe(false)
    expect(canNavigateAdmin('/admin/clientes', { ...caps, state: 'mfa_required', permissions: [] })).toBe(false)
    expect(canNavigateAdmin('/admin/clientes', { ...caps, state: 'email_unverified', permissions: [] })).toBe(false)
    expect(canNavigateAdmin('/admin/clientes', null)).toBe(false)
  })
  it('matches search reader catalog.write and policy reader catalog.publish, not administration labels', () => {
    const navigation = (permission: 'catalog.write' | 'administration.manage' | 'catalog.publish') =>
      adminNavigationGroups({ source: 'cloudflare', ...claims, state: 'ready', permissions: [permission] })
        .flatMap((group) => group.links)
        .map((link) => link.to)
    expect(navigation('catalog.write')).toContain('/admin/busqueda')
    expect(navigation('administration.manage')).not.toContain('/admin/busqueda')
    expect(navigation('catalog.publish')).toContain('/admin/politicas-catalogo')
    expect(navigation('catalog.write')).not.toContain('/admin/politicas-catalogo')
  })
  it('rejects malformed and mismatched claims without inventing a session or grant', async () => {
    const database = d1OverSqlite(sqlite),
      prepare = vi.spyOn(database, 'prepare')
    expect(await readD1AdminCapabilities(database, { ...claims, sessionVersion: 0 }, now)).toBeNull()
    expect(await readD1AdminCapabilities(database, { ...claims, identityId: 'invalid' }, now)).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect(
      await readD1AdminCapabilities(database, { ...claims, identityId: '10000000-0000-4000-8000-000000000002' }, now)
    ).toBeNull()
  })
  it('does not list financial permissions or unimplemented administrative routes', async () => {
    sqlite.exec(
      "INSERT OR IGNORE INTO permissions VALUES ('payments.manage','payments','manage','Synthetic'); INSERT OR IGNORE INTO role_permissions VALUES ('support','payments.manage')"
    )
    const caps = await readD1AdminCapabilities(d1OverSqlite(sqlite), claims, now)
    expect(caps!.permissions).toEqual(['support.manage'])
    const all = {
      ...caps!,
      permissions: [
        'administration.manage',
        'catalog.write',
        'catalog.publish',
        'inventory.read',
        'support.manage'
      ] as const
    }
    const destinations = adminNavigationGroups({ ...all, permissions: [...all.permissions] })
      .flatMap((group) => group.links)
      .map((link) => link.to)
    expect(destinations).not.toContain('/admin/flags')
    expect(destinations).toContain('/admin/clientes')
    expect(destinations).toContain('/admin/inventario')
    expect(destinations).toContain('/admin/politicas-catalogo')
  })
  it('reads live permission grants in exactly one query without changing persistent state', async () => {
    const database = d1OverSqlite(sqlite),
      prepare = vi.spyOn(database, 'prepare')
    const before = sqlite.prepare('SELECT total_changes() AS n').get()
    const result = await readD1AdminCapabilities(database, claims, now)
    expect(result).toMatchObject({ ...claims, state: 'ready', permissions: ['support.manage'] })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    expect(
      adminNavigationGroups(result!)
        .flatMap((g) => g.links)
        .map((l) => l.to)
    ).toEqual(['/admin/soporte'])
    expect(canNavigateAdmin('/admin/soporte/abc', result!)).toBe(true)
    expect(canNavigateAdmin('/admin/soporte-ajeno', result!)).toBe(false)
    expect(canNavigateAdmin('/admin/pedidos', result!)).toBe(false)
  })
  it.each([
    "UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'",
    "UPDATE auth_sessions SET expires_at='2026-10-08T12:00:00Z'",
    "UPDATE auth_sessions SET created_at='2026-10-08T12:30:00Z'",
    'UPDATE identities SET session_version=2',
    "UPDATE identities SET status='disabled'"
  ])('rejects stale session state: %s', async (sql) => {
    sqlite.exec(sql)
    expect(await readD1AdminCapabilities(d1OverSqlite(sqlite), claims, now)).toBeNull()
  })
  it.each([
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['DELETE FROM identity_roles', 'forbidden'],
    ["UPDATE identity_roles SET expires_at='2026-10-08T12:00:00Z'", 'forbidden'],
    ["UPDATE identity_roles SET granted_at='2026-10-09T00:00:00Z'", 'forbidden']
  ])('reveals no business links when authority is unavailable: %s', async (sql, state) => {
    sqlite.exec(sql)
    const result = await readD1AdminCapabilities(d1OverSqlite(sqlite), claims, now)
    expect(result).toMatchObject({ state, permissions: [] })
    expect(adminNavigationGroups(result!)).toEqual([])
  })
  it('removes revoked grants on the next read and never infers admin authority', async () => {
    const database = d1OverSqlite(sqlite)
    expect((await readD1AdminCapabilities(database, claims, now))!.permissions).toEqual(['support.manage'])
    sqlite.exec('DELETE FROM role_permissions')
    expect((await readD1AdminCapabilities(database, claims, now))!.permissions).toEqual([])
  })
  it('owns only its exact GET, denies cross-site and unsigned requests before D1, and is always no-store', async () => {
    const database = d1OverSqlite(sqlite),
      prepare = vi.spyOn(database, 'prepare')
    const deps = { database, sessionCookieConfiguration: configuration, origin: 'https://neteco.invalid', now }
    const url = deps.origin + '/api/admin/capabilities'
    expect(await handleAdminCapabilitiesHttp(new Request(deps.origin + '/api/admin/other'), deps)).toBeNull()
    for (const [request, status] of [
      [new Request(url, { method: 'POST' }), 405],
      [new Request(url, { headers: { origin: 'https://attacker.invalid' } }), 403],
      [new Request(url, { headers: { 'sec-fetch-site': 'cross-site' } }), 403],
      [new Request(url + '?identityId=other'), 400],
      [new Request(url), 401]
    ] as const) {
      const response = (await handleAdminCapabilitiesHttp(request, deps))!
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
    expect(prepare).not.toHaveBeenCalled()
    const cookie = (await issueD1SessionCookie(database, claims, configuration))!.split(';')[0]!
    const response = (await handleAdminCapabilitiesHttp(new Request(url, { headers: { cookie } }), deps))!
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'ready', permissions: ['support.manage'] })
    sqlite.exec("UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'")
    expect((await handleAdminCapabilitiesHttp(new Request(url, { headers: { cookie } }), deps))!.status).toBe(401)
  })
})
