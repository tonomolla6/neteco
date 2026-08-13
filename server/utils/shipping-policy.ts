export interface ShippingCommercialPolicy {
  freeShippingThresholdCents: number | null
  ownDeliveryPostalPrefixes: string[]
}

export function shippingCommercialPolicy(environment: NodeJS.ProcessEnv = process.env): ShippingCommercialPolicy {
  const production = environment.APP_ENV === 'production'
  const rawThreshold = environment.FREE_SHIPPING_THRESHOLD_CENTS?.trim()
  const freeShippingThresholdCents = rawThreshold ? Number(rawThreshold) : production ? null : 15_000
  if (
    freeShippingThresholdCents !== null &&
    (!Number.isSafeInteger(freeShippingThresholdCents) || freeShippingThresholdCents < 0)
  ) {
    throw new Error('FREE_SHIPPING_THRESHOLD_CENTS must be a non-negative integer')
  }
  const rawPrefixes = environment.OWN_DELIVERY_POSTAL_PREFIXES?.trim() || (production ? '' : '468')
  const ownDeliveryPostalPrefixes = rawPrefixes
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean)
  if (ownDeliveryPostalPrefixes.some((prefix) => !/^\d{2,5}$/.test(prefix))) {
    throw new Error('OWN_DELIVERY_POSTAL_PREFIXES must contain comma-separated postal prefixes')
  }
  return { freeShippingThresholdCents, ownDeliveryPostalPrefixes }
}
