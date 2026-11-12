import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogRecord, catalogFixtureIds as ids } from '../support/catalog-tabular-fixture'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCatalogImportJobHttp } from '../../workers/catalog/import-job-http'
import type { CatalogImportJob } from '../../shared/catalog-import-job'
import { catalogImportJobReceiptSchema } from '../../shared/catalog-import-job-commands'
import { testUuid, testNow } from '../support/deterministic'

const actor = '00570000-0000-4000-8000-000000000101',
  session = '00570000-0000-4000-8000-000000000102',
  warehouse = '00570000-0000-4000-8000-000000000103'
const origin = 'https://command-jobs.example.invalid',
  prefix = '/api/admin/catalog/import-jobs'
const password = 'synthetic-command-job-http-cookie-password'.repeat(2)
const reason = 'Synthetic whole catalog job authorization'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const uuid = (kind: number, index: number) =>
  `0057${String(kind).padStart(4, '0')}-1000-4000-8000-${String(index).padStart(12, '0')}`
type Environment = Parameters<typeof handleCatalogImportJobHttp>[1]

describe('private whole-job HTTP apply/revert boundary', () => {
  let sqlite: DatabaseSync, database: D1Database, env: Environment, cookie: string
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.compoundSelect = 5
    sqlite.limits.likePatternLength = 50
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO catalog_sources(id,code,name,owner,kind,is_master) VALUES (?,'HTTP-COMMAND-JOB','Supplier','NETECO','supplier',1)"
      )
      .run(ids.source)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,57,'Category','command-job-http','published')"
      )
      .run(ids.category)
    sqlite
      .prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Brand','command-job-http','published')")
      .run(ids.brand)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'HTTP-COMMAND-JOB','VAT',2100,'2020-01-01T00:00:00Z')"
      )
      .run(ids.tax)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'HTTP-COMMAND-JOB','Parcel','parcel')")
      .run(ids.shipping)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,'HTTP-COMMAND-JOB','Warehouse','warehouse',1,?)"
      )
      .run(warehouse, utc(-86400_000))
    sqlite.exec("INSERT INTO roles VALUES ('command-job-http','Importer','Synthetic fixture')")
    for (const [resource, action] of [
      ['catalog', 'write'],
      ['administration', 'manage'],
      ['inventory', 'write']
    ]) {
      sqlite
        .prepare('INSERT OR IGNORE INTO permissions VALUES (?,?,?,?)')
        .run(`${resource}.${action}`, resource!, action!, 'Synthetic fixture')
      sqlite.prepare("INSERT INTO role_permissions VALUES ('command-job-http',?)").run(`${resource}.${action}`)
    }
    cookie = await seedCookie(actor, session, 'command-job-http@example.invalid')
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
  })
  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  async function seedCookie(identity: string, sessionId: string, email: string) {
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,?,'unusable-synthetic',?,'active',?,?)"
      )
      .run(identity, email, utc(-86400_000), utc(-86400_000), utc(-86400_000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'command-job-http',?)")
      .run(identity, utc(-86400_000))
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(sessionId, identity, utc(-86400_000), utc(7200_000))
    return (await issueD1SessionCookie(
      database,
      { identityId: identity, sessionId, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
  }
  function record(index = 1) {
    const product = uuid(1, index),
      variant = uuid(2, index),
      asset = uuid(3, index),
      source = catalogRecord()
    return {
      ...source,
      product_id: product,
      product_legacy_id: String(990000 + index),
      product_slug: 'http-command-job-' + index,
      variant_id: variant,
      variant_legacy_id: String(1000000 + index),
      sku: 'HTTP-COMMAND-JOB-' + index,
      ean: '',
      gtin: '',
      mpn: 'HTTP-MPN-' + index,
      identifier_exception_reason: 'Synthetic MPN-only unpublished draft',
      asset_id: asset,
      asset_storage_key: `clean/${asset}.png`,
      asset_checksum_sha256: index.toString(16).padStart(64, '0'),
      asset_source_url: '/media/' + asset,
      product_attributes_json: JSON.stringify({
        image: '/media/' + asset,
        imageAlt: source.asset_alt_text,
        imageRights: {
          owner: source.asset_owner_name,
          license: source.asset_license,
          authorizedAt: source.asset_authorized_at
        }
      }),
      inventory_json: JSON.stringify([{ locationId: warehouse, physicalQuantity: 40, blockedQuantity: 2, version: 1 }])
    }
  }
  function request(path: string, method = 'POST', body: unknown = {}, headers: Record<string, string> = {}) {
    return new Request(origin + prefix + path, {
      method,
      headers: {
        origin,
        cookie,
        'content-type': 'application/json',
        'idempotency-key': testUuid(),
        ...headers
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) })
    })
  }
  const call = async (req: Request, environment = env) => {
    const response = await handleCatalogImportJobHttp(req, environment)
    expect(response).not.toBeNull()
    return response!
  }
  function privateHeaders(response: Response) {
    for (const [name, value] of Object.entries({
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer'
    }))
      expect(response.headers.get(name)).toBe(value)
  }
  async function fail(req: Request, code: string, status: number, environment = env) {
    const response = await call(req, environment)
    expect(response.status).toBe(status)
    privateHeaders(response)
    expect(await response.json()).toEqual({ error: { code } })
    return response
  }
  async function sealed(size = 1) {
    const response = await call(request('', 'POST', { totalPages: Math.ceil(size / 201), recordCount: size }))
    expect(response.status).toBe(200)
    const job = (await response.json()) as CatalogImportJob
    const records = Array.from({ length: size }, (_, index) => record(index + 1))
    for (let offset = 0; offset < size; offset += 201) {
      const index = Math.floor(offset / 201),
        page = await call(
          request(`/${job.id}/pages/${index}`, 'PUT', { index, records: records.slice(offset, offset + 201) })
        )
      expect(page.status).toBe(200)
    }
    const ready = await call(request(`/${job.id}/seal`, 'POST', { reason }))
    expect(ready.status).toBe(200)
    const result = (await ready.json()) as CatalogImportJob
    expect(result.status).toBe('ready')
    return result
  }
  const commandRequest = (
    job: CatalogImportJob,
    action: 'apply' | 'revert' = 'apply',
    key = testUuid(),
    headers: Record<string, string> = {}
  ) =>
    request(`/${job.id}/${action}`, 'POST', { previewHash: job.hash, reason }, { 'idempotency-key': key, ...headers })
  const table = (name: string) => sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
  function snapshot() {
    return Object.fromEntries(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' AND name<>'identity_rate_limits' ORDER BY name"
        )
        .all()
        .map(({ name }) => [String(name), table(String(name))])
    )
  }

  it('applies and exactly compensates a 601-row/3-page job through authenticated HTTP with private durable receipts and GET statuses', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external network permitted')),
      job = await sealed(601)
    expect(table('products')).toHaveLength(0)
    const applyKey = testUuid(),
      apply = await call(commandRequest(job, 'apply', applyKey))
    expect(apply.status).toBe(200)
    privateHeaders(apply)
    const text = await apply.text(),
      receipt = catalogImportJobReceiptSchema.parse(JSON.parse(text))
    expect(receipt).toMatchObject({
      source: 'cloudflare',
      action: 'apply',
      jobId: job.id,
      jobHash: job.hash,
      counts: { products: 601, variants: 601, assets: 601, mappings: 601 },
      updated: true
    })
    const beforeReplay = snapshot()
    expect(await (await call(commandRequest(job, 'apply', applyKey))).text()).toBe(text)
    expect(snapshot()).toEqual(beforeReplay)
    const get = request('/' + job.id, 'GET')
    get.headers.delete('origin')
    const fresh = await call(get, { ...env, DB: d1OverSqlite(sqlite) })
    expect(await fresh.json()).toMatchObject({ status: 'applied', hash: job.hash, counts: receipt.counts })
    privateHeaders(fresh)
    for (const name of [
      'products',
      'variants',
      'variant_price_versions',
      'inventory_balances',
      'media_assets',
      'product_media',
      'inventory_movements'
    ])
      expect(table(name)).toHaveLength(601)
    expect(table('products').every((row) => row.status === 'draft' && row.published_at === null)).toBe(true)
    expect(table('variants').every((row) => row.status === 'draft' && row.color === '#00AACC')).toBe(true)
    expect(
      table('media_assets').every((row) => row.rights_status === 'pending' && row.quarantine_status === 'pending')
    ).toBe(true)
    expect(
      table('variant_price_versions').every(
        (row) => row.created_by === actor && row.reason === reason && row.gross_cents === 1599
      )
    ).toBe(true)
    const revertKey = testUuid(),
      revert = await call(commandRequest(job, 'revert', revertKey))
    expect(revert.status).toBe(200)
    privateHeaders(revert)
    const revertText = await revert.text(),
      reverted = catalogImportJobReceiptSchema.parse(JSON.parse(revertText))
    expect(reverted).toMatchObject({
      action: 'revert',
      jobId: job.id,
      jobHash: job.hash,
      counts: receipt.counts,
      updated: true
    })
    expect(reverted.commandId).not.toBe(receipt.commandId)
    expect(await (await call(request('/' + job.id, 'GET'))).json()).toMatchObject({
      status: 'reverted',
      hash: job.hash
    })
    const after = snapshot()
    expect(await (await call(commandRequest(job, 'revert', revertKey))).text()).toBe(revertText)
    expect(snapshot()).toEqual(after)
    expect(table('inventory_movements')).toHaveLength(1202)
    expect(
      table('inventory_balances').every(
        (row) => row.physical_quantity === 0 && row.blocked_quantity === 0 && row.version === 2
      )
    ).toBe(true)
    expect(table('products').every((row) => row.status === 'discontinued')).toBe(true)
    expect(table('variants').every((row) => row.status === 'discontinued')).toBe(true)
    expect(
      table('variant_price_versions').every((row) => row.status === 'cancelled' && row.cancelled_by === actor)
    ).toBe(true)
    for (const name of ['media_uploads', 'media_scan_receipts', 'media_rights_decisions', 'product_media_publications'])
      expect(table(name)).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  }, 60000)

  it.each(['apply', 'revert'] as const)(
    'accepts only canonical POST /:id/%s paths, with no encoded/mixed-case/query/legacy fallback',
    async (action) => {
      const job = await sealed(),
        path = `/${job.id}/${action}`
      for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
        const response = await fail(request(path, method), 'method_not_allowed', 405)
        expect(response.headers.get('allow')).toBe('POST')
      }
      for (const invalid of [
        path + '/',
        path + '/extra',
        path + '?now=2099',
        path.replace(action, action.toUpperCase()),
        `/${job.id}/%61${action.slice(1)}`,
        '/not-a-uuid/' + action
      ])
        await fail(request(invalid), 'invalid_input', 400)
      await fail(new Request(origin + '/API/ADMIN/CATALOG/IMPORT-JOBS' + path), 'invalid_input', 400)
      await fail(new Request(origin + '/api/admin/catalog/%69mport-jobs' + path), 'invalid_input', 400)
      expect(await handleCatalogImportJobHttp(new Request(origin + '/api/products'), env)).toBeNull()
      expect(table('products')).toHaveLength(0)
    }
  )
  it.each(['apply', 'revert'] as const)(
    'requires same canonical origin and rejects cross-site or missing-origin %s even on replay',
    async (action) => {
      const job = await sealed(),
        applyKey = testUuid(),
        revertKey = testUuid()
      expect((await call(commandRequest(job, 'apply', applyKey))).status).toBe(200)
      if (action === 'revert') expect((await call(commandRequest(job, 'revert', revertKey))).status).toBe(200)
      const key = action === 'apply' ? applyKey : revertKey,
        before = snapshot()
      await fail(commandRequest(job, action, key, { origin: 'https://attacker.invalid' }), 'csrf_rejected', 403)
      await fail(commandRequest(job, action, key, { 'sec-fetch-site': 'cross-site' }), 'csrf_rejected', 403)
      const missing = commandRequest(job, action, key)
      missing.headers.delete('origin')
      await fail(missing, 'csrf_rejected', 403)
      expect(snapshot()).toEqual(before)
    }
  )
  it.each(['', 'invalid key', 'x'.repeat(201), 'ñ', 'abc/def', 'abc?def'])(
    'requires a bounded ASCII idempotency key (%s)',
    async (key) => {
      const job = await sealed(),
        before = snapshot(),
        req = commandRequest(job, 'apply', key)
      if (!key) req.headers.delete('idempotency-key')
      await fail(req, 'invalid_idempotency_key', 400)
      expect(snapshot()).toEqual(before)
    }
  )
  it('accepts an exactly 200-character valid command key and rejects altered same-key/opposite-action payloads', async () => {
    const job = await sealed(),
      key = 'A'.repeat(200),
      response = await call(commandRequest(job, 'apply', key))
    expect(response.status).toBe(200)
    const before = snapshot()
    await fail(
      request(
        `/${job.id}/apply`,
        'POST',
        { previewHash: job.hash, reason: reason + ' changed' },
        { 'idempotency-key': key }
      ),
      'idempotency_conflict',
      409
    )
    await fail(commandRequest(job, 'revert', key), 'idempotency_conflict', 409)
    await fail(commandRequest(job, 'apply'), 'already_applied', 409)
    expect(snapshot()).toEqual(before)
  })
  it.each(['catalog.write', 'administration.manage', 'inventory.write', 'email', 'mfa', 'session', 'expiry'])(
    'checks current %s before cached apply/revert responses',
    async (authority) => {
      const job = await sealed(),
        applyKey = testUuid(),
        revertKey = testUuid()
      expect((await call(commandRequest(job, 'apply', applyKey))).status).toBe(200)
      expect((await call(commandRequest(job, 'revert', revertKey))).status).toBe(200)
      let code = 'forbidden',
        status = 403
      if (authority === 'email') {
        sqlite.exec('UPDATE identities SET email_verified_at=NULL')
        code = 'email_unverified'
      } else if (authority === 'mfa') {
        sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
        code = 'mfa_required'
      } else if (authority === 'session' || authority === 'expiry') {
        sqlite.exec(
          authority === 'session'
            ? 'UPDATE auth_sessions SET revoked_at=created_at'
            : "UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ',created_at,'+1 second')"
        )
        code = 'unauthenticated'
        status = 401
      } else sqlite.prepare('DELETE FROM role_permissions WHERE permission_code=?').run(authority)
      const before = snapshot()
      await fail(commandRequest(job, 'apply', applyKey), code, status)
      await fail(commandRequest(job, 'revert', revertKey), code, status)
      await fail(request('/' + job.id, 'GET'), code, status)
      expect(snapshot()).toEqual(before)
    }
  )
  it('requires signed cookies and denies disabled authentication without executing either command', async () => {
    const job = await sealed(),
      before = snapshot()
    for (const action of ['apply', 'revert'] as const) {
      for (const value of ['', 'neteco-session=forged'])
        await fail(commandRequest(job, action, testUuid(), { cookie: value }), 'unauthenticated', 401)
      await fail(commandRequest(job, action), 'service_unavailable', 503, { ...env, AUTH_ENABLED: 'false' })
    }
    expect(snapshot()).toEqual(before)
  })
  it('keeps cached receipts and GET status private to the original owner', async () => {
    const job = await sealed(),
      key = testUuid()
    expect((await call(commandRequest(job, 'apply', key))).status).toBe(200)
    const otherCookie = await seedCookie(uuid(9, 1), uuid(9, 2), 'other-command-job@example.invalid'),
      before = snapshot()
    await fail(commandRequest(job, 'apply', key, { cookie: otherCookie }), 'not_found', 404)
    await fail(commandRequest(job, 'revert', testUuid(), { cookie: otherCookie }), 'not_found', 404)
    await fail(request('/' + job.id, 'GET', undefined, { cookie: otherCookie }), 'not_found', 404)
    expect(snapshot()).toEqual(before)
  })
  it.each([
    { reason },
    { previewHash: '0'.repeat(64) },
    { previewHash: 'bad', reason },
    { reason: 'x' },
    { now: '2099-01-01T00:00:00Z' },
    { price_gross_cents: 1 },
    { scope: 'production' },
    { records: [] },
    { source: 'legacy' }
  ])(
    'rejects missing/invalid fields and request-supplied authority without silently stripping extras (%j)',
    async (extra) => {
      const job = await sealed(),
        before = snapshot()
      const body =
        Object.hasOwn(extra, 'previewHash') || Object.hasOwn(extra, 'reason')
          ? extra
          : { previewHash: job.hash, reason, ...extra }
      await fail(request(`/${job.id}/apply`, 'POST', body), 'invalid_input', 422)
      expect(snapshot()).toEqual(before)
    }
  )
  it('rejects command body JSON/UTF8/content-type/declared and streamed byte violations at 4KiB', async () => {
    const job = await sealed(),
      path = `/${job.id}/apply`,
      before = snapshot()
    const raw = (body: Uint8Array, headers: Record<string, string> = {}) =>
      new Request(origin + prefix + path, {
        method: 'POST',
        headers: {
          origin,
          cookie,
          'idempotency-key': testUuid(),
          'content-type': 'application/json',
          ...headers
        },
        body
      })
    await fail(commandRequest(job, 'apply', testUuid(), { 'content-type': 'text/plain' }), 'json_required', 415)
    for (const value of ['4097', '-1', 'not-a-size'])
      await fail(commandRequest(job, 'apply', testUuid(), { 'content-length': value }), 'body_too_large', 413)
    await fail(raw(new Uint8Array([0xff])), 'invalid_json', 400)
    await fail(raw(new TextEncoder().encode('{')), 'invalid_json', 400)
    await fail(raw(new Uint8Array(4097)), 'body_too_large', 413)
    await fail(raw(new Uint8Array(4097), { 'content-length': '1' }), 'body_too_large', 413)
    const noBody = new Request(origin + prefix + path, {
      method: 'POST',
      headers: { origin, cookie, 'idempotency-key': testUuid(), 'content-type': 'application/json' }
    })
    await fail(noBody, 'missing_body', 400)
    expect(snapshot()).toEqual(before)
  })
  it('cancels stalled command streams at the existing 8-second deadline', async () => {
    const job = await sealed(),
      cancel = vi.fn(),
      stream = new ReadableStream<Uint8Array>({ cancel })
    const req = new Request(origin + prefix + '/' + job.id + '/apply', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'idempotency-key': 'stalled-command' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const pending = call(req)
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(8001)
    const response = await pending
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: { code: 'body_timeout' } })
    expect(cancel).toHaveBeenCalled()
    expect(table('products')).toHaveLength(0)
  })
  it('shares the 30/hour command quota while GET remains readable and page quota stays independent', async () => {
    const job = await sealed(),
      before = snapshot()
    sqlite
      .prepare(
        "UPDATE identity_rate_limits SET used=30 WHERE identity_id=? AND scope='admin-catalog-import-job-commands'"
      )
      .run(actor)
    for (const action of ['apply', 'revert'] as const) {
      const response = await fail(commandRequest(job, action), 'rate_limited', 429)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    }
    expect((await call(request('/' + job.id, 'GET'))).status).toBe(200)
    expect(snapshot()).toEqual(before)
    expect(table('identity_rate_limits').filter((row) => row.scope === 'admin-catalog-import-job-pages')[0]!.used).toBe(
      1
    )
  })
  it('maps native conflicts and sanitizes arbitrary backend failures without leaking SQL, source data or fallback success', async () => {
    const job = await sealed(),
      before = snapshot()
    await fail(request(`/${job.id}/apply`, 'POST', { previewHash: '0'.repeat(64), reason }), 'version_conflict', 409)
    await fail(commandRequest(job, 'revert'), 'not_applied', 409)
    const broken = {
      ...database,
      prepare: () => {
        throw new Error('SELECT PRIVATE_SECRET FROM PRIVATE_SOURCE')
      }
    } as D1Database
    await fail(commandRequest(job), 'service_unavailable', 500, { ...env, DB: broken })
    expect(snapshot()).toEqual(before)
  })
})
