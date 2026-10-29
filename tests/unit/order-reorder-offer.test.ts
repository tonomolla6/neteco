import { describe, expect, it } from 'vitest'
import { readOrderDetail } from '../../app/utils/orderDetail'
import type { OrderReorderOffer } from '../../shared/order-reorder'

const offer = (): OrderReorderOffer => ({
  evaluatedAt: '2026-10-08T12:00:00Z',
  unitGross: 654,
  lineGross: 1962,
  unitNet: 595,
  lineNet: 1784,
  taxRateBasisPoints: 1000,
  pricingVersion: 'synthetic-approved-price',
  minimumQuantity: 1,
  maximumQuantity: null,
  quantityIncrement: 1,
  availableQuantity: 22,
  backorderAllowed: false,
  quantityAllowed: true,
  stockSufficient: true,
  purchasable: true
})
function detail(current: OrderReorderOffer | null | undefined = undefined) {
  return {
    orderId: 'opaque-order',
    orderedAt: '2026-08-13T12:00:00Z',
    shippingMethod: 'envio',
    paymentMethod: null,
    fulfillmentStatus: null,
    destination: null,
    totals: { subtotalNet: 300, shippingNet: 0, tax: 63, total: 363 },
    shipment: null,
    lines: [
      {
        sku: 'SYNTHETIC-SKU',
        name: 'Historical name',
        format: 'Historical format',
        quantity: 3,
        unitGross: 121,
        lineGross: 363,
        variantId: 101,
        slug: 'synthetic',
        image: null,
        visual: null,
        available: true,
        reason: null,
        ...(current === undefined ? {} : { reorderOffer: current })
      }
    ]
  }
}
describe('optional current reorder offer validation', () => {
  it('preserves the Node historical contract when no current offer is supplied', () => {
    expect(readOrderDetail(detail(), 'opaque-order')).toEqual(detail())
  })
  it.each([null, offer()])(
    'preserves a strict nullable or current offer without replacing historical prices: %#',
    (current) => {
      expect(readOrderDetail(detail(current), 'opaque-order')).toEqual(detail(current))
    }
  )
  it('copies a current offer rather than retaining mutable response references', () => {
    const raw = detail(offer()),
      parsed = readOrderDetail(raw, 'opaque-order')
    raw.lines[0]!.reorderOffer!.minimumQuantity = 99
    expect(parsed?.lines[0]?.reorderOffer?.minimumQuantity).toBe(1)
    expect(parsed?.lines[0]?.unitGross).toBe(121)
  })
  it.each([
    'gross',
    'unit-net',
    'line-net',
    'quantity',
    'stock',
    'flags',
    'unknown',
    'zero',
    'negative',
    'nan',
    'date',
    'getter'
  ] as const)('rejects an incoherent/untrusted %s offer before any cart mutation', (change) => {
    const current = offer(),
      raw = detail(current)
    if (change === 'gross') current.lineGross = 1963
    if (change === 'unit-net') current.unitNet = 596
    if (change === 'line-net') current.lineNet = 1785
    if (change === 'quantity') current.minimumQuantity = 4
    if (change === 'stock') current.availableQuantity = 2
    if (change === 'flags') current.purchasable = false
    if (change === 'unknown') Object.assign(current, { internalWarehouse: 'private' })
    if (change === 'zero') current.unitGross = 0
    if (change === 'negative') current.availableQuantity = -1
    if (change === 'nan') current.taxRateBasisPoints = NaN
    if (change === 'date') current.evaluatedAt = 'not-an-instant'
    const getter = () => {
      throw new Error('untrusted getter executed')
    }
    if (change === 'getter') Object.defineProperty(current, 'unitGross', { get: getter, enumerable: true })
    expect(readOrderDetail(raw, 'opaque-order')).toBeNull()
  })
  it('accepts explicitly nonpurchasable quantity and stock observations as data, not authority', () => {
    const current = {
      ...offer(),
      minimumQuantity: 4,
      quantityAllowed: false,
      stockSufficient: false,
      availableQuantity: 2,
      purchasable: false
    }
    expect(readOrderDetail(detail(current), 'opaque-order')?.lines[0]?.reorderOffer).toEqual(current)
  })
  it('accepts permitted backorders without pretending observed stock exists', () => {
    const current = { ...offer(), backorderAllowed: true, availableQuantity: 0 }
    expect(readOrderDetail(detail(current), 'opaque-order')?.lines[0]?.reorderOffer).toEqual(current)
  })
})
