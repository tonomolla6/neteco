import { normalizeTaxId, taxIdFormatIsValid, validateAddress } from '../server/domain/customer'
import { isValidSpanishTaxId } from '../server/domain/spanish-tax-id'
import { z } from 'zod'

/** Local structural validation only: never a tax authority or VAT lookup. */
export function normalizeCustomerTaxId(value: string) {
  return normalizeTaxId(value)
}

export function customerTaxIdIsValid(countryCode: string, value: string, options: { required?: boolean } = {}) {
  const normalized = normalizeCustomerTaxId(value)
  if (!normalized) return options.required !== true
  return (
    taxIdFormatIsValid(countryCode, normalized) &&
    (countryCode.toUpperCase() !== 'ES' || isValidSpanishTaxId(normalized))
  )
}

/** Cloudflare-specific strengthening; the legacy Node address contract stays unchanged. */
export function validateCloudflareCustomerAddress(input: unknown) {
  // Check raw values: trim must not silently erase forbidden edge controls.
  // Instructions remain multiline; only the existing single-line fields change.
  const fields = [
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
  ] as const
  const normalized =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? ({ ...input } as Record<string, unknown>)
      : input
  if (normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const values = normalized as Record<string, unknown>
    for (const field of fields) {
      const value = values[field]
      if (typeof value !== 'string') continue
      if (
        [...value].some((character) => {
          const point = character.codePointAt(0)!
          return point <= 31 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029
        })
      ) {
        throw new z.ZodError([
          { code: 'custom', path: [field], message: 'El campo debe contener una sola línea sin caracteres de control' }
        ])
      }
      values[field] = value.normalize('NFC')
    }
  }
  const address = validateAddress(normalized)
  if (!customerTaxIdIsValid(address.countryCode, address.taxId)) {
    throw new z.ZodError([
      { code: 'custom', path: ['taxId'], message: 'El identificador fiscal no tiene un formato válido para el país' }
    ])
  }
  return address
}
