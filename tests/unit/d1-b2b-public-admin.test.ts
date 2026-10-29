import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleB2bPublicAdmin } from '../../workers/developer-platform/b2b-public-admin'

const now = '2026-10-29T10:00:00Z'
const identity = '10000000-0000-4000-8000-000000000001'
const session = '20000000-0000-4000-8000-000000000001'
const config = { password: 'a'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string
async function call(body: unknown, options: { cookie?: string; origin?: string; command?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', origin: options.origin ?? 'https://shop.invalid' })
  if (options.cookie !== '') headers.set('cookie', options.cookie ?? cookie)
  if (options.command !== '') headers.set('idempotency-key', options.command ?? '11111111-1111-4111-8111-111111111111')
  return (await handleB2bPublicAdmin(new Request('https://shop.invalid/api/admin/b2b-public/keys', {
    method: 'POST', headers, body: JSON.stringify(body)
  }), { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }))!
}
const create = { action: 'create', environment: 'sandbox', scopes: ['requests.read', 'requests.write'], quotaDaily: 20 }

describe('administración de credenciales B2B', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0121_b2b_public_api.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    sqlite.prepare(`INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,?, 'x',?,'active',?,?)`).run(identity,'admin@test.invalid',now,now,now)
    sqlite.prepare(`INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,'2026-10-29T11:00:00Z')`).run(session,identity,now)
    sqlite.exec(`INSERT INTO roles(code,name,description) VALUES ('b2b-admin','Admin','fixture'); INSERT INTO permissions(code,resource,action,description) VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO role_permissions(role_code,permission_code) VALUES ('b2b-admin','administration.manage')`)
    sqlite.prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'b2b-admin',?)`).run(identity,now)
    cookie = (await issueD1SessionCookie(database,{ identityId: identity, sessionId: session, sessionVersion: 1 },config))!
  })
  afterEach(() => { sqlite.close(); vi.useRealTimers() })
  it('devuelve métricas agregadas reales a administración con sesión viva', async () => {
    await call(create)
    const response = await handleB2bPublicAdmin(new Request('https://shop.invalid/api/admin/b2b-public/metrics', { headers: { cookie } }), { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ day: '2026-10-29', activeKeys: 1, requestsToday: 0 })
  })
  it('no entrega métricas sin sesión', async () => {
    const response = await handleB2bPublicAdmin(new Request('https://shop.invalid/api/admin/b2b-public/metrics'), { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now })
    expect(response?.status).toBe(401)
  })
  it('lista metadatos sin hashes ni secretos a administración', async () => {
    const created = await (await call(create)).json() as { id: string; key: string }
    const response = await handleB2bPublicAdmin(new Request('https://shop.invalid/api/admin/b2b-public/keys', { headers: { cookie } }), { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now })
    expect(response?.status).toBe(200)
    const text = await response!.text()
    expect(text).toContain(created.id)
    expect(text).not.toContain(created.key)
    expect(text).not.toContain('key_hash')
  })
  it('crea clave aleatoria y guarda solo hash con auditoría', async () => {
    const res = await call(create)
    expect(res.status).toBe(201)
    const data = await res.json() as { key: string; id: string }
    expect(data.key).toMatch(/^sbx_[a-f0-9]{64}$/)
    const row = sqlite.prepare('SELECT * FROM b2b_public_keys WHERE id=?').get(data.id)!
    expect(JSON.stringify(row)).not.toContain(data.key)
    expect(sqlite.prepare('SELECT action FROM b2b_public_admin_audit').get()).toMatchObject({ action: 'create' })
  })
  it('rechaza sin sesión', async () => expect((await call(create,{ cookie: '' })).status).toBe(401))
  it('rechaza origen cruzado', async () => expect((await call(create,{ origin: 'https://evil.invalid' })).status).toBe(403))
  it('requiere MFA viva', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    expect((await call(create)).status).toBe(403)
  })
  it('requiere permiso vivo', async () => {
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
    expect((await call(create)).status).toBe(403)
  })
  it('rechaza scopes desconocidos', async () => expect((await call({ ...create, scopes: ['orders.write'] })).status).toBe(422))
  it('rechaza cuota fuera de límites', async () => expect((await call({ ...create, quotaDaily: 0 })).status).toBe(422))
  it('requiere identificador de comando', async () => expect((await call(create,{ command: '' })).status).toBe(400))
  it('repite comando sin emitir otra clave ni revelar secreto otra vez', async () => {
    const first = await (await call(create)).json() as { id: string }
    const retry = await call(create)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ id: first.id, key: null })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 1 })
  })
  it('detecta conflicto idempotente', async () => {
    await call(create)
    expect((await call({ ...create, quotaDaily: 21 })).status).toBe(409)
  })
  it('revoca con CAS y deja auditoría', async () => {
    const { id } = await (await call(create)).json() as { id: string }
    const res = await call({ action: 'revoke', id, expectedVersion: 1 },{ command: '22222222-2222-4222-8222-222222222222' })
    expect(res.status).toBe(200)
    expect(sqlite.prepare('SELECT status,version FROM b2b_public_keys WHERE id=?').get(id)).toMatchObject({ status: 'revoked', version: 2 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
  it('no acepta otra revocación con versión antigua ni añade auditoría', async () => {
    const { id } = await (await call(create)).json() as { id: string }
    const input = { action: 'revoke', id, expectedVersion: 1 }
    expect((await call(input, { command: '22222222-2222-4222-8222-222222222222' })).status).toBe(200)
    expect((await call(input, { command: '33333333-3333-4333-8333-333333333333' })).status).toBe(409)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
  it('rechaza versión obsoleta', async () => {
    const { id } = await (await call(create)).json() as { id: string }
    const res = await call({ action: 'revoke', id, expectedVersion: 2 },{ command: '22222222-2222-4222-8222-222222222222' })
    expect(res.status).toBe(409)
  })
})
