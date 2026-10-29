import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleNativeCatalogImportHttp,
  ownsNativeCatalogImportNamespace
} from '../../workers/catalog/native-import-http'

const actor = '00540000-0000-4000-8000-000000000001'
const session = '00540000-0000-4000-8000-000000000002'
const warehouse = '00540000-0000-4000-8000-000000000003'
const origin = 'https://native-import.example.invalid'
const prefix = '/api/admin/catalog/native-import'
const password = 'synthetic-native-import-http-session-secret'.repeat(2)
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
type Environment = Parameters<typeof handleNativeCatalogImportHttp>[1]
describe('private native catalog intake HTTP boundary', () => {
  let sqlite: DatabaseSync, database: D1Database, env: Environment, cookie: string
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_native_previews'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0054_catalog_native_import.sql', import.meta.url), 'utf8')
      )
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'HTTP-NATIVE','Supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,54,'Category','native-http','published')"
      )
      .run(ids.category)
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Brand','native-http','published')")
      .run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'HTTP-NATIVE','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'HTTP-NATIVE','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'HTTP-NATIVE','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'native-http@example.invalid','unusable-synthetic',?,'active',?,?)"
      )
      .run(actor, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('native-http','Importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('native-http',?)").run(`${resource}.${action}`)
    }
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native-http',?)")
      .run(actor, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(session, actor, utc(-86400_000), utc(7200_000))
    cookie = (await issueD1SessionCookie(
      database,
      { identityId: actor, sessionId: session, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const body = () => ({
    records: [
      {
        ...catalogRecord(),
        inventory_json: JSON.stringify([
          { locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }
        ])
      }
    ]
  })
  function request(path = '/preview', method = 'POST', value: unknown = body(), extra: Record<string, string> = {}) {
    return new Request(origin + prefix + path, {
      method,
      headers: { origin, cookie, 'content-type': 'application/json', ...extra },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(value) })
    })
  }
  const call = async (req: Request, environment = env) => (await handleNativeCatalogImportHttp(req, environment))!
  async function expectError(req: Request, code: string, status: number, environment = env) {
    const response = await call(req, environment)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return response
  }
  async function preview() {
    const response = await call(request())
    expect(response.status).toBe(200)
    const data = (await response.json()) as { id: string; hash: string; outcome: string }
    expect(data.outcome).toBe('preview')
    return data
  }
  it('owns encoded and mixed-case namespace escapes without falling through', async () => {
    expect(ownsNativeCatalogImportNamespace('/api/products')).toBe(false)
    expect(await handleNativeCatalogImportHttp(new Request(origin + '/api/products'), env)).toBeNull()
    for (const path of [
      '/api/admin/catalog/native-import-extra',
      '/API/ADMIN/CATALOG/NATIVE-IMPORT/preview',
      '/api/admin/catalog/%6eative-import/preview',
      '/api/admin/catalog/%256eative-import/preview'
    ]) {
      expect(ownsNativeCatalogImportNamespace(path)).toBe(true)
      await expectError(new Request(origin + path), 'invalid_input', 400)
    }
    const response = await expectError(request('/preview', 'GET'), 'method_not_allowed', 405)
    expect(response.headers.get('allow')).toBe('POST')
    await expectError(request('/previews/' + session, 'POST'), 'method_not_allowed', 405)
    await expectError(request('/previews/not-a-uuid', 'GET'), 'invalid_input', 400)
    await expectError(request('/preview?now=2099-01-01T00:00:00Z'), 'invalid_input', 400)
  })
  it('requires enabled authentication, same-origin CSRF and a verified signed cookie', async () => {
    await expectError(request(), 'service_unavailable', 503, { ...env, AUTH_ENABLED: 'false' })
    await expectError(request(), 'service_unavailable', 503, { ...env, AUTH_ORIGIN: origin + '/' })
    await expectError(request('/preview', 'POST', body(), { origin: 'https://attacker.invalid' }), 'csrf_rejected', 403)
    await expectError(request('/preview', 'POST', body(), { 'sec-fetch-site': 'cross-site' }), 'csrf_rejected', 403)
    await expectError(request('/preview', 'POST', body(), { cookie: '' }), 'unauthenticated', 401)
    await expectError(
      request('/preview', 'POST', { ...body(), identityId: actor }, { cookie: 'neteco-session=forged' }),
      'unauthenticated',
      401
    )
    const missingOrigin = request()
    missingOrigin.headers.delete('origin')
    await expectError(missingOrigin, 'csrf_rejected', 403)
  })
  it.each(['catalog.write', 'administration.manage', 'inventory.write'])(
    'checks current %s permission on every route',
    async (permission) => {
      const p = await preview()
      sqlite.prepare('DELETE FROM role_permissions WHERE permission_code=?').run(permission)
      await expectError(request(), 'forbidden', 403)
      await expectError(request('/previews/' + p.id, 'GET'), 'forbidden', 403)
      await expectError(
        request(
          '/previews/' + p.id + '/apply',
          'POST',
          { previewHash: p.hash, reason: 'Approved' },
          { 'idempotency-key': 'apply-http' }
        ),
        'forbidden',
        403
      )
      expect(sqlite.prepare('SELECT count(*) count FROM products').get()).toEqual({ count: 0 })
    }
  )
  it('checks live MFA, email verification and revoked session', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    await expectError(request(), 'mfa_required', 403)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(session)
    sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(actor)
    await expectError(request(), 'email_unverified', 403)
    sqlite.prepare('UPDATE identities SET email_verified_at=? WHERE id=?').run(utc(-1000), actor)
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
    await expectError(request(), 'unauthenticated', 401)
  })
  it('previews, reads, applies, idempotently replays and reverts with private safe headers', async () => {
    const p = await preview()
    const read = request('/previews/' + p.id, 'GET')
    read.headers.delete('origin')
    expect((await call(read)).status).toBe(200)
    const command = { previewHash: p.hash, reason: 'Approved import' }
    const apply = () => request('/previews/' + p.id + '/apply', 'POST', command, { 'idempotency-key': 'apply-http' })
    const response = await call(apply()),
      receipt = await response.json()
    expect(response.status).toBe(200)
    expect(receipt).toMatchObject({ action: 'apply', updated: true })
    for (const [key, value] of Object.entries({
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer'
    }))
      expect(response.headers.get(key)).toBe(value)
    expect(await (await call(apply())).json()).toEqual(receipt)
    await expectError(
      request(
        '/previews/' + p.id + '/apply',
        'POST',
        { ...command, reason: 'Changed approval' },
        { 'idempotency-key': 'apply-http' }
      ),
      'idempotency_conflict',
      409
    )
    const reverted = await call(
      request('/previews/' + p.id + '/revert', 'POST', command, { 'idempotency-key': 'revert-http' })
    )
    expect(reverted.status).toBe(200)
    expect(await reverted.json()).toMatchObject({ action: 'revert', updated: true })
    expect(sqlite.prepare('SELECT status FROM products').get()).toEqual({ status: 'discontinued' })
  })
  it('rejects extras including client time, malformed JSON, bad UTF-8, types and body sizes', async () => {
    await expectError(request('/preview', 'POST', { ...body(), now: utc() }), 'invalid_input', 422)
    await expectError(request('/preview', 'POST', { records: [] }), 'invalid_input', 422)
    await expectError(request('/preview', 'POST', body(), { 'content-type': 'text/plain' }), 'json_required', 415)
    await expectError(request('/preview', 'POST', body(), { 'content-length': '900001' }), 'body_too_large', 413)
    await expectError(request('/preview', 'POST', body(), { 'content-length': '-1' }), 'body_too_large', 413)
    const raw = (bytes: Uint8Array) =>
      new Request(origin + prefix + '/preview', {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: bytes
      })
    await expectError(raw(new Uint8Array([0xff])), 'invalid_json', 400)
    await expectError(raw(new TextEncoder().encode('{')), 'invalid_json', 400)
    await expectError(raw(new Uint8Array(900001)), 'body_too_large', 413)
    const missing = new Request(origin + prefix + '/preview', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' }
    })
    await expectError(missing, 'missing_body', 400)
    const p = await preview()
    await expectError(request('/previews/' + p.id + '/apply'), 'invalid_idempotency_key', 400)
    await expectError(
      request(
        '/previews/' + p.id + '/apply',
        'POST',
        { previewHash: p.hash, reason: 'Approved', now: utc() },
        { 'idempotency-key': 'strict' }
      ),
      'invalid_input',
      422
    )
    await expectError(
      request(
        '/previews/' + p.id + '/apply',
        'POST',
        { previewHash: p.hash, reason: 'x'.repeat(5000) },
        { 'idempotency-key': 'large' }
      ),
      'body_too_large',
      413
    )
  })
  it('limits writes persistently to 30 per hour while allowing reads', async () => {
    const p = await preview()
    sqlite
      .prepare("UPDATE identity_rate_limits SET used=30 WHERE identity_id=? AND scope='admin-native-catalog-import'")
      .run(actor)
    const response = await expectError(request(), 'rate_limited', 429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await call(request('/previews/' + p.id, 'GET'))).status).toBe(200)
    sqlite
      .prepare(
        "UPDATE identity_rate_limits SET window_started_at=1,expires_at=2 WHERE identity_id=? AND scope='admin-native-catalog-import'"
      )
      .run(actor)
    expect((await call(request())).status).toBe(200)
  })
  it('returns domain not-found/conflict and sanitizes unexpected storage errors', async () => {
    await expectError(request('/previews/' + session, 'GET'), 'not_found', 404)
    const p = await preview()
    await expectError(
      request(
        '/previews/' + p.id + '/apply',
        'POST',
        { previewHash: 'a'.repeat(64), reason: 'Approved' },
        { 'idempotency-key': 'wrong-hash' }
      ),
      'version_conflict',
      409
    )
    const broken = {
      ...database,
      prepare: () => {
        throw new Error('SELECT private_password FROM secret_table')
      }
    } as D1Database
    await expectError(request(), 'service_unavailable', 503, { ...env, DB: broken })
  })
  it('cancels stalled streaming request bodies at the deadline', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const req = new Request(origin + prefix + '/preview', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = call(req)
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(8001)
    const response = await result
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: { code: 'body_timeout' } })
    expect(cancel).toHaveBeenCalled()
  })
})
