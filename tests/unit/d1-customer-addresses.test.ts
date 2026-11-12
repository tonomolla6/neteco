import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { hashWorkerPassword } from '../../workers/auth/password'
import { testUuid, testNow } from '../support/deterministic'

const identityId = '10000000-0000-4000-8000-000000000051'
const customerId = '30000000-0000-4000-8000-000000000051'
const otherCustomerId = '30000000-0000-4000-8000-000000000052'
const password = 'Synthetic-address-password-123'
const configuration = {
  password: randomBytes(32).toString('hex'),
  maxAgeSeconds: 3600,
  origin: 'https://neteco.invalid',
  tokenPepper: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('base64')
}

const address = {
  kind: 'both',
  label: 'Casa',
  recipientName: 'Cliente de prueba',
  companyName: '',
  taxId: '',
  line1: 'Calle de Prueba 12',
  line2: '',
  postalCode: '28001',
  city: 'Madrid',
  region: 'Madrid',
  countryCode: 'ES',
  phone: '+34600111222',
  instructions: '',
  isDefault: true
} as const

describe('D1 customer address book', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  const limiter = { limit: vi.fn(async () => ({ success: true })) }
  const handle = (request: Request) =>
    handleAuthenticationHttp(request, { database, edgeLimiter: limiter, configuration: () => configuration })
  function api(method: string, path: string, cookie = '', body?: unknown, origin = configuration.origin) {
    return new Request(`${configuration.origin}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        'cf-connecting-ip': '192.0.2.25',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  async function login() {
    const response = (await handle(api('POST', '/api/auth/login', '', { email: 'address@example.invalid', password })))!
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }

  beforeEach(async () => {
    limiter.limit.mockReset().mockResolvedValue({ success: true })
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(customerId, 'Cliente', now, now)
    sqlite
      .prepare('INSERT INTO customers(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(otherCustomerId, 'Otro', now, now)
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
        VALUES (?, 'address@example.invalid', ?, ?, 'active', ?, ?, ?)`
      )
      .run(identityId, await hashWorkerPassword(password), now, customerId, now, now)
  })
  afterEach(() => sqlite.close())

  it('creates, lists, edits and deletes only own addresses; audit never stores address PII', async () => {
    const cookie = await login()
    const created = (await handle(api('POST', '/api/account/addresses', cookie, address)))!
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const { id } = (await created.json()) as { id: string }
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    const otherId = testUuid()
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    sqlite
      .prepare(
        `INSERT INTO customer_addresses(id, customer_id, kind, label, recipient_name, line1,
        postal_code, city, region, country_code, created_at, updated_at)
        VALUES (?, ?, 'shipping', 'Ajena', 'Otra persona', 'Calle Ajena 1', '28001', 'Madrid', 'Madrid', 'ES', ?, ?)`
      )
      .run(otherId, otherCustomerId, now, now)
    const listed = (await handle(api('GET', '/api/account/addresses', cookie)))!
    expect(listed.status).toBe(200)
    expect((await listed.json()).addresses).toMatchObject([
      { id, label: 'Casa', isDefault: true, phone: '+34600111222' }
    ])
    const update = (await handle(
      api('PUT', `/api/account/addresses/${id}`, cookie, { ...address, label: 'Oficina', isDefault: false })
    ))!
    expect(update.status).toBe(200)
    expect((await handle(api('PUT', `/api/account/addresses/${otherId}`, cookie, address)))!.status).toBe(404)
    expect((await handle(api('DELETE', `/api/account/addresses/${otherId}`, cookie)))!.status).toBe(404)
    expect(sqlite.prepare('SELECT label FROM customer_addresses WHERE id = ?').get(otherId)).toEqual({
      label: 'Ajena'
    })
    expect((await handle(api('DELETE', `/api/account/addresses/${id}`, cookie)))!.status).toBe(200)
    await expect((await handle(api('GET', '/api/account/addresses', cookie)))!.json()).resolves.toEqual({
      addresses: []
    })
    const events = sqlite
      .prepare(
        'SELECT action, kind, country_code, is_default FROM customer_address_events WHERE customer_id = ? ORDER BY rowid'
      )
      .all(customerId)
    expect(events).toEqual([
      { action: 'created', kind: 'both', country_code: 'ES', is_default: 1 },
      { action: 'updated', kind: 'both', country_code: 'ES', is_default: 0 },
      { action: 'deleted', kind: 'both', country_code: 'ES', is_default: 0 }
    ])
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM customer_address_events').all())).not.toContain(
      'Calle de Prueba'
    )
    expect(() => sqlite.exec("DELETE FROM customer_address_events WHERE action = 'deleted'")).toThrow()
  })

  it('rejects a checksum-invalid fiscal address through actual HTTP without creating an address or audit event', async () => {
    const cookie = await login()
    const rejected = (await handle(api('POST', '/api/account/addresses', cookie, { ...address, taxId: 'A58818502' })))!
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_body' } })
    expect(sqlite.prepare('SELECT count(*) n FROM customer_addresses').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) n FROM customer_address_events').get()).toEqual({ n: 0 })
  })

  it('persists NFC address text through HTTP while preserving spaces and existing address snapshots', async () => {
    const cookie = await login()
    const original = (await handle(api('POST', '/api/account/addresses', cookie, address)))!
    expect(original.status).toBe(201)
    const { id: originalId } = (await original.json()) as { id: string }
    const before = sqlite.prepare('SELECT * FROM customer_addresses WHERE id=?').get(originalId)
    const input = {
      ...address,
      isDefault: false,
      label: ' Direccio\u0301n  secundaria ',
      recipientName: ' Jose\u0301  Pe\u0301rez ',
      line1: ' Calle  Jose\u0301  1 ',
      city: ' Vale\u0301ncia ',
      region: ' Castello\u0301n '
    }
    const created = (await handle(api('POST', '/api/account/addresses', cookie, input)))!
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const listed = (await handle(api('GET', '/api/account/addresses', cookie)))!
    expect(listed.status).toBe(200)
    const rows = (await listed.json()).addresses as Array<Record<string, unknown>>
    const current = rows.find((row) => row.id === id)!
    for (const field of ['label', 'recipientName', 'line1', 'city', 'region'] as const)
      expect(current[field]).toBe(input[field].trim().normalize('NFC'))
    expect(sqlite.prepare('SELECT * FROM customer_addresses WHERE id=?').get(originalId)).toEqual(before)
  })

  it('rejects single-line controls on create and edit without changing addresses or audit', async () => {
    const cookie = await login()
    const created = (await handle(api('POST', '/api/account/addresses', cookie, address)))!
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const snapshot = () => ({
      addresses: sqlite.prepare('SELECT * FROM customer_addresses ORDER BY id').all(),
      events: sqlite.prepare('SELECT * FROM customer_address_events ORDER BY rowid').all()
    })
    const before = snapshot()
    for (const control of ['\u0000', '\n', '\u007f', '\u0085', '\u2028', '\u2029'])
      for (const method of ['POST', 'PUT']) {
        const response = (await handle(
          api(method, method === 'POST' ? '/api/account/addresses' : `/api/account/addresses/${id}`, cookie, {
            ...address,
            recipientName: control + address.recipientName + control
          })
        ))!
        expect(response.status, `${method} ${JSON.stringify(control)}`).toBe(400)
        expect(await response.json()).toMatchObject({ error: { code: 'invalid_body' } })
        expect(snapshot()).toEqual(before)
      }
  })

  it('keeps exactly one default under replacement and rolls back a failed write', async () => {
    const cookie = await login()
    const first = (await (await handle(api('POST', '/api/account/addresses', cookie, address)))!.json()) as {
      id: string
    }
    const second = (await (await handle(
      api('POST', '/api/account/addresses', cookie, { ...address, label: 'Trabajo', kind: 'shipping' })
    ))!.json()) as { id: string }
    expect(sqlite.prepare('SELECT id FROM customer_addresses WHERE is_default = 1').all()).toEqual([{ id: second.id }])
    expect((await handle(api('PUT', `/api/account/addresses/${first.id}`, cookie, address)))!.status).toBe(200)
    expect(sqlite.prepare('SELECT id FROM customer_addresses WHERE is_default = 1').all()).toEqual([{ id: first.id }])
    sqlite.exec(`CREATE TRIGGER reject_address_update BEFORE UPDATE ON customer_addresses
      WHEN NEW.label = 'Bloqueada' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
    const failed = (await handle(
      api('PUT', `/api/account/addresses/${second.id}`, cookie, { ...address, label: 'Bloqueada', isDefault: true })
    ))!
    expect(failed.status).toBe(500)
    expect(sqlite.prepare('SELECT id FROM customer_addresses WHERE is_default = 1').all()).toEqual([{ id: first.id }])
    expect(sqlite.prepare('SELECT count(*) AS n FROM customer_address_events').get()).toEqual({ n: 5 })
  })

  it('rejects invalid data, foreign fields, CSRF, expired sessions and excessive address counts', async () => {
    const cookie = await login()
    expect(
      (await handle(api('POST', '/api/account/addresses', cookie, { ...address, postalCode: 'bad' })))!.status
    ).toBe(400)
    expect(
      (await handle(api('POST', '/api/account/addresses', cookie, { ...address, taxId: 'invalid-tax' })))!.status
    ).toBe(400)
    expect((await handle(api('POST', '/api/account/addresses', cookie, { ...address, phone: 'bad' })))!.status).toBe(
      400
    )
    expect(
      (await handle(api('POST', '/api/account/addresses', cookie, { ...address, customerId: otherCustomerId })))!.status
    ).toBe(400)
    expect((await handle(api('POST', '/api/account/addresses', cookie, address, 'https://evil.invalid')))!.status).toBe(
      403
    )
    expect((await handle(api('PUT', '/api/account/addresses/not-a-uuid', cookie, address)))!.status).toBe(400)
    const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const insert = sqlite.prepare(
      `INSERT INTO customer_addresses(id, customer_id, kind, label, recipient_name, line1,
       postal_code, city, region, country_code, created_at, updated_at)
       VALUES (?, ?, 'shipping', ?, 'Cliente de prueba', 'Calle Test 1', '28001', 'Madrid', 'Madrid', 'ES', ?, ?)`
    )
    for (let index = 0; index < 50; index++) insert.run(testUuid(), customerId, `Dirección ${index}`, now, now)
    expect((await handle(api('POST', '/api/account/addresses', cookie, address)))!.status).toBe(409)
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM customer_addresses WHERE customer_id = ?').get(customerId)
    ).toEqual({ n: 50 })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ?').run(now)
    expect((await handle(api('GET', '/api/account/addresses', cookie)))!.status).toBe(401)
    expect((await handle(api('POST', '/api/account/addresses', cookie, address)))!.status).toBe(401)
  })
})
