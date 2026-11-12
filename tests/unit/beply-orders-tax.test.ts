import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { assertBeplyTaxCompatibility } from '../../shared/beply-orders'

// Independent transcription of Core/Lib/Calculator.php:134-138,278-342,
// 246-272 at 37e1341d201d55d819332117300eea755f9a041e (not a captured API).
function sourceTotals(
  lines: Array<{ netCents: number; quantity: number; taxRateBasisPoints: number }>,
  method: 'classic' | 'price-adjusted'
) {
  const groups = new Map<number, { net: number; tax: number }>()
  for (const line of lines) {
    const price = Number((line.netCents / 100 / line.quantity).toFixed(6)),
      net = price * line.quantity
    const tax =
      line.taxRateBasisPoints === 0
        ? 0
        : method === 'classic'
          ? (net * line.taxRateBasisPoints) / 10000
          : (Math.round(price * (1 + line.taxRateBasisPoints / 10000) * 100) * line.quantity - Math.round(net * 100)) /
            100
    const group = groups.get(line.taxRateBasisPoints) ?? { net: 0, tax: 0 }
    group.net += net
    group.tax += tax
    groups.set(line.taxRateBasisPoints, group)
  }
  return new Map(
    [...groups].map(([rate, g]) => [rate, { net: Math.round(g.net * 100 + 1e-8), tax: Math.round(g.tax * 100 + 1e-8) }])
  )
}
describe('A-08 with the real configurable FacturaScripts algorithms', () => {
  it('accepts 2 × 1.00 in price-adjusted and rejects classic before issuing', () => {
    const lines = [0, 1].map(() => ({
      netCents: 83,
      taxCents: 17,
      grossCents: 100,
      quantity: 1,
      taxRateBasisPoints: 2100
    }))
    const input = { lines, shippingNetCents: 0, shippingTaxCents: 0, shippingTaxRateBasisPoints: 2100 }
    expect(sourceTotals(lines, 'classic').get(2100)).toEqual({ net: 166, tax: 35 })
    expect(sourceTotals(lines, 'price-adjusted').get(2100)).toEqual({ net: 166, tax: 34 })
    expect(() => assertBeplyTaxCompatibility(input, 'price-adjusted')).not.toThrow()
    expect(() => assertBeplyTaxCompatibility(input, 'classic')).toThrow('tax_rounding_review_required')
  })
  it('checks quantities, mixed rates and shipping using the generated six-decimal prices', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            netCents: fc.integer({ min: 1, max: 100000 }),
            quantity: fc.integer({ min: 1, max: 999 }),
            taxRateBasisPoints: fc.constantFrom(0, 1000, 2100)
          }),
          { minLength: 2, maxLength: 20 }
        ),
        fc.constantFrom('classic' as const, 'price-adjusted' as const),
        (raw, method) => {
          const entries = raw.map((line) => ({
              ...line,
              taxCents: Math.round((line.netCents * line.taxRateBasisPoints) / 10000)
            })),
            shipping = { ...entries[0]!, quantity: 1 },
            lines = entries.slice(1)
          const input = {
            lines,
            shippingNetCents: shipping.netCents,
            shippingTaxCents: shipping.taxCents,
            shippingTaxRateBasisPoints: shipping.taxRateBasisPoints
          }
          const expected = new Map<number, { net: number; tax: number }>()
          for (const line of [...lines, shipping]) {
            const group = expected.get(line.taxRateBasisPoints) ?? { net: 0, tax: 0 }
            group.net += line.netCents
            group.tax += line.taxCents
            expected.set(line.taxRateBasisPoints, group)
          }
          const actual = sourceTotals([...lines, shipping], method)
          let accepted = true
          try {
            assertBeplyTaxCompatibility(input, method)
          } catch {
            accepted = false
          }
          expect(accepted).toBe(
            [...expected].every(
              ([rate, group]) => group.net === actual.get(rate)!.net && group.tax === actual.get(rate)!.tax
            )
          )
        }
      ),
      { numRuns: 300, seed: 1122026 }
    )
  })
})
