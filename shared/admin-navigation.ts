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
export interface AdminNavigationTab extends AdminNavigationLink {
  permission: Permission | Permission[]
  /** Frase breve bajo el título cuando esta pestaña está activa. */
  description?: string
}
export interface AdminNavigationItem {
  label: string
  icon: string
  description?: string
  /** La primera pestaña es el destino de la entrada del menú. */
  tabs: AdminNavigationTab[]
}
export interface AdminNavigationSection {
  id: string
  label: string
  icon: string
  items: AdminNavigationItem[]
}
const A: Permission = 'administration.manage'
const C: Permission = 'catalog.write'
const S: Permission = 'support.manage'
const I: Permission = 'inventory.read'
const CA: Permission[] = ['catalog.write', 'administration.manage']
const tab = (
  to: string,
  label: string,
  icon: string,
  permission: Permission | Permission[],
  description?: string,
  exact?: boolean
): AdminNavigationTab => ({
  to,
  label,
  icon,
  permission,
  ...(description ? { description } : {}),
  ...(exact ? { exact } : {})
})

/**
 * Árbol único del panel: sección desplegable → entrada de menú → pestañas.
 * Cada pestaña es una ruta real; las pantallas relacionadas comparten cabecera y
 * se alternan con pestañas en vez de ocupar una entrada de menú cada una.
 */
