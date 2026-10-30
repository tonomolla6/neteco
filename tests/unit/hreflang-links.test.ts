import { describe, expect, it } from 'vitest'
import { productAlternateLinks, productSlugFromPath } from '../../app/utils/hreflang-links'

const ORIGIN = 'https://neteco.example'
const SELF = `${ORIGIN}/producto/limpiador`
const FALLBACK = [
  { hreflang: 'es-ES', href: SELF },
  { hreflang: 'x-default', href: SELF }
]
const good = {
  canonical: SELF,
  links: [
    { hreflang: 'es-ES', href: SELF },
    { hreflang: 'fr-FR', href: `${ORIGIN}/fr-fr/producto/nettoyant` },
    { hreflang: 'x-default', href: SELF }
  ]
}

describe('SEO-033 product alternate links', () => {
  it.each([
    ['/producto/limpiador', 'limpiador'],
    ['/producto/limpiador/', 'limpiador'],
    ['/producto/a-b-2', 'a-b-2'],
    ['/producto/', null],
    ['/producto/Mayus', null],
    ['/producto/a/b', null],
    ['/catalogo', null]
  ])('reads the product slug from %s', (path, slug) => expect(productSlugFromPath(path)).toBe(slug))

  it('uses the reciprocal server set when it is safe', () => {
    expect(productAlternateLinks(ORIGIN, SELF, good)).toEqual(good.links)
  })

  it.each([
    ['no response', null],
    ['too few links', { canonical: SELF, links: [good.links[0]!] }],
    [
      'a foreign origin',
      { canonical: SELF, links: [...good.links.slice(0, 2), { hreflang: 'x-default', href: 'https://evil.example/x' }] }
    ],
    ['an invalid hreflang', { canonical: SELF, links: [...good.links, { hreflang: 'fr_FR', href: `${ORIGIN}/x` }] }],
    [
      'a repeated hreflang',
      { canonical: SELF, links: [...good.links, { hreflang: 'fr-FR', href: `${ORIGIN}/fr-fr/producto/otro` }] }
    ],
    ['a missing x-default', { canonical: SELF, links: good.links.slice(0, 2) }],
    [
      'a set that does not include this page',
      {
        canonical: SELF,
        links: good.links.map((l) => (l.href === SELF ? { ...l, href: `${ORIGIN}/producto/otro` } : l))
      }
    ]
  ])('falls back to the single-market pair for %s', (_name, response) => {
    expect(productAlternateLinks(ORIGIN, SELF, response as never)).toEqual(FALLBACK)
  })
})
