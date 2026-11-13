/**
 * Mapa único del área de cliente.
 *
 * La portada de la cuenta (bloques clicables) y la navegación lateral salen de aquí, para que
 * una sección no pueda existir en un sitio y faltar en el otro.
 */
export interface AccountSection {
  to: string
  label: string
  description: string
  icon: string
  /** Solo existe cuando la tienda corre sobre el runtime de Cloudflare. */
  cloudflareOnly?: boolean
  /** Aparece como bloque en la portada, pero no se repite en la navegación lateral. */
  hubOnly?: boolean
}

export interface AccountSectionGroup {
  title: string
  sections: AccountSection[]
}

export const ACCOUNT_SECTION_GROUPS: AccountSectionGroup[] = [
  {
    title: 'Pedidos y compras',
    sections: [
      {
        to: '/cuenta/pedidos',
        label: 'Pedidos',
        description: 'Sigue un envío, repite una compra o descarga la factura.',
        icon: 'i-lucide-package'
      },
      {
        to: '/cuenta/pedidos?estado=devolver',
        label: 'Devoluciones',
        description: 'Elige el pedido y solicita la devolución de un producto.',
        icon: 'i-lucide-undo-2',
        hubOnly: true
      },
      {
        to: '/cuenta/listas',
        label: 'Listas',
        description: 'Tus productos habituales, listos para volver a pedir.',
        icon: 'i-lucide-list-checks'
      },
      {
        to: '/cuenta/presupuestos',
        label: 'Presupuestos',
        description: 'Consulta tus presupuestos y conviértelos en pedido.',
        icon: 'i-lucide-file-check-2',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/aportaciones-productos',
        label: 'Reseñas y preguntas',
        description: 'Lo que has opinado o preguntado sobre los productos.',
        icon: 'i-lucide-message-square',
        cloudflareOnly: true
      }
    ]
  },
  {
    title: 'Tu cuenta',
    sections: [
      {
        to: '/cuenta/seguridad',
        label: 'Acceso y seguridad',
        description: 'Contraseña, verificación en dos pasos y sesiones abiertas.',
        icon: 'i-lucide-shield-check'
      },
      {
        to: '/cuenta/direcciones',
        label: 'Direcciones',
        description: 'Dónde entregamos y a qué dirección facturamos.',
        icon: 'i-lucide-map-pin'
      },
      {
        to: '/cuenta/metodos-de-pago',
        label: 'Métodos de pago',
        description: 'Las tarjetas guardadas para pagar más rápido.',
        icon: 'i-lucide-credit-card',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/datos',
        label: 'Empresa y facturación',
        description: 'Tus datos de contacto y los datos fiscales del negocio.',
        icon: 'i-lucide-building-2'
      },
      {
        to: '/cuenta/solicitudes-b2b',
        label: 'Solicitudes de empresa',
        description: 'Crédito, altas de producto y otras peticiones comerciales.',
        icon: 'i-lucide-clipboard-list',
        cloudflareOnly: true
      }
    ]
  },
  {
    title: 'Avisos y comunicaciones',
    sections: [
      {
        to: '/cuenta/notificaciones',
        label: 'Notificaciones',
        description: 'Los mensajes sobre tus pedidos, facturas y consultas.',
        icon: 'i-lucide-bell',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/comunicaciones',
        label: 'Avisos y privacidad',
        description: 'Qué correos recibes y qué puedes hacer con tus datos.',
        icon: 'i-lucide-mail-check'
      },
      {
        to: '/cuenta/newsletter',
        label: 'Boletín',
        description: 'Elige de qué temas te escribimos y cada cuánto.',
        icon: 'i-lucide-mails',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/preferencias-mensajes',
        label: 'SMS y WhatsApp',
        description: 'Tus permisos para recibir avisos en el móvil.',
        icon: 'i-lucide-message-circle',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/avisos-productos',
        label: 'Avisos de productos',
        description: 'Te avisamos cuando algo vuelve a estar disponible o baja de precio.',
        icon: 'i-lucide-bell-ring',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/recuperar-carrito',
        label: 'Recordatorios de carrito',
        description: 'Recibe un recordatorio si dejas una compra a medias.',
        icon: 'i-lucide-shopping-cart',
        cloudflareOnly: true
      }
    ]
  },
  {
    title: 'Ayuda',
    sections: [
      {
        to: '/cuenta/soporte',
        label: 'Mis consultas',
        description: 'El seguimiento de lo que nos has preguntado.',
        icon: 'i-lucide-life-buoy',
        cloudflareOnly: true
      },
      {
        to: '/cuenta/revision-promociones',
        label: 'Revisión de promociones',
        description: 'El estado de las ventajas y referidos en revisión.',
        icon: 'i-lucide-shield-alert',
        cloudflareOnly: true
      }
    ]
  }
]

/** Secciones visibles según el runtime, conservando los grupos que no quedan vacíos. */
export function accountSectionGroups(cloudflare: boolean): AccountSectionGroup[] {
  return ACCOUNT_SECTION_GROUPS.map((group) => ({
    title: group.title,
    sections: group.sections.filter((section) => cloudflare || !section.cloudflareOnly)
  })).filter((group) => group.sections.length > 0)
}

/** Sección a la que pertenece una ruta de la cuenta; sirve para el rastro de migas. */
export function accountSectionFor(path: string): AccountSection | undefined {
  const clean = path.replace(/\/+$/, '')
  return ACCOUNT_SECTION_GROUPS.flatMap((group) => group.sections).find(
    (section) => !section.hubOnly && (clean === section.to || clean.startsWith(`${section.to}/`))
  )
}
