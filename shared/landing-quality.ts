/**
 * SEO-028: value gate for sector / need / locality landings. Pure and deterministic so the public page,
 * the resource list and the sitemap agree. A landing that fails any rule is noindex (thin / doorway page).
 */
export const LANDING_MIN_LIVE_PRODUCTS = 3
export const LANDING_MIN_TEXT_CHARS = 1200
export const LANDING_DUPLICATE_THRESHOLD = 0.8

export type LandingFacet = 'sector' | 'need' | 'locality' | 'general'
export type LandingReason =
  | 'offer_missing'
  | 'thin_content'
  | 'cases_missing'
  | 'advice_missing'
  | 'coverage_missing'
  | 'coverage_unspecific'
  | `duplicate_of:${string}`

export interface LandingBlock {
  type: string
  text?: string
  items?: string[]
}
export interface LandingCandidate {
  slug: string
  kind: string
  publishedAt: string
  categorySlug: string
  /** Published, publication-valid products linked from the landing (counted by the server, not declared). */
  liveProductCount: number
  blocks: LandingBlock[]
}
export interface LandingVerdict {
  slug: string
  facet: LandingFacet
  key: string
  indexable: boolean
  reasons: LandingReason[]
  textChars: number
}

const PREFIXES: Array<[string, Exclude<LandingFacet, 'general'>]> = [
  ['sector-', 'sector'],
  ['necesidad-', 'need'],
  ['localidad-', 'locality']
]
export function parseLandingFacet(categorySlug: string): { facet: LandingFacet; key: string } {
  for (const [prefix, facet] of PREFIXES)
    if (categorySlug.startsWith(prefix) && categorySlug.length > prefix.length)
      return { facet, key: categorySlug.slice(prefix.length) }
  return { facet: 'general', key: categorySlug }
}

const bodyTexts = (blocks: LandingBlock[]) =>
  blocks.flatMap((b) =>
    b.type === 'paragraph' || b.type === 'callout' ? [b.text ?? ''] : b.type === 'list' ? (b.items ?? []) : []
  )
const headings = (blocks: LandingBlock[]) => blocks.filter((b) => b.type === 'heading').map((b) => b.text ?? '')
const has = (values: string[], pattern: RegExp) => values.some((value) => pattern.test(value))
const words = (text: string) =>
  text
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
function shingles(text: string) {
  const w = words(text),
    out = new Set<string>()
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(' '))
  return out
}
function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  return shared / (a.size + b.size - shared)
}

const CASES = /caso|ejemplo|cliente/i
const ADVICE = /consejo|recomend|c[oó]mo\b/i
const COVERAGE_HEADING = /cobertura|entrega|reparto|zona/i
const COVERAGE_DETAIL = /\b\d{5}\b|\b\d+\s*(?:h|horas|d[ií]as|laborables)\b/i

/** Evaluates only `kind === 'landing'` candidates; the earliest published of a duplicate group keeps its status. */
export function evaluateLandingSet(candidates: LandingCandidate[]): Map<string, LandingVerdict> {
  const landings = candidates
    .filter((c) => c.kind === 'landing')
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.slug.localeCompare(b.slug))
  const verdicts = new Map<string, LandingVerdict>()
  const seen: Array<{ slug: string; shingles: Set<string> }> = []
  for (const landing of landings) {
    const { facet, key } = parseLandingFacet(landing.categorySlug)
    const texts = bodyTexts(landing.blocks),
      heads = headings(landing.blocks)
    const textChars = texts.reduce((sum, t) => sum + t.length, 0)
    const reasons: LandingReason[] = []
    if (landing.liveProductCount < LANDING_MIN_LIVE_PRODUCTS) reasons.push('offer_missing')
    if (textChars < LANDING_MIN_TEXT_CHARS) reasons.push('thin_content')
    if (facet === 'sector' && !has(heads, CASES)) reasons.push('cases_missing')
    if (facet === 'need' && !has(heads, ADVICE)) reasons.push('advice_missing')
    if (facet === 'locality') {
      if (!has(heads, COVERAGE_HEADING)) reasons.push('coverage_missing')
      else if (!has(texts, COVERAGE_DETAIL)) reasons.push('coverage_unspecific')
    }
    const fingerprint = shingles(texts.join(' '))
    const twin = seen.find((other) => similarity(other.shingles, fingerprint) >= LANDING_DUPLICATE_THRESHOLD)
    if (twin) reasons.push(`duplicate_of:${twin.slug}`)
    else seen.push({ slug: landing.slug, shingles: fingerprint })
    verdicts.set(landing.slug, { slug: landing.slug, facet, key, indexable: reasons.length === 0, reasons, textChars })
  }
  return new Map([...verdicts].sort((a, b) => a[0].localeCompare(b[0])))
}
