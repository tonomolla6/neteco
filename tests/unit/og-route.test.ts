import { describe, expect, it } from 'vitest'
import { OG_HEIGHT, OG_WIDTH, ogImagePath, ogStaticFallback, ogVersion, parseOgImagePath } from '../../shared/og-image'
import { dynamicOgMeta } from '../../app/utils/og-image'

describe('dynamic Open Graph routes', () => {
  it('builds and parses the public PNG routes for every supported kind', () => {
    expect(ogImagePath('producto', 'guante-nitrilo')).toBe('/og/producto/guante-nitrilo.png')
    expect(ogImagePath('categoria', 'productos-quimicos', 'abc123')).toBe(
      '/og/categoria/productos-quimicos.png?v=abc123'
    )
    expect(parseOgImagePath('/og/plantilla/checklist-appcc.png')).toEqual({
      kind: 'plantilla',
      slug: 'checklist-appcc'
    })
    expect(parseOgImagePath('/og/contenido/guia-limpieza.png')).toEqual({ kind: 'contenido', slug: 'guia-limpieza' })
  })

  it.each([
    '/og/producto/Mayus.png',
    '/og/producto/a_b.png',
    '/og/producto/.png',
    '/og/producto/a/b.png',
    '/og/producto/a%2Fb.png',
    '/og/producto/..%2Fadmin.png',
    '/og/producto/ok.jpg',
    '/og/producto/ok.png/',
    '/og/desconocido/ok.png',
    '/og/og-producto.jpg',
    `/og/producto/${'a'.repeat(181)}.png`
  ])('does not own %s', (path) => {
    expect(parseOgImagePath(path)).toBeNull()
  })

  it('derives a stable short version that changes with any rendered field', () => {
    const base = ogVersion('Guante', 'NETECO', 3, 1250, null)
    expect(base).toMatch(/^[a-z0-9]{1,12}$/)
    expect(ogVersion('Guante', 'NETECO', 3, 1250, null)).toBe(base)
    expect(ogVersion('Guante', 'NETECO', 3, 1300, null)).not.toBe(base)
    expect(ogVersion('Guante', 'NETECO', 4, 1250, null)).not.toBe(base)
  })

  it('maps each kind to the equivalent static card', () => {
    expect(ogStaticFallback('producto', 'x')).toBe('/og/og-producto.jpg')
    expect(ogStaticFallback('categoria', 'productos-quimicos')).toBe('/og/og-categoria-productos-quimicos.jpg')
    expect(ogStaticFallback('categoria', 'menaje-hosteleria')).toBe('/og/og-categoria-menaje-hosteleria.jpg')
    expect(ogStaticFallback('categoria', 'otra')).toBe('/og-default.jpg')
    expect(ogStaticFallback('plantilla', 'x')).toBe('/og/og-plantillas.jpg')
    expect(ogStaticFallback('contenido', 'x')).toBe('/og-default.jpg')
  })

  it('keeps the card at 1200x630', () => {
    expect([OG_WIDTH, OG_HEIGHT]).toEqual([1200, 630])
  })
})

describe('dynamicOgMeta (page integration)', () => {
  const origin = 'https://neteco.example'
  it('points og:image and twitter:image at the dynamic card with dimensions and alt text', () => {
    const meta = dynamicOgMeta({
      origin,
      kind: 'producto',
      slug: 'guante-nitrilo',
      version: ogVersion('Guante nitrilo'),
      alt: 'Guante nitrilo · NETECO',
      fallbackImage: '/media/abc/image?w=800&format=jpeg'
    })
    expect(meta.ogImage).toMatch(/^https:\/\/neteco\.example\/og\/producto\/guante-nitrilo\.png\?v=[a-z0-9]+$/)
    expect(meta.twitterImage).toBe(meta.ogImage)
    expect(meta.ogImageWidth).toBe(1200)
    expect(meta.ogImageHeight).toBe(630)
    expect(meta.ogImageType).toBe('image/png')
    expect(meta.ogImageAlt).toBe('Guante nitrilo · NETECO')
    expect(meta.twitterImageAlt).toBe('Guante nitrilo · NETECO')
  })

  it('keeps the real product image when the runtime has no dynamic card route (Node/dev)', () => {
    const meta = dynamicOgMeta({
      origin,
      kind: 'producto',
      slug: 'guante-nitrilo',
      alt: 'x',
      dynamic: false,
      fallbackImage: '/media/abc/image?w=800&format=jpeg'
    })
    expect(meta).toEqual({
      ogImage: 'https://neteco.example/media/abc/image?w=800&format=jpeg',
      twitterImage: 'https://neteco.example/media/abc/image?w=800&format=jpeg'
    })
  })

  it('uses the real product image, or the static card, only when no dynamic route can be built', () => {
    const withImage = dynamicOgMeta({
      origin,
      kind: 'producto',
      slug: 'Slug Invalido',
      alt: 'x',
      fallbackImage: '/media/abc/image?w=800&format=jpeg'
    })
    expect(withImage.ogImage).toBe('https://neteco.example/media/abc/image?w=800&format=jpeg')
    expect(withImage.ogImageWidth).toBeUndefined()
    const withoutImage = dynamicOgMeta({ origin, kind: 'categoria', slug: 'Raro Slug', alt: 'x' })
    expect(withoutImage.ogImage).toBe('https://neteco.example/og-default.jpg')
  })
})
