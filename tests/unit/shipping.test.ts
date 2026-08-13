import { describe, expect, it } from 'vitest'
import {
  addBusinessDays,
  assertShippingAddress,
  chargeableWeightGrams,
  classifyShipment,
  estimatedDeliveryWindow,
  ownDeliveryEligible,
  standardShippingNetCents
} from '../../server/domain/shipping'
import { carrierProviderFromEnvironment } from '../../server/integrations/carrier-factory'
import type { Parcel, ShippingAddress } from '../../server/integrations/carrier-provider'
import {
  ManualCarrierProvider,
  MockCarrierProvider,
  OwnDeliveryCarrierProvider
} from '../../server/integrations/mock-carrier'

const address: ShippingAddress = {
  name: 'Cliente NETECO',
  line1: 'Calle Prueba 1',
  postalCode: '28001',
  city: 'Madrid',
  region: 'Madrid',
  countryCode: 'ES',
  phone: '600000000'
}

const parcel: Parcel = {
  weightGrams: 1_000,
  widthMm: 300,
  heightMm: 200,
  depthMm: 100,
  contents: [{ sku: 'SKU-1', quantity: 1 }],
  handling: 'parcel'
}

describe('shipping domain', () => {
  it('validates complete supported Spanish addresses', () => {
    expect(() => assertShippingAddress(address)).not.toThrow()
    expect(() => assertShippingAddress({ ...address, countryCode: 'FR' })).toThrow('Spanish')
    expect(() => assertShippingAddress({ ...address, postalCode: '2800' })).toThrow('postal')
    expect(() => assertShippingAddress({ ...address, postalCode: 'x28001' })).toThrow('postal')
    expect(() => assertShippingAddress({ ...address, postalCode: '28001x' })).toThrow('postal')
    for (const field of ['name', 'line1', 'city', 'region'] as const) {
      expect(() => assertShippingAddress({ ...address, [field]: '  ' })).toThrow('incomplete')
    }
  })

  it('uses the greater of physical and volumetric weight and rejects invalid dimensions', () => {
    expect(chargeableWeightGrams(parcel)).toBe(1_200)
    expect(chargeableWeightGrams({ ...parcel, weightGrams: 2_000 })).toBe(2_000)
    for (const field of ['weightGrams', 'widthMm', 'heightMm', 'depthMm'] as const) {
      expect(() => chargeableWeightGrams({ ...parcel, [field]: 0 })).toThrow(`${field} must be`)
      expect(() => chargeableWeightGrams({ ...parcel, [field]: 1.5 })).toThrow(`${field} must be`)
    }
  })

  it('classifies own, parcel, multibulto, pallet and ADR profiles by precedence', () => {
    expect(() => classifyShipment([])).toThrow('At least one')
    expect(classifyShipment([parcel])).toBe('parcel')
    expect(classifyShipment([parcel], true)).toBe('own_delivery')
    expect(classifyShipment([parcel, parcel])).toBe('multi_parcel')
    expect(classifyShipment([{ ...parcel, handling: 'pallet' }], true)).toBe('pallet')
    expect(classifyShipment([parcel, { ...parcel, handling: 'pallet' }], true)).toBe('pallet')
    expect(classifyShipment([parcel, { ...parcel, handling: 'adr' }], true)).toBe('adr')
    expect(classifyShipment([{ ...parcel, weightGrams: 40_000 }], true)).toBe('own_delivery')
    expect(classifyShipment([{ ...parcel, weightGrams: 40_001 }], true)).toBe('pallet')
    expect(classifyShipment([{ ...parcel, handling: 'adr' }], true)).toBe('adr')
  })

  it('matches configurable own-delivery zones', () => {
    expect(ownDeliveryEligible('46870')).toBe(true)
    expect(ownDeliveryEligible('46001')).toBe(false)
    expect(ownDeliveryEligible('28001', ['28'])).toBe(true)
    expect(ownDeliveryEligible('28001', ['46', '28'])).toBe(true)
    expect(ownDeliveryEligible('x28001', ['28'])).toBe(false)
    expect(ownDeliveryEligible('28001x', ['28'])).toBe(false)
    expect(ownDeliveryEligible('bad')).toBe(false)
  })

  it('calculates normalized net tariffs by logistics profile', () => {
    expect(standardShippingNetCents('parcel', 1_000)).toBe(488)
    expect(standardShippingNetCents('parcel', 1)).toBe(488)
    expect(standardShippingNetCents('multi_parcel', 10_001)).toBe(694)
    expect(standardShippingNetCents('pallet', 1_000)).toBe(4_500)
    expect(standardShippingNetCents('adr', 1_000)).toBe(6_900)
    expect(standardShippingNetCents('own_delivery', 1_000)).toBe(0)
    expect(standardShippingNetCents('pickup', 1_000)).toBe(0)
    expect(() => standardShippingNetCents('parcel', 0)).toThrow('positive')
    expect(() => standardShippingNetCents('parcel', 1.5)).toThrow('positive')
  })

  it('calculates business days over weekends, holidays and cutoff', () => {
    expect(addBusinessDays(new Date('2026-08-14T10:00:00Z'), 0).toISOString()).toBe('2026-08-14T10:00:00.000Z')
    expect(addBusinessDays(new Date('2026-08-14T10:00:00Z'), 1).toISOString()).toBe('2026-08-17T10:00:00.000Z')
    expect(addBusinessDays(new Date('2026-08-14T10:00:00Z'), 1, ['2026-08-17']).toISOString()).toBe(
      '2026-08-18T10:00:00.000Z'
    )
    expect(() => addBusinessDays(new Date('2026-08-13T12:00:00Z'), -1)).toThrow('non-negative')
    expect(() => addBusinessDays(new Date('2026-08-13T12:00:00Z'), 1.5)).toThrow('non-negative')

    expect(
      estimatedDeliveryWindow({
        now: new Date('2026-08-12T12:00:00Z'),
        preparationBusinessDays: 0,
        transitBusinessDays: [1, 2],
        cutoffUtcHour: 13
      })
    ).toEqual({ from: '2026-08-13T12:00:00.000Z', to: '2026-08-14T12:00:00.000Z' })
    expect(
      estimatedDeliveryWindow({
        now: new Date('2026-08-12T13:00:00Z'),
        preparationBusinessDays: 0,
        transitBusinessDays: [0, 0],
        cutoffUtcHour: 13,
        holidays: ['2026-08-13']
      })
    ).toEqual({ from: '2026-08-14T13:00:00.000Z', to: '2026-08-14T13:00:00.000Z' })
    expect(
      estimatedDeliveryWindow({
        now: new Date('2026-08-12T00:00:00Z'),
        preparationBusinessDays: 0,
        transitBusinessDays: [0, 0],
        cutoffUtcHour: 0
      })
    ).toEqual({ from: '2026-08-13T00:00:00.000Z', to: '2026-08-13T00:00:00.000Z' })
    expect(
      estimatedDeliveryWindow({
        now: new Date('2026-08-12T22:00:00Z'),
        preparationBusinessDays: 0,
        transitBusinessDays: [0, 0],
        cutoffUtcHour: 23
      })
    ).toEqual({ from: '2026-08-12T22:00:00.000Z', to: '2026-08-12T22:00:00.000Z' })
  })

  it.each([
    { cutoffUtcHour: -1, transitBusinessDays: [1, 2] as [number, number] },
    { cutoffUtcHour: 24, transitBusinessDays: [1, 2] as [number, number] },
    { cutoffUtcHour: 1.5, transitBusinessDays: [1, 2] as [number, number] },
    { cutoffUtcHour: 13, transitBusinessDays: [-1, 2] as [number, number] },
    { cutoffUtcHour: 13, transitBusinessDays: [1.5, 2] as [number, number] },
    { cutoffUtcHour: 13, transitBusinessDays: [2, 1] as [number, number] },
    { cutoffUtcHour: 13, transitBusinessDays: [1, 2.5] as [number, number] }
  ])('rejects an invalid delivery window: $cutoffUtcHour / $transitBusinessDays', (invalid) => {
    expect(() =>
      estimatedDeliveryWindow({
        now: new Date('2026-08-12T10:00:00Z'),
        preparationBusinessDays: 0,
        ...invalid
      })
    ).toThrow('configuration')
  })
})

