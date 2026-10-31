import { selectVolumeUnitPrice, type VolumePriceTier } from '../../server/domain/money'
import {
  buildVolumePricingScale,
  calculateVolumePricingBreakdown,
  verifyVolumePricingContractMatch,
  type VolumePriceTierWithMultiple,
  type VolumePricingBreakdown,
  type VolumePricingScaleEntry
} from '../../shared/volume-pricing-scale'

/** Validate governed D1 JSON before presenting a tier or using it in a quote. */
export function parseVolumeTiers(raw: string, baseGrossCents: number): VolumePriceTier[] {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new TypeError('volume tiers must be an array')
  const tiers = value.map((tier: unknown) => {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw new TypeError('volume tier must be an object')
    const fields = tier as Record<string, unknown>
    if (typeof fields.minimumQuantity !== 'number' || typeof fields.unitGrossCents !== 'number')
      throw new TypeError('volume tier fields must be numbers')
    if (fields.unitGrossCents <= 0) throw new RangeError('volume tier price must be positive')
    return { minimumQuantity: fields.minimumQuantity, unitGrossCents: fields.unitGrossCents }
  })
  selectVolumeUnitPrice(baseGrossCents, 1, tiers)
  return tiers
}

/**
 * Parses governed D1 volume tiers with optional packaging multiples and labels.
 */
export function parseVolumeTiersWithMultiples(raw: string, baseGrossCents: number): VolumePriceTierWithMultiple[] {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new TypeError('volume tiers must be an array')
  const tiers = value.map((tier: unknown) => {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw new TypeError('volume tier must be an object')
    const fields = tier as Record<string, unknown>
    if (typeof fields.minimumQuantity !== 'number' || typeof fields.unitGrossCents !== 'number')
      throw new TypeError('volume tier fields must be numbers')
    if (fields.unitGrossCents <= 0) throw new RangeError('volume tier price must be positive')
    return {
      minimumQuantity: fields.minimumQuantity,
      unitGrossCents: fields.unitGrossCents,
      ...(typeof fields.packagingMultiple === 'number' && fields.packagingMultiple > 0
        ? { packagingMultiple: fields.packagingMultiple }
        : {}),
      ...(typeof fields.label === 'string' && fields.label.trim().length > 0 ? { label: fields.label.trim() } : {})
    }
  })
  selectVolumeUnitPrice(baseGrossCents, 1, tiers)
  return tiers
}

export {
  buildVolumePricingScale,
  calculateVolumePricingBreakdown,
  verifyVolumePricingContractMatch,
  type VolumePriceTierWithMultiple,
  type VolumePricingBreakdown,
  type VolumePricingScaleEntry
}
