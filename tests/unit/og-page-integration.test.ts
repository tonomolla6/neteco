import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const page = (path: string) => readFileSync(fileURLToPath(new URL(`../../app/pages/${path}`, import.meta.url)), 'utf8')

// Contrato de las páginas con la tarjeta dinámica: cada una declara og:image/twitter:image, tamaño y alt a partir de
// `dynamicOgMeta` (que ya cubre fallback y runtime sin ruta dinámica en og-route.test.ts).
describe.each([
  ['producto/[slug].vue', 'producto'],
  ['categoria/[slug].vue', 'categoria'],
  ['plantillas/[slug].vue', 'plantilla'],
  ['contenido/[slug].vue', 'contenido']
])('%s', (file, kind) => {
  const source = page(file)

  it(`builds the ${kind} card route with dynamicOgMeta`, () => {
    expect(source).toMatch(/import \{ dynamicOgMeta \} from '~\/utils\/og-image'/)
    expect(source).toMatch(new RegExp(`dynamicOgMeta\\(\\{[^}]*kind: '${kind}'`, 's'))
    expect(source).toMatch(/dynamic: runtime/)
  })

  it('publishes image, size, type, alt and the twitter equivalents in useSeoMeta', () => {
    const meta = source.slice(source.indexOf('useSeoMeta({'))
    for (const key of [
      'ogImage',
      'ogImageWidth',
      'ogImageHeight',
      'ogImageType',
      'ogImageAlt',
      'twitterImage',
      'twitterImageAlt'
    ])
      expect(meta, key).toContain(`${key}: () =>`)
  })
})

describe('product page fallback', () => {
  it('keeps the real product image as fallback and never as the only source', () => {
    const source = page('producto/[slug].vue')
    expect(source).toContain('fallbackImage: product.value.image')
    expect(source).not.toMatch(/ogImage: \(\) =>\s*product\.value\.image/)
  })
})
