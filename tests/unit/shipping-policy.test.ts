import { describe, expect, it } from 'vitest'
import { shippingCalendarPolicy, shippingCommercialPolicy } from '../../server/utils/shipping-policy'

describe('shipping commercial policy', () => {
  it('uses documented demo defaults outside production', () => {
    expect(shippingCommercialPolicy({ APP_ENV: 'test' })).toEqual({
      freeShippingThresholdCents: 15_000,
      ownDeliveryPostalPrefixes: ['468']
    })
  })

  it('fails closed instead of inventing production commercial promises', () => {
    expect(shippingCommercialPolicy({ APP_ENV: 'production' })).toEqual({
      freeShippingThresholdCents: null,
      ownDeliveryPostalPrefixes: []
    })
  })

  it('accepts approved production values', () => {
    expect(
      shippingCommercialPolicy({
        APP_ENV: 'production',
        FREE_SHIPPING_THRESHOLD_CENTS: '25000',
        OWN_DELIVERY_POSTAL_PREFIXES: '468,46790'
      })
    ).toEqual({ freeShippingThresholdCents: 25_000, ownDeliveryPostalPrefixes: ['468', '46790'] })
  })

  it('rejects invalid thresholds and postal prefixes', () => {
    expect(() => shippingCommercialPolicy({ FREE_SHIPPING_THRESHOLD_CENTS: '-1' })).toThrow(
      'FREE_SHIPPING_THRESHOLD_CENTS'
    )
    expect(() => shippingCommercialPolicy({ FREE_SHIPPING_THRESHOLD_CENTS: '1.5' })).toThrow(
      'FREE_SHIPPING_THRESHOLD_CENTS'
    )
    expect(() => shippingCommercialPolicy({ OWN_DELIVERY_POSTAL_PREFIXES: 'abc' })).toThrow(
      'OWN_DELIVERY_POSTAL_PREFIXES'
    )
  })

  it('merges national, local and carrier calendars in Europe/Madrid', () => {
    expect(
      shippingCalendarPolicy({
        SHIPPING_CUTOFF_LOCAL_HOUR: '14',
        SHIPPING_NATIONAL_HOLIDAYS: '2026-01-01,2026-12-25',
        SHIPPING_LOCAL_HOLIDAYS: '2026-11-16',
        SHIPPING_CARRIER_HOLIDAYS: '2026-12-25,2026-12-26'
      })
    ).toEqual({
      cutoffLocalHour: 14,
      holidays: ['2026-01-01', '2026-11-16', '2026-12-25', '2026-12-26']
    })
    expect(() => shippingCalendarPolicy({ SHIPPING_CUTOFF_LOCAL_HOUR: '24' })).toThrow('Europe/Madrid')
    expect(() => shippingCalendarPolicy({ SHIPPING_LOCAL_HOLIDAYS: '16/11/2026' })).toThrow('YYYY-MM-DD')
    expect(() => shippingCalendarPolicy({ SHIPPING_LOCAL_HOLIDAYS: '2026-02-30' })).toThrow('YYYY-MM-DD')
  })
})
