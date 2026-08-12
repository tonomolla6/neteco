export type Currency = 'EUR'

export interface TaxedAmount {
  netCents: number
  taxCents: number
  grossCents: number
  taxRateBasisPoints: number
}

export interface QuoteLineInput {
  variantId: string
  sku: string
  quantity: number
  unitGrossCents: number
  discountGrossCents?: number
  taxRateBasisPoints: number
  minimumQuantity?: number
  maximumQuantity?: number | null
  quantityIncrement?: number
}

export interface QuoteLine extends TaxedAmount {
  variantId: string
  sku: string
  quantity: number
  unitGrossCents: number
  discountGrossCents: number
}

export interface Quote {
  currency: Currency
  pricingVersion: string
  lines: QuoteLine[]
  subtotalNetCents: number
  discountGrossCents: number
  shipping: TaxedAmount
  taxCents: number
  totalGrossCents: number
}

function assertInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`)
}

export function roundRatio(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new RangeError('denominator must be positive')
  const sign = numerator < 0n ? -1n : 1n
  const absolute = numerator < 0n ? -numerator : numerator
  const result = (absolute * 2n + denominator) / (denominator * 2n)
  return Number(result * sign)
}

export function splitGross(grossCents: number, taxRateBasisPoints: number): TaxedAmount {
  assertInteger(grossCents, 'grossCents')
  assertInteger(taxRateBasisPoints, 'taxRateBasisPoints')
  if (grossCents < 0) throw new RangeError('grossCents cannot be negative')
  if (taxRateBasisPoints < 0 || taxRateBasisPoints > 10_000) {
    throw new RangeError('taxRateBasisPoints must be between 0 and 10000')
  }
  const netCents = roundRatio(BigInt(grossCents) * 10_000n, BigInt(10_000 + taxRateBasisPoints))
  return { netCents, taxCents: grossCents - netCents, grossCents, taxRateBasisPoints }
}

export function validateQuantity(
  quantity: number,
  rules: { minimumQuantity?: number; maximumQuantity?: number | null; quantityIncrement?: number }
) {
  assertInteger(quantity, 'quantity')
  const minimum = rules.minimumQuantity ?? 1
  const increment = rules.quantityIncrement ?? 1
  const maximum = rules.maximumQuantity ?? null
  assertInteger(minimum, 'minimumQuantity')
  assertInteger(increment, 'quantityIncrement')
  if (minimum <= 0) throw new RangeError('minimumQuantity must be positive')
  if (quantity < minimum) throw new RangeError(`quantity must be at least ${minimum}`)
  if (maximum !== null) {
    assertInteger(maximum, 'maximumQuantity')
    if (maximum <= 0) throw new RangeError('maximumQuantity must be positive')
    if (quantity > maximum) throw new RangeError(`quantity must not exceed ${maximum}`)
  }
  if (increment <= 0) throw new RangeError('quantityIncrement must be positive')
  if ((quantity - minimum) % increment !== 0) {
    throw new RangeError(`quantity must increase by ${increment} from ${minimum}`)
  }
}

export function quoteLine(input: QuoteLineInput): QuoteLine {
  validateQuantity(input.quantity, input)
  assertInteger(input.unitGrossCents, 'unitGrossCents')
  const discountGrossCents = input.discountGrossCents ?? 0
  assertInteger(discountGrossCents, 'discountGrossCents')
  if (input.unitGrossCents < 0 || discountGrossCents < 0)
    throw new RangeError('prices and discounts cannot be negative')
  const undiscountedGross = input.unitGrossCents * input.quantity
  assertInteger(undiscountedGross, 'lineGrossCents')
  if (discountGrossCents > undiscountedGross) throw new RangeError('discount cannot exceed line gross amount')
  const taxed = splitGross(undiscountedGross - discountGrossCents, input.taxRateBasisPoints)
  return {
    variantId: input.variantId,
    sku: input.sku,
    quantity: input.quantity,
    unitGrossCents: input.unitGrossCents,
    discountGrossCents,
    ...taxed
  }
}

export function calculateQuote(input: {
  currency?: Currency
  pricingVersion: string
  lines: QuoteLineInput[]
  shippingGrossCents: number
  shippingTaxRateBasisPoints: number
}): Quote {
  if (input.lines.length === 0) throw new RangeError('quote requires at least one line')
  const lines = input.lines.map(quoteLine)
  const shipping = splitGross(input.shippingGrossCents, input.shippingTaxRateBasisPoints)
  return {
    currency: input.currency ?? 'EUR',
    pricingVersion: input.pricingVersion,
    lines,
    subtotalNetCents: lines.reduce((sum, line) => sum + line.netCents, 0),
    discountGrossCents: lines.reduce((sum, line) => sum + line.discountGrossCents, 0),
    shipping,
    taxCents: lines.reduce((sum, line) => sum + line.taxCents, shipping.taxCents),
    totalGrossCents: lines.reduce((sum, line) => sum + line.grossCents, shipping.grossCents)
  }
}
