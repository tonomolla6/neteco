import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { pinSqlClock } from '../support/independent-sql-clock'
import { handleDeveloperOwnership } from '../../workers/developer-platform/ownership-http'

const now = '2026-10-29T10:00:00Z'
const identity = '10000000-0000-4000-8000-000000000001'
const session = '20000000-0000-4000-8000-000000000001'
const config = { password: 'a'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string
async function read() {
  return (await handleDeveloperOwnership(
    new Request('https://shop.invalid/api/admin/developer-platform/ownership', { headers: { cookie } }),
    { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
  ))!
}
async function write(body: unknown, command = '11111111-1111-4111-8111-111111111111', cookieValue = cookie) {
  return (await handleDeveloperOwnership(
    new Request('https://shop.invalid/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: {
        cookie: cookieValue,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': command
      },
      body: JSON.stringify(body)
    }),
    { database, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
  ))!
}
const command = { serviceId: 'catalog', owner: 'platform.catalog', expectedVersion: 0 }
describe('CIC-034: ownership persistente', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0121_b2b_public_api.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?, 'admin@test.invalid','x',?,'active',?,?)`
      )
      .run(identity, now, now, now)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,'2026-10-29T11:00:00Z')`
      )
      .run(session, identity, now)
    sqlite.exec(
      `INSERT INTO roles VALUES ('dev-admin','Admin','fixture'); INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO role_permissions VALUES ('dev-admin','administration.manage')`
    )
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'dev-admin',?)`)
      .run(identity, now)
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
  it('parte vacío y registra responsable con versión y auditoría', async () => {
    expect(await (await read()).json()).toMatchObject({ items: [] })
    expect((await write(command)).status).toBe(200)
    expect(await (await read()).json()).toMatchObject({
      items: [{ serviceId: 'catalog', owner: 'platform.catalog', version: 1 }]
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 1 })
  })
  it('requiere sesión y permiso vivo', async () => {
    expect((await write(command, '11111111-1111-4111-8111-111111111111', '')).status).toBe(401)
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
    expect((await read()).status).toBe(403)
  })
  it('la escritura usa el reloj de la base y no concede una sesión ya expirada allí', async () => {
    const dbTime = (
      sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS instant").get() as { instant: string }
    ).instant
    pinSqlClock(sqlite, dbTime)
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
    const req = new Request('https://shop.invalid/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(command)
    })
    const response = await handleDeveloperOwnership(req, {
      database,
      sessionCookieConfiguration: config,
      origin: 'https://shop.invalid'
    })
    expect(response?.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 0 })
  })
  it('si la cookie caduca antes de la escritura no cambia ownership', async () => {
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
        if (!sql.includes('SELECT payload_hash,service_id,owner,version,created_at')) return statement
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
    const req = new Request('https://shop.invalid/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: {
        cookie: shortCookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(command)
    })
    const response = await handleDeveloperOwnership(req, {
      database: guarded,
      sessionCookieConfiguration: shortConfig,
      origin: 'https://shop.invalid',
      now
    })
    expect(response?.status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 0 })
  })
  it('no escribe si la cookie ha expirado según el reloj de D1', async () => {
    const dbTime = (
      sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS instant").get() as { instant: string }
    ).instant
    pinSqlClock(sqlite, dbTime)
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
    const req = new Request('https://shop.invalid/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: {
        cookie: shortCookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(command)
    })
    const response = await handleDeveloperOwnership(req, {
      database,
      sessionCookieConfiguration: shortConfig,
      origin: 'https://shop.invalid'
    })
    expect(response?.status).toBe(503)
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 0 })
  })
  it('requiere MFA', async () => {
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    expect((await write(command)).status).toBe(403)
  })
  it('repite comando sin duplicar auditoría', async () => {
    const first = await (await write(command)).json()
    expect(await (await write(command)).json()).toEqual(first)
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 1 })
  })
  it('rechaza contenido distinto para el mismo comando', async () => {
    await write(command)
    expect((await write({ ...command, owner: 'another.team' })).status).toBe(409)
  })
  it('usa CAS para evitar pérdida por escritura concurrente', async () => {
    await write(command)
    const other = '22222222-2222-4222-8222-222222222222'
    expect((await write({ ...command, owner: 'other.team' }, other)).status).toBe(409)
    expect((await write({ ...command, owner: 'other.team', expectedVersion: 1 }, other)).status).toBe(200)
    expect(await (await read()).json()).toMatchObject({ items: [{ owner: 'other.team', version: 2 }] })
  })
  it('dos cambios concurrentes de la misma versión no se pisan', async () => {
    const outcomes = await Promise.all([
      write(command),
      write({ ...command, owner: 'ops.catalog' }, '22222222-2222-4222-8222-222222222222')
    ])
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409])
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 1 })
  })
  it('retirar permiso antes de escribir impide el comando y su auditoría', async () => {
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('INSERT INTO developer_ownership_commands')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async first() {
                sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
                return bound.first()
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const request = new Request('https://shop.invalid/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://shop.invalid',
        'content-type': 'application/json',
        'idempotency-key': '11111111-1111-4111-8111-111111111111'
      },
      body: JSON.stringify(command)
    })
    expect(
      (
        await handleDeveloperOwnership(request, {
          database: guarded,
          sessionCookieConfiguration: config,
          origin: 'https://shop.invalid',
          now
        })
      )?.status
    ).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM developer_ownership_audit').get()).toMatchObject({ n: 0 })
  })
  it('retirar permiso durante la lectura impide entregar datos', async () => {
    await write(command)
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('SELECT service_id AS serviceId')) return statement
        return {
          bind: statement.bind,
          async all() {
            const result = await statement.all()
            sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(identity)
            return result
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleDeveloperOwnership(
      new Request('https://shop.invalid/api/admin/developer-platform/ownership', { headers: { cookie } }),
      { database: guarded, sessionCookieConfiguration: config, origin: 'https://shop.invalid', now }
    )
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('platform.catalog')
  })
  it('no entrega responsables si la sesión expira durante la lectura', async () => {
    await write(command)
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('SELECT service_id AS serviceId')) return statement
        return {
          async all() {
            const result = await statement.all()
            vi.setSystemTime(new Date('2026-10-29T11:00:00Z'))
            return result
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleDeveloperOwnership(
      new Request('https://shop.invalid/api/admin/developer-platform/ownership', { headers: { cookie } }),
      { database: guarded, sessionCookieConfiguration: config, origin: 'https://shop.invalid' }
    )
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('platform.catalog')
  })
  it('no entrega responsables si caduca la cookie durante la consulta', async () => {
    await write(command)
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
        if (!sql.includes('SELECT service_id AS serviceId')) return statement
        return {
          async all() {
            const result = await statement.all()
            vi.advanceTimersByTime(2000)
            return result
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleDeveloperOwnership(
      new Request('https://shop.invalid/api/admin/developer-platform/ownership', { headers: { cookie: shortCookie } }),
      { database: guarded, sessionCookieConfiguration: shortConfig, origin: 'https://shop.invalid' }
    )
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('platform.catalog')
  })
  it.each([
    { ...command, serviceId: 'unknown' },
    { ...command, owner: 'Private Person' },
    { ...command, owner: '' },
    { ...command, expectedVersion: -1 },
    { ...command, extra: 1 }
  ])('valida datos estrictos %#', async (input) => expect((await write(input)).status).toBe(422))
  it('requiere un identificador de comando UUID', async () => expect((await write(command, 'bad')).status).toBe(400))
  it('impide borrar, modificar o reemplazar auditoría', async () => {
    await write(command)
    expect(() => sqlite.exec('DELETE FROM developer_ownership_audit')).toThrow()
    expect(() => sqlite.exec('UPDATE developer_ownership_audit SET owner=owner')).toThrow()
    expect(() =>
      sqlite.exec('INSERT OR REPLACE INTO developer_ownership_audit SELECT * FROM developer_ownership_audit')
    ).toThrow()
  })
})
