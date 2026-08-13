import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  addressInputSchema,
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
    expect(postalCodeFormatIsValid('GB', ' SW1A 1AA ')).toBe(true)
    expect(postalCodeFormatIsValid('GB', '!SW1A 1AA')).toBe(false)
    expect(postalCodeFormatIsValid('GB', 'SW1A 1AA!')).toBe(false)
    expect(postalCodeFormatIsValid('GB', '!')).toBe(false)
  })

  it('accepts common phone presentation while rejecting ambiguous short numbers', () => {
    expect(phoneFormatIsValid('+34 600 861 334')).toBe(true)
    expect(phoneFormatIsValid('600861334')).toBe(true)
    expect(phoneFormatIsValid('x600861334')).toBe(false)
    expect(phoneFormatIsValid('600861334x')).toBe(false)
    expect(phoneFormatIsValid('   ')).toBe(true)
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

  it('trims every address field and accepts each documented address kind', () => {
    const result = validateAddress({
      kind: 'billing',
      label: ' Facturación ',
      recipientName: ' Ada Lovelace ',
      companyName: ' Analytical Engines ',
      taxId: ' B-12345678 ',
      line1: ' Calle Mayor 1 ',
      line2: ' Piso 2 ',
      postalCode: ' 46870 ',
      city: ' Ontinyent ',
      region: ' Valencia ',
      countryCode: ' es ',
      phone: ' +34 600 861 334 ',
      instructions: ' Llamar antes ',
      isDefault: true
    })
    expect(result).toEqual({
      kind: 'billing',
      label: 'Facturación',
      recipientName: 'Ada Lovelace',
      companyName: 'Analytical Engines',
      taxId: 'B12345678',
      line1: 'Calle Mayor 1',
      line2: 'Piso 2',
      postalCode: '46870',
      city: 'Ontinyent',
      region: 'Valencia',
      countryCode: 'ES',
      phone: '+34 600 861 334',
      instructions: 'Llamar antes',
      isDefault: true
    })
    expect(addressInputSchema.safeParse({ ...result, kind: 'shipping' }).success).toBe(true)
    expect(addressInputSchema.safeParse({ ...result, kind: 'both' }).success).toBe(true)
    expect(addressInputSchema.safeParse({ ...result, countryCode: 'XES' }).success).toBe(false)
    expect(addressInputSchema.safeParse({ ...result, countryCode: 'ESX' }).success).toBe(false)
  })

  it('preserves explicit validation messages for form feedback', () => {
    const base = {
      kind: 'both' as const,
      label: 'Sede',
      recipientName: 'Neteco Cliente',
      taxId: 'B12345678',
      line1: 'Calle Mayor 1',
      postalCode: '46870',
      city: 'Ontinyent',
      region: 'Valencia',
      countryCode: 'ES',
      phone: '+34600861334'
    }
    const messages = [
      [{ ...base, postalCode: 'bad' }, 'El código postal no tiene un formato válido para el país'],
      [{ ...base, taxId: 'bad' }, 'El identificador fiscal no tiene un formato válido para el país'],
      [{ ...base, phone: '123' }, 'El teléfono no tiene un formato válido']
    ] as const
    for (const [input, message] of messages) {
      try {
        validateAddress(input)
        throw new Error('Expected address validation to fail')
      } catch (error) {
        expect(error).toMatchObject({ issues: [expect.objectContaining({ message })] })
      }
    }
  })

  it('never accepts a Spanish postal code outside exactly five digits', () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        expect(postalCodeFormatIsValid('ES', candidate)).toBe(/^\d{5}$/.test(candidate.trim().toUpperCase()))
      })
    )
  })

  it('matches the documented fiscal, international postal and phone grammars', () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const taxId = normalizeTaxId(candidate)
        expect(taxIdFormatIsValid('ES', candidate)).toBe(
          taxId.length === 0 || /^(?:[XYZ]\d{7}[A-Z]|\d{8}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])$/.test(taxId)
        )
      })
    )
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const normalized = candidate.trim().toUpperCase()
        expect(postalCodeFormatIsValid('GB', candidate)).toBe(/^[A-Z0-9][A-Z0-9 -]{1,10}[A-Z0-9]$/i.test(normalized))
      })
    )
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const normalized = candidate.replace(/[\s().-]/g, '')
        expect(phoneFormatIsValid(candidate)).toBe(candidate.trim().length === 0 || /^\+?\d{7,15}$/.test(normalized))
      })
    )
  })
})
