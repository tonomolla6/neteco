import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { createUiStatePostgresSession } from '../support/ui-state-postgres-session'

const mocks = vi.hoisted(() => ({ sql: vi.fn(), end: vi.fn(), postgres: vi.fn(), decrypt: vi.fn() }))
vi.mock('postgres', () => ({ default: mocks.postgres }))
vi.mock('../../server/utils/secrets', () => ({ decryptSecret: mocks.decrypt }))
const origin = 'http://127.0.0.1:3100'
const connection = 'postgres://fixture:fixture@127.0.0.1:5432/neteco_it_ui_state_fixture'
const identityId = '11111111-1111-4111-8111-111111111111'

function fixture(audience: 'admin' | 'customer' = 'admin') {
  let logins = 0,
    completions = 0
  const calls: string[] = []
  const request = {
    post: vi.fn(async (path: string, options: { data: Record<string, unknown>; headers: Record<string, string> }) => {
      calls.push(path)
      expect(new URL(path).origin).toBe(origin)
      expect(options.headers.origin).toBe(origin)
      const route = new URL(path).pathname
      let status = route === '/api/auth/register' ? 201 : 200
      let body: unknown = { ok: true }
      if (route === '/api/auth/login')
        body =
          ++logins > 1
            ? { mfaRequired: true, challenge: 'opaque-HTTP-issued-MFA-challenge' }
            : { user: { id: identityId, emailVerified: true, mfaVerified: false } }
      if (route === '/api/auth/mfa/setup')
        body = { manualKey: 'JBSWY3DPEHPK3PXP', recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] }
      if (route === '/api/auth/mfa/complete') {
        if (++completions === 1) body = { user: { id: identityId, emailVerified: true, mfaVerified: true } }
        else status = 400
      }
      return { status: () => status, json: async () => body }
    }),
    storageState: vi.fn(async () => ({
      cookies: [{ name: 'neteco-session', value: 'issued-by-auth-HTTP', domain: '127.0.0.1', path: '/' }],
      origins: []
    }))
  }
  return {
    options: {
      audience,
      origin,
      connection,
      appEnv: 'test',
      encryptionKey: 'A'.repeat(43) + '=',
      request,
      data: deterministicTestData('ui-state-auth-fixture')
    },
    request,
    calls
  }
}

describe('UI route acceptance creates legitimate sessions in the isolated PostgreSQL clone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.postgres.mockReturnValue(Object.assign(mocks.sql, { end: mocks.end }))
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join('?')
      if (query.includes('FROM identities')) return [{ id: identityId }]
      if (query.includes('FROM outbox_events')) return [{ tokenEnvelope: 'encrypted-verification-envelope' }]
      return []
    })
    mocks.decrypt.mockReturnValue('verification-token-from-outbox')
  })

  it('registers, verifies and logs in the customer without granting an admin role', async () => {
    const { options, request, calls } = fixture('customer')
    expect(await createUiStatePostgresSession(options)).toBe('neteco-session=issued-by-auth-HTTP')
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      '/api/auth/register',
      '/api/auth/verify-email',
      '/api/auth/login'
    ])
    expect(request.post.mock.calls[1]?.[1].data).toEqual({ token: 'verification-token-from-outbox' })
    expect(mocks.sql.mock.calls.map(([parts]) => parts.join('?')).join('\n')).not.toMatch(
      /INSERT INTO (?:identity_roles|auth_sessions)/
    )
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('enrolls MFA and consumes a real challenge/recovery code, rejecting replay before returning an admin cookie', async () => {
    const { options, calls } = fixture()
    expect(await createUiStatePostgresSession(options)).toBe('neteco-session=issued-by-auth-HTTP')
    const routes = calls.map((url) => new URL(url).pathname)
    expect(routes).toEqual([
      '/api/auth/register',
      '/api/auth/verify-email',
      '/api/auth/login',
      '/api/auth/mfa/setup',
      '/api/auth/mfa/verify-setup',
      '/api/auth/logout',
      '/api/auth/login',
      '/api/auth/mfa/complete',
      '/api/auth/mfa/complete'
    ])
    const queries = mocks.sql.mock.calls.map(([parts]) => parts.join('?'))
    expect(queries.filter((query) => /INSERT INTO identity_roles/.test(query))).toHaveLength(1)
    expect(queries.join('\n')).not.toMatch(/(?:INSERT INTO|UPDATE) auth_sessions/)
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it.each([
    { appEnv: 'production' },
    { connection: 'postgres://fixture:fixture@db.example.invalid/neteco_it_fixture' },
    { connection: 'postgres://fixture:fixture@127.0.0.1/neteco' },
    { origin: 'https://neteco.tonomolla.es' },
    { origin: 'http://127.0.0.1:3100/unexpected' }
  ])('rejects an unsafe fixture scope before HTTP or database access: %j', async (unsafe) => {
    const { options, request } = fixture()
    await expect(createUiStatePostgresSession({ ...options, ...unsafe })).rejects.toThrow(/isolated/i)
    expect(request.post).not.toHaveBeenCalled()
    expect(mocks.postgres).not.toHaveBeenCalled()
  })

  it('fails closed and closes the SQL client if registration is refused', async () => {
    const { options, request } = fixture()
    request.post.mockResolvedValueOnce({ status: () => 503, json: async () => ({ error: { code: 'unavailable' } }) })
    await expect(createUiStatePostgresSession(options)).rejects.toThrow(/503/)
    expect(request.post).toHaveBeenCalledOnce()
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('never substitutes a synthetic cookie when the HTTP authentication did not issue one', async () => {
    const { options, request } = fixture('customer')
    request.storageState.mockResolvedValueOnce({ cookies: [], origins: [] })
    await expect(createUiStatePostgresSession(options)).rejects.toThrow(/cookie/i)
    expect(mocks.end).toHaveBeenCalledOnce()
  })

  it('refuses to return an administrator session if the recovery challenge can be replayed', async () => {
    const { options, request } = fixture()
    const post = request.post.getMockImplementation()!
    request.post.mockImplementation(async (path, options) => {
      const result = await post(path, options)
      return new URL(path).pathname === '/api/auth/mfa/complete' ? { ...result, status: () => 200 } : result
    })
    await expect(createUiStatePostgresSession(options)).rejects.toThrow(/replay/i)
    expect(request.storageState).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalledOnce()
  })
})
