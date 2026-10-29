import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleB2bPublicApi, ownsB2bPublicApiNamespace, resetB2bSandbox } from '../../workers/developer-platform/b2b-public-api'

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
    const insert = sqlite.prepare(`INSERT INTO b2b_public_keys
      (id, key_hash, environment, scopes, quota_daily, status, version, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`)
    insert.run('a', hash(secret), 'sandbox', 'requests.read requests.write', 100, now)
    insert.run('b', hash(second), 'sandbox', 'requests.read requests.write', 100, now)
    insert.run('c', hash(live), 'live', 'requests.read requests.write', 100, now)
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
  it('rechaza credenciales desconocidas', async () => expect((await call('/api/b2b/v1/requests', { key: 'x' })).status).toBe(401))
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
    expect((await call('/api/b2b/v1/requests', { key: secret, method: 'POST', body: { reference: 'x' } })).status).toBe(400)
  })
  it.each(['', 'a'.repeat(129), 'con espacio'])('rechaza comando inválido %s', async (command) => {
    expect((await send(secret, command)).status).toBe(400)
  })
  it.each([{ reference: '' }, { reference: 'a'.repeat(101) }, { reference: 'a', extra: true }, {}])('rechaza payload inválido %#', async (body) => {
    expect((await send(secret, 'c2', body)).status).toBe(422)
  })
  it('aplica cuota persistente por clave', async () => {
    sqlite.prepare("UPDATE b2b_public_keys SET quota_daily=1, version=version+1 WHERE id='a'").run()
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(200)
    expect((await call('/api/b2b/v1/requests', { key: secret })).status).toBe(429)
    expect((await call('/api/b2b/v1/requests', { key: second })).status).toBe(200)
  })
  it('reinicia automáticamente los datos sandbox al siguiente día UTC', async () => {
    await send()
    now = '2026-10-30T00:00:01Z'
    expect(await (await call('/api/b2b/v1/requests', { key: secret })).json()).toMatchObject({ items: [] })
    expect((await send()).status).toBe(201)
  })
  it('proporciona catálogo sintético sin datos de producción', async () => {
    const response = await call('/api/b2b/v1/sandbox/catalog', { key: secret })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [{ id: 'synthetic-1', name: 'Producto de prueba', priceCents: 1200 }] })
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
  it('no reinicia los datos live cada día', async () => {
    await send(live)
    now = '2026-10-30T00:00:01Z'
    expect(await (await call('/api/b2b/v1/requests', { key: live })).json()).toMatchObject({ items: [{ reference: 'demo' }] })
  })
  it('rechaza rutas o versiones desconocidas sin fallthrough', async () => expect((await call('/api/b2b/v2/requests', { key: secret })).status).toBe(404))
  it('rechaza métodos no admitidos', async () => expect((await call('/api/b2b/v1/requests', { key: secret, method: 'DELETE' })).status).toBe(405))
  it('no cachea respuestas privadas', async () => expect((await call('/api/b2b/v1/requests', { key: secret })).headers.get('cache-control')).toContain('no-store'))
  it('mantiene una única escritura ante comandos concurrentes', async () => {
    const results = await Promise.all([send(), send()])
    expect(results.map((r) => r.status).sort()).toEqual([200, 201])
    expect(sqlite.prepare('SELECT count(*) AS n FROM b2b_public_requests').get()).toMatchObject({ n: 1 })
  })
})
