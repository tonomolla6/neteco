import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import { preferenceSeeds, NOW, CUSTOMER, ACTOR, SESSION, CLAIMS } from './d1-account-preferences-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAccountPreferencesHttp } from '../../workers/auth/account-preferences-http'
import { handleAccountPrivacyHttp } from '../../workers/auth/account-privacy-http'
import { handleDeliveryPreferencesRequest } from '../../workers/auth/delivery-preferences-http'
import { DELIVERY_PREFERENCES_POLICY_VERSION, deliveryPreferenceIntentHash } from '../../shared/delivery-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  ACCOUNT_SETTINGS_BROWSER_SCENARIOS,
  auditNativeAccountSettingsBrowser,
  createAccountSettingsBrowserBridge
} from '../../scripts/lib/audit-native-account-settings-browser'
const connection = vi.hoisted(() => vi.fn())
vi.mock('../../scripts/lib/remote-test-browser', () => ({
  connectRemoteTestBrowser: connection,
  REMOTE_BROWSER_NOT_RUN_REASON: 'explicitly not run'
}))
const origin = 'https://shop-audit.neteco.test',
  configuration = { password: 'synthetic-settings-cookie-secret-more32', maxAgeSeconds: 3600 },
  key = deterministicUuid('settings-preference-command'),
  privacyKey = deterministicUuid('settings-privacy-command'),
  body = {
    expectedVersion: 0,
    preferences: { product_updates: true, replenishment: true },
    policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
  },
  deliveryKey = deterministicUuid('settings-delivery-preference-command'),
  deliveryBody = { expectedVersion: 0, deliveryUpdates: false, policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION }
let sqlite: Awaited<ReturnType<typeof openMigratedDatabase>>,
  database: D1Database,
  cookie: string,
  dispatch: (request: Request) => Promise<Response>
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  sqlite = await openMigratedDatabase()
  for (const name of [
    '0063_order_annotations.sql',
    '0064_company_admin_review.sql',
    '0065_account_privacy.sql',
    '0066_account_preferences.sql',
    '0070_delivery_preferences.sql'
  ])
    sqlite.exec(await readFile('db/d1/migrations/' + name, 'utf8'))
  for (const sql of preferenceSeeds()) sqlite.exec(sql)
  for (const sql of preferenceSeeds())
    sqlite.exec(
      sql
        .replaceAll(CUSTOMER, deterministicUuid('settings-foreign-customer'))
        .replaceAll(ACTOR, deterministicUuid('settings-foreign-identity'))
        .replaceAll(SESSION, deterministicUuid('settings-foreign-session'))
        .replaceAll('preferences@example.invalid', 'foreign-owner-marker@example.invalid')
    )
  database = d1OverSqlite(sqlite)
  await database.batch(
    splitDemoSql(await readFile('db/d1/migrations/0071_account_security_notices.sql', 'utf8')).map((sql) =>
      database.prepare(sql)
    )
  )
  cookie = (await issueD1SessionCookie(database, CLAIMS, configuration))!.split(';')[0]!
  dispatch = async (request) => {
    const deps = {
      database,
      origin,
      sessionCookieConfiguration: configuration,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-settings-edge-pepper-more32',
      now: () => NOW
    }
    return (
      (await handleDeliveryPreferencesRequest(request, deps)) ??
      (await handleAccountPreferencesHttp(request, deps)) ??
      (await handleAccountPrivacyHttp(request, deps)) ??
      new Response(null, { status: 404 })
    )
  }
  connection.mockReset()
})
afterEach(() => {
  sqlite?.close()
  vi.useRealTimers()
})
const owner = () => ({
  ownerCookie: cookie,
  customerId: CUSTOMER,
  identityId: ACTOR,
  ownerEmail: 'preferences@example.invalid',
  forbiddenValues: ['foreign-owner-marker@example.invalid']
})
const request = (path: string, method = 'GET', value?: unknown, commandId = key) =>
  new Request(origin + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'CF-Connecting-IP': '192.0.2.165',
      'Content-Type': 'application/json',
      'Idempotency-Key': commandId
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) })
  })
