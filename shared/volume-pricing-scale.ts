import { roundRatio } from '../server/domain/money'

export interface VolumePriceTierWithMultiple {
  minimumQuantity: number
  unitGrossCents: number
  packagingMultiple?: number
  label?: string
}

export interface VolumePricingScaleEntry {
  tierIndex: number
  minimumQuantity: number
  maximumQuantity: number | null
  packagingMultiple: number
  unitGrossCents: number
  unitNetCents: number
  effectiveUnitDiscountGrossCents: number
  effectiveDiscountBasisPoints: number
  effectiveDiscountPercent: number
  sampleTotalGrossCents: number
  sampleTotalSavingsGrossCents: number
  isActive: boolean
  label: string
}

export interface NextTierIncentive {
  additionalQuantityNeeded: number
  nextTierMinQty: number
  nextTierUnitGrossCents: number
  additionalDiscountBasisPoints: number
  additionalDiscountPercent: number
  message: string
}

export interface VolumePricingBreakdown {
  baseGrossCents: number
  baseNetCents: number
  quantity: number
  taxRateBasisPoints: number
  appliedTierIndex: number
  appliedTierMinQty: number
  effectiveUnitGrossCents: number
  effectiveUnitNetCents: number
  unitDiscountGrossCents: number
  unitDiscountNetCents: number
  totalDiscountGrossCents: number
  totalDiscountNetCents: number
  totalGrossCents: number
  totalNetCents: number
  totalTaxCents: number
  nextTierIncentive: NextTierIncentive | null
  scale: VolumePricingScaleEntry[]
}

export interface OrderLineSnapshot {
  lineIndex: number
  sku: string
  name: string
  quantity: number
  unitGrossCents: number
  effectiveUnitGrossCents?: number
  discountGrossCents?: number
  netCents: number
  taxCents: number
  grossCents: number
  taxRateBasisPoints: number
}

export interface InvoiceLineSnapshot {
  lineIndex: number
  sku: string
  description: string
  quantity: number
  unitPriceNetCents: number
  unitGrossCents: number
  discountNetCents?: number
  discountGrossCents?: number
  netCents: number
  taxCents: number
  grossCents: number
  taxRateBasisPoints: number
}

export interface ContractMatchResult {
  isConsistent: boolean
  discrepancies: string[]
  summary: {
    grossMatches: boolean
    netMatches: boolean
    taxMatches: boolean
    discountMatches: boolean
  }
}

/** Net price derived from gross and tax rate basis points (e.g. 2100 for 21%). */
export function grossToNet(grossCents: number, taxRateBasisPoints: number): number {
  if (taxRateBasisPoints <= 0) return grossCents
  return roundRatio(BigInt(grossCents) * 10_000n, 10_000n + BigInt(taxRateBasisPoints))
}

/**
 * Builds a clear, sorted, verified volume pricing scale table.
 * Includes base tier (quantity 1) and all configured discount scales.
 */
