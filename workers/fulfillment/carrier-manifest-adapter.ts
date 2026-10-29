import { sha256Hex } from './shipping-ops-common'

/**
 * Carrier-side port for manifests and pickups. The only implementation here is a deterministic local
 * adapter (no network). A real carrier integration must implement the same contract and stay idempotent
 * by `idempotencyKey`.
 */
export interface ManifestShipmentLine {
  trackingNumber: string
  shipmentNumber: string
  orderId: string
  parcelIndex: number
  weightGrams: number
}

export interface CarrierManifestAdapter {
  readonly name: string
  closeManifest(input: {
    carrier: string
    pickupDate: string
    shipments: readonly ManifestShipmentLine[]
    idempotencyKey: string
  }): Promise<{ providerManifestId: string; contentType: 'text/csv; charset=utf-8'; content: string }>
  schedulePickup(input: {
    carrier: string
    pickupDate: string
    parcelCount: number
    idempotencyKey: string
  }): Promise<{ providerPickupId: string; status: 'scheduled' }>
}

const csvCell = (value: string | number) => {
  const text = String(value)
  // Neutralise spreadsheet formula injection and quote separators.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function createLocalCarrierManifestAdapter(
  options: { fail?: 'close' | 'pickup' | 'both' } = {}
): CarrierManifestAdapter {
  return {
    name: 'local-deterministic',
    async closeManifest(input) {
      if (options.fail === 'close' || options.fail === 'both') throw new Error('simulated carrier outage')
      const rows = [...input.shipments].sort((a, b) => (a.trackingNumber < b.trackingNumber ? -1 : 1))
      const content =
        ['tracking_number,shipment_number,order_id,parcel_index,weight_grams']
          .concat(
            rows.map((r) =>
              [r.trackingNumber, r.shipmentNumber, r.orderId, r.parcelIndex, r.weightGrams].map(csvCell).join(',')
            )
          )
          .join('\n') + '\n'
      const digest = await sha256Hex(`${input.carrier}|${input.pickupDate}|${input.idempotencyKey}|${content}`)
      return {
        providerManifestId: `MAN-${digest.slice(0, 14).toUpperCase()}`,
        contentType: 'text/csv; charset=utf-8',
        content
      }
    },
    async schedulePickup(input) {
      if (options.fail === 'pickup' || options.fail === 'both') throw new Error('simulated carrier outage')
      const digest = await sha256Hex(
        `${input.carrier}|${input.pickupDate}|${input.parcelCount}|${input.idempotencyKey}`
      )
      return { providerPickupId: `PUP-${digest.slice(0, 14).toUpperCase()}`, status: 'scheduled' }
    }
  }
}
