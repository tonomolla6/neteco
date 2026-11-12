import { describe, expect, it } from 'vitest'
import { productDeliveryRequestSchema, provinceForPostalCode } from '../../shared/delivery-estimate'

describe('"¿Cuándo me llega?" with the postal code alone', () => {
  it('knows the Spanish province of every valid postal code prefix', () => {
    expect(provinceForPostalCode('46870')).toBe('Valencia')
    expect(provinceForPostalCode('28001')).toBe('Madrid')
    expect(provinceForPostalCode('08001')).toBe('Barcelona')
    expect(provinceForPostalCode('35001')).toBe('Las Palmas')
    expect(provinceForPostalCode('52001')).toBe('Melilla')
    expect(provinceForPostalCode('00001')).toBeNull()
    expect(provinceForPostalCode('53001')).toBeNull()
    expect(provinceForPostalCode('4687')).toBeNull()
  })

  it('accepts a request without town and fills it from the postal code', () => {
    const parsed = productDeliveryRequestSchema.parse({
      variantId: '00000000-0000-4000-8000-000000000001',
      quantity: 2,
      postalCode: ' 46870 '
    })
    expect(parsed).toEqual({
      variantId: '00000000-0000-4000-8000-000000000001',
      quantity: 2,
      postalCode: '46870',
      city: 'Valencia',
      region: 'Valencia'
    })
  })

  it('keeps a town when the customer gives one', () => {
    const parsed = productDeliveryRequestSchema.parse({
      variantId: '00000000-0000-4000-8000-000000000001',
      quantity: 1,
      postalCode: '46870',
      city: 'Ontinyent'
    })
    expect(parsed).toMatchObject({ city: 'Ontinyent', region: 'Valencia' })
  })

  it('refuses a postal code that belongs to no province', () => {
    expect(
      productDeliveryRequestSchema.safeParse({
        variantId: '00000000-0000-4000-8000-000000000001',
        quantity: 1,
        postalCode: '99999'
      }).success
    ).toBe(false)
  })
})
