import { createHash } from 'node:crypto'
import {
  assertShippingAddress,
  chargeableWeightGrams,
  classifyShipment,
  estimatedDeliveryWindow,
  ownDeliveryEligible,
  standardShippingNetCents
} from '../domain/shipping'
import type { CarrierProvider, Parcel, ShipmentResult, ShippingAddress, ShippingRate } from './carrier-provider'

function stableReference(prefix: string, value: string) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 14).toUpperCase()}`
}

function label(reference: string) {
  return new TextEncoder().encode(`%PDF-1.4\n% NETECO carrier label ${reference}\n%%EOF`)
}

const trackingCalls = new Map<string, number>()

function failTestOperation(operation: string) {
  if (process.env.APP_ENV === 'test' && process.env.NETECO_TEST_CARRIER_FAILURE === operation) {
    throw new Error(`Simulated carrier outage during ${operation}`)
  }
}

function configuredTrackingEvents(providerShipmentId: string) {
  const sequence = process.env.MOCK_CARRIER_TRACKING_SEQUENCE?.split(',')
    .map((step) => step.trim())
    .filter(Boolean)
  if (!sequence?.length) return null
  const call = trackingCalls.get(providerShipmentId) ?? 0
  trackingCalls.set(providerShipmentId, call + 1)
  return sequence[Math.min(call, sequence.length - 1)]!.split('+')
    .map((status) => status.trim())
    .filter(Boolean)
    .map((status, index) => ({
      status,
      occurredAt: new Date(
        Date.parse('2026-08-13T08:00:00.000Z') + call * 60 * 60 * 1_000 + index * 60 * 1_000
      ).toISOString()
    }))
}

export class MockCarrierProvider implements CarrierProvider {
  constructor(readonly name: string = 'mock-carrier') {}

  async rates(input: { originPostalCode: string; destination: ShippingAddress; parcels: Parcel[] }) {
    assertShippingAddress(input.destination)
    if (!/^\d{5}$/.test(input.originPostalCode)) throw new Error('Origin postal code is invalid')
    const own = ownDeliveryEligible(input.destination.postalCode)
    const standardProfile = classifyShipment(input.parcels)
    const profile = own && ['parcel', 'multi_parcel'].includes(standardProfile) ? 'own_delivery' : standardProfile
    const chargeable = input.parcels.reduce((total, parcel) => total + chargeableWeightGrams(parcel), 0)
    const window = estimatedDeliveryWindow({
      now: new Date('2026-08-12T10:00:00.000Z'),
      preparationBusinessDays: 1,
      transitBusinessDays:
        profile === 'own_delivery' ? [0, 1] : profile === 'pallet' || profile === 'adr' ? [2, 4] : [1, 2],
      cutoffUtcHour: 13
    })
    const base = profile === 'own_delivery' ? 0 : standardShippingNetCents(profile, chargeable)
    const primary = {
      provider: this.name,
      serviceCode: profile === 'own_delivery' ? 'OWN-DAY' : `STANDARD-${profile.toUpperCase()}`,
      label: profile === 'own_delivery' ? 'Reparto propio NETECO' : 'Transporte estándar',
      netCents: base,
      taxRateBasisPoints: 2100,
      estimatedDeliveryFrom: window.from,
      estimatedDeliveryTo: window.to,
      profile
    } satisfies ShippingRate
    if (profile !== 'own_delivery') return [primary]
    const standardWindow = estimatedDeliveryWindow({
      now: new Date('2026-08-12T10:00:00.000Z'),
      preparationBusinessDays: 1,
      transitBusinessDays: [1, 2],
      cutoffUtcHour: 13
    })
    return [
      primary,
      {
        provider: this.name,
        serviceCode: `STANDARD-${standardProfile.toUpperCase()}`,
        label: 'Transporte estándar',
        netCents: standardShippingNetCents(standardProfile, chargeable),
        taxRateBasisPoints: 2100,
        estimatedDeliveryFrom: standardWindow.from,
        estimatedDeliveryTo: standardWindow.to,
        profile: standardProfile
      }
    ]
  }

  async createShipment(input: {
    orderNumber: string
    destination: ShippingAddress
    parcels: Parcel[]
    serviceCode: string
    idempotencyKey: string
  }): Promise<ShipmentResult> {
    failTestOperation('createShipment')
    assertShippingAddress(input.destination)
    classifyShipment(input.parcels)
    if (!input.serviceCode.trim() || !input.idempotencyKey.trim())
      throw new Error('Shipment service and idempotency are required')
    const reference = stableReference('SHP', `${input.orderNumber}:${input.idempotencyKey}`)
    return {
      providerShipmentId: reference,
      trackingNumber: stableReference('TRK', reference),
      label: label(reference),
      status: 'ready'
    }
  }

  async cancelShipment(providerShipmentId: string) {
    if (!providerShipmentId.trim()) throw new Error('Provider shipment id is required')
  }

  async tracking(providerShipmentId: string) {
    if (!providerShipmentId.trim()) throw new Error('Provider shipment id is required')
    const baseline = [
      { status: 'created', occurredAt: '2026-08-12T10:00:00.000Z' },
      { status: 'in_transit', occurredAt: '2026-08-13T07:00:00.000Z' }
    ]
    const configured = configuredTrackingEvents(providerShipmentId)
    return configured ? [...baseline, ...configured] : baseline
  }

  async createReturn(providerShipmentId: string, idempotencyKey: string) {
    if (!providerShipmentId.trim() || !idempotencyKey.trim()) throw new Error('Return identifiers are required')
    const reference = stableReference('RET', `${providerShipmentId}:${idempotencyKey}`)
    return {
      providerShipmentId: reference,
      trackingNumber: stableReference('RTR', reference),
      label: label(reference),
      status: 'created' as const
    }
  }

  async schedulePickup(input: { date: string; parcelCount: number; idempotencyKey: string }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Pickup date is invalid')
    if (!Number.isSafeInteger(input.parcelCount) || input.parcelCount < 1)
      throw new Error('Pickup parcel count is invalid')
    if (!input.idempotencyKey.trim()) throw new Error('Pickup idempotency is required')
    return {
      providerPickupId: stableReference('PUP', `${input.date}:${input.parcelCount}:${input.idempotencyKey}`),
      status: 'scheduled' as const
    }
  }
}

export class OwnDeliveryCarrierProvider extends MockCarrierProvider {
  constructor() {
    super('own-delivery')
  }

  override async rates(input: { originPostalCode: string; destination: ShippingAddress; parcels: Parcel[] }) {
    if (!ownDeliveryEligible(input.destination.postalCode)) return []
    const rates = await super.rates(input)
    return rates.filter((rate) => rate.profile === 'own_delivery')
  }
}

export class ManualCarrierProvider extends MockCarrierProvider {
  constructor() {
    super('manual-contingency')
  }
}