const setup = (override: Partial<{ dispatch: typeof dispatch }> = {}) =>
  createAccountSettingsBrowserBridge({ origin, database, dispatch, ...owner(), ...override })
async function recover(bridge: Awaited<ReturnType<typeof setup>>) {
  await bridge.forward(request('/api/account/preferences/commands/' + key))
  await bridge.forward(request('/api/account/preferences'))
}
async function recoverDelivery(bridge: Awaited<ReturnType<typeof setup>>) {
  const receipt = request('/api/account/delivery-preferences/commands/' + deliveryKey)
  receipt.headers.set('X-Neteco-Command-Payload-Hash', await deliveryPreferenceIntentHash(deliveryBody))
  await bridge.forward(receipt)
  await bridge.forward(request('/api/account/delivery-preferences'))
}
async function changeDelivery(bridge: Awaited<ReturnType<typeof setup>>) {
  expect(await bridge.forward(request('/api/account/delivery-preferences', 'PUT', deliveryBody, deliveryKey))).toEqual({
    action: 'abort',
    reason: 'proven_delivery_preference_response_lost'
  })
  await recoverDelivery(bridge)
}
it('preserves ordinary extra cookies throughout the real settings recovery and privacy export journey', async () => {
  const observed = vi.fn(dispatch)
  const bridge = await setup({ dispatch: observed })
  cookie = `neteco-consent=necessary; ${cookie}; neteco-cart-v2=synthetic-cart`
  const forward = async (candidate: Request) => {
    const result = await bridge.forward(candidate)
    expect(observed.mock.calls.some(([sent]) => sent === candidate)).toBe(true)
    expect(candidate.headers.get('cookie')).toBe(cookie)
    return result
  }
  expect(await forward(request('/api/account/preferences', 'PUT', body))).toEqual({
    action: 'abort',
    reason: 'proven_preference_response_lost'
  })
  await forward(request('/api/account/preferences/commands/' + key))
  await forward(request('/api/account/preferences'))
  expect(bridge.state().recovered).toBe(true)
  expect(await forward(request('/api/account/delivery-preferences', 'PUT', deliveryBody, deliveryKey))).toEqual({
    action: 'abort',
    reason: 'proven_delivery_preference_response_lost'
  })
  const recovery = request('/api/account/delivery-preferences/commands/' + deliveryKey)
  recovery.headers.set('X-Neteco-Command-Payload-Hash', await deliveryPreferenceIntentHash(deliveryBody))
  await forward(recovery)
  await forward(request('/api/account/delivery-preferences'))
  expect(bridge.state().deliveryRecovered).toBe(true)
  const posted = await forward(
    request('/api/account/privacy', 'POST', { requestType: 'export', idempotencyKey: privacyKey }, privacyKey)
  )
  if (posted.action !== 'fulfill') throw new Error('expected real privacy receipt')
  expect(posted.response.status).toBe(202)
  const receipt = (await posted.response.json()) as { id: string }
  await forward(request('/api/account/privacy'))
  const download = await forward(request(`/api/account/privacy/${receipt.id}/download`))
  if (download.action !== 'fulfill') throw new Error('expected real privacy download')
  expect(await download.response.json()).toMatchObject({
    accountPreferences: { version: 1, product_updates: true, replenishment: true },
    deliveryPreferences: { version: 1, deliveryUpdates: false }
  })
  expect(await bridge.assertComplete()).toMatchObject({
    preferencePuts: 1,
    deliveryPuts: 1,
    privacyPosts: 1,
    downloads: 1
  })
})
it.each(['foreign', 'duplicate-same', 'duplicate-foreign', 'absent'])(
  'rejects %s session cookies before any settings mutation dispatch',
  async (kind) => {
    const observed = vi.fn(dispatch)
    const bridge = await setup({ dispatch: observed })
    const original = cookie
    const candidateCookie =
      kind === 'foreign'
        ? 'neteco-session=foreign'
        : kind === 'duplicate-same'
          ? `${original}; ${original}`
          : kind === 'duplicate-foreign'
            ? `${original}; neteco-session=foreign`
            : 'neteco-consent=necessary; neteco-cart-v2=synthetic-cart'
    for (const candidate of [
      request('/api/account/preferences', 'PUT', body),
      request('/api/account/delivery-preferences', 'PUT', deliveryBody, deliveryKey),
      request('/api/account/privacy', 'POST', { requestType: 'export', idempotencyKey: privacyKey }, privacyKey)
    ]) {
      candidate.headers.set('cookie', candidateCookie)
      observed.mockClear()
      expect((await bridge.forward(candidate)).action).toBe('abort')
      expect(observed).not.toHaveBeenCalled()
    }
    expect(bridge.state()).toMatchObject({ preferencePuts: 0, deliveryPuts: 0, privacyPosts: 0 })
  }
)
it('uses verbatim real migrations and loses only proven committed responses, then recovers/export bytes', async () => {
  const bridge = await setup()
  const initial = await bridge.forward(request('/api/account/preferences'))
  expect(initial.action).toBe('fulfill')
  const lost = await bridge.forward(request('/api/account/preferences', 'PUT', body))
  expect(lost).toEqual({ action: 'abort', reason: 'proven_preference_response_lost' })
  expect(
    sqlite.prepare('SELECT version,product_updates,replenishment FROM customer_account_preferences').get()
  ).toEqual({
    version: 1,
    product_updates: 1,
    replenishment: 1
  })
  expect(bridge.state()).toMatchObject({ preferencePuts: 1, lostResponses: 1, recovered: false })
  const privacyBody = { requestType: 'export', idempotencyKey: privacyKey }
  expect((await bridge.forward(request('/api/account/privacy', 'POST', privacyBody, privacyKey))).action).toBe('abort')
  expect(sqlite.prepare('SELECT count(*) n FROM account_privacy_requests').get()).toEqual({ n: 0 })
  await recover(bridge)
  expect(bridge.state().recovered).toBe(true)
  await changeDelivery(bridge)
  const posted = await bridge.forward(request('/api/account/privacy', 'POST', privacyBody, privacyKey))
  expect(posted.action).toBe('fulfill')
  if (posted.action !== 'fulfill') throw new Error('expected real HTTP export request')
  expect(posted.response.status).toBe(202)
  const receipt = (await posted.response.clone().json()) as { id: string }
  await bridge.forward(request('/api/account/privacy'))
  const downloaded = await bridge.forward(request(`/api/account/privacy/${receipt.id}/download`))
  expect(downloaded.action).toBe('fulfill')
  if (downloaded.action !== 'fulfill') throw new Error('expected real download')
  expect(downloaded.response.headers.get('content-disposition')).toContain('attachment;')
  expect(await downloaded.response.clone().json()).toMatchObject({
    profile: { email: 'preferences@example.invalid' },
    accountPreferences: { version: 1, product_updates: true, replenishment: true },
    deliveryPreferences: { version: 1, deliveryUpdates: false },
    securityNotices: []
  })
  expect(await bridge.assertComplete()).toMatchObject({ preferencePuts: 1, privacyPosts: 1, downloads: 1 })
})
it('rejects a foreign security notice injected into otherwise real authorized export bytes', async () => {
  const bridge = await setup({
    dispatch: async (request) => {
      const response = await dispatch(request)
      if (!new URL(request.url).pathname.endsWith('/download') || response.status !== 200) return response
      const document = (await response.json()) as { securityNotices: unknown[] }
      // Adversarial response corruption, not an invented D1 event or positive acceptance fixture.
      document.securityNotices.push({
        kind: 'email_changed',
        recipient: 'another-owner@example.invalid',
        audience: 'previous',
        createdAt: NOW
      })
      return Response.json(document, { headers: response.headers })
    }
  })
  await bridge.forward(request('/api/account/preferences', 'PUT', body))
  await recover(bridge)
  await changeDelivery(bridge)
  const result = await bridge.forward(
    request('/api/account/privacy', 'POST', { requestType: 'export', idempotencyKey: privacyKey }, privacyKey)
  )
  if (result.action !== 'fulfill') throw new Error('expected real export receipt')
  const receipt = (await result.response.json()) as { id: string }
  await bridge.forward(request('/api/account/privacy'))
  await expect(bridge.forward(request(`/api/account/privacy/${receipt.id}/download`))).rejects.toThrow()
})
it('recovers a proven delivery opt-out without a second PUT or changing marketing consent', async () => {
  const bridge = await setup()
  await changeDelivery(bridge)
  expect(bridge.state()).toMatchObject({ deliveryPuts: 1, deliveryLostResponses: 1, deliveryRecovered: true })
  expect(sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 0 })
  const before = sqlite.prepare('SELECT total_changes() n').get()
  expect(
    (await bridge.forward(request('/api/account/delivery-preferences', 'PUT', deliveryBody, deliveryKey))).action
  ).toBe('abort')
  expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it('does not accept a delivery snapshot as proof of the lost command without a matching hash receipt', async () => {
  const bridge = await setup()
  await bridge.forward(request('/api/account/delivery-preferences', 'PUT', deliveryBody, deliveryKey))
  await bridge.forward(request('/api/account/delivery-preferences'))
  expect(bridge.state().deliveryRecovered).toBe(false)
  const wrong = request('/api/account/delivery-preferences/commands/' + deliveryKey)
  wrong.headers.set('X-Neteco-Command-Payload-Hash', 'a'.repeat(64))
  const result = await bridge.forward(wrong)
  expect(result.action).toBe('abort')
  expect(bridge.state().deliveryRecovered).toBe(false)
})
it('does not inject transport loss before the independent real receipt GET succeeds', async () => {
  const bridge = await setup({
    dispatch: async (r) => (r.url.includes('/commands/') ? new Response(null, { status: 503 }) : dispatch(r))
  })
  await expect(bridge.forward(request('/api/account/preferences', 'PUT', body))).rejects.toThrow()
  expect(bridge.state().lostResponses).toBe(0)
  expect(sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 1 })
})
it('never dispatches a second PUT after the proven commit even with identical payload/key', async () => {
  const bridge = await setup()
  await bridge.forward(request('/api/account/preferences', 'PUT', body))
  const before = sqlite.prepare('SELECT total_changes() n').get()
  expect((await bridge.forward(request('/api/account/preferences', 'PUT', body))).action).toBe('abort')
  expect(bridge.state().preferencePuts).toBe(1)
  expect(sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
})
it.each(['external', 'wrong-cookie', 'other-write', 'wrong-body', 'query', 'bad-key'])(
  'blocks %s before dispatch or consent writes',
  async (kind) => {
    const observed = vi.fn(dispatch)
    const bridge = await setup({ dispatch: observed })
    const r = request('/api/account/preferences', 'PUT', body)
    let candidate = r
    if (kind === 'external') candidate = new Request('https://foreign.invalid/api/account/preferences', r)
    if (kind === 'wrong-cookie') candidate.headers.set('cookie', 'neteco-session=other')
    if (kind === 'other-write') candidate = request('/api/account/newsletter/preferences', 'PUT', body)
    if (kind === 'wrong-body') candidate = request('/api/account/preferences', 'PUT', { ...body, expectedVersion: 1 })
    if (kind === 'query') candidate = request('/api/account/preferences?x=1', 'PUT', body)
    if (kind === 'bad-key') candidate.headers.set('idempotency-key', 'not-a-uuid')
    observed.mockClear()
    expect((await bridge.forward(candidate)).action).toBe('abort')
    expect(observed).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toEqual({ n: 0 })
  }
)
it('refuses loss when actual PUT is forbidden and never asserts recovery without the browser receipt read', async () => {
  const bridge = await setup()
  sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ACTOR)
  const result = await bridge.forward(request('/api/account/preferences', 'PUT', body))
  expect(result.action).toBe('fulfill')
  if (result.action === 'fulfill') expect(result.response.status).toBe(403)
  expect(bridge.state().lostResponses).toBe(0)
  expect(bridge.state().recovered).toBe(false)
  await expect(bridge.assertComplete()).rejects.toThrow()
})
it('does not treat fresh preferences alone as receipt recovery', async () => {
  const bridge = await setup()
  await bridge.forward(request('/api/account/preferences', 'PUT', body))
  await bridge.forward(request('/api/account/preferences'))
  expect(bridge.state().recovered).toBe(false)
})
it.each(['receipt', 'current'])('rejects a mismatched real %s recovery response', async (kind) => {
  let corrupt = false
  const bridge = await setup({
    dispatch: async (r) => {
      const response = await dispatch(r)
      if (!corrupt || r.method !== 'GET' || response.status !== 200) return response
      if (kind === 'receipt' && r.url.includes('/commands/')) {
        const value = (await response.clone().json()) as { commandId: string; receipt: { commandId: string } }
        value.commandId = value.receipt.commandId = deterministicUuid('settings-wrong-receipt')
        return Response.json(value, { headers: response.headers })
      }
      if (kind === 'current' && new URL(r.url).pathname === '/api/account/preferences') {
        const value = (await response.clone().json()) as { version: number }
        value.version++
        return Response.json(value, { headers: response.headers })
      }
      return response
    }
  })
  await bridge.forward(request('/api/account/preferences', 'PUT', body))
  corrupt = true
  await expect(recover(bridge)).rejects.toThrow()
  expect(bridge.state().recovered).toBe(false)
})
it('preserves existing foreign consent history and detects changes to send sources after completion', async () => {
  const foreignClaims = {
    identityId: deterministicUuid('settings-foreign-identity'),
    sessionId: deterministicUuid('settings-foreign-session'),
    sessionVersion: 1
  }
  const foreignCookie = (await issueD1SessionCookie(database, foreignClaims, configuration))!.split(';')[0]!
  const foreign = request('/api/account/preferences', 'PUT', body)
  foreign.headers.set('cookie', foreignCookie)
  expect((await dispatch(foreign)).status).toBe(200)
  const existing = sqlite.prepare('SELECT * FROM account_preference_commands').all()
  const bridge = await setup()
  await bridge.forward(request('/api/account/preferences', 'PUT', body))
  await recover(bridge)
  await changeDelivery(bridge)
  const result = await bridge.forward(
    request(
      '/api/account/privacy',
      'POST',
      {
        requestType: 'export',
        idempotencyKey: privacyKey
      },
      privacyKey
    )
  )
  if (result.action !== 'fulfill') throw new Error('expected real export receipt')
  const receipt = (await result.response.clone().json()) as { id: string }
  await bridge.forward(request('/api/account/privacy'))
  await bridge.forward(request(`/api/account/privacy/${receipt.id}/download`))
  await bridge.assertComplete()
  expect(sqlite.prepare('SELECT * FROM account_preference_commands WHERE customer_id<>?').all(CUSTOMER)).toEqual(
    existing
  )
  // Actual source rows, not a fabricated provider response or permission seed.
  sqlite
    .prepare('INSERT INTO newsletter_suppressions(email_hash,reason,source,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('a'.repeat(64), 'unsubscribe', 'account', Date.parse(NOW) / 1000, Date.parse(NOW) / 1000)
  await expect(bridge.assertComplete()).rejects.toThrow('No sends, newsletter, inventory or money source changes')
})
it('NOTRUN emits zero scenarios without connecting, preparing an owner, or reading D1', async () => {
  const prepareOwner = vi.fn(),
    scenario = vi.fn(),
    prepare = vi.fn(() => {
      throw new Error('unexpected database access')
    })
  const result = await auditNativeAccountSettingsBrowser({
    origin,
    database: { prepare } as unknown as D1Database,
    dispatch,
    prepareOwner,
    scenario,
    browserMode: 'not-run'
  })
  expect(result).toMatchObject({ scenarios: 0, browserExecuted: false, viewports: [] })
  expect(prepareOwner).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(connection).not.toHaveBeenCalled()
  expect(scenario).not.toHaveBeenCalled()
  expect(ACCOUNT_SETTINGS_BROWSER_SCENARIOS).toHaveLength(2)
})
it('required mode fails closed on unavailable private browser before preparing fixtures', async () => {
  connection.mockRejectedValue(new Error('private browser unavailable'))
  const prepareOwner = vi.fn()
  await expect(auditNativeAccountSettingsBrowser({ origin, database, dispatch, prepareOwner })).rejects.toThrow(
    'private browser unavailable'
  )
  expect(prepareOwner).not.toHaveBeenCalled()
  expect(connection).toHaveBeenCalledTimes(1)
})
