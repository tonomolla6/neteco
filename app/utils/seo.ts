import { LEGAL_PAGES } from '../../shared/legal-pages'

type RouteQuery = Record<string, unknown>

export const PRIVATE_SEO_PREFIXES = [
  '/admin',
  '/cuenta',
  '/carrito',
  '/checkout',
  '/pedido',
  '/pedidos',
  '/pago',
  '/auth',
  '/login',
  '/registro',
  '/recuperar-clave',
  '/restablecer-clave',
  '/verificar-email',
  '/buscar',
  '/newsletter',
  '/reparto',
  '/encuesta',
  '/comparar'
] as const

export function paginationNumber(query: RouteQuery): number | null {
  const raw = Array.isArray(query.page) ? query.page[0] : query.page
  const value = String(raw ?? '')
  if (!/^[1-9]\d*$/.test(value)) return null
  return Number(value)
}

export function normalizeSeoPath(path: string): string {
  const clean = path.split('?')[0]?.replace(/\/+$/, '') || '/'
  return clean.startsWith('/') ? clean : `/${clean}`
}

export function canonicalPath(path: string, query: RouteQuery): string {
  const base = normalizeSeoPath(path)
  const supportsPagination = base === '/catalogo' || base.startsWith('/categoria/')
  const page = supportsPagination ? paginationNumber(query) : null
  return page && page > 1 ? `${base}?page=${page}` : base
}

export function isIndexableCatalogQuery(query: RouteQuery): boolean {
  const keys = Object.keys(query)
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'page' && paginationNumber(query) !== null)
}

