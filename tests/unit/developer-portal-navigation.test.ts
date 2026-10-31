import { describe, expect, it } from 'vitest'
import { adminNavigationGroups, canNavigateAdmin, type AdminCapabilities } from '../../shared/admin-navigation'

const base: AdminCapabilities = {
  source: 'cloudflare',
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1,
  state: 'ready',
  permissions: ['administration.manage']
}
describe('CIC-034: entrada y permiso de navegación', () => {
  it('permite y anuncia el portal al administrador habilitado', () => {
    expect(canNavigateAdmin('/admin/plataforma', base)).toBe(true)
    expect(
      adminNavigationGroups(base)
        .flatMap((group) => group.links)
        .some((link) => link.to === '/admin/plataforma')
    ).toBe(true)
  })
  it('no permite el portal sin el permiso administrativo', () => {
    expect(canNavigateAdmin('/admin/plataforma', { ...base, permissions: ['catalog.write'] })).toBe(false)
  })
  it('no habilita el portal con MFA pendiente', () => {
    expect(canNavigateAdmin('/admin/plataforma', { ...base, state: 'mfa_required', permissions: [] })).toBe(false)
  })
})
