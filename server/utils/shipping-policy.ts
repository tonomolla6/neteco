export interface ShippingCommercialPolicy {
  freeShippingThresholdCents: number | null
  ownDeliveryPostalPrefixes: string[]
}

export interface ShippingCalendarPolicy {
  cutoffLocalHour: number
  holidays: string[]
}

export function shippingCalendarPolicy(environment: NodeJS.ProcessEnv = process.env): ShippingCalendarPolicy {
  const cutoffLocalHour = Number(environment.SHIPPING_CUTOFF_LOCAL_HOUR?.trim() || 13)
  if (!Number.isSafeInteger(cutoffLocalHour) || cutoffLocalHour < 0 || cutoffLocalHour > 23) {
    throw new Error('SHIPPING_CUTOFF_LOCAL_HOUR must be an integer from 0 to 23 in Europe/Madrid')
  }
  const holidays = [
    environment.SHIPPING_NATIONAL_HOLIDAYS,
    environment.SHIPPING_LOCAL_HOLIDAYS,
    environment.SHIPPING_CARRIER_HOLIDAYS
  ]
    .flatMap((value) => value?.split(',') ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    holidays.some((value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return true
      const parsed = new Date(`${value}T00:00:00Z`)
      return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    })
  ) {
    throw new Error('Shipping holidays must be comma-separated YYYY-MM-DD dates')
  }
  return { cutoffLocalHour, holidays: [...new Set(holidays)].sort() }
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
