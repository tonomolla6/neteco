import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'

const origin = 'https://inventory-alerts-runtime.neteco.test'
const password = 'synthetic-alerts-runtime-session-password-more-than-32'
// Actual entrypoints use D1's authoritative clock for the final grant check.
// Relative fixtures must use that clock too, not a JS-only historical fake.
const instant = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>
let cookie: string

function environment(overrides: Record<string, unknown> = {}): CloudflareEnv {
  return {
    APP_ENV: 'local',
    DB: fixture.database,
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: password,
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-alerts-runtime-pepper-more-than-32',
    ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    ASYNC_JOBS: { send: vi.fn(async () => undefined) },
    MEDIA: {},
    EMAIL: { send: vi.fn() },
    NEWSLETTER_EMAIL: { send: vi.fn() },
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    AUTH_EMAIL_ENABLED: 'false',
    NEWSLETTER_ENABLED: 'false',
    ...overrides
  } as unknown as CloudflareEnv
}

function request(path: string) {
  return new Request(origin + path, {
    headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.68' }
  })
}

function stockSnapshot() {
  return ['inventory_balances', 'inventory_movements', 'inventory_reservations', 'inventory_reservation_lines'].map(
    (table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  )
}

beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  // The shared fixture deliberately applies 0001–0062. Only this feature's
  // incremental schema is added here; native tests apply all 67 migrations.
  fixture.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0067_inventory_alerts.sql', import.meta.url), 'utf8')
  )
  cookie = (await issueD1SessionCookie(
    fixture.database,
    { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 },
    { password, maxAgeSeconds: 3600 }
  ))!.split(';')[0]!
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_forbidden'))
})

afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})

describe('inventory alerts actual Worker entrypoints', () => {
  it('mounts the private alerts handler before the legacy inventory namespace without stealing legacy reads', async () => {
    const alerts = await worker.fetch(request('/api/admin/inventory/alerts'), environment())
    expect(await alerts.clone().json()).toMatchObject({ source: 'cloudflare' })
    expect(alerts.status).toBe(200)
    expect(alerts.headers.get('cache-control')).toBe('private, no-store')
    expect(await alerts.json()).toMatchObject({ source: 'cloudflare', items: [], lastEvaluationAt: null })
    const legacy = await worker.fetch(request('/api/admin/inventory/variants/11'), environment())
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toMatchObject({ source: 'cloudflare', variant: { id: 11 } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps authentication-off requests closed before touching D1 or the edge limiter', async () => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_database')
    })
    const limit = vi.fn(() => {
      throw new Error('unexpected_edge')
    })
    const response = await worker.fetch(
      request('/api/admin/inventory/alerts'),
      environment({ AUTH_ENABLED: 'false', DB: { prepare }, ADMIN_EDGE_LIMIT: { limit } })
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(prepare).not.toHaveBeenCalled()
    expect(limit).not.toHaveBeenCalled()
  })

  it.each([
    ['true', undefined, 0],
    ['true', 'false', 0],
    ['false', 'true', 0],
    ['true', 'true', 1]
  ])('evaluates only under explicit auth=%s and alerts=%s activation', async (auth, enabled, expected) => {
    // Controlled pre-existing divergence, not an alert operation changing stock.
    fixture.sqlite.exec('UPDATE inventory_balances SET physical_quantity=21,version=version+1')
    const before = stockSnapshot()
    await worker.scheduled(
      { scheduledTime: Date.parse(instant) } as ScheduledController,
      environment({ AUTH_ENABLED: auth, INVENTORY_ALERTS_ENABLED: enabled })
    )
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_alert_episodes').get()!.n).toBe(expected)
    if (expected) {
      expect(fixture.sqlite.prepare('SELECT kind,state FROM inventory_alert_episodes').get()).toMatchObject({
        kind: 'anomaly',
        state: 'open'
      })
      expect(fixture.sqlite.prepare('SELECT source FROM inventory_alert_commands').get()!.source).toBe('cron')
    }
    expect(stockSnapshot()).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let a fiscal failure starve inventory evaluation and still rejects the failed scheduled invocation', async () => {
    fixture.sqlite.exec('UPDATE inventory_balances SET physical_quantity=21,version=version+1')
    const before = stockSnapshot()
    const prepare = fixture.database.prepare.bind(fixture.database)
    const database = {
      ...fixture.database,
      prepare(sql: string) {
        if (sql.includes('fiscal_outbox_delivery')) throw new Error('synthetic_fiscal_failure')
        return prepare(sql)
      }
    } as D1Database
    await expect(
      worker.scheduled(
        { scheduledTime: Date.parse(instant) } as ScheduledController,
        environment({ DB: database, INVENTORY_ALERTS_ENABLED: 'true' })
      )
    ).rejects.toThrow('scheduled_jobs_failed:fiscal.outbox')
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_alert_episodes').get()!.n).toBe(1)
    expect(stockSnapshot()).toEqual(before)
    expect(fetch).not.toHaveBeenCalled()
  })
})
