import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleCatalogTypedAttributesHttp,
  ownsCatalogTypedAttributesNamespace,
  type CatalogTypedAttributesHttpEnvironment
} from '../../workers/catalog/typed-attribute-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import worker from '../../workers/canary'
import { catalogTypedAttributeReceiptSchema } from '../../shared/catalog-typed-attributes'
import {
  catalogTypedAttributeDefinitionsViewSchema,
  catalogTypedAttributeProductViewSchema,
  catalogTypedAttributeValuesReceiptSchema
} from '../../shared/catalog-typed-attribute-views'
import { seedInventoryFixture } from '../support/d1-sqlite'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_SESSION,
  categoryUtc
} from '../support/category-command-fixture'

const ORIGIN = 'https://typed.neteco.invalid'
const PASSWORD = 'synthetic-typed-cookie-password-at-least-32'
const COLLECTION = '/api/admin/catalog-attributes/definitions'
describe('typed attribute HTTP uses live private authority and bounded requests', () => {
  let sqlite: DatabaseSync, database: D1Database, env: CatalogTypedAttributesHttpEnvironment, cookie: string
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_typed_attribute_definitions'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, NUXT_SESSION_PASSWORD: PASSWORD }
    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, {
      password: PASSWORD,
      maxAgeSeconds: 3600
    }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const input = () => ({
    categoryId: 10,
    code: 'washable',
    kind: 'boolean',
    label: 'Lavable',
    config: {},
    expectedVersion: 0,
    reason: 'Definición sintética por HTTP'
  })
  function request(
    path = COLLECTION,
    method = 'POST',
    body: BodyInit | null = JSON.stringify(input()),
    headers: Record<string, string> = {}
  ) {
    const init: RequestInit = {
      method,
      body,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'typed-http-create',
        ...headers
      }
    }
    if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(ORIGIN + path, init)
  }
  async function handle(candidate: Request, overrides: Partial<CatalogTypedAttributesHttpEnvironment> = {}) {
    const response = await handleCatalogTypedAttributesHttp(candidate, { ...env, ...overrides })
    expect(response).not.toBeNull()
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
    return response!
  }
  it('creates, reads current definitions and capabilities, revises, retires, and replays the original receipt', async () => {
    const created = await handle(request())
    expect(created.status).toBe(201)
    const first = catalogTypedAttributeReceiptSchema.parse(await created.json())
    const list = catalogTypedAttributeDefinitionsViewSchema.parse(
      await (await handle(request(COLLECTION + '?categoryId=10', 'GET', null))).json()
    )
    expect(list.definitions).toEqual([first.definition])
    expect(list.capabilities).toEqual({ read: true, create: true, update: true, retire: true })
    const path = COLLECTION + '/' + first.definition.id
    const updated = await handle(
      request(
        path,
        'PUT',
        JSON.stringify({
          action: 'update',
          label: 'Lavable revisado',
          config: {},
          expectedVersion: 1,
          reason: 'Etiqueta sintética nueva'
        }),
        { 'idempotency-key': 'typed-http-revise' }
      )
    )
    expect(updated.status).toBe(200)
    expect(catalogTypedAttributeReceiptSchema.parse(await updated.json()).definition).toMatchObject({
      revision: 2,
      label: 'Lavable revisado'
    })
    const retired = await handle(
      request(
        path,
        'PUT',
        JSON.stringify({ action: 'retire', expectedVersion: 2, reason: 'Retirada sintética explícita' }),
        { 'idempotency-key': 'typed-http-retire' }
      )
    )
    expect(retired.status).toBe(200)
    expect(catalogTypedAttributeReceiptSchema.parse(await retired.json()).definition).toMatchObject({
      revision: 3,
      status: 'retired'
    })
    expect(catalogTypedAttributeReceiptSchema.parse(await (await handle(request())).json())).toEqual(first)
    const after = catalogTypedAttributeDefinitionsViewSchema.parse(
      await (await handle(request(COLLECTION + '?categoryId=10', 'GET', null))).json()
    )
    expect(after.definitions).toHaveLength(1)
    expect(after.definitions[0]!.status).toBe('retired')
  })
  it('allows a catalog writer to read but never infers definition administration rights', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='administration.manage'")
    const response = await handle(request(COLLECTION + '?categoryId=10', 'GET', null))
    expect(response.status).toBe(200)
    expect(catalogTypedAttributeDefinitionsViewSchema.parse(await response.json()).capabilities).toEqual({
      read: true,
      create: false,
      update: false,
      retire: false
    })
    expect((await handle(request())).status).toBe(403)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
  })
  it('rechecks the read grant after the last capability query before emitting private definitions', async () => {
    expect((await handle(request())).status).toBe(201)
    let revoked = false
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql),
              bind = statement.bind.bind(statement)
            statement.bind = (...parameters: unknown[]) => {
              const bound = bind(...parameters)
              if (sql.includes('auth_sessions') && parameters[1] === 'administration.manage') {
                const first = bound.first.bind(bound)
                bound.first = async (...args: Parameters<typeof first>) => {
                  const result = await first(...args)
                  sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
                  revoked = true
                  return result
                }
              }
              return bound
            }
            return statement
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const response = await handle(request(COLLECTION + '?categoryId=10', 'GET', null), { DB: proxy })
    expect(revoked).toBe(true)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
  })
  it('rejects a definition write when only its catalog grant is revoked while reading the body', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    })
    const candidate = request(COLLECTION, 'POST', stream)
    let begin: (() => void) | undefined
    const reading = new Promise<void>((resolve) => {
      begin = resolve
    })
    const getReader = candidate.body!.getReader.bind(candidate.body!)
    vi.spyOn(candidate.body!, 'getReader').mockImplementation(() => {
      begin!()
      return getReader()
    })
    const pending = handle(candidate)
    await reading
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    controller!.enqueue(new TextEncoder().encode(JSON.stringify(input())))
    controller!.close()
    const response = await pending
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
  })
  it('cancels a stalled body at the eight-second deadline without waiting in real time', async () => {
    const cancel = vi.fn()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      cancel
    })
    const candidate = request(COLLECTION, 'POST', stream)
    let begin: (() => void) | undefined
    const reading = new Promise<void>((resolve) => {
      begin = resolve
    })
    const getReader = candidate.body!.getReader.bind(candidate.body!)
    vi.spyOn(candidate.body!, 'getReader').mockImplementation(() => {
      begin!()
      return getReader()
    })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let settled = false
    const pending = handle(candidate).then((response) => {
      settled = true
      return response
    })
    try {
      await reading
      await vi.advanceTimersByTimeAsync(7999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(settled).toBe(true)
      const response = await pending
      expect(response.status).toBe(408)
      expect(await response.json()).toEqual({ error: { code: 'body_timeout' } })
      expect(cancel).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
    } finally {
      if (!settled) {
        controller!.close()
        await pending
      }
      vi.useRealTimers()
    }
  })
  it('enforces the elapsed deadline even when immediate empty chunks keep winning the timer race', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const cancel = vi.fn()
    let chunks = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunks++ < 3) {
            vi.setSystemTime(Date.now() + 3000)
            controller.enqueue(new Uint8Array())
          } else controller.close()
        },
        cancel
      },
      { highWaterMark: 0 }
    )
    const response = await handle(request(COLLECTION, 'POST', stream))
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ error: { code: 'body_timeout' } })
    expect(cancel).toHaveBeenCalledOnce()
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
  })
  it('does not capture other administrative or public readers', async () => {
    for (const path of [
      '/api/products',
      '/api/admin/categories',
      '/api/admin/products',
      '/api/admin/catalog-attributes-extra'
    ]) {
      expect(ownsCatalogTypedAttributesNamespace(path)).toBe(false)
      expect(await handleCatalogTypedAttributesHttp(request(path, 'GET', null), env)).toBeNull()
    }
  })
  it.each([
    '/api/admin/catalog-attributes',
    '/api/admin/catalog-attributes/definitions/',
    '/api/admin/catalog-attributes/definitions/not-a-uuid',
    '/api/admin/catalog-attributes/definitions?categoryId=01',
    '/api/admin/catalog-attributes/definitions?categoryId=10&categoryId=11',
    '/api/admin/catalog-attributes/definitions?categoryId=10&now=2099',
    '/api/admin/catalog-%61ttributes/definitions?categoryId=10',
    '/api/admin/%2563atalog-attributes/definitions?categoryId=10'
  ])('owns malformed or encoded paths and rejects them before SQL: %s', async (path) => {
    expect(ownsCatalogTypedAttributesNamespace(new URL(ORIGIN + path).pathname)).toBe(true)
    const sql = vi.spyOn(database, 'prepare')
    const response = await handle(request(path, 'GET', null))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
    expect(sql).not.toHaveBeenCalled()
  })
  it('rejects wrong methods with an explicit Allow without reading SQL or bodies', async () => {
    const sql = vi.spyOn(database, 'prepare')
    const response = await handle(request(COLLECTION, 'DELETE'))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
    expect(sql).not.toHaveBeenCalled()
  })
  it.each(['origin', 'cross-site'])('rejects write CSRF %s before SQL and stream consumption', async (cause) => {
    const candidate = request(
      COLLECTION,
      'POST',
      JSON.stringify(input()),
      cause === 'origin' ? { origin: 'https://hostile.invalid' } : { 'sec-fetch-site': 'cross-site' }
    )
    const sql = vi.spyOn(database, 'prepare'),
      read = vi.spyOn(candidate.body!, 'getReader')
    expect((await handle(candidate)).status).toBe(403)
    expect(sql).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['missing', 'revoked', 'mfa', 'read-grant'])(
    'checks fresh %s authority before a read or a write',
    async (cause) => {
      if (cause === 'revoked')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(categoryUtc(), CATEGORY_SESSION)
      if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_SESSION)
      if (cause === 'read-grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
      const headers: Record<string, string> = cause === 'missing' ? { cookie: '' } : {}
      for (const method of ['GET', 'POST']) {
        const candidate = request(
          method === 'GET' ? COLLECTION + '?categoryId=10' : COLLECTION,
          method,
          method === 'GET' ? null : JSON.stringify(input()),
          headers
        )
        const read = candidate.body ? vi.spyOn(candidate.body, 'getReader') : null
        expect((await handle(candidate)).status).toBe(cause === 'missing' || cause === 'revoked' ? 401 : 403)
        if (read) expect(read).not.toHaveBeenCalled()
      }
    }
  )
  it('rejects excess streamed bytes even without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024))
        controller.close()
      }
    })
    expect((await handle(request(COLLECTION, 'POST', stream))).status).toBe(413)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 0 })
  })
  it('rejects invalid JSON, media type, keys, and immutable field overrides without writes', async () => {
    expect((await handle(request(COLLECTION, 'POST', '{'))).status).toBe(400)
    expect((await handle(request(COLLECTION, 'POST', '{}', { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await handle(request(COLLECTION, 'POST', JSON.stringify(input()), { 'idempotency-key': '' }))).status).toBe(
      400
    )
    expect((await handle(request(COLLECTION, 'POST', JSON.stringify({ ...input(), injected: true })))).status).toBe(422)
    const first = catalogTypedAttributeReceiptSchema.parse(await (await handle(request())).json())
    expect(
      (
        await handle(
          request(
            COLLECTION + '/' + first.definition.id,
            'PUT',
            JSON.stringify({
              action: 'update',
              label: 'Renamed',
              config: {},
              expectedVersion: 1,
              reason: 'Intento sintético',
              kind: 'number'
            }),
            { 'idempotency-key': 'immutable-override' }
          )
        )
      ).status
    ).toBe(422)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_typed_attribute_commands').get()).toEqual({ n: 1 })
  })
  it('does not authorize an old receipt after revocation', async () => {
    expect((await handle(request())).status).toBe(201)
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(categoryUtc(), CATEGORY_SESSION)
    const response = await handle(request())
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('washable')
  })
  it('fails closed on auth disabled or D1 outage without exposing internals', async () => {
    expect((await handle(request(), { AUTH_ENABLED: 'false' })).status).toBe(503)
    const failed = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return () => {
            throw new Error('SQL synthetic outage must stay private')
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const response = await handle(request(COLLECTION + '?categoryId=10', 'GET', null), { DB: failed })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })

  function ingressEnvironment(): CloudflareEnv {
    return {
      ...env,
      APP_ENV: 'local',
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-typed-ingress-pepper-at-least-32',
      ADMIN_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: true })) }
    } as unknown as CloudflareEnv
  }
  it('routes the dedicated private namespace through the existing administrative edge limiter', async () => {
    const ingress = ingressEnvironment()
    const candidate = request(COLLECTION + '?categoryId=10', 'GET', null, { 'cf-connecting-ip': '192.0.2.58' })
    const response = await worker.fetch(candidate, ingress)
    expect(response.status).toBe(200)
    expect(catalogTypedAttributeDefinitionsViewSchema.parse(await response.json()).categoryId).toBe(10)
    expect(ingress.ADMIN_EDGE_LIMIT.limit).toHaveBeenCalledOnce()
  })
  it('keeps disabled typed ingress private and rejects before SQL or request bodies', async () => {
    const ingress = ingressEnvironment()
    ingress.AUTH_ENABLED = 'false'
    const sql = vi.spyOn(database, 'prepare')
    const candidate = request(COLLECTION, 'POST', 'untrusted')
    const response = await worker.fetch(candidate, ingress)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(candidate.bodyUsed).toBe(false)
    expect(sql).not.toHaveBeenCalled()
    expect(ingress.ADMIN_EDGE_LIMIT.limit).not.toHaveBeenCalled()
  })
  it('rate-limits aliases at ingress before SQL or body consumption and never falls back to the renderer', async () => {
    const ingress = ingressEnvironment()
    ingress.ADMIN_EDGE_LIMIT = { limit: vi.fn(async () => ({ success: false })) }
    const sql = vi.spyOn(database, 'prepare')
    const candidate = request('/api/admin/catalog-%61ttributes/definitions', 'POST', 'untrusted', {
      'cf-connecting-ip': '192.0.2.58'
    })
    const response = await worker.fetch(candidate, ingress)
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(candidate.bodyUsed).toBe(false)
    expect(sql).not.toHaveBeenCalled()
  })
  it.each(['typed=not-json', 'typed=%5B%5D&typed=%5B%5D'])(
    'rejects invalid public filter query %s before catalog SQL',
    async (query) => {
      const sql = vi.spyOn(database, 'prepare')
      const response = await worker.fetch(new Request(ORIGIN + '/api/products?' + query), ingressEnvironment())
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ error: 'invalid_typed_filters' })
      expect(sql).not.toHaveBeenCalled()
    }
  )
  it('maps unknown typed definitions to uniform 400 rather than an outage or an unfiltered result', async () => {
    const typed = JSON.stringify([{ definitionId: '10000000-0000-4000-8000-000000000058', values: [false] }])
    const response = await worker.fetch(
      new Request(ORIGIN + '/api/products?typed=' + encodeURIComponent(typed)),
      ingressEnvironment()
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_typed_filters' })
  })
  it('reads and replaces draft product values through HTTP with catalog.write alone and durable replay', async () => {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_draft_commands_typed_shape'").get())
      sqlite.exec(
        await readFile(
          new URL('../../db/d1/migrations/0059_catalog_typed_attribute_values.sql', import.meta.url),
          'utf8'
        )
      )
    seedInventoryFixture(sqlite)
    sqlite.exec(
      "UPDATE products SET status='draft' WHERE id='p-1'; DELETE FROM role_permissions WHERE permission_code='administration.manage'"
    )
    const path = '/api/admin/catalog-attributes/products/1'
    const viewResponse = await handle(request(path, 'GET', null))
    expect(viewResponse.status).toBe(200)
    const view = catalogTypedAttributeProductViewSchema.parse(await viewResponse.json())
    expect(view.product.uuid).toBe('p-1')
    expect(view.capabilities).toEqual({ read: true, update: true })
    const body = JSON.stringify({
      expectedVersion: view.product.catalogVersion,
      reason: 'HTTP synthetic full replacement',
      typed: { version: 1, values: [] }
    })
    const first = await handle(request(path, 'PUT', body, { 'idempotency-key': 'typed-values-http' }))
    expect(first.status).toBe(200)
    const receipt = catalogTypedAttributeValuesReceiptSchema.parse(await first.json())
    const replay = await handle(request(path, 'PUT', body, { 'idempotency-key': 'typed-values-http' }))
    expect(await replay.json()).toEqual(receipt)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_draft_commands').get()).toEqual({ n: 1 })
    expect(
      (
        await handle(
          request(
            path,
            'PUT',
            JSON.stringify({ expectedVersion: receipt.catalogVersion, reason: 'Reject unsafe value', typed: null }),
            { 'idempotency-key': 'typed-invalid-values-http' }
          )
        )
      ).status
    ).toBe(422)
  })
})
