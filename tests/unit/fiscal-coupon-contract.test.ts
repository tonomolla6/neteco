import { expect, it } from 'vitest'
import { fiscalContractSchema, type FiscalContract, type FiscalPolicy } from '../../shared/fiscal-issuance'
import { validateFiscalContract } from '../../workers/fiscal/issuance'

const policy: FiscalPolicy = {
  id: '72000000-0000-4000-8000-000000000001',
  fingerprint: 'a'.repeat(64),
  approvedAt: '2026-10-09T14:00:00Z',
  idempotencyKey: 'synthetic-coupon-policy',
  provider: 'local_fake',
  environment: 'local_validation',
  series: 'LOCAL',
  trigger: 'after_payment_capture',
  mappings: {
    companyId: 'SYNTHETIC',
    taxes: { '0': 'ZERO', '1000': 'REDUCED', '2100': 'GENERAL' },
    paymentCode: 'CARD'
  },
  reason: 'Synthetic coupon monetary contract validation',
  evidenceRef: 'synthetic-coupon-contract'
}
type Line = FiscalContract['lines'][number]
function contract(lines: Line[]): FiscalContract {
  return {
    schemaVersion: 1,
    fiscalVersion: 1,
    kind: 'ordinary',
    orderId: '72000000-0000-4000-8000-000000000002',
    orderNumber: '72000000-0000-4000-8000-000000000002',
    series: 'LOCAL',
    issuedOn: '2026-10-09T14:00:00Z',
    currency: 'EUR',
    paymentMethod: 'redsys',
    idempotencyKey: 'synthetic-coupon-invoice',
    policyId: policy.id,
    policyFingerprint: policy.fingerprint,
    provider: policy.provider,
    environment: policy.environment,
    validationOnly: true,
    customer: {
      externalKey: '72000000-0000-4000-8000-000000000003',
      legalName: 'Synthetic Buyer',
      email: 'buyer@example.invalid',
      address: {
        line1: 'Synthetic Street 1',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES'
      }
    },
    lines,
    shippingNetCents: 100,
    shippingTaxCents: 0,
    shippingGrossCents: 100,
    shippingTaxRateBasisPoints: 0,
    totalNetCents: 100 + lines.reduce((sum, line) => sum + line.netCents, 0),
    totalTaxCents: lines.reduce((sum, line) => sum + line.taxCents, 0),
    totalGrossCents: 100 + lines.reduce((sum, line) => sum + line.grossCents, 0)
  }
}
function line(net: number, tax: number, discountNet: number, index = 0): Line {
  return {
    lineIndex: index,
    sku: `SYNTHETIC-${index}`,
    description: 'Synthetic coupon line',
    quantity: 3,
    unitGrossCents: 101,
    unitNetCents: 83,
    lineNetCents: 250,
    discountNetCents: discountNet,
    netCents: net,
    taxCents: tax,
    grossCents: net + tax,
    taxRateBasisPoints: 2100
  }
}
it.each([
  ['one gross cent discount entirely affects VAT rounding', 250, 52, 0],
  ['two gross cents discount changes net by one cent', 249, 52, 1],
  ['a fully discounted merchandise line has zero charged net and VAT', 0, 0, 250]
] as const)('accepts %s without applying the fiscal discount twice', (_label, net, tax, discount) => {
  const value = contract([line(net, tax, discount)])
  expect(fiscalContractSchema.safeParse(value).success).toBe(true)
  expect(() => validateFiscalContract(value, policy)).not.toThrow()
  expect(value.lines[0]!.lineNetCents - value.lines[0]!.discountNetCents).toBe(net)
})
it('preserves independent VAT rates and rounded pre-coupon unit net without forcing a false unit multiplication identity', () => {
  const value = contract([
    line(249, 52, 1),
    {
      lineIndex: 1,
      sku: 'SYNTHETIC-REDUCED',
      description: 'Reduced VAT coupon line',
      quantity: 2,
      unitGrossCents: 110,
      unitNetCents: 100,
      lineNetCents: 200,
      discountNetCents: 19,
      netCents: 181,
      taxCents: 18,
      grossCents: 199,
      taxRateBasisPoints: 1000
    }
  ])
  expect(value.lines[0]!.unitNetCents * value.lines[0]!.quantity).toBe(249)
  expect(value.lines[0]!.lineNetCents).toBe(250)
  expect(() => validateFiscalContract(value, policy)).not.toThrow()
  expect(value.totalGrossCents).toBe(600)
})
it('rejects double-discounted, negative-discount and over-priced fiscal line economics', () => {
  for (const change of [
    { lineNetCents: 249 },
    { discountNetCents: -1 },
    { grossCents: 304, netCents: 251, taxCents: 53 }
  ]) {
    const value = contract([{ ...line(249, 52, 1), ...change }])
    expect(() => {
      const parsed = fiscalContractSchema.parse(value)
      validateFiscalContract(parsed, policy)
    }).toThrow()
  }
})
