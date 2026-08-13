import { describe, expect, it } from 'vitest'
import { normalizeSearchTerm, uniqueSearchTerms } from '../../server/utils/search-terms'

describe('search term governance', () => {
  it('normalizes whitespace, case and duplicate synonym terms', () => {
    expect(normalizeSearchTerm('  Papel   higiénico ')).toBe('Papel higiénico')
    expect(uniqueSearchTerms('Lejía', [['hipoclorito', 'LEJÍA'], ['cloro']])).toEqual(['lejía', 'hipoclorito', 'cloro'])
  })

  it('drops unusable terms and caps expansion', () => {
    expect(uniqueSearchTerms('x', [['a', 'válido']])).toEqual(['válido'])
    expect(uniqueSearchTerms('base', [Array.from({ length: 30 }, (_, index) => `term-${index}`)])).toHaveLength(20)
  })
})