const tree: AdminNavigationSection[] = [
  {
    id: 'inicio',
    label: 'Inicio',
    icon: 'i-lucide-house',
    items: [
      {
        label: 'Inicio',
        icon: 'i-lucide-house',
        tabs: [
          tab(
            '/admin',
            'Hoy',
            'i-lucide-layout-dashboard',
            A,
            'Ventas, pedidos y tareas pendientes de la tienda.',
            true
          ),
          tab(
            '/admin/panel-rol',
            'Panel por rol',
            'i-lucide-layout-grid',
            A,
            'Qué ve cada perfil del equipo al entrar al panel.'
          )
        ]
      }
    ]
  },
  {
    id: 'pedidos',
    label: 'Pedidos',
    icon: 'i-lucide-receipt-text',
    items: [
      {
        label: 'Pedidos',
        icon: 'i-lucide-receipt-text',
        tabs: [
          tab(
            '/admin/pedidos',
            'Todos los pedidos',
            'i-lucide-receipt-text',
            A,
            'Consulta, prepara y expide los pedidos de la tienda.'
          ),
          tab(
            '/admin/pedidos-borrador',
            'Borradores',
            'i-lucide-file-clock',
            A,
            'Pedidos creados por el equipo que aún no se han confirmado.'
          ),
          tab(
            '/admin/presupuestos',
            'Presupuestos',
            'i-lucide-file-check-2',
            A,
            'Ofertas enviadas a clientes y su conversión en pedido.'
          ),
          tab(
            '/admin/preautorizaciones',
            'Preautorizaciones',
            'i-lucide-credit-card',
            A,
            'Retenciones de pago pendientes de capturar o liberar.'
          ),
          tab(
            '/admin/operaciones-pedidos',
            'Compras de empresa',
            'i-lucide-boxes',
            A,
            'Aprobaciones de compra de empresas y contingencia de pagos.'
          )
        ]
      },
      {
        label: 'Devoluciones',
        icon: 'i-lucide-rotate-ccw',
        tabs: [
          tab(
            '/admin/devoluciones',
            'Devoluciones',
            'i-lucide-rotate-ccw',
            A,
            'Solicitudes de devolución, recepción y reembolso.'
          ),
          tab(
            '/admin/retiradas',
            'Retiradas de producto',
            'i-lucide-triangle-alert',
            A,
            'Avisos de seguridad y retirada de lotes vendidos.'
          )
        ]
      }
    ]
  },
  {
    id: 'catalogo',
    label: 'Catálogo',
    icon: 'i-lucide-package',
    items: [
      {
        label: 'Productos',
        icon: 'i-lucide-package',
        tabs: [
          tab('/admin/productos', 'Productos', 'i-lucide-package', C, 'Fichas, variantes y estado de publicación.'),
          tab(
            '/admin/calidad-catalogo',
            'Calidad de fichas',
            'i-lucide-list-checks',
            C,
            'Fichas incompletas o con datos por revisar.'
          ),
          tab(
            '/admin/aportaciones-productos',
            'Reseñas y preguntas',
            'i-lucide-message-square',
            S,
            'Opiniones y preguntas de clientes pendientes de moderar.'
          ),
          tab(
            '/admin/politicas-catalogo',
            'Reglas de publicación',
            'i-lucide-shield-check',
            'catalog.publish',
            'Requisitos que debe cumplir una ficha para publicarse.'
          )
        ]
      },
      {
        label: 'Categorías',
        icon: 'i-lucide-folder-tree',
        tabs: [
          tab(
            '/admin/categorias',
            'Familias',
            'i-lucide-folder-tree',
            C,
            'Árbol de familias y categorías del catálogo.'
          ),
          tab(
            '/admin/orden-categorias',
            'Orden de productos',
            'i-lucide-arrow-up-down',
            C,
            'Qué productos se muestran primero en cada categoría.'
          )
        ]
      },
      {
        label: 'Precios',
        icon: 'i-lucide-badge-euro',
        tabs: [
          tab(
            '/admin/precios',
            'Precios',
            'i-lucide-badge-euro',
            C,
            'Precios de venta, tarifas y cambios programados.'
          ),
          tab(
            '/admin/reglas-precios',
            'Reglas de precio y envío',
            'i-lucide-percent',
            A,
            'Descuentos automáticos y condiciones de envío.'
          )
        ]
      },
      {
        label: 'Inventario',
        icon: 'i-lucide-warehouse',
        tabs: [
          tab(
            '/admin/inventario',
            'Existencias',
            'i-lucide-warehouse',
            I,
            'Stock disponible, reservado y movimientos.'
          ),
          tab(
            '/admin/inventario-planificacion',
            'Reposición y recuentos',
            'i-lucide-scan-barcode',
            I,
            'Propuestas de reposición y recuentos de almacén.'
          ),
          tab(
            '/admin/pedidos-compra',
            'Pedidos a proveedor',
            'i-lucide-clipboard-pen',
            I,
            'Compras a proveedores y su recepción.'
          ),
          tab(
            '/admin/feed-proveedores',
            'Tarifas de proveedor',
            'i-lucide-diff',
            CA,
            'Cambios recibidos de proveedores pendientes de revisar.'
          ),
          tab(
            '/admin/fuentes-suministro',
            'Proveedores',
            'i-lucide-truck',
            CA,
            'Qué proveedor sirve cada producto y con qué plazo.'
          )
        ]
      },
      {
        label: 'Imágenes y archivos',
        icon: 'i-lucide-images',
        tabs: [
          tab(
            '/admin/medios',
            'Imágenes y archivos',
            'i-lucide-images',
            C,
            'Biblioteca de imágenes y documentos del catálogo.'
          )
        ]
      }
    ]
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: 'i-lucide-users',
    items: [
      {
        label: 'Clientes',
        icon: 'i-lucide-building-2',
        tabs: [
          tab(
            '/admin/clientes',
            'Empresas',
            'i-lucide-building-2',
            A,
            'Clientes profesionales, validación y condiciones.',
            true
          ),
          tab(
            '/admin/clientes/contexto',
            'Ficha de cliente',
            'i-lucide-contact-round',
            ['support.manage', 'administration.manage'],
            'Pedidos, incidencias y datos de un cliente en una sola vista.'
          ),
          tab(
            '/admin/clientes/tarifas',
            'Tarifas por cliente',
            'i-lucide-badge-euro',
            A,
            'Precios acordados con cada empresa.'
          ),
          tab(
            '/admin/solicitudes-b2b',
            'Solicitudes de alta',
            'i-lucide-clipboard-list',
            S,
            'Empresas que han pedido una cuenta profesional.'
          ),
          tab(
            '/admin/gestor-cuentas',
            'Gestores de cuenta',
            'i-lucide-user-check',
            S,
            'Qué comercial atiende a cada empresa.'
          ),
          tab(
            '/admin/comercial',
            'Oportunidades',
            'i-lucide-trending-up',
            A,
            'Seguimiento comercial de cuentas y oportunidades.'
          )
        ]
      },
      {
        label: 'Soporte',
        icon: 'i-lucide-life-buoy',
        tabs: [
          tab('/admin/soporte', 'Consultas', 'i-lucide-life-buoy', S, 'Consultas de clientes y su plazo de respuesta.'),
          tab('/admin/soporte-chat', 'Chat', 'i-lucide-messages-square', S, 'Conversaciones en directo con clientes.'),
          tab(
            '/admin/soporte-analisis',
            'Motivos de contacto',
            'i-lucide-chart-no-axes-combined',
            S,
            'Por qué escriben los clientes y qué se puede evitar.'
          ),
          tab(
            '/admin/soporte-rca',
            'Causas de incidencias',
            'i-lucide-file-search',
            S,
            'Análisis del origen de las incidencias repetidas.'
          ),
          tab(
            '/admin/soporte-educacion',
            'Respuestas y guías',
            'i-lucide-graduation-cap',
            S,
            'Respuestas sugeridas y contenidos de ayuda.'
          ),
          tab(
            '/admin/encuestas',
            'Encuestas de entrega',
            'i-lucide-clipboard-check',
            A,
            'Valoraciones de los clientes tras recibir su pedido.'
          ),
          tab(
            '/admin/suplantacion-soporte',
            'Ver como cliente',
            'i-lucide-user-cog',
            S,
            'Acceso asistido a la cuenta de un cliente, con registro.'
          )
        ]
      }
    ]
  },
  {
    id: 'logistica',
    label: 'Logística',
    icon: 'i-lucide-truck',
    items: [
      {
        label: 'Envíos',
        icon: 'i-lucide-truck',
        tabs: [
          tab(
            '/admin/transportistas',
            'Transportistas',
            'i-lucide-truck',
            A,
            'Puntualidad, incidencias y calidad de cada transportista.'
          ),
          tab(
            '/admin/manifiestos-transportista',
            'Manifiestos',
            'i-lucide-clipboard-list',
            A,
            'Cierres diarios de recogida por transportista.'
          ),
          tab(
            '/admin/optimizacion-embalaje',
            'Embalaje',
            'i-lucide-package-check',
            A,
            'Cajas recomendadas para cada pedido.'
          )
        ]
      },
      {
        label: 'Reparto propio',
        icon: 'i-lucide-map-pin',
        tabs: [
          tab('/admin/rutas', 'Rutas', 'i-lucide-map-pin', A, 'Planificación de las rutas de reparto.'),
          tab(
            '/admin/reparto-app',
            'App de reparto',
            'i-lucide-smartphone',
            A,
            'Entregas registradas por los repartidores.'
          )
        ]
      },
      {
        label: 'Almacén',
        icon: 'i-lucide-scan-barcode',
        tabs: [
          tab(
            '/admin/almacen-escaneo',
            'Escaneo',
            'i-lucide-scan-barcode',
            A,
            'Terminal de lectura para preparar y ubicar mercancía.'
          ),
          tab(
            '/admin/almacen-adr',
            'Mercancías peligrosas',
            'i-lucide-shield-alert',
            A,
            'Clasificación ADR y etiquetas de los envíos.'
          )
        ]
      }
    ]
  },
  {
    id: 'marketing',
    label: 'Marketing',
    icon: 'i-lucide-megaphone',
    items: [
      {
        label: 'Promociones',
        icon: 'i-lucide-ticket-percent',
        tabs: [
          tab('/admin/promociones', 'Promociones', 'i-lucide-ticket-percent', A, 'Descuentos, cupones y su vigencia.'),
          tab(
            '/admin/cupon-bienvenida',
            'Cupón de bienvenida',
            'i-lucide-badge-percent',
            A,
            'Descuento para el primer pedido de un cliente nuevo.'
          ),
          tab(
            '/admin/incentivos-recurrentes',
            'Compra recurrente',
            'i-lucide-repeat',
            A,
            'Ventajas para clientes que repiten compra.'
          ),
          tab(
            '/admin/fraude-promocional',
            'Uso indebido',
            'i-lucide-shield-alert',
            A,
            'Casos de abuso de cupones y promociones.'
          )
        ]
      },
      {
        label: 'Campañas',
        icon: 'i-lucide-calendar-range',
        tabs: [
          tab(
            '/admin/campanas-comerciales',
            'Calendario',
            'i-lucide-calendar-days',
            A,
            'Campañas planificadas y su calendario.'
          ),
          tab(
            '/admin/campanas-estacionales',
            'Estacionales',
            'i-lucide-calendar-range',
            A,
            'Campañas de temporada y sus productos.'
          ),
          tab(
            '/admin/campanas-segmentadas',
            'Segmentadas',
            'i-lucide-target',
            A,
            'Campañas dirigidas a un grupo de clientes.'
          ),
          tab(
            '/admin/personalizacion-campanas',
            'Personalización',
            'i-lucide-sliders-horizontal',
            A,
            'Límites y reglas de la personalización.'
          ),
          tab(
            '/admin/audiencias',
            'Audiencias',
            'i-lucide-users',
            A,
            'Grupos de clientes para campañas y comunicaciones.'
          ),
          tab(
            '/admin/experimentos',
            'Pruebas A/B',
            'i-lucide-flask-conical',
            A,
            'Experimentos en curso y sus resultados.'
          )
        ]
      },
      {
        label: 'Comunicaciones',
        icon: 'i-lucide-mails',
        tabs: [
          tab(
            '/admin/comunicaciones-multicanal',
            'Mensajes',
            'i-lucide-message-square-more',
            A,
            'Correos, SMS y avisos enviados a clientes.'
          ),
          tab('/admin/newsletter', 'Boletín', 'i-lucide-mails', A, 'Ediciones del boletín y sus suscriptores.'),
          tab(
            '/admin/automatizaciones',
            'Automatizaciones',
            'i-lucide-workflow',
            A,
            'Mensajes que se envían solos según lo que hace el cliente.'
          ),
          tab(
            '/admin/avisos-alto-valor',
            'Avisos importantes',
            'i-lucide-bell-ring',
            A,
            'Mensajes prioritarios a clientes clave.'
          ),
          tab(
            '/admin/optimizacion-envios',
            'Mejor hora de envío',
            'i-lucide-send',
            A,
            'Cuándo abre cada cliente los mensajes.'
          ),
          tab(
            '/admin/modales',
            'Ventanas emergentes',
            'i-lucide-megaphone',
            A,
            'Avisos emergentes que se muestran en la tienda.'
          ),
          tab(
            '/admin/recuperacion-navegacion',
            'Carritos y visitas',
            'i-lucide-compass',
            A,
            'Recordatorios a clientes que dejaron una compra a medias.'
          )
        ]
      },
      {
        label: 'Contenido y SEO',
        icon: 'i-lucide-panels-top-left',
        tabs: [
          tab(
            '/admin/contenido',
            'Páginas',
            'i-lucide-panels-top-left',
            C,
            'Portada, páginas y bloques de contenido de la tienda.'
          ),
          tab('/admin/contenido-editorial', 'Artículos', 'i-lucide-file-text', CA, 'Guías y artículos profesionales.'),
          tab(
            '/admin/briefing-seo',
            'Calendario editorial',
            'i-lucide-calendar-days',
            CA,
            'Planificación de contenidos y palabras clave.'
          ),
          tab(
            '/admin/seo',
            'SEO',
            'i-lucide-search-check',
            ['administration.manage', 'catalog.write'],
            'Salud técnica de la tienda en buscadores.'
          ),
          tab(
            '/admin/gobernanza-contenido',
            'Revisión',
            'i-lucide-book-check',
            C,
            'Contenidos pendientes de revisar o caducados.'
          ),
          tab(
            '/admin/preview-comparacion',
            'Comparar cambios',
            'i-lucide-diff',
            C,
            'Diferencias entre la versión publicada y el borrador.'
          ),
          tab(
            '/admin/casos-cliente',
            'Casos de éxito',
            'i-lucide-award',
            A,
            'Historias de clientes publicadas en la tienda.'
          ),
          tab('/admin/aprendizaje', 'Formación', 'i-lucide-graduation-cap', A, 'Cursos y recursos para clientes.'),
          tab(
            '/admin/ugc-moderacion',
            'Fotos de clientes',
            'i-lucide-camera',
            A,
            'Imágenes enviadas por clientes pendientes de aprobar.'
          )
        ]
      }
    ]
  },
  {
    id: 'informes',
    label: 'Informes',
    icon: 'i-lucide-chart-no-axes-combined',
    items: [
      {
        label: 'Analítica',
        icon: 'i-lucide-chart-no-axes-combined',
        tabs: [
          tab(
            '/admin/analitica',
            'Ventas y conversión',
            'i-lucide-chart-no-axes-combined',
            A,
            'Visitas, conversión y ventas de la tienda.'
          ),
          tab(
            '/admin/analitica?tab=payment_funnel',
            'Embudo de pago',
            'i-lucide-credit-card',
            A,
            'Dónde se abandonan los pagos.'
          ),
          tab(
            '/admin/rendimiento',
            'Velocidad de la tienda',
            'i-lucide-gauge',
            A,
            'Rendimiento de las páginas que más venden.'
          )
        ]
      },
      {
        label: 'Búsquedas',
        icon: 'i-lucide-search-check',
        tabs: [
          tab(
            '/admin/analitica-busqueda',
            'Qué buscan los clientes',
            'i-lucide-search-check',
            A,
            'Términos más buscados y sus resultados.'
          ),
          tab(
            '/admin/busquedas-sin-resultado',
            'Sin resultado',
            'i-lucide-search-x',
            C,
            'Búsquedas que no encontraron ningún producto.'
          )
        ]
      }
    ]
  },
  {
    id: 'ajustes',
    label: 'Ajustes',
    icon: 'i-lucide-settings',
    items: [
      {
        label: 'Tienda y mercados',
        icon: 'i-lucide-store',
        tabs: [
          tab(
            '/admin/catalogo-mercados',
            'Mercados',
            'i-lucide-globe',
            A,
            'Países, idiomas y catálogo disponible en cada mercado.'
          ),
          tab(
            '/admin/checkout-mercados',
            'Compra por mercado',
            'i-lucide-shopping-cart',
            A,
            'Pagos, impuestos y envíos del proceso de compra en cada mercado.'
          )
        ]
      },
      {
        label: 'Usuarios y permisos',
        icon: 'i-lucide-shield-check',
        tabs: [
          tab('/admin/equipo', 'Equipo', 'i-lucide-users', A, 'Personas con acceso al panel y sus permisos.', true),
          tab(
            '/admin/auditoria',
            'Registro de actividad',
            'i-lucide-history',
            A,
            'Quién ha cambiado qué y cuándo.',
            true
          )
        ]
      },
      {
        label: 'Avisos',
        icon: 'i-lucide-bell-ring',
        tabs: [
          tab(
            '/admin/alertas-operativas',
            'Avisos del equipo',
            'i-lucide-bell-ring',
            A,
            'Qué incidencias avisan al equipo y por qué canal.'
          )
        ]
      },
      {
        label: 'Búsqueda y recomendaciones',
        icon: 'i-lucide-search',
        tabs: [
          tab(
            '/admin/busqueda',
            'Buscador',
            'i-lucide-search-check',
            C,
            'Sinónimos, redirecciones y orden de los resultados.'
          ),
          tab(
            '/admin/recomendaciones',
            'Recomendaciones',
            'i-lucide-sparkles',
            CA,
            'Productos sugeridos en fichas y carrito.'
          )
        ]
      },
      {
        label: 'Integraciones',
        icon: 'i-lucide-plug',
        tabs: [
          tab(
            '/admin/conectores',
            'Conectores',
            'i-lucide-plug',
            A,
            'Conexiones con ERP, transportistas y otros servicios.'
          ),
          tab(
            '/admin/integraciones',
            'API y avisos web',
            'i-lucide-webhook',
            A,
            'Claves de API, entornos de prueba y notificaciones a sistemas externos.'
          )
        ]
      },
      {
        label: 'Inteligencia artificial',
        icon: 'i-lucide-sparkles',
        tabs: [
          tab(
            '/admin/asistente-ia',
            'Asistente',
            'i-lucide-sparkles',
            A,
            'Generación y mejora de textos e imágenes del catálogo.'
          ),
          tab(
            '/admin/evaluacion-modelos',
            'Control de calidad',
            'i-lucide-shield-check',
            A,
            'Evaluación de los modelos antes de usarlos.'
          )
        ]
      },
      {
        label: 'Avanzado',
        icon: 'i-lucide-wrench',
        tabs: [
          tab(
            '/admin/plataforma',
            'Estado del sistema',
            'i-lucide-activity',
            A,
            'Salud de los servicios de la tienda.',
            true
          ),
          tab(
            '/admin/operaciones',
            'Procesos y colas',
            'i-lucide-list-restart',
            A,
            'Tareas automáticas, reintentos y bloqueos.'
          ),
          tab('/admin/observabilidad', 'Supervisión', 'i-lucide-radar', A, 'Disponibilidad, errores y capacidad.'),
          tab(
            '/admin/despliegues',
            'Publicación de versiones',
            'i-lucide-rocket',
            A,
            'Controles previos a publicar una versión nueva.'
          ),
          tab('/admin/garantia-calidad', 'Pruebas', 'i-lucide-check-check', A, 'Resultado de las pruebas automáticas.')
        ]
      }
    ]
  }
]

