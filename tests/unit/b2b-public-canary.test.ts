import { describe, expect, it } from 'vitest'
import canary from '../../workers/canary'

const env = { AUTH_ENABLED: 'false', B2B_PUBLIC_API_ENABLED: 'false' } as unknown as CloudflareEnv
const enabledEnv = {
  ...env,
  AUTH_ENABLED: 'true',
  B2B_PUBLIC_API_ENABLED: 'true',
  AUTH_RATE_LIMIT_PEPPER: 'x'.repeat(40),
  CART_EDGE_LIMIT: { limit: async () => ({ success: true }) }
} as unknown as CloudflareEnv
const ingress = { headers: { 'cf-connecting-ip': '203.0.113.9' } }

describe('montaje API B2B', () => {
  it('bloquea tráfico sin límite de borde configurado', async () => {
    const enabled = { ...env, AUTH_ENABLED: 'true', B2B_PUBLIC_API_ENABLED: 'true' } as CloudflareEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/requests'), enabled)
    expect(response.status).toBe(503)
  })
  it('rechaza exceso de tráfico en el borde antes de leer credenciales', async () => {
    const limited = {
      ...enabledEnv,
      CART_EDGE_LIMIT: { limit: async () => ({ success: false }) }
    } as unknown as CloudflareEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/requests', ingress), limited)
    expect(response.status).toBe(429)
  })
  it('exige sesión y MFA en el ownership del portal', async () => {
    const configured = {
      ...enabledEnv,
      AUTH_ORIGIN: 'https://shop.invalid',
      NUXT_SESSION_PASSWORD: 'a'.repeat(64),
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const response = await canary.fetch(
      new Request('https://shop.invalid/api/admin/developer-platform/ownership', ingress),
      configured
    )
    expect(response.status).toBe(401)
  })
  it('sirve contrato real cuando está habilitado', async () => {
    const enabled = enabledEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/openapi.json', ingress), enabled)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: '3.0.3' })
  })
  it('no cae al router anterior con credenciales ausentes', async () => {
    const enabled = enabledEnv
    const response = await canary.fetch(new Request('https://shop.invalid/api/b2b/v1/requests', ingress), enabled)
    expect(response.status).toBe(401)
  })
  it.each([
    '/api/b2b/v1/requests',
    '/api/b2b/v1/openapi.json',
    '/api/admin/b2b-public/keys',
    '/api/admin/developer-platform/ownership'
  ])('cierra %s cuando está desactivado', async (path) => {
    const response = await canary.fetch(new Request(`https://shop.invalid${path}`), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})
