import { describe, expect, it } from 'vitest'
import { ogImageForPath } from '../../app/utils/og-image'

describe('ogImageForPath', () => {
  it('returns the dedicated share card for known public pages', () => {
    expect(ogImageForPath('/')).toBe('/og/og-home.jpg')
    expect(ogImageForPath('/catalogo')).toBe('/og/og-catalogo.jpg')
    expect(ogImageForPath('/envios/')).toBe('/og/og-envios.jpg')
    expect(ogImageForPath('/categoria/productos-quimicos')).toBe('/og/og-categoria-productos-quimicos.jpg')
  })

  it('uses the generic product card for product pages', () => {
    expect(ogImageForPath('/producto/guante-de-nitrilo')).toBe('/og/og-producto.jpg')
  })

  it('falls back to the default card, including pages whose claims are not yet verified', () => {
    expect(ogImageForPath('/categoria/otra')).toBe('/og-default.jpg')
    expect(ogImageForPath('/cuenta/pedidos')).toBe('/og-default.jpg')
    expect(ogImageForPath('/certificaciones')).toBe('/og-default.jpg')
    expect(ogImageForPath('/marca')).toBe('/og-default.jpg')
  })
})