export function buildVolumePricingScale(options: {
  baseGrossCents: number
  taxRateBasisPoints: number
  tiers: VolumePriceTierWithMultiple[]
  currentQuantity?: number
}): VolumePricingScaleEntry[] {
  const { baseGrossCents, taxRateBasisPoints, tiers } = options
  const qty = Math.max(1, options.currentQuantity ?? 1)

  if (!Number.isSafeInteger(baseGrossCents) || baseGrossCents <= 0) {
    throw new RangeError('baseGrossCents must be a positive integer')
  }

  // Validate tiers strictly
  let prevMin = 0
  let prevPrice = baseGrossCents

  for (const tier of tiers) {
    if (!Number.isSafeInteger(tier.minimumQuantity) || tier.minimumQuantity <= prevMin) {
      throw new RangeError('volume tiers must have strictly increasing minimum quantities')
    }
    if (!Number.isSafeInteger(tier.unitGrossCents) || tier.unitGrossCents <= 0) {
      throw new RangeError('tier unitGrossCents must be a positive integer')
    }
    if (tier.unitGrossCents > prevPrice) {
      throw new RangeError('volume tier prices cannot increase')
    }
    prevMin = tier.minimumQuantity
    prevPrice = tier.unitGrossCents
  }

  // Combine tier 0 (base) and higher tiers
  const normalized: Array<{
    minQty: number
    maxQty: number | null
    unitGross: number
    multiple: number
    label: string
  }> = []

  // Check if first tier starts at 1, or add base tier
  const firstTier = tiers[0]
  if (!firstTier || firstTier.minimumQuantity > 1) {
    normalized.push({
      minQty: 1,
      maxQty: firstTier ? firstTier.minimumQuantity - 1 : null,
      unitGross: baseGrossCents,
      multiple: 1,
      label: 'Precio estándar'
    })
  }

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]!
    const nextT = tiers[i + 1]
    normalized.push({
      minQty: t.minimumQuantity,
      maxQty: nextT ? nextT.minimumQuantity - 1 : null,
      unitGross: t.unitGrossCents,
      multiple: t.packagingMultiple ?? t.minimumQuantity,
      label: t.label ?? `A partir de ${t.minimumQuantity} uds`
    })
  }

  return normalized.map((item, index) => {
    const unitDiscountGross = baseGrossCents - item.unitGross
    const discountBp = Math.round((unitDiscountGross / baseGrossCents) * 10_000)
    const discountPercent = Number((discountBp / 100).toFixed(1))
    const unitNet = grossToNet(item.unitGross, taxRateBasisPoints)
    const sampleGross = item.minQty * item.unitGross
    const sampleSavings = item.minQty * unitDiscountGross
    const isActive = qty >= item.minQty && (item.maxQty === null || qty <= item.maxQty)

    return {
      tierIndex: index,
      minimumQuantity: item.minQty,
      maximumQuantity: item.maxQty,
      packagingMultiple: item.multiple,
      unitGrossCents: item.unitGross,
      unitNetCents: unitNet,
      effectiveUnitDiscountGrossCents: unitDiscountGross,
      effectiveDiscountBasisPoints: discountBp,
      effectiveDiscountPercent: discountPercent,
      sampleTotalGrossCents: sampleGross,
      sampleTotalSavingsGrossCents: sampleSavings,
      isActive,
      label: item.label
    }
  })
}

/**
 * Calculates volume pricing breakdown for a specific quantity.
 * Calculates next tier upsell / incentive if a higher tier exists.
 */
export function calculateVolumePricingBreakdown(options: {
  baseGrossCents: number
  quantity: number
  taxRateBasisPoints: number
  tiers: VolumePriceTierWithMultiple[]
}): VolumePricingBreakdown {
  const { baseGrossCents, quantity, taxRateBasisPoints, tiers } = options

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError('quantity must be a positive integer')
  }

  const scale = buildVolumePricingScale({
    baseGrossCents,
    taxRateBasisPoints,
    tiers,
    currentQuantity: quantity
  })

  const activeEntry = scale.find((s) => s.isActive) ?? scale[0]!
  const baseNet = grossToNet(baseGrossCents, taxRateBasisPoints)

  const effectiveUnitGross = activeEntry.unitGrossCents
  const effectiveUnitNet = activeEntry.unitNetCents
  const unitDiscountGross = activeEntry.effectiveUnitDiscountGrossCents
  const unitDiscountNet = baseNet - effectiveUnitNet

  const totalGross = effectiveUnitGross * quantity
  const totalNet = roundRatio(BigInt(totalGross) * 10_000n, 10_000n + BigInt(taxRateBasisPoints))
  const totalTax = totalGross - totalNet

  const totalDiscountGross = unitDiscountGross * quantity
  const baseTotalNet = roundRatio(BigInt(baseGrossCents * quantity) * 10_000n, 10_000n + BigInt(taxRateBasisPoints))
  const totalDiscountNet = Math.max(0, baseTotalNet - totalNet)

  // Next tier incentive calculation
  let nextTierIncentive: NextTierIncentive | null = null
  const nextTier = scale.find((s) => s.minimumQuantity > quantity)

  if (nextTier) {
    const additionalQuantityNeeded = nextTier.minimumQuantity - quantity
    const additionalBp = nextTier.effectiveDiscountBasisPoints - activeEntry.effectiveDiscountBasisPoints
    const additionalPercent = Number((additionalBp / 100).toFixed(1))
    nextTierIncentive = {
      additionalQuantityNeeded,
      nextTierMinQty: nextTier.minimumQuantity,
      nextTierUnitGrossCents: nextTier.unitGrossCents,
      additionalDiscountBasisPoints: additionalBp,
      additionalDiscountPercent: additionalPercent,
      message: `Añade ${additionalQuantityNeeded} unidades más para alcanzar el tramo de ${nextTier.minimumQuantity} uds y ahorrar un ${nextTier.effectiveDiscountPercent}% (${nextTier.effectiveUnitDiscountGrossCents / 100} €/ud)`
    }
  }

  return {
    baseGrossCents,
    baseNetCents: baseNet,
    quantity,
    taxRateBasisPoints,
    appliedTierIndex: activeEntry.tierIndex,
    appliedTierMinQty: activeEntry.minimumQuantity,
    effectiveUnitGrossCents: effectiveUnitGross,
    effectiveUnitNetCents: effectiveUnitNet,
    unitDiscountGrossCents: unitDiscountGross,
    unitDiscountNetCents: unitDiscountNet,
    totalDiscountGrossCents: totalDiscountGross,
    totalDiscountNetCents: totalDiscountNet,
    totalGrossCents: totalGross,
    totalNetCents: totalNet,
    totalTaxCents: totalTax,
    nextTierIncentive,
    scale
  }
}