const allows = (capabilities: AdminCapabilities, permission: Permission | Permission[]) =>
  (Array.isArray(permission) ? permission : [permission]).some((value) => capabilities.permissions.includes(value))

/** Árbol filtrado por permisos para el menú lateral, las pestañas y los accesos de «Hoy». */
export function adminNavigationTree(capabilities: AdminCapabilities | null): AdminNavigationSection[] {
  if (capabilities?.state !== 'ready') return []
  return tree
    .map((section) => ({
      ...section,
      items: section.items
        .map((item) => ({ ...item, tabs: item.tabs.filter((entry) => allows(capabilities, entry.permission)) }))
        .filter((item) => item.tabs.length > 0)
    }))
    .filter((section) => section.items.length > 0)
}
/** Navigation hints only: every business API must still authorize its own operation. */
export function adminNavigationGroups(
  capabilities: AdminCapabilities | null
): Array<{ label: string; links: AdminNavigationLink[] }> {
  return adminNavigationTree(capabilities).map((section) => ({
    label: section.label,
    links: section.items.flatMap((item) =>
      item.tabs.map(({ to, label, icon, exact }) => ({
        to,
        label: item.tabs.length > 1 && label !== item.label ? `${item.label} · ${label}` : label,
        icon,
        ...(exact ? { exact } : {})
      }))
    )
  }))
}
const pathOf = (to: string) => to.split('?')[0]!
const matches = (path: string, link: AdminNavigationLink) =>
  path === pathOf(link.to) || (!link.exact && path.startsWith(pathOf(link.to) + '/'))
export function canNavigateAdmin(path: string, capabilities: AdminCapabilities | null): boolean {
  return adminNavigationTree(capabilities).some((section) =>
    section.items.some((item) => item.tabs.some((entry) => matches(path, entry)))
  )
}
/** Sección, entrada y pestaña que corresponden a una ruta (la coincidencia más específica gana). */
export function adminNavigationLocate(
  path: string,
  sections: AdminNavigationSection[],
  fullPath = path
): { section: AdminNavigationSection; item: AdminNavigationItem; tab: AdminNavigationTab } | null {
  let best: { section: AdminNavigationSection; item: AdminNavigationItem; tab: AdminNavigationTab } | null = null
  let score = -1
  for (const section of sections)
    for (const item of section.items)
      for (const entry of item.tabs) {
        if (!matches(path, entry)) continue
        const query = entry.to.includes('?')
        if (query && !fullPath.includes(entry.to.split('?')[1]!)) continue
        const value = pathOf(entry.to).length * 2 + (query ? 1 : 0)
        if (value > score) {
          score = value
          best = { section, item, tab: entry }
        }
      }
  return best
}
