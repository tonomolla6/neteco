import manifest from '~/assets/home-images.json'

/**
 * Fotografías de la portada, la cabecera y las páginas de error.
 *
 * Las genera aparte el encargo de imágenes y `scripts/sync-home-images.mjs` las copia a
 * `public/img/home/` y vuelca su manifiesto a `app/assets/home-images.json`. Mientras ese
 * manifiesto esté vacío, cada bloque usa su reserva (la foto de un producto real de la
 * familia, o una superficie de marca) y la página se ve completa igualmente.
 *
 * Se sirven como estáticos, no desde `/img/products`: el Worker de Cloudflare no publica
 * los originales de producto, pero sí los recursos propios de la tienda.
 */
export interface HomeImage {
  src: string
  alt: string
  width: number
  height: number
}

interface ManifestRow {
  file: string
  alt: string
  width: number
  height: number
}

const BASE = '/img/home'
const rows = manifest as ManifestRow[]
const byName = new Map(rows.map((row) => [row.file.replace(/\.[a-z0-9]+$/i, ''), row]))

/** Imagen por nombre de fichero sin extensión («hero-cocina», «familia-guantes»), o `null`. */
export function homeImage(name: string): HomeImage | null {
  const row = byName.get(name)
  return row ? { src: `${BASE}/${row.file}`, alt: row.alt, width: row.width, height: row.height } : null
}

/** Todas las imágenes cuyo nombre empieza por un prefijo, en el orden del manifiesto. */
export function homeImagesByPrefix(prefix: string): Array<HomeImage & { name: string }> {
  return rows
    .filter((row) => row.file.startsWith(prefix))
    .map((row) => ({
      name: row.file.replace(/\.[a-z0-9]+$/i, ''),
      src: `${BASE}/${row.file}`,
      alt: row.alt,
      width: row.width,
      height: row.height
    }))
}

/** Foto de la familia del catálogo, si el encargo de imágenes ha producido una para ese slug. */
export function familyPhoto(slug: string): HomeImage | null {
  return homeImage(`familia-${slug}`)
}
