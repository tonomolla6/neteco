import type { Parcel, ShippingAddress, ShippingRate } from '../integrations/carrier-provider'

export type ShipmentProfile = ShippingRate['profile']

export function assertShippingAddress(address: ShippingAddress) {
  if (address.countryCode !== 'ES') throw new Error('Only Spanish destinations are currently supported')
  if (!/^\d{5}$/.test(address.postalCode)) throw new Error('Spanish postal code is invalid')
  if (!address.name.trim() || !address.line1.trim() || !address.city.trim() || !address.region.trim()) {
    throw new Error('Shipping address is incomplete')
  }
}

export function chargeableWeightGrams(parcel: Parcel) {
  for (const [name, value] of Object.entries({
    weightGrams: parcel.weightGrams,
    widthMm: parcel.widthMm,
    heightMm: parcel.heightMm,
    depthMm: parcel.depthMm
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  }
  const volumetricGrams = Math.ceil((parcel.widthMm * parcel.heightMm * parcel.depthMm) / 5_000)
  return Math.max(parcel.weightGrams, volumetricGrams)
}

export function classifyShipment(parcels: Parcel[], ownDeliveryEligible = false): ShipmentProfile {
  if (parcels.length === 0) throw new Error('At least one parcel is required')
  if (parcels.some((parcel) => parcel.handling === 'adr')) return 'adr'
  if (parcels.some((parcel) => parcel.handling === 'pallet' || chargeableWeightGrams(parcel) > 40_000)) return 'pallet'
  if (ownDeliveryEligible) return 'own_delivery'
  return parcels.length > 1 ? 'multi_parcel' : 'parcel'
}

export function ownDeliveryEligible(postalCode: string, allowedPrefixes: readonly string[] = ['468']) {
  if (!/^\d{5}$/.test(postalCode)) return false
  return allowedPrefixes.some((prefix) => postalCode.startsWith(prefix))
}

export function standardShippingNetCents(profile: ShipmentProfile, chargeableGrams: number) {
  if (!Number.isSafeInteger(chargeableGrams) || chargeableGrams < 1) {
    throw new RangeError('Chargeable weight must be a positive safe integer')
  }
  if (profile === 'adr') return 6_900
  if (profile === 'pallet') return 4_500
  if (!['parcel', 'multi_parcel'].includes(profile)) return 0
  return 488 + Math.max(0, Math.ceil(chargeableGrams / 5_000) - 1) * 103
}

export function addBusinessDays(date: Date, days: number, holidays: readonly string[] = []) {
  if (!Number.isSafeInteger(days) || days < 0) throw new RangeError('Business-day count must be non-negative')
  const result = new Date(date)
  let remaining = days
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1)
    const iso = result.toISOString().slice(0, 10)
    const weekday = result.getUTCDay()
    if (weekday !== 0 && weekday !== 6 && !holidays.includes(iso)) remaining -= 1
  }
  return result
}

export function estimatedDeliveryWindow(input: {
  now: Date
  preparationBusinessDays: number
  transitBusinessDays: [number, number]
  cutoffUtcHour: number
  holidays?: readonly string[]
}) {
  const [minimumTransit, maximumTransit] = input.transitBusinessDays
  if (
    !Number.isSafeInteger(input.cutoffUtcHour) ||
    input.cutoffUtcHour < 0 ||
    input.cutoffUtcHour > 23 ||
    !Number.isSafeInteger(minimumTransit) ||
    !Number.isSafeInteger(maximumTransit) ||
    minimumTransit < 0 ||
    maximumTransit < minimumTransit
  ) {
    throw new RangeError('Delivery-window configuration is invalid')
  }
  const missedCutoff = input.now.getUTCHours() >= input.cutoffUtcHour ? 1 : 0
  const dispatch = addBusinessDays(input.now, input.preparationBusinessDays + missedCutoff, input.holidays ?? [])
  return {
    from: addBusinessDays(dispatch, minimumTransit, input.holidays ?? []).toISOString(),
    to: addBusinessDays(dispatch, maximumTransit, input.holidays ?? []).toISOString()
  }
}
