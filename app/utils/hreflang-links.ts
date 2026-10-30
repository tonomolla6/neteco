export interface MarketHreflangLink {
  hreflang: string
  href: string
}

export interface MarketHreflangResponse {
  canonical: string
  links: MarketHreflangLink[]
}

const PRODUCT_PATH = /^\/producto\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/
const HREFLANG = /^(?:x-default|[a-z]{2,3}-[A-Z]{2})$/

export function productSlugFromPath(path: string): string | null {
  return PRODUCT_PATH.exec(path)?.[1] ?? null
}

/**
 * Alternates for a product page. The server set is used only when it is safe: same origin, valid
 * hreflang values, no repeated value, es-ES and x-default present, and it contains this very page
 * (a set that does not reference itself is not reciprocal). Anything else falls back to the single-market pair.
 */
export function productAlternateLinks(
  origin: string,
  selfUrl: string,
  response: MarketHreflangResponse | null | undefined
): MarketHreflangLink[] {
  const fallback = [
    { hreflang: 'es-ES', href: selfUrl },
    { hreflang: 'x-default', href: selfUrl }
  ]
  const links = response?.links
  if (!Array.isArray(links) || links.length < 2 || links.length > 60) return fallback
  const seen = new Set<string>()
  for (const link of links) {
    if (
      !link ||
      typeof link.hreflang !== 'string' ||
      typeof link.href !== 'string' ||
      !HREFLANG.test(link.hreflang) ||
      !link.href.startsWith(`${origin}/`) ||
      seen.has(link.hreflang)
    )
      return fallback
    seen.add(link.hreflang)
  }
  if (!seen.has('es-ES') || !seen.has('x-default')) return fallback
  if (!links.some((link) => link.href === selfUrl)) return fallback
  return links.map(({ hreflang, href }) => ({ hreflang, href }))
}
