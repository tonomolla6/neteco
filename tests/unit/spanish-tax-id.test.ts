import { describe, expect, it } from 'vitest'
import { isValidSpanishTaxId, normalizeSpanishTaxId } from '../../server/domain/spanish-tax-id'

describe('Spanish tax identifiers', () => {
  it('normalizes casing, whitespace and separators', () => {
    expect(normalizeSpanishTaxId(' 12-345 678 z ')).toBe('12345678Z')
  })

  it.each(['12345678Z', 'X2482300W', 'A58818501', 'P2345678C', 'J99216582', 'J9921658B'])(
    'accepts a valid DNI, NIE or CIF: %s',
    (value) => expect(isValidSpanishTaxId(value)).toBe(true)
  )

  it.each(['', '12345678A', 'X2482300A', 'A58818502', 'P23456780', 'J9921658Z', 'NOT-A-TAX-ID'])(
    'rejects an invalid identifier: %s',
    (value) => expect(isValidSpanishTaxId(value)).toBe(false)
  )
})
