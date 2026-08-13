import { describe, expect, it } from 'vitest'
import { COMPANY_STATUSES, companyStatusCanTransition, redactTaxId } from '../../server/domain/company'

describe('professional company lifecycle', () => {
  it('defines every allowed transition explicitly', () => {
    const allowed = COMPANY_STATUSES.flatMap((from) =>
      COMPANY_STATUSES.filter((to) => companyStatusCanTransition(from, to)).map((to) => `${from}:${to}`)
    )
    expect(allowed).toEqual([
      'pending:pending',
      'pending:approved',
      'pending:rejected',
      'approved:approved',
      'approved:suspended',
      'rejected:pending',
      'rejected:rejected',
      'suspended:pending',
      'suspended:approved',
      'suspended:suspended'
    ])
  })

  it('redacts identifiers in audit evidence', () => {
    expect(redactTaxId(null)).toBeNull()
    expect(redactTaxId('123')).toBe('***')
    expect(redactTaxId('1234')).toBe('****')
    expect(redactTaxId('B12345678')).toBe('*****5678')
  })
})
