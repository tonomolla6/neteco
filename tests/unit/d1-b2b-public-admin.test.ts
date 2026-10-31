import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleB2bPublicApi } from '../../workers/developer-platform/b2b-public-api'
import { handleB2bPublicAdmin } from '../../workers/developer-platform/b2b-public-admin'

const now = '2026-10-29T10:00:00Z'
const identity = '10000000-0000-4000-8000-000000000001'
const companyId = '30000000-0000-4000-8000-000000000001'
const session = '20000000-0000-4000-8000-000000000001'
const config = { password: 'a'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string
async function call(body: unknown, options: { cookie?: string; origin?: string; command?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', origin: options.origin ?? 'https://shop.invalid' })
  if (options.cookie !== '') headers.set('cookie', options.cookie ?? cookie)
  if (options.command !== '') headers.set('idempotency-key', options.command ?? '11111111-1111-4111-8111-111111111111')
  return (await handleB2bPublicAdmin(
    new Request('https://shop.invalid/api/admin/b2b-public/keys', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }),
    { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
  ))!
}
const create = { action: 'create', environment: 'sandbox', scopes: ['requests.read', 'requests.write'], quotaDaily: 20 }

describe('administración de credenciales B2B', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0121_b2b_public_api.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,?, 'x',?,'active',?,?)`
      )
      .run(identity, 'admin@test.invalid', now, now, now)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,'2026-10-29T11:00:00Z')`
      )
      .run(session, identity, now)
    sqlite.exec(
      `INSERT INTO roles(code,name,description) VALUES ('b2b-admin','Admin','fixture'); INSERT INTO permissions(code,resource,action,description) VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO role_permissions(role_code,permission_code) VALUES ('b2b-admin','administration.manage')`
    )
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'b2b-admin',?)`)
      .run(identity, now)
    sqlite.prepare(`INSERT INTO customers(id,created_at,updated_at) VALUES ('customer-a',?,?)`).run(now, now)
    sqlite
      .prepare(
        `INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES (?,'customer-a','Synthetic company','approved',?,?)`
      )
      .run(companyId, now, now)
    cookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      config
    ))!
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })
  it('devuelve métricas agregadas reales a administración con sesión viva', async () => {
    await call(create)
    const response = await handleB2bPublicAdmin(
      new Request('https://shop.invalid/api/admin/b2b-public/metrics', { headers: { cookie } }),
      { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
    )
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ day: '2026-10-29', activeKeys: 1, requestsToday: 0 })
  })
  it('no entrega métricas si la sesión expira durante la consulta', async () => {
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('AS activeKeys')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async first() {
                const row = await bound.first()
                vi.setSystemTime(new Date('2026-10-29T11:00:00Z'))
                return row
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleB2bPublicAdmin(
      new Request('https://shop.invalid/api/admin/b2b-public/metrics', { headers: { cookie } }),
      { database: guarded, sessionCookieConfiguration: config, origin: 'https://shop.invalid' }
    )
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('activeKeys')
  })
  it('no entrega métricas si caduca la cookie durante la consulta', async () => {
    const shortConfig = { ...config, maxAgeSeconds: 1 }
    const shortCookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      shortConfig
    ))!
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('AS activeKeys')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async first() {
                const row = await bound.first()
                vi.advanceTimersByTime(2000)
                return row
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleB2bPublicAdmin(
      new Request('https://shop.invalid/api/admin/b2b-public/metrics', { headers: { cookie: shortCookie } }),
      { database: guarded, sessionCookieConfiguration: shortConfig, origin: 'https://shop.invalid' }
    )
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('activeKeys')
  })
  it('no entrega métricas sin sesión', async () => {
    const response = await handleB2bPublicAdmin(new Request('https://shop.invalid/api/admin/b2b-public/metrics'), {
      database,
      sessionCookieConfiguration: config,
      origin: 'https://shop.invalid',
      now
    })
    expect(response?.status).toBe(401)
  })
  it('lista metadatos sin hashes ni secretos a administración', async () => {
    const created = (await (await call(create)).json()) as { id: string; key: string }
    const response = await handleB2bPublicAdmin(
      new Request('https://shop.invalid/api/admin/b2b-public/keys', { headers: { cookie } }),
      { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
    )
    expect(response?.status).toBe(200)
    const text = await response!.text()
    expect(text).toContain(created.id)
    expect(text).not.toContain(created.key)
    expect(text).not.toContain('key_hash')
  })
  it('permite recorrer claves administrativas en páginas acotadas', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO b2b_public_keys(id,key_hash,environment,company_id,scopes,quota_daily,status,version,created_at) VALUES (?,?,'sandbox',NULL,'requests.read',10,'active',1,?)`
    )
    for (let i = 0; i < 102; i++) insert.run(`key-${i}`, i.toString(16).padStart(64, '0'), now)
    const request = new Request('https://shop.invalid/api/admin/b2b-public/keys?page=2', { headers: { cookie } })
    const response = await handleB2bPublicAdmin(request, {
      database,
      sessionCookieConfiguration: config,
      origin: 'https://shop.invalid',
      now
    })
    expect(response?.status).toBe(200)
    expect(((await response?.json()) as { items: unknown[] }).items).toHaveLength(2)
  })
  it('crea clave aleatoria y guarda solo hash con auditoría', async () => {
    const res = await call(create)
    expect(res.status).toBe(201)
    const data = (await res.json()) as { key: string; id: string }
    expect(data.key).toMatch(/^sbx_[a-f0-9]{64}$/)
    const row = sqlite.prepare('SELECT * FROM b2b_public_keys WHERE id=?').get(data.id)!
    expect(JSON.stringify(row)).not.toContain(data.key)
    expect(sqlite.prepare('SELECT action FROM b2b_public_admin_audit').get()).toMatchObject({ action: 'create' })
  })
  it('rechaza sin sesión', async () => expect((await call(create, { cookie: '' })).status).toBe(401))
  it('rechaza origen cruzado', async () =>
    expect((await call(create, { origin: 'https://evil.invalid' })).status).toBe(403))
  it('un fallo de base de datos no se presenta como conflicto de versión', async () => {
    const failing = {
      ...database,
      batch: async () => {
        throw new Error('database unavailable')
      }
    } as D1Database
    const request = new Request('https://shop.invalid/api/admin/b2b-public/keys', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(create)
    })
    const response = await handleB2bPublicAdmin(request, {
      database: failing,
      sessionCookieConfiguration: config,
      origin: 'https://shop.invalid',
      now
    })
    expect(response?.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
  })
  it('la auditoría no permite reemplazo destructivo', async () => {
    await call(create)
    expect(() =>
      sqlite.exec(`INSERT OR REPLACE INTO b2b_public_admin_audit SELECT * FROM b2b_public_admin_audit`)
    ).toThrow()
    expect(() =>
      sqlite.exec(`INSERT OR REPLACE INTO b2b_public_admin_commands SELECT * FROM b2b_public_admin_commands`)
    ).toThrow()
  })
  it('la escritura usa el reloj de la base y no concede una sesión ya expirada allí', async () => {
    const dbTime = (
      sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS instant").get() as { instant: string }
    ).instant
    const dbMs = Date.parse(dbTime)
    const iso = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const workerTime = dbMs - 120000
    sqlite
      .prepare('UPDATE auth_sessions SET created_at=?,expires_at=? WHERE id=?')
      .run(iso(workerTime - 60000), iso(dbMs - 60000), session)
    sqlite.prepare('UPDATE identities SET email_verified_at=? WHERE id=?').run(iso(workerTime - 60000), identity)
    sqlite.prepare('UPDATE identity_roles SET granted_at=? WHERE identity_id=?').run(iso(workerTime - 60000), identity)
    vi.setSystemTime(workerTime)
    cookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      config
    ))!
    const req = new Request('https://shop.invalid/api/admin/b2b-public/keys', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(create)
    })
    const response = await handleB2bPublicAdmin(req, {
      database,
      sessionCookieConfiguration: config,
      origin: 'https://shop.invalid'
    })
    expect(response?.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 0 })
  })
  it('si la cookie caduca antes del lote no emite ni audita', async () => {
    const shortConfig = { ...config, maxAgeSeconds: 1 }
    const shortCookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      shortConfig
    ))!
    let advanced = false
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('SELECT payload_hash,key_id,action FROM b2b_public_admin_commands')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async first() {
                const row = await bound.first()
                if (!advanced) {
                  advanced = true
                  vi.advanceTimersByTime(2000)
                }
                return row
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const req = new Request('https://shop.invalid/api/admin/b2b-public/keys', {
      method: 'POST',
      headers: {
        cookie: shortCookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(create)
    })
    const response = await handleB2bPublicAdmin(req, {
      database: guarded,
      sessionCookieConfiguration: shortConfig,
      origin: 'https://shop.invalid',
      now
    })
    expect(response?.status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
  })
  it('no escribe si la cookie ha expirado según el reloj de D1', async () => {
    const dbTime = (
      sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS instant").get() as { instant: string }
    ).instant
    const dbMs = Date.parse(dbTime)
    const iso = (n: number) => new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const workerTime = dbMs - 2000
    sqlite
      .prepare('UPDATE auth_sessions SET created_at=?,expires_at=? WHERE id=?')
      .run(iso(workerTime - 60000), iso(dbMs + 3600000), session)
    sqlite.prepare('UPDATE identities SET email_verified_at=? WHERE id=?').run(iso(workerTime - 60000), identity)
    sqlite.prepare('UPDATE identity_roles SET granted_at=? WHERE identity_id=?').run(iso(workerTime - 60000), identity)
    vi.setSystemTime(workerTime)
    const shortConfig = { ...config, maxAgeSeconds: 1 }
    const shortCookie = (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId: session, sessionVersion: 1 },
      shortConfig
    ))!
    const req = new Request('https://shop.invalid/api/admin/b2b-public/keys', {
      method: 'POST',
      headers: {
        cookie: shortCookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(create)
    })
    const response = await handleB2bPublicAdmin(req, {
      database,
      sessionCookieConfiguration: shortConfig,
      origin: 'https://shop.invalid'
    })
    expect(response?.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
  })
  it('requiere MFA viva', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    expect((await call(create)).status).toBe(403)
  })
  it('requiere permiso vivo', async () => {
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
    expect((await call(create)).status).toBe(403)
  })
  it('las claves live exigen empresa aprobada y pierden acceso al suspenderla', async () => {
    expect((await call({ ...create, environment: 'live' })).status).toBe(422)
    const result = await call({ ...create, environment: 'live', companyId })
    expect(result.status).toBe(201)
    const data = (await result.json()) as { key: string }
    const apiRequest = () =>
      new Request('https://shop.invalid/api/b2b/v1/requests', { headers: { authorization: `Bearer ${data.key}` } })
    expect((await handleB2bPublicApi(apiRequest(), { database, now }))?.status).toBe(200)
    sqlite.prepare(`UPDATE companies SET status='suspended' WHERE id=?`).run(companyId)
    expect((await handleB2bPublicApi(apiRequest(), { database, now }))?.status).toBe(401)
  })
  it('no emite ni audita si la empresa se suspende antes del lote', async () => {
    const original = database
    database = {
      ...original,
      async batch(statements: D1PreparedStatement[]) {
        sqlite.prepare(`UPDATE companies SET status='suspended' WHERE id=?`).run(companyId)
        return original.batch(statements)
      }
    } as D1Database
    const response = await call({ ...create, environment: 'live', companyId })
    expect(response.status).toBe(409)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 0 })
  })
  it('no emite ni audita si se revoca el permiso antes del lote', async () => {
    const original = database
    database = {
      ...original,
      async batch(statements: D1PreparedStatement[]) {
        sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
        return original.batch(statements)
      }
    } as D1Database
    const response = await call(create)
    expect(response.status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 0 })
  })
  it('rechaza emitir clave live para empresa no aprobada', async () => {
    sqlite.prepare(`UPDATE companies SET status='suspended' WHERE id=?`).run(companyId)
    expect((await call({ ...create, environment: 'live', companyId })).status).toBe(409)
  })
  it('rechaza scopes desconocidos', async () =>
    expect((await call({ ...create, scopes: ['orders.write'] })).status).toBe(422))
  it('rechaza cuota fuera de límites', async () => expect((await call({ ...create, quotaDaily: 0 })).status).toBe(422))
  it('requiere identificador de comando', async () => expect((await call(create, { command: '' })).status).toBe(400))
  it('repite comando sin emitir otra clave ni revelar secreto otra vez', async () => {
    const first = (await (await call(create)).json()) as { id: string }
    const retry = await call(create)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ id: first.id, key: null })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 1 })
  })
  it('creaciones concurrentes con el mismo comando emiten una sola clave', async () => {
    const responses = await Promise.all([call(create), call(create)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      id: string
      key: string | null
    }>
    expect(bodies[0]?.id).toBe(bodies[1]?.id)
    expect(bodies.filter((body) => body.key !== null)).toHaveLength(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_keys').get()).toMatchObject({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 1 })
  })
  it('dos revocaciones concurrentes con la misma versión no se pisan', async () => {
    const { id } = (await (await call(create)).json()) as { id: string }
    const revokeInput = { action: 'revoke', id, expectedVersion: 1 }
    const responses = await Promise.all([
      call(revokeInput, { command: '22222222-2222-4222-8222-222222222222' }),
      call(revokeInput, { command: '33333333-3333-4333-8333-333333333333' })
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
  it('detecta conflicto idempotente', async () => {
    await call(create)
    expect((await call({ ...create, quotaDaily: 21 })).status).toBe(409)
  })
  it('revoca con CAS y deja auditoría', async () => {
    const { id } = (await (await call(create)).json()) as { id: string }
    const res = await call(
      { action: 'revoke', id, expectedVersion: 1 },
      { command: '22222222-2222-4222-8222-222222222222' }
    )
    expect(res.status).toBe(200)
    expect(sqlite.prepare('SELECT status,version FROM b2b_public_keys WHERE id=?').get(id)).toMatchObject({
      status: 'revoked',
      version: 2
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
  it('no acepta otra revocación con versión antigua ni añade auditoría', async () => {
    const { id } = (await (await call(create)).json()) as { id: string }
    const input = { action: 'revoke', id, expectedVersion: 1 }
    expect((await call(input, { command: '22222222-2222-4222-8222-222222222222' })).status).toBe(200)
    expect((await call(input, { command: '33333333-3333-4333-8333-333333333333' })).status).toBe(409)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_admin_audit').get()).toMatchObject({ n: 2 })
  })
  it('rechaza versión obsoleta', async () => {
    const { id } = (await (await call(create)).json()) as { id: string }
    const res = await call(
      { action: 'revoke', id, expectedVersion: 2 },
      { command: '22222222-2222-4222-8222-222222222222' }
    )
    expect(res.status).toBe(409)
  })
})
