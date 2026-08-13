import { describe, expect, it } from 'vitest'
import { displayIban, normalizeIban, validIban } from '../../server/domain/iban'

describe('IBAN validation', () => {
  it('normalizes and validates checksum-safe Spanish IBANs', () => {
    expect(normalizeIban('es91 2100 0418 4502 0005 1332')).toBe('ES9121000418450200051332')
    expect(displayIban('es9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332')
    expect(validIban('ES91 2100 0418 4502 0005 1332')).toBe(true)
  })

  it('rejects malformed values and invalid checksums', () => {
    expect(validIban('ES00 0000 0000 0000 0000 0000')).toBe(false)
    expect(validIban('not-an-iban')).toBe(false)
  })
})
