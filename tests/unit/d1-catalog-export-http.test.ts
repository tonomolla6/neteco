import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCatalogExportHttp, ownsCatalogExportNamespace } from '../../workers/catalog/catalog-export-http'
import { verifyCatalogExportSnapshot } from '../../shared/catalog-export'

const actor = '00530000-0000-4000-8000-000000000031',
  session = '00530000-0000-4000-8000-000000000032'
const password = 'catalog-export-synthetic-local-test-only-password'.repeat(2)
const origin = 'https://catalog-export.neteco.test'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
describe('private catalogue snapshot HTTP', () => {
  let sqlite: DatabaseSync,
    env: Pick<CloudflareEnv, 'DB' | 'AUTH_ENABLED' | 'AUTH_ORIGIN' | 'NUXT_SESSION_PASSWORD'>,
    cookie: string
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'catalog-export@example.invalid','unusable',?,'active',?,?)"
      )
      .run(actor, utc(-86400000), utc(-86400000), utc(-86400000))
    sqlite.exec(
      "INSERT INTO roles VALUES ('exporter','Exporter','Fixture'); INSERT INTO permissions VALUES ('catalog.write','catalog','write','Fixture'),('administration.manage','administration','manage','Fixture'); INSERT INTO role_permissions VALUES ('exporter','catalog.write'),('exporter','administration.manage')"
    )
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'exporter',?)")
      .run(actor, utc(-86400000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(session, actor, utc(-86400000), utc(3600000))
    const database = d1OverSqlite(sqlite)
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
    const sealed = await issueD1SessionCookie(
      database,
      { sessionId: session, identityId: actor, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    )
    if (!sealed) throw Error('synthetic_session_not_issued')
    cookie = sealed
  })
  afterEach(() => sqlite.close())
  async function get(
    path = '/api/admin/catalog/export/snapshot',
    options: { method?: string; cookie?: string; origin?: string } = {}
  ) {
    const response = await handleCatalogExportHttp(
      new Request(origin + path, {
        method: options.method ?? 'GET',
        headers: { Cookie: options.cookie ?? cookie, Origin: options.origin ?? origin, 'Sec-Fetch-Site': 'same-origin' }
      }),
      env
    )
    expect(response).not.toBeNull()
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response!.headers.get('vary')).toBe('Cookie')
    return response!
  }
  it('reads a complete fresh snapshot without any DB mutation or fake mapped IDs', async () => {
    const before = sqlite.prepare('SELECT * FROM products ORDER BY id').all()
    const response = await get()
    expect(response.status).toBe(200)
    const dto = await verifyCatalogExportSnapshot(await response.json())
    expect(dto.counts.products).toBe(before.length)
    expect(dto.counts.variants).toBeGreaterThan(0)
    expect(sqlite.prepare('SELECT * FROM products ORDER BY id').all()).toEqual(before)
    const second = await get()
    expect(((await second.json()) as typeof dto).snapshotId).not.toBe(dto.snapshotId)
  })
  it.each([
    '?page=1',
    '?q=a&q=b',
    '?category=07',
    '?category=9999999999999999',
    '?status=unknown',
    '?instant=2026-10-03T00:00:00Z',
    '/snapshot/',
    '/other'
  ])('fails closed for ambiguous/unsupported route or query %s', async (suffix) => {
    const path = suffix.startsWith('?')
      ? '/api/admin/catalog/export/snapshot' + suffix
      : '/api/admin/catalog/export' + suffix
    expect((await get(path)).status).toBe(400)
  })
  it('does not route owned case/encoded aliases into fallback APIs', async () => {
    for (const path of [
      '/API/ADMIN/CATALOG/EXPORT/snapshot',
      '/api/admin/catalog/%65xport/snapshot',
      '/api/admin/catalog/exported/snapshot'
    ]) {
      expect(ownsCatalogExportNamespace(path)).toBe(true)
      expect((await get(path)).status).toBe(400)
    }
    expect(await handleCatalogExportHttp(new Request(origin + '/api/products'), env)).toBeNull()
  })
  it('requires GET, sealed cookie, same-origin, fresh intersection grants and MFA', async () => {
    expect((await get(undefined, { method: 'POST' })).status).toBe(405)
    expect((await get(undefined, { cookie: '' })).status).toBe(401)
    expect((await get(undefined, { origin: 'https://evil.test' })).status).toBe(403)
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
    expect(await (await get()).json()).toEqual({ error: { code: 'forbidden' } })
    sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    expect(await (await get()).json()).toEqual({ error: { code: 'mfa_required' } })
  })
  it('returns a sanitized outage, never an empty downloadable catalogue', async () => {
    env = {
      ...env,
      DB: {
        prepare() {
          throw Error('private_sql_database_token_secret')
        }
      } as unknown as D1Database
    }
    const response = await get()
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":{"code":"service_unavailable"}}')
  })
})
