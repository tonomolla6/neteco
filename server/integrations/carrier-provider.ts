export interface Parcel {
  weightGrams: number
  widthMm: number
  heightMm: number
  depthMm: number
  contents: Array<{ sku: string; quantity: number }>
}

export interface ShippingAddress {
  name: string
  line1: string
  line2?: string
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone?: string
}

export interface ShippingRate {
  provider: string
  serviceCode: string
  label: string
  netCents: number
  taxRateBasisPoints: number
  estimatedDeliveryFrom: string
  estimatedDeliveryTo: string
}

export interface ShipmentResult {
  providerShipmentId: string
  trackingNumber: string
  label: Uint8Array
  status: 'created' | 'ready'
}

export interface CarrierProvider {
  readonly name: string
  rates(input: { originPostalCode: string; destination: ShippingAddress; parcels: Parcel[] }): Promise<ShippingRate[]>
  createShipment(input: {
    orderNumber: string
    destination: ShippingAddress
    parcels: Parcel[]
    serviceCode: string
    idempotencyKey: string
  }): Promise<ShipmentResult>
  cancelShipment(providerShipmentId: string): Promise<void>
  tracking(providerShipmentId: string): Promise<{ status: string; occurredAt: string }[]>
  createReturn(providerShipmentId: string, idempotencyKey: string): Promise<ShipmentResult>
}
