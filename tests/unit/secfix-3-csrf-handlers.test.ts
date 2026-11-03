import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerRecurringListsHttp } from '../../workers/catalog/customer-recurring-lists-http'
import { handleUgcReviewsHttp } from '../../workers/media/ugc-reviews-http'

const now = '2026-10-29T12:00:00Z'
const origin = 'https://shop.example.invalid'
const identity = '10000000-0000-4000-8000-0000000000a1'
const session = '20000000-0000-4000-8000-0000000000a1'
const config = { password: 'q'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec(`
    INSERT INTO customers(id,created_at,updated_at) VALUES('customer','${now}','${now}');
    INSERT INTO identities(id,email,customer_id,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES('${identity}','c@example.invalid','customer','x','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES('${session}','${identity}',1,0,'${now}','2026-10-30T12:00:00Z');
  `)
  database = d1OverSqlite(sqlite)
  cookie = (await issueD1SessionCookie(
    database,
    { identityId: identity, sessionId: session, sessionVersion: 1 },
    config
  ))!
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

describe('SECFIX-3 mutation origin and session checks', () => {
  it.each(['https://evil.invalid', 'null', ''])('blocks recurring-list mutation with origin %s', async (sentOrigin) => {
    const response = await handleCustomerRecurringListsHttp(
      new Request(`${origin}/api/account/recurring-lists`, {
        method: 'POST',
        headers: { cookie, ...(sentOrigin ? { origin: sentOrigin } : {}) },
        body: JSON.stringify({ name: 'List' })
      }),
      { database, sessionCookieConfiguration: config }
    )
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it.each(['/api/products/p1/ugc-reviews', '/api/ugc-reviews/r1/withdraw'])(
    'blocks cross-origin and missing-origin UGC writes to %s',
    async (path) => {
      for (const sentOrigin of ['https://evil.invalid', '']) {
        const response = await handleUgcReviewsHttp(
          new Request(`${origin}${path}`, {
            method: 'POST',
            headers: sentOrigin ? { origin: sentOrigin } : {},
            body: '{}'
          }),
          { database, sessionProvider: async () => ({ identityId: identity }) }
        )
        expect(response?.status).toBe(403)
        expect(await response?.json()).toEqual({ error: { code: 'csrf_rejected' } })
      }
    }
  )

  it('rejects a revoked recurring-list session before evaluating input', async () => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, session)
    const response = await handleCustomerRecurringListsHttp(
      new Request(`${origin}/api/account/recurring-lists`, {
        method: 'POST',
        headers: { cookie, origin },
        body: '{}'
      }),
      { database, sessionCookieConfiguration: config }
    )
    expect(response?.status).toBe(401)
  })
})
