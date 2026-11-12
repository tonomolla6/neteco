import { describe, expect, it } from 'vitest'
import { PRICE_ON_REQUEST, PRICE_REQUEST_ACTION, hasPublicPrice, priceRequestPath } from '../../shared/price-on-request'

describe('price on request', () => {
  it('treats zero, negative, missing and non-numeric prices as not public', () => {
    for (const value of [0, -1, null, undefined, Number.NaN, '1200', Infinity])
      expect(hasPublicPrice(value)).toBe(false)
    expect(hasPublicPrice(1)).toBe(true)
    expect(hasPublicPrice(1186)).toBe(true)
  })

  it('uses plain shop wording', () => {
    expect(PRICE_ON_REQUEST).toBe('Consultar precio')
    expect(PRICE_REQUEST_ACTION).toBe('Pedir precio')
  })

  it('links to the contact page with product, subject and message prefilled', () => {
    const path = priceRequestPath({ slug: 'bayeta-micro', name: 'Bayeta microfibra', sku: 'BM-40', format: 'Pack 10' })
    const url = new URL(path, 'https://shop.invalid')
    expect(url.pathname).toBe('/contacto')
    expect(url.searchParams.get('producto')).toBe('bayeta-micro')
    expect(url.searchParams.get('asunto')).toBe('Precio de Bayeta microfibra · Ref. BM-40')
    expect(url.searchParams.get('mensaje')).toBe(
      'Quiero saber el precio de Bayeta microfibra (Pack 10), referencia BM-40. Cantidad aproximada: '
    )
  })

  it('omits the reference and format when they are unknown and keeps the subject within the form limit', () => {
    const url = new URL(priceRequestPath({ slug: 'x', name: 'N'.repeat(400) }), 'https://shop.invalid')
    expect(url.searchParams.get('asunto')!.length).toBeLessThanOrEqual(200)
    expect(url.searchParams.get('mensaje')).not.toContain('referencia')
    const short = new URL(priceRequestPath({ slug: 'x', name: 'Lejía' }), 'https://shop.invalid')
    expect(short.searchParams.get('asunto')).toBe('Precio de Lejía')
    expect(short.searchParams.get('mensaje')).toBe('Quiero saber el precio de Lejía. Cantidad aproximada: ')
  })
})
