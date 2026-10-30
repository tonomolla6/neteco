import { describe, expect, it } from 'vitest'
import {
  LANDING_MIN_LIVE_PRODUCTS,
  LANDING_MIN_TEXT_CHARS,
  evaluateLandingSet,
  parseLandingFacet,
  type LandingCandidate
} from '../../shared/landing-quality'

let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const p = (text: string) => ({ id: id(), type: 'paragraph' as const, text })
const h = (text: string) => ({ id: id(), type: 'heading' as const, level: 'h2' as const, text })
const body = (seed: string, chars = LANDING_MIN_TEXT_CHARS + 200) => {
  let text = ''
  let i = 0
  while (text.length < chars) text += `${seed} detalle${i++} específico del servicio. `
  return text
}
const landing = (over: Partial<LandingCandidate> & { slug: string }): LandingCandidate => ({
  kind: 'landing',
  publishedAt: '2026-10-01T00:00:00Z',
  categorySlug: 'sector-hosteleria',
  liveProductCount: LANDING_MIN_LIVE_PRODUCTS,
  blocks: [h('Casos de clientes del sector'), p(body(over.slug))],
  ...over
})
const verdict = (items: LandingCandidate[], slug: string) => evaluateLandingSet(items).get(slug)!

describe('SEO-028 landing value gate', () => {
  it('parses sector / need / locality facets from the editorial category slug only', () => {
    expect(parseLandingFacet('sector-hosteleria')).toEqual({ facet: 'sector', key: 'hosteleria' })
    expect(parseLandingFacet('necesidad-desengrasar')).toEqual({ facet: 'need', key: 'desengrasar' })
    expect(parseLandingFacet('localidad-valencia')).toEqual({ facet: 'locality', key: 'valencia' })
    expect(parseLandingFacet('limpieza-profesional')).toEqual({ facet: 'general', key: 'limpieza-profesional' })
    expect(parseLandingFacet('sector-')).toEqual({ facet: 'general', key: 'sector-' })
  })
  it('indexes a sector landing with live offer, substantive text and specific cases', () => {
    const v = verdict([landing({ slug: 'hosteleria' })], 'hosteleria')
    expect(v).toMatchObject({ facet: 'sector', indexable: true, reasons: [] })
  })
  it('noindexes thin text', () => {
    const v = verdict([landing({ slug: 'a', blocks: [h('Casos de clientes'), p('Texto corto.')] })], 'a')
    expect(v.indexable).toBe(false)
    expect(v.reasons).toContain('thin_content')
  })
  it('noindexes landings without enough live offer (no products or draft ones filtered out upstream)', () => {
    const v = verdict([landing({ slug: 'a', liveProductCount: LANDING_MIN_LIVE_PRODUCTS - 1 })], 'a')
    expect(v.indexable).toBe(false)
    expect(v.reasons).toContain('offer_missing')
  })
  it('requires cases for sector, advice for need and concrete coverage for locality', () => {
    const noCases = verdict([landing({ slug: 's', blocks: [h('Presentación'), p(body('s'))] })], 's')
    expect(noCases.reasons).toContain('cases_missing')
    const need = landing({ slug: 'n', categorySlug: 'necesidad-desengrasar', blocks: [h('Productos'), p(body('n'))] })
    expect(verdict([need], 'n').reasons).toContain('advice_missing')
    const needOk = { ...need, blocks: [h('Consejos de uso y dosificación'), p(body('n'))] }
    expect(verdict([needOk], 'n').indexable).toBe(true)
    const loc = landing({
      slug: 'l',
      categorySlug: 'localidad-valencia',
      blocks: [h('Cobertura y entrega en Valencia'), p(body('l'))]
    })
    expect(verdict([loc], 'l').reasons).toContain('coverage_unspecific')
    const locOk = {
      ...loc,
      blocks: [
        h('Cobertura y entrega en Valencia'),
        p('Entrega en 24 horas en los códigos postales 46001 a 46025.'),
        p(body('l'))
      ]
    }
    expect(verdict([locOk], 'l').indexable).toBe(true)
  })
  it('marks near-duplicate landings as doorway pages: the earliest keeps its index status', () => {
    const a = landing({
      slug: 'a',
      publishedAt: '2026-10-01T00:00:00Z',
      blocks: [h('Casos de clientes'), p(body('igual'))]
    })
    const b = landing({
      slug: 'b',
      publishedAt: '2026-10-02T00:00:00Z',
      blocks: [h('Casos de clientes'), p(body('igual'))]
    })
    const out = evaluateLandingSet([b, a])
    expect(out.get('a')!.indexable).toBe(true)
    expect(out.get('b')).toMatchObject({ indexable: false })
    expect(out.get('b')!.reasons).toContain('duplicate_of:a')
  })
  it('keeps clearly different landings indexable and ignores non-landing kinds', () => {
    const a = landing({ slug: 'a' })
    const b = landing({ slug: 'b', categorySlug: 'sector-sanidad' })
    const article = landing({ slug: 'art', kind: 'article', liveProductCount: 0, blocks: [p('corto')] })
    const out = evaluateLandingSet([a, b, article])
    expect(out.get('a')!.indexable && out.get('b')!.indexable).toBe(true)
    expect(out.has('art')).toBe(false)
  })
  it('is deterministic regardless of input order', () => {
    const items = [landing({ slug: 'a' }), landing({ slug: 'b', categorySlug: 'sector-sanidad' })]
    expect([...evaluateLandingSet(items)]).toEqual(
      [...evaluateLandingSet([...items].reverse())].sort((x, y) => x[0].localeCompare(y[0]))
    )
  })
})
