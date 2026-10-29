import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import worker from '../../workers/canary'
import { returnsFixture, BUYER_CLAIMS } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { DELIVERY_PREFERENCES_POLICY_VERSION, deliveryPreferenceIntentHash } from '../../shared/delivery-preferences'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'

const origin = 'https://account-settings.neteco.test'

it.each([
  ['GET', '/api/account/privacy'],
  ['POST', '/api/account/privacy'],
  ['GET', '/api/account/privacy/commands/11111111-1111-4111-8111-111111111165'],
  ['GET', '/api/account/privacy/11111111-1111-4111-8111-111111111165/download'],
  ['GET', '/api/account/privacy/not-a-route'],
  ['GET', '/api/account/preferences'],
  ['PUT', '/api/account/preferences'],
  ['GET', '/api/account/preferences/commands/11111111-1111-4111-8111-111111111166'],
  ['GET', '/api/account/preferences/not-a-route'],
  ['GET', '/api/account/delivery-preferences'],
  ['PUT', '/api/account/delivery-preferences'],
  ['GET', '/api/account/delivery-preferences/commands/11111111-1111-4111-8111-111111111170'],
  ['GET', '/api/account/delivery-preferences/not-a-route'],
  ['GET', '/api/account/%64elivery-preferences'],
  ['GET', '/api/account/%2564elivery-preferences'],
  ['GET', '/api/account/DELIVERY-PREFERENCES'],
  ['GET', '/api/account/delivery-preferences%2fcommands/11111111-1111-4111-8111-111111111170']
])('owns disabled private account %s %s without querying D1 or falling through to Node', async (method, path) => {
  const prepare = vi.fn(() => {
    throw new Error('unexpected_account_settings_db')
  })
  const response = await worker.fetch(new Request(origin + path, { method }), {
    APP_ENV: 'local',
    AUTH_ENABLED: 'false',
    DB: { prepare }
  } as unknown as CloudflareEnv)
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('vary')).toBe('Cookie')
  expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  expect(prepare).not.toHaveBeenCalled()
})

