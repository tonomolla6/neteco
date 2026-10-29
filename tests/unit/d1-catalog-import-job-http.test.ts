import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCatalogImportJobHttp, ownsCatalogImportJobNamespace } from '../../workers/catalog/import-job-http'

const actor = '00550000-0000-4000-8000-000000000001',
  session = '00550000-0000-4000-8000-000000000002',
  warehouse = '00550000-0000-4000-8000-000000000003'
const origin = 'https://jobs.example.invalid',
  prefix = '/api/admin/catalog/import-jobs'
const password = 'synthetic-job-http-session-password'.repeat(2)
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
type Environment = Parameters<typeof handleCatalogImportJobHttp>[1]
describe('private full catalog job HTTP staging boundary', () => {
  let sqlite: DatabaseSync, database: D1Database, env: Environment, cookie: string
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_import_jobs'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0055_catalog_import_jobs.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'HTTP-JOB','Supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare("INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,55,'Category','job-http','published')")
      .run(ids.category)
    sqlite.prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Brand','job-http','published')").run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'HTTP-JOB','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'HTTP-JOB','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'HTTP-JOB','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'job-http@example.invalid','unusable-synthetic',?,'active',?,?)"
      )
      .run(actor, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('job-http','Importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('job-http',?)").run(`${resource}.${action}`)
    }
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'job-http',?)")
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
  const record = () => ({
    ...catalogRecord(),
    inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }])
  })
  function request(
    path = '',
    method = 'POST',
    body: unknown = { totalPages: 1, recordCount: 1 },
    headers: Record<string, string> = {}
  ) {
    return new Request(origin + prefix + path, {
      method,
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': 'create-job', ...headers },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) })
    })
  }
  const call = async (req: Request, environment = env) => (await handleCatalogImportJobHttp(req, environment))!
  async function fail(req: Request, code: string, status: number, environment = env) {
    const response = await call(req, environment)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return response
  }
  async function create() {
    const response = await call(request())
    expect(response.status).toBe(200)
    const job = (await response.json()) as { id: string; status: string }
    expect(job.status).toBe('uploading')
    return job
  }
  it('owns encoded/mixed-case namespace attempts and rejects strict paths, methods and query strings', async () => {
    expect(ownsCatalogImportJobNamespace('/api/products')).toBe(false)
    expect(await handleCatalogImportJobHttp(new Request(origin + '/api/products'), env)).toBeNull()
    for (const path of [
      '/API/ADMIN/CATALOG/IMPORT-JOBS',
      '/api/admin/catalog/%69mport-jobs',
      '/api/admin/catalog/import-jobs-extra'
    ])
      await fail(new Request(origin + path), 'invalid_input', 400)
    for (const path of [
      '/not-a-uuid',
      `/${session}/pages/01`,
      `/${session}/pages/-1`,
      `/${session}/pages/1000`,
      // /:id/apply is now canonical; an extra segment remains invalid.
      // Strict command-body extras are covered by the command HTTP suite.
      `/${session}/apply/extra`,
      '/'
    ])
      await fail(request(path), 'invalid_input', 400)
    const response = await fail(request('', 'GET'), 'method_not_allowed', 405)
    expect(response.headers.get('allow')).toBe('POST')
    await fail(request(`/${session}/pages/0`, 'POST'), 'method_not_allowed', 405)
    await fail(request('?now=2099-01-01'), 'invalid_input', 400)
  })
  it('requires create idempotency and signed live MFA/email/cookie authentication', async () => {
    const noKey = request()
    noKey.headers.delete('idempotency-key')
    await fail(noKey, 'invalid_idempotency_key', 400)
    await fail(request('', 'POST', undefined, { 'idempotency-key': 'invalid key' }), 'invalid_idempotency_key', 400)
    await fail(request('', 'POST', undefined, { cookie: '' }), 'unauthenticated', 401)
    await fail(request('', 'POST', undefined, { cookie: 'neteco-session=forged' }), 'unauthenticated', 401)
    await fail(request(), 'service_unavailable', 503, { ...env, AUTH_ENABLED: 'false' })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
    await fail(request(), 'mfa_required', 403)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(session)
    sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(actor)
    await fail(request(), 'email_unverified', 403)
  })
  it('enforces write-origin CSRF but permits authenticated GET without Origin', async () => {
    await fail(request('', 'POST', undefined, { origin: 'https://attacker.invalid' }), 'csrf_rejected', 403)
    const noOrigin = request()
    noOrigin.headers.delete('origin')
    await fail(noOrigin, 'csrf_rejected', 403)
    const job = await create(),
      get = request('/' + job.id, 'GET')
    get.headers.delete('origin')
    expect((await call(get)).status).toBe(200)
    await fail(
      request(
        '/' + job.id + '/pages/0',
        'PUT',
        { index: 0, records: [record()] },
        { origin: 'https://attacker.invalid' }
      ),
      'csrf_rejected',
      403
    )
    await fail(
      request('/' + job.id + '/seal', 'POST', { reason: 'Approved' }, { 'sec-fetch-site': 'cross-site' }),
      'csrf_rejected',
      403
    )
  })
  it('creates, replays, uploads, replays, seals and reads owner-private jobs without domain mutations', async () => {
    const job = await create()
    expect(await (await call(request())).json()).toEqual(await (await call(request('/' + job.id, 'GET'))).json())
    const page = () => request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] })
    const first = await call(page()),
      staged = await first.json()
    expect(first.status).toBe(200)
    expect(staged).toMatchObject({ receivedPages: 1, status: 'uploading' })
    expect(await (await call(page())).json()).toEqual(staged)
    const sealed = await call(request('/' + job.id + '/seal', 'POST', { reason: 'Whole job approved' }))
    expect(sealed.status).toBe(200)
    expect(await sealed.json()).toMatchObject({
      status: 'ready',
      counts: { products: 1, variants: 1, assets: 1, mappings: 1 }
    })
    expect(sqlite.prepare('SELECT count(*) count FROM products').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) count FROM inventory_movements').get()).toEqual({ count: 0 })
    for (const [key, value] of Object.entries({
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }))
      expect(sealed.headers.get(key)).toBe(value)
  })
  it.each(['catalog.write', 'administration.manage', 'inventory.write'])(
    'rechecks%s after create and before read/page/seal/replay',
    async (permission) => {
      const job = await create()
      sqlite.prepare('DELETE FROM role_permissions WHERE permission_code=?').run(permission)
      await fail(request(), 'forbidden', 403)
      await fail(request('/' + job.id, 'GET'), 'forbidden', 403)
      await fail(request('/' + job.id + '/review', 'GET'), 'forbidden', 403)
      await fail(request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] }), 'forbidden', 403)
      await fail(request('/' + job.id + '/seal', 'POST', { reason: 'Approved' }), 'forbidden', 403)
    }
  )
  it('denies access to another importer job instead of exposing page or source evidence', async () => {
    const job = await create(),
      other = '00550000-0000-4000-8000-000000000011',
      otherSession = '00550000-0000-4000-8000-000000000012'
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'other@example.invalid','synthetic',?,'active',?,?)"
      )
      .run(other, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'job-http',?)")
      .run(other, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(otherSession, other, utc(-86400_000), utc(7200_000))
    const otherCookie = (await issueD1SessionCookie(
      database,
      { identityId: other, sessionId: otherSession, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    await fail(request('/' + job.id, 'GET', undefined, { cookie: otherCookie }), 'not_found', 404)
    await fail(request('/' + job.id + '/review', 'GET', undefined, { cookie: otherCookie }), 'not_found', 404)
    await fail(
      request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] }, { cookie: otherCookie }),
      'not_found',
      404
    )
  })
  it('rejects missing fields/extras/client clock, mismatched URL index, wrong JSON and raw UTF8/size violations', async () => {
    for (const value of [{ totalPages: 1 }, { recordCount: 1 }, { totalPages: 1, recordCount: 1, now: utc() }])
      await fail(request('', 'POST', value), 'invalid_input', 422)
    await fail(request('', 'POST', undefined, { 'content-type': 'text/plain' }), 'json_required', 415)
    await fail(request('', 'POST', undefined, { 'content-length': '4097' }), 'body_too_large', 413)
    const job = await create()
    await fail(request('/' + job.id + '/pages/0', 'PUT', { index: 1, records: [record()] }), 'invalid_input', 422)
    await fail(request('/' + job.id + '/pages/0', 'PUT', { index: 0 }), 'invalid_input', 422)
    await fail(request('/' + job.id + '/seal', 'POST', { reason: 'Approved', now: utc() }), 'invalid_input', 422)
    const raw = (bytes: Uint8Array) =>
      new Request(origin + prefix + '/' + job.id + '/pages/0', {
        method: 'PUT',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: bytes
      })
    await fail(raw(new Uint8Array([0xff])), 'invalid_json', 400)
    await fail(raw(new TextEncoder().encode('{')), 'invalid_json', 400)
    await fail(raw(new Uint8Array(900033)), 'body_too_large', 413)
    await fail(request('/' + job.id + '/seal', 'POST', { reason: 'x'.repeat(5000) }), 'body_too_large', 413)
  })
  it('uses separate bounded create/seal and page quotas so a30-write create ceiling does not stop50 pages', async () => {
    const job = await create()
    const quota = sqlite.prepare('SELECT scope FROM identity_rate_limits WHERE identity_id=?').get(actor) as {
      scope: string
    }
    sqlite.prepare('UPDATE identity_rate_limits SET used=30 WHERE identity_id=? AND scope=?').run(actor, quota.scope)
    const denied = await fail(request(), 'rate_limited', 429)
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await call(request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] }))).status).toBe(200)
    expect((await call(request('/' + job.id, 'GET'))).status).toBe(200)
  })
  it('maps conflicts and sanitizes unexpected backend outages as500 without SQL or source values', async () => {
    await create()
    await fail(request('', 'POST', { totalPages: 2, recordCount: 2 }), 'idempotency_conflict', 409)
    const broken = {
      ...database,
      prepare: () => {
        throw new Error('SELECT PRIVATE_SECRET FROM PRIVATE_TABLE')
      }
    } as D1Database
    await fail(request(), 'service_unavailable', 500, { ...env, DB: broken })
  })

  it('does not classify incidental UNIQUE text in a provider outage as a known catalog conflict', async () => {
    const job = await create()
    let batches = 0
    const broken = {
      ...database,
      batch: async (statements: D1PreparedStatement[]) => {
        batches++
        if (batches === 2)
          throw new Error(
            'Provider offline; UNIQUE constraint failed: catalog_import_job_entries.job_id, catalog_import_job_entries.kind, catalog_import_job_entries.item_id PRIVATE_SOURCE'
          )
        return database.batch(statements)
      }
    } as D1Database
    await fail(
      request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] }),
      'service_unavailable',
      500,
      { ...env, DB: broken }
    )
    expect(batches).toBe(2)
    expect(sqlite.prepare('SELECT count(*) count FROM catalog_import_job_pages').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT count(*) count FROM catalog_import_job_entries').get()).toEqual({ count: 0 })
  })
  it('cancels stalled streaming bodies at the deadline', async () => {
    const cancel = vi.fn(),
      stream = new ReadableStream<Uint8Array>({ cancel })
    const req = new Request(origin + prefix, {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': 'stream' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = call(req)
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(8001)
    const response = await result
    expect(response.status).toBe(408)
    expect(cancel).toHaveBeenCalled()
  })

  it('reviews only sealed jobs with private defaults and strict bounded nonduplicated query parameters', async () => {
    const job = await create()
    await fail(request('/' + job.id + '/review', 'GET'), 'version_conflict', 409)
    await call(request('/' + job.id + '/pages/0', 'PUT', { index: 0, records: [record()] }))
    await call(request('/' + job.id + '/seal', 'POST', { reason: 'Reviewed whole job' }))
    const noOrigin = request('/' + job.id + '/review', 'GET')
    noOrigin.headers.delete('origin')
    const result = await call(noOrigin),
      review = await result.json()
    expect(result.status).toBe(200)
    expect(review).toMatchObject({
      source: 'cloudflare',
      outcome: 'review',
      jobId: job.id,
      offset: 0,
      nextOffset: null,
      totalEntries: 4,
      entries: expect.any(Array)
    })
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    const partial = await (await call(request('/' + job.id + '/review?offset=1&limit=1', 'GET'))).json()
    expect(partial).toMatchObject({ offset: 1, nextOffset: 2, entries: expect.any(Array) })
    for (const query of [
      'offset=-1',
      'offset=01',
      'offset=100001',
      'offset=1.5',
      'offset=',
      'offset=0&offset=0',
      'limit=0',
      'limit=51',
      'limit=01',
      'limit=1&limit=1',
      'unknown=1',
      'now=2099'
    ])
      await fail(request('/' + job.id + '/review?' + query, 'GET'), 'invalid_input', 400)
    await fail(request('/' + job.id + '/review', 'POST'), 'method_not_allowed', 405)
    await fail(request('/' + job.id + '/review', 'GET', undefined, { cookie: '' }), 'unauthenticated', 401)
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
    await fail(request('/' + job.id + '/review', 'GET'), 'unauthenticated', 401)
  })
})