describe('normalized carrier provider', () => {
  const provider = new MockCarrierProvider()

  it('quotes every supported profile with normalized tax and ETA', async () => {
    const own = await provider.rates({
      originPostalCode: '46870',
      destination: { ...address, postalCode: '46870' },
      parcels: [parcel]
    })
    expect(own).toEqual([
      {
        provider: 'mock-carrier',
        serviceCode: 'OWN-DAY',
        label: 'Reparto propio NETECO',
        netCents: 0,
        taxRateBasisPoints: 2100,
        estimatedDeliveryFrom: '2026-08-13T10:00:00.000Z',
        estimatedDeliveryTo: '2026-08-14T10:00:00.000Z',
        profile: 'own_delivery'
      },
      {
        provider: 'mock-carrier',
        serviceCode: 'STANDARD-PARCEL',
        label: 'Transporte estándar',
        netCents: 488,
        taxRateBasisPoints: 2100,
        estimatedDeliveryFrom: '2026-08-14T10:00:00.000Z',
        estimatedDeliveryTo: '2026-08-17T10:00:00.000Z',
        profile: 'parcel'
      }
    ])

    const standard = await provider.rates({ originPostalCode: '46870', destination: address, parcels: [parcel] })
    expect(standard[0]).toMatchObject({ profile: 'parcel', netCents: 488 })
    expect(standard[0]!.estimatedDeliveryFrom).toBeTruthy()

    const heavy = await provider.rates({
      originPostalCode: '46870',
      destination: address,
      parcels: [{ ...parcel, weightGrams: 10_001 }]
    })
    expect(heavy[0]!.netCents).toBeGreaterThan(488)

    const pallet = await provider.rates({
      originPostalCode: '46870',
      destination: address,
      parcels: [{ ...parcel, handling: 'pallet' }]
    })
    expect(pallet[0]).toMatchObject({ profile: 'pallet', netCents: 4_500 })

    const adr = await provider.rates({
      originPostalCode: '46870',
      destination: address,
      parcels: [{ ...parcel, handling: 'adr' }]
    })
    expect(adr[0]).toMatchObject({ profile: 'adr', netCents: 6_900 })
    const ownPallet = await provider.rates({
      originPostalCode: '46870',
      destination: { ...address, postalCode: '46870' },
      parcels: [{ ...parcel, handling: 'pallet' }]
    })
    expect(ownPallet[0]).toMatchObject({ profile: 'pallet', netCents: 4_500 })
    await expect(provider.rates({ originPostalCode: 'bad', destination: address, parcels: [parcel] })).rejects.toThrow(
      'Origin'
    )
  })

  it('creates deterministic shipments, labels, tracking, cancellation, returns and pickups', async () => {
    const input = {
      orderNumber: 'NE12345',
      destination: address,
      parcels: [parcel],
      serviceCode: 'STANDARD-PARCEL',
      idempotencyKey: 'shipment:NE12345:v1'
    }
    const first = await provider.createShipment(input)
    const replay = await provider.createShipment(input)
    expect(replay).toEqual(first)
    expect({ ...first, label: new TextDecoder().decode(first.label) }).toEqual({
      providerShipmentId: 'SHP-8C08D069F8A3D7',
      trackingNumber: 'TRK-C4C5CB4F5B9036',
      label: '%PDF-1.4\n% NETECO carrier label SHP-8C08D069F8A3D7\n%%EOF',
      status: 'ready'
    })
    await expect(provider.tracking(first.providerShipmentId)).resolves.toEqual([
      { status: 'created', occurredAt: '2026-08-12T10:00:00.000Z' },
      { status: 'in_transit', occurredAt: '2026-08-13T07:00:00.000Z' }
    ])
    await expect(provider.cancelShipment(first.providerShipmentId)).resolves.toBeUndefined()
    const returned = await provider.createReturn(first.providerShipmentId, 'return:v1')
    expect({ ...returned, label: new TextDecoder().decode(returned.label) }).toEqual({
      providerShipmentId: 'RET-A121E782392AF1',
      trackingNumber: 'RTR-2C28D93D9F2244',
      label: '%PDF-1.4\n% NETECO carrier label RET-A121E782392AF1\n%%EOF',
      status: 'created'
    })
    await expect(
      provider.schedulePickup({ date: '2026-08-14', parcelCount: 2, idempotencyKey: 'pickup:v1' })
    ).resolves.toEqual({ status: 'scheduled', providerPickupId: 'PUP-1A16A0BA5063DC' })
  })

  it('rejects incomplete operational requests', async () => {
    const input = {
      orderNumber: 'NE12345',
      destination: address,
      parcels: [parcel],
      serviceCode: 'STANDARD-PARCEL',
      idempotencyKey: 'shipment:v1'
    }
    await expect(provider.createShipment({ ...input, serviceCode: '' })).rejects.toThrow('service')
    await expect(provider.createShipment({ ...input, serviceCode: '   ' })).rejects.toThrow('service')
    await expect(provider.createShipment({ ...input, idempotencyKey: '' })).rejects.toThrow('idempotency')
    await expect(provider.createShipment({ ...input, idempotencyKey: '   ' })).rejects.toThrow('idempotency')
    await expect(provider.cancelShipment('')).rejects.toThrow('required')
    await expect(provider.cancelShipment('   ')).rejects.toThrow('required')
    await expect(provider.tracking('')).rejects.toThrow('required')
    await expect(provider.tracking('   ')).rejects.toThrow('required')
    await expect(provider.createReturn('', 'key')).rejects.toThrow('identifiers')
    await expect(provider.createReturn('shipment', '')).rejects.toThrow('identifiers')
    await expect(provider.createReturn('   ', 'key')).rejects.toThrow('identifiers')
    await expect(provider.createReturn('shipment', '   ')).rejects.toThrow('identifiers')
    await expect(provider.schedulePickup({ date: 'bad', parcelCount: 1, idempotencyKey: 'key' })).rejects.toThrow(
      'date'
    )
    await expect(
      provider.schedulePickup({ date: 'x2026-08-14', parcelCount: 1, idempotencyKey: 'key' })
    ).rejects.toThrow('date')
    await expect(
      provider.schedulePickup({ date: '2026-08-14x', parcelCount: 1, idempotencyKey: 'key' })
    ).rejects.toThrow('date')
    await expect(
      provider.schedulePickup({ date: '2026-08-14', parcelCount: 0, idempotencyKey: 'key' })
    ).rejects.toThrow('count')
    await expect(
      provider.schedulePickup({ date: '2026-08-14', parcelCount: 1.5, idempotencyKey: 'key' })
    ).rejects.toThrow('count')
    await expect(provider.schedulePickup({ date: '2026-08-14', parcelCount: 1, idempotencyKey: '' })).rejects.toThrow(
      'idempotency'
    )
    await expect(
      provider.schedulePickup({ date: '2026-08-14', parcelCount: 1, idempotencyKey: '   ' })
    ).rejects.toThrow('idempotency')
  })

  it('fails closed unless a non-production mock is explicitly safe', () => {
    expect(carrierProviderFromEnvironment({ APP_ENV: 'local' })).toBeInstanceOf(MockCarrierProvider)
    expect(carrierProviderFromEnvironment({ APP_ENV: 'test', CARRIER_PROVIDER: 'mock' })).toBeInstanceOf(
      MockCarrierProvider
    )
    expect(() => carrierProviderFromEnvironment({ APP_ENV: 'production', CARRIER_PROVIDER: 'mock' })).toThrow(
      'contracted'
    )
    expect(() => carrierProviderFromEnvironment({ APP_ENV: 'production', CARRIER_PROVIDER: 'manual' })).toThrow(
      'contracted production carrier'
    )
    expect(() => carrierProviderFromEnvironment({ APP_ENV: 'production', CARRIER_PROVIDER: 'own-delivery' })).toThrow(
      'contracted production carrier'
    )
    expect(carrierProviderFromEnvironment({ APP_ENV: 'test', CARRIER_PROVIDER: 'manual' })).toBeInstanceOf(
      ManualCarrierProvider
    )
    expect(carrierProviderFromEnvironment({ APP_ENV: 'test', CARRIER_PROVIDER: 'own-delivery' })).toBeInstanceOf(
      OwnDeliveryCarrierProvider
    )
    expect(() => carrierProviderFromEnvironment({ APP_ENV: 'production', CARRIER_PROVIDER: 'carrier' })).toThrow(
      'contracted'
    )
  })

  it('limits the internal fleet adapter to its configured delivery zone', async () => {
    const own = new OwnDeliveryCarrierProvider()
    await expect(
      own.rates({ originPostalCode: '46870', destination: { ...address, postalCode: '46870' }, parcels: [parcel] })
    ).resolves.toEqual([expect.objectContaining({ provider: 'own-delivery', profile: 'own_delivery' })])
    await expect(own.rates({ originPostalCode: '46870', destination: address, parcels: [parcel] })).resolves.toEqual([])
    expect(new ManualCarrierProvider().name).toBe('manual-contingency')
  })
})
