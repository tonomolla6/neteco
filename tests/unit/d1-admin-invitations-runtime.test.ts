import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { invitationFixture, ORIGIN } from './d1-admin-invitations-fixture'
import { adminNavigationGroups, canNavigateAdmin } from '../../shared/admin-navigation'

describe('Cloudflare invitation routing and team navigation', () => {
  it.each([
    '/api/admin/invitations',
    '/api/account/invitations/accept',
    '/API/admin/invitations',
    '/api/admin/%69nvitations'
  ])('owns disabled namespace %s without legacy or database fallback', async (path) => {
    const env = environment({ AUTH_ENABLED: 'false', AUTH_ORIGIN: ORIGIN })
    const response = await worker.fetch(new Request(ORIGIN + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('rate limits before session or D1 access', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, ADMIN_EDGE_LIMIT: { limit } })
    const response = await worker.fetch(
      new Request(ORIGIN + '/api/admin/invitations', { headers: { 'CF-Connecting-IP': '192.0.2.82' } }),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })
  it('routes an authenticated real list through D1 without a provider or legacy handler', async () => {
    const f = await invitationFixture()
    try {
      const env = environment({
        DB: f.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: ORIGIN,
        NUXT_SESSION_PASSWORD: f.configuration.password
      })
      const response = await worker.fetch(
        new Request(ORIGIN + '/api/admin/invitations', {
          headers: { cookie: await f.cookie(), 'CF-Connecting-IP': '192.0.2.82' }
        }),
        env as unknown as CloudflareEnv
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0 })
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    } finally {
      f.sqlite.close()
    }
  })
  it('shows the exact team route only with current administration.manage capability', () => {
    const caps = {
      source: 'cloudflare' as const,
      identityId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      sessionVersion: 1,
      state: 'ready' as const,
      permissions: ['administration.manage' as const]
    }
    expect(
      adminNavigationGroups(caps)
        .flatMap((g) => g.links)
        .map((l) => l.to)
    ).toContain('/admin/equipo')
    expect(canNavigateAdmin('/admin/equipo', caps)).toBe(true)
    expect(canNavigateAdmin('/admin/equipo/falso', caps)).toBe(false)
    expect(canNavigateAdmin('/admin/equipo', { ...caps, permissions: ['support.manage'] })).toBe(false)
    expect(canNavigateAdmin('/admin/equipo', { ...caps, state: 'forbidden', permissions: [] })).toBe(false)
  })
})
