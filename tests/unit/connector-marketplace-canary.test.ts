import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

const baseEnv = {
  AUTH_ENABLED: 'false',
  DB: {} as D1Database,
  AUTH_ORIGIN: 'https://shop.invalid',
  AUTH_RATE_LIMIT_PEPPER: 'a'.repeat(32),
  ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
  NUXT_SESSION_PASSWORD: 'p'.repeat(64)
} as unknown as CloudflareEnv

describe('montaje Canary de Marketplace de Conectores (INT-023)', () => {
  it('responde 503 authUnavailable cuando AUTH_ENABLED es false', async () => {
    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/connectors/catalog', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      baseEnv
    )
    expect(res.status).toBe(503)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe('service_unavailable')
  })

  it('no cae a router anterior: responde 401 unauthenticated cuando AUTH_ENABLED es true pero falta sesión', async () => {
    const enabledEnv = {
      ...baseEnv,
      AUTH_ENABLED: 'true'
    } as CloudflareEnv

    const res = await canary.fetch(
      new Request('https://shop.invalid/api/admin/connectors/catalog', {
        headers: { 'cf-connecting-ip': '1.2.3.4' }
      }),
      enabledEnv
    )
    expect(res.status).toBe(401)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe('unauthenticated')
  })
})
