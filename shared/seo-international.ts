export class HreflangError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict') {
    super(code)
    this.name = 'HreflangError'
  }
}

export interface HreflangAlternate {
  marketCode: string
  locale: string
  slug: string
}

export interface HreflangLink {
  hreflang: string
  href: string
}

export type HreflangExclusionReason = 'duplicate_hreflang' | 'invalid_slug' | 'invalid_locale'

export interface HreflangSet {
  /** Identical on every page of the cluster: that is what makes the annotations reciprocal. */
  links: HreflangLink[]
  canonicalByMarket: Record<string, string>
  excluded: Array<{ marketCode: string; reason: HreflangExclusionReason }>
}

export const BASE_MARKET = 'ES'
export const BASE_LOCALE = 'es-ES'
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOCALE = /^[a-z]{2,3}-[A-Z]{2}$/

/** Public URL for a market page; the base market keeps the historical /producto/<slug> path. */
function pageUrl(origin: string, locale: string, slug: string, base: boolean): string {
  return base
    ? `${origin}/producto/${encodeURIComponent(slug)}`
    : `${origin}/${locale.toLowerCase()}/producto/${encodeURIComponent(slug)}`
}

export function buildHreflangSet(
  originInput: string,
  base: { slug: string },
  alternates: HreflangAlternate[]
): HreflangSet {
  let origin: string
  try {
    const parsed = new URL(originInput)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol')
    origin = parsed.origin
  } catch {
    throw new HreflangError('invalid_input')
  }
  if (!SLUG.test(base.slug)) throw new HreflangError('invalid_input')

  const baseUrl = pageUrl(origin, BASE_LOCALE, base.slug, true)
  const links: HreflangLink[] = [{ hreflang: BASE_LOCALE, href: baseUrl }]
  const canonicalByMarket: Record<string, string> = { [BASE_MARKET]: baseUrl }
  const excluded: HreflangSet['excluded'] = []
  const seen = new Set<string>([BASE_LOCALE])

  // Deterministic order so the winner of a duplicate hreflang never depends on query order.
  const ordered = alternates
    .filter((alternate) => alternate.marketCode !== BASE_MARKET && alternate.locale !== BASE_LOCALE)
    .sort((left, right) => left.marketCode.localeCompare(right.marketCode))
  for (const alternate of ordered) {
    if (!LOCALE.test(alternate.locale)) {
      excluded.push({ marketCode: alternate.marketCode, reason: 'invalid_locale' })
    } else if (!SLUG.test(alternate.slug)) {
      excluded.push({ marketCode: alternate.marketCode, reason: 'invalid_slug' })
    } else if (seen.has(alternate.locale)) {
      excluded.push({ marketCode: alternate.marketCode, reason: 'duplicate_hreflang' })
    } else {
      seen.add(alternate.locale)
      const href = pageUrl(origin, alternate.locale, alternate.slug, false)
      links.push({ hreflang: alternate.locale, href })
      canonicalByMarket[alternate.marketCode] = href
    }
  }
  links.push({ hreflang: 'x-default', href: baseUrl })
  return { links, canonicalByMarket, excluded }
}
