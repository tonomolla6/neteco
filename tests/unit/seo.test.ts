import { describe, expect, it } from 'vitest'
import {
  buildBreadcrumbJsonLd,
  buildFaqPageJsonLd,
  buildItemListJsonLd,
  buildWebsiteJsonLd,
  canonicalPath,
  defaultRouteSeo,
  errorPageSeo,
  formatSeoTitle,
  isIndexableCatalogQuery,
  isPrivateSeoPath,
  stripDuplicateBrand,
  truncateSeoDescription
} from '../../app/utils/seo'
import { NOINDEX_HEADER, robotsHeader } from '../../server/utils/robots'

describe('SEO policy', () => {
  it('keeps only meaningful catalog pagination in canonical URLs', () => {
    expect(canonicalPath('/catalogo', { page: '2', sort: 'price_asc' })).toBe('/catalogo?page=2')
    expect(canonicalPath('/categoria/guantes/', { page: '3' })).toBe('/categoria/guantes?page=3')
    expect(canonicalPath('/producto/guante', { sku: 'SKU-1' })).toBe('/producto/guante')
    expect(canonicalPath('/catalogo', { page: 'invalid' })).toBe('/catalogo')
  })

  it('indexes plain and paginated listings but excludes facets and malformed pages', () => {
    expect(isIndexableCatalogQuery({})).toBe(true)
    expect(isIndexableCatalogQuery({ page: '2' })).toBe(true)
    expect(isIndexableCatalogQuery({ page: '0' })).toBe(false)
    expect(isIndexableCatalogQuery({ page: '2', brand: 'NETECO' })).toBe(false)
  })

  it('blocks every non-production response and all private routes in production', () => {
    expect(robotsHeader('test', '/catalogo')).toBe(NOINDEX_HEADER)
    expect(robotsHeader('staging', '/producto/guante')).toBe(NOINDEX_HEADER)
    for (const privatePath of [
      '/admin',
      '/admin/productos',
      '/admin/campanas-estacionales',
      '/cuenta',
      '/cuenta/pedidos',
      '/cuenta/referidos',
      '/carrito',
      '/carrito/compartido',
      '/checkout',
      '/pedido/ord-123',
      '/pedido-rapido',
      '/pago/exito',
      '/pago/error',
      '/login',
      '/registro',
      '/recuperar-clave',
      '/restablecer-clave',
      '/verificar-email',
      '/buscar',
      '/newsletter/baja',
      '/newsletter/confirmar',
      '/reparto',
      '/encuesta/ord-123',
      '/comparar'
    ]) {
      expect(robotsHeader('production', privatePath)).toBe(NOINDEX_HEADER)
      expect(isPrivateSeoPath(privatePath)).toBe(true)
    }
    for (const publicPath of [
      '/',
      '/catalogo',
      '/categoria/guantes',
      '/producto/guante',
      '/ayuda',
      '/eventos',
      '/kits'
    ]) {
      expect(robotsHeader('production', publicPath)).toBeNull()
      expect(isPrivateSeoPath(publicPath)).toBe(false)
    }
  })

  it('strips duplicate brand suffixes and keeps formatted titles within 60 chars including brand suffix', () => {
    expect(stripDuplicateBrand('Centro de Marca y Certificaciones Oficiales · Neteco')).toBe(
      'Centro de Marca y Certificaciones Oficiales'
    )
    expect(stripDuplicateBrand('Comparador de productos | NETECO')).toBe('Comparador de productos')
    const shortTitle = formatSeoTitle('Catálogo profesional')
    expect(`${shortTitle} · NETECO`.length).toBeLessThanOrEqual(60)
    const longTitle = formatSeoTitle(
      'Centro de Marca, Certificaciones Oficiales y Documentación Técnica de Higiene Profesional · Neteco'
    )
    expect(longTitle).not.toMatch(/neteco/i)
    expect(`${longTitle} · NETECO`.length).toBeLessThanOrEqual(60)
  })

  it('truncates meta descriptions cleanly to at most 155 characters', () => {
    const longDesc =
      'Tienda online de NETECO: celulosa industrial, químicos de limpieza, bolsas de basura, guantes y EPIs. Más de 30 años suministrando a hostelería e industria.'
    const trimmed = truncateSeoDescription(longDesc)
    expect(trimmed.length).toBeGreaterThan(50)
    expect(trimmed.length).toBeLessThanOrEqual(155)
    expect(trimmed).toMatch(/^Tienda online de NETECO/)
  })

  it('provides unique titles and descriptions <=155 chars for routes and marks private routes noindex', () => {
    const routes = [
      '/',
      '/catalogo',
      '/eventos',
      '/kits',
      '/carrito',
      '/carrito/compartido',
      '/checkout',
      '/login',
      '/registro',
      '/recuperar-clave',
      '/restablecer-clave',
      '/verificar-email',
      '/cuenta',
      '/cuenta/pedidos',
      '/cuenta/referidos',
      '/admin',
      '/admin/campanas-estacionales'
    ]
    const titles = new Set<string>()
    const descriptions = new Set<string>()
    for (const path of routes) {
      const meta = defaultRouteSeo(path)
      expect(meta.title.length).toBeGreaterThan(0)
      expect(`${meta.title} · NETECO`.length).toBeLessThanOrEqual(60)
      expect(meta.description.length).toBeGreaterThan(20)
      expect(meta.description.length).toBeLessThanOrEqual(155)
      titles.add(meta.title)
      descriptions.add(meta.description)
      if (isPrivateSeoPath(path)) {
        expect(meta.robots).toContain('noindex')
      } else {
        expect(meta.robots).toBe('index, follow')
      }
    }
    expect(titles.size).toBe(routes.length)
    expect(descriptions.size).toBe(routes.length)
  })

  it('builds status-aware noindex SEO metadata for error pages (404, 410, 500)', () => {
    const notFound = errorPageSeo(404)
    expect(notFound.robots).toBe('noindex, nofollow')
    expect(notFound.title).toContain('no encontrada')
    expect(notFound.description.length).toBeLessThanOrEqual(155)

    const gone = errorPageSeo(410)
    expect(gone.robots).toBe('noindex, nofollow')
    expect(gone.title).toContain('retirado')

    const serverError = errorPageSeo(500)
    expect(serverError.robots).toBe('noindex, nofollow')
    expect(serverError.title.length).toBeGreaterThan(0)
  })

  it('builds valid JSON-LD schemas for WebSite SearchAction, BreadcrumbList, ItemList, and FAQPage', () => {
    const website = buildWebsiteJsonLd('https://neteco.es')
    expect(website['@type']).toBe('WebSite')
    expect(website.potentialAction['@type']).toBe('SearchAction')
    expect(website.potentialAction.target.urlTemplate).toBe('https://neteco.es/buscar?q={search_term_string}')

    const breadcrumbs = buildBreadcrumbJsonLd('https://neteco.es', [
      { name: 'Inicio', path: '/' },
      { name: 'Catálogo', path: '/catalogo' }
    ])
    expect(breadcrumbs['@type']).toBe('BreadcrumbList')
    expect(breadcrumbs.itemListElement).toHaveLength(2)
    expect(breadcrumbs.itemListElement[1]).toEqual({
      '@type': 'ListItem',
      position: 2,
      name: 'Catálogo',
      item: 'https://neteco.es/catalogo'
    })

    const itemList = buildItemListJsonLd('https://neteco.es', 'Catálogo NETECO', [
      { name: 'Guante nitrilo', slug: 'guante-nitrilo' }
    ])
    expect(itemList['@type']).toBe('ItemList')
    expect(itemList.numberOfItems).toBe(1)
    expect(itemList.itemListElement[0]?.url).toBe('https://neteco.es/producto/guante-nitrilo')

    const faq = buildFaqPageJsonLd([{ question: '¿Cuál es el pedido mínimo?', answer: 'No hay importe mínimo.' }])
    expect(faq['@type']).toBe('FAQPage')
    expect(faq.mainEntity[0]?.name).toBe('¿Cuál es el pedido mínimo?')
    expect(faq.mainEntity[0]?.acceptedAnswer.text).toBe('No hay importe mínimo.')
  })
})
