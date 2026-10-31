import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  handleB2bPublicApi,
  ownsB2bPublicApiNamespace,
  resetB2bSandbox
} from '../../workers/developer-platform/b2b-public-api'

const secret = 'sbx_' + 'a'.repeat(64)
const second = 'sbx_' + 'b'.repeat(64)
const live = 'live_' + 'c'.repeat(64)
const hash = (key: string) => createHash('sha256').update(key).digest('hex')
let sqlite: DatabaseSync
let database: D1Database
let now = '2026-10-29T10:00:00Z'
function request(path: string, options: { key?: string; method?: string; body?: unknown; command?: string } = {}) {
  const headers = new Headers()
  if (options.key) headers.set('authorization', `Bearer ${options.key}`)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.command) headers.set('idempotency-key', options.command)
  return new Request(`https://shop.invalid${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
}
async function call(path: string, options: Parameters<typeof request>[1] = {}) {
  return (await handleB2bPublicApi(request(path, options), { database, now }))!
}
const send = (key = secret, command = 'c1', body: unknown = { reference: 'demo' }) =>
  call('/api/b2b/v1/requests', { key, method: 'POST', body, command })

describe('INT-020 / CIC-032 API B2B aislada', () => {
  beforeEach(async () => {
    now = '2026-10-29T10:00:00Z'
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0121_b2b_public_api.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    sqlite.prepare(`INSERT INTO customers(id,created_at,updated_at) VALUES ('customer-a',?,?)`).run(now, now)
    sqlite
      .prepare(
        `INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES ('company-a','customer-a','Synthetic','approved',?,?)`
      )
      .run(now, now)
    const insert = sqlite.prepare(`INSERT INTO b2b_public_keys
      (id, key_hash, environment, company_id, scopes, quota_daily, status, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?)`)
    insert.run('a', hash(secret), 'sandbox', null, 'requests.read requests.write', 100, now)
    insert.run('b', hash(second), 'sandbox', null, 'requests.read requests.write', 100, now)
    insert.run('c', hash(live), 'live', 'company-a', 'requests.read requests.write', 100, now)
  })
  afterEach(() => sqlite.close())
  it('reserva el espacio de nombres versionado', () => {
    expect(ownsB2bPublicApiNamespace('/api/b2b/v1/requests')).toBe(true)
    expect(ownsB2bPublicApiNamespace('/api/b2b/v2/requests')).toBe(true)
    expect(ownsB2bPublicApiNamespace('/api/b2b-other')).toBe(false)
    expect(ownsB2bPublicApiNamespace('/api/b2b%2fv1/requests')).toBe(true)
    expect(ownsB2bPublicApiNamespace('/API/B2B/v1/requests')).toBe(true)
  })
  it('publica el contrato OpenAPI versionado sin credenciales', async () => {
    const response = await call('/api/b2b/v1/openapi.json')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: '3.0.3', info: { version: '1.0.0' } })
  })
  it('rechaza ausencia de credenciales', async () => expect((await call('/api/b2b/v1/requests')).status).toBe(401))
  it('rechaza credenciales desconocidas', async () =>
    expect((await call('/api/b2b/v1/requests', { key: 'x' })).status).toBe(401))
  it('rechaza una clave revocada', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET status='revoked', version=version+1 WHERE id='a'").run()
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(401)
  })
  it('exige scope de lectura', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET scopes='requests.write', version=version+1 WHERE id='a'").run()
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(403)
  })
  it('exige scope de escritura', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET scopes='requests.read', version=version+1 WHERE id='a'").run()
    expect((await send()).status).toBe(403)
  })
  it('crea una solicitud y permite consultarla', async () => {
    expect((await send()).status).toBe(201)
    const result = await call('/api/b2b/v1/requests', { key: secret })
    expect(await result.json()).toMatchObject({ items: [{ reference: 'demo', version: 1 }] })
  })
  it('aísla clientes sandbox', async () => {
    await send()
    expect(await (await call('/api/b2b/v1/requests', { key: second })).json()).toMatchObject({ items: [] })
  })
  it('aísla live y sandbox', async () => {
    await send()
    expect(await (await call('/api/b2b/v1/requests', { key: live })).json()).toMatchObject({ items: [] })
  })
  it('permite recorrer referencias propias en páginas acotadas', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO b2b_public_requests(id,key_id,generation,command_id,payload_hash,reference,version,created_at) VALUES (?,?,?,?,?,?,1,?)`
    )
    for (let i = 0; i < 105; i++)
      insert.run(`id-${String(i).padStart(3, '0')}`, 'a', '2026-10-29', `cmd-${i}`, 'a'.repeat(64), `ref-${i}`, now)
    const first = await call('/api/b2b/v1/requests?page=1', { key: secret })
    const secondPage = await call('/api/b2b/v1/requests?page=2', { key: secret })
    expect(((await first.json()) as { items: unknown[] }).items).toHaveLength(100)
    expect(((await secondPage.json()) as { items: unknown[] }).items).toHaveLength(5)
  })
  it.each(['0', '1e2', '1001', '2.5'])('rechaza página inválida %s', async (page) => {
    expect((await call(`/api/b2b/v1/requests?page=${page}`, { key: secret })).status).toBe(400)
  })
  it('rechaza parámetros de página duplicados o desconocidos', async () => {
    expect((await call('/api/b2b/v1/requests?page=1&page=2', { key: secret })).status).toBe(400)
    expect((await call('/api/b2b/v1/catalog?search=foo', { key: live })).status).toBe(400)
  })
  it('no escribe si se suspende la empresa antes de la sentencia', async () => {
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('INSERT INTO b2b_public_requests')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async first() {
                sqlite.prepare("UPDATE companies SET status='suspended' WHERE id='company-a'").run()
                return bound.first()
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleB2bPublicApi(
      request('/api/b2b/v1/requests', { key: live, method: 'POST', body: { reference: 'demo' }, command: 'race' }),
      { database: guarded, now }
    )
    expect(response?.status).toBe(401)
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_requests').get()).toMatchObject({ n: 0 })
  })
  it('no entrega resultados si se suspende la empresa durante la lectura', async () => {
    await send(live)
    const guarded = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('SELECT id,reference,version,created_at FROM b2b_public_requests')) return statement
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            return {
              async all() {
                const result = await bound.all()
                sqlite.prepare("UPDATE companies SET status='suspended' WHERE id='company-a'").run()
                return result
              }
            }
          }
        } as unknown as D1PreparedStatement
      }
    } as D1Database
    const response = await handleB2bPublicApi(request('/api/b2b/v1/requests', { key: live }), {
      database: guarded,
      now
    })
    expect(response?.status).toBe(401)
    expect(await response?.text()).not.toContain('demo')
  })
  it('no revela credenciales ni hash en la respuesta', async () => {
    const result = await (await send()).text()
    expect(result).not.toContain(secret)
    expect(result).not.toContain(hash(secret))
  })
  it('reproduce el mismo comando sin duplicarlo', async () => {
    const first = await send()
    const replay = await send()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_requests').get()).toMatchObject({ n: 1 })
  })
  it('rechaza reutilizar comando con otro contenido', async () => {
    await send()
    expect((await send(secret, 'c1', { reference: 'otro' })).status).toBe(409)
  })
  it('requiere idempotencia', async () => {
    expect((await call('/api/b2b/v1/requests', { key: secret, method: 'POST', body: { reference: 'x' } })).status).toBe(
      400
    )
  })
  it.each(['', 'a'.repeat(129), 'con espacio'])('rechaza comando inválido %s', async (command) => {
    expect((await send(secret, command)).status).toBe(400)
  })
  it.each([{ reference: '' }, { reference: 'a'.repeat(101) }, { reference: 'a', extra: true }, {}])(
    'rechaza payload inválido %#',
    async (body) => {
      expect((await send(secret, 'c2', body)).status).toBe(422)
    }
  )
  it.each(['person@example.invalid', 'nombre y apellidos', '<script>'])(
    'rechaza referencias que no son identificadores %s',
    async (reference) => {
      expect((await send(secret, 'invalid-reference', { reference })).status).toBe(422)
    }
  )
  it('aplica cuota persistente por clave', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET quota_daily=1, version=version+1 WHERE id='a'").run()
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(200)
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(429)
    expect((await call('/api/b2b/v1/requests', { key: second })).status).toBe(200)
  })
  it('la cuota sigue siendo atómica bajo solicitudes concurrentes', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET quota_daily=1, version=version+1 WHERE id='a'").run()
    const results = await Promise.all([
      call('/api/b2b/v1/requests', { key: secret }),
      call('/api/b2b/v1/requests', { key: secret })
    ])
    expect(results.map((result) => result.status).sort()).toEqual([200, 429])
  })
  it('reinicia automáticamente los datos sandbox al siguiente día UTC', async () => {
    await send()
    now = '2026-10-30T00:00:01Z'
    expect(await (await call('/api/b2b/v1/requests', { key: secret })).json()).toMatchObject({ items: [] })
    expect((await send()).status).toBe(201)
  })
  it('entrega catálogo publicado real a una clave live y solo sintético a sandbox', async () => {
    seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now })
    const liveResult = await call('/api/b2b/v1/catalog', { key: live })
    expect(liveResult.status).toBe(200)
    const liveBody = (await liveResult.json()) as { items: Array<{ name: string }> }
    expect(liveBody.items.map((item) => item.name)).toEqual(['Producto 1'])
    const sandboxResult = await call('/api/b2b/v1/catalog', { key: secret })
    const sandboxBody = await sandboxResult.json() as { items: Array<{ name: string }>; total: number }
    expect(sandboxBody).toMatchObject({ items: [{ name: 'Producto de prueba' }], total: 1 })
    expect(Object.keys(sandboxBody.items[0]!).sort()).toEqual(Object.keys(liveBody.items[0]!).sort())
    const next = await call('/api/b2b/v1/catalog?page=2', { key: secret })
    expect(await next.json()).toEqual({ items: [], total: 1 })
  })
  it('proporciona catálogo sintético sin datos de producción', async () => {
    const response = await call('/api/b2b/v1/sandbox/catalog', { key: secret })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [{ id: 'synthetic-1', name: 'Producto de prueba', slug: 'producto-prueba', priceCents: 1200 }],
      total: 1
    })
  })
  it('una clave live no accede al catálogo sintético', async () => {
    expect((await call('/api/b2b/v1/sandbox/catalog', { key: live })).status).toBe(404)
  })
  it('el mantenimiento retira únicamente generaciones sandbox y cuotas anteriores', async () => {
    await send()
    await send(live)
    await resetB2bSandbox(database, '2026-10-30T00:00:01Z')
    expect(sqlite.prepare('SELECT generation FROM b2b_public_requests').all()).toEqual([{ generation: 'live' }])
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_quota').get()).toMatchObject({ n: 0 })
    await resetB2bSandbox(database, '2026-10-30T00:00:01Z')
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_requests').get()).toMatchObject({ n: 1 })
  })
  it('el esquema impide mezclar generaciones live y sandbox', () => {
    const insert = sqlite.prepare(
      'INSERT INTO b2b_public_requests(id,key_id,generation,command_id,payload_hash,reference,version,created_at) VALUES (?,?,?,?,?,?,1,?)'
    )
    expect(() => insert.run('bad-live', 'c', '2026-10-29', 'cmd-live', 'a'.repeat(64), 'ref', now)).toThrow()
    expect(() => insert.run('bad-sandbox', 'a', 'live', 'cmd-sandbox', 'a'.repeat(64), 'ref', now)).toThrow()
    expect(() => insert.run('bad-day', 'a', '2026-10-28', 'cmd-day', 'a'.repeat(64), 'ref', now)).toThrow()
  })
  it('protege referencias live contra eliminación o reemplazo', async () => {
    await send(live)
    expect(() => sqlite.exec("DELETE FROM b2b_public_requests WHERE generation='live'")).toThrow()
    expect(() =>
      sqlite.exec(
        "INSERT OR REPLACE INTO b2b_public_requests SELECT * FROM b2b_public_requests WHERE generation='live'"
      )
    ).toThrow()
    expect(sqlite.prepare("SELECT count(*) AS n FROM b2b_public_requests WHERE generation='live'").get()).toMatchObject(
      { n: 1 }
    )
  })
  it('no reinicia los datos live cada día', async () => {
    await send(live)
    now = '2026-10-30T00:00:01Z'
    expect(await (await call('/api/b2b/v1/requests', { key: live })).json()).toMatchObject({
      items: [{ reference: 'demo' }]
    })
  })
  it('rechaza rutas o versiones desconocidas sin fallthrough', async () =>
    expect((await call('/api/b2b/v2/requests', { key: secret })).status).toBe(404))
  it('rechaza métodos no admitidos', async () =>
    expect((await call('/api/b2b/v1/requests', { key: secret, method: 'DELETE' })).status).toBe(405))
  it('no cachea respuestas privadas', async () =>
    expect((await call('/api/b2b/v1/requests', { key: secret })).headers.get('cache-control')).toContain('no-store'))
  it('mantiene una única escritura ante comandos concurrentes', async () => {
    const results = await Promise.all([send(), send()])
    expect(results.map((r) => r.status).sort()).toEqual([200, 201])
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_requests').get()).toMatchObject({ n: 1 })
  })
})
