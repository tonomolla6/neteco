import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { seedInventoryFixture, openAccountSecurityDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { preferenceSeeds, CLAIMS, OPTIONS, NOW, BEFORE } from './d1-account-preferences-fixture'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { PRODUCT_WATCH_POLICY_VERSION } from '../../shared/product-watch'
import {
  createD1ProductWatch,
  confirmD1ProductWatch,
  dispatchD1ProductWatchDeliveries
} from '../../workers/marketing/product-watch'
import { testUuid } from '../support/deterministic'

let f: { sqlite: Awaited<ReturnType<typeof openAccountSecurityDatabase>>; database: D1Database }
const pepper = 'synthetic-product-watch-runtime-hmac-0123456789abcdef'
const options = { ...OPTIONS, hmacKey: new TextEncoder().encode(pepper) }
let send: ReturnType<typeof vi.fn>
let outbound: ReturnType<typeof vi.spyOn>
let log: ReturnType<typeof vi.spyOn>
beforeEach(async () => {
  const sqlite = await openAccountSecurityDatabase()
  f = { sqlite, database: d1OverSqlite(sqlite) }
  try {
    for (const sql of preferenceSeeds()) sqlite.exec(sql)
    seedInventoryFixture(f.sqlite)
    await provisionPublicationValidityFixture(f.database, { productIds: ['p-1'], now: BEFORE })
    send = vi.fn(async () => ({ messageId: 'explicit-runtime-fake-acceptance' }))
    outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_forbidden'))
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  } catch (cause) {
    f.sqlite.close()
    throw cause
  }
})
afterEach(() => {
  f?.sqlite.close()
  vi.restoreAllMocks()
})
function env(overrides: Record<string, unknown> = {}) {
  return environment({
    DB: f.database,
    AUTH_ENABLED: 'true',
    AUTH_TOKEN_PEPPER: pepper,
    AUTH_ORIGIN: 'https://preprod.neteco.es',
    PRODUCT_WATCH_ENABLED: 'true',
    PRODUCT_WATCH_DELIVERY_ENABLED: 'false',
    NEWSLETTER_EMAIL: { send },
    NEWSLETTER_EMAIL_FROM: 'newsletter@neteco.es',
    ASYNC_JOBS: { send: vi.fn(async () => undefined) },
    EMAIL: { send: vi.fn() },
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    AUTH_EMAIL_ENABLED: 'false',
    NEWSLETTER_ENABLED: 'false',
    ...overrides
  })
}
const tick = (runtime = env()) => worker.scheduled({ scheduledTime: Date.parse(NOW) } as ScheduledController, runtime)
async function pending() {
  return createD1ProductWatch(
    f.database,
    CLAIMS,
    { variantId: 11, kind: 'price_drop', consent: true, policyVersion: PRODUCT_WATCH_POLICY_VERSION },
    testUuid(),
    options
  )
}
async function confirmedPriceDrop() {
  await updateD1AccountPreferences(
    f.database,
    CLAIMS,
    testUuid(),
    {
      expectedVersion: 0,
      preferences: { product_updates: true, replenishment: true },
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
    },
    OPTIONS
  )
  const receipt = await pending()
  let token: string | undefined
  await dispatchD1ProductWatchDeliveries(
    f.database,
    {
      async send(message) {
        token = message.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0]
        return { messageId: 'explicit-confirmation-fixture' }
      }
    },
    { ...options, origin: 'https://product-watch.example.invalid' }
  )
  expect(token).toBeDefined()
  await confirmD1ProductWatch(f.database, CLAIMS, receipt.watchId, { expectedVersion: 1, token }, testUuid(), options)
  f.sqlite
    .prepare(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
    VALUES(?,'v-1-1',400,'[]',?,'approved','Synthetic scheduled governed price drop',?)`
    )
    .run(testUuid(), BEFORE, BEFORE)
}
it('the actual scheduled Worker evaluates committed watches and persists one obligation without sending while delivery is OFF', async () => {
  await confirmedPriceDrop()
  await tick()
  await tick()
  expect(
    f.sqlite
      .prepare(
        "SELECT kind,status,count(*) n FROM product_watch_deliveries WHERE kind='price_drop' GROUP BY kind,status"
      )
      .all()
  ).toEqual([{ kind: 'price_drop', status: 'pending', n: 1 }])
  expect(send).not.toHaveBeenCalled()
  expect(outbound).not.toHaveBeenCalled()
})
it.each([{ PRODUCT_WATCH_ENABLED: 'false' }, { AUTH_ENABLED: 'false' }])(
  'does not touch watch tables or its provider without both authorities: %j',
  async (overrides) => {
    await pending()
    const prepare = vi.spyOn(f.database, 'prepare')
    await tick(env(overrides))
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('product_watch'))).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  }
)
it('hands a pending confirmation only to the explicitly opted-in marketing binding and persists its actual acceptance', async () => {
  await pending()
  const runtime = env({
    APP_ENV: 'preprod',
    PRODUCT_WATCH_DELIVERY_ENABLED: 'true',
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: '["preferences@example.invalid"]'
  })
  await tick(runtime)
  await tick(runtime)
  expect(send).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      from: 'newsletter@neteco.es',
      to: 'preferences@example.invalid',
      text: expect.stringContaining('/cuenta/avisos-productos#watchId=')
    })
  )
  expect(f.sqlite.prepare('SELECT status,provider_message_id FROM product_watch_deliveries').get()).toEqual({
    status: 'sent',
    provider_message_id: 'explicit-runtime-fake-acceptance'
  })
  expect(outbound).not.toHaveBeenCalled()
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/pw1\.|preferences@example|synthetic-product-watch-runtime-hmac/)
})
it('an ambiguous adapter acceptance goes to manual review and is not resent on the next scheduled invocation', async () => {
  await pending()
  send.mockResolvedValue(undefined)
  const runtime = env({
    APP_ENV: 'preprod',
    PRODUCT_WATCH_DELIVERY_ENABLED: 'true',
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: '["preferences@example.invalid"]'
  })
  await tick(runtime)
  await tick(runtime)
  expect(send).toHaveBeenCalledOnce()
  expect(f.sqlite.prepare('SELECT status FROM product_watch_deliveries').get()).toEqual({ status: 'manual_review' })
})
it.each([
  { APP_ENV: 'local' },
  { APP_ENV: 'preprod', PRODUCT_WATCH_ALLOWED_RECIPIENTS: '[]' },
  {
    APP_ENV: 'preprod',
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: '["preferences@example.invalid"]',
    AUTH_ORIGIN: 'https://shop.example.invalid'
  },
  {
    APP_ENV: 'preprod',
    PRODUCT_WATCH_ALLOWED_RECIPIENTS: '["preferences@example.invalid"]',
    AUTH_TOKEN_PEPPER: 'short'
  }
])('fails a misconfigured delivery stage closed without invoking a provider: %j', async (overrides) => {
  await pending()
  await expect(tick(env({ PRODUCT_WATCH_DELIVERY_ENABLED: 'true', ...overrides }))).rejects.toThrow(
    /scheduled_jobs_failed:.*product-watches/
  )
  expect(send).not.toHaveBeenCalled()
  expect(outbound).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT status FROM product_watch_deliveries').get()).toEqual({ status: 'pending' })
})
