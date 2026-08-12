import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  normalizeTaxId,
  phoneFormatIsValid,
  postalCodeFormatIsValid,
  taxIdFormatIsValid,
  validateAddress
} from '../../server/domain/customer'

describe('customer data validation', () => {
  it('normalizes fiscal identifiers without changing their meaning', () => {
    expect(normalizeTaxId(' b-12345678 ')).toBe('B12345678')
    expect(taxIdFormatIsValid('ES', 'B-12345678')).toBe(true)
    expect(taxIdFormatIsValid('ES', 'not-a-tax-id')).toBe(false)
    expect(taxIdFormatIsValid('FR', '')).toBe(true)
    expect(taxIdFormatIsValid('FR', 'FR-123456789')).toBe(true)
    expect(taxIdFormatIsValid('FR', '!BAD')).toBe(false)
  })

  it('uses a clear country-specific postal rule and a conservative international fallback', () => {
    expect(postalCodeFormatIsValid('ES', '46870')).toBe(true)
    expect(postalCodeFormatIsValid('ES', '1234')).toBe(false)
    expect(postalCodeFormatIsValid('GB', 'SW1A 1AA')).toBe(true)
    expect(postalCodeFormatIsValid('GB', '!')).toBe(false)
  })

  it('accepts common phone presentation while rejecting ambiguous short numbers', () => {
    expect(phoneFormatIsValid('+34 600 861 334')).toBe(true)
    expect(phoneFormatIsValid('123')).toBe(false)
    expect(phoneFormatIsValid('')).toBe(true)
  })

  it('applies optional address defaults', () => {
    expect(
      validateAddress({
        kind: 'shipping',
        label: 'Casa',
        recipientName: 'Ada Lovelace',
        line1: 'Calle Mayor 1',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES'
      })
    ).toMatchObject({ companyName: '', taxId: '', line2: '', phone: '', instructions: '', isDefault: false })
  })

  it.each([
    ['postalCode', { postalCode: 'bad' }],
    ['taxId', { taxId: 'bad' }],
    ['phone', { phone: '123' }]
  ])('reports an invalid %s explicitly', (field, override) => {
    expect(() =>
      validateAddress({
        kind: 'both',
        label: 'Sede',
        recipientName: 'Neteco Cliente',
        taxId: 'B12345678',
        line1: 'Calle Mayor 1',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES',
        phone: '+34600861334',
        ...override
      })
    ).toThrow(field)
  })

  it('validates and normalizes a complete address', () => {
    expect(
      validateAddress({
        kind: 'both',
        label: 'Sede',
        recipientName: 'Neteco Cliente',
        companyName: 'NETECO',
        taxId: 'B-12345678',
        line1: 'Calle Mayor 1',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'es',
        phone: '+34 600 861 334',
        isDefault: true
      })
    ).toMatchObject({ taxId: 'B12345678', countryCode: 'ES' })
  })

  it('never accepts a Spanish postal code outside exactly five digits', () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        expect(postalCodeFormatIsValid('ES', candidate)).toBe(/^\d{5}$/.test(candidate.trim().toUpperCase()))
      })
    )
  })
})
