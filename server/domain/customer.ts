import { z } from 'zod'

const COUNTRY_CODE = /^[A-Z]{2}$/
const GENERAL_POSTAL_CODE = /^[A-Z0-9][A-Z0-9 -]{1,10}[A-Z0-9]$/i
const ES_TAX_ID = /^(?:[XYZ]\d{7}[A-Z]|\d{8}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])$/

export const addressInputSchema = z.object({
  kind: z.enum(['shipping', 'billing', 'both']),
  label: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(2).max(160),
  companyName: z.string().trim().max(160).optional().default(''),
  taxId: z.string().trim().max(32).optional().default(''),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional().default(''),
  postalCode: z.string().trim().min(2).max(16),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().min(2).max(120),
  countryCode: z.string().trim().toUpperCase().regex(COUNTRY_CODE),
  phone: z.string().trim().max(32).optional().default(''),
  instructions: z.string().trim().max(500).optional().default(''),
  isDefault: z.boolean().default(false)
})

export type AddressInput = z.infer<typeof addressInputSchema>

export function normalizeTaxId(value: string) {
  return value.replace(/[\s.-]/g, '').toUpperCase()
}

export function taxIdFormatIsValid(countryCode: string, value: string) {
  const normalized = normalizeTaxId(value)
  if (!normalized) return true
  if (countryCode.toUpperCase() === 'ES') return ES_TAX_ID.test(normalized)
  return /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(normalized)
}

export function postalCodeFormatIsValid(countryCode: string, value: string) {
  const normalized = value.trim().toUpperCase()
  if (countryCode.toUpperCase() === 'ES') return /^\d{5}$/.test(normalized)
  return GENERAL_POSTAL_CODE.test(normalized)
}

export function phoneFormatIsValid(value: string) {
  if (!value.trim()) return true
  const normalized = value.replace(/[\s().-]/g, '')
  return /^\+?\d{7,15}$/.test(normalized)
}

export function validateAddress(input: unknown) {
  const address = addressInputSchema.parse(input)
  if (!postalCodeFormatIsValid(address.countryCode, address.postalCode)) {
    throw new z.ZodError([
      { code: 'custom', path: ['postalCode'], message: 'El código postal no tiene un formato válido para el país' }
    ])
  }
  if (!taxIdFormatIsValid(address.countryCode, address.taxId)) {
    throw new z.ZodError([
      { code: 'custom', path: ['taxId'], message: 'El identificador fiscal no tiene un formato válido para el país' }
    ])
  }
  if (!phoneFormatIsValid(address.phone)) {
    throw new z.ZodError([{ code: 'custom', path: ['phone'], message: 'El teléfono no tiene un formato válido' }])
  }
  return { ...address, taxId: normalizeTaxId(address.taxId), countryCode: address.countryCode.toUpperCase() }
}
