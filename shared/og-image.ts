// Contrato compartido (Worker y páginas) de las tarjetas Open Graph dinámicas:
// /og/<tipo>/<slug>.png, 1200x630. El Worker genera el PNG al vuelo y las páginas lo referencian.
export const OG_WIDTH = 1200
export const OG_HEIGHT = 630
export const OG_KINDS = ['producto', 'categoria', 'plantilla', 'contenido'] as const
export type OgKind = (typeof OG_KINDS)[number]

const SLUG = /^[a-z0-9][a-z0-9-]{0,179}$/
const ROUTE = /^\/og\/(producto|categoria|plantilla|contenido)\/([^/]+)\.png$/

export function isOgSlug(value: string): boolean {
  return SLUG.test(value)
}

/** Solo reconoce la ruta canónica; cualquier alias, codificación o slug no canónico queda fuera. */
export function parseOgImagePath(pathname: string): { kind: OgKind; slug: string } | null {
  const match = ROUTE.exec(pathname)
  if (!match || !SLUG.test(match[2]!)) return null
  return { kind: match[1] as OgKind, slug: match[2]! }
}

/** `version` (ver `ogVersion`) fuerza a CDN y redes sociales a pedir de nuevo la tarjeta cuando cambia el contenido. */
export function ogImagePath(kind: OgKind, slug: string, version?: string): string {
  return `/og/${kind}/${slug}.png${version ? `?v=${version}` : ''}`
}

/** Hash FNV-1a de 32 bits de los campos que se dibujan; no es un secreto ni una garantía de seguridad. */
export function ogVersion(...parts: ReadonlyArray<string | number | null | undefined>): string {
  let hash = 0x811c9dc5
  for (const char of parts.map((part) => (part == null ? '' : String(part))).join('\u001f')) {
    hash ^= char.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

const STATIC_CATEGORY_CARDS = new Set(['productos-quimicos', 'menaje-hosteleria'])

/** Tarjeta estática equivalente de public/ cuando la dinámica no se puede generar. */
export function ogStaticFallback(kind: OgKind, slug?: string): string {
  if (kind === 'producto') return '/og/og-producto.jpg'
  if (kind === 'plantilla') return '/og/og-plantillas.jpg'
  if (kind === 'categoria' && slug && STATIC_CATEGORY_CARDS.has(slug)) return `/og/og-categoria-${slug}.jpg`
  return '/og-default.jpg'
}
