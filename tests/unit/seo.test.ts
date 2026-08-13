import { describe, expect, it } from 'vitest'
import { canonicalPath, isIndexableCatalogQuery } from '../../app/utils/seo'
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

  it('blocks every non-production response and only private admin routes in production', () => {
    expect(robotsHeader('test', '/catalogo')).toBe(NOINDEX_HEADER)
    expect(robotsHeader('staging', '/producto/guante')).toBe(NOINDEX_HEADER)
    expect(robotsHeader('production', '/admin/productos')).toBe(NOINDEX_HEADER)
    expect(robotsHeader('production', '/catalogo')).toBeNull()
  })
})
