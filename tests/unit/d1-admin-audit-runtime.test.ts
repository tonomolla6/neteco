import { describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { environment } from '../support/customer-operations-fixture'
import { adminNavigationGroups, canNavigateAdmin } from '../../shared/admin-navigation'
import { testUuid } from '../support/deterministic'

const origin = 'https://audit.neteco.test'
describe('Cloudflare administrative audit boundary and navigation', () => {
  it.each([
    '/api/admin/audit',
    '/api/admin/audit/events/example',
    '/api/admin/audit/exports',
    '/API/admin/audit',
    '/api/admin/%61udit'
  ])('owns disabled namespace %s without reaching legacy or D1', async (path) => {
    const env = environment({ AUTH_ENABLED: 'false', AUTH_ORIGIN: origin })
    const response = await worker.fetch(new Request(origin + path), env as unknown as CloudflareEnv)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('applies the administrative edge limit before a session or database read', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const env = environment({ AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, ADMIN_EDGE_LIMIT: { limit } })
    const response = await worker.fetch(
      new Request(origin + '/api/admin/audit', { headers: { 'CF-Connecting-IP': '192.0.2.85' } }),
      env as unknown as CloudflareEnv
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(limit).toHaveBeenCalledOnce()
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  it('exposes only the exact audit screen to current administration authority', () => {
    const caps = {
      source: 'cloudflare' as const,
      identityId: testUuid(),
      sessionId: testUuid(),
      sessionVersion: 1,
      state: 'ready' as const,
      permissions: ['administration.manage' as const]
    }
    expect(
      adminNavigationGroups(caps)
        .flatMap((group) => group.links)
        .map((link) => link.to)
    ).toContain('/admin/auditoria')
    expect(canNavigateAdmin('/admin/auditoria', caps)).toBe(true)
    expect(canNavigateAdmin('/admin/auditoria/inventado', caps)).toBe(false)
    expect(canNavigateAdmin('/admin/auditoria', { ...caps, permissions: ['support.manage'] })).toBe(false)
    expect(canNavigateAdmin('/admin/auditoria', { ...caps, state: 'forbidden', permissions: [] })).toBe(false)
  })
})