it('routes a current owner through real private request, receipt, list and download without Node fallback', async () => {
  const fixture = await returnsFixture()
  try {
    fixture.sqlite.exec(await readFile('db/d1/migrations/0065_account_privacy.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0070_delivery_preferences.sql', 'utf8'))
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/0071_account_security_notices.sql', 'utf8')).map((sql) =>
        fixture.database.prepare(sql)
      )
    )
    const configuration = { password: 'synthetic-account-settings-secret-over32', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      DB: fixture.database
    } as unknown as CloudflareEnv
    const key = '11111111-1111-4111-8111-111111111165'
    const request = (suffix = '', method = 'GET') =>
      new Request(origin + '/api/account/privacy' + suffix, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        ...(method === 'POST' ? { body: JSON.stringify({ requestType: 'export', idempotencyKey: key }) } : {})
      })
    const created = await worker.fetch(request('', 'POST'), env)
    expect(created.status).toBe(202)
    const receipt = (await created.json()) as { id: string; commandId: string }
    expect(receipt.commandId).toBe(key)
    expect(await (await worker.fetch(request('', 'POST'), env)).json()).toEqual(receipt)
    const recovered = await worker.fetch(request('/commands/' + key), env)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ outcome: 'applied', receipt })
    expect(await (await worker.fetch(request(), env)).json()).toMatchObject({ requests: [receipt] })
    const download = await worker.fetch(request('/' + receipt.id + '/download'), env)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="neteco-datos-${receipt.id}.json"`)
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    expect(await download.json()).toMatchObject({
      schemaVersion: 1,
      profile: { email: 'buyer@example.invalid' },
      securityNotices: []
    })
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 1 })
    expect((await worker.fetch(request('/not-a-route'), env)).status).toBe(404)
  } finally {
    fixture.sqlite.close()
  }
})

it('routes delivery preferences through the real Worker with exact hashed read-only receipt recovery', async () => {
  const fixture = await returnsFixture()
  try {
    fixture.sqlite.exec(await readFile('db/d1/migrations/0070_delivery_preferences.sql', 'utf8'))
    const configuration = { password: 'synthetic-delivery-preferences-secret-over32', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-delivery-preferences-pepper-more32',
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      DB: fixture.database
    } as unknown as CloudflareEnv
    const key = '11111111-1111-4111-8111-111111111170'
    const input = { expectedVersion: 0, deliveryUpdates: false, policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION }
    const hash = await deliveryPreferenceIntentHash(input)
    const request = (suffix = '', body?: unknown, payloadHash = hash) =>
      new Request(origin + '/api/account/delivery-preferences' + suffix, {
        method: body === undefined ? 'GET' : 'PUT',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'X-Neteco-Command-Payload-Hash': payloadHash,
          'CF-Connecting-IP': '192.0.2.170'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    const initial = await worker.fetch(request(), env)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({
      source: 'cloudflare',
      version: 0,
      deliveryUpdates: true,
      updatedAt: null
    })
    const applied = await worker.fetch(request('', input), env)
    expect(applied.status).toBe(200)
    const receipt = await applied.json()
    expect(receipt).toMatchObject({ commandId: key, version: 1, deliveryUpdates: false })
    expect(await (await worker.fetch(request('', input), env)).json()).toEqual(receipt)
    const before = fixture.sqlite.prepare('SELECT total_changes() n').get()
    expect(await (await worker.fetch(request('/commands/' + key), env)).json()).toMatchObject({
      outcome: 'applied',
      receipt
    })
    expect((await worker.fetch(request('/commands/' + key, undefined, 'a'.repeat(64)), env)).status).toBe(409)
    expect(await (await worker.fetch(request(), env)).json()).toMatchObject({ version: 1, deliveryUpdates: false })
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM delivery_preference_commands').get()).toEqual({ n: 1 })
    expect((await worker.fetch(request('/not-a-route'), env)).status).toBe(404)
  } finally {
    fixture.sqlite.close()
  }
})

it('routes preference CAS, exact replay and read-only receipt recovery through the real Worker', async () => {
  const fixture = await returnsFixture()
  try {
    fixture.sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
    const configuration = { password: 'synthetic-account-preferences-secret-over32', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(fixture.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-account-preferences-pepper-more32',
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      DB: fixture.database
    } as unknown as CloudflareEnv
    const key = '11111111-1111-4111-8111-111111111166'
    const request = (suffix = '', body?: unknown) =>
      new Request(origin + '/api/account/preferences' + suffix, {
        method: body ? 'PUT' : 'GET',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'CF-Connecting-IP': '192.0.2.166'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    const initial = await worker.fetch(request(), env)
    expect(initial.status).toBe(200)
    const snapshot = (await initial.json()) as { policyVersion: string }
    expect(snapshot).toMatchObject({ version: 0, preferences: { product_updates: false, replenishment: false } })
    const input = {
      expectedVersion: 0,
      policyVersion: snapshot.policyVersion,
      preferences: { product_updates: true, replenishment: false }
    }
    const applied = await worker.fetch(request('', input), env)
    expect(applied.status).toBe(200)
    const receipt = await applied.json()
    expect(receipt).toMatchObject({ commandId: key, expectedVersion: 0, version: 1, preferences: input.preferences })
    expect(await (await worker.fetch(request('', input), env)).json()).toEqual(receipt)
    const before = fixture.sqlite.prepare('SELECT total_changes() n').get()
    expect(await (await worker.fetch(request('/commands/' + key), env)).json()).toMatchObject({
      outcome: 'applied',
      receipt
    })
    expect(await (await worker.fetch(request(), env)).json()).toMatchObject({
      version: 1,
      preferences: input.preferences
    })
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 1 })
    expect((await worker.fetch(request('/not-a-route'), env)).status).toBe(404)
  } finally {
    fixture.sqlite.close()
  }
})
