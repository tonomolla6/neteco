import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

const env = { AUTH_ENABLED: 'false', B2B_PUBLIC_API_ENABLED: 'false' } as unknown as CloudflareEnv

describe('montaje API B2B', () => {
  it('sirve contrato real cuando está habilitado', async () => {
    const enabled = { ...env, AUTH_ENABLED: 'true', B2B_PUBLIC_API_ENABLED: 'true' } as CloudflareEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/openapi.json'), enabled)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: '3.0.3' })
  })
  it('no cae al router anterior con credenciales ausentes', async () => {
    const enabled = { ...env, AUTH_ENABLED: 'true', B2B_PUBLIC_API_ENABLED: 'true' } as CloudflareEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/requests'), enabled)
    expect(response.status).toBe(401)
  })
  it.each(['/api/b2b/v1/requests', '/api/b2b/v1/openapi.json', '/api/admin/b2b-public/keys'])('cierra %s cuando está desactivado', async (path) => {
    const response = await canary.fetch(new Request(`https://shop.invalid${path}`), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
