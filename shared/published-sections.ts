/**
 * Secciones de contenido que solo existen cuando tienen contenido.
 *
 * Eran rutas públicas e indexables que respondían «estará disponible próximamente» o, peor,
 * prometían certificaciones y un verificador sin nada detrás. Una página así resta: ahora
 * cada sección se publica expresamente (`PUBLISHED_SECTIONS`, lista separada por comas) y,
 * mientras no esté en esa lista, responde 404 y no aparece en el sitemap ni en la navegación.
 *
 * `/recursos` queda fuera: el centro de recursos ya tiene su propia puerta de publicación
 * (CMS) y su propio fragmento de sitemap.
 */
export const GATED_SECTIONS = [
  'certificaciones',
  'marca',
  'kits',
  'eventos',
  'plantillas',
  'casos-exito',
  'datos-y-herramientas'
] as const
export type GatedSection = (typeof GATED_SECTIONS)[number]

const isGated = (value: string): value is GatedSection => (GATED_SECTIONS as readonly string[]).includes(value)

/** Lee la lista configurada; lo que no sea una sección conocida se ignora. */
export function parsePublishedSections(raw: unknown): GatedSection[] {
  if (typeof raw !== 'string') return []
  const requested = raw.split(',').map((entry) => entry.trim().toLowerCase())
  return GATED_SECTIONS.filter((section) => requested.includes(section)).sort()
}

/** La sección a la que pertenece una ruta pública, o `null` si la ruta no está sujeta a publicación. */
export function gatedSectionForPath(path: string): GatedSection | null {
  const first = path.split(/[?#]/)[0]!.split('/')[1] ?? ''
  return isGated(first) ? first : null
}

export function isPathPublished(path: string, published: readonly string[]): boolean {
  const section = gatedSectionForPath(path)
  return section === null || published.includes(section)
}
