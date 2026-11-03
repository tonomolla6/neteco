import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import worker from '../../workers/canary'

// SECFIX-3 finding 25: the global mutation guard let cross-site requests without an Origin header through.
describe('SECFIX-3 canary crossOriginMutation', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => sqlite.close())

  const env = () =>
    ({
      APP_ENV: 'canary',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://canary.neteco.invalid',
      NUXT_SESSION_PASSWORD: 'synthetic-canary-csrf-cookie-password-at-least-32-characters',
      AUTH_RATE_LIMIT_PEPPER: 'p'.repeat(40),
      DB: db,
      CACHE: { get: vi.fn(), put: vi.fn() },
      MEDIA: { get: vi.fn(), put: vi.fn() },
      ASYNC_JOBS: { send: vi.fn() },
      CART_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) },
      ADMIN_EDGE_LIMIT: { limit: vi.fn().mockResolvedValue({ success: true }) }
    }) as unknown as CloudflareEnv

  const post = (headers: Record<string, string>) =>
    worker.fetch!(
      new Request('https://canary.neteco.invalid/api/account/recurring-lists', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1', 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'CSRF List' })
      }),
      env()
    )

  it('rejects a cross-site mutation that omits Origin (sec-fetch-site: cross-site)', async () => {
    const response = await post({ 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it('rejects a mutation without Origin whose Referer is another origin', async () => {
    const response = await post({ referer: 'https://evil.example/form.html' })
    expect(response.status).toBe(403)
  })

  it('rejects Origin: null', async () => {
    expect((await post({ origin: 'null' })).status).toBe(403)
  })

  it('rejects a session-bearing mutation without Origin, Referer or Fetch Metadata', async () => {
    const response = await post({ cookie: 'neteco-session=synthetic' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it('still lets same-origin and header-less server calls reach the module (401 without session)', async () => {
    expect((await post({ origin: 'https://canary.neteco.invalid', 'sec-fetch-site': 'same-origin' })).status).toBe(401)
    expect((await post({})).status).toBe(401)
  })
})