export function isPrivateSeoPath(path: string): boolean {
  const normalized = normalizeSeoPath(path)
  return PRIVATE_SEO_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

export function stripDuplicateBrand(title: string): string {
  return title
    .replace(/\s*(?:·|\||-|—)\s*neteco\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatSeoTitle(title: string, maxTotalLength = 60): string {
  const cleaned = stripDuplicateBrand(title)
  if (!cleaned || /^neteco$/i.test(cleaned)) return 'NETECO'
  const suffixLength = ' · NETECO'.length
  const maxBaseLength = Math.max(12, maxTotalLength - suffixLength)
  if (cleaned.length <= maxBaseLength) return cleaned
  const slice = cleaned.slice(0, maxBaseLength - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxBaseLength * 0.6) ? slice.slice(0, lastSpace) : slice
  return `${cut.replace(/[.,;:·|-]+$/, '').trim()}…`
}

export function truncateSeoDescription(description: string, maxLength = 155): string {
  const normalized = description.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const slice = normalized.slice(0, maxLength - 1)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace >= Math.floor(maxLength * 0.6) ? slice.slice(0, lastSpace) : slice
  return `${cut.replace(/[.,;:·|-]+$/, '').trim()}…`
}

const ROUTE_SEO_DEFAULTS: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Suministros de higiene y limpieza profesional',
    description:
      'Tienda online de NETECO: celulosa industrial, químicos de limpieza, bolsas de basura, guantes y EPIs para hostelería e industria en España.'
  },
  '/catalogo': {
    title: 'Catálogo de higiene y limpieza profesional',
    description:
      'Catálogo completo de celulosa industrial, químicos profesionales, bolsas de basura, guantes, EPIs y útiles de limpieza con envío 24/48 h.'
  },
  '/eventos': {
    title: 'Eventos, ferias y demostraciones técnicas',
    description:
      'Calendario de ferias profesionales, demostraciones técnicas y jornadas de higiene industrial y hostelería organizadas por NETECO.'
  },
  '/kits': {
    title: 'Kits de higiene y limpieza por sector',
    description:
      'Kits preconfigurados de celulosa, químicos y consumibles profesionales para hostelería, industria alimentaria, clínicas y oficinas.'
  },
  '/marca': {
    title: 'Centro de marca y activos corporativos',
    description:
      'Identidad visual, logotipos oficiales, guía de estilo y activos verificados de marca NETECO para distribuidores y prensa.'
  },
  '/certificaciones': {
    title: 'Certificados y registros',
    description:
      'Certificados y registros de NETECO y de sus productos, cada uno con su número, su entidad emisora y su documento.'
  },
  '/casos-exito': {
    title: 'Casos de éxito en higiene profesional',
    description:
      'Proyectos reales de optimización de costes y suministro de higiene e limpieza industrial con clientes de hostelería e industria.'
  },
  '/plantillas': {
    title: 'Plantillas y checklists de limpieza B2B',
    description:
      'Plantillas descargables de control APPCC, registros de limpieza y checklists operativos para equipos de mantenimiento e higiene.'
  },
  '/datos-y-herramientas': {
    title: 'Datos técnicos y calculadoras de consumo',
    description:
      'Calculadoras de dosificación, tablas de compatibilidad química y herramientas técnicas para optimizar el consumo de higiene.'
  },
  '/recursos': {
    title: 'Centro de recursos y guías de higiene',
    description:
      'Guías técnicas, protocolos de desinfección y artículos especializados sobre limpieza profesional y normativa sanitaria vigente.'
  },
  '/ayuda': {
    title: 'Preguntas frecuentes y centro de ayuda',
    description:
      'Respuestas sobre pedidos, envíos 24/48 h, facturación B2B, pagos seguros y devoluciones en la tienda profesional de NETECO.'
  },
  '/contacto': {
    title: 'Contacto y asesoramiento técnico comercial',
    description:
      'Contacta con el equipo de NETECO en Ontinyent (Valencia) para presupuestos por volumen, fichas técnicas o consultas de pedidos.'
  },
  '/envios': {
    title: 'Envíos y plazos de entrega en península',
    description:
      'Condiciones de transporte de NETECO: entrega en 24/48 horas en península, portes gratis desde 150 € y recogida en Ontinyent.'
  },
  '/devoluciones': {
    title: 'Política de devoluciones y garantías',
    description:
      'Plazos de desistimiento de 14 días, gestión de incidencias de transporte y condiciones de devolución para suministros de NETECO.'
  },
  '/formas-de-pago': {
    title: 'Formas de pago seguro y facturación',
    description:
      'Paga tus pedidos profesionales con tarjeta bancaria, Bizum o transferencia inmediata con factura electrónica con IVA desglosado.'
  },
  ...Object.fromEntries(LEGAL_PAGES.map(({ path, title, description }) => [path, { title, description }])),
  '/accesibilidad': {
    title: 'Declaración de accesibilidad web WCAG',
    description:
      'Compromiso de NETECO con la accesibilidad digital conforme a UNE-EN 301 549 y WCAG 2.1 nivel AA y canal de comunicación.'
  },
  '/carrito': {
    title: 'Tu carrito de compra profesional',
    description:
      'Revisa las referencias seleccionadas, calcula los gastos de envío e impuestos y tramita tu pedido profesional en NETECO.'
  },
  '/carrito/compartido': {
    title: 'Carrito compartido de suministros',
    description:
      'Consulta las referencias y precios actuales de un carrito compartido de NETECO y añade los productos seleccionados a tu pedido.'
  },
  '/checkout': {
    title: 'Finalizar compra y datos de facturación',
    description:
      'Introduce la dirección de entrega, los datos fiscales de facturación y selecciona el método de pago para confirmar tu pedido.'
  },
  '/login': {
    title: 'Iniciar sesión en tu cuenta de cliente',
    description:
      'Accede a tu área privada de cliente en NETECO para consultar pedidos, descargar facturas y repetir compras habituales.'
  },
  '/registro': {
    title: 'Crear cuenta profesional o particular',
    description:
      'Regístrate en NETECO para guardar direcciones de envío, gestionar tus datos fiscales de empresa y agilizar tus pedidos.'
  },
  '/recuperar-clave': {
    title: 'Recuperar contraseña de acceso',
    description:
      'Solicita un enlace seguro por correo electrónico para restablecer la contraseña de acceso a tu cuenta de cliente en NETECO.'
  },
  '/restablecer-clave': {
    title: 'Restablecer contraseña de tu cuenta',
    description:
      'Define una nueva contraseña segura para recuperar el acceso a tu cuenta profesional o particular en la tienda de NETECO.'
  },
  '/verificar-email': {
    title: 'Verificación de correo electrónico',
    description:
      'Confirma tu dirección de correo electrónico para activar todas las funciones de compra y facturación de tu cuenta NETECO.'
  },
  '/pedido-rapido': {
    title: 'Pedido rápido por referencia',
    description:
      'Pide con el albarán delante: escribe las referencias de NETECO, pega tu lista o sube un archivo y añádelo todo al carrito de una vez.'
  },
  '/comparar': {
    title: 'Comparador técnico de suministros',
    description:
      'Compara formatos, precios unitarios, especificaciones técnicas y disponibilidad entre referencias del catálogo de NETECO.'
  },
  '/reparto': {
    title: 'Operativa de reparto y entregas en ruta',
    description:
      'Aplicación operativa interna para conductores y confirmación de entregas en ruta de pedidos logísticos de NETECO.'
  },
  '/newsletter/baja': {
    title: 'Cancelar suscripción al boletín comercial',
    description:
      'Gestiona la baja inmediata de tu dirección de correo electrónico en las comunicaciones comerciales y novedades de NETECO.'
  },
  '/newsletter/confirmar': {
    title: 'Confirmar suscripción al boletín NETECO',
    description:
      'Valida tu dirección de correo electrónico para recibir ofertas profesionales y novedades del catálogo de higiene de NETECO.'
  },
  '/cuenta': {
    title: 'Resumen de mi cuenta de cliente',
    description:
      'Panel privado de cliente en NETECO: consulta el resumen de actividad, últimos pedidos, direcciones y datos de facturación.'
  },
  '/cuenta/pedidos': {
    title: 'Historial de pedidos y facturas',
    description:
      'Consulta el estado de tus pedidos en curso, descarga facturas en PDF y repite compras anteriores desde tu cuenta de NETECO.'
  },
  '/cuenta/direcciones': {
    title: 'Mis direcciones de envío y facturación',
    description:
      'Gestiona tus direcciones habituales de entrega, almacenes de recepción y datos fiscales de facturación en NETECO.'
  },
  '/cuenta/listas': {
    title: 'Listas de compra recurrente B2B',
    description:
      'Organiza tus listas de productos habituales para reponer stock de higiene y limpieza en pocos clics desde tu cuenta NETECO.'
  },
  '/cuenta/fidelidad': {
    title: 'Programa de puntos y fidelidad',
    description:
      'Consulta tu saldo de puntos acumulados, nivel de cliente y recompensas disponibles por tus compras profesionales en NETECO.'
  },
  '/cuenta/privacidad': {
    title: 'Privacidad, consentimientos y datos RGPD',
    description:
      'Configura tus preferencias de privacidad, descarga tus datos personales o ejerce tus derechos ARCO/RGPD en NETECO.'
  },
  '/cuenta/reclamaciones': {
    title: 'Mis reclamaciones e incidencias de pedido',
    description:
      'Realiza el seguimiento de incidencias logísticas, devoluciones y reclamaciones abiertas sobre tus pedidos en NETECO.'
  },
  '/cuenta/referidos': {
    title: 'Programa de recomendación e invitaciones',
    description:
      'Invita a otras empresas y profesionales a comprar en NETECO y consulta el estado de tus bonificaciones por referidos.'
  },
  '/cuenta/suscripciones': {
    title: 'Suscripciones de reposición periódica',
    description:
      'Administra tus entregas programadas de consumibles de higiene, frecuencias de envío y referencias suscritas en NETECO.'
  },
  '/admin': {
    title: 'Panel de administración y control',
    description:
      'Cuadro de mando administrativo de NETECO con indicadores clave de ventas, pedidos pendientes, catálogo y operativa diaria.'
  },
  '/admin/campanas-estacionales': {
    title: 'Campañas estacionales · Administración',
    description:
      'Configuración y seguimiento de campañas comerciales estacionales, promociones temáticas y creatividades en el panel de NETECO.'
  }
}

function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function defaultRouteSeo(path: string): {
  title: string
  description: string
  robots: string
  ogType: 'website' | 'product'
} {
  const normalized = normalizeSeoPath(path)
  const isPrivate = isPrivateSeoPath(normalized)
  const robots = isPrivate ? 'noindex, nofollow' : 'index, follow'
  const ogType = normalized.startsWith('/producto/') ? 'product' : 'website'

  const exact = ROUTE_SEO_DEFAULTS[normalized]
  if (exact) {
    return {
      title: formatSeoTitle(exact.title),
      description: truncateSeoDescription(exact.description),
      robots,
      ogType
    }
  }

  if (normalized.startsWith('/admin/')) {
    const section = humanizeSlug(normalized.slice('/admin/'.length).replace(/\//g, '-'))
    return {
      title: formatSeoTitle(`${section} · Administración`),
      description: truncateSeoDescription(
        `Módulo interno de gestión de ${section.toLowerCase()} en el panel de administración y operaciones de NETECO.`
      ),
      robots,
      ogType
    }
  }

  if (normalized.startsWith('/cuenta/')) {
    const section = humanizeSlug(normalized.slice('/cuenta/'.length).replace(/\//g, '-'))
    return {
      title: formatSeoTitle(`${section} · Mi cuenta`),
      description: truncateSeoDescription(
        `Gestión privada de ${section.toLowerCase()} en el área de cliente profesional y particular de NETECO.`
      ),
      robots,
      ogType
    }
  }

  if (normalized.startsWith('/categoria/')) {
    const section = humanizeSlug(normalized.slice('/categoria/'.length))
    return {
      title: formatSeoTitle(`${section} profesional`),
      description: truncateSeoDescription(
        `Compra ${section.toLowerCase()} para uso profesional e industrial en NETECO con stock propio y envío 24/48 h.`
      ),
      robots,
      ogType
    }
  }

  if (normalized.startsWith('/producto/')) {
    const section = humanizeSlug(normalized.slice('/producto/'.length))
    return {
      title: formatSeoTitle(section),
      description: truncateSeoDescription(
        `Ficha técnica, formatos y precios profesionales de ${section.toLowerCase()} en el catálogo online de NETECO.`
      ),
      robots,
      ogType
    }
  }

  const label = humanizeSlug(normalized.slice(1).replace(/\//g, '-')) || 'Catálogo profesional'
  return {
    title: formatSeoTitle(label),
    description: truncateSeoDescription(
      `${label} en la tienda profesional de suministros de higiene, celulosa y limpieza industrial de NETECO.`
    ),
    robots,
    ogType
  }
}

export function errorPageSeo(statusCode?: number): {
  title: string
  description: string
  robots: string
} {
  if (statusCode === 410) {
    return {
      title: 'Contenido retirado',
      description: 'Este recurso o producto ya no forma parte del catálogo público vigente de NETECO.',
      robots: 'noindex, nofollow'
    }
  }
  if (statusCode === 404) {
    return {
      title: 'Página no encontrada',
      description: 'La página solicitada no existe o ha cambiado de dirección en la tienda online de NETECO.',
      robots: 'noindex, nofollow'
    }
  }
  return {
    title: 'Error temporal del servicio',
    description: 'No hemos podido completar la solicitud en este momento. Vuelve a intentarlo en unos segundos.',
    robots: 'noindex, nofollow'
  }
}

export function buildWebsiteJsonLd(origin: string) {
  const cleanOrigin = origin.replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'NETECO',
    url: cleanOrigin,
    inLanguage: 'es-ES',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${cleanOrigin}/buscar?q={search_term_string}`
      },
      'query-input': 'required name=search_term_string'
    }
  }
}

export function buildBreadcrumbJsonLd(origin: string, items: Array<{ name: string; path: string }>) {
  const cleanOrigin = origin.replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${cleanOrigin}${item.path === '/' ? '/' : item.path.replace(/\/+$/, '')}`
    }))
  }
}

export function buildItemListJsonLd(
  origin: string,
  name: string,
  items: Array<{ name: string; slug: string; position?: number }>
) {
  const cleanOrigin = origin.replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: item.position ?? index + 1,
      name: item.name,
      url: `${cleanOrigin}/producto/${encodeURIComponent(item.slug)}`
    }))
  }
}

export function buildFaqPageJsonLd(items: Array<{ question: string; answer: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer
      }
    }))
  }
}