/**
 * Requirement MKT-023 acceptance:
 * Motor / Pedido / Factura coinciden exactamente al céntimo.
 */
export function verifyVolumePricingContractMatch(options: {
  engine: VolumePricingBreakdown
  orderLine: OrderLineSnapshot
  invoiceLine: InvoiceLineSnapshot
}): ContractMatchResult {
  const { engine, orderLine, invoiceLine } = options
  const discrepancies: string[] = []

  // 1. Quantity consistency
  if (orderLine.quantity !== engine.quantity) {
    discrepancies.push(`Quantity discrepancy: order (${orderLine.quantity}) vs engine (${engine.quantity})`)
  }
  if (invoiceLine.quantity !== engine.quantity) {
    discrepancies.push(`Quantity discrepancy: invoice (${invoiceLine.quantity}) vs engine (${engine.quantity})`)
  }

  // 2. Gross amounts match
  const grossMatches =
    engine.totalGrossCents === orderLine.grossCents &&
    orderLine.grossCents === invoiceLine.grossCents &&
    orderLine.grossCents === orderLine.unitGrossCents * orderLine.quantity - (orderLine.discountGrossCents ?? 0)

  if (!grossMatches) {
    discrepancies.push(
      `Gross discrepancy: engine=${engine.totalGrossCents}, order=${orderLine.grossCents}, invoice=${invoiceLine.grossCents}`
    )
  }

  // 3. Net amounts match
  const netMatches = engine.totalNetCents === orderLine.netCents && orderLine.netCents === invoiceLine.netCents

  if (!netMatches) {
    discrepancies.push(
      `Net discrepancy: engine=${engine.totalNetCents}, order=${orderLine.netCents}, invoice=${invoiceLine.netCents}`
    )
  }

  // 4. Tax amounts match and net + tax = gross
  const orderSum = orderLine.netCents + orderLine.taxCents === orderLine.grossCents
  const invoiceSum = invoiceLine.netCents + invoiceLine.taxCents === invoiceLine.grossCents
  const taxMatches =
    engine.totalTaxCents === orderLine.taxCents && orderLine.taxCents === invoiceLine.taxCents && orderSum && invoiceSum

  if (!taxMatches) {
    discrepancies.push(
      `Tax discrepancy: engine=${engine.totalTaxCents}, order=${orderLine.taxCents}, invoice=${invoiceLine.taxCents}`
    )
  }

  // 5. Volume discount match
  const discountMatches =
    (orderLine.discountGrossCents ?? 0) === engine.totalDiscountGrossCents &&
    (invoiceLine.discountGrossCents ?? 0) === engine.totalDiscountGrossCents

  if (!discountMatches) {
    discrepancies.push(
      `Discount discrepancy: engine=${engine.totalDiscountGrossCents}, order=${orderLine.discountGrossCents}, invoice=${invoiceLine.discountGrossCents}`
    )
  }

  return {
    isConsistent: discrepancies.length === 0,
    discrepancies,
    summary: {
      grossMatches,
      netMatches,
      taxMatches,
      discountMatches
    }
  }
}
