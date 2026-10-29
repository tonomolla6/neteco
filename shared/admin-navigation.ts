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
      {
        to: '/admin/rutas',
        label: 'Rutas de reparto',
        icon: 'i-lucide-map-pin',
        permission: 'administration.manage'
      },
      {
        to: '/admin/reparto-app',
        label: 'App de reparto',
        icon: 'i-lucide-smartphone',
        permission: 'administration.manage'
      },
      {
        to: '/admin/manifiestos-transportista',
        label: 'Manifiestos de transportista',
        icon: 'i-lucide-clipboard-list',
        permission: 'administration.manage'
      },
      {
        to: '/admin/optimizacion-embalaje',
        label: 'Optimización de embalaje',
        icon: 'i-lucide-package-check',
        permission: 'administration.manage'
      },
      {
        to: '/admin/alertas-operativas',
        label: 'Alertas operativas',
        icon: 'i-lucide-bell-ring',
        permission: 'administration.manage'
      },
      { to: '/admin/soporte', label: 'Soporte', icon: 'i-lucide-life-buoy', permission: 'support.manage' },
      {
        to: '/admin/soporte-chat',
        label: 'Chat de soporte',
        icon: 'i-lucide-messages-square',
        permission: 'support.manage'
      },
      {
        to: '/admin/soporte-rca',
        label: 'Análisis Causa Raíz (RCA)',
        icon: 'i-lucide-file-search',
        permission: 'support.manage'
      },
      {
        to: '/admin/gestor-cuentas',
        label: 'Gestores de cuenta B2B',
        icon: 'i-lucide-user-check',
        permission: 'support.manage'
      },
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
      { to: '/admin/inventario', label: 'Inventario', icon: 'i-lucide-warehouse', permission: 'inventory.read' },
      {
        to: '/admin/inventario-planificacion',
        label: 'Reposición, escaneo y conteos',
        icon: 'i-lucide-scan-barcode',
        permission: 'inventory.read'
      },
      {
        to: '/admin/suplantacion-soporte',
        label: 'Suplantación de soporte',
        icon: 'i-lucide-user-cog',
        permission: 'support.manage'
      }
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
      {
        to: '/admin/medios/guias-producto',
        label: 'Guías de producto y vídeo',
        icon: 'i-lucide-video',
        permission: ['catalog.write', 'administration.manage']
      },
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
        to: '/admin/asistente-ia',
        label: 'Asistente IA y enriquecimiento',
        icon: 'i-lucide-sparkles',
        permission: 'administration.manage'
      },
      {
        to: '/admin/catalogo-mercados',
        label: 'Mercados e internacional',
        icon: 'i-lucide-globe',
        permission: 'administration.manage'
      },
      {
        to: '/admin/retiradas',
        label: 'Retiradas de producto',
        icon: 'i-lucide-triangle-alert',
        permission: 'administration.manage'
      },
      {
        to: '/admin/ugc-moderacion',
        label: 'Moderación UGC',
        icon: 'i-lucide-camera',
        permission: 'administration.manage'
      },
      {
        to: '/admin/casos-cliente',
        label: 'Casos de éxito',
        icon: 'i-lucide-award',
        permission: 'administration.manage'
      },
      {
        to: '/admin/modales',
        label: 'Modales',
        icon: 'i-lucide-megaphone',
        permission: 'administration.manage'
      },
      {
        to: '/admin/automatizaciones',
        label: 'Automatizaciones',
        icon: 'i-lucide-workflow',
        permission: 'administration.manage'
      },
      {
        to: '/admin/audiencias',
        label: 'Segmentos y Audiencias',
        icon: 'i-lucide-users',
        permission: 'administration.manage'
      },
      {
        to: '/admin/experimentos',
        label: 'A/B Testing & Experimentos',
        icon: 'i-lucide-flask-conical',
        permission: 'administration.manage'
      },
      {
        to: '/admin/marketing/kits',
        label: 'Kits y Bundles',
        icon: 'i-lucide-package-check',
        permission: ['catalog.write', 'administration.manage']
      },
      {
        to: '/admin/marketing/referidos',
        label: 'Programa de Referidos',
        icon: 'i-lucide-user-plus',
        permission: 'administration.manage'
      },
      {
        to: '/admin/marketing/eventos',
        label: 'Webinars y Eventos',
        icon: 'i-lucide-calendar-days',
        permission: 'administration.manage'
      },
      {
        to: '/admin/newsletter',
        label: 'Newsletter editorial',
        icon: 'i-lucide-mails',
        permission: 'administration.manage'
      },
      {
        to: '/admin/optimizacion-envios',
        label: 'Optimización de envíos',
        icon: 'i-lucide-send',
        permission: 'administration.manage'
      },
      {
        to: '/admin/campanas-segmentadas',
        label: 'Campañas segmentadas',
        icon: 'i-lucide-target',
        permission: 'administration.manage'
      },
      {
        to: '/admin/personalizacion-campanas',
        label: 'Personalización y guardrails',
        icon: 'i-lucide-sliders-horizontal',
        permission: 'administration.manage'
      },
      {
        to: '/admin/analitica',
        label: 'Analítica',
        icon: 'i-lucide-chart-no-axes-combined',
        permission: 'administration.manage'
      },
      {
        to: '/admin/analitica?tab=payment_funnel',
        label: 'Funnel de pagos',
        icon: 'i-lucide-credit-card',
        permission: 'administration.manage'
      },
      {
        to: '/admin/analitica-busqueda',
        label: 'Analítica de búsqueda',
        icon: 'i-lucide-search-check',
        permission: 'administration.manage'
      },
      {
        to: '/admin/seo',
        label: 'SEO Técnico & Búsqueda IA',
        icon: 'i-lucide-search-check',
        permission: ['administration.manage', 'catalog.write']
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
        to: '/admin/observabilidad',
        label: 'Observabilidad y SRE',
        icon: 'i-lucide-activity',
        permission: 'administration.manage'
      },
      {
        to: '/admin/rendimiento',
        label: 'Rendimiento por valor',
        icon: 'i-lucide-gauge',
        permission: 'administration.manage'
      },
      {
        to: '/admin/evaluacion-modelos',
        label: 'Evaluación IA y Quality Gate',
        icon: 'i-lucide-shield-check',
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
