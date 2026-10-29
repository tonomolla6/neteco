import { describe, expect, it } from 'vitest'
import { adminNavigationGroups, canNavigateAdmin, type AdminCapabilities } from '../../shared/admin-navigation'

const capabilities = (permissions: AdminCapabilities['permissions']): AdminCapabilities => ({
  source: 'cloudflare',
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  sessionVersion: 1,
  state: 'ready',
  permissions
})
const route = '/admin/aportaciones-productos'

describe('product contributions moderation navigation', () => {
  it('offers the moderation queue to a support-authorized operator, including its details', () => {
    const actor = capabilities(['support.manage'])
    expect(canNavigateAdmin(route, actor)).toBe(true)
    expect(canNavigateAdmin(route + '/review', actor)).toBe(true)
    expect(
      adminNavigationGroups(actor)
        .flatMap((group) => group.links)
        .filter((link) => link.to === route)
    ).toHaveLength(1)
  })
  it('does not treat general administration or catalogue authority as moderation permission', () => {
    expect(canNavigateAdmin(route, capabilities(['administration.manage', 'catalog.write']))).toBe(false)
  })
  it('removes moderation navigation while live authority needs MFA', () => {
    expect(canNavigateAdmin(route, { ...capabilities([]), state: 'mfa_required' })).toBe(false)
  })
})

describe('commercial and customer context navigation', () => {
  it('offers customer context to either a live support or administration grant', () => {
    for (const permission of ['support.manage', 'administration.manage'] as const) {
      const actor = capabilities([permission])
      expect(canNavigateAdmin('/admin/clientes/contexto', actor)).toBe(true)
      expect(
        adminNavigationGroups(actor)
          .flatMap((group) => group.links)
          .filter((link) => link.to === '/admin/clientes/contexto')
      ).toHaveLength(1)
    }
  })
  it('offers commercial quotes to administration without requiring catalogue editing authority', () => {
    expect(canNavigateAdmin('/admin/presupuestos', capabilities(['administration.manage']))).toBe(true)
    expect(canNavigateAdmin('/admin/presupuestos', capabilities(['catalog.write', 'support.manage']))).toBe(false)
  })
  it('hides both routes without a relevant live grant or while MFA is required', () => {
    for (const path of ['/admin/clientes/contexto', '/admin/presupuestos']) {
      expect(canNavigateAdmin(path, capabilities(['catalog.write']))).toBe(false)
      expect(canNavigateAdmin(path, { ...capabilities(['administration.manage']), state: 'mfa_required' })).toBe(false)
    }
  })
})
