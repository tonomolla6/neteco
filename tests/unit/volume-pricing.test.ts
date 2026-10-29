import { describe, expect, it } from 'vitest'
import { parseVolumeTiers } from '../../workers/catalog/volume-pricing'

describe('governed D1 volume tiers', () => {
  it('accepts ordered, non-increasing prices', () => {
    expect(
      parseVolumeTiers('[{"minimumQuantity":2,"unitGrossCents":450},{"minimumQuantity":5,"unitGrossCents":400}]', 500)
    ).toEqual([
      { minimumQuantity: 2, unitGrossCents: 450 },
      { minimumQuantity: 5, unitGrossCents: 400 }
    ])
  })

  it.each([
    '{}',
    '[null]',
    '[{"minimumQuantity":"2","unitGrossCents":400}]',
    '[{"minimumQuantity":2.5,"unitGrossCents":400}]',
    '[{"minimumQuantity":2,"unitGrossCents":600}]',
    '[{"minimumQuantity":2,"unitGrossCents":0}]',
    '[{"minimumQuantity":2,"unitGrossCents":400},{"minimumQuantity":2,"unitGrossCents":300}]'
  ])('fails closed on invalid JSON tier data: %s', (raw) => {
    expect(() => parseVolumeTiers(raw, 500)).toThrow()
  })
})
