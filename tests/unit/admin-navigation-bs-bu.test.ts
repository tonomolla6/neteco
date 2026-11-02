import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adminNavigationGroups, type AdminCapabilities } from '../../shared/admin-navigation'

/** Navigation hints must mirror the permission each server module really enforces. */
const lucide = JSON.parse(
  readFileSync(new URL('../../node_modules/@iconify-json/lucide/icons.json', import.meta.url), 'utf8')
) as { icons: Record<string, unknown> }
const caps = (permissions: AdminCapabilities['permissions']): AdminCapabilities => ({
  source: 'cloudflare',
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1,
  state: 'ready',
  permissions
})
const links = (permissions: AdminCapabilities['permissions']) =>
  adminNavigationGroups(caps(permissions)).flatMap((group) => group.links)
const EXPECTED = {
  '/admin/orden-categorias': 'catalog.write',
  '/admin/gobernanza-contenido': 'catalog.write',
  '/admin/fraude-promocional': 'administration.manage',
  '/admin/comunicaciones-multicanal': 'administration.manage',
  '/admin/preautorizaciones': 'administration.manage',
  '/admin/pedidos-compra': 'inventory.read',
  '/admin/busquedas-sin-resultado': 'catalog.write',
  '/admin/reglas-precios': 'administration.manage',
  '/admin/aprendizaje': 'administration.manage',
  '/admin/incentivos-recurrentes': 'administration.manage',
  '/admin/garantia-calidad': 'administration.manage'
} as const

describe('BS/BU administrative navigation', () => {
  it.each(Object.entries(EXPECTED))('%s is shown only with %s', (to, permission) => {
    expect(links([permission]).map((link) => link.to)).toContain(to)
    const others = (
      ['administration.manage', 'catalog.write', 'catalog.publish', 'inventory.read', 'support.manage'] as const
    ).filter((candidate) => candidate !== permission)
    expect(links([...others]).map((link) => link.to)).not.toContain(to)
    expect(adminNavigationGroups(null)).toEqual([])
  })

  it('uses existing lucide icons and unique destinations', () => {
    const all = links(['administration.manage', 'catalog.write', 'catalog.publish', 'inventory.read', 'support.manage'])
    for (const to of Object.keys(EXPECTED)) {
      const link = all.find((candidate) => candidate.to === to)!
      expect(lucide.icons[link.icon.replace('i-lucide-', '')]).toBeDefined()
    }
    expect(new Set(all.map((link) => link.to)).size).toBe(all.length)
  })
})
