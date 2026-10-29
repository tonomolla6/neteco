import { describe, expect, it } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'

const path = '/api/account/cart-recovery/preferences'
const pepper = 'synthetic-recovery-runtime-hmac-0123456789abcdef'

describe('cart recovery actual Worker authority boundary', () => {
  it.each([
    path,
    '/API/account/cart-recovery/preferences',
    '/api/account/%63art-recovery/preferences',
    '/api/account/%2563art-recovery/preferences',
    '/api/account/cart-recovery%2fpreferences',
    '/api/account/cart-recovery%5cpreferences',
    '/api/account/cart-recovery%ZZ'
  ])('claims its namespace while disabled without touching D1 or email: %s', async (ownedPath) => {
    const env = environment({ CART_RECOVERY_ENABLED: 'false' })
    const response = await worker.fetch(new Request(env.AUTH_ORIGIN + ownedPath), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it.each([
    { AUTH_ENABLED: 'false', AUTH_TOKEN_PEPPER: pepper },
    { AUTH_ENABLED: 'true', AUTH_TOKEN_PEPPER: undefined },
    { AUTH_ENABLED: 'true', AUTH_TOKEN_PEPPER: 'too-short' }
  ])('fails closed without both account authority and the private HMAC key: %j', async (overrides) => {
    const env = environment({ CART_RECOVERY_ENABLED: 'true', ...overrides })
    const response = await worker.fetch(
      new Request(env.AUTH_ORIGIN + path, { headers: { 'CF-Connecting-IP': '192.0.2.95' } }),
      env
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('uses the configured account gate instead of a public or legacy recovery reader', async () => {
    const env = environment({ AUTH_ENABLED: 'true', CART_RECOVERY_ENABLED: 'true', AUTH_TOKEN_PEPPER: pepper })
    const response = await worker.fetch(
      new Request(env.AUTH_ORIGIN + path, { headers: { 'CF-Connecting-IP': '192.0.2.95' } }),
      env
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
    expect(env.CART_EDGE_LIMIT.limit).toHaveBeenCalledTimes(1)
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
})
