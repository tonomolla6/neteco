/**
 * Páginas legales de la tienda. Una sola lista para el pie, el SEO de cada ruta y los dos
 * sitemaps (Nitro y Worker), de modo que una página legal nueva no quede fuera de ninguno.
 *
 * Los datos del titular no viven aquí: salen de `runtimeConfig.public.commercial`
 * (`shared/commercial-terms.ts`).
 */

export interface LegalPage {
  path: '/aviso-legal' | '/privacidad' | '/cookies' | '/condiciones-generales'
  /** Texto del enlace en el pie y en el resto de páginas legales. */
  label: string
  title: string
  description: string
}

export const LEGAL_PAGES: readonly LegalPage[] = [
  {
    path: '/aviso-legal',
    label: 'Aviso legal',
    title: 'Aviso legal',
    description:
      'Titular de la tienda online NETECO, datos de contacto e inscripción, condiciones de uso del sitio y propiedad intelectual.'
  },
  {
    path: '/privacidad',
    label: 'Política de privacidad',
    title: 'Política de privacidad',
    description:
      'Qué datos tratamos en la tienda NETECO, para qué, con qué base jurídica, cuánto tiempo, quién los recibe y cómo ejercer tus derechos.'
  },
  {
    path: '/cookies',
    label: 'Política de cookies',
    title: 'Política de cookies',
    description:
      'Cookies que usa la tienda NETECO, para qué sirve cada una, cuánto duran y cómo cambiar tu consentimiento en cualquier momento.'
  },
  {
    path: '/condiciones-generales',
    label: 'Condiciones generales de venta',
    title: 'Condiciones generales de venta',
    description:
      'Proceso de compra, precios e IVA, pago, envío, desistimiento de 14 días, garantía y condiciones para clientes profesionales de NETECO.'
  }
]

export const LEGAL_PATHS: readonly string[] = LEGAL_PAGES.map((page) => page.path)
