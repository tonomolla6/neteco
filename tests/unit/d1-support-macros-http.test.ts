import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, ORIGIN, CLAIMS } from './d1-support-fixture'

describe('support macro HTTP authority and boundaries', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    f = await supportFixture()
    if (!f.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='support_macro_commands'").get())
      f.sqlite.exec(await readFile(new URL('../../db/d1/migrations/0060_support_macros.sql', import.meta.url), 'utf8'))
  })
  afterEach(() => f.sqlite.close())
  it('provides a private empty library and rejects customers, anonymous, non-MFA and cross-origin commands', async () => {
    const response = await f.request('/api/admin/support/macros')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ source: 'cloudflare', macros: [] })
    expect((await f.request('/api/admin/support/macros', 'GET', undefined, '')).status).toBe(401)
    expect((await f.request('/api/admin/support/macros', 'GET', undefined, f.customerCookie)).status).toBe(403)
    const cross = await f.dispatch(
      new Request(ORIGIN + '/api/admin/support/macros/' + crypto.randomUUID(), {
        method: 'PUT',
        headers: { cookie: f.adminCookie, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
        body: '{}'
      })
    )
    expect(cross.status).toBe(403)
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    expect((await f.request('/api/admin/support/macros')).status).toBe(403)
  })
  it('rejects malformed namespace, query injection, unsupported methods and unknown input', async () => {
    expect((await f.request('/api/admin/support/macros?customerId=x')).status).toBe(400)
    expect((await f.request('/api/admin/support/macros', 'DELETE', {})).status).toBe(405)
    expect(
      (
        await f.request('/api/admin/support/macros/' + crypto.randomUUID(), 'PUT', {
          action: 'approve',
          email: 'secret@example.invalid'
        })
      ).status
    ).toBe(422)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM support_macro_commands').get()).toEqual({ n: 0 })
  })
  it('validates private library and history cursors without falling through to ticket endpoints', async () => {
    expect((await f.request('/api/admin/support/macros?afterMacroId=not-a-uuid')).status).toBe(422)
    expect((await f.request('/api/admin/support/macros/' + crypto.randomUUID() + '?beforeVersion=2')).status).toBe(200)
    expect((await f.request('/api/admin/support/macros/' + crypto.randomUUID() + '?beforeVersion=0')).status).toBe(422)
    expect((await f.request('/api/admin/support/macros?beforeVersion=2')).status).toBe(400)
    const id = crypto.randomUUID()
    expect((await f.request('/api/admin/support/macros?afterMacroId=' + id + '&afterMacroId=' + id)).status).toBe(400)
    expect((await f.request('/api/admin/support/macros/' + id + '?beforeVersion=2&extra=x')).status).toBe(400)
  })
})
