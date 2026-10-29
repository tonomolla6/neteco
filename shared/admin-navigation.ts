import { z } from 'zod'

export const ADMIN_NAVIGATION_PERMISSIONS = [
  'administration.manage',
  'catalog.write',
  'catalog.publish',
  'inventory.read',
  'support.manage'
] as const
export const adminCapabilitiesSchema = z
  .object({
    source: z.literal('cloudflare'),
    identityId: z.string().uuid(),
    sessionId: z.string().uuid(),
    sessionVersion: z.number().int().positive(),
    state: z.enum(['ready', 'email_unverified', 'mfa_required', 'forbidden']),
    permissions: z.array(z.enum(ADMIN_NAVIGATION_PERMISSIONS)).max(ADMIN_NAVIGATION_PERMISSIONS.length)
  })
  .strict()
  .refine((value) => value.state === 'ready' || value.permissions.length === 0)
export type AdminCapabilities = z.infer<typeof adminCapabilitiesSchema>
type Permission = (typeof ADMIN_NAVIGATION_PERMISSIONS)[number]
export interface AdminNavigationLink {
  to: string
  label: string
  icon: string
  exact?: boolean
}
const sections: Array<{
  label: string
  links: Array<AdminNavigationLink & { permission: Permission | Permission[] }>
}> = [
  {
    label: 'Operación',
    links: [
      {
        to: '/admin',
        label: 'Hoy',
        icon: 'i-lucide-layout-dashboard',
        exact: true,
        permission: 'administration.manage'
      },
      { to: '/admin/pedidos', label: 'Pedidos', icon: 'i-lucide-receipt-text', permission: 'administration.manage' },
      {
        to: '/admin/clientes',
        label: 'Clientes profesionales',
        icon: 'i-lucide-building-2',
        exact: true,
        permission: 'administration.manage'
      },
      {
        to: '/admin/clientes/contexto',
        label: 'Ficha de cliente',
        icon: 'i-lucide-contact-round',
        permission: ['support.manage', 'administration.manage']
      },
      {
        to: '/admin/presupuestos',
        label: 'Presupuestos',
        icon: 'i-lucide-file-check-2',
        permission: 'administration.manage'
      },
      {
        to: '/admin/devoluciones',
        label: 'Devoluciones',
        icon: 'i-lucide-rotate-ccw',
        permission: 'administration.manage'
      },
      {
        to: '/admin/transportistas',
        label: 'Transportistas y Scorecard',
        icon: 'i-lucide-truck',
        permission: 'administration.manage'
      },
      { to: '/admin/soporte', label: 'Soporte', icon: 'i-lucide-life-buoy', permission: 'support.manage' },
      {
        to: '/admin/encuestas',
        label: 'Encuestas de entrega',
        icon: 'i-lucide-clipboard-check',
        permission: 'administration.manage'
      },
      {
        to: '/admin/aportaciones-productos',
        label: 'Reseñas y preguntas',
        icon: 'i-lucide-message-square',
        permission: 'support.manage'
      },
      { to: '/admin/inventario', label: 'Inventario', icon: 'i-lucide-warehouse', permission: 'inventory.read' }
    ]
  },
  {
    label: 'Catálogo',
    links: [
      { to: '/admin/productos', label: 'Productos', icon: 'i-lucide-package', permission: 'catalog.write' },
      { to: '/admin/categorias', label: 'Familias', icon: 'i-lucide-folder-tree', permission: 'catalog.write' },
      {
        to: '/admin/calidad-catalogo',
        label: 'Calidad del catálogo',
        icon: 'i-lucide-list-checks',
        permission: 'catalog.write'
      },
      {
        to: '/admin/politicas-catalogo',
        label: 'Políticas de publicación',
        icon: 'i-lucide-shield-check',
        permission: 'catalog.publish'
      },
      { to: '/admin/precios', label: 'Precios', icon: 'i-lucide-badge-euro', permission: 'catalog.write' },
      { to: '/admin/medios', label: 'Medios', icon: 'i-lucide-images', permission: 'catalog.write' },
      { to: '/admin/contenido', label: 'Contenido', icon: 'i-lucide-panels-top-left', permission: 'catalog.write' }
    ]
  },
  {
    label: 'Marketing',
    links: [
      {
        to: '/admin/promociones',
        label: 'Promociones',
        icon: 'i-lucide-ticket-percent',
        permission: 'administration.manage'
      },
      {
        to: '/admin/modales',
        label: 'Modales',
        icon: 'i-lucide-megaphone',
        permission: 'administration.manage'
      },
      {
        to: '/admin/newsletter',
        label: 'Newsletter editorial',
        icon: 'i-lucide-mails',
        permission: 'administration.manage'
      },
      {
        to: '/admin/analitica',
        label: 'Analítica',
        icon: 'i-lucide-chart-no-axes-combined',
        permission: 'administration.manage'
      },
      {
        to: '/admin/analitica-busqueda',
        label: 'Analítica de búsqueda',
        icon: 'i-lucide-search-check',
        permission: 'administration.manage'
      }
    ]
  },
  {
    label: 'Sistema',
    links: [
      {
        to: '/admin/auditoria',
        label: 'Auditoría',
        icon: 'i-lucide-history',
        exact: true,
        permission: 'administration.manage'
      },
      {
        to: '/admin/equipo',
        label: 'Equipo y accesos',
        icon: 'i-lucide-shield-check',
        exact: true,
        permission: 'administration.manage'
      },
      {
        to: '/admin/operaciones',
        label: 'Operaciones y colas',
        icon: 'i-lucide-activity',
        permission: 'administration.manage'
      },
      {
        to: '/admin/busqueda',
        label: 'Relevancia de búsqueda',
        icon: 'i-lucide-search-check',
        permission: 'catalog.write'
      }
    ]
  }
]
/** Navigation hints only: every business API must still authorize its own operation. */
export function adminNavigationGroups(
  capabilities: AdminCapabilities | null
): Array<{ label: string; links: AdminNavigationLink[] }> {
  if (capabilities?.state !== 'ready') return []
  return sections
    .map((group) => ({
      label: group.label,
      links: group.links.filter((link) =>
        (Array.isArray(link.permission) ? link.permission : [link.permission]).some((permission) =>
          capabilities.permissions.includes(permission)
        )
      )
    }))
    .filter((group) => group.links.length > 0)
}
export function canNavigateAdmin(path: string, capabilities: AdminCapabilities | null): boolean {
  return adminNavigationGroups(capabilities)
    .flatMap((group) => group.links)
    .some((link) => path === link.to || (!link.exact && path.startsWith(link.to + '/')))
}
