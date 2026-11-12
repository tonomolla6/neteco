/**
 * Últimos productos vistos, solo en este navegador. Alimentan «Recomendado para ti» sin
 * cuenta ni cookies de terceros: la lista nunca sale del navegador salvo como slugs en la
 * petición de recomendaciones, y no se guarda en el servidor.
 */
const STORAGE_KEY = 'neteco-recent-products'
const LIMIT = 12
const SLUG = /^[a-z0-9][a-z0-9-]{0,179}$/

export function useRecentlyViewed() {
  const slugs = useState<string[]>('recently-viewed-products', () => [])

  function restore() {
    if (!import.meta.client) return slugs.value
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
      if (Array.isArray(stored))
        slugs.value = stored
          .filter((slug): slug is string => typeof slug === 'string' && SLUG.test(slug))
          .slice(0, LIMIT)
    } catch {
      /* Sin almacenamiento, la franja usa lo más pedido. */
    }
    return slugs.value
  }

  function record(slug: string) {
    if (!import.meta.client || !SLUG.test(slug)) return
    restore()
    slugs.value = [slug, ...slugs.value.filter((entry) => entry !== slug)].slice(0, LIMIT)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slugs.value))
    } catch {
      /* La página sigue funcionando aunque no se pueda recordar. */
    }
  }

  return { slugs, restore, record }
}
