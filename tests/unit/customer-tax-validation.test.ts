import { describe, expect, it } from 'vitest'
import {
  normalizeCustomerTaxId,
  customerTaxIdIsValid,
  validateCloudflareCustomerAddress
} from '../../shared/customer-tax-validation'
import { taxIdFormatIsValid, validateAddress } from '../../server/domain/customer'

const address = {
  kind: 'billing',
  label: 'Fiscal',
  recipientName: 'Cliente sintético',
  line1: 'Calle Ejemplo 1',
  postalCode: '28001',
  city: 'Madrid',
  region: 'Madrid',
  countryCode: 'ES'
}
describe('Cloudflare customer fiscal validation by country and use', () => {
  it('normalizes single-line address fields to NFC without collapsing spaces or changing Node', () => {
    const input = {
      ...address,
      label: '  Direccio\u0301n  principal  ',
      recipientName: ' Jose\u0301  Pe\u0301rez ',
      companyName: ' Compan\u0303i\u0301a ',
      line1: ' Calle  Jose\u0301  1 ',
      line2: ' Atico\u0301 ',
      city: ' Vale\u0301ncia ',
      region: ' Castello\u0301n ',
      phone: ' +34 600 861 334 ',
      instructions: 'Primera planta\nLlamar antes'
    }
    const result = validateCloudflareCustomerAddress(input)
    for (const field of ['label', 'recipientName', 'companyName', 'line1', 'line2', 'city', 'region'] as const)
      expect(result[field]).toBe(input[field].trim().normalize('NFC'))
    expect(result.label).toBe('Dirección  principal')
    expect(result.phone).toBe('+34 600 861 334')
    expect(result.instructions).toBe(input.instructions)
    expect(validateAddress(input).recipientName).toBe(input.recipientName.trim())
  })
  it('rejects controls in every single-line field before trimming, including their edges', () => {
    const base = { ...address, companyName: 'Empresa', taxId: 'A58818501', line2: 'Planta 1', phone: '+34600111222' }
    for (const field of [
      'label',
      'recipientName',
      'companyName',
      'taxId',
      'line1',
      'line2',
      'postalCode',
      'city',
      'region',
      'countryCode',
      'phone'
    ] as const)
      for (const control of ['\u0000', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029'])
        for (const value of [
          control + base[field],
          base[field] + control,
          base[field].slice(0, 1) + control + base[field].slice(1)
        ])
          expect(
            () => validateCloudflareCustomerAddress({ ...base, [field]: value }),
            `${field} ${JSON.stringify(value)}`
          ).toThrow()
  })
  it('normalizes existing whitespace, hyphen and dot separators without changing legacy helpers', () => {
    expect(normalizeCustomerTaxId(' a.588 185-01 ')).toBe('A58818501')
    expect(taxIdFormatIsValid('ES', 'A58818502')).toBe(true)
    expect(validateAddress({ ...address, taxId: 'A58818502' }).taxId).toBe('A58818502')
  })
  it.each(['12345678Z', 'X2482300W', 'A58818501', 'P2345678C', 'J99216582', 'J9921658B'])(
    'accepts existing checksum-valid Spanish identifier %s',
    (value) => {
      expect(customerTaxIdIsValid('ES', value, { required: true })).toBe(true)
    }
  )
  it.each(['12345678A', 'X2482300A', 'A58818502', 'P23456780'])(
    'rejects structurally plausible but checksum-invalid Spanish identifier %s',
    (value) => {
      expect(customerTaxIdIsValid('ES', value)).toBe(false)
    }
  )
  it.each(['', ' --- ', '...'])('requires an actual normalized fiscal identifier for professional use: %j', (value) => {
    expect(customerTaxIdIsValid('ES', value, { required: true })).toBe(false)
    expect(customerTaxIdIsValid('ES', value)).toBe(true)
  })
  it('preserves the existing non-Spanish structural fallback without claiming tax verification', () => {
    expect(customerTaxIdIsValid('FR', 'FR-123456789', { required: true })).toBe(true)
    expect(customerTaxIdIsValid('PT', '!BAD', { required: true })).toBe(false)
    expect(customerTaxIdIsValid('AD', '---', { required: true })).toBe(false)
  })
  it('normalizes a valid fiscal address and leaves an optional identifier absent', () => {
    expect(validateCloudflareCustomerAddress({ ...address, taxId: ' a.588185-01 ' })).toMatchObject({
      taxId: 'A58818501',
      countryCode: 'ES'
    })
    expect(validateCloudflareCustomerAddress(address).taxId).toBe('')
  })
  it('identifies the taxId field rather than accepting an invalid checksum address', () => {
    expect(() => validateCloudflareCustomerAddress({ ...address, taxId: 'A58818502' })).toThrowError(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ['taxId'] })] })
    )
  })
})
